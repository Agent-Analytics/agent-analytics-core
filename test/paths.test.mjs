import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { BaseAdapter } from '../src/db/base-adapter.js';
import { buildPathsReport } from '../src/path-analytics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(resolve(__dirname, '../schema.sql'), 'utf-8');

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

function pathRows(rows) {
  return rows.map((row, index) => ({
    session_id: row.session_id,
    entry_page: row.entry_page,
    event: row.event,
    path: row.path ?? null,
    timestamp: row.timestamp ?? index + 1,
  }));
}

describe('buildPathsReport', () => {
  test('builds mixed page and event paths and attributes goal in-session', () => {
    const result = buildPathsReport(pathRows([
      { session_id: 's1', entry_page: '/landing', event: 'page_view', path: '/landing', timestamp: 1 },
      { session_id: 's1', entry_page: '/landing', event: 'page_view', path: '/pricing', timestamp: 2 },
      { session_id: 's1', entry_page: '/landing', event: 'cta_click', timestamp: 3 },
      { session_id: 's1', entry_page: '/landing', event: 'signup', timestamp: 4 },
    ]), {
      goalEvent: 'signup',
      maxSteps: 5,
      pathLimit: 5,
    });

    assert.equal(result.entry_paths.length, 1);
    assert.equal(result.entry_paths[0].entry_page, '/landing');
    assert.equal(result.entry_paths[0].sessions, 1);
    assert.equal(result.entry_paths[0].conversions, 1);
    assert.equal(result.entry_paths[0].tree[0].type, 'page');
    assert.equal(result.entry_paths[0].tree[0].value, '/pricing');
    assert.equal(result.entry_paths[0].tree[0].children[0].type, 'event');
    assert.equal(result.entry_paths[0].tree[0].children[0].value, 'cta_click');
    assert.equal(result.entry_paths[0].tree[0].children[0].children[0].type, 'goal');
    assert.equal(result.entry_paths[0].tree[0].children[0].children[0].value, 'signup');
  });

  test('collapses duplicate nodes and ignores passive events', () => {
    const result = buildPathsReport(pathRows([
      { session_id: 's1', entry_page: '/landing', event: 'page_view', path: '/landing', timestamp: 1 },
      { session_id: 's1', entry_page: '/landing', event: '$scroll_depth', timestamp: 2 },
      { session_id: 's1', entry_page: '/landing', event: 'page_view', path: '/pricing', timestamp: 3 },
      { session_id: 's1', entry_page: '/landing', event: 'page_view', path: '/pricing', timestamp: 4 },
      { session_id: 's1', entry_page: '/landing', event: 'cta_click', timestamp: 5 },
      { session_id: 's1', entry_page: '/landing', event: 'cta_click', timestamp: 6 },
    ]), {
      goalEvent: 'signup',
      maxSteps: 5,
      pathLimit: 5,
    });

    assert.equal(result.entry_paths[0].tree.length, 1);
    assert.equal(result.entry_paths[0].tree[0].type, 'page');
    assert.equal(result.entry_paths[0].tree[0].value, '/pricing');
    assert.equal(result.entry_paths[0].tree[0].children.length, 1);
    assert.equal(result.entry_paths[0].tree[0].children[0].type, 'event');
    assert.equal(result.entry_paths[0].tree[0].children[0].value, 'cta_click');
    assert.equal(result.entry_paths[0].tree[0].children[0].children[0].type, 'drop_off');
  });

  test('marks long sessions as truncated when max steps is exceeded', () => {
    const result = buildPathsReport(pathRows([
      { session_id: 's1', entry_page: '/landing', event: 'page_view', path: '/landing', timestamp: 1 },
      { session_id: 's1', entry_page: '/landing', event: 'page_view', path: '/pricing', timestamp: 2 },
      { session_id: 's1', entry_page: '/landing', event: 'cta_click', timestamp: 3 },
      { session_id: 's1', entry_page: '/landing', event: 'page_view', path: '/checkout', timestamp: 4 },
      { session_id: 's1', entry_page: '/landing', event: 'form_submit', timestamp: 5 },
      { session_id: 's1', entry_page: '/landing', event: 'purchase_intent', timestamp: 6 },
    ]), {
      goalEvent: 'signup',
      maxSteps: 3,
      pathLimit: 5,
    });

    const [first] = result.entry_paths[0].tree;
    assert.equal(first.children[0].children[0].children[0].type, 'truncated');
  });

  test('trims siblings to pathLimit in descending session order', () => {
    const result = buildPathsReport(pathRows([
      { session_id: 'a1', entry_page: '/landing', event: 'page_view', path: '/landing', timestamp: 1 },
      { session_id: 'a1', entry_page: '/landing', event: 'page_view', path: '/pricing', timestamp: 2 },
      { session_id: 'a2', entry_page: '/landing', event: 'page_view', path: '/landing', timestamp: 3 },
      { session_id: 'a2', entry_page: '/landing', event: 'page_view', path: '/pricing', timestamp: 4 },
      { session_id: 'b1', entry_page: '/landing', event: 'page_view', path: '/landing', timestamp: 5 },
      { session_id: 'b1', entry_page: '/landing', event: 'page_view', path: '/docs', timestamp: 6 },
      { session_id: 'c1', entry_page: '/landing', event: 'page_view', path: '/landing', timestamp: 7 },
      { session_id: 'c1', entry_page: '/landing', event: 'page_view', path: '/blog', timestamp: 8 },
    ]), {
      goalEvent: 'signup',
      maxSteps: 5,
      pathLimit: 2,
    });

    assert.equal(result.entry_paths[0].tree.length, 2);
    assert.equal(result.entry_paths[0].tree[0].value, '/pricing');
    assert.equal(result.entry_paths[0].tree[1].value, '/blog');
  });
});

describe('BaseAdapter.getPaths', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  test('returns entry-page path trees with goal and drop_off outcomes', async () => {
    const now = Date.now();

    await adapter.trackEvent({ project: 'p', event: 'page_view', session_id: 's1', user_id: 'u1', timestamp: now, properties: { path: '/landing' } });
    await adapter.trackEvent({ project: 'p', event: 'page_view', session_id: 's1', user_id: 'u1', timestamp: now + 1, properties: { path: '/pricing' } });
    await adapter.trackEvent({ project: 'p', event: 'signup', session_id: 's1', user_id: 'u1', timestamp: now + 2, properties: { path: '/pricing' } });

    await adapter.trackEvent({ project: 'p', event: 'page_view', session_id: 's2', user_id: 'u2', timestamp: now + 10, properties: { path: '/landing' } });
    await adapter.trackEvent({ project: 'p', event: 'cta_click', session_id: 's2', user_id: 'u2', timestamp: now + 11, properties: { path: '/landing' } });

    const result = await adapter.getPaths({
      project: 'p',
      goal_event: 'signup',
      since: '30d',
      max_steps: 5,
      entry_limit: 10,
      path_limit: 5,
      candidate_session_cap: 5000,
    });

    assert.equal(result.goal_event, 'signup');
    assert.equal(result.bounds.max_steps, 5);
    assert.equal(result.entry_paths.length, 1);
    assert.equal(result.entry_paths[0].entry_page, '/landing');
    assert.equal(result.entry_paths[0].sessions, 2);
    assert.equal(result.entry_paths[0].conversions, 1);
    assert.equal(result.entry_paths[0].tree[0].value, '/pricing');
    assert.equal(result.entry_paths[0].tree[0].children[0].type, 'goal');
    assert.equal(result.entry_paths[0].tree[1].value, 'cta_click');
    assert.equal(result.entry_paths[0].tree[1].children[0].type, 'drop_off');
  });
});
