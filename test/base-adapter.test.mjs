/**
 * Contract tests for BaseAdapter.
 *
 * Uses a MockAdapter backed by better-sqlite3 :memory: that implements
 * the 4 primitive methods (_run, _queryAll, _queryOne, _batch).
 * Every public method on BaseAdapter is tested through this mock.
 */
import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { BaseAdapter } from '../src/db/base-adapter.js';
import { ERROR_CODES } from '../src/errors.js';

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
// Tests
// ---------------------------------------------------------------------------

describe('BaseAdapter contract', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  // --- Abstract methods ---

  test('abstract methods throw when not overridden', async () => {
    const base = new BaseAdapter();
    await assert.rejects(() => base._run('', []), /not implemented/);
    await assert.rejects(() => base._queryAll('', []), /not implemented/);
    await assert.rejects(() => base._queryOne('', []), /not implemented/);
    await assert.rejects(() => base._batch([]), /not implemented/);
  });

  // --- trackEvent ---

  test('trackEvent inserts event without session', async () => {
    await adapter.trackEvent({
      project: 'p1', event: 'click', user_id: 'u1', timestamp: 1000000,
    });
    const rows = adapter.db.prepare('SELECT * FROM events').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].project_id, 'p1');
    assert.equal(rows[0].event, 'click');
    assert.equal(rows[0].session_id, null);
    // No session created
    assert.equal(adapter.db.prepare('SELECT * FROM sessions').all().length, 0);
  });

  test('trackEvent inserts event + upserts session atomically', async () => {
    await adapter.trackEvent({
      project: 'p1', event: 'page_view', user_id: 'u1',
      session_id: 'sess1', timestamp: 1000000,
      properties: { path: '/home' },
    });
    const events = adapter.db.prepare('SELECT * FROM events').all();
    assert.equal(events.length, 1);
    assert.equal(events[0].session_id, 'sess1');

    const sessions = adapter.db.prepare('SELECT * FROM sessions').all();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].session_id, 'sess1');
    assert.equal(sessions[0].entry_page, '/home');
    assert.equal(sessions[0].is_bounce, 1);
  });

  test('trackEvent updates session on second event', async () => {
    await adapter.trackEvent({
      project: 'p1', event: 'page_view', user_id: 'u1',
      session_id: 'sess1', timestamp: 1000000,
      properties: { path: '/home' },
    });
    await adapter.trackEvent({
      project: 'p1', event: 'click', user_id: 'u1',
      session_id: 'sess1', timestamp: 1060000,
      properties: { path: '/about' },
    });
    const s = adapter.db.prepare('SELECT * FROM sessions').all();
    assert.equal(s.length, 1);
    assert.equal(s[0].event_count, 2);
    assert.equal(s[0].is_bounce, 0);
    assert.equal(s[0].exit_page, '/about');
    assert.equal(s[0].duration, 60000);
  });

  test('trackEvent stores properties as JSON', async () => {
    await adapter.trackEvent({
      project: 'p1', event: 'click', properties: { button: 'signup', page: 3 },
      timestamp: 1000000,
    });
    const row = adapter.db.prepare('SELECT properties FROM events').get();
    const parsed = JSON.parse(row.properties);
    assert.deepEqual(parsed, { button: 'signup', page: 3 });
  });

  // --- trackBatch ---

  test('trackBatch inserts multiple events + sessions', async () => {
    await adapter.trackBatch([
      { project: 'p1', event: 'page_view', session_id: 'sA', user_id: 'u1', timestamp: 1000000, properties: { path: '/a' } },
      { project: 'p1', event: 'click', session_id: 'sA', user_id: 'u1', timestamp: 1010000, properties: { path: '/b' } },
      { project: 'p1', event: 'page_view', session_id: 'sB', user_id: 'u2', timestamp: 2000000, properties: { path: '/x' } },
      { project: 'p1', event: 'click', user_id: 'u3', timestamp: 3000000 },
    ]);
    assert.equal(adapter.db.prepare('SELECT COUNT(*) as c FROM events').get().c, 4);
    const sessions = adapter.db.prepare('SELECT * FROM sessions ORDER BY session_id').all();
    assert.equal(sessions.length, 2);
    const sA = sessions.find(s => s.session_id === 'sA');
    assert.equal(sA.event_count, 2);
    assert.equal(sA.is_bounce, 0);
    const sB = sessions.find(s => s.session_id === 'sB');
    assert.equal(sB.event_count, 1);
    assert.equal(sB.is_bounce, 1);
  });

  // --- upsertSession ---

  test('upsertSession creates and updates session', async () => {
    await adapter.upsertSession({
      project_id: 'p1', session_id: 'sess1', user_id: 'u1',
      timestamp: 1000000, properties: { path: '/home' },
    });
    let s = adapter.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('sess1');
    assert.equal(s.entry_page, '/home');

    await adapter.upsertSession({
      project_id: 'p1', session_id: 'sess1', user_id: 'u1',
      timestamp: 1060000, properties: { path: '/about' },
    });
    s = adapter.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('sess1');
    assert.equal(s.event_count, 2);
    assert.equal(s.exit_page, '/about');
  });

  // --- getSessions ---

  test('getSessions returns sessions with filters', async () => {
    await adapter.trackEvent({ project: 'p1', event: 'pv', session_id: 's1', user_id: 'u1', timestamp: Date.now(), properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p1', event: 'pv', session_id: 's2', user_id: 'u2', timestamp: Date.now(), properties: { path: '/' } });

    const all = await adapter.getSessions({ project: 'p1' });
    assert.equal(all.length, 2);

    const filtered = await adapter.getSessions({ project: 'p1', user_id: 'u1' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].user_id, 'u1');
  });

  test('getSessions filters by is_bounce', async () => {
    await adapter.trackEvent({ project: 'p1', event: 'pv', session_id: 's1', user_id: 'u1', timestamp: Date.now(), properties: { path: '/' } });
    // s1 is a bounce (1 event)
    await adapter.trackEvent({ project: 'p1', event: 'pv', session_id: 's2', user_id: 'u2', timestamp: Date.now(), properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p1', event: 'click', session_id: 's2', user_id: 'u2', timestamp: Date.now() + 1000, properties: { path: '/' } });
    // s2 is not a bounce (2 events)

    const bounces = await adapter.getSessions({ project: 'p1', is_bounce: 1 });
    assert.equal(bounces.length, 1);
    assert.equal(bounces[0].session_id, 's1');

    const nonBounces = await adapter.getSessions({ project: 'p1', is_bounce: 0 });
    assert.equal(nonBounces.length, 1);
    assert.equal(nonBounces[0].session_id, 's2');
  });

  // --- getSessionStats ---

  test('getSessionStats computes metrics correctly', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's1', user_id: 'u1', timestamp: now, properties: { path: '/a' } });
    await adapter.trackEvent({ project: 'p', event: 'click', session_id: 's1', user_id: 'u1', timestamp: now + 60000, properties: { path: '/b' } });
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's2', user_id: 'u2', timestamp: now, properties: { path: '/c' } });

    const stats = await adapter.getSessionStats({ project: 'p' });
    assert.equal(stats.total_sessions, 2);
    assert.ok(Math.abs(stats.bounce_rate - 0.5) < 0.01);
    assert.equal(stats.avg_duration, 30000); // (60000 + 0) / 2
  });

  test('getSessionStats returns zeros when no sessions', async () => {
    const stats = await adapter.getSessionStats({ project: 'p' });
    assert.equal(stats.total_sessions, 0);
    assert.equal(stats.bounce_rate, 0);
    assert.equal(stats.avg_duration, 0);
  });

  // --- cleanupSessions ---

  test('cleanupSessions deletes old sessions', async () => {
    const old = new Date('2024-01-01').getTime();
    const recent = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's_old', user_id: 'u1', timestamp: old, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's_new', user_id: 'u1', timestamp: recent, properties: { path: '/' } });

    await adapter.cleanupSessions({ project: 'p', before_date: '2025-01-01' });
    const sessions = adapter.db.prepare('SELECT * FROM sessions').all();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].session_id, 's_new');
  });

  // --- getStats ---

  test('getStats returns aggregated overview', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'page_view', user_id: 'u1', timestamp: now, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u1', timestamp: now + 1000 });
    await adapter.trackEvent({ project: 'p', event: 'page_view', user_id: 'u2', timestamp: now + 2000 });

    const result = await adapter.getStats({ project: 'p' });
    assert.ok(result.period);
    assert.ok(result.totals);
    assert.equal(result.totals.total_events, 3);
    assert.equal(result.totals.unique_users, 2);
    assert.ok(Array.isArray(result.timeSeries));
    assert.ok(Array.isArray(result.events));
    assert.ok(result.sessions);
  });

  // --- getEvents ---

  test('getEvents returns events with parsed properties', async () => {
    await adapter.trackEvent({ project: 'p', event: 'click', properties: { button: 'signup' }, user_id: 'u1', timestamp: Date.now() });
    await adapter.trackEvent({ project: 'p', event: 'page_view', properties: { path: '/home' }, user_id: 'u1', timestamp: Date.now() });

    const all = await adapter.getEvents({ project: 'p' });
    assert.equal(all.length, 2);
    assert.equal(typeof all[0].properties, 'object');
  });

  test('getEvents filters by event name', async () => {
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u1', timestamp: Date.now() });
    await adapter.trackEvent({ project: 'p', event: 'page_view', user_id: 'u1', timestamp: Date.now() });

    const filtered = await adapter.getEvents({ project: 'p', event: 'click' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].event, 'click');
  });

  test('getEvents filters by session_id', async () => {
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's1', user_id: 'u1', timestamp: Date.now(), properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's2', user_id: 'u1', timestamp: Date.now(), properties: { path: '/' } });

    const filtered = await adapter.getEvents({ project: 'p', session_id: 's1' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].session_id, 's1');
  });

  // --- query ---

  test('query returns results with default metrics', async () => {
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u1', timestamp: Date.now() });
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u2', timestamp: Date.now() });

    const result = await adapter.query({ project: 'p' });
    assert.ok(result.period);
    assert.ok(result.rows);
    assert.equal(result.rows[0].event_count, 2);
  });

  test('query supports group_by and multiple metrics', async () => {
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u1', timestamp: Date.now() });
    await adapter.trackEvent({ project: 'p', event: 'page_view', user_id: 'u1', timestamp: Date.now() });
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u2', timestamp: Date.now() });

    const result = await adapter.query({
      project: 'p',
      metrics: ['event_count', 'unique_users'],
      group_by: ['event'],
    });
    assert.ok(result.rows.length >= 2);
    const clickRow = result.rows.find(r => r.event === 'click');
    assert.equal(clickRow.event_count, 2);
    assert.equal(clickRow.unique_users, 2);
  });

  test('query supports filters', async () => {
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u1', timestamp: Date.now() });
    await adapter.trackEvent({ project: 'p', event: 'page_view', user_id: 'u1', timestamp: Date.now() });

    const result = await adapter.query({
      project: 'p',
      filters: [{ field: 'event', op: 'eq', value: 'click' }],
    });
    assert.equal(result.rows[0].event_count, 1);
  });

  test('query supports property filters', async () => {
    await adapter.trackEvent({ project: 'p', event: 'click', properties: { button: 'signup' }, user_id: 'u1', timestamp: Date.now() });
    await adapter.trackEvent({ project: 'p', event: 'click', properties: { button: 'login' }, user_id: 'u2', timestamp: Date.now() });

    const result = await adapter.query({
      project: 'p',
      filters: [{ field: 'properties.button', op: 'eq', value: 'signup' }],
    });
    assert.equal(result.rows[0].event_count, 1);
  });

  test('query timestamp gte filter uses exact epoch-ms cutoff', async () => {
    const cutoff = '2026-04-13T22:06:23Z';
    await adapter.trackEvent({ project: 'p', event: 'login', user_id: 'before', timestamp: Date.parse('2026-04-13T21:35:09Z') });
    await adapter.trackEvent({ project: 'p', event: 'login', user_id: 'after-1', timestamp: Date.parse('2026-04-14T10:51:25Z') });
    await adapter.trackEvent({ project: 'p', event: 'login', user_id: 'after-2', timestamp: Date.parse('2026-04-14T16:58:28Z') });

    const result = await adapter.query({
      project: 'p',
      metrics: ['event_count', 'unique_users'],
      date_from: '2026-04-13',
      date_to: '2026-04-14',
      filters: [
        { field: 'event', op: 'eq', value: 'login' },
        { field: 'timestamp', op: 'gte', value: cutoff },
      ],
    });

    assert.equal(result.rows[0].event_count, 2);
    assert.equal(result.rows[0].unique_users, 2);
  });

  test('query defaults event_count to raw rows for lifecycle events', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'project_created', user_id: 'u1', session_id: 's1', timestamp: now, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'project_created', user_id: 'u1', session_id: 's1', timestamp: now + 1, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'login', user_id: 'u2', timestamp: now + 2 });
    await adapter.trackEvent({ project: 'p', event: 'login', user_id: 'u2', timestamp: now + 3 });

    const projectCreated = await adapter.query({
      project: 'p',
      filters: [{ field: 'event', op: 'eq', value: 'project_created' }],
    });
    const login = await adapter.query({
      project: 'p',
      filters: [{ field: 'event', op: 'eq', value: 'login' }],
    });

    assert.equal(projectCreated.rows[0].event_count, 2);
    assert.equal(login.rows[0].event_count, 2);
  });

  test('query supports explicit session_then_user count_mode for event_count', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'project_created', user_id: 'u1', session_id: 's1', timestamp: now, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'project_created', user_id: 'u1', session_id: 's1', timestamp: now + 1, properties: { path: '/' } });

    const result = await adapter.query({
      project: 'p',
      metrics: ['event_count'],
      filters: [{ field: 'event', op: 'eq', value: 'project_created' }],
      count_mode: 'session_then_user',
    });
    assert.equal(result.rows[0].event_count, 1);
  });

  test('query supports explicit user_id dedupe when session_id is missing', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'api_key_generated', user_id: 'u1', timestamp: now });
    await adapter.trackEvent({ project: 'p', event: 'api_key_generated', user_id: 'u1', timestamp: now + 1 });

    const result = await adapter.query({
      project: 'p',
      filters: [{ field: 'event', op: 'eq', value: 'api_key_generated' }],
      count_mode: 'session_then_user',
    });
    assert.equal(result.rows[0].event_count, 1);
  });

  test('query collapses mixed session and no-session duplicates for the same user', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'project_created', user_id: 'u1', session_id: 's1', timestamp: now, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'project_created', user_id: 'u1', timestamp: now + 1, properties: { path: '/' } });

    const deduped = await adapter.query({
      project: 'p',
      metrics: ['event_count'],
      group_by: ['event'],
      filters: [{ field: 'event', op: 'eq', value: 'project_created' }],
      count_mode: 'session_then_user',
    });
    const raw = await adapter.query({
      project: 'p',
      metrics: ['event_count'],
      group_by: ['event'],
      filters: [{ field: 'event', op: 'eq', value: 'project_created' }],
      count_mode: 'raw',
    });

    assert.equal(deduped.rows[0].event_count, 1);
    assert.equal(raw.rows[0].event_count, 2);
  });

  test('query counts distinct sessions and suppresses no-session fallback when sessions exist for that user', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'project_created', user_id: 'u1', session_id: 's1', timestamp: now, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'project_created', user_id: 'u1', session_id: 's2', timestamp: now + 1, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'project_created', user_id: 'u1', timestamp: now + 2, properties: { path: '/' } });

    const result = await adapter.query({
      project: 'p',
      metrics: ['event_count'],
      filters: [{ field: 'event', op: 'eq', value: 'project_created' }],
      count_mode: 'session_then_user',
    });

    assert.equal(result.rows[0].event_count, 2);
  });

  test('query falls back to raw row identity when session_id and user_id are missing', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'anonymous_activation', timestamp: now });
    await adapter.trackEvent({ project: 'p', event: 'anonymous_activation', timestamp: now + 1 });

    const result = await adapter.query({
      project: 'p',
      filters: [{ field: 'event', op: 'eq', value: 'anonymous_activation' }],
    });
    assert.equal(result.rows[0].event_count, 2);
  });

  test('query dedupes event_count within each group when session_then_user is explicit', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'project_created', user_id: 'u1', session_id: 's1', timestamp: now, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'project_created', user_id: 'u1', session_id: 's1', timestamp: now + 1, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'api_key_generated', user_id: 'u1', session_id: 's1', timestamp: now + 2, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'api_key_generated', user_id: 'u2', session_id: 's2', timestamp: now + 3, properties: { path: '/' } });

    const result = await adapter.query({
      project: 'p',
      group_by: ['event'],
      order_by: 'event',
      order: 'asc',
      count_mode: 'session_then_user',
    });
    const created = result.rows.find(r => r.event === 'project_created');
    const keyGenerated = result.rows.find(r => r.event === 'api_key_generated');
    assert.equal(created.event_count, 1);
    assert.equal(keyGenerated.event_count, 2);
  });

  test('query keeps mixed session and no-session rows separate when group_by includes session_id', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'project_created', user_id: 'u1', session_id: 's1', timestamp: now, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'project_created', user_id: 'u1', timestamp: now + 1, properties: { path: '/' } });

    const result = await adapter.query({
      project: 'p',
      metrics: ['event_count'],
      group_by: ['session_id'],
      order_by: 'session_id',
      order: 'asc',
      count_mode: 'session_then_user',
    });

    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].session_id, null);
    assert.equal(result.rows[0].event_count, 1);
    assert.equal(result.rows[1].session_id, 's1');
    assert.equal(result.rows[1].event_count, 1);
  });

  test('query rejects invalid metric', async () => {
    await assert.rejects(
      () => adapter.query({ project: 'p', metrics: ['bogus'] }),
      /invalid metric/,
    );
  });

  test('query rejects invalid group_by', async () => {
    await assert.rejects(
      () => adapter.query({ project: 'p', group_by: ['bogus'] }),
      /invalid group_by/,
    );
  });

  // --- listProjects ---

  test('listProjects returns projects from events', async () => {
    await adapter.trackEvent({ project: 'p1', event: 'click', user_id: 'u1', timestamp: Date.now() });
    await adapter.trackEvent({ project: 'p2', event: 'click', user_id: 'u1', timestamp: Date.now() });

    const projects = await adapter.listProjects();
    assert.equal(projects.length, 2);
    assert.ok(projects.some(p => p.id === 'p1'));
    assert.ok(projects.some(p => p.id === 'p2'));
    assert.ok(projects[0].event_count);
  });

  // --- getProperties ---

  test('getProperties returns event names and property keys', async () => {
    await adapter.trackEvent({ project: 'p', event: 'click', properties: { button: 'signup', page: 1 }, user_id: 'u1', timestamp: Date.now() });
    await adapter.trackEvent({ project: 'p', event: 'page_view', properties: { path: '/home' }, user_id: 'u1', timestamp: Date.now() });

    const result = await adapter.getProperties({ project: 'p' });
    assert.ok(Array.isArray(result.events));
    assert.ok(result.events.length >= 2);
    assert.ok(Array.isArray(result.property_keys));
    assert.ok(result.property_keys.includes('button'));
    assert.ok(result.property_keys.includes('path'));
    assert.ok(result.property_keys.includes('page'));
  });

  // --- getPropertiesReceived ---

  test('getPropertiesReceived maps property keys to events', async () => {
    await adapter.trackEvent({ project: 'p', event: 'click', properties: { button: 'signup' }, user_id: 'u1', timestamp: Date.now() });
    await adapter.trackEvent({ project: 'p', event: 'page_view', properties: { path: '/home' }, user_id: 'u1', timestamp: Date.now() });

    const result = await adapter.getPropertiesReceived({ project: 'p' });
    assert.ok(result.sample_size);
    assert.ok(Array.isArray(result.properties));
    assert.ok(result.properties.some(p => p.key === 'button' && p.event === 'click'));
    assert.ok(result.properties.some(p => p.key === 'path' && p.event === 'page_view'));
  });

  // --- query: contains filter ---

  test('query supports contains filter op', async () => {
    await adapter.trackEvent({ project: 'p', event: 'page_view', user_id: 'u1', timestamp: Date.now() });
    await adapter.trackEvent({ project: 'p', event: 'page_exit', user_id: 'u1', timestamp: Date.now() });
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u2', timestamp: Date.now() });

    const result = await adapter.query({
      project: 'p',
      count_mode: 'raw',
      filters: [{ field: 'event', op: 'contains', value: 'page' }],
    });
    assert.equal(result.rows[0].event_count, 2);
  });

  test('query supports contains filter on properties', async () => {
    await adapter.trackEvent({ project: 'p', event: 'click', properties: { path: '/blog/post-1' }, user_id: 'u1', timestamp: Date.now() });
    await adapter.trackEvent({ project: 'p', event: 'click', properties: { path: '/pricing' }, user_id: 'u2', timestamp: Date.now() });

    const result = await adapter.query({
      project: 'p',
      filters: [{ field: 'properties.path', op: 'contains', value: 'blog' }],
    });
    assert.equal(result.rows[0].event_count, 1);
  });

  // --- query: session_id and timestamp as filterable fields ---

  test('query accepts session_id as filter field', async () => {
    await adapter.trackEvent({ project: 'p', event: 'click', session_id: 'sess-abc', user_id: 'u1', timestamp: Date.now(), properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'click', session_id: 'sess-xyz', user_id: 'u2', timestamp: Date.now(), properties: { path: '/' } });

    const result = await adapter.query({
      project: 'p',
      filters: [{ field: 'session_id', op: 'eq', value: 'sess-abc' }],
    });
    assert.equal(result.rows[0].event_count, 1);
  });

  test('query accepts timestamp as filter field', async () => {
    const now = Date.now();
    const t1 = now - 1000;
    const t2 = now;
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u1', timestamp: t1 });
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u2', timestamp: t2 });

    const result = await adapter.query({
      project: 'p',
      filters: [{ field: 'timestamp', op: 'gte', value: t2 }],
    });
    assert.equal(result.rows[0].event_count, 1);
  });

  test('query accepts numeric string timestamp filters', async () => {
    const t1 = 1774526399000;
    const t2 = 1774526400000;
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u1', timestamp: t1 });
    await adapter.trackEvent({ project: 'p', event: 'signup', user_id: 'u2', timestamp: t2 });

    const result = await adapter.query({
      project: 'p',
      date_from: '2026-03-26',
      filters: [{ field: 'timestamp', op: 'gte', value: String(t2) }],
    });
    assert.equal(result.rows[0].event_count, 1);
  });

  test('query accepts ISO string timestamp filters', async () => {
    const t1 = Date.parse('2026-03-26T11:59:59Z');
    const t2 = Date.parse('2026-03-26T12:00:00Z');
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u1', timestamp: t1 });
    await adapter.trackEvent({ project: 'p', event: 'signup', user_id: 'u2', timestamp: t2 });

    const result = await adapter.query({
      project: 'p',
      date_from: '2026-03-26',
      group_by: ['event'],
      filters: [{ field: 'timestamp', op: 'gte', value: '2026-03-26T12:00:00Z' }],
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].event, 'signup');
    assert.equal(result.rows[0].event_count, 1);
  });

  test('query rejects invalid timestamp filters', async () => {
    await assert.rejects(
      () => adapter.query({
        project: 'p',
        filters: [{ field: 'timestamp', op: 'gte', value: 'not-a-date' }],
      }),
      (err) => err.code === ERROR_CODES.INVALID_BODY && err.status === 400,
    );
  });

  // --- query: country in group_by ---

  test('query supports country in group_by', async () => {
    // Insert events with country directly into DB
    const now = Date.now();
    const date = new Date(now).toISOString().split('T')[0];
    adapter.db.prepare(
      `INSERT INTO events (id, project_id, event, user_id, timestamp, date, country) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('e1', 'p', 'click', 'u1', now, date, 'US');
    adapter.db.prepare(
      `INSERT INTO events (id, project_id, event, user_id, timestamp, date, country) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('e2', 'p', 'click', 'u2', now, date, 'US');
    adapter.db.prepare(
      `INSERT INTO events (id, project_id, event, user_id, timestamp, date, country) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('e3', 'p', 'click', 'u3', now, date, 'DE');

    const result = await adapter.query({
      project: 'p',
      metrics: ['event_count'],
      group_by: ['country'],
    });
    assert.ok(result.rows.length >= 2);
    const usRow = result.rows.find(r => r.country === 'US');
    assert.equal(usRow.event_count, 2);
    const deRow = result.rows.find(r => r.country === 'DE');
    assert.equal(deRow.event_count, 1);
  });

  // --- query: session_count in order_by ---

  test('query supports session_count in order_by', async () => {
    await adapter.trackEvent({ project: 'p', event: 'click', session_id: 'sA', user_id: 'u1', timestamp: Date.now(), properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'click', session_id: 'sB', user_id: 'u1', timestamp: Date.now(), properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'page_view', session_id: 'sC', user_id: 'u2', timestamp: Date.now(), properties: { path: '/' } });

    const result = await adapter.query({
      project: 'p',
      metrics: ['session_count'],
      group_by: ['event'],
      order_by: 'session_count',
      order: 'desc',
    });
    assert.ok(result.rows.length >= 2);
    // click has 2 sessions, page_view has 1
    assert.equal(result.rows[0].event, 'click');
    assert.equal(result.rows[0].session_count, 2);
  });

  // --- query: invalid contains still validates ---

  test('query with unique_users only does not ORDER BY event_count', async () => {
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u1', timestamp: Date.now() });
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u2', timestamp: Date.now() });

    // Should not throw — when metrics=["unique_users"], ORDER BY should use unique_users
    const result = await adapter.query({
      project: 'p',
      metrics: ['unique_users'],
    });
    assert.equal(result.rows[0].unique_users, 2);
  });

  test('query with session_count only does not ORDER BY event_count', async () => {
    await adapter.trackEvent({ project: 'p', event: 'click', session_id: 'sA', user_id: 'u1', timestamp: Date.now(), properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'click', session_id: 'sB', user_id: 'u2', timestamp: Date.now(), properties: { path: '/' } });

    const result = await adapter.query({
      project: 'p',
      metrics: ['session_count'],
    });
    assert.equal(result.rows[0].session_count, 2);
  });

  test('query ignores count_mode when event_count is not requested', async () => {
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u1', timestamp: Date.now() });
    await adapter.trackEvent({ project: 'p', event: 'click', user_id: 'u2', timestamp: Date.now() });

    const result = await adapter.query({
      project: 'p',
      metrics: ['unique_users'],
      count_mode: 'session_then_user',
    });
    assert.equal(result.rows[0].unique_users, 2);
  });

  test('query rejects invalid filter op', async () => {
    await assert.rejects(
      () => adapter.query({ project: 'p', filters: [{ field: 'event', op: 'like', value: 'x' }] }),
      /invalid filter op/,
    );
  });

  test('query rejects bare property fields and returns properties guidance', async () => {
    await adapter.trackEvent({
      project: 'p',
      event: 'page_view',
      properties: { referrer: 'https://clawflows.com/', utm_source: 'clawflows' },
      user_id: 'u1',
      timestamp: Date.now(),
    });

    await assert.rejects(
      async () => adapter.query({ project: 'p', filters: [{ field: 'referrer', op: 'contains', value: 'clawflows.com' }] }),
      (err) => {
        assert.equal(err.code, ERROR_CODES.INVALID_FILTER_FIELD);
        assert.match(err.message, /properties\.referrer/);
        assert.equal(err.details.suggested_field, 'properties.referrer');
        assert.deepEqual(err.details.available_properties.property_keys, ['referrer', 'utm_source']);
        return true;
      },
    );
  });

  test('query rejects filters missing field, op, or value', async () => {
    await adapter.trackEvent({
      project: 'p',
      event: 'page_view',
      properties: { path: '/' },
      user_id: 'u1',
      timestamp: Date.now(),
    });

    await assert.rejects(
      async () => adapter.query({ project: 'p', filters: [{ property: 'path', value: '/' }] }),
      (err) => {
        assert.equal(err.code, ERROR_CODES.INVALID_FILTER_FIELD);
        assert.match(err.message, /must include field, op, and value/);
        assert.deepEqual(err.details.available_properties.property_keys, ['path']);
        return true;
      },
    );
  });
});
