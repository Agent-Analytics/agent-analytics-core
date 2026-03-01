import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * computeINP — mirrors the INP p98 logic in tracker.src.js cwvFlush().
 * Takes an array of interaction durations, returns the p98 value.
 * Returns null if no interactions.
 */
function computeINP(interactions) {
  if (!interactions || interactions.length === 0) return null;
  var sorted = interactions.slice().sort(function(a, b) { return a - b; });
  var idx = Math.min(Math.ceil(sorted.length * 0.98) - 1, sorted.length - 1);
  return sorted[Math.max(idx, 0)];
}

/**
 * createWebVitalsController — mirrors the CWV logic in tracker.src.js.
 * Returns null if disabled. Otherwise returns a controller for testing
 * LCP, CLS, INP accumulation and flush behavior.
 */
function createWebVitalsController(enabled) {
  if (!enabled) return null;

  var lcp = -1, cls = 0, interactions = [];
  var flushed = false;
  var tracked = [];

  return {
    // Simulate LCP entries
    onLCP: function(entries) {
      if (entries.length) lcp = entries[entries.length - 1].startTime;
    },

    // Simulate CLS entries
    onCLS: function(entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].hadRecentInput) cls += entries[i].value;
      }
    },

    // Simulate INP entries
    onINP: function(entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].interactionId) interactions.push(entries[i].duration);
      }
    },

    flush: function(path) {
      if (flushed) return null;
      if (lcp < 0 && cls === 0 && interactions.length === 0) return null;
      flushed = true;
      var props = { path: path || '/' };
      if (lcp >= 0) props.cwv_lcp = Math.round(lcp);
      props.cwv_cls = Math.round(cls * 1000) / 1000;
      if (interactions.length > 0) {
        props.cwv_inp = computeINP(interactions);
      }
      tracked.push(props);
      return props;
    },

    reset: function(path) {
      // Flush before reset (SPA pattern)
      this.flush(path);
      lcp = -1;
      cls = 0;
      interactions = [];
      flushed = false;
    },

    getTracked: function() { return tracked; },
    isFlushed: function() { return flushed; },
  };
}

// --- INP p98 calculation ---

describe('INP p98 calculation', () => {
  test('single interaction returns that value', () => {
    assert.equal(computeINP([100]), 100);
  });

  test('two interactions returns the larger (p98)', () => {
    assert.equal(computeINP([50, 200]), 200);
  });

  test('100 interactions returns p98', () => {
    const arr = [];
    for (let i = 1; i <= 100; i++) arr.push(i * 10); // 10, 20, ..., 1000
    const result = computeINP(arr);
    // p98 of 100 items: ceil(100*0.98)-1 = 97, sorted[97] = 980
    assert.equal(result, 980);
  });

  test('50 interactions returns p98', () => {
    const arr = [];
    for (let i = 1; i <= 50; i++) arr.push(i * 8);
    const result = computeINP(arr);
    // ceil(50*0.98)-1 = 48, sorted[48] = 49*8 = 392
    assert.equal(result, 392);
  });

  test('unsorted input is sorted before computing', () => {
    assert.equal(computeINP([300, 100, 200]), 300);
  });

  test('returns null for empty array', () => {
    assert.equal(computeINP([]), null);
  });

  test('returns null for null input', () => {
    assert.equal(computeINP(null), null);
  });
});

// --- CLS accumulation ---

describe('CLS accumulation', () => {
  test('accumulates layout shift values', () => {
    const ctrl = createWebVitalsController(true);
    ctrl.onCLS([{ value: 0.1, hadRecentInput: false }]);
    ctrl.onCLS([{ value: 0.05, hadRecentInput: false }]);
    const props = ctrl.flush('/test');
    assert.equal(props.cwv_cls, 0.15);
  });

  test('filters out entries with hadRecentInput', () => {
    const ctrl = createWebVitalsController(true);
    ctrl.onCLS([
      { value: 0.1, hadRecentInput: false },
      { value: 0.5, hadRecentInput: true },
      { value: 0.05, hadRecentInput: false },
    ]);
    const props = ctrl.flush('/test');
    assert.equal(props.cwv_cls, 0.15);
  });

  test('zero CLS when all entries have hadRecentInput', () => {
    const ctrl = createWebVitalsController(true);
    ctrl.onCLS([{ value: 0.3, hadRecentInput: true }]);
    ctrl.onLCP([{ startTime: 100 }]); // need some data to trigger flush
    const props = ctrl.flush('/test');
    assert.equal(props.cwv_cls, 0);
  });

  test('CLS rounded to 3 decimal places', () => {
    const ctrl = createWebVitalsController(true);
    ctrl.onCLS([{ value: 0.1234567, hadRecentInput: false }]);
    const props = ctrl.flush('/test');
    assert.equal(props.cwv_cls, 0.123);
  });
});

// --- LCP behavior ---

describe('LCP behavior', () => {
  test('takes the latest entry (last in array)', () => {
    const ctrl = createWebVitalsController(true);
    ctrl.onLCP([
      { startTime: 100 },
      { startTime: 500 },
      { startTime: 250 },
    ]);
    const props = ctrl.flush('/test');
    assert.equal(props.cwv_lcp, 250);
  });

  test('multiple onLCP calls — latest call wins', () => {
    const ctrl = createWebVitalsController(true);
    ctrl.onLCP([{ startTime: 100 }]);
    ctrl.onLCP([{ startTime: 800 }]);
    const props = ctrl.flush('/test');
    assert.equal(props.cwv_lcp, 800);
  });

  test('LCP rounded to integer', () => {
    const ctrl = createWebVitalsController(true);
    ctrl.onLCP([{ startTime: 1234.567 }]);
    const props = ctrl.flush('/test');
    assert.equal(props.cwv_lcp, 1235);
  });

  test('no LCP data omits cwv_lcp from props', () => {
    const ctrl = createWebVitalsController(true);
    ctrl.onCLS([{ value: 0.1, hadRecentInput: false }]);
    const props = ctrl.flush('/test');
    assert.equal(props.cwv_lcp, undefined);
    assert.equal(props.cwv_cls, 0.1);
  });
});

// --- Flush behavior ---

describe('web vitals flush behavior', () => {
  test('flush with no data returns null', () => {
    const ctrl = createWebVitalsController(true);
    const result = ctrl.flush('/test');
    assert.equal(result, null);
  });

  test('double flush returns null on second call', () => {
    const ctrl = createWebVitalsController(true);
    ctrl.onLCP([{ startTime: 100 }]);
    const first = ctrl.flush('/test');
    assert.notEqual(first, null);
    const second = ctrl.flush('/test');
    assert.equal(second, null);
  });

  test('flush includes path', () => {
    const ctrl = createWebVitalsController(true);
    ctrl.onLCP([{ startTime: 100 }]);
    const props = ctrl.flush('/about');
    assert.equal(props.path, '/about');
  });

  test('flush includes all three metrics when available', () => {
    const ctrl = createWebVitalsController(true);
    ctrl.onLCP([{ startTime: 500 }]);
    ctrl.onCLS([{ value: 0.1, hadRecentInput: false }]);
    ctrl.onINP([{ interactionId: 1, duration: 80 }]);
    const props = ctrl.flush('/test');
    assert.equal(props.cwv_lcp, 500);
    assert.equal(props.cwv_cls, 0.1);
    assert.equal(props.cwv_inp, 80);
  });

  test('no INP data omits cwv_inp from props', () => {
    const ctrl = createWebVitalsController(true);
    ctrl.onLCP([{ startTime: 100 }]);
    const props = ctrl.flush('/test');
    assert.equal(props.cwv_inp, undefined);
  });
});

// --- SPA reset cycle ---

describe('web vitals SPA reset', () => {
  test('reset flushes and allows new collection cycle', () => {
    const ctrl = createWebVitalsController(true);
    ctrl.onLCP([{ startTime: 500 }]);
    ctrl.onCLS([{ value: 0.1, hadRecentInput: false }]);

    // Reset (which triggers flush internally)
    ctrl.reset('/page1');
    assert.equal(ctrl.getTracked().length, 1);
    assert.equal(ctrl.getTracked()[0].cwv_lcp, 500);

    // New data on next page
    ctrl.onLCP([{ startTime: 300 }]);
    ctrl.onCLS([{ value: 0.05, hadRecentInput: false }]);
    const props = ctrl.flush('/page2');
    assert.equal(props.cwv_lcp, 300);
    assert.equal(props.cwv_cls, 0.05);
    assert.equal(ctrl.getTracked().length, 2);
  });

  test('reset with no data does not create a tracked entry', () => {
    const ctrl = createWebVitalsController(true);
    ctrl.reset('/empty');
    assert.equal(ctrl.getTracked().length, 0);
  });
});

// --- INP entries filtering ---

describe('INP entry filtering', () => {
  test('only entries with interactionId are included', () => {
    const ctrl = createWebVitalsController(true);
    ctrl.onINP([
      { interactionId: 1, duration: 80 },
      { interactionId: 0, duration: 200 },
      { interactionId: 2, duration: 50 },
      { duration: 300 },
    ]);
    const props = ctrl.flush('/test');
    // Only interactionId 1 (80) and 2 (50), p98 → 80
    assert.equal(props.cwv_inp, 80);
  });
});

// --- Disabled state ---

describe('web vitals disabled', () => {
  test('returns null when disabled', () => {
    assert.equal(createWebVitalsController(false), null);
  });

  test('returns null for falsy values', () => {
    assert.equal(createWebVitalsController(null), null);
    assert.equal(createWebVitalsController(undefined), null);
    assert.equal(createWebVitalsController(0), null);
    assert.equal(createWebVitalsController(''), null);
  });
});

// --- Build output checks ---

describe('web vitals in built tracker', () => {
  test('built tracker.js contains $web_vitals event name', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('$web_vitals'), 'tracker.js should contain $web_vitals');
  });

  test('built tracker.js contains data-track-vitals attribute', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('data-track-vitals'), 'tracker.js should reference data-track-vitals');
  });

  test('built tracker.js contains largest-contentful-paint', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('largest-contentful-paint'), 'tracker.js should contain largest-contentful-paint');
  });

  test('built tracker.js contains layout-shift', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('layout-shift'), 'tracker.js should contain layout-shift');
  });

  test('built tracker.js contains cwv_lcp', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('cwv_lcp'), 'tracker.js should contain cwv_lcp');
  });

  test('built tracker.js contains cwv_cls', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('cwv_cls'), 'tracker.js should contain cwv_cls');
  });

  test('built tracker.js contains cwv_inp', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('cwv_inp'), 'tracker.js should contain cwv_inp');
  });
});
