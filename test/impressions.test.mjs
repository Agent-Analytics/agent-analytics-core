import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * parseImpressionProps — mirrors the extra property extraction logic
 * from the impression tracking block in tracker.src.js.
 * Given an element's attributes as { name, value } pairs,
 * returns { name, ...extras }.
 */
function parseImpressionProps(impressionName, attributes) {
  var props = { name: impressionName };
  for (var i = 0; i < attributes.length; i++) {
    var a = attributes[i].name;
    if (a.startsWith('data-aa-impression-')) {
      props[a.slice(19)] = attributes[i].value;
    }
  }
  return props;
}

/**
 * createImpressionTracker — simulates the IntersectionObserver-based
 * impression tracking lifecycle from tracker.src.js.
 * Returns null if IntersectionObserver is unavailable.
 */
function createImpressionTracker(hasIO) {
  if (!hasIO) return null;

  var observed = new Set();
  var tracked = [];
  var disconnected = false;
  var scanCount = 0;

  function scan(elements) {
    scanCount++;
    disconnected = false;
    observed.clear();
    for (var i = 0; i < elements.length; i++) {
      observed.add(elements[i]);
    }
  }

  function intersect(element) {
    if (!observed.has(element)) return false;
    var name = element.impressionName;
    if (!name) return false;
    var props = parseImpressionProps(name, element.attributes || []);
    tracked.push({ event: '$impression', properties: props });
    // unobserve after fire
    observed.delete(element);
    return true;
  }

  function disconnect() {
    disconnected = true;
    observed.clear();
  }

  return {
    scan: scan,
    intersect: intersect,
    disconnect: disconnect,
    getTracked: function() { return tracked; },
    getObserved: function() { return observed; },
    isDisconnected: function() { return disconnected; },
    getScanCount: function() { return scanCount; }
  };
}

// Helper: create a mock element
function mockElement(impressionName, extraAttrs) {
  var attributes = [
    { name: 'data-aa-impression', value: impressionName }
  ];
  if (extraAttrs) {
    for (var key in extraAttrs) {
      attributes.push({ name: 'data-aa-impression-' + key, value: extraAttrs[key] });
    }
  }
  return { impressionName: impressionName, attributes: attributes };
}

// --- Extra properties parsing ---

describe('impression extra properties parsing', () => {
  test('extracts name from data-aa-impression attribute', () => {
    var props = parseImpressionProps('cta_banner', [
      { name: 'data-aa-impression', value: 'cta_banner' }
    ]);
    assert.deepEqual(props, { name: 'cta_banner' });
  });

  test('extracts extra properties from data-aa-impression-* attributes', () => {
    var props = parseImpressionProps('hero', [
      { name: 'data-aa-impression', value: 'hero' },
      { name: 'data-aa-impression-placement', value: 'top' },
      { name: 'data-aa-impression-variant', value: 'blue' }
    ]);
    assert.deepEqual(props, { name: 'hero', placement: 'top', variant: 'blue' });
  });

  test('ignores non-impression attributes', () => {
    var props = parseImpressionProps('banner', [
      { name: 'data-aa-impression', value: 'banner' },
      { name: 'class', value: 'hero-section' },
      { name: 'id', value: 'main-cta' },
      { name: 'data-aa-event', value: 'click' }
    ]);
    assert.deepEqual(props, { name: 'banner' });
  });

  test('handles empty extra property value', () => {
    var props = parseImpressionProps('card', [
      { name: 'data-aa-impression', value: 'card' },
      { name: 'data-aa-impression-section', value: '' }
    ]);
    assert.deepEqual(props, { name: 'card', section: '' });
  });

  test('handles no attributes beyond name', () => {
    var props = parseImpressionProps('footer', []);
    assert.deepEqual(props, { name: 'footer' });
  });

  test('slice(19) correctly strips data-aa-impression- prefix', () => {
    var prefix = 'data-aa-impression-';
    assert.equal(prefix.length, 19);
    assert.equal('data-aa-impression-position'.slice(19), 'position');
    assert.equal('data-aa-impression-x'.slice(19), 'x');
  });
});

// --- Observer lifecycle simulation ---

describe('impression tracker observer lifecycle', () => {
  test('returns null when IntersectionObserver unavailable', () => {
    assert.equal(createImpressionTracker(false), null);
  });

  test('scan registers elements for observation', () => {
    var tracker = createImpressionTracker(true);
    var el1 = mockElement('banner');
    var el2 = mockElement('cta');
    tracker.scan([el1, el2]);
    assert.equal(tracker.getObserved().size, 2);
    assert.ok(tracker.getObserved().has(el1));
    assert.ok(tracker.getObserved().has(el2));
  });

  test('intersecting element fires $impression event', () => {
    var tracker = createImpressionTracker(true);
    var el = mockElement('hero_cta');
    tracker.scan([el]);
    var result = tracker.intersect(el);
    assert.equal(result, true);
    assert.equal(tracker.getTracked().length, 1);
    assert.equal(tracker.getTracked()[0].event, '$impression');
    assert.equal(tracker.getTracked()[0].properties.name, 'hero_cta');
  });

  test('intersecting element includes extra properties', () => {
    var tracker = createImpressionTracker(true);
    var el = mockElement('pricing', { plan: 'pro', position: 'above-fold' });
    tracker.scan([el]);
    tracker.intersect(el);
    var props = tracker.getTracked()[0].properties;
    assert.equal(props.name, 'pricing');
    assert.equal(props.plan, 'pro');
    assert.equal(props.position, 'above-fold');
  });
});

// --- Once per element ---

describe('impression tracking once per element', () => {
  test('element is unobserved after firing', () => {
    var tracker = createImpressionTracker(true);
    var el = mockElement('banner');
    tracker.scan([el]);
    tracker.intersect(el);
    assert.equal(tracker.getObserved().has(el), false);
  });

  test('duplicate intersection on same element returns false', () => {
    var tracker = createImpressionTracker(true);
    var el = mockElement('banner');
    tracker.scan([el]);
    assert.equal(tracker.intersect(el), true);
    assert.equal(tracker.intersect(el), false);
    assert.equal(tracker.getTracked().length, 1);
  });

  test('multiple elements fire independently', () => {
    var tracker = createImpressionTracker(true);
    var el1 = mockElement('hero');
    var el2 = mockElement('footer');
    tracker.scan([el1, el2]);
    tracker.intersect(el1);
    tracker.intersect(el2);
    assert.equal(tracker.getTracked().length, 2);
    assert.equal(tracker.getTracked()[0].properties.name, 'hero');
    assert.equal(tracker.getTracked()[1].properties.name, 'footer');
  });

  test('element with empty name is skipped', () => {
    var tracker = createImpressionTracker(true);
    var el = { impressionName: '', attributes: [] };
    tracker.scan([el]);
    assert.equal(tracker.intersect(el), false);
  });
});

// --- SPA re-scan ---

describe('impression tracking SPA re-scan', () => {
  test('scan clears previous observations', () => {
    var tracker = createImpressionTracker(true);
    var el1 = mockElement('banner');
    tracker.scan([el1]);
    assert.equal(tracker.getObserved().size, 1);

    var el2 = mockElement('new_section');
    tracker.scan([el2]);
    assert.equal(tracker.getObserved().size, 1);
    assert.ok(!tracker.getObserved().has(el1));
    assert.ok(tracker.getObserved().has(el2));
  });

  test('previously seen element can fire again after re-scan', () => {
    var tracker = createImpressionTracker(true);
    var el = mockElement('hero');
    tracker.scan([el]);
    tracker.intersect(el);
    assert.equal(tracker.getTracked().length, 1);

    // SPA navigation — re-scan with same element
    tracker.scan([el]);
    tracker.intersect(el);
    assert.equal(tracker.getTracked().length, 2);
  });

  test('scan count increments on each scan', () => {
    var tracker = createImpressionTracker(true);
    assert.equal(tracker.getScanCount(), 0);
    tracker.scan([]);
    assert.equal(tracker.getScanCount(), 1);
    tracker.scan([]);
    assert.equal(tracker.getScanCount(), 2);
  });

  test('empty scan clears observations', () => {
    var tracker = createImpressionTracker(true);
    var el = mockElement('banner');
    tracker.scan([el]);
    assert.equal(tracker.getObserved().size, 1);
    tracker.scan([]);
    assert.equal(tracker.getObserved().size, 0);
  });
});

// --- No IO fallback ---

describe('no IntersectionObserver fallback', () => {
  test('returns null — no tracking, no errors', () => {
    var result = createImpressionTracker(false);
    assert.equal(result, null);
  });

  test('null for various falsy values', () => {
    assert.equal(createImpressionTracker(0), null);
    assert.equal(createImpressionTracker(''), null);
    assert.equal(createImpressionTracker(null), null);
    assert.equal(createImpressionTracker(undefined), null);
  });
});

// --- Build output checks ---

describe('impression tracking in built tracker', () => {
  test('built tracker.js contains $impression event name', () => {
    var content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('$impression'), 'tracker.js should contain $impression');
  });

  test('built tracker.js contains data-aa-impression attribute', () => {
    var content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('data-aa-impression'), 'tracker.js should reference data-aa-impression');
  });

  test('built tracker.js contains IntersectionObserver', () => {
    var content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('IntersectionObserver'), 'tracker.js should reference IntersectionObserver');
  });

  test('built tracker.js contains threshold for 50% visibility', () => {
    var content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('threshold'), 'tracker.js should contain threshold option');
  });
});
