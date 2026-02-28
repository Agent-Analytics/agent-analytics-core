import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * parseHeartbeatInterval — must match the logic in tracker.src.js.
 * Parses the data-heartbeat attribute value into a usable interval (seconds).
 * Returns 0 if disabled, otherwise clamps to minimum 15 seconds.
 */
function parseHeartbeatInterval(attrValue) {
  if (!attrValue) return 0;
  var n = parseInt(attrValue, 10);
  if (isNaN(n) || n <= 0) return 0;
  return Math.max(n, 15);
}

/**
 * Simulates the time-on-page accumulation from tracker.src.js.
 * Accumulates seconds silently, flushes once on page exit with $time_on_page.
 */
function createTimeOnPageController(interval) {
  if (!interval) return null;

  var seconds = 0;
  var running = false;
  var flushed = [];

  return {
    start: function() {
      if (running) return;
      running = true;
    },
    stop: function() {
      running = false;
    },
    tick: function() {
      if (!running) return;
      seconds += interval;
    },
    flush: function(path) {
      if (seconds > 0) {
        flushed.push({ event: '$time_on_page', properties: { time_on_page: seconds, path: path } });
        seconds = 0;
      }
    },
    isRunning: function() { return running; },
    getSeconds: function() { return seconds; },
    getFlushed: function() { return flushed; },
    onVisibilityChange: function(visible, path) {
      if (visible) this.start();
      else { this.stop(); this.flush(path); }
    }
  };
}

describe('heartbeat interval parsing', () => {
  test('"15" parses to 15 (minimum)', () => {
    assert.equal(parseHeartbeatInterval('15'), 15);
  });

  test('"30" parses to 30', () => {
    assert.equal(parseHeartbeatInterval('30'), 30);
  });

  test('"60" parses to 60', () => {
    assert.equal(parseHeartbeatInterval('60'), 60);
  });

  test('null returns 0 (disabled)', () => {
    assert.equal(parseHeartbeatInterval(null), 0);
  });

  test('undefined returns 0 (disabled)', () => {
    assert.equal(parseHeartbeatInterval(undefined), 0);
  });

  test('empty string returns 0 (disabled)', () => {
    assert.equal(parseHeartbeatInterval(''), 0);
  });

  test('"abc" returns 0 (non-numeric)', () => {
    assert.equal(parseHeartbeatInterval('abc'), 0);
  });

  test('"0" returns 0 (disabled)', () => {
    assert.equal(parseHeartbeatInterval('0'), 0);
  });

  test('"-5" returns 0 (negative)', () => {
    assert.equal(parseHeartbeatInterval('-5'), 0);
  });
});

describe('heartbeat minimum clamp to 15', () => {
  test('"1" clamps to 15', () => {
    assert.equal(parseHeartbeatInterval('1'), 15);
  });

  test('"5" clamps to 15', () => {
    assert.equal(parseHeartbeatInterval('5'), 15);
  });

  test('"10" clamps to 15', () => {
    assert.equal(parseHeartbeatInterval('10'), 15);
  });

  test('"14" clamps to 15', () => {
    assert.equal(parseHeartbeatInterval('14'), 15);
  });

  test('"15" stays at 15', () => {
    assert.equal(parseHeartbeatInterval('15'), 15);
  });

  test('"16" stays at 16 (above minimum)', () => {
    assert.equal(parseHeartbeatInterval('16'), 16);
  });
});

describe('time-on-page controller disabled', () => {
  test('returns null when interval is 0', () => {
    assert.equal(createTimeOnPageController(0), null);
  });

  test('returns null when interval is falsy', () => {
    assert.equal(createTimeOnPageController(null), null);
    assert.equal(createTimeOnPageController(undefined), null);
    assert.equal(createTimeOnPageController(false), null);
  });
});

describe('time-on-page visibility state machine', () => {
  test('starts in stopped state', () => {
    const tp = createTimeOnPageController(15);
    assert.equal(tp.isRunning(), false);
  });

  test('start makes it running', () => {
    const tp = createTimeOnPageController(15);
    tp.start();
    assert.equal(tp.isRunning(), true);
  });

  test('stop makes it not running', () => {
    const tp = createTimeOnPageController(15);
    tp.start();
    tp.stop();
    assert.equal(tp.isRunning(), false);
  });

  test('start is idempotent', () => {
    const tp = createTimeOnPageController(15);
    tp.start();
    tp.start();
    assert.equal(tp.isRunning(), true);
  });

  test('visibility visible → starts', () => {
    const tp = createTimeOnPageController(15);
    tp.onVisibilityChange(true, '/');
    assert.equal(tp.isRunning(), true);
  });

  test('visibility hidden → stops and flushes', () => {
    const tp = createTimeOnPageController(15);
    tp.start();
    tp.tick(); // 15s
    tp.tick(); // 30s
    tp.onVisibilityChange(false, '/about');
    assert.equal(tp.isRunning(), false);
    assert.equal(tp.getFlushed().length, 1);
    assert.equal(tp.getFlushed()[0].properties.time_on_page, 30);
    assert.equal(tp.getFlushed()[0].properties.path, '/about');
  });

  test('visibility cycle: visible → hidden → visible → hidden', () => {
    const tp = createTimeOnPageController(15);
    tp.onVisibilityChange(true, '/');
    tp.tick(); // 15s
    tp.onVisibilityChange(false, '/'); // flush 15s
    assert.equal(tp.getFlushed().length, 1);
    assert.equal(tp.getFlushed()[0].properties.time_on_page, 15);

    tp.onVisibilityChange(true, '/');
    tp.tick(); // 15s
    tp.tick(); // 30s
    tp.onVisibilityChange(false, '/'); // flush 30s
    assert.equal(tp.getFlushed().length, 2);
    assert.equal(tp.getFlushed()[1].properties.time_on_page, 30);
  });

  test('ticks do not accumulate when stopped', () => {
    const tp = createTimeOnPageController(15);
    tp.tick();
    tp.tick();
    assert.equal(tp.getSeconds(), 0);
  });
});

describe('time-on-page accumulation', () => {
  test('accumulates seconds based on interval × ticks', () => {
    const tp = createTimeOnPageController(15);
    tp.start();
    tp.tick(); // 15
    tp.tick(); // 30
    tp.tick(); // 45
    assert.equal(tp.getSeconds(), 45);
  });

  test('flush sends $time_on_page with accumulated seconds and path', () => {
    const tp = createTimeOnPageController(15);
    tp.start();
    tp.tick(); // 15
    tp.tick(); // 30
    tp.flush('/pricing');

    const events = tp.getFlushed();
    assert.equal(events.length, 1);
    assert.equal(events[0].event, '$time_on_page');
    assert.equal(events[0].properties.time_on_page, 30);
    assert.equal(events[0].properties.path, '/pricing');
  });

  test('flush resets seconds to 0', () => {
    const tp = createTimeOnPageController(15);
    tp.start();
    tp.tick(); // 15
    tp.flush('/');
    assert.equal(tp.getSeconds(), 0);
  });

  test('flush with 0 seconds sends nothing', () => {
    const tp = createTimeOnPageController(15);
    tp.flush('/');
    assert.equal(tp.getFlushed().length, 0);
  });

  test('seconds continue after pause/resume', () => {
    const tp = createTimeOnPageController(15);
    tp.start();
    tp.tick(); // 15
    tp.stop();
    tp.tick(); // no-op
    tp.start();
    tp.tick(); // 30
    assert.equal(tp.getSeconds(), 30);
  });

  test('SPA navigation: flush previous page, reset for new page', () => {
    const tp = createTimeOnPageController(15);
    tp.start();
    tp.tick(); // 15s on /home
    tp.tick(); // 30s on /home

    // SPA nav: flush /home, reset
    tp.stop();
    tp.flush('/home');
    tp.start();

    tp.tick(); // 15s on /about

    tp.stop();
    tp.flush('/about');

    const events = tp.getFlushed();
    assert.equal(events.length, 2);
    assert.equal(events[0].properties.time_on_page, 30);
    assert.equal(events[0].properties.path, '/home');
    assert.equal(events[1].properties.time_on_page, 15);
    assert.equal(events[1].properties.path, '/about');
  });
});

describe('time-on-page in built tracker', () => {
  test('built tracker.js contains $time_on_page event name', () => {
    const trackerPath = join(__dirname, '..', 'src', 'tracker.js');
    const content = readFileSync(trackerPath, 'utf-8');
    assert.ok(content.includes('$time_on_page'), 'tracker.js should contain $time_on_page');
  });

  test('built tracker.js contains data-heartbeat attribute reference', () => {
    const trackerPath = join(__dirname, '..', 'src', 'tracker.js');
    const content = readFileSync(trackerPath, 'utf-8');
    assert.ok(content.includes('data-heartbeat'), 'tracker.js should reference data-heartbeat');
  });

  test('built tracker.js contains time_on_page property', () => {
    const trackerPath = join(__dirname, '..', 'src', 'tracker.js');
    const content = readFileSync(trackerPath, 'utf-8');
    assert.ok(content.includes('time_on_page'), 'tracker.js should reference time_on_page');
  });
});
