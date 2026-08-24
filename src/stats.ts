import type { SinkName } from './types.ts';

/**
 * Zähler für die Tageszusammenfassung.
 *
 * Der naheliegende Weg wäre ein Schlüssel pro Tag, der gelesen, hochgezählt und zurückgeschrieben
 * wird. Bei Workers KV verliert dieser Weg unter Last Zählungen, weil zwei gleichzeitige Aufrufe
 * denselben Ausgangswert lesen und der zweite den ersten überschreibt.
 *
 * Deshalb schreibt der Relay pro Ereignis einen eigenen kleinen Schlüssel und zählt beim Abruf über
 * list. Das kann nichts verlieren. Der Preis ist ein Listendurchlauf beim Lesen, was für eine
 * Tageszusammenfassung völlig in Ordnung ist. Bei echtem Volumen wäre Analytics Engine oder ein
 * Durable Object die richtige Wahl, und genau das steht auch im Kapitel "Grenzen" des README.
 */

const STAT_PREFIX = 'stat:';
const STAT_TTL = 8 * 24 * 60 * 60;
const LIST_PAGE_LIMIT = 1000;

export type StatScope = SinkName | 'relay';
export type StatStatus = 'sent' | 'skipped' | 'failed' | 'accepted' | 'duplicate' | 'rejected';

export function dayKey(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
}

export function statKey(day: string, scope: StatScope, status: StatStatus, eventId: string): string {
  return `${STAT_PREFIX}${day}:${scope}:${status}:${eventId}`;
}

export async function record(
  kv: KVNamespace,
  day: string,
  scope: StatScope,
  status: StatStatus,
  eventId: string,
): Promise<void> {
  await kv.put(statKey(day, scope, status, eventId), '1', { expirationTtl: STAT_TTL });
}

export interface DaySummary {
  day: string;
  counts: Record<string, number>;
  total: number;
}

/** Zählt alle Schlüssel eines Tages und gruppiert nach Ziel und Status. */
export async function summarizeDay(kv: KVNamespace, day: string): Promise<DaySummary> {
  const counts: Record<string, number> = {};
  let total = 0;
  let cursor: string | undefined;

  for (;;) {
    const page = await kv.list({ prefix: `${STAT_PREFIX}${day}:`, limit: LIST_PAGE_LIMIT, cursor });
    for (const entry of page.keys) {
      // Aufbau: stat:<tag>:<ziel>:<status>:<event_id>
      const parts = entry.name.split(':');
      const scope = parts[2];
      const status = parts[3];
      if (!scope || !status) continue;
      const bucket = `${scope}.${status}`;
      counts[bucket] = (counts[bucket] ?? 0) + 1;
      total += 1;
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }

  return { day, counts, total };
}

export async function summarize(kv: KVNamespace, nowSeconds: number, days: number): Promise<DaySummary[]> {
  const out: DaySummary[] = [];
  const bounded = Math.min(Math.max(days, 1), 8);
  for (let offset = 0; offset < bounded; offset++) {
    const day = dayKey(nowSeconds - offset * 86400);
    out.push(await summarizeDay(kv, day));
  }
  return out;
}
