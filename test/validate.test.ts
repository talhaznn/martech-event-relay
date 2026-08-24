import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../src/validate.ts';

const NOW = 1_756_108_800;

function beispielEreignis(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'evt_4f3c2a1b9d8e7f60',
    event_name: 'demo_conversion_server',
    event_time: NOW,
    action_source: 'website',
    event_source_url: 'https://martech-event-relay.example/',
    client_id: '1234567890.1756108800',
    session_id: '1756108800',
    user_data: { email: 'max@example.com', phone: '0151 51834055' },
    custom_data: { value: 49.9, currency: 'EUR' },
    consent: { analytics: true, marketing: true },
    ...overrides,
  };
}

test('ein vollständiges Ereignis geht durch, ohne Warnungen', () => {
  const result = validateEvent(beispielEreignis(), NOW);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.warnings, []);
});

test('ein unbekanntes Feld wird abgelehnt statt stillschweigend verworfen', () => {
  const result = validateEvent(beispielEreignis({ evnet_name: 'tippfehler' }), NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((error) => error.code === 'unknown_field'));
});

test('GA4 lässt keine Großbuchstaben im Ereignisnamen zu', () => {
  const result = validateEvent(beispielEreignis({ event_name: 'DemoConversion' }), NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((error) => error.field === 'event_name'));
});

test('Millisekunden statt Sekunden fallen auf', () => {
  const result = validateEvent(beispielEreignis({ event_time: NOW * 1000 }), NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((error) => error.code === 'event_time_in_future'));
});

test('ein Ereignis älter als sieben Tage wird abgelehnt', () => {
  const result = validateEvent(beispielEreignis({ event_time: NOW - 8 * 86400 }), NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((error) => error.code === 'event_time_too_old'));
});

test('zwischen zweiundsiebzig Stunden und sieben Tagen gibt es eine Warnung, keinen Fehler', () => {
  const result = validateEvent(beispielEreignis({ event_time: NOW - 4 * 86400 }), NOW);
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.warnings.some((warning) => warning.code === 'event_time_older_than_72h'));
});

test('ein Betrag ohne Währung wird abgelehnt', () => {
  const result = validateEvent(beispielEreignis({ custom_data: { value: 12 } }), NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((error) => error.code === 'currency_required_with_value'));
});

test('eine Währung in Kleinbuchstaben wird abgelehnt', () => {
  const result = validateEvent(beispielEreignis({ custom_data: { value: 12, currency: 'eur' } }), NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((error) => error.field === 'custom_data.currency'));
});

test('eine client_id in falscher Form wird abgelehnt, eine fehlende nur bemängelt', () => {
  const falsch = validateEvent(beispielEreignis({ client_id: 'GA1.1.123.456' }), NOW);
  assert.equal(falsch.ok, false);

  const ohne = beispielEreignis();
  delete ohne.client_id;
  const fehlend = validateEvent(ohne, NOW);
  assert.equal(fehlend.ok, true);
  if (fehlend.ok) assert.ok(fehlend.warnings.some((warning) => warning.code === 'missing_client_id'));
});

test('fehlende Einwilligung erzeugt eine Warnung', () => {
  const ohne = beispielEreignis();
  delete ohne.consent;
  const result = validateEvent(ohne, NOW);
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.warnings.some((warning) => warning.code === 'missing_consent'));
});

test('unbekannte Unterfelder in user_data werden abgelehnt', () => {
  const result = validateEvent(beispielEreignis({ user_data: { emial: 'tippfehler@example.com' } }), NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors[0]?.field, 'user_data.emial');
});

test('etwas, das kein Objekt ist, wird sauber abgewiesen', () => {
  for (const eingabe of ['zeichenkette', 42, null, [1, 2, 3]]) {
    const result = validateEvent(eingabe, NOW);
    assert.equal(result.ok, false);
  }
});

test('eine event_source_url ohne http oder https wird abgelehnt', () => {
  const result = validateEvent(beispielEreignis({ event_source_url: 'javascript:alert(1)' }), NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((error) => error.field === 'event_source_url'));
});
