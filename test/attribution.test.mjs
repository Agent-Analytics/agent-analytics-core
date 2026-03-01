import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * createAttributionController — mirrors the UTM persistence + first-touch
 * attribution logic in tracker.src.js. Uses mock storage and URL params.
 */
function createAttributionController(localStorage, sessionStorage) {
  localStorage = localStorage || {};
  sessionStorage = sessionStorage || {};

  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

  function getUtm(urlParams) {
    var u = {};
    var hasNew = false;
    for (var i = 0; i < UTM_KEYS.length; i++) {
      var v = urlParams[UTM_KEYS[i]];
      if (v) { u[UTM_KEYS[i]] = v; hasNew = true; }
    }
    // Persist new UTMs to sessionStorage (last-touch for this session)
    if (hasNew) {
      sessionStorage['aa_utm'] = JSON.stringify(u);
    } else {
      // No UTMs on URL — restore from session
      try { u = JSON.parse(sessionStorage['aa_utm'] || '{}'); } catch (_) { u = {}; }
    }
    // First-touch: store once, never overwrite
    if (hasNew && !localStorage['aa_ft']) {
      localStorage['aa_ft'] = JSON.stringify(u);
    }
    return u;
  }

  function buildProps(autoCollected, urlParams) {
    var p = Object.assign({}, autoCollected);
    var utm = getUtm(urlParams || {});
    // Merge UTM
    for (var k in utm) { if (utm.hasOwnProperty(k)) p[k] = utm[k]; }
    // Merge first-touch attribution
    try {
      var ft = JSON.parse(localStorage['aa_ft'] || '{}');
      for (var kf in ft) { if (ft.hasOwnProperty(kf)) p['first_' + kf] = ft[kf]; }
    } catch (_) {}
    return p;
  }

  return {
    getUtm: getUtm,
    buildProps: buildProps,
    getLocalStorage: function() { return localStorage; },
    getSessionStorage: function() { return sessionStorage; }
  };
}

// --- UTM session persistence ---

describe('UTM session persistence', () => {
  test('UTMs from URL are returned', () => {
    const ctrl = createAttributionController();
    const utm = ctrl.getUtm({ utm_source: 'google', utm_medium: 'cpc' });
    assert.equal(utm.utm_source, 'google');
    assert.equal(utm.utm_medium, 'cpc');
  });

  test('UTMs persist after "navigation" (no URL params → reads sessionStorage)', () => {
    const ls = {};
    const ss = {};
    const ctrl = createAttributionController(ls, ss);
    ctrl.getUtm({ utm_source: 'google', utm_medium: 'cpc' });
    // Navigate to page without UTMs
    const utm2 = ctrl.getUtm({});
    assert.equal(utm2.utm_source, 'google');
    assert.equal(utm2.utm_medium, 'cpc');
  });

  test('new UTMs on URL overwrite session UTMs', () => {
    const ls = {};
    const ss = {};
    const ctrl = createAttributionController(ls, ss);
    ctrl.getUtm({ utm_source: 'google' });
    const utm2 = ctrl.getUtm({ utm_source: 'facebook' });
    assert.equal(utm2.utm_source, 'facebook');
    // Verify old key is gone
    assert.equal(utm2.utm_medium, undefined);
  });

  test('empty URL + empty session returns empty object', () => {
    const ctrl = createAttributionController();
    const utm = ctrl.getUtm({});
    assert.deepEqual(utm, {});
  });

  test('partial UTMs merge correctly', () => {
    const ls = {};
    const ss = {};
    const ctrl = createAttributionController(ls, ss);
    ctrl.getUtm({ utm_source: 'google', utm_campaign: 'spring' });
    // Navigate — reads from session
    const utm2 = ctrl.getUtm({});
    assert.equal(utm2.utm_source, 'google');
    assert.equal(utm2.utm_campaign, 'spring');
    assert.equal(utm2.utm_medium, undefined);
  });
});

// --- First-touch attribution ---

describe('first-touch attribution', () => {
  test('first visit with UTMs stores first-touch', () => {
    const ls = {};
    const ss = {};
    const ctrl = createAttributionController(ls, ss);
    ctrl.getUtm({ utm_source: 'google', utm_medium: 'cpc' });
    const ft = JSON.parse(ls['aa_ft']);
    assert.equal(ft.utm_source, 'google');
    assert.equal(ft.utm_medium, 'cpc');
  });

  test('second visit with different UTMs does NOT overwrite first-touch', () => {
    const ls = {};
    const ss = {};
    const ctrl = createAttributionController(ls, ss);
    ctrl.getUtm({ utm_source: 'google' });

    // Second visit — different UTMs, new sessionStorage
    const ss2 = {};
    const ctrl2 = createAttributionController(ls, ss2);
    ctrl2.getUtm({ utm_source: 'facebook' });

    const ft = JSON.parse(ls['aa_ft']);
    assert.equal(ft.utm_source, 'google'); // original preserved
  });

  test('first-touch persists across sessions (same localStorage)', () => {
    const ls = {};

    // Session 1
    const ctrl1 = createAttributionController(ls, {});
    ctrl1.getUtm({ utm_source: 'google', utm_campaign: 'launch' });

    // Session 2 — no UTMs
    const ctrl2 = createAttributionController(ls, {});
    ctrl2.getUtm({});

    const ft = JSON.parse(ls['aa_ft']);
    assert.equal(ft.utm_source, 'google');
    assert.equal(ft.utm_campaign, 'launch');
  });

  test('no UTMs on first visit = no first-touch stored', () => {
    const ls = {};
    const ctrl = createAttributionController(ls, {});
    ctrl.getUtm({});
    assert.equal(ls['aa_ft'], undefined);
  });

  test('first-touch stored on first visit with UTMs, even if later visits have none', () => {
    const ls = {};

    // First visit with UTMs
    const ctrl1 = createAttributionController(ls, {});
    ctrl1.getUtm({ utm_source: 'newsletter' });

    // Second visit without UTMs
    const ctrl2 = createAttributionController(ls, {});
    ctrl2.getUtm({});

    // Third visit without UTMs
    const ctrl3 = createAttributionController(ls, {});
    ctrl3.getUtm({});

    const ft = JSON.parse(ls['aa_ft']);
    assert.equal(ft.utm_source, 'newsletter');
  });
});

// --- baseProps merge — attribution ---

describe('baseProps merge — attribution', () => {
  test('utm_source from URL appears as utm_source', () => {
    const ctrl = createAttributionController();
    const props = ctrl.buildProps({ path: '/' }, { utm_source: 'google' });
    assert.equal(props.utm_source, 'google');
  });

  test('first_utm_source appears alongside utm_source', () => {
    const ctrl = createAttributionController();
    const props = ctrl.buildProps({ path: '/' }, { utm_source: 'google' });
    assert.equal(props.utm_source, 'google');
    assert.equal(props.first_utm_source, 'google');
  });

  test('on return visit: utm_source = new campaign, first_utm_source = original', () => {
    const ls = {};

    // First visit
    const ctrl1 = createAttributionController(ls, {});
    ctrl1.buildProps({}, { utm_source: 'google', utm_medium: 'cpc' });

    // Return visit with different UTMs
    const ctrl2 = createAttributionController(ls, {});
    const props = ctrl2.buildProps({}, { utm_source: 'facebook', utm_medium: 'social' });
    assert.equal(props.utm_source, 'facebook');
    assert.equal(props.utm_medium, 'social');
    assert.equal(props.first_utm_source, 'google');
    assert.equal(props.first_utm_medium, 'cpc');
  });

  test('pages without UTMs still have session-persisted utm_source', () => {
    const ls = {};
    const ss = {};
    const ctrl = createAttributionController(ls, ss);
    // Landing page with UTMs
    ctrl.buildProps({}, { utm_source: 'google' });
    // Internal navigation — no UTMs
    const props = ctrl.buildProps({}, {});
    assert.equal(props.utm_source, 'google');
  });

  test('first-touch props do not exist if user never arrived via UTM', () => {
    const ctrl = createAttributionController();
    const props = ctrl.buildProps({ path: '/' }, {});
    assert.equal(props.first_utm_source, undefined);
    assert.equal(props.first_utm_medium, undefined);
  });
});

// --- Build output checks ---

describe('attribution in built tracker', () => {
  const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');

  test('tracker.js contains aa_utm', () => {
    assert.ok(content.includes('aa_utm'), 'tracker.js should contain aa_utm');
  });

  test('tracker.js contains aa_ft', () => {
    assert.ok(content.includes('aa_ft'), 'tracker.js should contain aa_ft');
  });

  test('tracker.js contains first_', () => {
    assert.ok(content.includes('first_'), 'tracker.js should contain first_ prefix for first-touch props');
  });
});
