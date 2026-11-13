import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { AnalyticsError } from '../src/errors.js';
import {
  SQL_FETCH_CAP,
  SQL_MAX_BYTES,
  SQL_ROW_CAP,
  resolveSqlWindow,
  validateReadOnlySql,
  wrapProjectSql,
} from '../src/sql.js';

function database() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE events (
      id TEXT, project_id TEXT, event TEXT, properties TEXT, user_id TEXT,
      session_id TEXT, timestamp INTEGER, date TEXT, country TEXT, resolved_user_id TEXT
    );
    CREATE TABLE sessions (
      session_id TEXT, user_id TEXT, project_id TEXT, start_time INTEGER, end_time INTEGER,
      duration INTEGER, entry_page TEXT, exit_page TEXT, event_count INTEGER, is_bounce INTEGER,
      date TEXT, resolved_user_id TEXT
    );
    CREATE TABLE user_profiles (project_id TEXT, user_id TEXT, traits TEXT);
    INSERT INTO events VALUES
      ('1', 'secret', 'page', '{"path":"/secret"}', 'u', 's', 1, '2026-01-01', 'US', 'resolved-secret'),
      ('2', 'mine', 'click', '{"path":"/mine"}', 'u2', 's2', 2, '2026-01-02', 'DE', 'resolved-mine'),
      ('3', 'mine', 'old', '{"path":"/old"}', 'u2', 's3', 3, '2025-12-01', 'DE', 'resolved-old');
    INSERT INTO sessions VALUES
      ('s', 'u', 'secret', 1, 2, 1, '/secret', '/secret', 1, 1, '2026-01-01', 'resolved-secret'),
      ('s2', 'u2', 'mine', 1, 2, 1, '/mine', '/mine', 1, 0, '2026-01-02', 'resolved-mine'),
      ('s3', 'u2', 'mine', 3, 4, 1, '/old', '/old', 1, 1, '2025-12-01', 'resolved-old');
    INSERT INTO user_profiles VALUES ('secret', 'u', '{"email":"a@b.c"}');
  `);
  return db;
}

const TEST_WINDOW = { date_from: '2026-01-01', date_to: '2026-01-02' };

function run(sql, projectName = 'mine') {
  const wrapped = wrapProjectSql(sql, projectName, TEST_WINDOW);
  return {
    wrapped,
    rows: database().prepare(wrapped.sql).all(...wrapped.params),
  };
}

function rejected(sql) {
  const result = validateReadOnlySql(sql);
  assert.equal(result.ok, false, sql);
  assert.equal(typeof result.error, 'string');
  assert.throws(() => wrapProjectSql(sql, 'mine'), (err) => err instanceof AnalyticsError && err.code === 'INVALID_SQL');
  return result.error;
}

describe('validateReadOnlySql', () => {
  test('accepts a project select and a write keyword inside a string', () => {
    assert.deepEqual(validateReadOnlySql("SELECT id FROM events WHERE event != 'DELETE'"), { ok: true });
    assert.deepEqual(validateReadOnlySql('SELECT id FROM sessions'), { ok: true });
    assert.deepEqual(validateReadOnlySql('SELECT 1'), { ok: true });
  });

  test('rejects statements that are not one select', () => {
    assert.match(rejected('WITH t AS (SELECT id FROM events) SELECT * FROM t'), /SELECT/);
    assert.match(rejected('SELECT id FROM events; SELECT id FROM sessions'), /multiple/);
    assert.match(rejected('INSERT INTO events (id) VALUES (1)'), /INSERT/);
    assert.match(rejected('UPDATE events SET event = \'x\''), /UPDATE/);
    assert.match(rejected('DELETE FROM events'), /DELETE/);
    assert.match(rejected('DROP TABLE events'), /DROP/);
    assert.match(rejected(''), /required/);
    assert.match(rejected('SELECT id FROM events WHERE id = ?'), /bind/);
  });

  test('rejects write keywords outside strings, including comments, and allows them inside strings', () => {
    assert.match(rejected('SELECT id FROM events /* INSERT */'), /INSERT/);
    assert.match(rejected('SELECT id FROM events -- DELETE'), /DELETE/);
    assert.match(rejected('SELECT REPLACE(event, \'a\', \'b\') FROM events'), /REPLACE/);
    assert.equal(validateReadOnlySql("SELECT id FROM events WHERE event = 'INSERT INTO events'").ok, true);
    assert.equal(validateReadOnlySql("SELECT id FROM events WHERE properties = 'main.events'").ok, true);
  });

  test('rejects other tables, schema names, and catalog tables', () => {
    assert.match(rejected('SELECT * FROM user_profiles'), /user_profiles/);
    assert.match(rejected('SELECT * FROM main.events'), /schema-qualified/);
    assert.match(rejected('SELECT * FROM temp.events'), /schema-qualified/);
    assert.match(rejected('SELECT * FROM "main".events'), /schema-qualified/);
    assert.match(rejected('SELECT * FROM [main].events'), /schema-qualified/);
    assert.match(rejected('SELECT * FROM main/**/.events'), /schema-qualified/);
    assert.match(rejected('SELECT * FROM main./**/events'), /schema-qualified/);
    assert.match(rejected('SELECT name FROM sqlite_master'), /sqlite_master/);
    assert.match(rejected('SELECT name FROM sqlite_schema'), /sqlite_schema/);
    assert.match(rejected('SELECT name FROM sqlite_temp_master'), /sqlite_temp_master/);
    assert.match(rejected('SELECT * FROM "sqlite_master"'), /sqlite_master/);
    assert.match(rejected('SELECT id FROM events, user_profiles'), /user_profiles/);
    assert.match(rejected('SELECT id FROM events JOIN user_profiles ON events.user_id = user_profiles.user_id'), /user_profiles/);
    assert.match(rejected('SELECT id FROM (SELECT id FROM events), user_profiles'), /user_profiles/);
    assert.match(rejected('SELECT * FROM (WITH p AS (SELECT * FROM user_profiles) SELECT * FROM p)'), /user_profiles/);
    assert.match(rejected('SELECT * FROM json_each((SELECT traits FROM user_profiles))'), /not allowed/);
    assert.match(rejected("SELECT * FROM pragma_table_info('events')"), /not allowed/);
    assert.match(rejected('SELECT id FROM events WHERE EXISTS (SELECT 1 FROM user_profiles)'), /user_profiles/);
    assert.match(rejected('PRAGMA table_info(events)'), /PRAGMA/);
    assert.match(rejected('ATTACH DATABASE \'x\' AS other'), /ATTACH/);
  });

  test('rejects SQL over 20 KB and negative LIMIT', () => {
    assert.match(rejected(`SELECT '${'a'.repeat(SQL_MAX_BYTES)}'`), /20 KB/);
    assert.match(rejected('SELECT id FROM events LIMIT -1'), /LIMIT/);
    assert.match(rejected('SELECT id FROM events LIMIT (SELECT 1)'), /LIMIT/);
  });

  test('rejects a self-join, a recursive CTE, and blob functions', () => {
    assert.match(rejected('SELECT * FROM events a JOIN events b ON a.id = b.id'), /only once/);
    assert.match(rejected('SELECT * FROM events a JOIN events b ON a.id = b.id JOIN sessions ON a.session_id = sessions.session_id'), /only once/);
    assert.match(rejected('SELECT id FROM events, events, sessions'), /only once/);
    assert.match(rejected('SELECT id FROM events WHERE EXISTS (SELECT 1 FROM events)'), /only once/);
    assert.match(rejected('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 2) SELECT x FROM c'), /recursive|SELECT/);
    assert.match(rejected('SELECT * FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 2) SELECT x FROM c)'), /recursive/);
    assert.match(rejected('SELECT randomblob(1000000)'), /randomblob/);
    assert.match(rejected('SELECT zeroblob(1000000)'), /zeroblob/);
    assert.equal(validateReadOnlySql("SELECT id FROM events WHERE event != 'randomblob'").ok, true);
    assert.equal(validateReadOnlySql('SELECT * FROM events JOIN sessions ON events.session_id = sessions.session_id').ok, true);
    assert.equal(validateReadOnlySql('SELECT id FROM (WITH p AS (SELECT id FROM events) SELECT id FROM p)').ok, true);
  });

  test('rejects IN against another table or a table-valued function', () => {
    const ts = 1700000000000;
    const tuple = `('b-secret','ub9','proj-b',${ts})`;
    assert.match(rejected(`SELECT 'x' WHERE ${tuple} IN identity_map`), /identity_map/);
    assert.match(rejected(`SELECT 'x' WHERE ${tuple} IN user_profiles`), /user_profiles/);
    assert.match(rejected(`SELECT 'x' WHERE ${tuple} IN pragma_table_info('events')`), /table-valued/);
    assert.match(rejected('SELECT * FROM json_each(properties)'), /table-valued/);
    assert.equal(validateReadOnlySql("SELECT id FROM events WHERE event IN ('click', 'page')").ok, true);
    assert.equal(validateReadOnlySql('SELECT id FROM events WHERE session_id IN (SELECT session_id FROM sessions)').ok, true);
  });
});

describe('wrapProjectSql', () => {
  test('binds the project name twice and hides other projects and resolved_user_id', () => {
    const { wrapped, rows } = run("SELECT * FROM events WHERE event != 'DELETE'", "o'hare");
    assert.deepEqual(wrapped.params, ["o'hare", '2026-01-01', '2026-01-02', "o'hare", '2026-01-01', '2026-01-02']);
    assert.deepEqual(wrapped.window, TEST_WINDOW);
    assert.match(wrapped.sql, /FROM main\.events WHERE project_id = \? AND date >= \? AND date <= \?/);
    assert.match(wrapped.sql, /FROM main\.sessions WHERE project_id = \? AND date >= \? AND date <= \?/);
    assert.doesNotMatch(wrapped.sql, /resolved_user_id/);
    assert.equal(rows.length, 0);

    const mine = run('SELECT * FROM events');
    assert.deepEqual(mine.rows.map((row) => row.id), ['2']);
    assert.equal(mine.rows[0].resolved_user_id, undefined);
    assert.equal(Object.hasOwn(mine.rows[0], 'project_id'), false);

    const sessions = run('SELECT session_id, project_id, entry_page FROM sessions');
    assert.deepEqual(sessions.rows, [{ session_id: 's2', project_id: 'mine', entry_page: '/mine' }]);
  });

  test('joins events to sessions without reading another project', () => {
    const { rows } = run(`
      SELECT events.id, sessions.entry_page
      FROM events
      JOIN sessions ON events.session_id = sessions.session_id
    `);
    assert.deepEqual(rows, [{ id: '2', entry_page: '/mine' }]);
  });

  test('caps a missing LIMIT at 1001 fetched rows and keeps a small user LIMIT', () => {
    const open = wrapProjectSql('SELECT id FROM events', 'mine');
    assert.equal(open.probeTruncation, true);
    assert.equal(open.returnLimit, SQL_ROW_CAP);
    assert.match(open.sql, new RegExp(`LIMIT ${SQL_FETCH_CAP}\\s*$`));

    const small = wrapProjectSql('SELECT id FROM events LIMIT 10', 'mine');
    assert.equal(small.probeTruncation, false);
    assert.equal(small.returnLimit, 10);
    assert.match(small.sql, /LIMIT 10\s*$/);

    const large = wrapProjectSql('SELECT id FROM events LIMIT 5000 OFFSET 2', 'mine');
    assert.equal(large.probeTruncation, true);
    assert.match(large.sql, /LIMIT 1001 OFFSET 2/);

    const comma = wrapProjectSql('SELECT id FROM events LIMIT 1, 5000', 'mine');
    assert.match(comma.sql, /LIMIT 1, 1001/);

    const trailing = wrapProjectSql('SELECT id FROM events;', 'mine');
    assert.match(trailing.sql, /LIMIT 1001;/);

    const commented = wrapProjectSql('SELECT id FROM events -- c', 'mine', TEST_WINDOW);
    assert.match(commented.sql, /-- c\nLIMIT 1001/);
    assert.equal(database().prepare(commented.sql).all(...commented.params).length, 1);
    assert.match(rejected('SELECT id FROM events LIMIT 1000+500'), /plain non-negative integer/);
    assert.match(rejected('SELECT id FROM events LIMIT (1000)'), /plain non-negative integer/);
  });

  test('omits rows outside the date window', () => {
    const events = run('SELECT id, date FROM events ORDER BY date');
    assert.deepEqual(events.rows, [{ id: '2', date: '2026-01-02' }]);
    const sessions = run('SELECT session_id, date FROM sessions ORDER BY date');
    assert.deepEqual(sessions.rows, [{ session_id: 's2', date: '2026-01-02' }]);
  });

  test('resolves days as an inclusive UTC window and rejects a span over 90 days', () => {
    const now = new Date('2026-04-10T23:30:00.000Z');
    assert.deepEqual(resolveSqlWindow(undefined, now), { date_from: '2026-04-04', date_to: '2026-04-10' });
    assert.deepEqual(resolveSqlWindow({ days: 1 }, now), { date_from: '2026-04-10', date_to: '2026-04-10' });
    assert.deepEqual(resolveSqlWindow({ days: 90 }, now), { date_from: '2026-01-11', date_to: '2026-04-10' });
    assert.deepEqual(resolveSqlWindow({ date_from: '2026-01-01', date_to: '2026-03-31' }), {
      date_from: '2026-01-01',
      date_to: '2026-03-31',
    });

    for (const window of [
      { days: 0 },
      { days: 91 },
      { days: 1.5 },
      { days: '7' },
      { date_from: '2026-04-02', date_to: '2026-04-01' },
      { date_from: '2026-02-31', date_to: '2026-03-01' },
      { date_from: '2026-01-01' },
      { days: 7, date_from: '2026-01-01', date_to: '2026-01-02' },
      { date_from: '2026-01-01', date_to: '2026-04-01' },
    ]) {
      assert.throws(
        () => resolveSqlWindow(window, now),
        (err) => err instanceof AnalyticsError && err.code === 'INVALID_WINDOW',
        JSON.stringify(window),
      );
    }
  });

  test('a string that names another table does not expose that table', () => {
    const { rows } = run("SELECT id FROM events WHERE event != 'user_profiles'");
    assert.deepEqual(rows.map((row) => row.id), ['2']);
  });
});
