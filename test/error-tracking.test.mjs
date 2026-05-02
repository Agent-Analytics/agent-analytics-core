import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const trackerSource = readFileSync(join(__dirname, '..', 'src', 'tracker.src.js'), 'utf-8');

function createStorage() {
  const store = new Map();
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
    clear() { store.clear(); }
  };
}

function runTracker(attrs = {}) {
  const events = { document: {}, window: {} };
  const beacons = [];
  const scriptAttrs = new Map(Object.entries(attrs));
  const context = {
    URL,
    URLSearchParams,
    Blob: class Blob {
      constructor(parts, options) { this.parts = parts; this.options = options; }
      text() { return Promise.resolve(this.parts.join('')); }
    },
    console: { log() {} },
    Math,
    Date,
    clearTimeout() {},
    setTimeout() { return 1; },
    location: {
      href: 'https://app.example.com/dashboard',
      origin: 'https://app.example.com',
      protocol: 'https:',
      host: 'app.example.com',
      hostname: 'app.example.com',
      pathname: '/dashboard',
      search: '',
      hash: ''
    },
    history: { replaceState() {} },
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    screen: { width: 1440, height: 900 },
    navigator: {
      language: 'en-US',
      userAgent: 'Mozilla/5.0 Chrome/120.0 Safari/537.36',
      doNotTrack: '0',
      sendBeacon(endpoint, blob) {
        beacons.push({ endpoint, body: blob.parts.join('') });
        return true;
      }
    },
    performance: { getEntriesByType() { return []; } },
    fetch() { return Promise.resolve({ ok: true, json: () => Promise.resolve({ experiments: [] }) }); }
  };
  const document = {
    title: 'App',
    referrer: '',
    visibilityState: 'visible',
    readyState: 'complete',
    documentElement: { classList: { remove() {} } },
    currentScript: {
      src: 'https://cdn.example/tracker.js',
      dataset: { project: 'proj', token: 'tok' },
      getAttribute(name) { return scriptAttrs.get(name) || null; }
    },
    addEventListener(type, handler) { events.document[type] = events.document[type] || []; events.document[type].push(handler); },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  context.document = document;
  context.window = {
    addEventListener(type, handler) { events.window[type] = events.window[type] || []; events.window[type].push(handler); }
  };
  context.window.window = context.window;
  context.window.document = document;
  context.window.navigator = context.navigator;
  context.window.location = context.location;
  context.window.localStorage = context.localStorage;
  context.window.sessionStorage = context.sessionStorage;

  vm.createContext(context);
  vm.runInContext(trackerSource, context, { filename: 'tracker.src.js' });

  function flush() {
    for (const handler of events.window.beforeunload || []) handler();
    return beacons.map((entry) => JSON.parse(entry.body));
  }

  return { context, events, flush };
}

function flushedEvents(runtime) {
  return runtime.flush().flatMap((payload) => payload.events || [payload]);
}

function lastFlushedEvent(runtime, eventName) {
  const matches = flushedEvents(runtime).filter((payload) => payload.event === eventName);
  assert.ok(matches.length > 0, `expected flushed ${eventName} event`);
  return matches.at(-1);
}


function safeErrorString(value, fallback = '') {
  try { return String(value || ''); } catch { return fallback; }
}

function redactErrorPatterns(value) {
  try {
    return safeErrorString(value)
      .replace(/https?:\/\/[^\s"'<>]+/gi, function(raw) {
        try {
          var u = new URL(raw);
          return u.origin + u.pathname;
        } catch {
          return '[redacted]';
        }
      })
      .replace(/[A-Z0-9._%+-]+%40[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, '$1[redacted]')
      .replace(/\b(token|api_key|apikey|key|secret|password|access_token|refresh_token|auth|code)\s*[:=]\s*[^\s&,;]+/gi, '$1=[redacted]')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[redacted]')
      .replace(/(^|[\s=:,;"'`])([A-Za-z0-9_-]{32,})(?=$|[\s,;"'`])/g, '$1[redacted]');
  } catch {
    return '[redacted]';
  }
}

function sanitizeErrorText(value, maxLen) {
  try {
    var out = redactErrorPatterns(value);
    return maxLen ? out.slice(0, maxLen) : out;
  } catch {
    return '';
  }
}

function sanitizeErrorSource(value) {
  try {
    var raw = safeErrorString(value);
    if (!raw) return '';
    try {
      var u = new URL(raw);
      return redactErrorPatterns(u.origin + u.pathname).slice(0, 500);
    } catch {
      return redactErrorPatterns(raw.replace(/[?#].*$/, '')).slice(0, 500);
    }
  } catch {
    return '';
  }
}

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
      var safeMessage = sanitizeErrorText(message, 500);
      var safeSource = sanitizeErrorSource(filename);
      var key = safeMessage + '|' + safeSource + '|' + (lineno || 0);
      if (seen[key]) return false;
      seen[key] = 1;
      count++;
      tracked.push({
        event: '$error',
        properties: {
          message: safeMessage,
          source: safeSource,
          line: lineno || 0,
          col: colno || 0
        }
      });
      return true;
    },

    onRejection: function(reason) {
      if (count >= CAP) return false;
      var msg = reason instanceof Error ? reason.message : safeErrorString(reason);
      var safeMessage = sanitizeErrorText(msg, 500);
      var key = safeMessage + '||0';
      if (seen[key]) return false;
      seen[key] = 1;
      count++;
      tracked.push({
        event: '$error',
        properties: {
          message: safeMessage,
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
    et.onError('long error ' + 'word '.repeat(200), 'app.js', 1, 1);
    assert.equal(et.getTracked()[0].properties.message.length, 500);
  });

  test('rejection message over 500 chars is truncated', () => {
    const et = createErrorTracker(true);
    et.onRejection(new Error('long rejection ' + 'word '.repeat(200)));
    assert.equal(et.getTracked()[0].properties.message.length, 500);
  });

  test('message under 500 chars is not truncated', () => {
    const et = createErrorTracker(true);
    et.onError('short error', 'app.js', 1, 1);
    assert.equal(et.getTracked()[0].properties.message, 'short error');
  });
});

// --- Private data redaction ---

describe('error tracker private data redaction', () => {
  test('redacts window error messages and source URL details before tracking', () => {
    const et = createErrorTracker(true);
    et.onError(
      'Fetch failed for danny@example.com via https://api.example.com/callback?token=example_query_token_123456#done Authorization: Bearer example_keye_1234567890abcdef1234567890abcdef id 6f3b0d2d9e4b4c8a9f0e1d2c3b4a5968',
      'https://app.example.com/users/danny@example.com/assets/app.js?access_token=example_query_token_123456#frame',
      42,
      7
    );

    const props = et.getTracked()[0].properties;
    assert.equal(props.source, 'https://app.example.com/users/[redacted]/assets/app.js');
    assert.doesNotMatch(props.message, /danny@example\.com|token=example_query_token_123456|#done|example_keye_1234567890abcdef1234567890abcdef|6f3b0d2d9e4b4c8a9f0e1d2c3b4a5968/);
    assert.match(props.message, /\[redacted\]/);
    assert.match(props.message, /https:\/\/api\.example\.com\/callback/);
  });

  test('redacts URL-encoded emails and unhandled rejection messages', () => {
    const et = createErrorTracker(true);
    et.onRejection(new Error('Failed for danny%40example.com with api_key=secret_value_1234567890abcdef1234567890abcdef'));
    et.onRejection('Rejected https://api.example.com/reset?email=danny%40example.com#frag');

    assert.doesNotMatch(et.getTracked()[0].properties.message, /danny%40example\.com|example_keye_1234567890abcdef1234567890abcdef/);
    assert.match(et.getTracked()[0].properties.message, /\[redacted\]/);
    assert.equal(et.getTracked()[1].properties.message, 'Rejected https://api.example.com/reset');
  });

  test('dedupes on sanitized message and source values', () => {
    const et = createErrorTracker(true);
    assert.equal(et.onError('Failed token=example_keye_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'https://app.example.com/app.js?token=one', 10, 1), true);
    assert.equal(et.onError('Failed token=example_keye_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'https://app.example.com/app.js?token=two', 10, 2), false);
    assert.equal(et.getTracked().length, 1);
  });

  test('malformed inputs do not throw and still avoid obvious query token leakage', () => {
    const et = createErrorTracker(true);
    assert.doesNotThrow(() => et.onError({ toString() { throw new Error('boom'); } }, 'not a url ?token=secret', 1, 1));
    const props = et.getTracked()[0].properties;
    assert.equal(typeof props.message, 'string');
    assert.doesNotMatch(props.source, /token=secret/);
  });
});

describe('real tracker automatic error redaction', () => {
  test('redacts automatic error capture while leaving manual $error payloads untouched', () => {
    const runtime = runTracker({ 'data-track-errors': 'true' });

    runtime.context.window.aa.track('$error', {
      message: 'Manual failure for danny@example.com with token=example_keye_1234567890abcdef1234567890abcdef'
    });

    for (const handler of runtime.events.window.error || []) handler({
      message: 'Fetch failed for danny@example.com with token=example_keye_1234567890abcdef1234567890abcdef',
      filename: 'https://app.example.com/users/danny@example.com/assets/app.js?access_token=example_query_token_123456#frame',
      lineno: 42,
      colno: 7
    });

    const events = flushedEvents(runtime).filter((payload) => payload.event === '$error');
    assert.equal(events.length, 2);

    assert.match(events[0].properties.message, /danny@example\.com/);
    assert.match(events[0].properties.message, /example_keye_1234567890abcdef1234567890abcdef/);

    assert.doesNotMatch(events[1].properties.message, /danny@example\.com|example_keye_1234567890abcdef1234567890abcdef/);
    assert.equal(events[1].properties.source, 'https://app.example.com/users/[redacted]/assets/app.js');
  });

  test('redacts automatic unhandled rejections in the real tracker source', () => {
    const runtime = runTracker({ 'data-track-errors': 'true' });
    for (const handler of runtime.events.window.unhandledrejection || []) handler({
      reason: new Error('Rejected for danny@example.com at https://api.example.com/callback?access_token=example_query_token_123456#frag')
    });

    const payload = lastFlushedEvent(runtime, '$error');
    assert.doesNotMatch(payload.properties.message, /danny@example\.com|access_token=example_query_token_123456|#frag/);
    assert.match(payload.properties.message, /\[redacted\]/);
    assert.match(payload.properties.message, /https:\/\/api\.example\.com\/callback/);
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
