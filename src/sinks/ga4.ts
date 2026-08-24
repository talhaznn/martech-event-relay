import type { Env, EventEnvelope, SinkResult } from '../types.ts';

/**
 * Ziel A: Google Analytics 4 über das Measurement Protocol.
 *
 * Das ist der serverseitige Weg. Der Aufruf geht von Cloudflare aus an Google, nicht aus dem Browser.
 * Er überlebt damit Adblocker, ITP und einen Nutzer, der die Seite vor dem Absenden des Tags schließt.
 *
 * Drei Punkte, an denen das Measurement Protocol in der Praxis regelmäßig scheitert und die hier
 * bewusst behandelt sind:
 *
 * 1. client_id. Ohne diesen Wert legt GA4 für jedes Serverereignis einen neuen Nutzer an. Die
 *    Demoseite liest ihn deshalb aus dem _ga Cookie und schickt ihn mit.
 * 2. engagement_time_msec. Fehlt der Parameter, taucht das Ereignis in Berichten und im Echtzeitbericht
 *    oft gar nicht auf, obwohl die Antwort 204 lautet.
 * 3. debug_mode. DebugView zeigt nur Ereignisse mit diesem Parameter. Der Debug-Endpunkt selbst
 *    validiert dagegen nur und zeichnet nichts auf. Beides wird hier getrennt behandelt.
 */

const COLLECT_URL = 'https://www.google-analytics.com/mp/collect';
const DEBUG_URL = 'https://www.google-analytics.com/debug/mp/collect';
const SEVENTY_TWO_HOURS = 72 * 60 * 60;
const TIMEOUT_MS = 5000;

interface Ga4Payload {
  client_id: string;
  user_id?: string;
  timestamp_micros?: string;
  non_personalized_ads?: boolean;
  consent?: { ad_user_data: 'GRANTED' | 'DENIED'; ad_personalization: 'GRANTED' | 'DENIED' };
  events: Array<{ name: string; params: Record<string, string | number> }>;
}

export function buildGa4Payload(envelope: EventEnvelope, nowSeconds: number): Ga4Payload {
  const params: Record<string, string | number> = {
    // Verbindet das Serverereignis mit dem Browserereignis derselben Anfrage.
    event_id: envelope.event_id,
    // Ohne diesen Parameter wertet GA4 das Ereignis häufig nicht in die Sitzung ein.
    engagement_time_msec: 1,
    relay_source: envelope.source,
    relay_action_source: envelope.action_source,
  };

  if (envelope.session_id) params.session_id = envelope.session_id;
  if (envelope.event_source_url) params.page_location = envelope.event_source_url.slice(0, 100);
  if (typeof envelope.custom_data.value === 'number') params.value = envelope.custom_data.value;
  if (envelope.custom_data.currency) params.currency = envelope.custom_data.currency;
  if (envelope.custom_data.content_name) params.content_name = envelope.custom_data.content_name.slice(0, 100);
  if (envelope.custom_data.order_id) params.transaction_id = envelope.custom_data.order_id.slice(0, 100);

  const payload: Ga4Payload = {
    // Fehlt die client_id, wird ein stabiler Ersatz aus der event_id gebildet. Das hält die Anfrage
    // gültig, trennt den Nutzer aber vom Browserereignis. Deshalb warnt die Validierung davor.
    client_id: envelope.client_id ?? `${hashToDigits(envelope.event_id)}.${envelope.event_time}`,
    non_personalized_ads: !envelope.consent.marketing,
    consent: {
      ad_user_data: envelope.consent.marketing ? 'GRANTED' : 'DENIED',
      ad_personalization: envelope.consent.marketing ? 'GRANTED' : 'DENIED',
    },
    events: [{ name: envelope.event_name, params }],
  };

  if (envelope.user_data.external_id) payload.user_id = envelope.user_data.external_id;

  // GA4 nimmt einen mitgesendeten Zeitstempel nur bis zweiundsiebzig Stunden rückwirkend an.
  // Darüber hinaus würde er stillschweigend verworfen, deshalb lassen wir ihn dann gleich weg.
  if (envelope.event_time >= nowSeconds - SEVENTY_TWO_HOURS) {
    payload.timestamp_micros = String(envelope.event_time * 1_000_000);
  }

  return payload;
}

/** Erzeugt aus einer beliebigen Zeichenkette eine stabile Ziffernfolge als Notbehelf für client_id. */
function hashToDigits(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return String(hash >>> 0);
}

export async function sendToGa4(env: Env, envelope: EventEnvelope, nowSeconds: number): Promise<SinkResult> {
  const started = Date.now();

  if (!envelope.consent.analytics) {
    return {
      sink: 'ga4',
      ok: true,
      status: 'skipped',
      detail: 'Keine Einwilligung für Analytics. Das Ereignis wurde bewusst nicht gesendet.',
      duration_ms: Date.now() - started,
    };
  }

  if (!env.GA4_MEASUREMENT_ID || !env.GA4_API_SECRET) {
    return {
      sink: 'ga4',
      ok: true,
      status: 'skipped',
      detail: 'GA4_MEASUREMENT_ID oder GA4_API_SECRET fehlt. Der Sink läuft im Trockenlauf.',
      duration_ms: Date.now() - started,
    };
  }

  const debug = env.GA4_DEBUG === 'true';
  const payload = buildGa4Payload(envelope, nowSeconds);
  if (debug) payload.events[0]!.params.debug_mode = 1;

  const query = `?measurement_id=${encodeURIComponent(env.GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(env.GA4_API_SECRET)}`;
  const body = JSON.stringify(payload);

  let validationMessages: unknown[] | undefined;
  if (debug) {
    // Der Debug-Endpunkt zeichnet nichts auf, er antwortet nur mit Befunden. Deshalb läuft er
    // zusätzlich zum echten Aufruf und nicht an dessen Stelle.
    try {
      const debugResponse = await fetch(DEBUG_URL + query, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const parsed = (await debugResponse.json()) as { validationMessages?: unknown[] };
      validationMessages = parsed.validationMessages ?? [];
    } catch (error) {
      validationMessages = [{ description: `Debug-Endpunkt nicht erreichbar: ${String(error)}` }];
    }
  }

  try {
    const response = await fetch(COLLECT_URL + query, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // Das Measurement Protocol antwortet auf gültige Anfragen mit 204 und ohne Körper. Ein 204 heißt
    // ausdrücklich nicht, dass die Nutzdaten fachlich stimmen. Genau dafür gibt es den Debug-Endpunkt.
    const ok = response.status === 204 || response.status === 200;
    return {
      sink: 'ga4',
      ok,
      status: ok ? 'sent' : 'failed',
      http_status: response.status,
      detail: ok
        ? `An Measurement Protocol gesendet, Ereignis ${envelope.event_name}.`
        : `Unerwarteter Status ${response.status}.`,
      validation_messages: validationMessages,
      duration_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      sink: 'ga4',
      ok: false,
      status: 'failed',
      detail: `Netzwerkfehler: ${String(error)}`,
      validation_messages: validationMessages,
      duration_ms: Date.now() - started,
    };
  }
}
