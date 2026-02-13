import assert from 'node:assert/strict';
import { test } from 'node:test';

// Extract the validation function (will be exported after fix)
let validatePropertyKey;
try {
  const mod = await import('../src/db/d1.js');
  validatePropertyKey = mod.validatePropertyKey;
} catch {
  // Before fix, function won't exist
  validatePropertyKey = null;
}

test('validatePropertyKey exists', () => {
  assert.ok(validatePropertyKey, 'validatePropertyKey should be exported');
});

test('valid keys pass', () => {
  if (!validatePropertyKey) return;
  for (const key of ['foo', 'user_name', 'page123', 'A', 'x_1_y']) {
    assert.doesNotThrow(() => validatePropertyKey(key), `"${key}" should be valid`);
  }
});

test('malicious keys are rejected', () => {
  if (!validatePropertyKey) return;
  for (const key of ["') OR 1=1 --", "key'; DROP TABLE", "a.b", 'key"value', "key'value"]) {
    assert.throws(() => validatePropertyKey(key), /Invalid property filter key/, `"${key}" should be rejected`);
  }
});

test('edge cases rejected', () => {
  if (!validatePropertyKey) return;
  assert.throws(() => validatePropertyKey(''), /Invalid property filter key/);
  assert.throws(() => validatePropertyKey('a'.repeat(200)), /Invalid property filter key/);
  assert.throws(() => validatePropertyKey('café'), /Invalid property filter key/);
  assert.throws(() => validatePropertyKey('key value'), /Invalid property filter key/);
});
