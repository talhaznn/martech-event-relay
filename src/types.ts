/**
 * Gemeinsame Typen des Relays.
 *
 * Wichtig für das Verständnis des ganzen Projekts: es gibt zwei Formen eines Ereignisses.
 *
 *   RawEvent       das, was der Browser schickt. Kann Klartext enthalten, zum Beispiel eine
 *                  E-Mail-Adresse aus einem Formular.
 *   EventEnvelope  das, was der Relay intern weiterreicht und im Fehlerfall zwischenspeichert.
 *                  Hier sind alle personenbezogenen Felder bereits normalisiert und mit SHA-256
 *                  gehasht. Klartext verlässt die Funktion nie und wird nirgends abgelegt.
 */

export interface Env {
  RELAY: KVNamespace;

  /** Messstream der GA4 Property, Form G-XXXXXXXXXX. */
  GA4_MEASUREMENT_ID: string;
  /** Wenn "true", geht der GA4-Sink auf den Debug-Endpunkt und liefert Validierungsmeldungen zurück. */
  GA4_DEBUG: string;
  /** Kommagetrennte Liste erlaubter Browser-Origins, oder "*" für die öffentliche Demo. */
  ALLOWED_ORIGINS: string;
  /** Lebensdauer der Dedup-Schlüssel in Sekunden. */
  DEDUPE_TTL_SECONDS: string;
  /** Vollständige URL des CAPI-förmigen Empfängers. Leer bedeutet: der Relay ruft sich selbst auf. */
  CAPI_ENDPOINT: string;

  /** Geheimnisse, gesetzt über wrangler secret put. */
  RELAY_HMAC_SECRET: string;
  GA4_API_SECRET?: string;
  N8N_RETRY_WEBHOOK?: string;
}

export type ActionSource = 'website' | 'app' | 'email' | 'phone_call' | 'chat' | 'other';

/** Personenbezogene Felder, wie sie der Browser liefert. Klartext. */
export interface RawUserData {
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  city?: string;
  country?: string;
  external_id?: string;
}

/** Dieselben Felder nach Normalisierung und SHA-256. Nur noch Hexadezimal, 64 Zeichen. */
export interface HashedUserData {
  em?: string;
  ph?: string;
  fn?: string;
  ln?: string;
  ct?: string;
  country?: string;
  external_id?: string;
}

export interface CustomData {
  value?: number;
  currency?: string;
  content_name?: string;
  content_category?: string;
  order_id?: string;
}

export interface ConsentState {
  analytics: boolean;
  marketing: boolean;
}

export interface RawEvent {
  event_id: string;
  event_name: string;
  event_time: number;
  action_source: ActionSource;
  event_source_url?: string;
  /** GA4 client_id aus dem _ga Cookie. Ohne diesen Wert landet das Serverereignis bei einem neuen Nutzer. */
  client_id?: string;
  /** GA4 session_id aus dem _ga_<Stream> Cookie. Ohne diesen Wert beginnt serverseitig eine neue Sitzung. */
  session_id?: string;
  user_data?: RawUserData;
  custom_data?: CustomData;
  consent?: ConsentState;
}

export interface EventEnvelope {
  event_id: string;
  event_name: string;
  event_time: number;
  action_source: ActionSource;
  event_source_url?: string;
  client_id?: string;
  session_id?: string;
  user_data: HashedUserData;
  custom_data: CustomData;
  consent: ConsentState;
  /** "browser" für Aufrufe von der Demoseite, "server" für signierte Aufrufe. */
  source: 'browser' | 'server';
  /** Zeitpunkt, zu dem der Relay das Ereignis angenommen hat. */
  received_at: number;
}

export type SinkName = 'ga4' | 'capi';

export interface SinkResult {
  sink: SinkName;
  ok: boolean;
  /** "sent", "skipped" oder "failed". "skipped" heißt: bewusst nicht gesendet, kein Fehler. */
  status: 'sent' | 'skipped' | 'failed';
  http_status?: number;
  /** Kurze Begründung, die auch in der Antwort an den Aufrufer sichtbar wird. */
  detail?: string;
  /** Nur gefüllt, wenn GA4_DEBUG aktiv ist. */
  validation_messages?: unknown[];
  duration_ms: number;
}

export interface CollectResponse {
  status: 'accepted' | 'duplicate' | 'rejected';
  event_id: string;
  duplicate: boolean;
  /** Bei einem Duplikat: wann das Original angenommen wurde. */
  first_seen_at?: number;
  sinks: SinkResult[];
  retry_scheduled: SinkName[];
  received_at: number;
}
