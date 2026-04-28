import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_STORAGE_PREFIX = 'aa:test-scope:';
function scopedKey(key) { return TEST_STORAGE_PREFIX + key; }

/**
 * createVisitorIntelligenceController — mirrors the session count + days since
 * first visit logic in tracker.src.js. Uses mock localStorage/sessionStorage.
 */
function createVisitorIntelligenceController(localStorage, sessionStorage) {
  localStorage = localStorage || {};
  sessionStorage = sessionStorage || {};

  var SESSION_TIMEOUT = 30 * 60 * 1000;

  var sessionCount = parseInt(localStorage[scopedKey('sc')] || '0', 10);
  var firstVisit = parseInt(localStorage[scopedKey('fv')] || '0', 10);
  var _now = Date.now();

  if (!firstVisit) {
    firstVisit = _now;
    localStorage[scopedKey('fv')] = String(firstVisit);
  }

  function getSessionId(now) {
    if (now !== undefined) _now = now;
    var lastActivity = parseInt(sessionStorage[scopedKey('last_activity')] || '0', 10);
    var sid = sessionStorage[scopedKey('sid')];
    if (!sid || (lastActivity && (_now - lastActivity) > SESSION_TIMEOUT)) {
      sid = 'sess_' + Math.random().toString(36).slice(2, 11) + _now.toString(36);
      sessionStorage[scopedKey('sid')] = sid;
      // Increment session count on new session
      sessionCount++;
      localStorage[scopedKey('sc')] = String(sessionCount);
    }
    sessionStorage[scopedKey('last_activity')] = String(_now);
    return sid;
  }

  return {
    getSessionId: getSessionId,
    getSessionCount: function() { return sessionCount; },
    getFirstVisit: function() { return firstVisit; },
    getDaysSinceFirstVisit: function(now) {
      var ts = now !== undefined ? now : _now;
      return Math.floor((ts - firstVisit) / 86400000);
    },
    buildProps: function(now) {
      var ts = now !== undefined ? now : _now;
      return {
        session_count: sessionCount,
        days_since_first_visit: Math.floor((ts - firstVisit) / 86400000)
      };
    },
    getLocalStorage: function() { return localStorage; },
    getSessionStorage: function() { return sessionStorage; }
  };
}

// --- Session count ---

describe('session count', () => {
  test('first visit sets session_count to 1', () => {
    const ls = {};
    const ss = {};
    const ctrl = createVisitorIntelligenceController(ls, ss);
    ctrl.getSessionId();
    assert.equal(ctrl.getSessionCount(), 1);
  });

  test('new session increments count (1 → 2)', () => {
    const ls = {};
    const ss = {};
    const ctrl = createVisitorIntelligenceController(ls, ss);
    const now = Date.now();
    ctrl.getSessionId(now);
    assert.equal(ctrl.getSessionCount(), 1);
    // Simulate 31 minutes later (new session)
    ctrl.getSessionId(now + 31 * 60 * 1000);
    assert.equal(ctrl.getSessionCount(), 2);
  });

  test('same session does not increment count', () => {
    const ls = {};
    const ss = {};
    const ctrl = createVisitorIntelligenceController(ls, ss);
    const now = Date.now();
    ctrl.getSessionId(now);
    assert.equal(ctrl.getSessionCount(), 1);
    // 5 minutes later — same session
    ctrl.getSessionId(now + 5 * 60 * 1000);
    assert.equal(ctrl.getSessionCount(), 1);
  });

  test('count persists across "page reloads" (new controller, same storage)', () => {
    const ls = {};
    const ss = {};
    const now = Date.now();

    // First page load
    const ctrl1 = createVisitorIntelligenceController(ls, ss);
    ctrl1.getSessionId(now);
    assert.equal(ctrl1.getSessionCount(), 1);

    // "Reload" — new controller, same localStorage, new sessionStorage (cleared on reload)
    const ss2 = {};
    const ctrl2 = createVisitorIntelligenceController(ls, ss2);
    ctrl2.getSessionId(now + 1000);
    assert.equal(ctrl2.getSessionCount(), 2);
  });

  test('10 sessions = count of 10', () => {
    const ls = {};
    const now = Date.now();

    for (let i = 0; i < 10; i++) {
      // Each iteration = new sessionStorage (like opening a new browser session)
      const ss = {};
      const ctrl = createVisitorIntelligenceController(ls, ss);
      ctrl.getSessionId(now + i * 60 * 60 * 1000); // 1 hour apart
    }
    assert.equal(parseInt(ls[scopedKey('sc')], 10), 10);
  });
});

// --- Days since first visit ---

describe('days since first visit', () => {
  test('first visit = 0 days', () => {
    const ls = {};
    const ss = {};
    const ctrl = createVisitorIntelligenceController(ls, ss);
    ctrl.getSessionId();
    assert.equal(ctrl.getDaysSinceFirstVisit(), 0);
  });

  test('same day = 0 days', () => {
    const now = Date.now();
    const ls = {};
    const ss = {};
    const ctrl = createVisitorIntelligenceController(ls, ss);
    ctrl.getSessionId(now);
    assert.equal(ctrl.getDaysSinceFirstVisit(now + 3600000), 0); // 1 hour later
  });

  test('1 day later = 1', () => {
    const now = Date.now();
    const ls = { [scopedKey('fv')]: String(now) };
    const ss = {};
    const ctrl = createVisitorIntelligenceController(ls, ss);
    assert.equal(ctrl.getDaysSinceFirstVisit(now + 86400000), 1);
  });

  test('7 days later = 7', () => {
    const now = Date.now();
    const ls = { [scopedKey('fv')]: String(now) };
    const ss = {};
    const ctrl = createVisitorIntelligenceController(ls, ss);
    assert.equal(ctrl.getDaysSinceFirstVisit(now + 7 * 86400000), 7);
  });

  test('first_visit timestamp never changes', () => {
    const now = Date.now();
    const ls = {};
    const ss = {};

    // First visit
    const ctrl1 = createVisitorIntelligenceController(ls, ss);
    ctrl1.getSessionId(now);
    const firstVisit = parseInt(ls[scopedKey('fv')], 10);

    // Second visit — 1 day later, new sessionStorage
    const ss2 = {};
    const ctrl2 = createVisitorIntelligenceController(ls, ss2);
    ctrl2.getSessionId(now + 86400000);
    assert.equal(parseInt(ls[scopedKey('fv')], 10), firstVisit);

    // Third visit — 30 days later
    const ss3 = {};
    const ctrl3 = createVisitorIntelligenceController(ls, ss3);
    ctrl3.getSessionId(now + 30 * 86400000);
    assert.equal(parseInt(ls[scopedKey('fv')], 10), firstVisit);
  });
});

// --- baseProps merge ---

describe('baseProps merge — visitor intelligence', () => {
  test('session_count appears in built props', () => {
    const ls = {};
    const ss = {};
    const ctrl = createVisitorIntelligenceController(ls, ss);
    ctrl.getSessionId();
    const props = ctrl.buildProps();
    assert.equal(props.session_count, 1);
  });

  test('days_since_first_visit appears in built props', () => {
    const now = Date.now();
    const ls = { [scopedKey('fv')]: String(now - 3 * 86400000) }; // 3 days ago
    const ss = {};
    const ctrl = createVisitorIntelligenceController(ls, ss);
    ctrl.getSessionId(now);
    const props = ctrl.buildProps(now);
    assert.equal(props.days_since_first_visit, 3);
  });

  test('session_count reflects correct count after multiple sessions', () => {
    const ls = {};
    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      const ss = {};
      const ctrl = createVisitorIntelligenceController(ls, ss);
      ctrl.getSessionId(now + i * 60 * 60 * 1000);
    }

    const ss = {};
    const ctrl = createVisitorIntelligenceController(ls, ss);
    ctrl.getSessionId(now + 6 * 60 * 60 * 1000);
    const props = ctrl.buildProps();
    assert.equal(props.session_count, 6);
  });
});

// --- Build output checks ---

describe('visitor intelligence in built tracker', () => {
  const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');

  test('tracker.js contains scoped session count key', () => {
    assert.ok(content.includes('aa:'), 'tracker.js should contain scoped storage prefix');
    assert.ok(content.includes('sc'), 'tracker.js should contain session count key');
    assert.equal(content.includes('aa_sc'), false, 'tracker.js should not contain legacy aa_sc key');
  });

  test('tracker.js contains scoped first visit key', () => {
    assert.ok(content.includes('aa:'), 'tracker.js should contain scoped storage prefix');
    assert.ok(content.includes('fv'), 'tracker.js should contain first visit key');
    assert.equal(content.includes('aa_fv'), false, 'tracker.js should not contain legacy aa_fv key');
  });

  test('tracker.js contains session_count', () => {
    assert.ok(content.includes('session_count'), 'tracker.js should contain session_count');
  });

  test('tracker.js contains days_since_first_visit', () => {
    assert.ok(content.includes('days_since_first_visit'), 'tracker.js should contain days_since_first_visit');
  });
});
