import type { HashedUserData, RawUserData } from './types.ts';
import {
  normalizeCountry,
  normalizeEmail,
  normalizeExternalId,
  normalizeName,
  normalizePhone,
} from './normalize.ts';

const encoder = new TextEncoder();

/** SHA-256 als Hexadezimalstring in Kleinbuchstaben. Läuft unverändert im Worker und in Node. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Ein Hash ist genau dann gültig, wenn er 64 Zeichen aus 0 bis 9 und a bis f hat. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/**
 * Wandelt die Klartextfelder aus dem Browser in gehashte Felder um.
 *
 * Nach dieser Funktion existiert im Prozess kein Klartext mehr, der weitergereicht oder gespeichert
 * wird. Das ist bewusst früh im Ablauf platziert, damit auch der Zwischenspeicher für
 * Wiederholversuche niemals Klartext enthält.
 */
export async function hashUserData(
  raw: RawUserData | undefined,
  defaultCountryCode = '49',
): Promise<HashedUserData> {
  if (!raw) return {};

  const normalized: Record<keyof HashedUserData, string | undefined> = {
    em: normalizeEmail(raw.email),
    ph: normalizePhone(raw.phone, defaultCountryCode),
    fn: normalizeName(raw.first_name),
    ln: normalizeName(raw.last_name),
    ct: normalizeName(raw.city),
    country: normalizeCountry(raw.country),
    external_id: normalizeExternalId(raw.external_id),
  };

  const out: HashedUserData = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined) continue;
    out[key as keyof HashedUserData] = await sha256Hex(value);
  }
  return out;
}
