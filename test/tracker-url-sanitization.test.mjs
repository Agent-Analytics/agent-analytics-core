import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const trackerSource = readFileSync(join(__dirname, '..', 'src', 'tracker.src.js'), 'utf-8');

function createStorage() {
  const store = new Map();
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
    clear() { store.clear(); }
  };
}

function runTracker({
  href = 'https://example.com/private/path?token=secret&utm_source=google&utm_medium=cpc&utm_campaign=spring&utm_content=ad&utm_term=shoes#frag',
  referrer = 'https://ref.example/search?q=secret&email=user@example.com#results',
  attrs = {},
  querySelector = () => null,
  performanceEntries = []
} = {}) {
  const url = new URL(href);
  const events = { document: {}, window: {} };
  const beacons = [];
  const scriptAttrs = new Map(Object.entries(attrs));
  const context = {
    URL,
    URLSearchParams,
    Blob: class Blob {
      constructor(parts, options) { this.parts = parts; this.options = options; }
      text() { return Promise.resolve(this.parts.join('')); }
    },
    console: { log() {} },
    Math,
    Date,
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
    performance: { getEntriesByType() { return performanceEntries; } },
    fetch() { return Promise.resolve({ ok: true, json: () => Promise.resolve({ experiments: [] }) }); }
  };
  const document = {
    title: 'Sensitive Page',
    referrer,
    visibilityState: 'visible',
    readyState: 'complete',
    documentElement: { classList: { remove() {} } },
    currentScript: {
      src: 'https://cdn.example/tracker.js',
      dataset: { project: 'proj', token: 'tok' },
      getAttribute(name) { return scriptAttrs.get(name) || null; }
    },
    addEventListener(type, handler) { events.document[type] = events.document[type] || []; events.document[type].push(handler); },
    querySelector,
    querySelectorAll() { return []; }
  };
  context.document = document;
  context.window = {
    addEventListener(type, handler) { events.window[type] = events.window[type] || []; events.window[type].push(handler); }
  };
  context.window.window = context.window;
  context.window.document = document;
  context.window.navigator = context.navigator;
  context.window.location = context.location;
  context.window.localStorage = context.localStorage;
  context.window.sessionStorage = context.sessionStorage;

  vm.createContext(context);
  vm.runInContext(trackerSource, context, { filename: 'tracker.src.js' });

  function flush() {
    for (const handler of events.window.beforeunload || []) handler();
    return beacons.map((entry) => JSON.parse(entry.body));
  }

  return { context, events, beacons, flush };
}

function flushedEvents(runtime) {
  return runtime.flush().flatMap((payload) => payload.events || [payload]);
}

function lastPayload(runtime, eventName) {
  const flushed = flushedEvents(runtime);
  assert.ok(flushed.length > 0, 'expected at least one flushed payload');
  const matches = eventName ? flushed.filter((payload) => payload.event === eventName) : flushed;
  assert.ok(matches.length > 0, `expected flushed payload for ${eventName || 'any event'}`);
  return matches.at(-1);
}

function makeAnchor(href, text = 'Go', attrs = {}) {
  return {
    href,
    textContent: text,
    id: '',
    className: '',
    tagName: 'A',
    getAttribute(name) { return attrs[name] || null; },
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    closest(selector) {
      if (selector === '[data-aa-event]') return attrs['data-aa-event'] ? this : null;
      return selector === 'a' || selector === 'a, button' ? this : null;
    }
  };
}

function makeForm(action, extra = {}) {
  return {
    tagName: 'FORM',
    id: 'lead',
    action,
    method: 'post',
    className: '',
    elements: extra.elements || [],
    getAttribute(name) { return name === 'name' ? 'lead-form' : null; },
    hasAttribute(name) { return name === 'novalidate'; },
    checkValidity() { return true; }
  };
}

describe('tracker URL/referrer sanitization contract', () => {
  test('page payload sends origin/path URL and sanitized referrer while preserving UTM allowlist', () => {
    const runtime = runTracker();
    runtime.context.window.aa.page();

    const payload = lastPayload(runtime, 'page_view');
    const props = payload.properties;

    assert.equal(payload.event, 'page_view');
    assert.equal(props.url, 'https://example.com/private/path');
    assert.equal(props.path, '/private/path');
    assert.equal(props.referrer, 'https://ref.example/search');
    assert.equal(props.utm_source, 'google');
    assert.equal(props.utm_medium, 'cpc');
    assert.equal(props.utm_campaign, 'spring');
    assert.equal(props.utm_content, 'ad');
    assert.equal(props.utm_term, 'shoes');
    assert.doesNotMatch(JSON.stringify(props), /token=secret|email=user@example\.com|#frag|#results|q=secret/);
  });

  test('outgoing link payload href omits query string and hash', () => {
    const runtime = runTracker({ attrs: { 'data-track-outgoing': 'true' } });
    const link = makeAnchor('https://other.example/landing?invite=secret#top', 'External');
    for (const handler of runtime.events.document.click || []) handler({ target: link });

    const payload = lastPayload(runtime, 'outgoing_link');
    assert.equal(payload.event, 'outgoing_link');
    assert.equal(payload.properties.href, 'https://other.example/landing');
    assert.doesNotMatch(JSON.stringify(payload.properties), /invite=secret|#top/);
  });

  test('outgoing link payload does not include visible text by default', () => {
    const runtime = runTracker({ attrs: { 'data-track-outgoing': 'true' } });
    const link = makeAnchor('https://other.example/pricing', 'Secret enterprise account');
    for (const handler of runtime.events.document.click || []) handler({ target: link });

    const payload = lastPayload(runtime, 'outgoing_link');
    assert.equal(payload.event, 'outgoing_link');
    assert.equal(payload.properties.text, undefined);
    assert.doesNotMatch(JSON.stringify(payload.properties), /Secret enterprise account/);
  });

  test('outgoing link tracking skips developer-authored data-aa-event elements', () => {
    const runtime = runTracker({ attrs: { 'data-track-outgoing': 'true' } });
    const link = makeAnchor('https://other.example/pricing', 'External', { 'data-aa-event': 'cta_click' });
    for (const handler of runtime.events.document.click || []) handler({ target: link });

    const flushed = flushedEvents(runtime);
    assert.equal(flushed.some((payload) => payload.event === 'outgoing_link'), false);
  });

  test('click tracking link href omits query string and hash', () => {
    const runtime = runTracker({ attrs: { 'data-track-clicks': 'true' } });
    const link = makeAnchor('https://example.com/account?session=secret#billing', 'Account');
    for (const handler of runtime.events.document.click || []) handler({ target: link });

    const payload = lastPayload(runtime, '$click');
    assert.equal(payload.event, '$click');
    assert.equal(payload.properties.href, 'https://example.com/account');
    assert.doesNotMatch(JSON.stringify(payload.properties), /session=secret|#billing/);
  });

  test('click tracking payload does not include visible text by default', () => {
    const runtime = runTracker({ attrs: { 'data-track-clicks': 'true' } });
    const button = {
      tagName: 'BUTTON',
      textContent: 'Delete private workspace',
      id: 'danger',
      className: 'btn',
      type: 'button',
      closest(selector) { return selector === 'a, button' ? this : null; }
    };
    for (const handler of runtime.events.document.click || []) handler({ target: button });

    const payload = lastPayload(runtime, '$click');
    assert.equal(payload.event, '$click');
    assert.equal(payload.properties.text, undefined);
    assert.doesNotMatch(JSON.stringify(payload.properties), /Delete private workspace/);
  });

  test('download href uses URL sanitizer and omits query string and hash', () => {
    const runtime = runTracker({ attrs: { 'data-track-downloads': 'true' } });
    const link = makeAnchor('https://cdn.example/reports/export.pdf?token=secret#download', 'Download');
    for (const handler of runtime.events.document.click || []) handler({ target: link });

    const payload = lastPayload(runtime, '$download');
    assert.equal(payload.event, '$download');
    assert.equal(payload.properties.href, 'https://cdn.example/reports/export.pdf');
    assert.doesNotMatch(JSON.stringify(payload.properties), /token=secret|#download/);
  });

  test('form submit action omits query string and hash', () => {
    const runtime = runTracker({ attrs: { 'data-track-forms': 'true' } });
    const form = makeForm('https://example.com/submit?csrf=secret#form');
    for (const handler of runtime.events.document.submit || []) handler({ target: form });

    const payload = lastPayload(runtime, '$form_submit');
    assert.equal(payload.event, '$form_submit');
    assert.equal(payload.properties.action, 'https://example.com/submit');
    assert.doesNotMatch(JSON.stringify(payload.properties), /csrf=secret|#form/);
  });

  test('form submit tracking remains metadata-only and does not read field values', () => {
    const runtime = runTracker({ attrs: { 'data-track-forms': 'true' } });
    const secretField = {};
    Object.defineProperty(secretField, 'value', {
      get() { throw new Error('form field value should not be read'); }
    });
    const form = makeForm('https://example.com/submit?csrf=secret#form', { elements: [secretField] });
    for (const handler of runtime.events.document.submit || []) handler({ target: form });

    const payload = lastPayload(runtime, '$form_submit');
    assert.equal(payload.event, '$form_submit');
    assert.equal(payload.properties.form_data, undefined);
    assert.equal(payload.properties.fields, undefined);
    assert.doesNotMatch(JSON.stringify(payload.properties), /csrf=secret|#form/);
  });

  test('404 payload referrer omits query string and hash', () => {
    const runtime = runTracker({
      attrs: { 'data-track-404': 'true' },
      querySelector: () => ({ content: '404' })
    });

    const payload = lastPayload(runtime, '$404');
    assert.equal(payload.event, '$404');
    assert.equal(payload.properties.referrer, 'https://ref.example/search');
    assert.doesNotMatch(JSON.stringify(payload.properties), /q=secret|email=user@example\.com|#results/);
  });
});
