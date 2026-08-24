import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCountry,
  normalizeEmail,
  normalizeName,
  normalizePhone,
} from '../src/normalize.ts';

test('E-Mail wird getrimmt und kleingeschrieben', () => {
  assert.equal(normalizeEmail('  Max.Mustermann@Example.COM '), 'max.mustermann@example.com');
});

test('E-Mail ohne Klammeraffe wird verworfen statt gehasht', () => {
  assert.equal(normalizeEmail('keine-adresse'), undefined);
  assert.equal(normalizeEmail(''), undefined);
  assert.equal(normalizeEmail(undefined), undefined);
});

test('deutsche Rufnummern ergeben in allen Schreibweisen denselben Wert', () => {
  const erwartet = '4915151834055';
  assert.equal(normalizePhone('+49 151 51834055'), erwartet);
  assert.equal(normalizePhone('0151 51834055'), erwartet);
  assert.equal(normalizePhone('0151/518 340 55'), erwartet);
  assert.equal(normalizePhone('0049 151 51834055'), erwartet);
  assert.equal(normalizePhone('+49 (0)151 51834055'), erwartet);
});

test('Rufnummer ohne führende Null bekommt die Vorwahl vorangestellt', () => {
  assert.equal(normalizePhone('151 51834055'), '4915151834055');
});

test('zu kurze und zu lange Rufnummern werden verworfen', () => {
  assert.equal(normalizePhone('12345'), undefined);
  assert.equal(normalizePhone('abc'), undefined);
  assert.equal(normalizePhone('+49 1234567890123456789'), undefined);
});

test('Namen verlieren Interpunktion und Leerzeichen, Umlaute bleiben', () => {
  assert.equal(normalizeName(" O'Brien "), 'obrien');
  assert.equal(normalizeName('Anna-Lena'), 'annalena');
  assert.equal(normalizeName('Müller'), 'müller');
  assert.equal(normalizeName('   '), undefined);
});

test('Ländercode nur als zwei Buchstaben', () => {
  assert.equal(normalizeCountry('DE'), 'de');
  assert.equal(normalizeCountry(' de '), 'de');
  assert.equal(normalizeCountry('Deutschland'), undefined);
});
