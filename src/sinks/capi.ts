import type { Env, EventEnvelope, SinkResult } from '../types.ts';
import { sign } from '../signature.ts';

/**
 * Ziel B: ein Empfänger in der Form der Meta Conversions API.
 *
 * Hier muss ich ehrlich sein, und das steht genauso im README. Das hier spricht nicht mit Meta.
 * Für einen echten Aufruf bräuchte es ein Business-Konto, eine Pixel-ID und ein Zugriffstoken, und
 * beides gehört nicht in ein öffentliches Demo-Repository.
 *
 * Nachgebaut ist alles, was die eigentliche Ingenieurarbeit ausmacht:
 * die Nutzlastform, die Normalisierung und das Hashen der Identifikatoren, die gemeinsame event_id
 * für die Deduplizierung zwischen Browser und Server, die Signatur des Aufrufs und die
 * Fehlerbehandlung. Was fehlt, ist ausschließlich der Empfänger auf der anderen Seite.
 */

const TIMEOUT_MS = 5000;

/**
 * Meta arbeitet mit einer festen Liste von Standardereignissen. Wer einen eigenen Namen schickt,
 * bekommt zwar ein 200, das Ereignis ist im Werbekonto aber nicht als Konversion auswählbar.
 * Deshalb wird hier übersetzt statt durchgereicht.
 */
const STANDARD_EVENTS: Record<string, string> = {
  generate_lead: 'Lead',
  lead: 'Lead',
  demo_conversion: 'Lead',
  demo_conversion_server: 'Lead',
  purchase: 'Purchase',
  add_to_cart: 'AddToCart',
  begin_checkout: 'InitiateCheckout',
  view_item: 'ViewContent',
  sign_up: 'CompleteRegistration',
  search: 'Search',
  contact: 'Contact',
  subscribe: 'Subscribe',
};

export function toStandardEventName(eventName: string): string {
  return STANDARD_EVENTS[eventName] ?? eventName;
}

export interface CapiPayload {
  data: Array<{
    event_name: string;
    event_time: number;
    event_id: string;
    action_source: string;
    event_source_url?: string;
    user_data: Record<string, string[] | string>;
    custom_data?: Record<string, unknown>;
  }>;
}

export function buildCapiPayload(envelope: EventEnvelope): CapiPayload {
  // Meta erwartet die gehashten Identifikatoren als Listen, weil eine Person mehrere Adressen
  // oder Rufnummern haben kann. external_id und country folgen derselben Form.
  const userData: Record<string, string[] | string> = {};
  if (envelope.user_data.em) userData.em = [envelope.user_data.em];
  if (envelope.user_data.ph) userData.ph = [envelope.user_data.ph];
  if (envelope.user_data.fn) userData.fn = [envelope.user_data.fn];
  if (envelope.user_data.ln) userData.ln = [envelope.user_data.ln];
  if (envelope.user_data.ct) userData.ct = [envelope.user_data.ct];
  if (envelope.user_data.country) userData.country = [envelope.user_data.country];
  if (envelope.user_data.external_id) userData.external_id = [envelope.user_data.external_id];

  const customData: Record<string, unknown> = {};
  if (typeof envelope.custom_data.value === 'number') customData.value = envelope.custom_data.value;
  if (envelope.custom_data.currency) customData.currency = envelope.custom_data.currency;
  if (envelope.custom_data.content_name) customData.content_name = envelope.custom_data.content_name;
  if (envelope.custom_data.content_category) customData.content_category = envelope.custom_data.content_category;
  if (envelope.custom_data.order_id) customData.order_id = envelope.custom_data.order_id;

  return {
    data: [
      {
        event_name: toStandardEventName(envelope.event_name),
        event_time: envelope.event_time,
        event_id: envelope.event_id,
        action_source: envelope.action_source,
        ...(envelope.event_source_url ? { event_source_url: envelope.event_source_url } : {}),
        user_data: userData,
        ...(Object.keys(customData).length > 0 ? { custom_data: customData } : {}),
      },
    ],
  };
}

/** Baut die vollständige Zieladresse. Ein relativer Wert bezieht sich auf den Relay selbst. */
export function resolveCapiEndpoint(configured: string, requestUrl: string): string {
  if (!configured) return new URL('/capi/events', requestUrl).toString();
  if (configured.startsWith('http://') || configured.startsWith('https://')) return configured;
  return new URL(configured, requestUrl).toString();
}

export async function sendToCapi(
  env: Env,
  envelope: EventEnvelope,
  requestUrl: string,
  nowSeconds: number,
): Promise<SinkResult> {
  const started = Date.now();

  if (!envelope.consent.marketing) {
    return {
      sink: 'capi',
      ok: true,
      status: 'skipped',
      detail: 'Keine Einwilligung für Marketing. Der werbliche Sink wurde bewusst übersprungen.',
      duration_ms: Date.now() - started,
    };
  }

  if (!env.RELAY_HMAC_SECRET) {
    // Ohne Geheimnis lässt sich der Aufruf nicht signieren, und der Empfänger nimmt nur signierte
    // Aufrufe an. Das ist ein Einrichtungsfehler und kein Übertragungsfehler, deshalb kein
    // Wiederholversuch, sondern eine klare Meldung.
    return {
      sink: 'capi',
      ok: true,
      status: 'skipped',
      detail: 'RELAY_HMAC_SECRET ist nicht gesetzt, der Aufruf kann nicht signiert werden.',
      duration_ms: Date.now() - started,
    };
  }

  const endpoint = resolveCapiEndpoint(env.CAPI_ENDPOINT ?? '', requestUrl);
  const body = JSON.stringify(buildCapiPayload(envelope));
  const signature = await sign(env.RELAY_HMAC_SECRET, nowSeconds, body);

  const anfrage = new Request(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-timestamp': String(nowSeconds),
      'x-relay-signature': signature,
    },
    body,
  });

  // Zeigt CAPI_ENDPOINT auf den Relay selbst, läuft der Aufruf über die Service-Bindung.
  // Der Weg über den öffentlichen Hostnamen wäre ein Selbstaufruf, den Cloudflare mit
  // Fehler 1042 abbricht. Ein extern eingestelltes Ziel geht weiter übers Netz.
  const eigenesZiel = !env.CAPI_ENDPOINT;
  const senden = eigenesZiel && env.CAPI
    ? () => env.CAPI!.fetch(anfrage)
    : () => fetch(anfrage, { signal: AbortSignal.timeout(TIMEOUT_MS) });

  try {
    const response = await senden();

    const text = await response.text();
    const ok = response.ok;
    return {
      sink: 'capi',
      ok,
      status: ok ? 'sent' : 'failed',
      http_status: response.status,
      detail: ok ? `Empfänger bestätigt: ${text.slice(0, 200)}` : `Empfänger antwortet ${response.status}: ${text.slice(0, 200)}`,
      duration_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      sink: 'capi',
      ok: false,
      status: 'failed',
      detail: `Netzwerkfehler: ${String(error)}`,
      duration_ms: Date.now() - started,
    };
  }
}
