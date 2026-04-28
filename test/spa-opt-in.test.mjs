import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { TRACKER_JS } from '../src/tracker.js';

function createStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
    removeItem(key) { delete store[key]; },
  };
}

function createTrackerContext({ trackSpa = false } = {}) {
  const sends = [];
  const listeners = {};
  const attrs = trackSpa ? { 'data-track-spa': 'true' } : {};
  const location = new URL('https://example.com/start?utm_source=test');

  function setLocation(url) {
    const next = new URL(url || location.href, location.href);
    location.href = next.href;
    location.protocol = next.protocol;
    location.username = next.username;
    location.password = next.password;
    location.host = next.host;
    location.hostname = next.hostname;
    location.port = next.port;
    location.pathname = next.pathname;
    location.search = next.search;
    location.hash = next.hash;
  }

  const document = {
    currentScript: {
      src: 'https://cdn.example.com/tracker.js',
      dataset: { project: 'proj_1', token: 'tok_1' },
      getAttribute(name) { return attrs[name] || null; },
    },
    visibilityState: 'visible',
    referrer: 'https://referrer.example/',
    title: 'Start',
    documentElement: { classList: { remove() {} } },
    addEventListener(type, fn) { (listeners[`document:${type}`] ||= []).push(fn); },
    querySelectorAll() { return []; },
  };

  function pushState(_state, _title, url) { if (url !== undefined && url !== null) setLocation(url); }
  function replaceState(_state, _title, url) { if (url !== undefined && url !== null) setLocation(url); }
  const originalPushState = pushState;
  const originalReplaceState = replaceState;

  const context = {
    window: null,
    document,
    location,
    addEventListener(type, fn) { (listeners[`window:${type}`] ||= []).push(fn); },
    removeEventListener() {},
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
    fetch(url, options = {}) {
      if (String(url).includes('/experiments/config')) {
        return Promise.resolve({ json: async () => ({ experiments: [] }) });
      }
      sends.push({ url: String(url), body: String(options.body || '') });
      return Promise.resolve({ ok: true });
    },
    console,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(TRACKER_JS, context);
  return { context, sends, listeners, originalPushState, originalReplaceState, setLocation };
}

function pageEvents(sends) {
  return sends
    .filter((send) => send.url.endsWith('/track'))
    .map((send) => JSON.parse(send.body))
    .filter((payload) => payload.event === 'page_view');
}

function fire(listeners, name, event = {}) {
  for (const fn of listeners[`window:${name}`] || []) fn(event);
}

describe('SPA route automation opt-in', () => {
  test('default load tracks the initial page view but does not patch history methods', () => {
    const { context, sends, originalPushState, originalReplaceState } = createTrackerContext();

    assert.equal(context.history.pushState, originalPushState);
    assert.equal(context.history.replaceState, originalReplaceState);
    assert.equal(pageEvents(sends).length, 1, 'initial page view remains enabled by default');
  });

  test('default popstate, hashchange, and bfcache restore do not send route page views', () => {
    const { sends, listeners, setLocation } = createTrackerContext();
    assert.equal(pageEvents(sends).length, 1);

    setLocation('/popstate-route');
    fire(listeners, 'popstate');
    setLocation('/popstate-route#hash-route');
    fire(listeners, 'hashchange');
    setLocation('/bfcache-route');
    fire(listeners, 'pageshow', { persisted: true });

    assert.equal(pageEvents(sends).length, 1, 'only initial page view should be sent without SPA opt-in');
  });

  test('data-track-spa=true wraps history and tracks pushState, replaceState, popstate, hashchange, and bfcache route views', () => {
    const { context, sends, listeners, originalPushState, originalReplaceState, setLocation } = createTrackerContext({ trackSpa: true });

    assert.notEqual(context.history.pushState, originalPushState);
    assert.notEqual(context.history.replaceState, originalReplaceState);
    assert.equal(pageEvents(sends).length, 1);

    context.history.pushState({}, '', '/pushed');
    context.history.replaceState({}, '', '/replaced');
    setLocation('/popped');
    fire(listeners, 'popstate');
    setLocation('/popped#hashed');
    fire(listeners, 'hashchange');
    setLocation('/restored');
    fire(listeners, 'pageshow', { persisted: true });

    const pages = pageEvents(sends);
    assert.equal(pages.length, 6);
    assert.deepEqual(pages.map((payload) => payload.properties.path), [
      '/start',
      '/pushed',
      '/replaced',
      '/popped',
      '/popped',
      '/restored',
    ]);
  });

  test('manual aa.page remains available when SPA automation is disabled', () => {
    const { context, sends, setLocation } = createTrackerContext();
    setLocation('/manual');

    context.window.aa.page('Manual Page');

    const pages = pageEvents(sends);
    assert.equal(pages.length, 2);
    assert.equal(pages[1].properties.page, 'Manual Page');
    assert.equal(pages[1].properties.path, '/manual');
  });
});
