import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGa4Payload } from '../src/sinks/ga4.ts';
import { buildCapiPayload, resolveCapiEndpoint, toStandardEventName } from '../src/sinks/capi.ts';
import { NOW, umschlag } from './fixtures.ts';

test('GA4 bekommt die event_id als Parameter mit', () => {
  const payload = buildGa4Payload(umschlag(), NOW);
  assert.equal(payload.events[0]?.params.event_id, 'evt_4f3c2a1b9d8e7f60');
});

test('die Kennung geht zusätzlich unter einem eigenen Namen mit', () => {
  // event_id hat bei Meta eine feste Bedeutung. relay_event_id ist ein selbst vergebener
  // Name ohne Sonderbedeutung bei irgendeinem Ziel und macht den Vergleich der beiden
  // Wege unabhängig davon, wie ein Ziel event_id auslegt.
  const payload = buildGa4Payload(umschlag(), NOW);
  assert.equal(payload.events[0]?.params.relay_event_id, 'evt_4f3c2a1b9d8e7f60');
  assert.equal(payload.events[0]?.params.relay_event_id, payload.events[0]?.params.event_id);
});

test('GA4 bekommt engagement_time_msec, sonst fällt das Ereignis aus den Berichten', () => {
  const payload = buildGa4Payload(umschlag(), NOW);
  assert.equal(payload.events[0]?.params.engagement_time_msec, 1);
});

test('client_id und session_id werden durchgereicht, damit die Sitzung zusammenbleibt', () => {
  const payload = buildGa4Payload(umschlag(), NOW);
  assert.equal(payload.client_id, '1234567890.1756108800');
  assert.equal(payload.events[0]?.params.session_id, '1756108800');
});

test('ohne client_id entsteht ein stabiler Ersatzwert in gültiger Form', () => {
  const payload = buildGa4Payload(umschlag({ client_id: undefined }), NOW);
  assert.match(payload.client_id, /^\d+\.\d+$/);
  assert.equal(payload.client_id, buildGa4Payload(umschlag({ client_id: undefined }), NOW).client_id);
});

test('der Zeitstempel fällt weg, sobald er älter als zweiundsiebzig Stunden ist', () => {
  const frisch = buildGa4Payload(umschlag({ event_time: NOW - 3600 }), NOW);
  assert.equal(frisch.timestamp_micros, String((NOW - 3600) * 1_000_000));

  const alt = buildGa4Payload(umschlag({ event_time: NOW - 80 * 3600 }), NOW);
  assert.equal(alt.timestamp_micros, undefined);
});

test('die Einwilligung wird auf die Consent-Felder von GA4 abgebildet', () => {
  const mit = buildGa4Payload(umschlag({ consent: { analytics: true, marketing: true } }), NOW);
  assert.equal(mit.consent?.ad_user_data, 'GRANTED');
  assert.equal(mit.non_personalized_ads, false);

  const ohne = buildGa4Payload(umschlag({ consent: { analytics: true, marketing: false } }), NOW);
  assert.equal(ohne.consent?.ad_personalization, 'DENIED');
  assert.equal(ohne.non_personalized_ads, true);
});

test('CAPI erhält die Identifikatoren als Listen und nur als Hashes', () => {
  const payload = buildCapiPayload(umschlag());
  const event = payload.data[0]!;
  assert.deepEqual(event.user_data.em, ['a'.repeat(64)]);
  assert.deepEqual(event.user_data.ph, ['b'.repeat(64)]);
  assert.ok(!JSON.stringify(payload).includes('@'));
});

test('CAPI übersetzt auf die Standardereignisse von Meta', () => {
  assert.equal(toStandardEventName('demo_conversion_server'), 'Lead');
  assert.equal(toStandardEventName('purchase'), 'Purchase');
  assert.equal(toStandardEventName('begin_checkout'), 'InitiateCheckout');
  // Unbekannte Namen gehen unverändert durch und landen als eigenes Ereignis.
  assert.equal(toStandardEventName('irgendwas_eigenes'), 'irgendwas_eigenes');
});

test('CAPI trägt dieselbe event_id wie GA4, das ist die Grundlage der Deduplizierung', () => {
  const envelope = umschlag();
  const ga4 = buildGa4Payload(envelope, NOW);
  const capi = buildCapiPayload(envelope);
  assert.equal(capi.data[0]?.event_id, ga4.events[0]?.params.event_id);
});

test('ein leeres custom_data erzeugt kein leeres Feld in der Nutzlast', () => {
  const payload = buildCapiPayload(umschlag({ custom_data: {} }));
  assert.equal('custom_data' in payload.data[0]!, false);
});

test('die Zieladresse lässt sich relativ oder absolut angeben', () => {
  assert.equal(
    resolveCapiEndpoint('', 'https://relay.example/collect'),
    'https://relay.example/capi/events',
  );
  assert.equal(
    resolveCapiEndpoint('/capi/events', 'https://relay.example/collect'),
    'https://relay.example/capi/events',
  );
  assert.equal(
    resolveCapiEndpoint('https://anderer-empfaenger.example/events', 'https://relay.example/collect'),
    'https://anderer-empfaenger.example/events',
  );
});
