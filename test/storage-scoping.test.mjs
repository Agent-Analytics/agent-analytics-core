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
    key(index) { return Object.keys(store)[index] || null; },
    get length() { return Object.keys(store).length; },
    _store: store,
  };
}

function createThrowingStorage() {
  return {
    getItem() { throw new Error('storage denied'); },
    setItem() { throw new Error('storage denied'); },
    removeItem() { throw new Error('storage denied'); },
    key() { throw new Error('storage denied'); },
    get length() { throw new Error('storage denied'); },
  };
}

function createRemoveThrowingStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
    removeItem() { throw new Error('remove denied'); },
    key(index) { return Object.keys(store)[index] || null; },
    get length() { return Object.keys(store).length; },
    _store: store,
  };
}

function runTracker({
  token = 'tok_1',
  project = 'proj_1',
  href = 'https://example.com/pricing?utm_source=test&utm_campaign=spring',
  localStorage = createStorage(),
  sessionStorage = createStorage(),
  requireConsent = false,
  doNotTrackAttribute = false,
  navigatorDoNotTrack = '0',
  storageAccessCounter = null,
} = {}) {
  const sends = [];
  const listeners = {};
  const location = new URL(href);
  location.href = location.toString();

  const document = {
    currentScript: {
      src: 'https://cdn.example.com/tracker.js',
      dataset: { project, token },
      getAttribute(name) {
        if (name === 'data-require-consent' && requireConsent) return 'true';
        if (name === 'data-do-not-track' && doNotTrackAttribute) return 'true';
        return null;
      },
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
    history: { pushState() {}, replaceState() {} },
    navigator: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0',
      language: 'en-US',
      doNotTrack: navigatorDoNotTrack,
      sendBeacon: undefined,
    },
    screen: { width: 1440, height: 900 },
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
    Blob: class Blob {},
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
  if (storageAccessCounter) {
    Object.defineProperty(context, 'localStorage', {
      configurable: true,
      get() { storageAccessCounter.localStorage++; return localStorage; },
    });
    Object.defineProperty(context, 'sessionStorage', {
      configurable: true,
      get() { storageAccessCounter.sessionStorage++; return sessionStorage; },
    });
  } else {
    context.localStorage = localStorage;
    context.sessionStorage = sessionStorage;
  }
  vm.createContext(context);
  vm.runInContext(TRACKER_JS, context);
  return { context, sends, listeners, localStorage, sessionStorage };
}

function parseTrack(sends, event) {
  const hit = sends.find((send) => send.url.endsWith('/track') && JSON.parse(send.body).event === event);
  assert.ok(hit, `expected ${event} track send`);
  return JSON.parse(hit.body);
}

function flushHidden(env) {
  env.context.document.visibilityState = 'hidden';
  for (const fn of env.listeners.visibilitychange || []) fn();
}

const legacyKeys = ['aa_uid', 'aa_identified_uid', 'aa_consent', 'aa_utm', 'aa_ft', 'aa_sc', 'aa_fv', 'aa_sid', 'aa_last_activity'];

describe('project-scoped safe browser storage', () => {
  test('old global aa_* values are ignored and not migrated', () => {
    const local = createStorage({
      aa_uid: 'anon_legacy',
      aa_identified_uid: 'legacy_user',
      aa_consent: 'granted',
      aa_ft: JSON.stringify({ utm_source: 'legacy_ft' }),
      aa_sc: '42',
      aa_fv: String(Date.now() - 3 * 86400000),
    });
    const session = createStorage({
      aa_sid: 'sess_legacy',
      aa_last_activity: String(Date.now()),
      aa_utm: JSON.stringify({ utm_source: 'legacy_utm' }),
    });

    const env = runTracker({ localStorage: local, sessionStorage: session, href: 'https://example.com/no-utm' });
    env.context.window.aa.track('legacy_check');
    flushHidden(env);

    const payload = parseTrack(env.sends, 'legacy_check');
    assert.notEqual(payload.user_id, 'legacy_user');
    assert.notEqual(payload.user_id, 'anon_legacy');
    assert.notEqual(payload.session_id, 'sess_legacy');
    assert.equal(payload.properties.utm_source, undefined);
    assert.equal(payload.properties.first_utm_source, undefined);
    assert.equal(payload.properties.session_count, 1);

    assert.equal(local._store.aa_uid, 'anon_legacy');
    assert.equal(local._store.aa_identified_uid, 'legacy_user');
    assert.equal(local._store.aa_consent, 'granted');
    assert.equal(session._store.aa_sid, 'sess_legacy');
    for (const key of legacyKeys) {
      assert.equal(Object.keys(local._store).filter((k) => k === key).length <= 1, true);
      assert.equal(Object.keys(session._store).filter((k) => k === key).length <= 1, true);
    }
  });

  test('two project tokens on one origin isolate anonymous and identified ids', () => {
    const local = createStorage();
    const session = createStorage();

    const first = runTracker({ token: 'token_a', project: 'shared', localStorage: local, sessionStorage: session });
    first.context.window.aa.identify('user_a');
    first.context.window.aa.track('event_a');
    flushHidden(first);

    const second = runTracker({ token: 'token_b', project: 'shared', localStorage: local, sessionStorage: session });
    second.context.window.aa.track('event_b');
    flushHidden(second);

    const eventA = parseTrack(first.sends, 'event_a');
    const eventB = parseTrack(second.sends, 'event_b');
    assert.equal(eventA.user_id, 'user_a');
    assert.match(eventB.user_id, /^anon_/);
    assert.notEqual(eventB.user_id, 'user_a');
    assert.notEqual(eventA.session_id, eventB.session_id);

    const keys = Object.keys(local._store).concat(Object.keys(session._store));
    assert.ok(keys.some((key) => key.includes('token_a') && key.endsWith(':uid')));
    assert.ok(keys.some((key) => key.includes('token_a') && key.endsWith(':identified_uid')));
    assert.ok(keys.some((key) => key.includes('token_b') && key.endsWith(':uid')));
    assert.equal(keys.some((key) => key === 'aa_uid' || key === 'aa_identified_uid'), false);
  });

  test('storage scope encoding does not collide for punctuation variants', () => {
    const local = createStorage();
    const session = createStorage();

    for (const token of ['a:b', 'a/b', 'a_b']) {
      const env = runTracker({ token, project: 'shared', localStorage: local, sessionStorage: session });
      env.context.window.aa.track(`event_${token}`);
      flushHidden(env);
    }

    const uidKeys = Object.keys(local._store).filter((key) => key.endsWith(':uid'));
    assert.equal(new Set(uidKeys).size, 3);
    assert.equal(uidKeys.length, 3);
  });

  test('storage get/set/remove throwing does not break public methods and uses memory fallback', () => {
    let env;
    assert.doesNotThrow(() => {
      env = runTracker({
        localStorage: createThrowingStorage(),
        sessionStorage: createThrowingStorage(),
        requireConsent: true,
      });
    });

    assert.doesNotThrow(() => env.context.window.aa.requireConsent());
    assert.doesNotThrow(() => env.context.window.aa.track('pre_consent'));
    assert.doesNotThrow(() => env.context.window.aa.grantConsent());
    assert.doesNotThrow(() => env.context.window.aa.identify('throw_user'));
    assert.doesNotThrow(() => env.context.window.aa.track('post_consent'));
    assert.doesNotThrow(() => flushHidden(env));
    assert.doesNotThrow(() => env.context.window.aa.revokeConsent());

    const postConsent = parseTrack(env.sends, 'post_consent');
    assert.equal(postConsent.user_id, 'throw_user');
    assert.match(postConsent.session_id, /^sess_/);
  });

  test('revokeConsent tombstones consent if native removeItem throws but getItem still works', () => {
    const local = createRemoveThrowingStorage();
    const env = runTracker({ token: 'tok_remove', localStorage: local, requireConsent: true });

    env.context.window.aa.grantConsent();
    env.context.window.aa.revokeConsent();
    env.context.window.aa.requireConsent();
    env.context.window.aa.track('after_revoke');
    flushHidden(env);

    assert.equal(env.sends.some((send) => send.url.endsWith('/track') && JSON.parse(send.body).event === 'after_revoke'), false);
  });

  test('DNT early return does not access browser storage wrappers', () => {
    const storageAccessCounter = { localStorage: 0, sessionStorage: 0 };
    const env = runTracker({
      doNotTrackAttribute: true,
      navigatorDoNotTrack: '1',
      storageAccessCounter,
    });

    assert.equal(storageAccessCounter.localStorage, 0);
    assert.equal(storageAccessCounter.sessionStorage, 0);
    assert.ok(env.context.window.aa);
    assert.doesNotThrow(() => env.context.window.aa.track('dnt_noop'));
    assert.equal(env.context.window.aa.experiment('dnt_experiment'), null);
    assert.deepEqual(env.sends, []);
  });

  test('consent, UTM, first-touch, and session metadata use scoped keys only', () => {
    const local = createStorage();
    const session = createStorage();
    const env = runTracker({ token: 'tok_scoped', project: 'proj_scoped', localStorage: local, sessionStorage: session, requireConsent: true });

    env.context.window.aa.grantConsent();
    env.context.window.aa.track('scoped_check');
    flushHidden(env);

    for (const key of legacyKeys) {
      assert.equal(Object.prototype.hasOwnProperty.call(local._store, key), false, `${key} should not be in localStorage`);
      assert.equal(Object.prototype.hasOwnProperty.call(session._store, key), false, `${key} should not be in sessionStorage`);
    }

    const localKeys = Object.keys(local._store);
    const sessionKeys = Object.keys(session._store);
    assert.ok(localKeys.includes('aa:tok_scoped:consent'));
    assert.ok(localKeys.includes('aa:tok_scoped:ft'));
    assert.ok(localKeys.includes('aa:tok_scoped:sc'));
    assert.ok(localKeys.includes('aa:tok_scoped:fv'));
    assert.ok(sessionKeys.includes('aa:tok_scoped:utm'));
    assert.ok(sessionKeys.includes('aa:tok_scoped:sid'));
    assert.ok(sessionKeys.includes('aa:tok_scoped:last_activity'));

    const payload = parseTrack(env.sends, 'scoped_check');
    assert.equal(payload.properties.utm_source, 'test');
    assert.equal(payload.properties.first_utm_source, 'test');
    assert.equal(payload.properties.session_count, 1);
  });
});
