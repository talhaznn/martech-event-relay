/**
 * Strukturierte Logzeilen.
 *
 * Ausgegeben wird eine Zeile JSON pro Ereignis. Das lässt sich mit wrangler tail live mitlesen und
 * später ohne Nacharbeit filtern. Freitext-Logs sind nach zwei Wochen wertlos, weil niemand mehr
 * weiß, wonach er greppen soll.
 *
 * Zusätzlich landen die letzten Zeilen in einem Ringpuffer in KV. Der Endpunkt /debug/recent gibt
 * sie zurück, damit sich der Ablauf ohne Terminalzugriff nachvollziehen lässt.
 */

const RING_KEY = 'log:recent';
const RING_SIZE = 25;
const RING_TTL = 24 * 60 * 60;

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogLine {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): LogLine {
  const line: LogLine = { ts: new Date().toISOString(), level, msg, ...fields };
  const serialized = JSON.stringify(line);
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.log(serialized);
  return line;
}

/**
 * Ringpuffer in KV.
 *
 * Auch hier gilt die Einschränkung aus dedupe.ts: lesen, ändern, schreiben ist nicht atomar. Bei
 * gleichzeitigen Aufrufen kann eine Zeile verloren gehen. Für eine Anzeige der letzten Ereignisse
 * ist das vertretbar, für eine Abrechnung wäre es das nicht.
 */
export async function pushToRing(kv: KVNamespace, line: LogLine): Promise<void> {
  try {
    const current = (await kv.get<LogLine[]>(RING_KEY, 'json')) ?? [];
    current.unshift(line);
    await kv.put(RING_KEY, JSON.stringify(current.slice(0, RING_SIZE)), { expirationTtl: RING_TTL });
  } catch (error) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'ring_write_failed', error: String(error) }));
  }
}

export async function readRing(kv: KVNamespace): Promise<LogLine[]> {
  return (await kv.get<LogLine[]>(RING_KEY, 'json')) ?? [];
}
