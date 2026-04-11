import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * createConsentController — mirrors the consent management + queue/flush
 * logic in tracker.src.js. Uses a mock localStorage object.
 */
function createConsentController(requireAtInit, storage) {
  storage = storage || {};

  var consentRequired = !!requireAtInit;
  var consentGranted = consentRequired ? storage['aa_consent'] === 'granted' : false;

  var queue = [];
  var flushed = [];
  var flushRequests = [];
  var identifySent = [];
  var scheduleFlushCalls = 0;
  var MAX_BATCH_EVENTS = 100;

  function flush() {
    if (!queue.length || (consentRequired && !consentGranted)) return;
    var batch = queue.splice(0);
    while (batch.length) {
      var chunk = batch.splice(0, MAX_BATCH_EVENTS);
      flushed.push.apply(flushed, chunk);
      flushRequests.push({
        endpoint: chunk.length === 1 ? '/track' : '/track/batch',
        events: chunk
      });
    }
  }

  function scheduleFlush() {
    if (consentRequired && !consentGranted) return;
    scheduleFlushCalls++;
    // In real tracker, this sets a 5s timer that calls flush()
  }

  return {
    track: function(event, props) {
      queue.push({ event: event, properties: props || {} });
      scheduleFlush();
    },

    identify: function(id, previousId) {
      flush();
      if (previousId && previousId !== id && (!consentRequired || consentGranted)) {
        identifySent.push({ previous_id: previousId, user_id: id });
      }
    },

    flush: flush,

    requireConsent: function() {
      consentRequired = true;
      consentGranted = storage['aa_consent'] === 'granted';
    },

    grantConsent: function() {
      consentGranted = true;
      storage['aa_consent'] = 'granted';
      queue.push({ event: '$consent', properties: { action: 'granted' } });
      flush();
    },

    revokeConsent: function() {
      consentGranted = false;
      delete storage['aa_consent'];
      queue.length = 0;
    },

    // Test helpers
    getQueue: function() { return queue; },
    getFlushed: function() { return flushed; },
    getFlushRequests: function() { return flushRequests; },
    getIdentifySent: function() { return identifySent; },
    getScheduleFlushCalls: function() { return scheduleFlushCalls; },
    isConsentRequired: function() { return consentRequired; },
    isConsentGranted: function() { return consentGranted; }
  };
}

// --- Default (no consent required) ---

describe('consent not required (default)', () => {
  test('flush works normally', () => {
    const ctrl = createConsentController(false);
    ctrl.track('page_view', { path: '/' });
    ctrl.flush();
    assert.equal(ctrl.getFlushed().length, 1);
    assert.equal(ctrl.getFlushRequests().length, 1);
    assert.equal(ctrl.getFlushRequests()[0].endpoint, '/track');
    assert.equal(ctrl.getQueue().length, 0);
  });

  test('scheduleFlush is called on track', () => {
    const ctrl = createConsentController(false);
    ctrl.track('click', {});
    assert.equal(ctrl.getScheduleFlushCalls(), 1);
  });

  test('identify send works normally', () => {
    const ctrl = createConsentController(false);
    ctrl.identify('user_123', 'anon_abc');
    assert.equal(ctrl.getIdentifySent().length, 1);
  });
});

// --- Consent required, not yet granted ---

describe('consent required, not yet decided', () => {
  test('events buffer in queue', () => {
    const ctrl = createConsentController(true);
    ctrl.track('page_view', { path: '/' });
    ctrl.track('click', { button: 'cta' });
    assert.equal(ctrl.getQueue().length, 2);
    assert.equal(ctrl.getFlushed().length, 0);
  });

  test('flush is blocked', () => {
    const ctrl = createConsentController(true);
    ctrl.track('page_view', {});
    ctrl.flush();
    assert.equal(ctrl.getQueue().length, 1);
    assert.equal(ctrl.getFlushed().length, 0);
  });

  test('scheduleFlush is skipped', () => {
    const ctrl = createConsentController(true);
    ctrl.track('page_view', {});
    assert.equal(ctrl.getScheduleFlushCalls(), 0);
  });

  test('identify send is blocked', () => {
    const ctrl = createConsentController(true);
    ctrl.identify('user_123', 'anon_abc');
    assert.equal(ctrl.getIdentifySent().length, 0);
  });

  test('multiple events accumulate in buffer', () => {
    const ctrl = createConsentController(true);
    for (let i = 0; i < 10; i++) {
      ctrl.track('event_' + i, {});
    }
    assert.equal(ctrl.getQueue().length, 10);
    assert.equal(ctrl.getFlushed().length, 0);
  });
});

// --- grantConsent ---

describe('grantConsent()', () => {
  test('flushes buffered events plus $consent event', () => {
    const ctrl = createConsentController(true);
    ctrl.track('page_view', { path: '/' });
    ctrl.track('click', { button: 'cta' });
    assert.equal(ctrl.getFlushed().length, 0);

    ctrl.grantConsent();
    assert.equal(ctrl.getFlushed().length, 3); // 2 buffered + $consent
    assert.equal(ctrl.getQueue().length, 0);
    const consentEvent = ctrl.getFlushed().find(e => e.event === '$consent');
    assert.ok(consentEvent, 'should include $consent event');
    assert.equal(consentEvent.properties.action, 'granted');
  });

  test('sets localStorage', () => {
    const storage = {};
    const ctrl = createConsentController(true, storage);
    ctrl.grantConsent();
    assert.equal(storage['aa_consent'], 'granted');
  });

  test('subsequent events flush normally', () => {
    const ctrl = createConsentController(true);
    ctrl.grantConsent(); // flushes $consent
    ctrl.track('page_view', {});
    ctrl.flush();
    assert.equal(ctrl.getFlushed().length, 2); // $consent + page_view
  });

  test('scheduleFlush works after grant', () => {
    const ctrl = createConsentController(true);
    ctrl.grantConsent();
    ctrl.track('click', {});
    assert.equal(ctrl.getScheduleFlushCalls(), 1);
  });

  test('identify send works after grant', () => {
    const ctrl = createConsentController(true);
    ctrl.grantConsent();
    ctrl.identify('user_123', 'anon_abc');
    assert.equal(ctrl.getIdentifySent().length, 1);
  });

  test('grant with empty queue sends $consent event', () => {
    const storage = {};
    const ctrl = createConsentController(true, storage);
    ctrl.grantConsent();
    assert.equal(storage['aa_consent'], 'granted');
    assert.equal(ctrl.getFlushed().length, 1); // just $consent
    assert.equal(ctrl.getFlushed()[0].event, '$consent');
    assert.equal(ctrl.getFlushRequests()[0].endpoint, '/track');
  });

  test('grant flushes large consent buffers in batches of 100 or fewer', () => {
    const ctrl = createConsentController(true);
    for (let i = 0; i < 240; i++) {
      ctrl.track(`event_${i}`, { index: i });
    }

    ctrl.grantConsent();

    const requests = ctrl.getFlushRequests();
    assert.deepEqual(requests.map((request) => request.events.length), [100, 100, 41]);
    assert.ok(requests.every((request) => request.events.length <= 100));
    assert.ok(requests.every((request) => request.endpoint === '/track/batch'));
    assert.equal(ctrl.getFlushed().length, 241);
    assert.equal(ctrl.getFlushed().at(-1).event, '$consent');
    assert.equal(ctrl.getQueue().length, 0);
  });
});

// --- revokeConsent ---

describe('revokeConsent()', () => {
  test('clears buffered queue', () => {
    const ctrl = createConsentController(true);
    ctrl.track('page_view', {});
    ctrl.track('click', {});
    assert.equal(ctrl.getQueue().length, 2);

    ctrl.revokeConsent();
    assert.equal(ctrl.getQueue().length, 0);
  });

  test('removes localStorage', () => {
    const storage = { 'aa_consent': 'granted' };
    const ctrl = createConsentController(true, storage);
    ctrl.grantConsent();
    ctrl.revokeConsent();
    assert.equal(storage['aa_consent'], undefined);
  });

  test('new events after revoke still buffer', () => {
    const ctrl = createConsentController(true);
    ctrl.grantConsent(); // flushes $consent
    ctrl.revokeConsent();
    ctrl.track('page_view', {});
    assert.equal(ctrl.getQueue().length, 1);
    ctrl.flush();
    assert.equal(ctrl.getFlushed().length, 1); // only $consent from before revoke
    assert.equal(ctrl.getQueue().length, 1);
  });

  test('identify send blocked after revoke', () => {
    const ctrl = createConsentController(true);
    ctrl.grantConsent();
    ctrl.revokeConsent();
    ctrl.identify('user_123', 'anon_abc');
    assert.equal(ctrl.getIdentifySent().length, 0);
  });
});

// --- Grant → Revoke → Re-grant cycle ---

describe('consent lifecycle cycles', () => {
  test('grant then revoke then re-grant flushes new events', () => {
    const ctrl = createConsentController(true);
    ctrl.track('event_1', {});
    ctrl.grantConsent(); // flush event_1 + $consent
    assert.equal(ctrl.getFlushed().length, 2);

    ctrl.revokeConsent(); // clear queue
    ctrl.track('event_2', {});
    ctrl.track('event_3', {});
    assert.equal(ctrl.getQueue().length, 2);

    ctrl.grantConsent(); // flush event_2 + event_3 + $consent
    assert.equal(ctrl.getFlushed().length, 5); // 2 + 3
    assert.equal(ctrl.getQueue().length, 0);
  });

  test('multiple revoke cycles work', () => {
    const ctrl = createConsentController(true);
    for (let i = 0; i < 3; i++) {
      ctrl.track('event', {});
      ctrl.grantConsent(); // event + $consent = 2 per cycle
      ctrl.revokeConsent();
    }
    assert.equal(ctrl.getFlushed().length, 6); // 3 events + 3 $consent
    assert.equal(ctrl.getQueue().length, 0);
  });
});

// --- Prior consent (localStorage already set) ---

describe('prior consent from localStorage', () => {
  test('flush works immediately when prior consent exists', () => {
    const storage = { 'aa_consent': 'granted' };
    const ctrl = createConsentController(true, storage);
    ctrl.track('page_view', {});
    ctrl.flush();
    assert.equal(ctrl.getFlushed().length, 1);
  });

  test('scheduleFlush works with prior consent', () => {
    const storage = { 'aa_consent': 'granted' };
    const ctrl = createConsentController(true, storage);
    ctrl.track('page_view', {});
    assert.equal(ctrl.getScheduleFlushCalls(), 1);
  });

  test('identify works with prior consent', () => {
    const storage = { 'aa_consent': 'granted' };
    const ctrl = createConsentController(true, storage);
    ctrl.identify('user_123', 'anon_abc');
    assert.equal(ctrl.getIdentifySent().length, 1);
  });

  test('consentGranted is true on init with prior consent', () => {
    const storage = { 'aa_consent': 'granted' };
    const ctrl = createConsentController(true, storage);
    assert.equal(ctrl.isConsentGranted(), true);
  });
});

// --- requireConsent() programmatic ---

describe('aa.requireConsent() programmatic', () => {
  test('calling requireConsent after init blocks flush', () => {
    const ctrl = createConsentController(false);
    ctrl.track('page_view', {});
    ctrl.flush();
    assert.equal(ctrl.getFlushed().length, 1); // first flush works

    ctrl.requireConsent();
    ctrl.track('click', {});
    ctrl.flush();
    assert.equal(ctrl.getQueue().length, 1); // blocked
    assert.equal(ctrl.getFlushed().length, 1); // no new flushes
  });

  test('requireConsent checks localStorage for prior grant', () => {
    const storage = { 'aa_consent': 'granted' };
    const ctrl = createConsentController(false, storage);
    ctrl.requireConsent();
    ctrl.track('page_view', {});
    ctrl.flush();
    assert.equal(ctrl.getFlushed().length, 1); // works because localStorage has consent
  });

  test('requireConsent without prior grant enters buffer mode', () => {
    const ctrl = createConsentController(false);
    ctrl.requireConsent();
    ctrl.track('page_view', {});
    ctrl.flush();
    assert.equal(ctrl.getQueue().length, 1); // buffered
    assert.equal(ctrl.getFlushed().length, 0);
  });
});

// --- $consent event ---

describe('$consent event on grantConsent', () => {
  test('$consent event has action: granted', () => {
    const ctrl = createConsentController(true);
    ctrl.grantConsent();
    const consentEvent = ctrl.getFlushed().find(e => e.event === '$consent');
    assert.ok(consentEvent);
    assert.equal(consentEvent.properties.action, 'granted');
  });

  test('$consent event is last in flush (after buffered events)', () => {
    const ctrl = createConsentController(true);
    ctrl.track('page_view', {});
    ctrl.track('click', {});
    ctrl.grantConsent();
    const events = ctrl.getFlushed();
    assert.equal(events[events.length - 1].event, '$consent');
  });
});

// --- Build output checks ---

describe('consent management in built tracker', () => {
  const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');

  test('built tracker.js contains requireConsent method', () => {
    assert.ok(content.includes('requireConsent'), 'tracker.js should contain requireConsent');
  });

  test('built tracker.js contains grantConsent method', () => {
    assert.ok(content.includes('grantConsent'), 'tracker.js should contain grantConsent');
  });

  test('built tracker.js contains revokeConsent method', () => {
    assert.ok(content.includes('revokeConsent'), 'tracker.js should contain revokeConsent');
  });

  test('built tracker.js contains aa_consent localStorage key', () => {
    assert.ok(content.includes('aa_consent'), 'tracker.js should contain aa_consent');
  });

  test('built tracker.js contains data-require-consent attribute', () => {
    assert.ok(content.includes('data-require-consent'), 'tracker.js should contain data-require-consent');
  });

  test('built tracker.js contains localhost stubs for consent methods', () => {
    assert.ok(content.includes('[aa-dev] requireConsent'), 'tracker.js should contain [aa-dev] requireConsent');
    assert.ok(content.includes('[aa-dev] grantConsent'), 'tracker.js should contain [aa-dev] grantConsent');
    assert.ok(content.includes('[aa-dev] revokeConsent'), 'tracker.js should contain [aa-dev] revokeConsent');
  });
});
