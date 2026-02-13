import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeEqual, includesSafe } from '../src/crypto.js';

// --- safeEqual ---

test('safeEqual: matching strings return true', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(safeEqual('aak_test123', 'aak_test123'));
});

test('safeEqual: different strings return false', () => {
  assert.ok(!safeEqual('abc', 'def'));
  assert.ok(!safeEqual('abc', 'abx'));
});

test('safeEqual: different lengths return false', () => {
  assert.ok(!safeEqual('short', 'longer_string'));
  assert.ok(!safeEqual('a', 'ab'));
});

test('safeEqual: empty strings match', () => {
  assert.ok(safeEqual('', ''));
});

test('safeEqual: non-string inputs return false', () => {
  assert.ok(!safeEqual(null, 'abc'));
  assert.ok(!safeEqual('abc', undefined));
  assert.ok(!safeEqual(123, 'abc'));
  assert.ok(!safeEqual(null, null));
  assert.ok(!safeEqual(undefined, undefined));
});

// --- includesSafe ---

test('includesSafe: finds value in single-item list', () => {
  assert.ok(includesSafe('token_a', 'token_a'));
});

test('includesSafe: finds value in comma-separated list', () => {
  assert.ok(includesSafe('token_a,token_b,token_c', 'token_b'));
  assert.ok(includesSafe('token_a,token_b,token_c', 'token_a'));
  assert.ok(includesSafe('token_a,token_b,token_c', 'token_c'));
});

test('includesSafe: handles whitespace around items', () => {
  assert.ok(includesSafe('token_a , token_b , token_c', 'token_b'));
  assert.ok(includesSafe(' token_a ', 'token_a'));
});

test('includesSafe: returns false for missing value', () => {
  assert.ok(!includesSafe('token_a,token_b', 'token_c'));
  assert.ok(!includesSafe('token_a', 'token_b'));
});

test('includesSafe: returns false for partial match', () => {
  assert.ok(!includesSafe('token_abc', 'token_ab'));
  assert.ok(!includesSafe('token_a,token_b', 'token'));
});
