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
    _store: store,
  };
}

function createTrackerContext() {
  const sends = [];
  const listeners = {};
  const location = new URL('https://example.com/pricing?utm_source=test');
  location.href = location.toString();

  const document = {
    currentScript: {
      src: 'https://cdn.example.com/tracker.js',
      dataset: { project: 'proj_1', token: 'tok_1' },
      getAttribute() { return null; },
    },
    visibilityState: 'visible',
    referrer: 'https://referrer.example/',
    title: 'Pricing',
    documentElement: { classList: { remove() {} } },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    querySelectorAll() { return []; },
  };

  const context = {
    window: null,
    document,
    location,
    addEventListener(type, fn) { (listeners[`window:${type}`] ||= []).push(fn); },
    removeEventListener() {},
    history: {
      pushState() {},
      replaceState() {},
    },
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
    setTimeout(fn) { if (typeof fn === 'function') fn(); return 1; },
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
  return { context, sends, listeners };
}

function parseSend(sends, path, predicate = () => true) {
  const hit = sends.find((send) => send.url.endsWith(path) && predicate(JSON.parse(send.body)));
  assert.ok(hit, `expected send to ${path}`);
  return JSON.parse(hit.body);
}

describe('browser tracker identity cleanup', () => {
  test('identify sends stable user_id with traits.email and no browser-side email_hash', () => {
    assert.equal(TRACKER_JS.includes('email_hash'), false, 'built tracker must not reference email_hash');
    assert.equal(TRACKER_JS.includes('SHA-256'), false, 'built tracker must not contain SHA-256 hashing code');
    assert.equal(TRACKER_JS.includes('crypto.subtle'), false, 'built tracker must not use browser crypto hashing');

    const { context, sends } = createTrackerContext();
    context.window.aa.identify('user_123', {
      email: ' USER@Example.COM ',
      name: 'User Example',
      email_hash: 'legacy-hash-must-drop',
      contactEmail: 'secondary@example.com',
    });

    const payload = parseSend(sends, '/identify');
    assert.equal(payload.token, 'tok_1');
    assert.match(payload.previous_id, /^anon_/);
    assert.equal(payload.user_id, 'user_123');
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'email_hash'), false);
    assert.deepEqual(payload.traits, {
      name: 'User Example',
      email: 'user@example.com',
    });
  });

  test('track and set payloads drop reserved email keys recursively', () => {
    const { context, sends, listeners } = createTrackerContext();
    context.window.aa.set({
      email: 'global@example.com',
      globalEmail: 'global2@example.com',
      plan: 'pro',
      nested: { email_hash: 'legacy', ok: true },
    });
    context.window.aa.track('signup', {
      email: 'event@example.com',
      email_hash: 'legacy',
      contactEmail: 'event2@example.com',
      nested: { email: 'nested@example.com', keep: 'yes' },
      array: [{ email: 'array@example.com', keep: 1 }],
      source: 'button',
    });

    context.document.visibilityState = 'hidden';
    for (const fn of listeners.visibilitychange || []) fn();

    const payload = parseSend(sends, '/track', (payload) => payload.event === 'signup');
    assert.equal(payload.event, 'signup');
    assert.equal(payload.properties.plan, 'pro');
    assert.equal(payload.properties.source, 'button');
    assert.equal(payload.properties.email, undefined);
    assert.equal(payload.properties.email_hash, undefined);
    assert.equal(payload.properties.contactEmail, undefined);
    assert.equal(payload.properties.globalEmail, undefined);
    assert.deepEqual(payload.properties.nested, { keep: 'yes' });
    assert.deepEqual(payload.properties.array, [{ keep: 1 }]);
  });
});
