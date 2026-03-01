import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * detect404 — mirrors the 404 detection logic in tracker.src.js.
 * Takes mock environment signals and returns true/false.
 *
 * @param {{ metaContent: string|null, navResponseStatus: number|null }} env
 * @returns {boolean}
 */
function detect404(env) {
  // Check meta tag
  if (env.metaContent === '404') return true;
  // Check Navigation Timing API responseStatus
  if (env.navResponseStatus === 404) return true;
  return false;
}

// --- Meta tag detection ---

describe('404 detection via meta tag', () => {
  test('detects 404 when meta content is "404"', () => {
    assert.equal(detect404({ metaContent: '404', navResponseStatus: null }), true);
  });

  test('does not detect 404 when meta content is "200"', () => {
    assert.equal(detect404({ metaContent: '200', navResponseStatus: null }), false);
  });

  test('does not detect 404 when meta content is null', () => {
    assert.equal(detect404({ metaContent: null, navResponseStatus: null }), false);
  });

  test('does not detect 404 when meta content is empty', () => {
    assert.equal(detect404({ metaContent: '', navResponseStatus: null }), false);
  });

  test('does not detect 404 when meta content is "not-found"', () => {
    assert.equal(detect404({ metaContent: 'not-found', navResponseStatus: null }), false);
  });
});

// --- Navigation Timing detection ---

describe('404 detection via Navigation Timing', () => {
  test('detects 404 when responseStatus is 404', () => {
    assert.equal(detect404({ metaContent: null, navResponseStatus: 404 }), true);
  });

  test('does not detect 404 when responseStatus is 200', () => {
    assert.equal(detect404({ metaContent: null, navResponseStatus: 200 }), false);
  });

  test('does not detect 404 when responseStatus is null', () => {
    assert.equal(detect404({ metaContent: null, navResponseStatus: null }), false);
  });

  test('does not detect 404 when responseStatus is 500', () => {
    assert.equal(detect404({ metaContent: null, navResponseStatus: 500 }), false);
  });
});

// --- Combined detection ---

describe('404 detection combined', () => {
  test('detects when both signals are present', () => {
    assert.equal(detect404({ metaContent: '404', navResponseStatus: 404 }), true);
  });

  test('detects when only meta tag is present', () => {
    assert.equal(detect404({ metaContent: '404', navResponseStatus: 200 }), true);
  });

  test('detects when only nav timing is present', () => {
    assert.equal(detect404({ metaContent: null, navResponseStatus: 404 }), true);
  });

  test('does not detect when neither signal is present', () => {
    assert.equal(detect404({ metaContent: null, navResponseStatus: null }), false);
  });
});

// --- Build output checks ---

describe('404 tracking in built tracker', () => {
  test('built tracker.js contains $404 event name', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('$404'), 'tracker.js should contain $404');
  });

  test('built tracker.js contains data-track-404 attribute', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('data-track-404'), 'tracker.js should reference data-track-404');
  });

  test('built tracker.js contains aa-status meta tag check', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('aa-status'), 'tracker.js should reference aa-status meta tag');
  });

  test('built tracker.js contains responseStatus check', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('responseStatus'), 'tracker.js should contain responseStatus');
  });
});
