/**
 * Normalisierung personenbezogener Felder vor dem Hashen.
 *
 * Der Grund dafür ist der Abgleich auf der Gegenseite. Ein Hash trifft nur dann, wenn beide Seiten
 * exakt denselben Eingabestring gehasht haben. "Max.Mustermann@Example.COM " und
 * "max.mustermann@example.com" ergeben zwei völlig verschiedene Hashes und damit keine Übereinstimmung.
 * Die Regeln hier folgen der öffentlichen Vorgabe von Meta für die Conversions API.
 */

/** Trimmen und in Kleinbuchstaben. Leere Werte ergeben undefined, damit sie nicht als Hash von "" landen. */
export function normalizeEmail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().toLowerCase();
  if (!cleaned.includes('@')) return undefined;
  return cleaned;
}

/**
 * Telefonnummer auf reine Ziffern mit Ländervorwahl bringen.
 *
 * "+49 151 51834055" und "0151 51834055" müssen denselben Hash ergeben, sonst läuft der Abgleich
 * für deutsche Formulareingaben ins Leere. Genau diese Stelle wird in der Praxis am häufigsten
 * falsch gemacht.
 */
export function normalizePhone(
  value: string | undefined,
  defaultCountryCode = '49',
): string | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  const hasPlus = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (!digits) return undefined;

  if (hasPlus) {
    // Bereits internationale Form. Die Vorwahl steht vorne.
  } else if (digits.startsWith('00')) {
    // Internationale Wählform, zum Beispiel 0049151...
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    // Nationale Wählform, zum Beispiel 0151... Die führende Null ist die Verkehrsausscheidungsziffer
    // und fällt weg, davor kommt die Ländervorwahl.
    digits = defaultCountryCode + digits.replace(/^0+/, '');
  } else if (!digits.startsWith(defaultCountryCode)) {
    digits = defaultCountryCode + digits;
  }

  // Schreibweisen wie "+49 (0)151 ..." sind im deutschen Geschäftsverkehr üblich und ergeben sonst
  // eine Nummer mit einer Null zu viel. Nach der Ländervorwahl steht nie eine führende Null.
  //
  // Diese Regel gilt bewusst nur für die eingestellte Standardvorwahl. In Italien zum Beispiel gehört
  // die Null hinter der Vorwahl zur Rufnummer, dort wäre dasselbe Vorgehen falsch.
  if (digits.startsWith(defaultCountryCode + '0')) {
    digits = defaultCountryCode + digits.slice(defaultCountryCode.length).replace(/^0+/, '');
  }

  // E.164 erlaubt höchstens fünfzehn Ziffern einschließlich Ländervorwahl. Alles unter acht Ziffern
  // ist keine belastbare Rufnummer und würde im Abgleich nur Rauschen erzeugen.
  if (digits.length < 8 || digits.length > 15) return undefined;
  return digits;
}

/** Namen, Ort: klein, ohne Interpunktion, ohne Leerzeichen. Umlaute bleiben erhalten. */
export function normalizeName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
  return cleaned || undefined;
}

/** Ländercode nach ISO 3166-1 alpha-2, klein. */
export function normalizeCountry(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (cleaned.length !== 2) return undefined;
  return cleaned;
}

/** Eigene Kundennummer. Wird nur getrimmt, weil sie in beiden Systemen identisch vorliegt. */
export function normalizeExternalId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim();
  return cleaned || undefined;
}
