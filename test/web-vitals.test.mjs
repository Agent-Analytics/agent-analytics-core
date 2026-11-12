import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import vm from 'node:vm';
import { TRACKER_JS } from '../src/tracker.js';

/**
 * These tests execute the real minified tracker (src/tracker.js), not a
 * reimplementation. PerformanceObserver, document, and visibility are fakes.
 */

function createStorage() {
  const store = {};
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
    removeItem(key) { delete store[key]; },
  };
}

function classListOf(names) {
  const list = { length: names.length };
  names.forEach((name, index) => { list[index] = name; });
  return list;
}

function el(tag, { id = '', classes = [], parent = null, text = 'do-not-collect-this-text' } = {}) {
  return {
    nodeType: 1,
    nodeName: tag,
    id,
    classList: classListOf(classes),
    parentNode: parent,
    textContent: text,
  };
}

const docNode = { nodeType: 9, nodeName: '#document' };

function shift(value, startTime, node, { hadRecentInput = false } = {}) {
  return {
    value,
    startTime,
    hadRecentInput,
    sources: node ? [{ node }] : [],
  };
}

function runTracker(options = {}) {
  const sends = [];
  const listeners = { document: {}, window: {} };
  const observers = [];
  const attrs = options.attrs || { 'data-track-vitals': 'true' };
  const buffered = options.buffered || {};
  const location = new URL(options.href || 'https://example.com/start');

  function setLocation(url) {
    const next = new URL(url, location.href);
    location.href = next.href;
    location.pathname = next.pathname;
    location.search = next.search;
    location.hash = next.hash;
  }

  function pushState(_state, _title, url) {
    if (url !== undefined && url !== null) setLocation(url);
  }
  function replaceState(_state, _title, url) {
    if (url !== undefined && url !== null) setLocation(url);
  }

  class PerformanceObserver {
    constructor(callback) {
      this.callback = callback;
      this.type = '';
      this.opts = null;
      this._records = [];
      observers.push(this);
    }

    observe(opts) {
      this.opts = opts || {};
      this.type = this.opts.type || '';
      if ((options.failObserve || []).includes(this.type)) {
        throw new Error('unsupported ' + this.type);
      }
      const initial = buffered[this.type];
      if (this.opts.buffered && initial && initial.length) {
        const entries = initial.slice();
        this.callback({ getEntries() { return entries; } });
      }
    }

    takeRecords() {
      return this._records.splice(0, this._records.length);
    }

    disconnect() {}
  }
  PerformanceObserver.supportedEntryTypes = options.supportedEntryTypes
    || ['layout-shift', 'largest-contentful-paint', 'paint', 'event', 'navigation'];

  const performance = {
    now() { return options.now || 0; },
    getEntriesByType(type) {
      if (type === 'navigation') return options.navigation ? [options.navigation] : [];
      if (type === 'visibility-state') return options.visibilityEntries || [];
      return [];
    },
  };

  const document = {
    title: 'Start',
    referrer: '',
    visibilityState: options.visibility || 'visible',
    readyState: options.readyState || 'complete',
    documentElement: { classList: { remove() {} }, clientHeight: 800 },
    body: { scrollHeight: 0, offsetHeight: 0, clientHeight: 0 },
    currentScript: {
      src: 'https://cdn.example.com/tracker.js',
      dataset: { project: 'proj', token: 'tok' },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      },
    },
    addEventListener(type, handler) {
      (listeners.document[type] ||= []).push(handler);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };

  const context = {
    window: null,
    document,
    location,
    history: { pushState, replaceState },
    navigator: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0',
      language: 'en-US',
      doNotTrack: '0',
      sendBeacon: undefined,
    },
    screen: { width: 1440, height: 900 },
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    performance,
    PerformanceObserver,
    URL,
    URLSearchParams,
    Intl,
    Math,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Promise,
    setTimeout(fn) { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    fetch(url, init = {}) {
      const target = String(url);
      if (target.includes('/experiments/config')) {
        return Promise.resolve({ json: async () => ({ experiments: [] }) });
      }
      sends.push({ url: target, body: String(init.body || '') });
      return Promise.resolve({ ok: true });
    },
    console,
    addEventListener(type, handler) {
      (listeners.window[type] ||= []).push(handler);
    },
    removeEventListener() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(TRACKER_JS, context, { filename: 'tracker.js' });

  return { context, sends, listeners, observers, document, location, setLocation };
}

function fire(listeners, scope, type, event) {
  for (const handler of (listeners[scope][type] || []).slice()) handler(event || {});
}

function hide(runtime, timeStamp = 1000) {
  runtime.document.visibilityState = 'hidden';
  fire(runtime.listeners, 'document', 'visibilitychange', { type: 'visibilitychange', timeStamp });
}

function show(runtime, timeStamp = 2000) {
  runtime.document.visibilityState = 'visible';
  fire(runtime.listeners, 'document', 'visibilitychange', { type: 'visibilitychange', timeStamp });
}

function pagehide(runtime, timeStamp = 1000) {
  fire(runtime.listeners, 'window', 'pagehide', { type: 'pagehide', timeStamp, persisted: false });
}

function pageshow(runtime, persisted) {
  fire(runtime.listeners, 'window', 'pageshow', { type: 'pageshow', persisted: !!persisted, timeStamp: 5 });
}

function emit(runtime, type, entries) {
  for (const observer of runtime.observers) {
    if (observer.type === type) observer.callback({ getEntries() { return entries; } });
  }
}

function parsedEvents(runtime) {
  const events = [];
  for (const send of runtime.sends) {
    const body = JSON.parse(send.body);
    if (Array.isArray(body.events)) events.push(...body.events);
    else events.push(body);
  }
  return events;
}

function vitals(runtime) {
  return parsedEvents(runtime).filter((event) => event.event === '$web_vitals').map((event) => event.properties);
}

function latest(runtime) {
  const rows = vitals(runtime);
  assert.ok(rows.length > 0, 'expected a $web_vitals event');
  return rows.at(-1);
}

describe('built tracker artifact', () => {
  test('tests execute the minified tracker build', () => {
    assert.match(TRACKER_JS, /^\/\*! Agent Analytics tracker/);
    assert.equal(TRACKER_JS.includes('function cwvFlush'), false);
    assert.equal(TRACKER_JS.includes('$web_vitals'), true);
    assert.equal(TRACKER_JS.includes('data-track-vitals'), true);
    assert.equal(TRACKER_JS.includes('cwv_lcp'), true);
    assert.equal(TRACKER_JS.includes('cwv_cls'), true);
    assert.equal(TRACKER_JS.includes('cwv_inp'), true);
    assert.equal(TRACKER_JS.includes('cwv_fcp'), true);
    assert.equal(TRACKER_JS.includes('cwv_ttfb'), true);
    assert.equal(TRACKER_JS.includes('cwv_lcp_target'), true);
    assert.equal(TRACKER_JS.includes('cwv_inp_target'), true);
    assert.equal(TRACKER_JS.includes('cwv_cls_target'), true);
    assert.equal(TRACKER_JS.includes('layout-shift'), true);
    assert.equal(TRACKER_JS.includes('0.98'), false);
  });
});

describe('CLS session windows', () => {
  test('sums shifts in one window and rounds to 3 decimals', () => {
    const runtime = runTracker();
    emit(runtime, 'layout-shift', [
      shift(0.1, 0, null),
      shift(0.05, 400, null),
      shift(0.1234567, 800, null),
    ]);
    hide(runtime);
    assert.equal(latest(runtime).cwv_cls, 0.273);
  });

  test('keeps the largest session window when a gap reaches 1s', () => {
    const runtime = runTracker();
    emit(runtime, 'layout-shift', [
      shift(0.2, 0, null),
      shift(0.2, 999, null),
      shift(0.3, 999 + 1000, null),
    ]);
    hide(runtime);
    assert.equal(latest(runtime).cwv_cls, 0.4);
  });

  test('starts a new window at a gap of exactly 1s and at 5s from the first shift', () => {
    const gap = runTracker();
    emit(gap, 'layout-shift', [shift(0.2, 0, null), shift(0.3, 1000, null)]);
    hide(gap);
    assert.equal(latest(gap).cwv_cls, 0.3);

    const within = runTracker();
    emit(within, 'layout-shift', [
      shift(0.05, 0, null),
      shift(0.05, 900, null),
      shift(0.05, 1800, null),
      shift(0.05, 2700, null),
      shift(0.05, 3600, null),
      shift(0.05, 4500, null),
    ]);
    hide(within);
    assert.equal(latest(within).cwv_cls, 0.3);

    const maxed = runTracker();
    emit(maxed, 'layout-shift', [
      shift(0.05, 0, null),
      shift(0.05, 900, null),
      shift(0.05, 1800, null),
      shift(0.05, 2700, null),
      shift(0.05, 3600, null),
      shift(0.05, 4500, null),
      shift(0.01, 5400, null),
    ]);
    hide(maxed);
    assert.equal(latest(maxed).cwv_cls, 0.3);
  });

  test('ignores hadRecentInput and does not let it split a window', () => {
    const runtime = runTracker();
    emit(runtime, 'layout-shift', [
      shift(0.1, 0, null),
      shift(0.8, 500, null, { hadRecentInput: true }),
      shift(0.1, 900, null),
    ]);
    hide(runtime);
    assert.equal(latest(runtime).cwv_cls, 0.2);
  });

  test('reports 0 when layout-shift is supported and nothing shifted', () => {
    const runtime = runTracker();
    hide(runtime);
    const props = latest(runtime);
    assert.equal(props.cwv_cls, 0);
    assert.equal(Object.hasOwn(props, 'cwv_lcp'), false);
    assert.equal(Object.hasOwn(props, 'cwv_inp'), false);
  });

  test('omits cwv_cls when layout-shift is not a supported entry type', () => {
    const runtime = runTracker({
      supportedEntryTypes: ['largest-contentful-paint', 'paint', 'event'],
      navigation: { responseStart: 80, activationStart: 0 },
    });
    emit(runtime, 'largest-contentful-paint', [{ startTime: 200 }]);
    hide(runtime);
    const props = latest(runtime);
    assert.equal(props.cwv_lcp, 200);
    assert.equal(props.cwv_ttfb, 80);
    assert.equal(Object.hasOwn(props, 'cwv_cls'), false);
    assert.equal(Object.hasOwn(props, 'cwv_cls_target'), false);
    assert.equal(runtime.observers.some((observer) => observer.type === 'layout-shift'), false);
  });

  test('omits cwv_cls when the layout-shift observer cannot start', () => {
    const runtime = runTracker({
      failObserve: ['layout-shift'],
      navigation: { responseStart: 40, activationStart: 0 },
    });
    hide(runtime);
    const props = latest(runtime);
    assert.equal(props.cwv_ttfb, 40);
    assert.equal(Object.hasOwn(props, 'cwv_cls'), false);
  });

  test('includes shifts that are only available from takeRecords at flush', () => {
    const runtime = runTracker();
    const observer = runtime.observers.find((item) => item.type === 'layout-shift');
    observer._records.push(shift(0.15, 20, null));
    hide(runtime);
    assert.equal(latest(runtime).cwv_cls, 0.15);
  });
});

describe('INP grouping and 1-per-50', () => {
  test('groups entries by interactionId and uses the max duration', () => {
    const button = el('BUTTON', { id: 'save' });
    const runtime = runTracker();
    emit(runtime, 'event', [
      { interactionId: 7, duration: 10, target: el('BUTTON', { id: 'other' }) },
      { interactionId: 7, duration: 80.4, target: button },
      { interactionId: 7, duration: 25, target: el('BUTTON', { id: 'late' }) },
      { interactionId: 8, duration: 40, target: el('A', { id: 'nav' }) },
      { interactionId: 0, duration: 500, target: el('DIV', { id: 'zero' }) },
      { duration: 400, target: el('DIV', { id: 'missing' }) },
    ]);
    hide(runtime);
    const props = latest(runtime);
    assert.equal(props.cwv_inp, 80);
    assert.equal(props.cwv_inp_target, '#save');
  });

  test('reports the worst interaction below 50 and drops one highest per 50', () => {
    function interactions(count) {
      const entries = [];
      for (let i = 1; i <= count; i++) entries.push({ interactionId: i, duration: i });
      return entries;
    }

    const under = runTracker();
    emit(under, 'event', interactions(49));
    hide(under);
    assert.equal(latest(under).cwv_inp, 49);

    const fifty = runTracker();
    emit(fifty, 'event', interactions(50));
    hide(fifty);
    assert.equal(latest(fifty).cwv_inp, 49);

    const hundred = runTracker();
    emit(hundred, 'event', interactions(100));
    hide(hundred);
    assert.equal(latest(hundred).cwv_inp, 98);
  });

  test('the dropped outlier does not supply the INP target', () => {
    const runtime = runTracker();
    const entries = [{ interactionId: 1, duration: 900, target: el('DIV', { id: 'outlier' }) }];
    for (let i = 2; i <= 50; i++) {
      entries.push({
        interactionId: i,
        duration: i === 2 ? 400 : 10,
        target: el('BUTTON', { id: i === 2 ? 'kept' : 'small' }),
      });
    }
    emit(runtime, 'event', entries);
    hide(runtime);
    const props = latest(runtime);
    assert.equal(props.cwv_inp, 400);
    assert.equal(props.cwv_inp_target, '#kept');
  });

  test('omits cwv_inp when no interaction was observed', () => {
    const runtime = runTracker();
    emit(runtime, 'largest-contentful-paint', [{ startTime: 100 }]);
    hide(runtime);
    assert.equal(Object.hasOwn(latest(runtime), 'cwv_inp'), false);
  });

  test('observes event entries with the existing duration threshold', () => {
    const runtime = runTracker();
    const observer = runtime.observers.find((item) => item.type === 'event');
    assert.equal(observer.opts.buffered, true);
    assert.equal(observer.opts.durationThreshold, 16);
  });
});

describe('LCP and FCP hidden exclusion', () => {
  test('keeps paints that happen before the page is hidden and rounds to ms', () => {
    const runtime = runTracker();
    emit(runtime, 'largest-contentful-paint', [{ startTime: 100 }, { startTime: 1234.5 }]);
    emit(runtime, 'paint', [
      { name: 'first-paint', startTime: 10 },
      { name: 'first-contentful-paint', startTime: 80.4 },
    ]);
    hide(runtime, 2000);
    const props = latest(runtime);
    assert.equal(props.cwv_lcp, 1235);
    assert.equal(props.cwv_fcp, 80);
  });

  test('ignores LCP and FCP when the page was hidden before those paints', () => {
    const runtime = runTracker({ navigation: { responseStart: 55, activationStart: 0 } });
    hide(runtime, 20);
    emit(runtime, 'largest-contentful-paint', [{ startTime: 100 }]);
    emit(runtime, 'paint', [{ name: 'first-contentful-paint', startTime: 80 }]);
    pagehide(runtime, 120);
    const props = latest(runtime);
    assert.equal(props.cwv_ttfb, 55);
    assert.equal(Object.hasOwn(props, 'cwv_lcp'), false);
    assert.equal(Object.hasOwn(props, 'cwv_fcp'), false);
  });

  test('ignores buffered paints when the document is already hidden', () => {
    const runtime = runTracker({
      visibility: 'hidden',
      navigation: { responseStart: 30, activationStart: 0 },
      buffered: {
        'largest-contentful-paint': [{ startTime: 400 }],
        paint: [{ name: 'first-contentful-paint', startTime: 120 }],
      },
    });
    pagehide(runtime, 500);
    const props = latest(runtime);
    assert.equal(props.cwv_ttfb, 30);
    assert.equal(Object.hasOwn(props, 'cwv_lcp'), false);
    assert.equal(Object.hasOwn(props, 'cwv_fcp'), false);
  });

  test('uses a visibility-state hidden entry that happened before the tracker ran', () => {
    const runtime = runTracker({
      visibilityEntries: [{ name: 'hidden', startTime: 30 }],
      navigation: { responseStart: 10, activationStart: 0 },
    });
    emit(runtime, 'paint', [{ name: 'first-contentful-paint', startTime: 10 }]);
    emit(runtime, 'largest-contentful-paint', [{ startTime: 100 }]);
    hide(runtime, 200);
    const props = latest(runtime);
    assert.equal(props.cwv_fcp, 10);
    assert.equal(Object.hasOwn(props, 'cwv_lcp'), false);
  });

  test('keeps the last LCP from before hide and ignores a later candidate', () => {
    const runtime = runTracker();
    emit(runtime, 'largest-contentful-paint', [{ startTime: 180.2 }]);
    hide(runtime, 400);
    show(runtime, 450);
    emit(runtime, 'largest-contentful-paint', [{ startTime: 900 }]);
    hide(runtime, 1000);
    const rows = vitals(runtime);
    assert.equal(rows.at(-1).cwv_lcp, 180);
    assert.ok(rows.every((row) => row.cwv_lcp === 180));
  });
});

describe('TTFB', () => {
  test('subtracts activationStart from responseStart and rounds to ms', () => {
    const runtime = runTracker({
      navigation: { responseStart: 180.4, activationStart: 30.2, requestStart: 45.5 },
    });
    hide(runtime);
    assert.equal(latest(runtime).cwv_ttfb, 150);
  });

  test('treats a missing or non-positive activationStart as 0', () => {
    const missing = runTracker({ navigation: { responseStart: 90.2, requestStart: 10 } });
    hide(missing);
    assert.equal(latest(missing).cwv_ttfb, 90);

    const zero = runTracker({ navigation: { responseStart: 90.2, activationStart: 0 } });
    hide(zero);
    assert.equal(latest(zero).cwv_ttfb, 90);

    const negative = runTracker({ navigation: { responseStart: 100, activationStart: -5 } });
    hide(negative);
    assert.equal(latest(negative).cwv_ttfb, 100);
  });

  test('clamps at 0 when activationStart is after responseStart', () => {
    const runtime = runTracker({ navigation: { responseStart: 50, activationStart: 80 } });
    hide(runtime);
    assert.equal(latest(runtime).cwv_ttfb, 0);
  });

  test('omits cwv_ttfb when there is no navigation entry', () => {
    const runtime = runTracker();
    emit(runtime, 'largest-contentful-paint', [{ startTime: 100 }]);
    hide(runtime);
    assert.equal(Object.hasOwn(latest(runtime), 'cwv_ttfb'), false);
  });

  test('leaves perf_ttfb on $performance as responseStart minus requestStart', () => {
    const runtime = runTracker({
      attrs: { 'data-track-vitals': 'true', 'data-track-performance': 'true' },
      navigation: {
        domainLookupStart: 5,
        domainLookupEnd: 18,
        connectStart: 18,
        connectEnd: 45,
        requestStart: 45.5,
        responseStart: 120.8,
        activationStart: 20,
        domInteractive: 450,
        domComplete: 980,
        loadEventEnd: 1002,
      },
    });
    hide(runtime);
    const perf = parsedEvents(runtime).find((event) => event.event === '$performance');
    assert.equal(perf.properties.perf_ttfb, 75);
    assert.equal(Object.hasOwn(perf.properties, 'cwv_ttfb'), false);
    assert.equal(latest(runtime).cwv_ttfb, 101);
  });
});

describe('attribution selectors', () => {
  test('uses an id selector and does not include text', () => {
    const runtime = runTracker();
    const target = el('DIV', { id: 'hero', text: 'secret user@example.com' });
    emit(runtime, 'largest-contentful-paint', [{ startTime: 210, element: target }]);
    hide(runtime);
    const props = latest(runtime);
    assert.equal(props.cwv_lcp_target, '#hero');
    assert.equal(props.cwv_lcp_target.includes('secret'), false);
    assert.equal(props.cwv_lcp_target.includes('user@'), false);
    assert.equal(props.cwv_lcp_target.includes('DIV'), false);
  });

  test('sorts classes and walks ancestors until an id', () => {
    const runtime = runTracker();
    const parent = el('DIV', { id: 'main', parent: docNode });
    const child = el('SPAN', { classes: ['title', 'zeta'], parent });
    emit(runtime, 'largest-contentful-paint', [{ startTime: 50, element: child }]);
    hide(runtime);
    assert.equal(latest(runtime).cwv_lcp_target, '#main>span.title.zeta');
  });

  test('falls back to the LCP id when the element is gone', () => {
    const runtime = runTracker();
    emit(runtime, 'largest-contentful-paint', [{ startTime: 50, id: 'poster' }]);
    hide(runtime);
    assert.equal(latest(runtime).cwv_lcp_target, '#poster');
  });

  test('truncates selectors at 200 characters', () => {
    const runtime = runTracker();
    emit(runtime, 'largest-contentful-paint', [{ startTime: 50, element: el('DIV', { id: 'a'.repeat(250) }) }]);
    hide(runtime);
    const target = latest(runtime).cwv_lcp_target;
    assert.equal(target.length, 200);
    assert.equal(target, '#' + 'a'.repeat(199));
  });

  test('drops URL ids and URL class tokens', () => {
    const byId = runTracker();
    emit(byId, 'largest-contentful-paint', [{
      startTime: 40,
      element: el('IMG', { id: 'https://cdn.example/hero.png', text: 'https://cdn.example/hero.png' }),
    }]);
    hide(byId);
    const idTarget = latest(byId).cwv_lcp_target;
    assert.equal(idTarget, 'img');
    assert.equal(idTarget.includes('http'), false);
    assert.equal(idTarget.includes('cdn.example'), false);

    const byClass = runTracker();
    emit(byClass, 'largest-contentful-paint', [{
      startTime: 40,
      element: el('DIV', { classes: ['ok', 'https://evil.test/x', 'url(https://evil.test/bg.png)'] }),
    }]);
    hide(byClass);
    const classTarget = latest(byClass).cwv_lcp_target;
    assert.equal(classTarget, 'div.ok');
    assert.equal(classTarget.includes('evil.test'), false);
    assert.equal(classTarget.includes('url('), false);
  });

  test('CLS target is the largest shift inside the winning session window', () => {
    const runtime = runTracker();
    const small = el('DIV', { id: 'small' });
    const mid = el('DIV', { id: 'mid' });
    const winner = el('P', { id: 'winner' });
    emit(runtime, 'layout-shift', [
      shift(0.04, 0, small),
      shift(0.01, 100, mid),
      shift(0.2, 2000, winner),
    ]);
    hide(runtime);
    const props = latest(runtime);
    assert.equal(props.cwv_cls, 0.2);
    assert.equal(props.cwv_cls_target, '#winner');
  });
});

describe('SPA path, hidden re-flush, and bfcache', () => {
  test('sends the path captured at the start of the view', () => {
    const runtime = runTracker({
      href: 'https://example.com/app/home',
      attrs: { 'data-track-vitals': 'true', 'data-track-spa': 'true' },
      navigation: { responseStart: 200, activationStart: 25 },
    });
    emit(runtime, 'largest-contentful-paint', [{ startTime: 800 }]);
    emit(runtime, 'paint', [{ name: 'first-contentful-paint', startTime: 120 }]);
    runtime.context.history.pushState({}, '', '/app/next');
    const first = vitals(runtime).at(-1);
    assert.equal(first.path, '/app/home');
    assert.equal(first.cwv_lcp, 800);
    assert.equal(first.cwv_fcp, 120);
    assert.equal(first.cwv_ttfb, 175);

    emit(runtime, 'layout-shift', [shift(0.11, 10, null)]);
    hide(runtime, 3000);
    const second = latest(runtime);
    assert.equal(second.path, '/app/next');
    assert.equal(second.cwv_cls, 0.11);
    assert.equal(Object.hasOwn(second, 'cwv_lcp'), false);
    assert.equal(Object.hasOwn(second, 'cwv_fcp'), false);
    assert.equal(Object.hasOwn(second, 'cwv_ttfb'), false);
  });

  test('re-flushes on a later hide only when values changed', () => {
    const runtime = runTracker();
    emit(runtime, 'layout-shift', [shift(0.1, 0, null)]);
    hide(runtime, 500);
    assert.equal(vitals(runtime).length, 1);
    assert.equal(latest(runtime).cwv_cls, 0.1);

    pagehide(runtime, 550);
    assert.equal(vitals(runtime).length, 1);

    show(runtime, 600);
    hide(runtime, 700);
    assert.equal(vitals(runtime).length, 1);

    show(runtime, 800);
    emit(runtime, 'layout-shift', [shift(0.2, 900, null)]);
    hide(runtime, 1200);
    assert.equal(vitals(runtime).length, 2);
    assert.equal(latest(runtime).cwv_cls, 0.3);
  });

  test('pagehide flushes while the document is still visible', () => {
    const runtime = runTracker();
    emit(runtime, 'largest-contentful-paint', [{ startTime: 140 }]);
    pagehide(runtime, 300);
    assert.equal(latest(runtime).cwv_lcp, 140);
    assert.equal(runtime.document.visibilityState, 'visible');
  });

  test('bfcache pageshow persisted restarts CLS and INP without the SPA flag', () => {
    const runtime = runTracker({ attrs: { 'data-track-vitals': 'true' } });
    const before = parsedEvents(runtime).filter((event) => event.event === 'page_view').length;
    emit(runtime, 'layout-shift', [shift(0.2, 1000, el('DIV', { id: 'old' }))]);
    emit(runtime, 'event', [{ interactionId: 1, duration: 300, target: el('BUTTON', { id: 'old' }) }]);
    hide(runtime, 1400);
    assert.equal(latest(runtime).cwv_cls, 0.2);
    assert.equal(latest(runtime).cwv_inp, 300);

    show(runtime, 1500);
    pageshow(runtime, true);
    emit(runtime, 'layout-shift', [shift(0.05, 1500, el('DIV', { id: 'new' }))]);
    emit(runtime, 'event', [{ interactionId: 2, duration: 40, target: el('BUTTON', { id: 'new' }) }]);
    hide(runtime, 1800);

    const props = latest(runtime);
    assert.equal(props.cwv_cls, 0.05);
    assert.equal(props.cwv_cls_target, '#new');
    assert.equal(props.cwv_inp, 40);
    assert.equal(props.cwv_inp_target, '#new');
    const pages = parsedEvents(runtime).filter((event) => event.event === 'page_view');
    assert.equal(pages.length, before);
  });
});

describe('vitals flag', () => {
  test('data-track-vitals=true sends $web_vitals and does not put cwv keys on page_view', () => {
    const runtime = runTracker({ attrs: { 'data-track-vitals': 'true' } });
    emit(runtime, 'largest-contentful-paint', [{ startTime: 90 }]);
    hide(runtime);
    const props = latest(runtime);
    assert.equal(props.cwv_lcp, 90);
    assert.equal(props.path, '/start');
    const page = parsedEvents(runtime).find((event) => event.event === 'page_view');
    assert.ok(page);
    assert.equal(Object.hasOwn(page.properties, 'cwv_lcp'), false);
    assert.equal(Object.hasOwn(page.properties, 'cwv_cls'), false);
  });

  test('data-track-vitals=false sends no vitals', () => {
    const runtime = runTracker({ attrs: { 'data-track-vitals': 'false' } });
    emit(runtime, 'largest-contentful-paint', [{ startTime: 90 }]);
    emit(runtime, 'layout-shift', [shift(0.2, 0, null)]);
    hide(runtime);
    pagehide(runtime);
    assert.equal(vitals(runtime).length, 0);
    assert.equal(runtime.observers.length, 0);
  });

  test('an absent data-track-vitals attribute sends no vitals', () => {
    const runtime = runTracker({ attrs: {} });
    hide(runtime);
    pagehide(runtime);
    assert.equal(vitals(runtime).length, 0);
  });

  test('only the exact true value turns vitals on', () => {
    const runtime = runTracker({ attrs: { 'data-track-vitals': 'TRUE' } });
    hide(runtime);
    assert.equal(vitals(runtime).length, 0);
  });
});
