import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * createGlobalPropsController — mirrors the globalProps + aa.set() + baseProps merge
 * logic in tracker.src.js. Returns a controller for testing the algorithm.
 */
function createGlobalPropsController() {
  var globalProps = {};

  return {
    set: function(props) {
      if (!props) return;
      for (var k in props) {
        if (props.hasOwnProperty(k)) {
          if (props[k] === null) delete globalProps[k];
          else globalProps[k] = props[k];
        }
      }
    },

    getGlobalProps: function() {
      return Object.assign({}, globalProps);
    },

    /**
     * Simulates baseProps() merge order:
     *   auto-collected → UTM → globalProps → extra (event-specific)
     */
    buildProps: function(autoCollected, utm, extra) {
      var p = Object.assign({}, autoCollected);
      for (var k in utm) { if (utm.hasOwnProperty(k)) p[k] = utm[k]; }
      for (var k1 in globalProps) { if (globalProps.hasOwnProperty(k1)) p[k1] = globalProps[k1]; }
      if (extra) for (var k2 in extra) { if (extra.hasOwnProperty(k2)) p[k2] = extra[k2]; }
      return p;
    }
  };
}

// --- Basic set behavior ---

describe('aa.set() basic behavior', () => {
  test('set adds properties to globalProps', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ plan: 'pro', team: 'alpha' });
    assert.deepEqual(ctrl.getGlobalProps(), { plan: 'pro', team: 'alpha' });
  });

  test('multiple set calls merge (not replace)', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ a: 1 });
    ctrl.set({ b: 2 });
    assert.deepEqual(ctrl.getGlobalProps(), { a: 1, b: 2 });
  });

  test('set overwrites existing key', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ plan: 'free' });
    ctrl.set({ plan: 'pro' });
    assert.deepEqual(ctrl.getGlobalProps(), { plan: 'pro' });
  });

  test('set with null removes that key', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ a: 1, b: 2 });
    ctrl.set({ a: null });
    assert.deepEqual(ctrl.getGlobalProps(), { b: 2 });
  });

  test('set with null on non-existent key is a no-op', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ a: 1 });
    ctrl.set({ nonexistent: null });
    assert.deepEqual(ctrl.getGlobalProps(), { a: 1 });
  });

  test('set with null/undefined/false argument is a no-op', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ a: 1 });
    ctrl.set(null);
    ctrl.set(undefined);
    ctrl.set(false);
    assert.deepEqual(ctrl.getGlobalProps(), { a: 1 });
  });

  test('set with empty object is a no-op', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ a: 1 });
    ctrl.set({});
    assert.deepEqual(ctrl.getGlobalProps(), { a: 1 });
  });
});

// --- Value types ---

describe('aa.set() value types', () => {
  test('string values', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ name: 'alice' });
    assert.equal(ctrl.getGlobalProps().name, 'alice');
  });

  test('numeric values', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ count: 42 });
    assert.equal(ctrl.getGlobalProps().count, 42);
  });

  test('boolean values', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ active: true, disabled: false });
    assert.equal(ctrl.getGlobalProps().active, true);
    assert.equal(ctrl.getGlobalProps().disabled, false);
  });

  test('false is preserved (not treated as null)', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ flag: false });
    assert.equal(ctrl.getGlobalProps().flag, false);
    assert.ok('flag' in ctrl.getGlobalProps());
  });

  test('zero is preserved (not treated as null)', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ count: 0 });
    assert.equal(ctrl.getGlobalProps().count, 0);
    assert.ok('count' in ctrl.getGlobalProps());
  });

  test('empty string is preserved (not treated as null)', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ label: '' });
    assert.equal(ctrl.getGlobalProps().label, '');
    assert.ok('label' in ctrl.getGlobalProps());
  });
});

// --- Merge order ---

describe('aa.set() merge order in baseProps', () => {
  const auto = { path: '/home', browser: 'Chrome', title: 'Home' };
  const utm = { utm_source: 'google' };

  test('global props appear in built properties', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ plan: 'pro' });
    const props = ctrl.buildProps(auto, utm, null);
    assert.equal(props.plan, 'pro');
    assert.equal(props.path, '/home');
    assert.equal(props.utm_source, 'google');
  });

  test('global props override auto-collected', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ title: 'Custom Title' });
    const props = ctrl.buildProps(auto, utm, null);
    assert.equal(props.title, 'Custom Title');
  });

  test('global props override UTM', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ utm_source: 'override' });
    const props = ctrl.buildProps(auto, utm, null);
    assert.equal(props.utm_source, 'override');
  });

  test('event-specific (extra) overrides global props', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ plan: 'pro' });
    const props = ctrl.buildProps(auto, utm, { plan: 'enterprise' });
    assert.equal(props.plan, 'enterprise');
  });

  test('event-specific overrides global which overrides auto', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ title: 'Global Title' });
    const props = ctrl.buildProps(auto, utm, { title: 'Event Title' });
    assert.equal(props.title, 'Event Title');
  });

  test('full merge order: auto < UTM < global < extra', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ browser: 'GlobalBrowser', plan: 'pro', utm_source: 'global_src' });
    const props = ctrl.buildProps(
      { browser: 'Chrome', path: '/' },
      { utm_source: 'google' },
      { plan: 'enterprise' }
    );
    assert.equal(props.browser, 'GlobalBrowser');
    assert.equal(props.utm_source, 'global_src');
    assert.equal(props.plan, 'enterprise');
    assert.equal(props.path, '/');
  });
});

// --- Persistence across events ---

describe('aa.set() persists across events', () => {
  test('global props appear in multiple buildProps calls', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ user_type: 'admin' });

    const props1 = ctrl.buildProps({ path: '/a' }, {}, null);
    const props2 = ctrl.buildProps({ path: '/b' }, {}, null);
    const props3 = ctrl.buildProps({ path: '/c' }, {}, null);

    assert.equal(props1.user_type, 'admin');
    assert.equal(props2.user_type, 'admin');
    assert.equal(props3.user_type, 'admin');
  });

  test('removing a global prop stops it from appearing', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ temp: 'value' });

    const props1 = ctrl.buildProps({}, {}, null);
    assert.equal(props1.temp, 'value');

    ctrl.set({ temp: null });

    const props2 = ctrl.buildProps({}, {}, null);
    assert.equal(props2.temp, undefined);
  });

  test('set then remove then set again works', () => {
    const ctrl = createGlobalPropsController();
    ctrl.set({ key: 'v1' });
    ctrl.set({ key: null });
    ctrl.set({ key: 'v2' });
    assert.equal(ctrl.getGlobalProps().key, 'v2');
  });
});

// --- Build output checks ---

describe('aa.set() in built tracker', () => {
  const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');

  test('built tracker.js contains null-delete logic for set', () => {
    assert.ok(content.includes('===null') && content.includes('delete'), 'tracker.js should contain null-delete logic for aa.set()');
  });

  test('built tracker.js contains aa-dev set stub', () => {
    assert.ok(content.includes('[aa-dev] set'), 'tracker.js should contain [aa-dev] set');
  });

  test('built tracker.js contains set method', () => {
    assert.ok(content.includes('set:function'), 'tracker.js should contain set:function');
  });
});
