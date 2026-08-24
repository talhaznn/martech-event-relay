import type { CollectResponse, Env, EventEnvelope, SinkName, SinkResult } from './types.ts';
import { checkAndMark } from './dedupe.ts';
import { hashUserData } from './hash.ts';
import { corsHeaders, fehlendesGeheimnis, isOriginAllowed, jsonResponse } from './http.ts';
import { log, pushToRing } from './log.ts';
import { scheduleRetry } from './retry.ts';
import { verify } from './signature.ts';
import { sendToGa4 } from './sinks/ga4.ts';
import { sendToCapi } from './sinks/capi.ts';
import { dayKey, record } from './stats.ts';
import { validateEvent } from './validate.ts';

/**
 * Der Haupteingang: POST /collect
 *
 * Zur Authentifizierung eine Entscheidung, die ich bewusst so getroffen habe und im README begründe.
 *
 * Ein Browser kann kein Geheimnis halten. Wer eine HMAC-Signatur im JavaScript der Seite bildet, gibt
 * den Schlüssel jedem, der die Entwicklerwerkzeuge öffnet, und hat trotzdem das Gefühl, etwas
 * abgesichert zu haben. Deshalb gibt es hier zwei Wege in denselben Endpunkt.
 *
 *   Browser  ohne Signatur, dafür mit Prüfung der Herkunft, strenger Schemaprüfung und einer
 *            einfachen Ratenbremse. Das Ergebnis wird als source "browser" gekennzeichnet.
 *   Server   mit Signatur über Zeitstempel und Rohkörper. Das nutzen das Testskript und der
 *            Wiederholversuch aus n8n. Das Ergebnis wird als source "server" gekennzeichnet.
 *
 * Ist eine Signatur vorhanden, muss sie stimmen. Ein kaputter Signaturkopf führt nie dazu, dass der
 * Aufruf einfach als Browseraufruf durchrutscht.
 */

const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT_PER_MINUTE = 60;

export async function handleCollect(
  request: Request,
  env: Env,
  rawBody: string,
  nowSeconds: number,
): Promise<Response> {
  const origin = request.headers.get('origin');
  const erlaubteHerkuenfte = env.ALLOWED_ORIGINS ?? '*';
  const headers = corsHeaders(origin, erlaubteHerkuenfte);

  if (rawBody.length > MAX_BODY_BYTES) {
    return jsonResponse({ status: 'rejected', error: 'body_too_large', limit_bytes: MAX_BODY_BYTES }, 413, headers);
  }

  const hasSignatureHeaders =
    request.headers.get('x-relay-signature') !== null || request.headers.get('x-relay-timestamp') !== null;

  let source: 'browser' | 'server';
  if (hasSignatureHeaders) {
    if (!env.RELAY_HMAC_SECRET) return fehlendesGeheimnis();
    const verification = await verify(
      env.RELAY_HMAC_SECRET,
      request.headers.get('x-relay-timestamp'),
      request.headers.get('x-relay-signature'),
      rawBody,
      nowSeconds,
    );
    if (!verification.ok) {
      log('warn', 'collect_signature_rejected', { reason: verification.reason });
      return jsonResponse({ status: 'rejected', error: 'invalid_signature', reason: verification.reason }, 401, headers);
    }
    source = 'server';
  } else {
    if (!isOriginAllowed(origin, erlaubteHerkuenfte)) {
      log('warn', 'collect_origin_rejected', { origin });
      return jsonResponse(
        {
          status: 'rejected',
          error: 'origin_not_allowed',
          detail: 'Aufrufe ohne Signatur sind nur von einer eingetragenen Herkunft erlaubt.',
        },
        403,
        headers,
      );
    }
    const limited = await isRateLimited(env, request, nowSeconds);
    if (limited) {
      return jsonResponse({ status: 'rejected', error: 'rate_limited', limit_per_minute: RATE_LIMIT_PER_MINUTE }, 429, headers);
    }
    source = 'browser';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ status: 'rejected', error: 'invalid_json' }, 400, headers);
  }

  const validation = validateEvent(parsed, nowSeconds);
  if (!validation.ok) {
    log('warn', 'collect_validation_failed', { errors: validation.errors });
    return jsonResponse({ status: 'rejected', error: 'validation_failed', errors: validation.errors }, 422, headers);
  }

  const raw = validation.value;

  // Ab hier existiert kein Klartext mehr. Was weitergereicht und gespeichert wird, ist gehasht.
  const envelope: EventEnvelope = {
    event_id: raw.event_id,
    event_name: raw.event_name,
    event_time: raw.event_time,
    action_source: raw.action_source,
    event_source_url: raw.event_source_url,
    client_id: raw.client_id,
    session_id: raw.session_id,
    user_data: await hashUserData(raw.user_data),
    custom_data: raw.custom_data ?? {},
    consent: raw.consent ?? { analytics: true, marketing: false },
    source,
    received_at: nowSeconds,
  };

  const ttl = Number(env.DEDUPE_TTL_SECONDS) || 86400;
  const day = dayKey(nowSeconds);
  const decision = await checkAndMark(env.RELAY, envelope, ttl);

  if (decision.duplicate) {
    const line = log('info', 'event_duplicate', {
      event_id: envelope.event_id,
      event_name: envelope.event_name,
      source,
      first_seen_at: decision.first_seen_at,
    });
    await pushToRing(env.RELAY, line);
    await record(env.RELAY, day, 'relay', 'duplicate', `${envelope.event_id}:${nowSeconds}`);

    const body: CollectResponse = {
      status: 'duplicate',
      event_id: envelope.event_id,
      duplicate: true,
      first_seen_at: decision.first_seen_at,
      sinks: [],
      retry_scheduled: [],
      received_at: nowSeconds,
    };
    return jsonResponse(body, 200, headers);
  }

  await record(env.RELAY, day, 'relay', 'accepted', envelope.event_id);

  // Beide Ziele laufen gleichzeitig. Ein langsames Ziel darf das andere nicht aufhalten, und ein
  // Fehler in einem Ziel darf das andere nicht mitreißen.
  const results: SinkResult[] = await Promise.all([
    sendToGa4(env, envelope, nowSeconds),
    sendToCapi(env, envelope, request.url, nowSeconds),
  ]);

  const retryScheduled: SinkName[] = [];
  for (const result of results) {
    await record(env.RELAY, day, result.sink, result.status, envelope.event_id);
    if (result.status === 'failed') {
      const dispatched = await scheduleRetry(
        env,
        envelope,
        result.sink,
        result.detail ?? 'unbekannter Fehler',
        request.url,
        nowSeconds,
        ttl,
      );
      retryScheduled.push(result.sink);
      if (!dispatched) {
        result.detail = `${result.detail ?? ''} Umschlag für den Wiederholversuch liegt in KV.`.trim();
      }
    }
  }

  const line = log('info', 'event_accepted', {
    event_id: envelope.event_id,
    event_name: envelope.event_name,
    source,
    consent: envelope.consent,
    sinks: results.map((result) => ({ sink: result.sink, status: result.status, http_status: result.http_status, ms: result.duration_ms })),
    warnings: validation.warnings.map((warning) => warning.code),
  });
  await pushToRing(env.RELAY, line);

  const body: CollectResponse & { warnings: typeof validation.warnings } = {
    status: 'accepted',
    event_id: envelope.event_id,
    duplicate: false,
    sinks: results,
    retry_scheduled: retryScheduled,
    received_at: nowSeconds,
    warnings: validation.warnings,
  };
  return jsonResponse(body, 200, headers);
}

/**
 * Einfache Ratenbremse pro Adresse und Minute.
 *
 * Auch das ist lesen, ändern, schreiben und damit nicht exakt. Für den Zweck reicht es: sie soll ein
 * versehentliches Dauerfeuer aus einer Schleife abfangen, nicht einen entschlossenen Angreifer. Wer
 * eine harte Grenze braucht, nimmt ein Durable Object oder die Rate-Limiting-Bindung von Cloudflare.
 */
async function isRateLimited(env: Env, request: Request, nowSeconds: number): Promise<boolean> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unbekannt';
  const minute = Math.floor(nowSeconds / 60);
  const key = `rl:${ip}:${minute}`;
  const current = Number((await env.RELAY.get(key)) ?? '0');
  if (current >= RATE_LIMIT_PER_MINUTE) return true;
  await env.RELAY.put(key, String(current + 1), { expirationTtl: 60 });
  return false;
}
