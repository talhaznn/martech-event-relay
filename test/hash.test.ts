import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashUserData, isSha256Hex, sha256Hex } from '../src/hash.ts';

test('SHA-256 stimmt mit dem bekannten Testvektor überein', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('gleiche Person in verschiedenen Schreibweisen ergibt denselben Hash', async () => {
  const a = await hashUserData({ email: 'Max.Mustermann@Example.com', phone: '0151 51834055' });
  const b = await hashUserData({ email: ' max.mustermann@example.com ', phone: '+49 151 51834055' });
  assert.equal(a.em, b.em);
  assert.equal(a.ph, b.ph);
});

test('alle Ausgabefelder sind gültige SHA-256-Hexwerte', async () => {
  const hashed = await hashUserData({
    email: 'test@example.com',
    phone: '0151 51834055',
    first_name: 'Talha',
    last_name: 'Zengin',
    city: 'Dortmund',
    country: 'DE',
    external_id: 'kunde-4711',
  });
  for (const [field, value] of Object.entries(hashed)) {
    assert.ok(isSha256Hex(value), `${field} ist kein SHA-256-Hexwert: ${value}`);
  }
});

test('kein Klartext verlässt die Hashfunktion', async () => {
  const hashed = await hashUserData({ email: 'geheim@example.com', phone: '0151 51834055' });
  const serialisiert = JSON.stringify(hashed);
  assert.ok(!serialisiert.includes('geheim'));
  assert.ok(!serialisiert.includes('@'));
  assert.ok(!serialisiert.includes('51834055'));
});

test('leere Eingaben erzeugen keine Hashes von leeren Zeichenketten', async () => {
  const hashed = await hashUserData({ email: '', phone: '   ', first_name: undefined });
  assert.deepEqual(hashed, {});
  assert.deepEqual(await hashUserData(undefined), {});
});

test('isSha256Hex weist Großbuchstaben und falsche Längen ab', () => {
  assert.equal(isSha256Hex('a'.repeat(64)), true);
  assert.equal(isSha256Hex('A'.repeat(64)), false);
  assert.equal(isSha256Hex('a'.repeat(63)), false);
  assert.equal(isSha256Hex(42), false);
});
