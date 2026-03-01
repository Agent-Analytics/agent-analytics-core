import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * computePerfMetrics — must match the logic in tracker.src.js collectPerf().
 * Takes a PerformanceNavigationTiming-like object, returns perf props.
 * Returns null if nav is falsy.
 */
function computePerfMetrics(nav) {
  if (!nav) return null;
  return {
    perf_dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
    perf_tcp: Math.round(nav.connectEnd - nav.connectStart),
    perf_ttfb: Math.round(nav.responseStart - nav.requestStart),
    perf_dom_interactive: Math.round(nav.domInteractive),
    perf_dom_complete: Math.round(nav.domComplete),
    perf_load: Math.round(nav.loadEventEnd),
  };
}

/**
 * Simulates the performance collection controller from tracker.src.js.
 * Handles readyState check and delayed collection.
 */
function createPerfController(enabled) {
  if (!enabled) return null;

  var collected = null;
  var scheduled = false;

  return {
    /** Simulate collectPerf with a given nav timing object */
    collect: function(nav) {
      var metrics = computePerfMetrics(nav);
      if (metrics) {
        collected = metrics;
      }
    },
    /** Simulate the readyState/load scheduling logic */
    schedule: function(readyState, nav) {
      if (readyState === 'complete') {
        // setTimeout(collectPerf, 0) — immediate in test
        scheduled = true;
        this.collect(nav);
      } else {
        // would add load listener — simulate by not collecting yet
        scheduled = false;
      }
    },
    /** Simulate window.load firing */
    onLoad: function(nav) {
      scheduled = true;
      this.collect(nav);
    },
    getCollected: function() { return collected; },
    isScheduled: function() { return scheduled; },
  };
}

// --- Realistic Navigation Timing fixture ---
function makeNavTiming(overrides) {
  return {
    startTime: 0,
    domainLookupStart: 5.2,
    domainLookupEnd: 18.7,
    connectStart: 18.7,
    connectEnd: 45.3,
    requestStart: 45.5,
    responseStart: 120.8,
    domInteractive: 450.2,
    domComplete: 980.6,
    loadEventEnd: 1002.4,
    ...overrides,
  };
}

describe('performance metric calculation', () => {
  test('computes DNS lookup time', () => {
    const nav = makeNavTiming();
    const m = computePerfMetrics(nav);
    assert.equal(m.perf_dns, Math.round(18.7 - 5.2)); // 14
  });

  test('computes TCP connection time', () => {
    const nav = makeNavTiming();
    const m = computePerfMetrics(nav);
    assert.equal(m.perf_tcp, Math.round(45.3 - 18.7)); // 27
  });

  test('computes TTFB', () => {
    const nav = makeNavTiming();
    const m = computePerfMetrics(nav);
    assert.equal(m.perf_ttfb, Math.round(120.8 - 45.5)); // 75
  });

  test('computes DOM interactive (absolute from startTime=0)', () => {
    const nav = makeNavTiming();
    const m = computePerfMetrics(nav);
    assert.equal(m.perf_dom_interactive, Math.round(450.2)); // 450
  });

  test('computes DOM complete (absolute)', () => {
    const nav = makeNavTiming();
    const m = computePerfMetrics(nav);
    assert.equal(m.perf_dom_complete, Math.round(980.6)); // 981
  });

  test('computes full page load (absolute)', () => {
    const nav = makeNavTiming();
    const m = computePerfMetrics(nav);
    assert.equal(m.perf_load, Math.round(1002.4)); // 1002
  });

  test('all values are integers (rounded)', () => {
    const nav = makeNavTiming({
      domainLookupStart: 1.1,
      domainLookupEnd: 2.9,
      connectStart: 3.3,
      connectEnd: 7.7,
      requestStart: 8.1,
      responseStart: 15.5,
      domInteractive: 100.4,
      domComplete: 200.6,
      loadEventEnd: 250.9,
    });
    const m = computePerfMetrics(nav);
    for (const key of Object.keys(m)) {
      assert.equal(m[key], Math.floor(m[key]) || Math.ceil(m[key]),
        `${key} should be an integer, got ${m[key]}`);
      assert.equal(Number.isInteger(m[key]), true, `${key} must be integer`);
    }
  });
});

describe('performance edge cases', () => {
  test('returns null when nav is null', () => {
    assert.equal(computePerfMetrics(null), null);
  });

  test('returns null when nav is undefined', () => {
    assert.equal(computePerfMetrics(undefined), null);
  });

  test('handles zero timing values', () => {
    const nav = makeNavTiming({
      domainLookupStart: 0,
      domainLookupEnd: 0,
      connectStart: 0,
      connectEnd: 0,
      requestStart: 0,
      responseStart: 0,
      domInteractive: 0,
      domComplete: 0,
      loadEventEnd: 0,
    });
    const m = computePerfMetrics(nav);
    assert.equal(m.perf_dns, 0);
    assert.equal(m.perf_tcp, 0);
    assert.equal(m.perf_ttfb, 0);
    assert.equal(m.perf_dom_interactive, 0);
    assert.equal(m.perf_dom_complete, 0);
    assert.equal(m.perf_load, 0);
  });

  test('handles cached responses (DNS/TCP = 0)', () => {
    const nav = makeNavTiming({
      domainLookupStart: 0,
      domainLookupEnd: 0,
      connectStart: 0,
      connectEnd: 0,
    });
    const m = computePerfMetrics(nav);
    assert.equal(m.perf_dns, 0);
    assert.equal(m.perf_tcp, 0);
    // Other metrics still have values
    assert.ok(m.perf_ttfb > 0);
    assert.ok(m.perf_dom_interactive > 0);
  });

  test('handles very fast page loads', () => {
    const nav = makeNavTiming({
      domainLookupStart: 0.1,
      domainLookupEnd: 0.2,
      connectStart: 0.2,
      connectEnd: 0.3,
      requestStart: 0.3,
      responseStart: 1.0,
      domInteractive: 5.0,
      domComplete: 10.0,
      loadEventEnd: 12.0,
    });
    const m = computePerfMetrics(nav);
    assert.equal(m.perf_dns, 0); // rounds to 0
    assert.equal(m.perf_tcp, 0); // rounds to 0
    assert.equal(m.perf_ttfb, 1);
    assert.equal(m.perf_load, 12);
  });

  test('handles slow page loads', () => {
    const nav = makeNavTiming({
      domainLookupStart: 100,
      domainLookupEnd: 2500,
      connectStart: 2500,
      connectEnd: 5000,
      requestStart: 5000,
      responseStart: 8000,
      domInteractive: 12000,
      domComplete: 18000,
      loadEventEnd: 20000,
    });
    const m = computePerfMetrics(nav);
    assert.equal(m.perf_dns, 2400);
    assert.equal(m.perf_tcp, 2500);
    assert.equal(m.perf_ttfb, 3000);
    assert.equal(m.perf_dom_interactive, 12000);
    assert.equal(m.perf_load, 20000);
  });
});

describe('performance controller disabled', () => {
  test('returns null when disabled', () => {
    assert.equal(createPerfController(false), null);
  });

  test('returns null when falsy', () => {
    assert.equal(createPerfController(null), null);
    assert.equal(createPerfController(undefined), null);
    assert.equal(createPerfController(0), null);
    assert.equal(createPerfController(''), null);
  });
});

describe('performance controller readyState handling', () => {
  test('collects immediately when readyState is complete', () => {
    const ctrl = createPerfController(true);
    const nav = makeNavTiming();
    ctrl.schedule('complete', nav);
    assert.equal(ctrl.isScheduled(), true);
    assert.notEqual(ctrl.getCollected(), null);
    assert.equal(ctrl.getCollected().perf_dns, Math.round(18.7 - 5.2));
  });

  test('does not collect when readyState is loading', () => {
    const ctrl = createPerfController(true);
    const nav = makeNavTiming();
    ctrl.schedule('loading', nav);
    assert.equal(ctrl.isScheduled(), false);
    assert.equal(ctrl.getCollected(), null);
  });

  test('does not collect when readyState is interactive', () => {
    const ctrl = createPerfController(true);
    const nav = makeNavTiming();
    ctrl.schedule('interactive', nav);
    assert.equal(ctrl.isScheduled(), false);
    assert.equal(ctrl.getCollected(), null);
  });

  test('collects on load event when not already complete', () => {
    const ctrl = createPerfController(true);
    const nav = makeNavTiming();
    ctrl.schedule('loading', nav);
    assert.equal(ctrl.getCollected(), null);

    // Simulate load event firing
    ctrl.onLoad(nav);
    assert.equal(ctrl.isScheduled(), true);
    assert.notEqual(ctrl.getCollected(), null);
    assert.equal(ctrl.getCollected().perf_load, Math.round(1002.4));
  });

  test('skips collection when nav entry is missing', () => {
    const ctrl = createPerfController(true);
    ctrl.collect(null);
    assert.equal(ctrl.getCollected(), null);
  });
});

describe('performance metrics property keys', () => {
  test('all 6 expected keys are present', () => {
    const nav = makeNavTiming();
    const m = computePerfMetrics(nav);
    const keys = Object.keys(m).sort();
    assert.deepEqual(keys, [
      'perf_dns',
      'perf_dom_complete',
      'perf_dom_interactive',
      'perf_load',
      'perf_tcp',
      'perf_ttfb',
    ]);
  });

  test('no extra keys beyond the 6 metrics', () => {
    const nav = makeNavTiming();
    const m = computePerfMetrics(nav);
    assert.equal(Object.keys(m).length, 6);
  });
});

describe('performance tracking in built tracker', () => {
  test('built tracker.js contains $performance event name', () => {
    const trackerPath = join(__dirname, '..', 'src', 'tracker.js');
    const content = readFileSync(trackerPath, 'utf-8');
    assert.ok(content.includes('$performance'), 'tracker.js should contain $performance');
  });

  test('built tracker.js contains data-track-performance attribute reference', () => {
    const trackerPath = join(__dirname, '..', 'src', 'tracker.js');
    const content = readFileSync(trackerPath, 'utf-8');
    assert.ok(content.includes('data-track-performance'), 'tracker.js should reference data-track-performance');
  });

  test('built tracker.js contains perf metric keys', () => {
    const trackerPath = join(__dirname, '..', 'src', 'tracker.js');
    const content = readFileSync(trackerPath, 'utf-8');
    assert.ok(content.includes('perf_dns'), 'tracker.js should contain perf_dns');
    assert.ok(content.includes('perf_ttfb'), 'tracker.js should contain perf_ttfb');
    assert.ok(content.includes('perf_load'), 'tracker.js should contain perf_load');
  });

  test('built tracker.js uses getEntriesByType for navigation timing', () => {
    const trackerPath = join(__dirname, '..', 'src', 'tracker.js');
    const content = readFileSync(trackerPath, 'utf-8');
    assert.ok(content.includes('getEntriesByType'), 'tracker.js should use getEntriesByType');
  });

  test('built tracker.js uses loadEventEnd', () => {
    const trackerPath = join(__dirname, '..', 'src', 'tracker.js');
    const content = readFileSync(trackerPath, 'utf-8');
    assert.ok(content.includes('loadEventEnd'), 'tracker.js should reference loadEventEnd');
  });
});
