import type { EventEnvelope } from '../src/types.ts';

export const NOW = 1_756_108_800;

/** Ein bereits gehashter Umschlag, so wie er nach handleCollect im Speicher liegt. */
export function umschlag(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: 'evt_4f3c2a1b9d8e7f60',
    event_name: 'demo_conversion_server',
    event_time: NOW,
    action_source: 'website',
    event_source_url: 'https://martech-event-relay.example/',
    client_id: '1234567890.1756108800',
    session_id: '1756108800',
    user_data: {
      em: 'a'.repeat(64),
      ph: 'b'.repeat(64),
      external_id: 'c'.repeat(64),
    },
    custom_data: { value: 49.9, currency: 'EUR', content_name: 'Demo' },
    consent: { analytics: true, marketing: true },
    source: 'browser',
    received_at: NOW,
    ...overrides,
  };
}
