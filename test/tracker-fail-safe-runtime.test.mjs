import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { TRACKER_JS } from '../src/tracker.js';

function createStorage(initial = {}, options = {}) {
  const store = { ...initial };
  return {
    getItem(key) {
      if (options.throwOnGet) throw new Error('storage get failed');
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      if (options.throwOnSet) throw new Error('storage set failed');
      store[key] = String(value);
    },
    removeItem(key) {
      if (options.throwOnRemove) throw new Error('storage remove failed');
      delete store[key];
    },
    _store: store,
  };
}

function createTrackerContext(options = {}) {
  const sends = [];
  const listeners = {};
  const location = new URL(options.url || 'https://example.com/pricing?utm_source=test');
  location.href = location.toString();
  const script = {
    src: 'https://cdn.example.com/tracker.js',
    dataset: { project: 'proj_1', token: 'tok_1' },
    getAttribute(name) {
      if (name === 'data-track-spa' && options.trackSpa) return 'true';
      return null;
    },
  };
  const document = {
    get currentScript() {
      if (options.throwCurrentScript) throw new Error('currentScript unavailable');
      return script;
    },
    visibilityState: 'visible',
    referrer: 'https://referrer.example/',
    title: 'Pricing',
    documentElement: { classList: { remove() {} } },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  const context = {
    window: null,
    document,
    location,
    addEventListener(type, fn) { (listeners[`window:${type}`] ||= []).push(fn); },
    removeEventListener() {},
    history: {
      pushState(_state, _title, url) {
        if (url) {
          const next = new URL(String(url), location.href);
          location.href = next.href;
          location.pathname = next.pathname;
          location.search = next.search;
          location.hash = next.hash;
        }
      },
      replaceState() {},
    },
    navigator: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0',
      language: 'en-US',
      doNotTrack: '0',
      sendBeacon: options.sendBeacon,
    },
    screen: { width: 1440, height: 900 },
    localStorage: createStorage(options.localStorage, options.localStorageOptions),
    sessionStorage: createStorage(options.sessionStorage, options.sessionStorageOptions),
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
    Blob,
    setTimeout(fn) { if (typeof fn === 'function') fn(); return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    fetch(url, fetchOptions = {}) {
      if (options.fetchThrows) throw new Error('network unavailable');
      if (String(url).includes('/experiments/config')) {
        return Promise.resolve({ json: async () => ({ experiments: [] }) });
      }
      sends.push({ url: String(url), body: String(fetchOptions.body || '') });
      if (options.fetchRejects) return Promise.reject(new Error('network rejected'));
      return Promise.resolve({ ok: true });
    },
    console,
  };
  context.window = context;
  vm.createContext(context);
  return { context, sends, listeners };
}

function loadTracker(runtime) {
  vm.runInContext(TRACKER_JS, runtime.context);
}

function flush(runtime) {
  runtime.context.document.visibilityState = 'hidden';
  for (const fn of runtime.listeners.visibilitychange || []) fn();
}

function sentEvents(runtime) {
  return runtime.sends
    .filter((send) => send.url.endsWith('/track'))
    .map((send) => JSON.parse(send.body));
}

describe('browser tracker fail-safe runtime', () => {
  test('initialization failure leaves a no-throw public API stub', () => {
    const runtime = createTrackerContext({ throwCurrentScript: true });
    assert.doesNotThrow(() => loadTracker(runtime));
    assert.ok(runtime.context.window.aa);
    for (const call of [
      () => runtime.context.window.aa.track('event', { ok: true }),
      () => runtime.context.window.aa.identify('user_1', { plan: 'pro' }),
      () => runtime.context.window.aa.page('Home'),
      () => runtime.context.window.aa.set({ plan: 'pro' }),
      () => runtime.context.window.aa.requireConsent(),
      () => runtime.context.window.aa.grantConsent(),
      () => runtime.context.window.aa.revokeConsent(),
    ]) {
      assert.doesNotThrow(call);
    }
    assert.equal(runtime.context.window.aa.experiment('hero', ['a', 'b']), null);
  });

  test('public methods swallow storage and network failures', () => {
    const runtime = createTrackerContext({
      fetchThrows: true,
      sendBeacon() { throw new Error('beacon failed'); },
      localStorageOptions: { throwOnSet: true },
      sessionStorageOptions: { throwOnSet: true },
    });
    assert.doesNotThrow(() => loadTracker(runtime));
    assert.doesNotThrow(() => runtime.context.window.aa.track('network_failure', { ok: true }));
    assert.doesNotThrow(() => runtime.context.window.aa.identify('user_1', { plan: 'pro' }));
    assert.doesNotThrow(() => runtime.context.window.aa.grantConsent());
  });

  test('circular properties do not throw and oversized payloads are bounded', () => {
    const runtime = createTrackerContext();
    loadTracker(runtime);
    const circular = { name: 'root', huge: 'x'.repeat(200_000) };
    circular.self = circular;
    assert.doesNotThrow(() => runtime.context.window.aa.track('bounded_payload', circular));
    flush(runtime);

    const payload = sentEvents(runtime).find((event) => event.event === 'bounded_payload');
    assert.ok(payload, 'expected bounded_payload track event');
    assert.equal(payload.properties.name, 'root');
    assert.equal(payload.properties.self, '[Circular]');
    assert.ok(payload.properties.huge.length <= 4096, 'huge strings should be truncated');
    assert.ok(JSON.stringify(payload).length <= 70_000, 'serialized payload should be bounded');
  });

  test('loading twice does not double-track initial page views or double-register SPA automation', () => {
    const runtime = createTrackerContext({ trackSpa: true });
    loadTracker(runtime);
    loadTracker(runtime);

    const initialPageViews = sentEvents(runtime).filter((event) => event.event === 'page_view');
    assert.equal(initialPageViews.length, 1);
    assert.equal((runtime.listeners['window:popstate'] || []).length, 1);
    assert.equal((runtime.listeners['window:hashchange'] || []).length, 1);

    runtime.context.history.pushState({}, '', '/next');
    flush(runtime);
    const pageViews = sentEvents(runtime).filter((event) => event.event === 'page_view');
    assert.equal(pageViews.length, 2);
  });
});
