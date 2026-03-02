import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * sdDocHeight — mirrors the robust cross-browser height measurement in tracker.src.js.
 * Returns the maximum across all 6 measurements (body + documentElement × 3 properties).
 */
function sdDocHeight(body, docEl) {
  var b = body || {}, e = docEl || {};
  return Math.max(
    b.scrollHeight || 0, b.offsetHeight || 0, b.clientHeight || 0,
    e.scrollHeight || 0, e.offsetHeight || 0, e.clientHeight || 0
  );
}

/**
 * createScrollDepthController — mirrors the scroll depth logic in tracker.src.js.
 * Extracts the state machine for testing without a browser DOM.
 */
function createScrollDepthController(enabled) {
  if (!enabled) return null;

  var docHeight = 0;
  var maxPx = 0;
  var flushed = false;
  var tracked = [];
  var viewportHeight = 0;
  var scrollY = 0;

  function measure() {
    var px = docHeight <= viewportHeight ? docHeight : scrollY + viewportHeight;
    if (px > maxPx) maxPx = px;
  }

  return {
    setDimensions: function(dh, vh) {
      docHeight = dh;
      viewportHeight = vh;
    },

    setScrollY: function(y) {
      scrollY = y;
    },

    measure: measure,

    flush: function(path) {
      if (flushed) return null;
      measure();
      if (maxPx > 0 && docHeight > 0) {
        flushed = true;
        var pct = Math.min(Math.round((maxPx / docHeight) * 100), 100);
        tracked.push({ scroll_depth: pct, path: path || '/' });
        return { scroll_depth: pct, path: path || '/' };
      }
      return null;
    },

    reset: function(path) {
      var result = this.flush(path);
      maxPx = 0;
      flushed = false;
      measure();
      return result;
    },

    getTracked: function() { return tracked; },
    getMaxPx: function() { return maxPx; },
    isFlushed: function() { return flushed; },
  };
}

// --- Document height measurement ---

describe('document height measurement', () => {
  test('returns max across all 6 measurements', () => {
    const result = sdDocHeight(
      { scrollHeight: 100, offsetHeight: 200, clientHeight: 150 },
      { scrollHeight: 300, offsetHeight: 250, clientHeight: 180 }
    );
    assert.equal(result, 300);
  });

  test('body values can be the largest', () => {
    const result = sdDocHeight(
      { scrollHeight: 500, offsetHeight: 200, clientHeight: 150 },
      { scrollHeight: 300, offsetHeight: 250, clientHeight: 180 }
    );
    assert.equal(result, 500);
  });

  test('handles missing body gracefully', () => {
    const result = sdDocHeight(null, { scrollHeight: 1000, offsetHeight: 800, clientHeight: 600 });
    assert.equal(result, 1000);
  });

  test('handles missing documentElement gracefully', () => {
    const result = sdDocHeight({ scrollHeight: 1000, offsetHeight: 800, clientHeight: 600 }, null);
    assert.equal(result, 1000);
  });

  test('handles both missing', () => {
    const result = sdDocHeight(null, null);
    assert.equal(result, 0);
  });

  test('handles partial properties', () => {
    const result = sdDocHeight({ scrollHeight: 500 }, { offsetHeight: 300 });
    assert.equal(result, 500);
  });
});

// --- Scroll depth calculation ---

describe('scroll depth calculation', () => {
  test('top of page = viewport_height / doc_height (not 0)', () => {
    const ctrl = createScrollDepthController(true);
    ctrl.setDimensions(2000, 800);
    ctrl.setScrollY(0);
    ctrl.measure();
    const result = ctrl.flush('/test');
    // viewport is 800px into 2000px doc = 40%
    assert.equal(result.scroll_depth, 40);
  });

  test('scrolled to bottom = 100', () => {
    const ctrl = createScrollDepthController(true);
    ctrl.setDimensions(2000, 800);
    ctrl.setScrollY(1200); // scrollY + vh = 2000
    ctrl.measure();
    const result = ctrl.flush('/test');
    assert.equal(result.scroll_depth, 100);
  });

  test('mid-page scroll = correct percentage', () => {
    const ctrl = createScrollDepthController(true);
    ctrl.setDimensions(2000, 800);
    ctrl.setScrollY(200); // 200 + 800 = 1000 / 2000 = 50%
    ctrl.measure();
    const result = ctrl.flush('/test');
    assert.equal(result.scroll_depth, 50);
  });

  test('clamps to 100 max', () => {
    const ctrl = createScrollDepthController(true);
    ctrl.setDimensions(2000, 800);
    ctrl.setScrollY(1500); // 1500 + 800 = 2300 > 2000
    ctrl.measure();
    const result = ctrl.flush('/test');
    assert.equal(result.scroll_depth, 100);
  });

  test('short page (docHeight <= viewportHeight) = 100', () => {
    const ctrl = createScrollDepthController(true);
    ctrl.setDimensions(500, 800); // page shorter than viewport
    ctrl.setScrollY(0);
    ctrl.measure();
    const result = ctrl.flush('/test');
    assert.equal(result.scroll_depth, 100);
  });
});

// --- Scroll depth state machine ---

describe('scroll depth state machine', () => {
  test('starts with initial measurement (non-zero for short pages)', () => {
    const ctrl = createScrollDepthController(true);
    ctrl.setDimensions(400, 800);
    ctrl.measure(); // initial
    assert.ok(ctrl.getMaxPx() > 0, 'max should be non-zero for short page');
  });

  test('max only increases on scroll', () => {
    const ctrl = createScrollDepthController(true);
    ctrl.setDimensions(2000, 800);
    ctrl.setScrollY(0);
    ctrl.measure();
    const max1 = ctrl.getMaxPx();

    ctrl.setScrollY(500);
    ctrl.measure();
    const max2 = ctrl.getMaxPx();
    assert.ok(max2 > max1, 'max should increase on scroll down');

    ctrl.setScrollY(200); // scroll back up
    ctrl.measure();
    const max3 = ctrl.getMaxPx();
    assert.equal(max3, max2, 'max should not decrease on scroll up');
  });

  test('flush sends $scroll_depth with correct path and percentage', () => {
    const ctrl = createScrollDepthController(true);
    ctrl.setDimensions(1000, 500);
    ctrl.setScrollY(500); // 500 + 500 = 1000 = 100%
    ctrl.measure();
    const result = ctrl.flush('/about');
    assert.deepEqual(result, { scroll_depth: 100, path: '/about' });
  });

  test('double flush returns null on second call', () => {
    const ctrl = createScrollDepthController(true);
    ctrl.setDimensions(2000, 800);
    ctrl.setScrollY(500);
    ctrl.measure();
    const first = ctrl.flush('/test');
    assert.notEqual(first, null);
    const second = ctrl.flush('/test');
    assert.equal(second, null);
    assert.equal(ctrl.getTracked().length, 1, 'should only track once');
  });

  test('flush with no scroll sends initial viewport percentage', () => {
    const ctrl = createScrollDepthController(true);
    ctrl.setDimensions(2000, 800);
    ctrl.setScrollY(0);
    ctrl.measure();
    const result = ctrl.flush('/test');
    assert.equal(result.scroll_depth, 40);
  });

  test('reset: flushes previous page, resets for new page', () => {
    const ctrl = createScrollDepthController(true);
    ctrl.setDimensions(2000, 800);
    ctrl.setScrollY(400);
    ctrl.measure();

    // Reset triggers flush
    ctrl.reset('/page1');
    assert.equal(ctrl.getTracked().length, 1);
    assert.equal(ctrl.getTracked()[0].scroll_depth, 60); // (400+800)/2000

    // New page starts fresh
    ctrl.setDimensions(1000, 800);
    ctrl.setScrollY(200); // 200 + 800 = 1000 = 100%
    ctrl.measure();
    const result = ctrl.flush('/page2');
    assert.equal(result.scroll_depth, 100);
    assert.equal(ctrl.getTracked().length, 2);
  });

  test('reset re-enables flushing for next page', () => {
    const ctrl = createScrollDepthController(true);
    ctrl.setDimensions(2000, 800);
    ctrl.setScrollY(400);
    ctrl.measure();
    ctrl.flush('/page1');
    assert.equal(ctrl.isFlushed(), true);

    ctrl.reset('/page1'); // should reset flushed flag
    assert.equal(ctrl.isFlushed(), false);

    ctrl.setDimensions(1000, 800);
    ctrl.setScrollY(200);
    ctrl.measure();
    const result = ctrl.flush('/page2');
    assert.notEqual(result, null, 'should be able to flush after reset');
  });

  test('SPA navigation: flush + reset pattern', () => {
    const ctrl = createScrollDepthController(true);

    // Page 1
    ctrl.setDimensions(3000, 800);
    ctrl.setScrollY(700); // 700+800=1500/3000=50%
    ctrl.measure();

    // Navigate to page 2 (calls reset)
    ctrl.reset('/page1');

    // Page 2
    ctrl.setDimensions(1500, 800);
    ctrl.setScrollY(700); // 700+800=1500/1500=100%
    ctrl.measure();
    ctrl.flush('/page2');

    assert.equal(ctrl.getTracked().length, 2);
    assert.equal(ctrl.getTracked()[0].scroll_depth, 50);
    assert.equal(ctrl.getTracked()[1].scroll_depth, 100);
  });
});

// --- Disabled state ---

describe('scroll depth disabled', () => {
  test('returns null when disabled', () => {
    assert.equal(createScrollDepthController(false), null);
  });

  test('returns null for falsy values', () => {
    assert.equal(createScrollDepthController(null), null);
    assert.equal(createScrollDepthController(undefined), null);
    assert.equal(createScrollDepthController(0), null);
    assert.equal(createScrollDepthController(''), null);
  });
});

// --- Zero height edge cases ---

describe('scroll depth edge cases', () => {
  test('zero doc height returns null (no flush)', () => {
    const ctrl = createScrollDepthController(true);
    ctrl.setDimensions(0, 800);
    ctrl.measure();
    const result = ctrl.flush('/test');
    assert.equal(result, null);
  });

  test('zero viewport with tall page still tracks scroll', () => {
    const ctrl = createScrollDepthController(true);
    ctrl.setDimensions(2000, 0);
    ctrl.setScrollY(1000); // 1000 + 0 = 1000/2000 = 50%
    ctrl.measure();
    const result = ctrl.flush('/test');
    assert.equal(result.scroll_depth, 50);
  });
});

// --- Build output checks ---

describe('scroll depth in built tracker', () => {
  test('tracker.js contains $scroll_depth', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('$scroll_depth'), 'tracker.js should contain $scroll_depth');
  });

  test('tracker.js contains scroll_depth', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('scroll_depth'), 'tracker.js should contain scroll_depth');
  });

  test('tracker.js contains data-track-scroll-depth', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('data-track-scroll-depth'), 'tracker.js should reference data-track-scroll-depth');
  });
});
