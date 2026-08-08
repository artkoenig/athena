import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatDuration } from './duration.mjs';

// AC: exports a named function `formatDuration(ms)`.

test('formatDuration: a named function of one parameter', () => {
  assert.equal(typeof formatDuration, 'function');
  assert.equal(formatDuration.length, 1);
});

// AC: below 1000, printed as a whole number of milliseconds.

test('formatDuration: below 1000ms prints a whole number of milliseconds ("850ms")', () => {
  assert.equal(formatDuration(850), '850ms');
});

test('formatDuration: 0ms prints "0ms" (zero)', () => {
  assert.equal(formatDuration(0), '0ms');
});

test('formatDuration: 999ms prints "999ms" (top of the milliseconds range)', () => {
  assert.equal(formatDuration(999), '999ms');
});

test('formatDuration: a fractional input below 1000 still prints a whole number of milliseconds ("850ms")', () => {
  assert.equal(formatDuration(850.7), '850ms');
});

// AC: 1000 up to but not including 60000, printed with exactly one decimal place.

test('formatDuration: 1400ms prints with exactly one decimal place ("1.4s")', () => {
  assert.equal(formatDuration(1400), '1.4s');
});

test('formatDuration: 1000ms (lower boundary) prints "1.0s", keeping one decimal on a whole number of seconds', () => {
  assert.equal(formatDuration(1000), '1.0s');
});

test('formatDuration: 2000ms prints "2.0s"', () => {
  assert.equal(formatDuration(2000), '2.0s');
});

test('formatDuration: 59999ms (top of the seconds range) prints "59.9s" and does not roll into the minutes form', () => {
  assert.equal(formatDuration(59999), '59.9s');
});

// AC: 60000 up to but not including 3600000, printed as whole minutes and whole seconds.

test('formatDuration: 125000ms prints whole minutes and whole seconds ("2m 5s")', () => {
  assert.equal(formatDuration(125000), '2m 5s');
});

test('formatDuration: 60000ms (lower boundary) prints "1m 0s", with the zero trailing seconds printed rather than dropped', () => {
  assert.equal(formatDuration(60000), '1m 0s');
});

test('formatDuration: 3599999ms (top of the minutes range) prints "59m 59s"', () => {
  assert.equal(formatDuration(3599999), '59m 59s');
});

// AC: 3600000 or more, printed as whole hours and whole minutes.

test('formatDuration: 3780000ms prints whole hours and whole minutes ("1h 3m")', () => {
  assert.equal(formatDuration(3780000), '1h 3m');
});

test('formatDuration: 3600000ms (lower boundary) prints "1h 0m", with the zero trailing minutes printed rather than dropped', () => {
  assert.equal(formatDuration(3600000), '1h 0m');
});

test('formatDuration: 86400000ms (a day) prints "24h 0m", the hours field neither capped nor wrapped', () => {
  assert.equal(formatDuration(86400000), '24h 0m');
});

// AC: rounds down to the unit it prints.

test('formatDuration: 1999ms rounds down to "1.9s", not "2.0s" from naive rounding', () => {
  assert.equal(formatDuration(1999), '1.9s');
});

test('formatDuration: 119999ms rounds down to "1m 59s"', () => {
  assert.equal(formatDuration(119999), '1m 59s');
});

test('formatDuration: 3659999ms rounds down to "1h 0m", a hair under one hour and one minute floors to 0m, not 1m', () => {
  assert.equal(formatDuration(3659999), '1h 0m');
});

// AC: throws a TypeError when the input is not a number, is NaN, is infinite, or is negative.

test('formatDuration: throws TypeError when the input is not a number (string, null, undefined, boolean, object, array)', () => {
  const notNumbers = ['1400', null, undefined, true, {}, []];
  for (const value of notNumbers) {
    assert.throws(() => formatDuration(value), TypeError);
  }
});

test('formatDuration: throws TypeError when the input is NaN', () => {
  assert.throws(() => formatDuration(NaN), TypeError);
});

test('formatDuration: throws TypeError when the input is infinite (Infinity and -Infinity)', () => {
  assert.throws(() => formatDuration(Infinity), TypeError);
  assert.throws(() => formatDuration(-Infinity), TypeError);
});

test('formatDuration: throws TypeError when the input is negative (-1 and -0.5)', () => {
  assert.throws(() => formatDuration(-1), TypeError);
  assert.throws(() => formatDuration(-0.5), TypeError);
});

test('formatDuration: -0 is accepted and prints "0ms" (negative zero is not negative)', () => {
  assert.equal(formatDuration(-0), '0ms');
});

// AC: the module has no dependencies beyond the Node standard library.

test('formatDuration: duration.mjs has no import statement and no require( call', () => {
  const source = readFileSync(new URL('./duration.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\b/);
  assert.doesNotMatch(source, /\brequire\s*\(/);
});
