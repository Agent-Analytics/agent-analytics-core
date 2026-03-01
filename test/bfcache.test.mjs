import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Build output checks ---
// bfcache is hard to unit test without a browser — mostly build output checks

describe('bfcache support in built tracker', () => {
  test('built tracker.js contains pageshow event listener', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('pageshow'), 'tracker.js should contain pageshow event');
  });

  test('built tracker.js contains persisted check', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('persisted'), 'tracker.js should check event.persisted');
  });
});
