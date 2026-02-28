import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * parseHeartbeatInterval — must match the logic in tracker.src.js.
 * Parses the data-heartbeat attribute value into a usable interval (seconds).
 * Returns 0 if disabled, otherwise clamps to minimum 5 seconds.
 */
function parseHeartbeatInterval(attrValue) {
  if (!attrValue) return 0;
  var n = parseInt(attrValue, 10);
  if (isNaN(n) || n <= 0) return 0;
  return Math.max(n, 5);
}

/**
 * Simulates the heartbeat visibility state machine from tracker.src.js.
 * Tracks start/stop calls and heartbeat events fired.
 */
function createHeartbeatController(interval) {
  if (!interval) return null;

  var count = 0;
  var running = false;
  var events = [];

  return {
    start: function() {
      if (running) return; // idempotent
      running = true;
    },
    stop: function() {
      running = false;
    },
    tick: function() {
      if (!running) return; // no-op when paused
      count++;
      events.push({ event: '$heartbeat', properties: { count: count } });
    },
    isRunning: function() { return running; },
    getCount: function() { return count; },
    getEvents: function() { return events; },
    onVisibilityChange: function(visible) {
      if (visible) this.start();
      else this.stop();
    }
  };
}

describe('heartbeat interval parsing', () => {
  test('"15" parses to 15', () => {
    assert.equal(parseHeartbeatInterval('15'), 15);
  });

  test('"30" parses to 30', () => {
    assert.equal(parseHeartbeatInterval('30'), 30);
  });

  test('"60" parses to 60', () => {
    assert.equal(parseHeartbeatInterval('60'), 60);
  });

  test('"5" parses to 5 (exactly at minimum)', () => {
    assert.equal(parseHeartbeatInterval('5'), 5);
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

describe('heartbeat minimum clamp', () => {
  test('"1" clamps to 5', () => {
    assert.equal(parseHeartbeatInterval('1'), 5);
  });

  test('"2" clamps to 5', () => {
    assert.equal(parseHeartbeatInterval('2'), 5);
  });

  test('"3" clamps to 5', () => {
    assert.equal(parseHeartbeatInterval('3'), 5);
  });

  test('"4" clamps to 5', () => {
    assert.equal(parseHeartbeatInterval('4'), 5);
  });

  test('"5" stays at 5', () => {
    assert.equal(parseHeartbeatInterval('5'), 5);
  });

  test('"6" stays at 6 (above minimum)', () => {
    assert.equal(parseHeartbeatInterval('6'), 6);
  });
});

describe('heartbeat controller disabled', () => {
  test('returns null when interval is 0', () => {
    assert.equal(createHeartbeatController(0), null);
  });

  test('returns null when interval is falsy', () => {
    assert.equal(createHeartbeatController(null), null);
    assert.equal(createHeartbeatController(undefined), null);
    assert.equal(createHeartbeatController(false), null);
  });
});

describe('heartbeat visibility state machine', () => {
  test('starts in stopped state', () => {
    const hb = createHeartbeatController(15);
    assert.equal(hb.isRunning(), false);
  });

  test('start makes it running', () => {
    const hb = createHeartbeatController(15);
    hb.start();
    assert.equal(hb.isRunning(), true);
  });

  test('stop makes it not running', () => {
    const hb = createHeartbeatController(15);
    hb.start();
    hb.stop();
    assert.equal(hb.isRunning(), false);
  });

  test('start is idempotent (calling twice is safe)', () => {
    const hb = createHeartbeatController(15);
    hb.start();
    hb.start();
    assert.equal(hb.isRunning(), true);
  });

  test('visibility visible → starts timer', () => {
    const hb = createHeartbeatController(15);
    hb.onVisibilityChange(true);
    assert.equal(hb.isRunning(), true);
  });

  test('visibility hidden → stops timer', () => {
    const hb = createHeartbeatController(15);
    hb.start();
    hb.onVisibilityChange(false);
    assert.equal(hb.isRunning(), false);
  });

  test('visibility cycle: visible → hidden → visible', () => {
    const hb = createHeartbeatController(15);
    hb.onVisibilityChange(true);
    assert.equal(hb.isRunning(), true);

    hb.onVisibilityChange(false);
    assert.equal(hb.isRunning(), false);

    hb.onVisibilityChange(true);
    assert.equal(hb.isRunning(), true);
  });

  test('ticks do not fire when stopped', () => {
    const hb = createHeartbeatController(15);
    // Not started — tick should be no-op
    hb.tick();
    hb.tick();
    assert.equal(hb.getCount(), 0);
    assert.equal(hb.getEvents().length, 0);
  });
});

describe('heartbeat event shape', () => {
  test('each tick produces a $heartbeat event with incrementing count', () => {
    const hb = createHeartbeatController(15);
    hb.start();

    hb.tick();
    hb.tick();
    hb.tick();

    const events = hb.getEvents();
    assert.equal(events.length, 3);

    assert.equal(events[0].event, '$heartbeat');
    assert.equal(events[0].properties.count, 1);

    assert.equal(events[1].event, '$heartbeat');
    assert.equal(events[1].properties.count, 2);

    assert.equal(events[2].event, '$heartbeat');
    assert.equal(events[2].properties.count, 3);
  });

  test('count continues after pause/resume', () => {
    const hb = createHeartbeatController(15);
    hb.start();
    hb.tick(); // count 1
    hb.tick(); // count 2

    hb.stop();
    hb.tick(); // should not fire (stopped)

    hb.start();
    hb.tick(); // count 3 (continues from where it left off)

    const events = hb.getEvents();
    assert.equal(events.length, 3); // only 3 events (not 4)
    assert.equal(events[2].properties.count, 3);
  });

  test('count starts at 1 (not 0)', () => {
    const hb = createHeartbeatController(15);
    hb.start();
    hb.tick();

    assert.equal(hb.getEvents()[0].properties.count, 1);
  });
});

describe('heartbeat in built tracker', () => {
  test('built tracker.js contains $heartbeat event name', () => {
    const trackerPath = join(__dirname, '..', 'src', 'tracker.js');
    const content = readFileSync(trackerPath, 'utf-8');
    assert.ok(content.includes('$heartbeat'), 'tracker.js should contain $heartbeat');
  });

  test('built tracker.js contains data-heartbeat attribute reference', () => {
    const trackerPath = join(__dirname, '..', 'src', 'tracker.js');
    const content = readFileSync(trackerPath, 'utf-8');
    assert.ok(content.includes('data-heartbeat'), 'tracker.js should reference data-heartbeat');
  });
});
