import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, timingSafeEqual, verify } from '../src/signature.ts';

const SECRET = 'test-geheimnis';
const NOW = 1_756_108_800;
const BODY = '{"event_id":"evt_abc12345","event_name":"demo_conversion_server"}';

test('signieren und prüfen passen zusammen', async () => {
  const signature = await sign(SECRET, NOW, BODY);
  assert.match(signature, /^v1=[0-9a-f]{64}$/);
  assert.deepEqual(await verify(SECRET, String(NOW), signature, BODY, NOW), { ok: true });
});

test('ein veränderter Körper fällt auf', async () => {
  const signature = await sign(SECRET, NOW, BODY);
  const result = await verify(SECRET, String(NOW), signature, BODY.replace('abc12345', 'abc99999'), NOW);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_signature');
});

test('ein falsches Geheimnis fällt auf', async () => {
  const signature = await sign('anderes-geheimnis', NOW, BODY);
  const result = await verify(SECRET, String(NOW), signature, BODY, NOW);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_signature');
});

test('ein alter Aufruf lässt sich nicht wiederholen', async () => {
  const signature = await sign(SECRET, NOW, BODY);
  // Derselbe unveränderte Aufruf, nur eine Stunde später erneut eingeworfen.
  const result = await verify(SECRET, String(NOW), signature, BODY, NOW + 3600);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timestamp_out_of_tolerance');
});

test('ein Zeitstempel aus der Zukunft wird ebenfalls abgelehnt', async () => {
  const signature = await sign(SECRET, NOW + 3600, BODY);
  const result = await verify(SECRET, String(NOW + 3600), signature, BODY, NOW);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timestamp_out_of_tolerance');
});

test('der Zeitstempel gehört in die Signatur, nicht nur daneben', async () => {
  // Wer nur den Körper signiert, kann den Zeitstempelkopf beliebig neu setzen und den Aufruf
  // damit unbegrenzt wiederholen. Hier scheitert genau das.
  const signature = await sign(SECRET, NOW, BODY);
  const result = await verify(SECRET, String(NOW + 10), signature, BODY, NOW + 10);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_signature');
});

test('fehlende Köpfe und unbrauchbare Zeitstempel werden benannt', async () => {
  assert.equal((await verify(SECRET, null, 'v1=abc', BODY, NOW)).reason, 'missing_header');
  assert.equal((await verify(SECRET, String(NOW), null, BODY, NOW)).reason, 'missing_header');
  assert.equal((await verify(SECRET, 'gestern', 'v1=abc', BODY, NOW)).reason, 'malformed_timestamp');
});

test('der Vergleich in konstanter Zeit verhält sich wie ein Vergleich', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
});
