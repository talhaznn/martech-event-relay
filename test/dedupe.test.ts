import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capiDedupeKey, checkAndMark, dedupeKey, loadEnvelope, storeEnvelope } from '../src/dedupe.ts';
import { dayKey, record, summarize, summarizeDay } from '../src/stats.ts';
import { MockKV } from './kv-mock.ts';
import { NOW, umschlag } from './fixtures.ts';

function kv(): any {
  const mock = new MockKV();
  mock.now = NOW;
  return mock;
}

test('das erste Ereignis ist neu, das zweite ist ein Duplikat', async () => {
  const store = kv();
  const envelope = umschlag();

  const erst = await checkAndMark(store, envelope, 86400);
  assert.deepEqual(erst, { duplicate: false });

  const zweit = await checkAndMark(store, { ...envelope, received_at: NOW + 5 }, 86400);
  assert.equal(zweit.duplicate, true);
  // Der Zeitpunkt des Originals bleibt erhalten, nicht der des Wiederholers.
  assert.equal(zweit.first_seen_at, NOW);
});

test('verschiedene event_id sind verschiedene Ereignisse', async () => {
  const store = kv();
  await checkAndMark(store, umschlag({ event_id: 'evt_aaaa1111' }), 86400);
  const zweit = await checkAndMark(store, umschlag({ event_id: 'evt_bbbb2222' }), 86400);
  assert.equal(zweit.duplicate, false);
});

test('nach Ablauf der Lebensdauer gilt dasselbe Ereignis wieder als neu', async () => {
  const store = kv();
  const envelope = umschlag();
  await checkAndMark(store, envelope, 86400);

  store.now = NOW + 86401;
  const später = await checkAndMark(store, envelope, 86400);
  assert.equal(später.duplicate, false);
});

test('der zwischengespeicherte Umschlag enthält keinen Klartext', async () => {
  const store = kv();
  const envelope = umschlag();
  await storeEnvelope(store, envelope, 86400);

  const geladen = await loadEnvelope(store, envelope.event_id);
  assert.deepEqual(geladen, envelope);
  assert.ok(!JSON.stringify(geladen).includes('@'));
});

test('ein nicht vorhandener Umschlag liefert null statt eines Fehlers', async () => {
  assert.equal(await loadEnvelope(kv(), 'evt_gibtesnicht'), null);
});

test('die Schlüssel sind stabil und sprechend', () => {
  assert.equal(dedupeKey('evt_abc'), 'evt:evt_abc');
  // Meta unterscheidet nach event_id und event_name zusammen.
  assert.equal(capiDedupeKey('evt_abc', 'Lead'), 'capi:Lead:evt_abc');
  assert.notEqual(capiDedupeKey('evt_abc', 'Lead'), capiDedupeKey('evt_abc', 'Purchase'));
});

test('die Zähler verlieren nichts, auch nicht bei vielen Ereignissen', async () => {
  const store = kv();
  const tag = dayKey(NOW);
  for (let index = 0; index < 250; index++) {
    await record(store, tag, 'relay', 'accepted', `evt_${index}`);
    await record(store, tag, 'ga4', 'sent', `evt_${index}`);
  }
  await record(store, tag, 'capi', 'failed', 'evt_kaputt');

  const summary = await summarizeDay(store, tag);
  assert.equal(summary.counts['relay.accepted'], 250);
  assert.equal(summary.counts['ga4.sent'], 250);
  assert.equal(summary.counts['capi.failed'], 1);
  assert.equal(summary.total, 501);
});

test('die Zusammenfassung blättert über die Seitengrenze von KV hinweg', async () => {
  const store = kv();
  const tag = dayKey(NOW);
  // Mehr als eine Listenseite, damit der Cursor tatsächlich benutzt wird.
  for (let index = 0; index < 1200; index++) {
    await record(store, tag, 'ga4', 'sent', `evt_${String(index).padStart(5, '0')}`);
  }
  const summary = await summarizeDay(store, tag);
  assert.equal(summary.counts['ga4.sent'], 1200);
});

test('die Zusammenfassung über mehrere Tage trennt die Tage sauber', async () => {
  const store = kv();
  await record(store, dayKey(NOW), 'relay', 'accepted', 'evt_heute');
  await record(store, dayKey(NOW - 86400), 'relay', 'accepted', 'evt_gestern');

  const tage = await summarize(store, NOW, 2);
  assert.equal(tage.length, 2);
  assert.equal(tage[0]?.total, 1);
  assert.equal(tage[1]?.total, 1);
  assert.notEqual(tage[0]?.day, tage[1]?.day);
});
