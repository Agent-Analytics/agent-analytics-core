import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import { D1Adapter } from '../src/db/d1.js';
import { createAnalyticsHandler } from '../src/handler.js';

// ---------------------------------------------------------------------------
// In-memory SQLite-like mock for D1
// ---------------------------------------------------------------------------

class MockD1 {
  constructor() {
    this.tables = { events: [], sessions: [] };
  }

  prepare(sql) {
    const self = this;
    return {
      bind(...params) {
        // Return a NEW bound statement (like real D1)
        return {
          bind(...p) { return this.constructor ? self.prepare(sql).bind(...p) : this; },
          async run() { return self._exec(sql, params); },
          async first() {
            const r = self._exec(sql, params);
            return r.results ? r.results[0] || null : null;
          },
          async all() { return self._exec(sql, params); },
        };
      },
      async run() { return self._exec(sql, []); },
      async first() {
        const r = self._exec(sql, []);
        return r.results ? r.results[0] || null : null;
      },
      async all() { return self._exec(sql, []); },
    };
  }

  async batch(stmts) {
    const results = [];
    for (const s of stmts) {
      results.push(await s.run());
    }
    return results;
  }

  _exec(sql, params) {
    const trimmed = sql.trim().replace(/\s+/g, ' ');

    // INSERT INTO events
    if (/^INSERT INTO events/i.test(trimmed)) {
      const row = {
        id: params[0], project_id: params[1], event: params[2],
        properties: params[3], user_id: params[4], session_id: params[5],
        timestamp: params[6], date: params[7],
      };
      this.tables.events.push(row);
      return { success: true };
    }

    // INSERT INTO sessions ... ON CONFLICT
    if (/^INSERT INTO sessions/i.test(trimmed)) {
      return this._upsertSession(params);
    }

    // DELETE FROM sessions
    if (/^DELETE FROM sessions/i.test(trimmed)) {
      const project = params[0];
      const before = params[1];
      const before_count = this.tables.sessions.length;
      this.tables.sessions = this.tables.sessions.filter(
        s => !(s.project_id === project && s.date < before)
      );
      return { success: true, changes: before_count - this.tables.sessions.length };
    }

    // SELECT queries on sessions
    if (/FROM sessions/i.test(trimmed)) {
      return this._querySessionsTable(trimmed, params);
    }

    // SELECT queries on events
    if (/FROM events/i.test(trimmed)) {
      return this._queryEventsTable(trimmed, params);
    }

    return { results: [], success: true };
  }

  _upsertSession(params) {
    // SQL: VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?)
    // 9 params: session_id, user_id, project_id, start_time, end_time, entry_page, exit_page, event_count, date
    const data = {
      session_id: params[0], user_id: params[1], project_id: params[2],
      start_time: params[3], end_time: params[4], duration: 0,
      entry_page: params[5], exit_page: params[6],
      event_count: params[7], is_bounce: 1, date: params[8],
    };

    const idx = this.tables.sessions.findIndex(s => s.session_id === data.session_id);
    if (idx === -1) {
      this.tables.sessions.push({ ...data });
    } else {
      const existing = this.tables.sessions[idx];
      const oldStart = existing.start_time;
      const oldEnd = existing.end_time;
      const newStart = Math.min(oldStart, data.start_time);
      const newEnd = Math.max(oldEnd, data.end_time);
      const newCount = existing.event_count + data.event_count;
      existing.start_time = newStart;
      existing.end_time = newEnd;
      existing.duration = newEnd - newStart;
      existing.event_count = newCount;
      existing.is_bounce = newCount > 1 ? 0 : 1;
      // entry_page: update if new event is earlier
      if (data.start_time < oldStart) {
        existing.entry_page = data.entry_page;
      }
      // exit_page: update if new event is later or equal
      if (data.end_time >= oldEnd) {
        existing.exit_page = data.exit_page;
      }
      if (data.date < existing.date) existing.date = data.date;
    }
    return { success: true };
  }

  _querySessionsTable(sql, params) {
    let rows = [...this.tables.sessions];

    // Aggregate queries
    if (/COUNT\(\*\) as total_sessions/i.test(sql)) {
      const project = params[0];
      const fromDate = params[1];
      const filtered = rows.filter(s => s.project_id === project && s.date >= fromDate);
      const total = filtered.length;
      const bounced = filtered.filter(s => s.is_bounce === 1).length;
      const totalDuration = filtered.reduce((sum, s) => sum + s.duration, 0);
      const totalEvents = filtered.reduce((sum, s) => sum + s.event_count, 0);
      const uniqueUsers = new Set(filtered.map(s => s.user_id).filter(Boolean)).size;
      return {
        results: [{
          total_sessions: total,
          bounced_sessions: bounced,
          total_duration: totalDuration,
          total_events: totalEvents,
          unique_users: uniqueUsers || 1,
        }],
      };
    }

    // List sessions
    const project = params[0];
    const fromDate = params[1];
    rows = rows.filter(s => s.project_id === project && s.date >= fromDate);
    let paramIdx = 2;

    // user_id filter
    if (/user_id = \?/i.test(sql)) {
      rows = rows.filter(s => s.user_id === params[paramIdx++]);
    }

    // is_bounce filter
    if (/is_bounce = \?/i.test(sql)) {
      rows = rows.filter(s => s.is_bounce === params[paramIdx++]);
    }

    rows.sort((a, b) => b.start_time - a.start_time);

    // LIMIT
    if (/LIMIT \?/i.test(sql)) {
      rows = rows.slice(0, params[paramIdx]);
    }

    return { results: rows };
  }

  _queryEventsTable(sql, params) {
    let rows = [...this.tables.events];
    let paramIdx = 0;

    // project_id filter
    if (/project_id = \?/i.test(sql)) {
      const val = params[paramIdx++];
      rows = rows.filter(r => r.project_id === val);
    }
    // date filter
    if (/date >= \?/i.test(sql)) {
      const d = params[paramIdx++];
      rows = rows.filter(r => r.date >= d);
    }
    if (/date <= \?/i.test(sql)) {
      const d = params[paramIdx++];
      rows = rows.filter(r => r.date <= d);
    }
    // event filter
    if (/AND event = \?/i.test(sql)) {
      const val = params[paramIdx++];
      rows = rows.filter(r => r.event === val);
    }
    // session_id filter
    if (/AND session_id = \?/i.test(sql)) {
      const sid = params[paramIdx++];
      rows = rows.filter(r => r.session_id === sid);
    }

    // COUNT queries
    if (/COUNT\(\*\) as event_count/i.test(sql)) {
      return { results: [{ event_count: rows.length }] };
    }
    if (/COUNT\(DISTINCT user_id\) as unique_users.*COUNT\(\*\) as total_events/i.test(sql)) {
      const uu = new Set(rows.map(r => r.user_id).filter(Boolean)).size;
      return { results: [{ unique_users: uu, total_events: rows.length }] };
    }
    if (/COUNT\(\*\) as total_events/i.test(sql) && /COUNT\(DISTINCT user_id\)/i.test(sql)) {
      if (/GROUP BY date/i.test(sql)) {
        const byDate = {};
        for (const r of rows) {
          if (!byDate[r.date]) byDate[r.date] = { date: r.date, users: new Set(), count: 0 };
          byDate[r.date].count++;
          if (r.user_id) byDate[r.date].users.add(r.user_id);
        }
        return {
          results: Object.values(byDate).map(d => ({
            date: d.date, unique_users: d.users.size, total_events: d.count,
          })),
        };
      }
      const uu = new Set(rows.map(r => r.user_id).filter(Boolean)).size;
      return { unique_users: uu, total_events: rows.length };
    }
    if (/GROUP BY event/i.test(sql)) {
      const byEvent = {};
      for (const r of rows) {
        if (!byEvent[r.event]) byEvent[r.event] = { event: r.event, count: 0, users: new Set() };
        byEvent[r.event].count++;
        if (r.user_id) byEvent[r.event].users.add(r.user_id);
      }
      return {
        results: Object.values(byEvent)
          .map(e => ({ event: e.event, count: e.count, unique_users: e.users.size }))
          .sort((a, b) => b.count - a.count),
      };
    }

    // SELECT * (raw events)
    rows.sort((a, b) => b.timestamp - a.timestamp);
    if (/LIMIT \?/i.test(sql)) {
      rows = rows.slice(0, params[params.length - 1]);
    }
    return { results: rows };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter() {
  const mock = new MockD1();
  return { adapter: new D1Adapter(mock), mock };
}

function makeHandler(adapter) {
  return createAnalyticsHandler({
    db: adapter,
    validateWrite: () => ({ valid: true }),
    validateRead: () => ({ valid: true }),
  });
}

function makeRequest(method, path, body) {
  const url = `http://test${path}`;
  const opts = { method };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers = { 'Content-Type': 'application/json' };
  }
  return new Request(url, opts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session tracking - D1Adapter', () => {
  let adapter, mock;

  beforeEach(() => {
    ({ adapter, mock } = makeAdapter());
  });

  test('1. Session created on first event with session_id', async () => {
    await adapter.trackEvent({
      project: 'test', event: 'page_view', session_id: 'sess1',
      user_id: 'u1', timestamp: 1000000, properties: { path: '/home' },
    });
    assert.equal(mock.tables.sessions.length, 1);
    const s = mock.tables.sessions[0];
    assert.equal(s.session_id, 'sess1');
    assert.equal(s.project_id, 'test');
    assert.equal(s.user_id, 'u1');
    assert.equal(s.start_time, 1000000);
    assert.equal(s.end_time, 1000000);
    assert.equal(s.duration, 0);
    assert.equal(s.entry_page, '/home');
    assert.equal(s.exit_page, '/home');
    assert.equal(s.event_count, 1);
    assert.equal(s.is_bounce, 1);
  });

  test('2. Session updated on second event same session', async () => {
    await adapter.trackEvent({
      project: 'test', event: 'page_view', session_id: 'sess1',
      user_id: 'u1', timestamp: 1000000, properties: { path: '/home' },
    });
    await adapter.trackEvent({
      project: 'test', event: 'click', session_id: 'sess1',
      user_id: 'u1', timestamp: 1060000, properties: { path: '/about' },
    });
    assert.equal(mock.tables.sessions.length, 1);
    const s = mock.tables.sessions[0];
    assert.equal(s.end_time, 1060000);
    assert.equal(s.exit_page, '/about');
    assert.equal(s.event_count, 2);
    assert.equal(s.duration, 60000);
  });

  test('3. Bounce detection: single=1, multi=0', async () => {
    await adapter.trackEvent({
      project: 'test', event: 'page_view', session_id: 'sess1',
      user_id: 'u1', timestamp: 1000000, properties: { path: '/' },
    });
    assert.equal(mock.tables.sessions[0].is_bounce, 1);

    await adapter.trackEvent({
      project: 'test', event: 'click', session_id: 'sess1',
      user_id: 'u1', timestamp: 1001000, properties: { path: '/' },
    });
    assert.equal(mock.tables.sessions[0].is_bounce, 0);
  });

  test('4. Out-of-order events: start_time=MIN, end_time=MAX', async () => {
    await adapter.trackEvent({
      project: 'test', event: 'page_view', session_id: 'sess1',
      user_id: 'u1', timestamp: 2000000, properties: { path: '/second' },
    });
    await adapter.trackEvent({
      project: 'test', event: 'page_view', session_id: 'sess1',
      user_id: 'u1', timestamp: 1000000, properties: { path: '/first' },
    });
    const s = mock.tables.sessions[0];
    assert.equal(s.start_time, 1000000);
    assert.equal(s.end_time, 2000000);
    assert.equal(s.duration, 1000000);
  });

  test('5. Events without session_id skip session upsert', async () => {
    await adapter.trackEvent({
      project: 'test', event: 'page_view', user_id: 'u1', timestamp: 1000000,
    });
    assert.equal(mock.tables.sessions.length, 0);
    assert.equal(mock.tables.events.length, 1);
  });

  test('6. Batch events with multiple session_ids upsert correctly', async () => {
    await adapter.trackBatch([
      { project: 'test', event: 'page_view', session_id: 'sA', user_id: 'u1', timestamp: 1000000, properties: { path: '/a' } },
      { project: 'test', event: 'click', session_id: 'sA', user_id: 'u1', timestamp: 1010000, properties: { path: '/b' } },
      { project: 'test', event: 'page_view', session_id: 'sB', user_id: 'u2', timestamp: 2000000, properties: { path: '/x' } },
    ]);
    assert.equal(mock.tables.events.length, 3);
    assert.equal(mock.tables.sessions.length, 2);
    const sA = mock.tables.sessions.find(s => s.session_id === 'sA');
    assert.equal(sA.event_count, 2);
    assert.equal(sA.is_bounce, 0);
    const sB = mock.tables.sessions.find(s => s.session_id === 'sB');
    assert.equal(sB.event_count, 1);
    assert.equal(sB.is_bounce, 1);
  });

  test('7. getSessions returns filtered results', async () => {
    await adapter.trackEvent({ project: 'test', event: 'pv', session_id: 's1', user_id: 'u1', timestamp: Date.now(), properties: { path: '/' } });
    await adapter.trackEvent({ project: 'test', event: 'pv', session_id: 's2', user_id: 'u2', timestamp: Date.now(), properties: { path: '/' } });
    const all = await adapter.getSessions({ project: 'test', days: 7 });
    assert.equal(all.length, 2);
    const filtered = await adapter.getSessions({ project: 'test', days: 7, user_id: 'u1' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].user_id, 'u1');
  });

  test('8. getSessionStats computes metrics correctly', async () => {
    const now = Date.now();
    // Session 1: 2 events, 60s duration, user u1
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's1', user_id: 'u1', timestamp: now, properties: { path: '/a' } });
    await adapter.trackEvent({ project: 'p', event: 'click', session_id: 's1', user_id: 'u1', timestamp: now + 60000, properties: { path: '/b' } });
    // Session 2: 1 event (bounce), user u2
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's2', user_id: 'u2', timestamp: now, properties: { path: '/c' } });
    // Session 3: 3 events, 120s duration, user u1
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's3', user_id: 'u1', timestamp: now, properties: { path: '/d' } });
    await adapter.trackEvent({ project: 'p', event: 'click', session_id: 's3', user_id: 'u1', timestamp: now + 60000, properties: { path: '/e' } });
    await adapter.trackEvent({ project: 'p', event: 'click', session_id: 's3', user_id: 'u1', timestamp: now + 120000, properties: { path: '/f' } });

    const stats = await adapter.getSessionStats({ project: 'p', days: 7 });
    assert.equal(stats.total_sessions, 3);
    // 1 bounce out of 3
    assert.ok(Math.abs(stats.bounce_rate - 1 / 3) < 0.01);
    // avg duration: (60000 + 0 + 120000) / 3 = 60000
    assert.equal(stats.avg_duration, 60000);
    // pages per session: (2 + 1 + 3) / 3 = 2
    assert.equal(stats.pages_per_session, 2);
    // sessions per user: 3 sessions / 2 users = 1.5
    assert.equal(stats.sessions_per_user, 1.5);
  });

  test('9. cleanupSessions deletes old sessions', async () => {
    const old = new Date('2024-01-01').getTime();
    const recent = Date.now();
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's_old', user_id: 'u1', timestamp: old, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's_new', user_id: 'u1', timestamp: recent, properties: { path: '/' } });
    assert.equal(mock.tables.sessions.length, 2);
    await adapter.cleanupSessions({ project: 'p', before_date: '2025-01-01' });
    assert.equal(mock.tables.sessions.length, 1);
    assert.equal(mock.tables.sessions[0].session_id, 's_new');
  });
});

describe('Session tracking - Handler endpoints', () => {
  let handler, adapter;

  beforeEach(() => {
    ({ adapter } = makeAdapter());
    handler = makeHandler(adapter);
  });

  test('10. GET /sessions returns correct response', async () => {
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's1', user_id: 'u1', timestamp: Date.now(), properties: { path: '/' } });
    const { response } = await handler(makeRequest('GET', '/sessions?project=p&days=7'));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.project, 'p');
    assert.ok(Array.isArray(body.sessions));
    assert.equal(body.sessions.length, 1);
  });

  test('11. GET /sessions requires project', async () => {
    const { response } = await handler(makeRequest('GET', '/sessions'));
    assert.equal(response.status, 400);
  });

  test('12. GET /stats includes session metrics', async () => {
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's1', user_id: 'u1', timestamp: Date.now(), properties: { path: '/' } });
    const { response } = await handler(makeRequest('GET', '/stats?project=p&days=7'));
    const body = await response.json();
    assert.ok(body.sessions, 'stats should include sessions');
    assert.ok('total_sessions' in body.sessions);
    assert.ok('bounce_rate' in body.sessions);
    assert.ok('avg_duration' in body.sessions);
  });

  test('13. GET /events accepts session_id filter', async () => {
    const { adapter: a } = makeAdapter();
    await a.trackEvent({ project: 'p', event: 'pv', session_id: 's1', user_id: 'u1', timestamp: Date.now(), properties: { path: '/' } });
    await a.trackEvent({ project: 'p', event: 'pv', session_id: 's2', user_id: 'u1', timestamp: Date.now(), properties: { path: '/' } });
    // Test adapter directly
    const filtered = await a.getEvents({ project: 'p', session_id: 's1', days: 7 });
    assert.equal(filtered.length, 1, 'adapter should filter by session_id');
    assert.equal(filtered[0].session_id, 's1');
    // Test handler endpoint
    const h = makeHandler(a);
    const { response } = await h(makeRequest('GET', '/events?project=p&session_id=s1&days=7'));
    const body = await response.json();
    assert.equal(body.events.length, 1, 'handler should filter by session_id');
  });

  test('14. POST /query supports session_id group_by and session metrics', async () => {
    await adapter.trackEvent({ project: 'p', event: 'pv', session_id: 's1', user_id: 'u1', timestamp: Date.now(), properties: { path: '/' } });
    // session_id in group_by should not throw
    const { response } = await handler(makeRequest('POST', '/query', {
      project: 'p',
      metrics: ['event_count'],
      group_by: ['session_id'],
    }));
    assert.equal(response.status, 200);
  });
});

describe('Tracker.js session support', () => {
  test('15. tracker.js contains session_id logic', async () => {
    const { TRACKER_JS } = await import('../src/tracker.js');
    assert.ok(TRACKER_JS.includes('session_id'), 'tracker should reference session_id');
    assert.ok(TRACKER_JS.includes('sessionStorage'), 'tracker should use sessionStorage');
    assert.ok(TRACKER_JS.includes('aa_sid'), 'tracker should use aa_sid key');
    assert.ok(TRACKER_JS.includes('aa_last_activity'), 'tracker should track last activity');
  });
});
