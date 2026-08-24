import type { EventEnvelope, SinkName } from './types.ts';

/**
 * Deduplizierung über Workers KV.
 *
 * Der Schlüssel ist die event_id. Wer dieselbe event_id zweimal schickt, bekommt beim zweiten Mal
 * duplicate: true und der Fan-out unterbleibt. Genau das passiert im Alltag ständig: doppelte Klicks,
 * ein erneut gesendetes Formular, ein Wiederholversuch nach einem Netzwerkfehler, ein zweiter
 * Seitenaufruf aus dem Verlauf.
 *
 * Ehrliche Einordnung, die auch im README steht: KV kennt kein atomares "nur schreiben, wenn nicht
 * vorhanden". Zwischen dem Lesen und dem Schreiben liegt ein kleines Zeitfenster, in dem zwei
 * gleichzeitige Aufrufe beide auf "neu" entscheiden können. Für Produktivlast mit echter Nebenläufigkeit
 * wäre ein Durable Object der richtige Baustein, weil dort pro event_id genau eine Instanz läuft und
 * die Entscheidung serialisiert ist. Für diese Demo ist das Fenster benannt statt versteckt.
 */

const DEDUPE_PREFIX = 'evt:';
const ENVELOPE_PREFIX = 'env:';

export interface DedupeRecord {
  first_seen_at: number;
  event_name: string;
  source: string;
}

export interface DedupeDecision {
  duplicate: boolean;
  first_seen_at?: number;
}

/** KV verlangt eine Mindestlebensdauer von sechzig Sekunden. */
const MIN_TTL = 60;

export function dedupeKey(eventId: string): string {
  return DEDUPE_PREFIX + eventId;
}

export async function checkAndMark(
  kv: KVNamespace,
  envelope: EventEnvelope,
  ttlSeconds: number,
): Promise<DedupeDecision> {
  const key = dedupeKey(envelope.event_id);
  const existing = await kv.get<DedupeRecord>(key, 'json');
  if (existing) {
    return { duplicate: true, first_seen_at: existing.first_seen_at };
  }

  const record: DedupeRecord = {
    first_seen_at: envelope.received_at,
    event_name: envelope.event_name,
    source: envelope.source,
  };
  await kv.put(key, JSON.stringify(record), {
    expirationTtl: Math.max(MIN_TTL, ttlSeconds),
  });
  return { duplicate: false };
}

/**
 * Zwischenspeicher für Wiederholversuche.
 *
 * Abgelegt wird der bereits gehashte Umschlag, nicht der Rohkörper. Damit liegt zu keinem Zeitpunkt
 * eine Klartext-Adresse in KV, und n8n muss die Nutzdaten gar nicht erst durch seine Datenbank tragen.
 * Der Wiederholversuch schickt nur die event_id und den Namen des Ziels.
 */
export async function storeEnvelope(
  kv: KVNamespace,
  envelope: EventEnvelope,
  ttlSeconds: number,
): Promise<void> {
  await kv.put(ENVELOPE_PREFIX + envelope.event_id, JSON.stringify(envelope), {
    expirationTtl: Math.max(MIN_TTL, ttlSeconds),
  });
}

export async function loadEnvelope(kv: KVNamespace, eventId: string): Promise<EventEnvelope | null> {
  return kv.get<EventEnvelope>(ENVELOPE_PREFIX + eventId, 'json');
}

/** Dedup-Schlüssel des CAPI-Empfängers. Meta unterscheidet nach event_id und event_name zusammen. */
export function capiDedupeKey(eventId: string, eventName: string): string {
  return `capi:${eventName}:${eventId}`;
}

export function retryKey(eventId: string, sink: SinkName): string {
  return `retry:${eventId}:${sink}`;
}
