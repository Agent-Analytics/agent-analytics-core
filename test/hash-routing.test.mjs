import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('hash-based routing support in built tracker', () => {
  test('built tracker.js contains hashchange event listener', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('hashchange'), 'tracker.js should listen for hashchange events');
  });

  test('built tracker.js includes location.hash in route comparison', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('location.hash'), 'tracker.js should include location.hash in path comparison');
  });
});
