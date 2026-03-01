import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * getTimezone — mirrors the timezone logic in tracker.src.js.
 * Returns IANA timezone string, or empty string on failure.
 */
function getTimezone(intlAvailable, resolvedTimezone) {
  var tz = '';
  try {
    if (!intlAvailable) throw new Error('Intl not available');
    tz = resolvedTimezone;
  } catch(_) {}
  return tz;
}

describe('timezone collection', () => {
  test('returns IANA timezone string when Intl is available', () => {
    const tz = getTimezone(true, 'America/New_York');
    assert.equal(tz, 'America/New_York');
  });

  test('returns common timezones correctly', () => {
    assert.equal(getTimezone(true, 'Europe/London'), 'Europe/London');
    assert.equal(getTimezone(true, 'Asia/Tokyo'), 'Asia/Tokyo');
    assert.equal(getTimezone(true, 'America/Los_Angeles'), 'America/Los_Angeles');
    assert.equal(getTimezone(true, 'UTC'), 'UTC');
  });

  test('returns empty string when Intl is not available', () => {
    const tz = getTimezone(false, undefined);
    assert.equal(tz, '');
  });

  test('returns empty string on error', () => {
    const tz = getTimezone(false, null);
    assert.equal(tz, '');
  });

  test('actual Intl.DateTimeFormat returns IANA string', () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.ok(typeof tz === 'string');
    assert.ok(tz.length > 0);
    // IANA timezones contain a slash (e.g. America/New_York) or are short like UTC
    assert.ok(tz.includes('/') || /^[A-Z]{2,5}$/.test(tz),
      `Expected IANA timezone, got: ${tz}`);
  });
});

describe('timezone in built tracker', () => {
  test('built tracker.js contains timezone property', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('timezone'), 'tracker.js should contain timezone');
  });

  test('built tracker.js contains Intl.DateTimeFormat', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('DateTimeFormat'), 'tracker.js should use DateTimeFormat');
  });

  test('built tracker.js contains resolvedOptions', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('resolvedOptions'), 'tracker.js should use resolvedOptions');
  });
});
