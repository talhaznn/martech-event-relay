import type { Env, EventEnvelope, SinkName } from './types.ts';
import { retryKey, storeEnvelope } from './dedupe.ts';
import { sign } from './signature.ts';
import { log } from './log.ts';

/**
 * Wiederholversuche.
 *
 * Der Worker selbst versucht es genau einmal. Alles Weitere übernimmt n8n, und das ist Absicht.
 * Ein Worker hat eine begrenzte Laufzeit und darf nicht minutenlang auf ein zickiges Zielsystem
 * warten, während der Browser des Nutzers auf die Antwort wartet. Der Wartelauf mit wachsendem
 * Abstand gehört deshalb nach draußen, in ein System, das ihn sichtbar macht und in dem ein
 * Mensch nachsehen kann, was liegen geblieben ist.
 *
 * Übertragen wird bewusst nur die event_id und der Name des Ziels. Die Nutzdaten holt der Relay beim
 * Wiederholversuch selbst aus KV. Damit laufen keine personenbezogenen Daten durch n8n, auch keine
 * gehashten.
 */

export interface RetryTicket {
  event_id: string;
  sink: SinkName;
  attempt: number;
  error: string;
  replay_url: string;
  scheduled_at: number;
}

export async function scheduleRetry(
  env: Env,
  envelope: EventEnvelope,
  sink: SinkName,
  error: string,
  requestUrl: string,
  nowSeconds: number,
  ttlSeconds: number,
): Promise<boolean> {
  await storeEnvelope(env.RELAY, envelope, ttlSeconds);
  await env.RELAY.put(
    retryKey(envelope.event_id, sink),
    JSON.stringify({ error, scheduled_at: nowSeconds }),
    { expirationTtl: Math.max(60, ttlSeconds) },
  );

  const ticket: RetryTicket = {
    event_id: envelope.event_id,
    sink,
    attempt: 1,
    error: error.slice(0, 500),
    replay_url: new URL('/replay', requestUrl).toString(),
    scheduled_at: nowSeconds,
  };

  if (!env.N8N_RETRY_WEBHOOK || !env.RELAY_HMAC_SECRET) {
    log('warn', 'retry_not_dispatched', {
      ...ticket,
      reason: 'N8N_RETRY_WEBHOOK oder RELAY_HMAC_SECRET ist nicht gesetzt. Der Umschlag liegt in KV und kann von Hand über /replay erneut gesendet werden.',
    });
    return false;
  }

  const body = JSON.stringify(ticket);
  const signature = await sign(env.RELAY_HMAC_SECRET, nowSeconds, body);

  try {
    const response = await fetch(env.N8N_RETRY_WEBHOOK, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-timestamp': String(nowSeconds),
        'x-relay-signature': signature,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    log(response.ok ? 'info' : 'warn', 'retry_dispatched', { ...ticket, http_status: response.status });
    return response.ok;
  } catch (dispatchError) {
    // Fällt n8n aus, bleibt der Umschlag trotzdem in KV liegen. Nichts geht verloren, es dauert nur länger.
    log('error', 'retry_dispatch_failed', { ...ticket, error: String(dispatchError) });
    return false;
  }
}
