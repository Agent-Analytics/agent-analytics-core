import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * isPrerender — must match the logic in tracker.src.js.
 * Returns true if the page is being prerendered (Chrome Speculation Rules,
 * <link rel="prerender">) and tracking should be skipped entirely.
 */
function isPrerender(visibilityState) {
  return visibilityState === 'prerender';
}

describe('prerender detection', () => {
  test('"prerender" returns true', () => {
    assert.equal(isPrerender('prerender'), true);
  });

  test('"visible" returns false', () => {
    assert.equal(isPrerender('visible'), false);
  });

  test('"hidden" returns false (background tab, NOT prerender)', () => {
    assert.equal(isPrerender('hidden'), false);
  });

  test('undefined returns false', () => {
    assert.equal(isPrerender(undefined), false);
  });

  test('null returns false', () => {
    assert.equal(isPrerender(null), false);
  });
});

describe('prerender in built tracker', () => {
  test('built tracker.js contains prerender check', () => {
    const trackerPath = join(__dirname, '..', 'src', 'tracker.js');
    const content = readFileSync(trackerPath, 'utf-8');
    assert.ok(content.includes('prerender'), 'tracker.js should contain prerender check');
  });
});
