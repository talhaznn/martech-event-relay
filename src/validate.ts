import type { ActionSource, RawEvent } from './types.ts';

/**
 * Handgeschriebene Schemaprüfung ohne Fremdbibliothek.
 *
 * Zwei Entscheidungen liegen dem zugrunde. Erstens hat der Worker damit null Laufzeitabhängigkeiten,
 * was Startzeit und Angriffsfläche klein hält. Zweitens ist die Prüfung streng und nicht nachsichtig.
 * Unbekannte Felder werden abgelehnt statt stillschweigend durchgereicht, damit ein Tippfehler im
 * Tag-Manager sofort auffällt und nicht erst Wochen später in einem leeren Bericht.
 */

export interface ValidationError {
  field: string;
  code: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: RawEvent; warnings: ValidationError[] }
  | { ok: false; errors: ValidationError[] };

const ACTION_SOURCES: ActionSource[] = ['website', 'app', 'email', 'phone_call', 'chat', 'other'];

/** Konvention dieses Projekts: evt_ gefolgt von einer UUID ohne Bindestriche. */
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

/** Regel von GA4: Buchstabe am Anfang, danach Buchstaben, Ziffern und Unterstriche, höchstens 40 Zeichen. */
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/** Form der GA4 client_id aus dem _ga Cookie, zum Beispiel 1234567890.1756108800 */
const CLIENT_ID_PATTERN = /^\d{1,20}\.\d{1,20}$/;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const USER_DATA_KEYS = ['email', 'phone', 'first_name', 'last_name', 'city', 'country', 'external_id'];
const CUSTOM_DATA_KEYS = ['value', 'currency', 'content_name', 'content_category', 'order_id'];
const TOP_LEVEL_KEYS = [
  'event_id',
  'event_name',
  'event_time',
  'action_source',
  'event_source_url',
  'client_id',
  'session_id',
  'user_data',
  'custom_data',
  'consent',
];

const SEVEN_DAYS = 7 * 24 * 60 * 60;
const SEVENTY_TWO_HOURS = 72 * 60 * 60;
const FIVE_MINUTES = 5 * 60;
const MAX_STRING_LENGTH = 256;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateEvent(input: unknown, nowSeconds: number): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ field: '(root)', code: 'not_an_object', message: 'Der Körper muss ein JSON-Objekt sein.' }],
    };
  }

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      errors.push({
        field: key,
        code: 'unknown_field',
        message: `Unbekanntes Feld. Erlaubt sind: ${TOP_LEVEL_KEYS.join(', ')}.`,
      });
    }
  }

  const eventId = input.event_id;
  if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) {
    errors.push({
      field: 'event_id',
      code: 'invalid_event_id',
      message: 'Pflichtfeld. Acht bis achtzig Zeichen aus Buchstaben, Ziffern, Bindestrich und Unterstrich. Empfohlen ist evt_ gefolgt von einer UUID.',
    });
  }

  const eventName = input.event_name;
  if (typeof eventName !== 'string' || !EVENT_NAME_PATTERN.test(eventName)) {
    errors.push({
      field: 'event_name',
      code: 'invalid_event_name',
      message: 'Pflichtfeld. GA4 erlaubt nur Kleinbuchstaben, Ziffern und Unterstriche, muss mit einem Buchstaben beginnen, höchstens vierzig Zeichen.',
    });
  }

  const eventTime = input.event_time;
  if (typeof eventTime !== 'number' || !Number.isInteger(eventTime)) {
    errors.push({
      field: 'event_time',
      code: 'invalid_event_time',
      message: 'Pflichtfeld. Unix-Zeit in ganzen Sekunden, nicht in Millisekunden.',
    });
  } else if (eventTime > nowSeconds + FIVE_MINUTES) {
    errors.push({
      field: 'event_time',
      code: 'event_time_in_future',
      message: 'Der Zeitstempel liegt mehr als fünf Minuten in der Zukunft.',
    });
  } else if (eventTime < nowSeconds - SEVEN_DAYS) {
    errors.push({
      field: 'event_time',
      code: 'event_time_too_old',
      message: 'Der Zeitstempel ist älter als sieben Tage und wird von den Zielsystemen nicht mehr angenommen.',
    });
  } else if (eventTime < nowSeconds - SEVENTY_TWO_HOURS) {
    warnings.push({
      field: 'event_time',
      code: 'event_time_older_than_72h',
      message: 'Älter als zweiundsiebzig Stunden. GA4 verwirft in dem Fall den mitgesendeten Zeitstempel und setzt die Empfangszeit.',
    });
  }

  const actionSource = input.action_source;
  if (typeof actionSource !== 'string' || !ACTION_SOURCES.includes(actionSource as ActionSource)) {
    errors.push({
      field: 'action_source',
      code: 'invalid_action_source',
      message: `Pflichtfeld. Erlaubt sind: ${ACTION_SOURCES.join(', ')}.`,
    });
  }

  if (input.event_source_url !== undefined) {
    const url = input.event_source_url;
    if (typeof url !== 'string' || url.length > 1024) {
      errors.push({ field: 'event_source_url', code: 'invalid_url', message: 'Höchstens 1024 Zeichen.' });
    } else {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
      } catch {
        errors.push({ field: 'event_source_url', code: 'invalid_url', message: 'Keine gültige http- oder https-Adresse.' });
      }
    }
  }

  if (input.client_id !== undefined) {
    if (typeof input.client_id !== 'string' || !CLIENT_ID_PATTERN.test(input.client_id)) {
      errors.push({
        field: 'client_id',
        code: 'invalid_client_id',
        message: 'Form 1234567890.1756108800, so wie sie im _ga Cookie steht.',
      });
    }
  } else {
    warnings.push({
      field: 'client_id',
      code: 'missing_client_id',
      message: 'Ohne client_id legt GA4 für das Serverereignis einen eigenen Nutzer an. Der Wert steht im _ga Cookie.',
    });
  }

  if (input.session_id !== undefined && !/^\d{1,20}$/.test(String(input.session_id))) {
    errors.push({ field: 'session_id', code: 'invalid_session_id', message: 'Nur Ziffern.' });
  }

  if (input.user_data !== undefined) {
    if (!isPlainObject(input.user_data)) {
      errors.push({ field: 'user_data', code: 'not_an_object', message: 'Muss ein Objekt sein.' });
    } else {
      for (const [key, value] of Object.entries(input.user_data)) {
        if (!USER_DATA_KEYS.includes(key)) {
          errors.push({
            field: `user_data.${key}`,
            code: 'unknown_field',
            message: `Unbekanntes Feld. Erlaubt sind: ${USER_DATA_KEYS.join(', ')}.`,
          });
        } else if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH) {
          errors.push({
            field: `user_data.${key}`,
            code: 'invalid_string',
            message: `Muss eine Zeichenkette mit höchstens ${MAX_STRING_LENGTH} Zeichen sein.`,
          });
        }
      }
    }
  }

  if (input.custom_data !== undefined) {
    if (!isPlainObject(input.custom_data)) {
      errors.push({ field: 'custom_data', code: 'not_an_object', message: 'Muss ein Objekt sein.' });
    } else {
      for (const [key, value] of Object.entries(input.custom_data)) {
        if (!CUSTOM_DATA_KEYS.includes(key)) {
          errors.push({
            field: `custom_data.${key}`,
            code: 'unknown_field',
            message: `Unbekanntes Feld. Erlaubt sind: ${CUSTOM_DATA_KEYS.join(', ')}.`,
          });
          continue;
        }
        if (key === 'value') {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            errors.push({ field: 'custom_data.value', code: 'invalid_value', message: 'Muss eine Zahl größer oder gleich null sein.' });
          }
        } else if (key === 'currency') {
          if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
            errors.push({ field: 'custom_data.currency', code: 'invalid_currency', message: 'Drei Großbuchstaben nach ISO 4217, zum Beispiel EUR.' });
          }
        } else if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH) {
          errors.push({
            field: `custom_data.${key}`,
            code: 'invalid_string',
            message: `Muss eine Zeichenkette mit höchstens ${MAX_STRING_LENGTH} Zeichen sein.`,
          });
        }
      }
      const cd = input.custom_data;
      if (typeof cd.value === 'number' && cd.currency === undefined) {
        errors.push({
          field: 'custom_data.currency',
          code: 'currency_required_with_value',
          message: 'Ein Betrag ohne Währung ist nicht auswertbar. Beides gehört zusammen.',
        });
      }
    }
  }

  if (input.consent !== undefined) {
    if (!isPlainObject(input.consent)) {
      errors.push({ field: 'consent', code: 'not_an_object', message: 'Muss ein Objekt sein.' });
    } else {
      for (const key of ['analytics', 'marketing']) {
        if (typeof input.consent[key] !== 'boolean') {
          errors.push({ field: `consent.${key}`, code: 'invalid_boolean', message: 'Muss true oder false sein.' });
        }
      }
    }
  } else {
    warnings.push({
      field: 'consent',
      code: 'missing_consent',
      message: 'Ohne Angabe nimmt der Relay Analytics als erlaubt und Marketing als nicht erlaubt an. Der werbliche Sink wird dann übersprungen.',
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as RawEvent, warnings };
}
