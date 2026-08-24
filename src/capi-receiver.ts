import type { Env } from './types.ts';
import { capiDedupeKey } from './dedupe.ts';
import { isSha256Hex, SHA256_HEX } from './hash.ts';
import { fehlendesGeheimnis, jsonResponse } from './http.ts';
import { log, pushToRing } from './log.ts';
import { verify } from './signature.ts';

/**
 * Der nachgebildete Empfänger in der Form der Meta Conversions API.
 *
 * Er ist bewusst streng, denn genau hier zeigt sich, ob die Pipeline davor sauber arbeitet:
 *
 * 1. Ohne gültige Signatur kein Zutritt. Wer Konversionen einwerfen kann, kann Gebotsstrategien
 *    verschieben, also gehört der Endpunkt geschützt.
 * 2. Jeder Identifikator muss ein SHA-256 in Kleinbuchstaben sein. Findet der Empfänger ein
 *    Klammeraffen-Zeichen, ein Leerzeichen oder ein Pluszeichen, lehnt er ab, statt es zu verarbeiten.
 *    Klartext, der versehentlich an eine Werbeplattform geht, lässt sich nicht zurückholen. Deshalb
 *    ist dieser Punkt fail closed.
 * 3. event_id und event_name zusammen bilden den Dedup-Schlüssel. Genau so entscheidet Meta, ob ein
 *    Browser- und ein Serverereignis dieselbe Handlung beschreiben.
 */

const MAX_EVENTS = 100;

interface CapiIncomingEvent {
  event_name?: unknown;
  event_time?: unknown;
  event_id?: unknown;
  action_source?: unknown;
  user_data?: unknown;
  custom_data?: unknown;
}

function looksLikePlaintext(value: string): boolean {
  if (SHA256_HEX.test(value)) return false;
  // Klammeraffe, Leerzeichen, Pluszeichen und Punkt kommen in einem Hexadezimalstring nicht vor.
  // Wer sie hier sieht, hat vergessen zu hashen.
  return /[@\s+]/.test(value) || value.includes('.');
}

export async function handleCapiEvents(request: Request, env: Env, rawBody: string, nowSeconds: number): Promise<Response> {
  if (!env.RELAY_HMAC_SECRET) return fehlendesGeheimnis();

  const verification = await verify(
    env.RELAY_HMAC_SECRET,
    request.headers.get('x-relay-timestamp'),
    request.headers.get('x-relay-signature'),
    rawBody,
    nowSeconds,
  );
  if (!verification.ok) {
    log('warn', 'capi_signature_rejected', { reason: verification.reason });
    return jsonResponse({ error: 'invalid_signature', reason: verification.reason }, 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0 || data.length > MAX_EVENTS) {
    return jsonResponse({ error: 'invalid_payload', detail: `data muss eine Liste mit ein bis ${MAX_EVENTS} Ereignissen sein.` }, 400);
  }

  let received = 0;
  let duplicates = 0;
  const problems: Array<{ index: number; field: string; message: string }> = [];

  for (let index = 0; index < data.length; index++) {
    const event = data[index] as CapiIncomingEvent;

    if (typeof event.event_name !== 'string' || !event.event_name) {
      problems.push({ index, field: 'event_name', message: 'Pflichtfeld.' });
      continue;
    }
    if (typeof event.event_id !== 'string' || !event.event_id) {
      problems.push({ index, field: 'event_id', message: 'Pflichtfeld. Ohne diesen Wert ist keine Deduplizierung möglich.' });
      continue;
    }
    if (typeof event.event_time !== 'number' || !Number.isInteger(event.event_time)) {
      problems.push({ index, field: 'event_time', message: 'Pflichtfeld, Unix-Zeit in Sekunden.' });
      continue;
    }
    if (typeof event.action_source !== 'string') {
      problems.push({ index, field: 'action_source', message: 'Pflichtfeld.' });
      continue;
    }

    const userData = event.user_data;
    if (typeof userData !== 'object' || userData === null || Array.isArray(userData)) {
      problems.push({ index, field: 'user_data', message: 'Muss ein Objekt sein.' });
      continue;
    }

    let hashProblem = false;
    for (const [field, value] of Object.entries(userData as Record<string, unknown>)) {
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) {
        if (typeof entry !== 'string') {
          problems.push({ index, field: `user_data.${field}`, message: 'Nur Zeichenketten erlaubt.' });
          hashProblem = true;
          continue;
        }
        if (looksLikePlaintext(entry)) {
          problems.push({
            index,
            field: `user_data.${field}`,
            message: 'Sieht nach Klartext aus. Abgelehnt, bevor personenbezogene Daten die Plattform erreichen.',
          });
          hashProblem = true;
          continue;
        }
        if (!isSha256Hex(entry)) {
          problems.push({
            index,
            field: `user_data.${field}`,
            message: 'Erwartet wird SHA-256 in Kleinbuchstaben, vierundsechzig Zeichen.',
          });
          hashProblem = true;
        }
      }
    }
    if (hashProblem) continue;

    const key = capiDedupeKey(event.event_id, event.event_name);
    const seen = await env.RELAY.get(key);
    if (seen) {
      duplicates += 1;
      continue;
    }
    await env.RELAY.put(key, String(nowSeconds), { expirationTtl: 24 * 60 * 60 });
    received += 1;
  }

  if (problems.length > 0) {
    log('warn', 'capi_payload_rejected', { problems });
    return jsonResponse({ error: 'invalid_events', problems, events_received: 0 }, 422);
  }

  const line = log('info', 'capi_events_received', { events_received: received, duplicates });
  await pushToRing(env.RELAY, line);

  return jsonResponse({
    events_received: received,
    duplicates,
    // Kein echter Wert von Meta. Der Name ist bewusst als Simulation gekennzeichnet.
    fbtrace_id: `sim_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    simulated: true,
    note: 'Nachgebildeter Empfänger. Es besteht keine Verbindung zu Meta.',
  });
}
