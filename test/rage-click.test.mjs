import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const trackerSource = readFileSync(join(__dirname, '..', 'src', 'tracker.src.js'), 'utf-8');
const WINDOW_MS = 1000;

function createStorage() {
  const store = new Map();
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
    clear() { store.clear(); }
  };
}

function runTracker({ attrs = { 'data-track-clicks': 'true' } } = {}) {
  const clock = { now: 1_700_000_000_000 };
  const RealDate = Date;
  function TrackerDate(...args) {
    if (!new.target) return RealDate(...args);
    if (args.length === 0) return new RealDate(clock.now);
    return new RealDate(...args);
  }
  TrackerDate.now = function() { return clock.now; };
  TrackerDate.parse = RealDate.parse;
  TrackerDate.UTC = RealDate.UTC;
  TrackerDate.prototype = RealDate.prototype;

  const url = new URL('https://example.com/private/path');
  const events = { document: {}, window: {} };
  const beacons = [];
  const scriptAttrs = new Map(Object.entries(attrs));
  const context = {
    URL,
    URLSearchParams,
    Date: TrackerDate,
    Blob: class Blob {
      constructor(parts, options) { this.parts = parts; this.options = options; }
      text() { return Promise.resolve(this.parts.join('')); }
    },
    console: { log() {} },
    Math,
    JSON,
    clearTimeout() {},
    setTimeout(fn, delay) { if (delay === 0) fn(); return 1; },
    location: {
      href: url.href,
      origin: url.origin,
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash
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
    title: 'Sensitive Page',
    referrer: '',
    visibilityState: 'visible',
    readyState: 'complete',
    documentElement: { classList: { remove() {} } },
    currentScript: {
      src: 'https://cdn.example/tracker.js',
      dataset: { project: 'proj', token: 'tok' },
      getAttribute(name) { return scriptAttrs.get(name) || null; }
    },
    addEventListener(type, handler) {
      events.document[type] = events.document[type] || [];
      events.document[type].push(handler);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  context.document = document;
  context.window = {
    addEventListener(type, handler) {
      events.window[type] = events.window[type] || [];
      events.window[type].push(handler);
    }
  };
  context.window.window = context.window;
  context.window.document = document;
  context.window.navigator = context.navigator;
  context.window.location = context.location;
  context.window.localStorage = context.localStorage;
  context.window.sessionStorage = context.sessionStorage;

  vm.createContext(context);
  vm.runInContext(trackerSource, context, { filename: 'tracker.src.js' });

  function click(target) {
    for (const handler of events.document.click || []) handler({ target });
  }

  function flush() {
    for (const handler of events.window.beforeunload || []) handler();
    return beacons.flatMap((entry) => {
      const payload = JSON.parse(entry.body);
      return payload.events || [payload];
    });
  }

  return { clock, click, flush };
}

function tracked(runtime, name) {
  return runtime.flush().filter((event) => event.event === name);
}

function denySensitiveReads(obj, label) {
  for (const key of ['textContent', 'innerText', 'value']) {
    Object.defineProperty(obj, key, {
      get() { throw new Error(`tracker read ${label} ${key}`); },
      enumerable: false
    });
  }
}

function makeControl({
  tagName = 'BUTTON',
  id = 'save',
  className = 'btn primary',
  type = 'button',
  href = '',
  declarative = false
} = {}) {
  const el = {
    tagName,
    id,
    className,
    type,
    href,
    getAttribute(name) { return declarative && name === 'data-aa-event' ? 'cta_click' : null; },
    attributes: declarative ? [{ name: 'data-aa-event', value: 'cta_click' }] : [],
    closest(selector) {
      if (selector === '[data-aa-event]') return declarative ? el : null;
      if (selector === 'a') return tagName === 'A' ? el : null;
      if (selector === 'button') return tagName === 'BUTTON' ? el : null;
      if (selector === 'a, button') return el;
      return null;
    }
  };
  denySensitiveReads(el, 'control');
  el.inner = {
    tagName: 'SPAN',
    closest(selector) { return el.closest(selector); }
  };
  denySensitiveReads(el.inner, 'inner click');
  return el;
}

function clickTimes(runtime, target, times) {
  for (const at of times) {
    runtime.clock.now = at;
    runtime.click(target);
  }
}

describe('rage click detection', () => {
  test('three rapid clicks on the same element emit one rage_click and still emit $click', () => {
    const runtime = runTracker();
    const button = makeControl({ id: 'save', className: 'btn primary' });
    const start = runtime.clock.now;
    clickTimes(runtime, button.inner, [start, start + 40, start + 80]);

    const clicks = tracked(runtime, '$click');
    const rage = tracked(runtime, 'rage_click');
    assert.equal(clicks.length, 3);
    assert.equal(rage.length, 1);
    assert.ok(rage[0].properties.click_count >= 3);
    assert.equal(rage[0].properties.tag, 'button');
    assert.equal(rage[0].properties.id, 'save');
    assert.equal(rage[0].properties.classes, 'btn primary');
    assert.equal(rage[0].properties.type, 'button');
    assert.equal(rage[0].properties.text, undefined);
    assert.equal(clicks.every((event) => event.properties.click_count === undefined), true);
  });

  test('a fourth click in the same burst does not emit another rage_click', () => {
    const runtime = runTracker();
    const button = makeControl();
    const start = runtime.clock.now;
    clickTimes(runtime, button, [start, start + 10, start + 20, start + 30]);

    const rage = tracked(runtime, 'rage_click');
    assert.equal(rage.length, 1);
    assert.equal(rage[0].properties.click_count, 3);
    assert.equal(tracked(runtime, '$click').length, 4);
  });

  test('clicks spaced more than 1s do not emit rage_click', () => {
    const runtime = runTracker();
    const button = makeControl();
    const start = runtime.clock.now;
    clickTimes(runtime, button, [start, start + WINDOW_MS + 1, start + (WINDOW_MS + 1) * 2]);

    assert.equal(tracked(runtime, 'rage_click').length, 0);
    assert.equal(tracked(runtime, '$click').length, 3);
  });

  test('fewer than 3 clicks do not emit rage_click', () => {
    const runtime = runTracker();
    const button = makeControl();
    const start = runtime.clock.now;
    clickTimes(runtime, button, [start, start + 25]);

    assert.equal(tracked(runtime, 'rage_click').length, 0);
    assert.equal(tracked(runtime, '$click').length, 2);
  });

  test('clicks on different elements do not combine into a rage_click', () => {
    const runtime = runTracker();
    const first = makeControl({ id: 'save', className: 'btn primary' });
    const second = makeControl({ id: 'cancel', className: 'btn primary' });
    const start = runtime.clock.now;
    clickTimes(runtime, first, [start]);
    clickTimes(runtime, second, [start + 10]);
    clickTimes(runtime, first, [start + 20]);
    clickTimes(runtime, second, [start + 30]);

    assert.equal(tracked(runtime, 'rage_click').length, 0);
    const clicks = tracked(runtime, '$click');
    assert.equal(clicks.filter((event) => event.properties.id === 'save').length, 2);
    assert.equal(clicks.filter((event) => event.properties.id === 'cancel').length, 2);
  });

  test('interleaved clicks still rage once per element', () => {
    const runtime = runTracker();
    const first = makeControl({ id: 'save', className: 'twin' });
    const second = makeControl({ id: 'cancel', className: 'twin' });
    const start = runtime.clock.now;
    for (let i = 0; i < 3; i++) {
      clickTimes(runtime, first, [start + i * 20]);
      clickTimes(runtime, second, [start + i * 20 + 5]);
    }

    const rage = tracked(runtime, 'rage_click');
    assert.equal(rage.length, 2);
    assert.deepEqual(rage.map((event) => event.properties.id).sort(), ['cancel', 'save']);
    assert.equal(rage.every((event) => event.properties.click_count >= 3), true);
    assert.equal(rage.every((event) => event.properties.classes === 'twin'), true);
  });

  test('a later burst can emit again after the window clears', () => {
    const runtime = runTracker();
    const button = makeControl({ id: 'retry' });
    const start = runtime.clock.now;
    clickTimes(runtime, button, [start, start + 10, start + 20]);
    const next = start + 20 + WINDOW_MS + 1;
    clickTimes(runtime, button, [next, next + 10, next + 20]);

    const rage = tracked(runtime, 'rage_click');
    assert.equal(rage.length, 2);
    assert.equal(rage.every((event) => event.properties.id === 'retry' && event.properties.click_count >= 3), true);
  });

  test('link rage_click keeps sanitized href props and omits visible text', () => {
    const runtime = runTracker();
    const link = makeControl({
      tagName: 'A',
      id: 'docs',
      className: 'nav',
      href: 'https://other.example/docs?token=secret#section'
    });
    const start = runtime.clock.now;
    clickTimes(runtime, link.inner, [start, start + 15, start + 30]);

    const rage = tracked(runtime, 'rage_click');
    assert.equal(rage.length, 1);
    assert.equal(rage[0].properties.tag, 'a');
    assert.equal(rage[0].properties.id, 'docs');
    assert.equal(rage[0].properties.classes, 'nav');
    assert.equal(rage[0].properties.href, 'https://other.example/docs');
    assert.equal(rage[0].properties.is_external, true);
    assert.equal(rage[0].properties.type, undefined);
    assert.doesNotMatch(JSON.stringify(rage[0].properties), /token=secret|#section/);
  });

  test('rage_click is not emitted when click tracking is off or the click is declarative', () => {
    const off = runTracker({ attrs: {} });
    const plain = makeControl();
    const start = off.clock.now;
    clickTimes(off, plain, [start, start + 10, start + 20]);
    assert.equal(tracked(off, 'rage_click').length, 0);
    assert.equal(tracked(off, '$click').length, 0);

    const runtime = runTracker();
    const declared = makeControl({ id: 'cta', declarative: true });
    clickTimes(runtime, declared, [start, start + 10, start + 20]);
    assert.equal(tracked(runtime, 'rage_click').length, 0);
    assert.equal(tracked(runtime, '$click').length, 0);
    assert.equal(tracked(runtime, 'cta_click').length, 3);
  });
});

describe('rage click tracker source', () => {
  test('source names the threshold, window, and event', () => {
    assert.match(trackerSource, /var RAGE_CLICK_THRESHOLD = 3;/);
    assert.match(trackerSource, /var RAGE_CLICK_WINDOW_MS = 1000;/);
    assert.match(trackerSource, /aa\.track\('rage_click'/);
    assert.match(trackerSource, /click_count/);
  });

  test('built tracker.js contains the rage_click event', () => {
    const built = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.match(built, /rage_click/);
    assert.match(built, /click_count/);
  });
});
