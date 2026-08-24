import { bytesToHex } from './hash.ts';

/**
 * HMAC-SHA256 über Zeitstempel und Rohtext des Körpers.
 *
 * Signiert wird die Zeichenkette "<timestamp>.<rawBody>" und nicht nur der Körper. Der Zeitstempel
 * gehört in die Signatur, sonst kann ein abgefangener Aufruf beliebig oft wiederholt werden, ohne
 * dass die Signatur ungültig wird.
 */

const encoder = new TextEncoder();
const PREFIX = 'v1=';

/** Standardfenster für die Wiederholungssperre. Aufrufe außerhalb davon werden abgelehnt. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function sign(secret: string, timestamp: number, rawBody: string): Promise<string> {
  const key = await importKey(secret);
  const payload = encoder.encode(`${timestamp}.${rawBody}`);
  const mac = await crypto.subtle.sign('HMAC', key, payload);
  return PREFIX + bytesToHex(new Uint8Array(mac));
}

/**
 * Vergleich in konstanter Zeit.
 *
 * Ein normaler Vergleich mit === bricht beim ersten abweichenden Zeichen ab. Über die Laufzeit
 * lässt sich damit Zeichen für Zeichen die richtige Signatur erraten. Diese Schleife läuft immer
 * über die volle Länge.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type VerifyFailure =
  | 'missing_header'
  | 'malformed_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'bad_signature';

export interface VerifyResult {
  ok: boolean;
  reason?: VerifyFailure;
}

export async function verify(
  secret: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  rawBody: string,
  nowSeconds: number,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): Promise<VerifyResult> {
  if (!timestampHeader || !signatureHeader) return { ok: false, reason: 'missing_header' };

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || !Number.isInteger(timestamp)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  const expected = await sign(secret, timestamp, rawBody);
  if (!timingSafeEqual(expected, signatureHeader.trim())) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}
