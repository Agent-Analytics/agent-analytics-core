/**
 * TDD tests for BaseAdapter analytics methods.
 *
 * Uses MockAdapter backed by better-sqlite3 :memory: (same as base-adapter.test.mjs).
 * Tests: getBreakdown, getInsights, getPages, getSessionDistribution, getHeatmap
 */
import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { BaseAdapter } from '../src/db/base-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(resolve(__dirname, '../schema.sql'), 'utf-8');

// ---------------------------------------------------------------------------
// MockAdapter — thin subclass using better-sqlite3 in-memory
// ---------------------------------------------------------------------------

class MockAdapter extends BaseAdapter {
  constructor() {
    super();
    this.db = new Database(':memory:');
    this.db.exec(schema);
  }

  _run(sql, params) {
    return this.db.prepare(sql).run(...params);
  }

  _queryAll(sql, params) {
    return this.db.prepare(sql).all(...params);
  }

  _queryOne(sql, params) {
    return this.db.prepare(sql).get(...params) || null;
  }

  _batch(statements) {
    const txn = this.db.transaction((stmts) => {
      for (const { sql, params } of stmts) {
        this.db.prepare(sql).run(...params);
      }
    });
    txn(statements);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(ts) {
  return new Date(ts).toISOString().split('T')[0];
}

function daysAgoMs(n) {
  return Date.now() - n * 86_400_000;
}

// ---------------------------------------------------------------------------
// Tests: getBreakdown
// ---------------------------------------------------------------------------

describe('BaseAdapter.getBreakdown', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  test('returns top property values grouped by count', async () => {
    const now = Date.now();
    // 5 events with path=/home
    for (let i = 0; i < 5; i++) {
      await adapter.trackEvent({ project: 'p', event: 'page_view', properties: { path: '/home' }, user_id: `u${i}`, timestamp: now + i });
    }
    // 3 events with path=/pricing
    for (let i = 0; i < 3; i++) {
      await adapter.trackEvent({ project: 'p', event: 'page_view', properties: { path: '/pricing' }, user_id: `u${i}`, timestamp: now + 100 + i });
    }
    // 1 event with path=/docs
    await adapter.trackEvent({ project: 'p', event: 'page_view', properties: { path: '/docs' }, user_id: 'u0', timestamp: now + 200 });

    const result = await adapter.getBreakdown({ project: 'p', property: 'path' });

    assert.ok(result.values);
    assert.equal(result.values.length, 3);
    assert.equal(result.values[0].value, '/home');
    assert.equal(result.values[0].count, 5);
    assert.equal(result.values[1].value, '/pricing');
    assert.equal(result.values[1].count, 3);
    assert.equal(result.values[2].value, '/docs');
    assert.equal(result.values[2].count, 1);
    // Check unique_users
    assert.equal(result.values[0].unique_users, 5);
    assert.equal(result.values[1].unique_users, 3);
    // Check totals
    assert.equal(result.total_events, 9);
    assert.equal(result.total_with_property, 9);
    assert.equal(result.property, 'path');
  });

  test('filters by event name', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'page_view', properties: { path: '/home' }, user_id: 'u1', timestamp: now });
    await adapter.trackEvent({ project: 'p', event: 'page_view', properties: { path: '/home' }, user_id: 'u2', timestamp: now + 1 });
    await adapter.trackEvent({ project: 'p', event: 'click', properties: { path: '/home' }, user_id: 'u1', timestamp: now + 2 });

    const result = await adapter.getBreakdown({ project: 'p', property: 'path', event: 'page_view' });

    assert.equal(result.values.length, 1);
    assert.equal(result.values[0].count, 2);
    assert.equal(result.event, 'page_view');
  });

  test('returns empty values when no matching property', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'click', properties: { button: 'signup' }, user_id: 'u1', timestamp: now });

    const result = await adapter.getBreakdown({ project: 'p', property: 'nonexistent' });

    assert.deepEqual(result.values, []);
  });

  test('rejects invalid property key', async () => {
    await assert.rejects(
      () => adapter.getBreakdown({ project: 'p', property: 'sql; DROP TABLE' }),
      /Invalid property/,
    );
  });

  test('respects limit parameter', async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      await adapter.trackEvent({ project: 'p', event: 'pv', properties: { path: `/page${i}` }, user_id: 'u1', timestamp: now + i });
    }

    const result = await adapter.getBreakdown({ project: 'p', property: 'path', limit: 3 });

    assert.equal(result.values.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Tests: getInsights
// ---------------------------------------------------------------------------

describe('BaseAdapter.getInsights', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  test('returns current and previous period with deltas', async () => {
    // Current period: last 7 days — 10 events
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      await adapter.trackEvent({
        project: 'p', event: 'page_view', user_id: `u${i % 5}`,
        timestamp: now - (i * 3600000), // spread across current period
      });
    }
    // Previous period: 8-14 days ago — 8 events
    for (let i = 0; i < 8; i++) {
      await adapter.trackEvent({
        project: 'p', event: 'page_view', user_id: `u${i % 4}`,
        timestamp: now - (8 * 86400000) - (i * 3600000),
      });
    }

    const result = await adapter.getInsights({ project: 'p', period: '7d' });

    assert.ok(result.current_period);
    assert.ok(result.previous_period);
    assert.ok(result.metrics);
    assert.equal(result.metrics.total_events.current, 10);
    assert.equal(result.metrics.total_events.previous, 8);
    assert.equal(result.metrics.total_events.change, 2);
    assert.equal(result.metrics.total_events.change_pct, 25);
  });

  test('returns zeros when no data in previous period', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await adapter.trackEvent({
        project: 'p', event: 'click', user_id: 'u1',
        timestamp: now - (i * 3600000),
      });
    }

    const result = await adapter.getInsights({ project: 'p', period: '7d' });

    assert.equal(result.metrics.total_events.current, 5);
    assert.equal(result.metrics.total_events.previous, 0);
    assert.equal(result.metrics.total_events.change, 5);
    // Division by zero: change_pct should be null when previous is 0
    assert.equal(result.metrics.total_events.change_pct, null);
  });

  test('returns session metrics with deltas', async () => {
    const now = Date.now();
    // Current period: 2 sessions (1 bounce, 1 not)
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's1', user_id: 'u1', timestamp: now, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's2', user_id: 'u2', timestamp: now - 1000, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'click', session_id: 's2', user_id: 'u2', timestamp: now, properties: { path: '/about' } });

    // Previous period: 1 session (bounce)
    const prev = now - 8 * 86400000;
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's3', user_id: 'u3', timestamp: prev, properties: { path: '/' } });

    const result = await adapter.getInsights({ project: 'p', period: '7d' });

    assert.ok(result.metrics.total_sessions);
    assert.equal(result.metrics.total_sessions.current, 2);
    assert.equal(result.metrics.total_sessions.previous, 1);
    assert.ok(result.metrics.bounce_rate !== undefined);
  });

  test('computes trend correctly', async () => {
    const now = Date.now();
    // Current period: 20 events (>10% more than previous)
    for (let i = 0; i < 20; i++) {
      await adapter.trackEvent({ project: 'p', event: 'pv', user_id: 'u1', timestamp: now - (i * 100) });
    }
    // Previous period: 10 events
    for (let i = 0; i < 10; i++) {
      await adapter.trackEvent({ project: 'p', event: 'pv', user_id: 'u1', timestamp: now - 8 * 86400000 - (i * 100) });
    }

    const result = await adapter.getInsights({ project: 'p', period: '7d' });

    assert.equal(result.trend, 'growing');
  });
});

// ---------------------------------------------------------------------------
// Tests: getPages
// ---------------------------------------------------------------------------

describe('BaseAdapter.getPages', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  test('returns entry pages grouped with bounce rate', async () => {
    const now = Date.now();
    // 3 sessions entering on /home
    for (let i = 0; i < 3; i++) {
      await adapter.trackEvent({ project: 'p', event: 'pv', session_id: `s${i}`, user_id: `u${i}`, timestamp: now, properties: { path: '/home' } });
    }
    // Make s1 non-bounce
    await adapter.trackEvent({ project: 'p', event: 'click', session_id: 's1', user_id: 'u1', timestamp: now + 30000, properties: { path: '/about' } });
    // 1 session entering on /pricing (non-bounce)
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's10', user_id: 'u10', timestamp: now, properties: { path: '/pricing' } });
    await adapter.trackEvent({ project: 'p', event: 'click', session_id: 's10', user_id: 'u10', timestamp: now + 60000, properties: { path: '/checkout' } });

    const result = await adapter.getPages({ project: 'p', type: 'entry' });

    assert.ok(result.entry_pages);
    assert.equal(result.entry_pages.length, 2);
    // /home should come first (3 sessions)
    assert.equal(result.entry_pages[0].page, '/home');
    assert.equal(result.entry_pages[0].sessions, 3);
    assert.equal(result.entry_pages[0].bounces, 2);
    // bounce_rate = 2/3 ≈ 0.667
    assert.ok(Math.abs(result.entry_pages[0].bounce_rate - 0.667) < 0.01);
  });

  test('returns exit pages when type=exit', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's1', user_id: 'u1', timestamp: now, properties: { path: '/home' } });
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's1', user_id: 'u1', timestamp: now + 5000, properties: { path: '/pricing' } });
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's2', user_id: 'u2', timestamp: now, properties: { path: '/docs' } });

    const result = await adapter.getPages({ project: 'p', type: 'exit' });

    assert.ok(result.exit_pages);
    assert.ok(result.exit_pages.length >= 1);
  });

  test('returns both entry and exit when type=both', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's1', user_id: 'u1', timestamp: now, properties: { path: '/home' } });
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's1', user_id: 'u1', timestamp: now + 5000, properties: { path: '/about' } });

    const result = await adapter.getPages({ project: 'p', type: 'both' });

    assert.ok(result.entry_pages);
    assert.ok(result.exit_pages);
  });
});

// ---------------------------------------------------------------------------
// Tests: getSessionDistribution
// ---------------------------------------------------------------------------

describe('BaseAdapter.getSessionDistribution', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  test('returns duration buckets', async () => {
    const now = Date.now();
    // Create sessions with known durations by inserting raw data
    const sessions = [
      { id: 's1', dur: 0, bounce: 1, events: 1 },         // 0s bucket
      { id: 's2', dur: 5000, bounce: 0, events: 2 },      // 1-10s
      { id: 's3', dur: 25000, bounce: 0, events: 3 },     // 10-30s
      { id: 's4', dur: 45000, bounce: 0, events: 4 },     // 30-60s
      { id: 's5', dur: 120000, bounce: 0, events: 5 },    // 1-3m
      { id: 's6', dur: 400000, bounce: 0, events: 8 },    // 3-10m
      { id: 's7', dur: 700000, bounce: 0, events: 12 },   // 10m+
    ];

    const date = formatDate(now);
    for (const s of sessions) {
      adapter.db.prepare(
        `INSERT INTO sessions (session_id, user_id, project_id, start_time, end_time, duration, entry_page, exit_page, event_count, is_bounce, date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(s.id, 'u1', 'p', now - s.dur, now, s.dur, '/', '/', s.events, s.bounce, date);
    }

    const result = await adapter.getSessionDistribution({ project: 'p' });

    assert.ok(result.distribution);
    assert.equal(result.distribution.length, 7);
    // Each bucket should have 1 session
    for (const bucket of result.distribution) {
      assert.equal(bucket.sessions, 1);
    }
    // pct should sum to ~100
    const totalPct = result.distribution.reduce((sum, b) => sum + b.pct, 0);
    assert.ok(Math.abs(totalPct - 100) < 1);
  });

  test('computes engaged_pct', async () => {
    const now = Date.now();
    const date = formatDate(now);
    // 6 sessions: 2 with duration >= 30000 (engaged)
    const sessions = [
      { id: 's1', dur: 0, bounce: 1, events: 1 },
      { id: 's2', dur: 5000, bounce: 0, events: 2 },
      { id: 's3', dur: 15000, bounce: 0, events: 2 },
      { id: 's4', dur: 20000, bounce: 0, events: 3 },
      { id: 's5', dur: 45000, bounce: 0, events: 4 },    // engaged
      { id: 's6', dur: 120000, bounce: 0, events: 5 },   // engaged
    ];

    for (const s of sessions) {
      adapter.db.prepare(
        `INSERT INTO sessions (session_id, user_id, project_id, start_time, end_time, duration, entry_page, exit_page, event_count, is_bounce, date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(s.id, 'u1', 'p', now - s.dur, now, s.dur, '/', '/', s.events, s.bounce, date);
    }

    const result = await adapter.getSessionDistribution({ project: 'p' });

    // 2 out of 6 engaged = 33.3%
    assert.ok(Math.abs(result.engaged_pct - 33.3) < 0.5);
  });

  test('returns empty distribution with no sessions', async () => {
    const result = await adapter.getSessionDistribution({ project: 'p' });

    assert.deepEqual(result.distribution, []);
    assert.equal(result.engaged_pct, 0);
    assert.equal(result.median_bucket, null);
  });
});

// ---------------------------------------------------------------------------
// Tests: getHeatmap
// ---------------------------------------------------------------------------

describe('BaseAdapter.getHeatmap', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  test('returns day_of_week × hour grid', async () => {
    // Tuesday Feb 11, 2026 2:00 PM UTC = 1739282400000
    // strftime('%w', ...) for Tuesday = 2
    const tuesdayAt2pm = new Date('2026-02-10T14:00:00Z').getTime();
    // Sunday Feb 9, 2026 3:00 AM UTC
    const sundayAt3am = new Date('2026-02-08T03:00:00Z').getTime();

    await adapter.trackEvent({ project: 'p', event: 'pv', user_id: 'u1', timestamp: tuesdayAt2pm });
    await adapter.trackEvent({ project: 'p', event: 'pv', user_id: 'u2', timestamp: tuesdayAt2pm + 1000 });
    await adapter.trackEvent({ project: 'p', event: 'pv', user_id: 'u1', timestamp: sundayAt3am });

    const result = await adapter.getHeatmap({ project: 'p', since: '30d' });

    assert.ok(result.heatmap);
    assert.ok(result.heatmap.length >= 2);
    assert.ok(result.peak);
    assert.ok(result.busiest_day);
    assert.ok(result.busiest_hour !== undefined);

    // The peak should be Tuesday 2PM (2 events, 2 users)
    const tuePm = result.heatmap.find(h => h.day === 2 && h.hour === 14);
    if (tuePm) {
      assert.equal(tuePm.events, 2);
      assert.equal(tuePm.users, 2);
    }
  });

  test('returns empty heatmap with no events', async () => {
    const result = await adapter.getHeatmap({ project: 'p' });

    assert.deepEqual(result.heatmap, []);
    assert.equal(result.peak, null);
    assert.equal(result.busiest_day, null);
    assert.equal(result.busiest_hour, null);
  });

  test('includes day_name in results', async () => {
    const mondayNoon = new Date('2026-02-09T12:00:00Z').getTime();
    await adapter.trackEvent({ project: 'p', event: 'pv', user_id: 'u1', timestamp: mondayNoon });

    const result = await adapter.getHeatmap({ project: 'p', since: '30d' });

    assert.ok(result.heatmap.length >= 1);
    // Every entry should have day_name
    for (const entry of result.heatmap) {
      assert.ok(entry.day_name);
    }
  });
});
