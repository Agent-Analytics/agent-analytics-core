import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Database from 'better-sqlite3';
import {
  ERASURE_BATCH_SIZE,
  ERASURE_LARGE_EVENT_THRESHOLD,
  collectIdentityGraph,
  countSubjectEvents,
  eraseSubjectRows,
  hashErasureSubject,
  reapplyErasureReceipt,
  userIdsForEmailLookup,
} from '../src/erasure.js';

const OSS_SCHEMA = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    event TEXT NOT NULL,
    properties TEXT,
    user_id TEXT,
    session_id TEXT,
    timestamp INTEGER NOT NULL,
    date TEXT NOT NULL,
    country TEXT
  );
  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT,
    project_id TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    duration INTEGER DEFAULT 0,
    entry_page TEXT,
    exit_page TEXT,
    event_count INTEGER DEFAULT 1,
    is_bounce INTEGER DEFAULT 1,
    date TEXT NOT NULL
  );
  CREATE TABLE identity_map (
    previous_id TEXT NOT NULL,
    canonical_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (previous_id, project_id)
  );
`;

const HOSTED_EXTRA = `
  ALTER TABLE events ADD COLUMN resolved_user_id TEXT;
  ALTER TABLE sessions ADD COLUMN resolved_user_id TEXT;
  CREATE TABLE identity_aliases (
    scope_id TEXT NOT NULL,
    alias_id TEXT NOT NULL,
    canonical_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope_id, alias_id)
  );
  CREATE TABLE project_identity_scopes (
    project_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE user_profiles (
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    email_hash TEXT,
    traits TEXT,
    first_seen_at INTEGER,
    last_seen_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );
  CREATE TABLE email_lookup_index (
    scope_id TEXT NOT NULL,
    lookup_index TEXT NOT NULL,
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope_id, user_id)
  );
`;

function open(hosted = false) {
  const sqlite = new Database(':memory:');
  sqlite.exec(OSS_SCHEMA);
  if (hosted) sqlite.exec(HOSTED_EXTRA);
  return sqlite;
}

function adapter(sqlite, writes = null) {
  return {
    async queryAll(sql, params = []) {
      return sqlite.prepare(sql).all(...params);
    },
    async queryOne(sql, params = []) {
      return sqlite.prepare(sql).get(...params) ?? null;
    },
    async run(sql, params = []) {
      if (writes) writes.push(sql);
      const info = sqlite.prepare(sql).run(...params);
      return { changes: info.changes };
    },
  };
}

function insertEvent(sqlite, row) {
  const hosted = Object.prototype.hasOwnProperty.call(row, 'resolved_user_id');
  if (hosted) {
    sqlite.prepare(
      `INSERT INTO events (id, project_id, event, properties, user_id, resolved_user_id, session_id, timestamp, date, country)
       VALUES (?, ?, 'page', ?, ?, ?, ?, 1, '2026-11-13', 'US')`,
    ).run(row.id, row.project, row.properties ?? null, row.user_id ?? null, row.resolved_user_id ?? null, row.session_id ?? null);
    return;
  }
  sqlite.prepare(
    `INSERT INTO events (id, project_id, event, properties, user_id, session_id, timestamp, date, country)
     VALUES (?, ?, 'page', ?, ?, ?, 1, '2026-11-13', 'US')`,
  ).run(row.id, row.project, row.properties ?? null, row.user_id ?? null, row.session_id ?? null);
}

function insertSession(sqlite, row) {
  const hosted = Object.prototype.hasOwnProperty.call(row, 'resolved_user_id');
  if (hosted) {
    sqlite.prepare(
      `INSERT INTO sessions (session_id, user_id, resolved_user_id, project_id, start_time, end_time, duration, entry_page, exit_page, event_count, is_bounce, date)
       VALUES (?, ?, ?, ?, 1, 2, 1, '/', '/', 1, 1, '2026-11-13')`,
    ).run(row.session_id, row.user_id ?? null, row.resolved_user_id ?? null, row.project);
    return;
  }
  sqlite.prepare(
    `INSERT INTO sessions (session_id, user_id, project_id, start_time, end_time, duration, entry_page, exit_page, event_count, is_bounce, date)
     VALUES (?, ?, ?, 1, 2, 1, '/', '/', 1, 1, '2026-11-13')`,
  ).run(row.session_id, row.user_id ?? null, row.project);
}

describe('eraseSubjectRows', () => {
  test('OSS schema deletes one project and one identity hop, and leaves the other project', async () => {
    const sqlite = open(false);
    const db = adapter(sqlite);
    insertEvent(sqlite, { id: 'e-known', project: 'site-a', user_id: 'known-user', session_id: 'sess-a' });
    insertEvent(sqlite, { id: 'e-anon', project: 'site-a', user_id: 'anon-user', session_id: 'sess-anon' });
    insertEvent(sqlite, { id: 'e-far', project: 'site-a', user_id: 'far-user', session_id: 'sess-far' });
    insertEvent(sqlite, {
      id: 'e-prop',
      project: 'site-a',
      user_id: 'someone-else',
      session_id: 'sess-else',
      properties: '{"note":"known-user"}',
    });
    insertEvent(sqlite, { id: 'e-other', project: 'site-b', user_id: 'known-user', session_id: 'sess-b' });
    insertEvent(sqlite, { id: 'e-other-anon', project: 'site-b', user_id: 'anon-user', session_id: 'sess-b-anon' });
    insertSession(sqlite, { session_id: 'sess-a', project: 'site-a', user_id: 'known-user' });
    insertSession(sqlite, { session_id: 'sess-anon', project: 'site-a', user_id: 'anon-user' });
    insertSession(sqlite, { session_id: 'sess-far', project: 'site-a', user_id: 'far-user' });
    insertSession(sqlite, { session_id: 'sess-else', project: 'site-a', user_id: 'someone-else' });
    insertSession(sqlite, { session_id: 'sess-b', project: 'site-b', user_id: 'known-user' });
    sqlite.prepare('INSERT INTO identity_map (previous_id, canonical_id, project_id, created_at) VALUES (?, ?, ?, 1)')
      .run('anon-user', 'known-user', 'site-a');
    sqlite.prepare('INSERT INTO identity_map (previous_id, canonical_id, project_id, created_at) VALUES (?, ?, ?, 1)')
      .run('far-user', 'anon-user', 'site-a');
    sqlite.prepare('INSERT INTO identity_map (previous_id, canonical_id, project_id, created_at) VALUES (?, ?, ?, 1)')
      .run('anon-user', 'known-user', 'site-b');

    const graph = await collectIdentityGraph(db, { project: 'site-a', seedIds: ['known-user'] });
    assert.deepEqual(graph.sort(), ['anon-user', 'known-user']);

    const result = await eraseSubjectRows(db, {
      project: 'site-a',
      mode: 'user_ids',
      userIds: ['known-user'],
    });

    assert.equal(result.counts.events, 2);
    assert.equal(result.counts.sessions, 2);
    assert.equal(result.counts.identity_rows, 2);
    assert.equal(result.counts.profiles, 0);
    assert.equal(result.userIds.includes('far-user'), false);
    assert.deepEqual(
      sqlite.prepare('SELECT id FROM events WHERE project_id = ? ORDER BY id').all('site-a').map((row) => row.id),
      ['e-far', 'e-prop'],
    );
    assert.deepEqual(
      sqlite.prepare('SELECT id FROM events WHERE project_id = ? ORDER BY id').all('site-b').map((row) => row.id),
      ['e-other', 'e-other-anon'],
    );
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?').get('site-b').n, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM identity_map WHERE project_id = ?').get('site-b').n, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM identity_map WHERE project_id = ?').get('site-a').n, 0);
  });

  test('session erasure does not walk the graph', async () => {
    const sqlite = open(false);
    const db = adapter(sqlite);
    insertEvent(sqlite, { id: 'e1', project: 'site-a', user_id: 'known-user', session_id: 'sess-1' });
    insertEvent(sqlite, { id: 'e2', project: 'site-a', user_id: 'known-user', session_id: 'sess-2' });
    insertEvent(sqlite, { id: 'e3', project: 'site-b', user_id: 'known-user', session_id: 'sess-1b' });
    insertSession(sqlite, { session_id: 'sess-1', project: 'site-a', user_id: 'known-user' });
    insertSession(sqlite, { session_id: 'sess-2', project: 'site-a', user_id: 'known-user' });
    sqlite.prepare('INSERT INTO identity_map (previous_id, canonical_id, project_id, created_at) VALUES (?, ?, ?, 1)')
      .run('anon-user', 'known-user', 'site-a');

    const result = await eraseSubjectRows(db, {
      project: 'site-a',
      mode: 'session_id',
      sessionId: 'sess-1',
    });

    assert.equal(result.counts.events, 1);
    assert.equal(result.counts.sessions, 1);
    assert.equal(result.counts.identity_rows, 0);
    assert.deepEqual(result.userIds, []);
    assert.equal(sqlite.prepare("SELECT id FROM events WHERE project_id = 'site-a'").get().id, 'e2');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM identity_map').get().n, 1);
    assert.equal(sqlite.prepare("SELECT id FROM events WHERE project_id = 'site-b'").get().id, 'e3');
  });

  test('hosted tables stay inside the named project', async () => {
    const sqlite = open(true);
    const writes = [];
    const db = adapter(sqlite, writes);
    const now = 1;
    insertEvent(sqlite, { id: 'a1', project: 'site-a', user_id: 'known-user', resolved_user_id: 'known-user', session_id: 'sa' });
    insertEvent(sqlite, { id: 'a2', project: 'site-a', user_id: 'stranger', resolved_user_id: 'known-user', session_id: 'sa2' });
    insertEvent(sqlite, { id: 'a3', project: 'site-a', user_id: 'alias-user', resolved_user_id: null, session_id: 'sa3' });
    insertEvent(sqlite, { id: 'b1', project: 'site-b', user_id: 'known-user', resolved_user_id: 'known-user', session_id: 'sb' });
    insertSession(sqlite, { session_id: 'sa', project: 'site-a', user_id: 'known-user', resolved_user_id: 'known-user' });
    insertSession(sqlite, { session_id: 'sb', project: 'site-b', user_id: 'known-user', resolved_user_id: 'known-user' });
    sqlite.prepare('INSERT INTO identity_map (previous_id, canonical_id, project_id, created_at) VALUES (?, ?, ?, ?)')
      .run('anon-user', 'known-user', 'site-a', now);
    sqlite.prepare('INSERT INTO identity_map (previous_id, canonical_id, project_id, created_at) VALUES (?, ?, ?, ?)')
      .run('anon-user', 'known-user', 'site-b', now);
    sqlite.prepare('INSERT INTO project_identity_scopes (project_id, scope_id, updated_at) VALUES (?, ?, ?)')
      .run('site-a', 'project:site-a', now);
    sqlite.prepare('INSERT INTO project_identity_scopes (project_id, scope_id, updated_at) VALUES (?, ?, ?)')
      .run('site-b', 'project:site-b', now);
    sqlite.prepare('INSERT INTO identity_aliases (scope_id, alias_id, canonical_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('project:site-a', 'alias-user', 'known-user', now, now);
    sqlite.prepare('INSERT INTO identity_aliases (scope_id, alias_id, canonical_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('project:site-b', 'alias-user', 'known-user', now, now);
    sqlite.prepare('INSERT INTO identity_aliases (scope_id, alias_id, canonical_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('portfolio:shared', 'alias-user', 'known-user', now, now);
    sqlite.prepare(`INSERT INTO user_profiles (project_id, user_id, traits, updated_at) VALUES (?, ?, ?, ?)`)
      .run('site-a', 'known-user', '{}', now);
    sqlite.prepare(`INSERT INTO user_profiles (project_id, user_id, traits, updated_at) VALUES (?, ?, ?, ?)`)
      .run('site-b', 'known-user', '{}', now);
    sqlite.prepare(`INSERT INTO email_lookup_index (scope_id, lookup_index, project_id, user_id, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('project:uuid-a', 'hmac-a', 'site-a', 'known-user', now);
    sqlite.prepare(`INSERT INTO email_lookup_index (scope_id, lookup_index, project_id, user_id, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('project:uuid-b', 'hmac-b', 'site-b', 'known-user', now);

    const result = await eraseSubjectRows(db, {
      project: 'site-a',
      mode: 'user_ids',
      userIds: ['known-user'],
      includeHostedIdentity: true,
      emailLookups: [{ scopeId: 'project:uuid-a', lookupIndex: 'hmac-a' }],
    });

    assert.equal(result.counts.events, 3);
    assert.ok(result.counts.identity_rows >= 2);
    assert.equal(result.counts.profiles, 1);
    assert.equal(result.counts.email_lookups, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = 'site-a'").get().n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = 'site-b'").get().n, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_id = 'site-b'").get().n, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM identity_map WHERE project_id = 'site-b'").get().n, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM identity_aliases WHERE scope_id = 'project:site-b'").get().n, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM identity_aliases WHERE scope_id = 'portfolio:shared'").get().n, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_profiles WHERE project_id = 'site-b'").get().n, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email_lookup_index WHERE project_id = 'site-b'").get().n, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email_lookup_index WHERE scope_id = 'project:uuid-a'").get().n, 0);

    for (const sql of writes) {
      assert.match(sql, /project_id = \?/);
    }
  });

  test('deletes more than one primary-key batch', async () => {
    const sqlite = open(false);
    const db = adapter(sqlite);
    const count = ERASURE_BATCH_SIZE + 5;
    const insert = sqlite.prepare(
      `INSERT INTO events (id, project_id, event, properties, user_id, session_id, timestamp, date, country)
       VALUES (?, 'site-a', 'page', NULL, 'known-user', NULL, 1, '2026-11-13', NULL)`,
    );
    const other = sqlite.prepare(
      `INSERT INTO events (id, project_id, event, properties, user_id, session_id, timestamp, date, country)
       VALUES ('keep', 'site-b', 'page', NULL, 'known-user', NULL, 1, '2026-11-13', NULL)`,
    );
    const tx = sqlite.transaction(() => {
      for (let index = 0; index < count; index += 1) insert.run(`e${index}`);
      other.run();
    });
    tx();

    const result = await eraseSubjectRows(db, {
      project: 'site-a',
      userIds: ['known-user'],
    });
    assert.equal(result.counts.events, count);
    assert.equal(sqlite.prepare('SELECT id FROM events').get().id, 'keep');
    assert.equal(await countSubjectEvents(db, { project: 'site-b', userIds: ['known-user'] }), 1);
    assert.equal(ERASURE_LARGE_EVENT_THRESHOLD, 100_000);
  });

  test('reapply uses hashes and does not touch the other project', async () => {
    const sqlite = open(true);
    const db = adapter(sqlite);
    insertEvent(sqlite, { id: 'a1', project: 'site-a', user_id: 'known-user', resolved_user_id: null, session_id: 'sa' });
    insertEvent(sqlite, { id: 'b1', project: 'site-b', user_id: 'known-user', resolved_user_id: null, session_id: 'sb' });
    insertSession(sqlite, { session_id: 'sa', project: 'site-a', user_id: 'known-user', resolved_user_id: null });
    insertSession(sqlite, { session_id: 'sb', project: 'site-b', user_id: 'known-user', resolved_user_id: null });
    sqlite.prepare('INSERT INTO identity_map (previous_id, canonical_id, project_id, created_at) VALUES (?, ?, ?, 1)')
      .run('anon-user', 'known-user', 'site-a');
    sqlite.prepare('INSERT INTO identity_map (previous_id, canonical_id, project_id, created_at) VALUES (?, ?, ?, 1)')
      .run('anon-user', 'known-user', 'site-b');

    const receipt = {
      project_name: 'site-a',
      user_id_hashes: [await hashErasureSubject('known-user'), await hashErasureSubject('anon-user')],
      session_id_hashes: [await hashErasureSubject('sa')],
      email_lookups: [],
    };
    const applied = await reapplyErasureReceipt(db, receipt, { includeHostedIdentity: true });
    assert.equal(applied.counts.events, 1);
    assert.deepEqual(Object.keys(applied).sort(), ['counts']);
    assert.equal(JSON.stringify(applied).includes('known-user'), false);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = 'site-a'").get().n, 0);
    assert.equal(sqlite.prepare("SELECT id FROM events WHERE project_id = 'site-b'").get().id, 'b1');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM identity_map WHERE project_id = 'site-b'").get().n, 1);
  });

  test('a shared session stays, and reapply matches the live delete', async () => {
    function seed(sqlite) {
      for (let index = 0; index < 11; index += 1) {
        insertEvent(sqlite, {
          id: `shared-${index}`,
          project: 'site-a',
          user_id: 'alice',
          session_id: 's-shared',
        });
      }
      insertEvent(sqlite, { id: 'bob-event', project: 'site-a', user_id: 'bob', session_id: 's-shared' });
      insertEvent(sqlite, { id: 'alice-only', project: 'site-a', user_id: 'alice', session_id: 's-alice' });
      insertSession(sqlite, { session_id: 's-shared', project: 'site-a', user_id: 'alice' });
      insertSession(sqlite, { session_id: 's-alice', project: 'site-a', user_id: 'alice' });
    }

    const liveDb = open(false);
    seed(liveDb);
    const live = await eraseSubjectRows(adapter(liveDb), {
      project: 'site-a',
      mode: 'user_ids',
      userIds: ['alice'],
    });
    assert.equal(live.counts.events, 12);
    assert.equal(live.counts.sessions, 1);
    assert.equal(live.sessionIds.includes('s-shared'), false);
    assert.equal(live.sessionIds.includes('s-alice'), true);
    assert.equal(liveDb.prepare("SELECT id FROM events WHERE id = 'bob-event'").get().id, 'bob-event');
    assert.equal(liveDb.prepare("SELECT user_id, event_count FROM sessions WHERE session_id = 's-shared'").get().user_id, 'bob');
    assert.equal(liveDb.prepare("SELECT event_count FROM sessions WHERE session_id = 's-shared'").get().event_count, 1);
    assert.equal(liveDb.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 's-alice'").get().n, 0);

    const restored = open(false);
    seed(restored);
    const receipt = {
      project_name: 'site-a',
      subject_type: 'user_id',
      user_id_hashes: await Promise.all(live.userIds.map((id) => hashErasureSubject(id))),
      session_id_hashes: [
        await hashErasureSubject('s-shared'),
        await hashErasureSubject('s-alice'),
      ],
      email_lookups: [],
    };
    const again = await reapplyErasureReceipt(adapter(restored), receipt);
    assert.equal(again.counts.events, live.counts.events);
    assert.equal(again.counts.sessions, live.counts.sessions);
    assert.equal(restored.prepare("SELECT id FROM events WHERE id = 'bob-event'").get().id, 'bob-event');
    assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 's-shared'").get().n, 1);
    assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = 'alice'").get().n, 0);

    const sessionDb = open(false);
    seed(sessionDb);
    const sessionLive = await eraseSubjectRows(adapter(sessionDb), {
      project: 'site-a',
      mode: 'session_id',
      sessionId: 's-shared',
    });
    const sessionRestored = open(false);
    seed(sessionRestored);
    const sessionAgain = await reapplyErasureReceipt(adapter(sessionRestored), {
      project_name: 'site-a',
      subject_type: 'session_id',
      user_id_hashes: [await hashErasureSubject('alice')],
      session_id_hashes: [await hashErasureSubject('s-shared')],
      email_lookups: [],
    });
    assert.equal(sessionAgain.counts.events, sessionLive.counts.events);
    assert.equal(sessionAgain.counts.sessions, sessionLive.counts.sessions);
    assert.equal(sessionRestored.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 's-shared'").get().n, 0);
    assert.equal(sessionRestored.prepare("SELECT id FROM events WHERE id = 'alice-only'").get().id, 'alice-only');
  });

  test('set based deletes stay within the D1 call budget', async () => {
    function counting(sqlite) {
      const db = adapter(sqlite);
      const stats = { calls: 0 };
      return {
        stats,
        db: {
          async queryAll(...args) {
            stats.calls += 1;
            return db.queryAll(...args);
          },
          async queryOne(...args) {
            stats.calls += 1;
            return db.queryOne(...args);
          },
          async run(...args) {
            stats.calls += 1;
            return db.run(...args);
          },
        },
      };
    }

    const smallSql = open(true);
    insertEvent(smallSql, {
      id: 'one',
      project: 'site-a',
      user_id: 'known-user',
      resolved_user_id: 'known-user',
      session_id: 'sess-one',
    });
    insertSession(smallSql, {
      session_id: 'sess-one',
      project: 'site-a',
      user_id: 'known-user',
      resolved_user_id: 'known-user',
    });
    const small = counting(smallSql);
    await eraseSubjectRows(small.db, {
      project: 'site-a',
      userIds: ['known-user'],
      includeHostedIdentity: true,
    });
    assert.ok(small.stats.calls <= 16, `normal erasure used ${small.stats.calls} calls`);

    const largeSql = open(false);
    const insert = largeSql.prepare(
      `INSERT INTO events (id, project_id, event, properties, user_id, session_id, timestamp, date, country)
       VALUES (?, 'site-a', 'page', NULL, 'known-user', NULL, 1, '2026-11-13', NULL)`,
    );
    largeSql.transaction(() => {
      for (let index = 0; index < 100_000; index += 1) insert.run(`bulk-${index}`);
    })();
    const large = counting(largeSql);
    const erased = await eraseSubjectRows(large.db, {
      project: 'site-a',
      userIds: ['known-user'],
    });
    assert.equal(erased.counts.events, 100_000);
    assert.ok(large.stats.calls <= 30, `100k erasure used ${large.stats.calls} calls`);
    console.log(`erasure calls normal=${small.stats.calls} events100k=${large.stats.calls}`);
  });

  test('email lookup ids are limited to the project and scope', async () => {
    const sqlite = open(true);
    const db = adapter(sqlite);
    sqlite.prepare(`INSERT INTO email_lookup_index (scope_id, lookup_index, project_id, user_id, updated_at) VALUES (?, ?, ?, ?, 1)`)
      .run('project:uuid-a', 'hmac-a', 'site-a', 'known-user', );
    sqlite.prepare(`INSERT INTO email_lookup_index (scope_id, lookup_index, project_id, user_id, updated_at) VALUES (?, ?, ?, ?, 1)`)
      .run('project:uuid-b', 'hmac-a', 'site-b', 'known-user');

    assert.deepEqual(
      await userIdsForEmailLookup(db, { project: 'site-a', scopeId: 'project:uuid-a', lookupIndex: 'hmac-a' }),
      ['known-user'],
    );
    assert.deepEqual(
      await userIdsForEmailLookup(db, { project: 'site-b', scopeId: 'project:uuid-a', lookupIndex: 'hmac-a' }),
      [],
    );
  });
});
