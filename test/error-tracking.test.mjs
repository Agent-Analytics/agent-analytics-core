import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * createErrorTracker — mirrors the error tracking logic in tracker.src.js.
 * Returns null if disabled, otherwise returns a controller for testing.
 */
function createErrorTracker(enabled) {
  if (!enabled) return null;

  var seen = {};
  var count = 0;
  var CAP = 5;
  var tracked = [];

  return {
    onError: function(message, filename, lineno, colno) {
      if (count >= CAP) return false;
      var key = (message || '') + '|' + (filename || '') + '|' + (lineno || 0);
      if (seen[key]) return false;
      seen[key] = 1;
      count++;
      tracked.push({
        event: '$error',
        properties: {
          message: (message || '').slice(0, 500),
          source: filename || '',
          line: lineno || 0,
          col: colno || 0
        }
      });
      return true;
    },

    onRejection: function(reason) {
      if (count >= CAP) return false;
      var msg = reason instanceof Error ? reason.message : String(reason || '');
      var key = msg + '||0';
      if (seen[key]) return false;
      seen[key] = 1;
      count++;
      tracked.push({
        event: '$error',
        properties: {
          message: msg.slice(0, 500),
          source: '',
          line: 0,
          col: 0
        }
      });
      return true;
    },

    reset: function() { seen = {}; count = 0; },
    getTracked: function() { return tracked; },
    getCount: function() { return count; }
  };
}

// --- Disabled state ---

describe('error tracker disabled', () => {
  test('returns null when not enabled', () => {
    assert.equal(createErrorTracker(false), null);
  });

  test('returns null for falsy values', () => {
    assert.equal(createErrorTracker(null), null);
    assert.equal(createErrorTracker(undefined), null);
    assert.equal(createErrorTracker(0), null);
    assert.equal(createErrorTracker(''), null);
  });
});

// --- Basic tracking ---

describe('error tracker basic tracking', () => {
  test('tracks a window error with message, source, line, col', () => {
    const et = createErrorTracker(true);
    const result = et.onError('TypeError: x is not a function', 'app.js', 42, 10);
    assert.equal(result, true);
    assert.equal(et.getTracked().length, 1);
    const e = et.getTracked()[0];
    assert.equal(e.event, '$error');
    assert.equal(e.properties.message, 'TypeError: x is not a function');
    assert.equal(e.properties.source, 'app.js');
    assert.equal(e.properties.line, 42);
    assert.equal(e.properties.col, 10);
  });

  test('tracks an unhandled rejection with Error reason', () => {
    const et = createErrorTracker(true);
    const result = et.onRejection(new Error('fetch failed'));
    assert.equal(result, true);
    const e = et.getTracked()[0];
    assert.equal(e.event, '$error');
    assert.equal(e.properties.message, 'fetch failed');
    assert.equal(e.properties.source, '');
    assert.equal(e.properties.line, 0);
    assert.equal(e.properties.col, 0);
  });

  test('tracks an unhandled rejection with string reason', () => {
    const et = createErrorTracker(true);
    et.onRejection('something went wrong');
    assert.equal(et.getTracked()[0].properties.message, 'something went wrong');
  });

  test('tracks an unhandled rejection with null reason', () => {
    const et = createErrorTracker(true);
    et.onRejection(null);
    assert.equal(et.getTracked()[0].properties.message, '');
  });

  test('tracks an unhandled rejection with undefined reason', () => {
    const et = createErrorTracker(true);
    et.onRejection(undefined);
    assert.equal(et.getTracked()[0].properties.message, '');
  });

  test('handles missing error fields gracefully', () => {
    const et = createErrorTracker(true);
    et.onError(undefined, undefined, undefined, undefined);
    const e = et.getTracked()[0];
    assert.equal(e.properties.message, '');
    assert.equal(e.properties.source, '');
    assert.equal(e.properties.line, 0);
    assert.equal(e.properties.col, 0);
  });
});

// --- Deduplication ---

describe('error tracker deduplication', () => {
  test('same error (message+source+line) tracked only once', () => {
    const et = createErrorTracker(true);
    et.onError('ReferenceError: x', 'app.js', 10, 5);
    const dup = et.onError('ReferenceError: x', 'app.js', 10, 5);
    assert.equal(dup, false);
    assert.equal(et.getTracked().length, 1);
    assert.equal(et.getCount(), 1);
  });

  test('same message different line is tracked separately', () => {
    const et = createErrorTracker(true);
    et.onError('TypeError', 'app.js', 10, 5);
    et.onError('TypeError', 'app.js', 20, 5);
    assert.equal(et.getTracked().length, 2);
  });

  test('same message different source is tracked separately', () => {
    const et = createErrorTracker(true);
    et.onError('TypeError', 'app.js', 10, 5);
    et.onError('TypeError', 'lib.js', 10, 5);
    assert.equal(et.getTracked().length, 2);
  });

  test('different col same message+source+line is deduped', () => {
    const et = createErrorTracker(true);
    et.onError('TypeError', 'app.js', 10, 5);
    const dup = et.onError('TypeError', 'app.js', 10, 99);
    assert.equal(dup, false);
    assert.equal(et.getTracked().length, 1);
  });

  test('duplicate rejections are deduped by message', () => {
    const et = createErrorTracker(true);
    et.onRejection(new Error('timeout'));
    const dup = et.onRejection(new Error('timeout'));
    assert.equal(dup, false);
    assert.equal(et.getTracked().length, 1);
  });

  test('error and rejection with same dedup key are deduped', () => {
    const et = createErrorTracker(true);
    // error key: 'msg||0' (empty source, line 0)
    et.onError('msg', '', 0, 0);
    // rejection key: 'msg||0'
    const dup = et.onRejection(new Error('msg'));
    assert.equal(dup, false);
    assert.equal(et.getTracked().length, 1);
  });
});

// --- Cap at 5 ---

describe('error tracker cap at 5 per page view', () => {
  test('tracks exactly 5 unique errors then stops', () => {
    const et = createErrorTracker(true);
    for (let i = 0; i < 10; i++) {
      et.onError('Error ' + i, 'app.js', i, 0);
    }
    assert.equal(et.getTracked().length, 5);
    assert.equal(et.getCount(), 5);
  });

  test('cap applies across errors and rejections', () => {
    const et = createErrorTracker(true);
    for (let i = 0; i < 3; i++) {
      et.onError('Error ' + i, 'app.js', i, 0);
    }
    for (let i = 0; i < 5; i++) {
      et.onRejection(new Error('Rejection ' + i));
    }
    assert.equal(et.getTracked().length, 5);
  });

  test('6th error returns false', () => {
    const et = createErrorTracker(true);
    for (let i = 0; i < 5; i++) {
      assert.equal(et.onError('Error ' + i, 'app.js', i, 0), true);
    }
    assert.equal(et.onError('Error 5', 'app.js', 5, 0), false);
  });
});

// --- SPA reset ---

describe('error tracker SPA reset', () => {
  test('reset clears dedup set and count', () => {
    const et = createErrorTracker(true);
    et.onError('ReferenceError: x', 'app.js', 10, 5);
    et.onError('TypeError: y', 'app.js', 20, 3);
    assert.equal(et.getCount(), 2);

    et.reset();
    assert.equal(et.getCount(), 0);

    // Same error is now trackable again
    const result = et.onError('ReferenceError: x', 'app.js', 10, 5);
    assert.equal(result, true);
    assert.equal(et.getTracked().length, 3); // 2 from before + 1 new
  });

  test('reset allows 5 more errors after cap was reached', () => {
    const et = createErrorTracker(true);
    for (let i = 0; i < 5; i++) {
      et.onError('Error ' + i, 'app.js', i, 0);
    }
    assert.equal(et.onError('Error 5', 'app.js', 5, 0), false);

    et.reset();
    const result = et.onError('Error 5', 'app.js', 5, 0);
    assert.equal(result, true);
    assert.equal(et.getCount(), 1);
  });
});

// --- Message truncation ---

describe('error message truncation', () => {
  test('message over 500 chars is truncated', () => {
    const et = createErrorTracker(true);
    et.onError('x'.repeat(1000), 'app.js', 1, 1);
    assert.equal(et.getTracked()[0].properties.message.length, 500);
  });

  test('rejection message over 500 chars is truncated', () => {
    const et = createErrorTracker(true);
    et.onRejection(new Error('y'.repeat(1000)));
    assert.equal(et.getTracked()[0].properties.message.length, 500);
  });

  test('message under 500 chars is not truncated', () => {
    const et = createErrorTracker(true);
    et.onError('short error', 'app.js', 1, 1);
    assert.equal(et.getTracked()[0].properties.message, 'short error');
  });
});

// --- Build output checks ---

describe('error tracking in built tracker', () => {
  test('built tracker.js contains $error event name', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('$error'), 'tracker.js should contain $error');
  });

  test('built tracker.js contains data-track-errors attribute', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('data-track-errors'), 'tracker.js should reference data-track-errors');
  });

  test('built tracker.js contains unhandledrejection listener', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('unhandledrejection'), 'tracker.js should reference unhandledrejection');
  });
});
