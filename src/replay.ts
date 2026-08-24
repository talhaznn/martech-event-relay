import type { Env, SinkName, SinkResult } from './types.ts';
import { loadEnvelope, retryKey } from './dedupe.ts';
import { fehlendesGeheimnis, jsonResponse } from './http.ts';
import { log, pushToRing } from './log.ts';
import { verify } from './signature.ts';
import { sendToGa4 } from './sinks/ga4.ts';
import { sendToCapi } from './sinks/capi.ts';
import { dayKey, record } from './stats.ts';

/**
 * POST /replay
 *
 * Der Endpunkt, den n8n nach jeder Wartezeit aufruft. Er nimmt nur eine event_id und den Namen eines
 * Ziels entgegen und holt sich den gehashten Umschlag selbst aus KV.
 *
 * Zwei Eigenschaften sind hier wichtig. Erstens ist der Aufruf immer signiert, ohne Ausnahme, denn er
 * löst echten Versand aus. Zweitens läuft er absichtlich an der Deduplizierung vorbei: das Ereignis
 * wurde ja bereits angenommen, nur ein einzelnes Ziel hat es nicht bekommen. Würde der
 * Wiederholversuch durch dieselbe Prüfung laufen, würde er sich selbst als Duplikat abweisen und
 * das liegen gebliebene Ereignis wäre für immer verloren.
 */

export async function handleReplay(request: Request, env: Env, rawBody: string, nowSeconds: number): Promise<Response> {
  if (!env.RELAY_HMAC_SECRET) return fehlendesGeheimnis();

  const verification = await verify(
    env.RELAY_HMAC_SECRET,
    request.headers.get('x-relay-timestamp'),
    request.headers.get('x-relay-signature'),
    rawBody,
    nowSeconds,
  );
  if (!verification.ok) {
    log('warn', 'replay_signature_rejected', { reason: verification.reason });
    return jsonResponse({ ok: false, error: 'invalid_signature', reason: verification.reason }, 401);
  }

  let parsed: { event_id?: unknown; sink?: unknown };
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
  }

  const eventId = parsed.event_id;
  const sink = parsed.sink;
  if (typeof eventId !== 'string' || (sink !== 'ga4' && sink !== 'capi')) {
    return jsonResponse(
      { ok: false, error: 'invalid_payload', detail: 'Erwartet wird { "event_id": "...", "sink": "ga4" | "capi" }.' },
      400,
    );
  }

  const envelope = await loadEnvelope(env.RELAY, eventId);
  if (!envelope) {
    // Nach Ablauf der Lebensdauer ist der Umschlag weg. Das ist ein Endzustand und kein Fehler, den
    // ein weiterer Wiederholversuch heilen könnte. n8n soll hier aufhören und Alarm schlagen.
    return jsonResponse(
      {
        ok: false,
        error: 'envelope_not_found',
        event_id: eventId,
        detail: 'Kein zwischengespeicherter Umschlag. Entweder abgelaufen oder das Ereignis wurde nie angenommen.',
        terminal: true,
      },
      404,
    );
  }

  const result: SinkResult =
    sink === 'ga4'
      ? await sendToGa4(env, envelope, nowSeconds)
      : await sendToCapi(env, envelope, request.url, nowSeconds);

  const day = dayKey(nowSeconds);
  await record(env.RELAY, day, sink as SinkName, result.status, `${eventId}:replay:${nowSeconds}`);

  if (result.ok) {
    await env.RELAY.delete(retryKey(eventId, sink as SinkName));
  }

  const line = log(result.ok ? 'info' : 'warn', 'replay_result', {
    event_id: eventId,
    sink,
    status: result.status,
    http_status: result.http_status,
  });
  await pushToRing(env.RELAY, line);

  return jsonResponse({ ok: result.ok, event_id: eventId, sink, result }, result.ok ? 200 : 502);
}
