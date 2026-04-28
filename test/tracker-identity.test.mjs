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

function createTrackerContext(options = {}) {
  const sends = [];
  const listeners = {};
  const location = new URL(options.url || 'https://example.com/pricing?utm_source=test');
  location.href = location.toString();
  const forms = options.forms || [];

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
    body: { textContent: options.bodyText || '' },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    querySelectorAll(selector) {
      if (selector === 'form') return forms;
      return [];
    },
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
    localStorage: createStorage(options.localStorage),
    sessionStorage: createStorage(options.sessionStorage),
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
  test('identify without traits sends no traits', () => {
    const { context, sends } = createTrackerContext();
    context.window.aa.identify('user_no_traits');

    const payload = parseSend(sends, '/identify');
    assert.equal(payload.user_id, 'user_no_traits');
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'traits'), false);
  });

  test('explicit identify email is normalized and only sent on identify', () => {
    const { context, sends, listeners } = createTrackerContext();
    context.window.aa.identify('user_email', { email: ' USER@Example.COM ' });
    context.window.aa.track('post_identify_event', { source: 'button' });
    context.document.visibilityState = 'hidden';
    for (const fn of listeners.visibilitychange || []) fn();

    const identifyPayload = parseSend(sends, '/identify');
    assert.deepEqual(identifyPayload.traits, { email: 'user@example.com' });

    const trackPayload = parseSend(sends, '/track', (payload) => payload.event === 'post_identify_event');
    assert.equal(JSON.stringify(trackPayload).includes('user@example.com'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(trackPayload.properties, 'email'), false);
  });

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

  test('does not infer or send emails from URL, DOM, forms, local storage, or session storage', () => {
    const form = {
      tagName: 'FORM',
      id: 'signup',
      action: 'https://example.com/signup?email=form@example.com',
      method: 'post',
      className: 'lead-form',
      getAttribute(name) { return name === 'name' ? 'newsletter' : null; },
      hasAttribute() { return true; },
      checkValidity() { return true; },
    };
    const { context, sends, listeners } = createTrackerContext({
      url: 'https://example.com/pricing?email=url@example.com&utm_source=test',
      bodyText: 'Contact dom@example.com for help',
      forms: [form],
      localStorage: {
        email: 'local@example.com',
        'aa:tok_1:email': 'scoped-local@example.com',
        'aa:tok_1:ft': JSON.stringify({ utm_source: 'stored', email: 'first-touch@example.com' }),
      },
      sessionStorage: {
        email: 'session@example.com',
        'aa:tok_1:utm': JSON.stringify({ utm_source: 'session', email: 'session-utm@example.com' }),
      },
    });

    context.window.aa.track('manual_event', { source: 'test' });
    for (const fn of listeners.submit || []) fn({ target: form });
    context.document.visibilityState = 'hidden';
    for (const fn of listeners.visibilitychange || []) fn();

    const serialized = sends.map((send) => send.body).join('\n');
    for (const email of [
      'url@example.com',
      'dom@example.com',
      'form@example.com',
      'local@example.com',
      'scoped-local@example.com',
      'first-touch@example.com',
      'session@example.com',
      'session-utm@example.com',
    ]) {
      assert.equal(serialized.includes(email), false, `must not send inferred ${email}`);
    }
  });
});
