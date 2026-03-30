/**
 * Tests for identity stitching (identifyUser + POST /identify).
 */
import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { BaseAdapter } from '../src/db/base-adapter.js';
import { createAnalyticsHandler } from '../src/handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(resolve(__dirname, '../schema.sql'), 'utf-8');

class MockAdapter extends BaseAdapter {
  constructor() {
    super();
    this.db = new Database(':memory:');
    this.db.exec(schema);
  }
  _run(sql, params) { return this.db.prepare(sql).run(...params); }
  _queryAll(sql, params) { return this.db.prepare(sql).all(...params); }
  _queryOne(sql, params) { return this.db.prepare(sql).get(...params) || null; }
  _batch(statements) {
    const txn = this.db.transaction((stmts) => {
      for (const { sql, params } of stmts) this.db.prepare(sql).run(...params);
    });
    txn(statements);
  }
}

describe('identifyUser (BaseAdapter)', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  test('backfills events and sessions', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p1', event: 'page_view', user_id: 'anon_abc', session_id: 's1', timestamp: now, properties: { path: '/' } });
    await adapter.trackEvent({ project: 'p1', event: 'click', user_id: 'anon_abc', session_id: 's1', timestamp: now + 1000, properties: { path: '/about' } });

    await adapter.identifyUser({ project: 'p1', previous_id: 'anon_abc', canonical_id: 'user_123' });

    // Events backfilled
    const events = adapter.db.prepare('SELECT user_id FROM events WHERE project_id = ?').all('p1');
    assert.equal(events.length, 2);
    for (const e of events) assert.equal(e.user_id, 'user_123');

    // Sessions backfilled
    const sessions = adapter.db.prepare('SELECT user_id FROM sessions WHERE project_id = ?').all('p1');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].user_id, 'user_123');

    // Identity map entry
    const mapping = adapter.db.prepare('SELECT * FROM identity_map WHERE previous_id = ? AND project_id = ?').get('anon_abc', 'p1');
    assert.ok(mapping);
    assert.equal(mapping.canonical_id, 'user_123');
  });

  test('is idempotent — same mapping twice is a no-op', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p1', event: 'click', user_id: 'anon_abc', timestamp: now });

    await adapter.identifyUser({ project: 'p1', previous_id: 'anon_abc', canonical_id: 'user_123' });
    await adapter.identifyUser({ project: 'p1', previous_id: 'anon_abc', canonical_id: 'user_123' });

    const events = adapter.db.prepare('SELECT user_id FROM events WHERE project_id = ?').all('p1');
    assert.equal(events.length, 1);
    assert.equal(events[0].user_id, 'user_123');

    const mappings = adapter.db.prepare('SELECT * FROM identity_map WHERE project_id = ?').all('p1');
    assert.equal(mappings.length, 1);
  });

  test('re-identify updates mapping and re-backfills', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p1', event: 'click', user_id: 'anon_abc', timestamp: now });

    await adapter.identifyUser({ project: 'p1', previous_id: 'anon_abc', canonical_id: 'user_123' });

    // Now re-identify: the old anon_abc events are now user_123
    // A new event arrives with user_123 that we want to map to user_final
    await adapter.trackEvent({ project: 'p1', event: 'click', user_id: 'user_123', timestamp: now + 1000 });
    await adapter.identifyUser({ project: 'p1', previous_id: 'user_123', canonical_id: 'user_final' });

    const events = adapter.db.prepare('SELECT user_id FROM events WHERE project_id = ? ORDER BY timestamp').all('p1');
    // Both events should now have user_final
    for (const e of events) assert.equal(e.user_id, 'user_final');
  });

  test('does not affect other projects', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'p1', event: 'click', user_id: 'anon_abc', timestamp: now });
    await adapter.trackEvent({ project: 'p2', event: 'click', user_id: 'anon_abc', timestamp: now });

    await adapter.identifyUser({ project: 'p1', previous_id: 'anon_abc', canonical_id: 'user_123' });

    // p1 events backfilled
    const p1Events = adapter.db.prepare('SELECT user_id FROM events WHERE project_id = ?').all('p1');
    assert.equal(p1Events[0].user_id, 'user_123');

    // p2 events untouched
    const p2Events = adapter.db.prepare('SELECT user_id FROM events WHERE project_id = ?').all('p2');
    assert.equal(p2Events[0].user_id, 'anon_abc');
  });

  test('handles no matching events gracefully', async () => {
    // No events exist for this user — should not throw
    await adapter.identifyUser({ project: 'p1', previous_id: 'nonexistent', canonical_id: 'user_123' });

    const mapping = adapter.db.prepare('SELECT * FROM identity_map WHERE previous_id = ? AND project_id = ?').get('nonexistent', 'p1');
    assert.ok(mapping);
    assert.equal(mapping.canonical_id, 'user_123');
  });

  test('canonicalizes a late event after identify has already been recorded', async () => {
    const now = Date.now();

    await adapter.identifyUser({ project: 'p1', previous_id: 'anon_abc', canonical_id: 'user_123' });
    await adapter.trackEvent({
      project: 'p1',
      event: 'page_view',
      user_id: 'anon_abc',
      session_id: 's1',
      timestamp: now,
      properties: { path: '/' },
    });

    const event = adapter.db.prepare('SELECT user_id FROM events WHERE project_id = ?').get('p1');
    const session = adapter.db.prepare('SELECT user_id FROM sessions WHERE project_id = ?').get('p1');
    assert.equal(event.user_id, 'user_123');
    assert.equal(session.user_id, 'user_123');
  });

  test('canonicalizes late events through an existing identity chain', async () => {
    const now = Date.now();

    await adapter.identifyUser({ project: 'p1', previous_id: 'anon_abc', canonical_id: 'user_123' });
    await adapter.identifyUser({ project: 'p1', previous_id: 'user_123', canonical_id: 'user_final' });
    await adapter.trackEvent({
      project: 'p1',
      event: 'page_view',
      user_id: 'anon_abc',
      session_id: 's1',
      timestamp: now,
      properties: { path: '/' },
    });

    const event = adapter.db.prepare('SELECT user_id FROM events WHERE project_id = ?').get('p1');
    const session = adapter.db.prepare('SELECT user_id FROM sessions WHERE project_id = ?').get('p1');
    const mapping = adapter.db.prepare('SELECT canonical_id FROM identity_map WHERE previous_id = ? AND project_id = ?').get('anon_abc', 'p1');
    assert.equal(event.user_id, 'user_final');
    assert.equal(session.user_id, 'user_final');
    assert.equal(mapping.canonical_id, 'user_final');
  });
});

describe('POST /identify (handler)', () => {
  let adapter, handle;
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0';

  beforeEach(() => {
    adapter = new MockAdapter();
    handle = createAnalyticsHandler({
      db: adapter,
      validateWrite: (req, body) => ({ valid: true }),
      validateRead: () => ({ valid: true }),
    });
  });

  function identifyReq(body) {
    return new Request('http://localhost/identify', {
      method: 'POST',
      headers: { 'User-Agent': UA },
      body: JSON.stringify(body),
    });
  }

  test('returns ok on valid identify', async () => {
    const now = Date.now();
    await adapter.trackEvent({ project: 'mysite', event: 'click', user_id: 'anon_abc', timestamp: now });

    const { response } = await handle(identifyReq({ project: 'mysite', previous_id: 'anon_abc', user_id: 'user_123' }));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);

    // Verify backfill happened
    const events = adapter.db.prepare('SELECT user_id FROM events WHERE project_id = ?').all('mysite');
    assert.equal(events[0].user_id, 'user_123');
  });

  test('rejects missing project', async () => {
    const { response } = await handle(identifyReq({ previous_id: 'anon_abc', user_id: 'user_123' }));
    assert.equal(response.status, 400);
  });

  test('rejects missing previous_id', async () => {
    const { response } = await handle(identifyReq({ project: 'mysite', user_id: 'user_123' }));
    assert.equal(response.status, 400);
  });

  test('rejects missing user_id', async () => {
    const { response } = await handle(identifyReq({ project: 'mysite', previous_id: 'anon_abc' }));
    assert.equal(response.status, 400);
  });

  test('rejects same previous_id and user_id', async () => {
    const { response } = await handle(identifyReq({ project: 'mysite', previous_id: 'same', user_id: 'same' }));
    assert.equal(response.status, 400);
  });

  test('rejects previous_id exceeding 256 chars', async () => {
    const { response } = await handle(identifyReq({ project: 'mysite', previous_id: 'a'.repeat(257), user_id: 'user_123' }));
    assert.equal(response.status, 400);
  });
});
