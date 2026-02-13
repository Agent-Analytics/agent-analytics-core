import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePropertyKey } from '../src/db/d1.js';
import { AnalyticsError, ERROR_CODES } from '../src/errors.js';

test('validatePropertyKey exists', () => {
  assert.ok(validatePropertyKey, 'validatePropertyKey should be exported');
});

test('valid keys pass', () => {
  for (const key of ['foo', 'user_name', 'page123', 'A', 'x_1_y']) {
    assert.doesNotThrow(() => validatePropertyKey(key), `"${key}" should be valid`);
  }
});

test('malicious keys are rejected with AnalyticsError', () => {
  for (const key of ["') OR 1=1 --", "key'; DROP TABLE", "a.b", 'key"value', "key'value"]) {
    assert.throws(() => validatePropertyKey(key), (err) => {
      assert.ok(err instanceof AnalyticsError);
      assert.equal(err.code, ERROR_CODES.INVALID_PROPERTY_KEY);
      assert.equal(err.status, 400);
      return true;
    }, `"${key}" should be rejected`);
  }
});

test('edge cases rejected', () => {
  assert.throws(() => validatePropertyKey(''), /Invalid property filter key/);
  assert.throws(() => validatePropertyKey('a'.repeat(200)), /Invalid property filter key/);
  assert.throws(() => validatePropertyKey('café'), /Invalid property filter key/);
  assert.throws(() => validatePropertyKey('key value'), /Invalid property filter key/);
});
