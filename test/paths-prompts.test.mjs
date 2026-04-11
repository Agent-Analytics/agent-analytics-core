import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildPathsReport } from '../src/path-analytics.js';

function pathRows(rows) {
  return rows.map((row, index) => ({
    session_id: row.session_id,
    entry_page: row.entry_page,
    exit_page: row.exit_page ?? null,
    event: row.event,
    path: row.path ?? null,
    timestamp: row.timestamp ?? index + 1,
  }));
}

function report(rows, options = {}) {
  return buildPathsReport(pathRows(rows), {
    goalEvent: options.goalEvent ?? 'signup',
    maxSteps: options.maxSteps ?? 5,
    pathLimit: options.pathLimit ?? 5,
  });
}

function flattenTree(nodes) {
  const flattened = [];
  const visit = (node) => {
    flattened.push(node);
    for (const child of node.children || []) visit(child);
  };
  for (const node of nodes || []) visit(node);
  return flattened;
}

function findNode(entry, type, value) {
  return flattenTree(entry.tree).find((node) => node.type === type && node.value === value);
}

describe('session paths prompt coverage', () => {
  test('prompt: summarize top entry pages, top exit pages, and the one path most worth improving', () => {
    const result = report([
      { session_id: 'home-converts', entry_page: '/home', exit_page: '/signup', event: 'page_view', path: '/home', timestamp: 1 },
      { session_id: 'home-converts', entry_page: '/home', exit_page: '/signup', event: 'page_view', path: '/pricing', timestamp: 2 },
      { session_id: 'home-converts', entry_page: '/home', exit_page: '/signup', event: 'signup', timestamp: 3 },
      { session_id: 'home-drops', entry_page: '/home', exit_page: '/pricing', event: 'page_view', path: '/home', timestamp: 4 },
      { session_id: 'home-drops', entry_page: '/home', exit_page: '/pricing', event: 'page_view', path: '/pricing', timestamp: 5 },
      { session_id: 'home-drops', entry_page: '/home', exit_page: '/pricing', event: 'cta_click', timestamp: 6 },
      { session_id: 'blog-drops', entry_page: '/blog', exit_page: '/blog', event: 'page_view', path: '/blog', timestamp: 7 },
    ]);

    const [topEntry] = result.entry_paths;
    assert.equal(topEntry.entry_page, '/home');
    assert.equal(topEntry.sessions, 2);
    assert.equal(topEntry.conversions, 1);
    assert.equal(topEntry.conversion_rate, 0.5);
    assert.deepEqual(topEntry.exit_pages, [
      { exit_page: '/pricing', sessions: 1, conversions: 0, conversion_rate: 0, drop_offs: 1, drop_off_rate: 1 },
      { exit_page: '/signup', sessions: 1, conversions: 1, conversion_rate: 1, drop_offs: 0, drop_off_rate: 0 },
    ]);

    const pricing = findNode(topEntry, 'page', '/pricing');
    assert.equal(pricing.sessions, 2);
    assert.ok(findNode(topEntry, 'goal', 'signup'));
    assert.ok(findNode(topEntry, 'drop_off', '/pricing'));
  });

  test('prompt: find entry pages that start many sessions but fail to reach signup', () => {
    const result = report([
      { session_id: 'docs-1', entry_page: '/docs', exit_page: '/setup', event: 'page_view', path: '/docs', timestamp: 1 },
      { session_id: 'docs-1', entry_page: '/docs', exit_page: '/setup', event: 'page_view', path: '/setup', timestamp: 2 },
      { session_id: 'docs-1', entry_page: '/docs', exit_page: '/setup', event: 'install_click', timestamp: 3 },
      { session_id: 'docs-2', entry_page: '/docs', exit_page: '/setup', event: 'page_view', path: '/docs', timestamp: 4 },
      { session_id: 'docs-2', entry_page: '/docs', exit_page: '/setup', event: 'page_view', path: '/setup', timestamp: 5 },
      { session_id: 'docs-3', entry_page: '/docs', exit_page: '/docs', event: 'page_view', path: '/docs', timestamp: 6 },
      { session_id: 'pricing-1', entry_page: '/pricing', exit_page: '/signup', event: 'page_view', path: '/pricing', timestamp: 7 },
      { session_id: 'pricing-1', entry_page: '/pricing', exit_page: '/signup', event: 'signup', timestamp: 8 },
      { session_id: 'pricing-2', entry_page: '/pricing', exit_page: '/signup', event: 'page_view', path: '/pricing', timestamp: 9 },
      { session_id: 'pricing-2', entry_page: '/pricing', exit_page: '/signup', event: 'signup', timestamp: 10 },
    ]);

    const weakEntry = result.entry_paths[0];
    assert.equal(weakEntry.entry_page, '/docs');
    assert.equal(weakEntry.sessions, 3);
    assert.equal(weakEntry.conversions, 0);
    assert.equal(weakEntry.exit_pages[0].exit_page, '/setup');
    assert.equal(weakEntry.exit_pages[0].drop_offs, 2);

    const setup = findNode(weakEntry, 'page', '/setup');
    assert.equal(setup.sessions, 2);
    assert.ok(findNode(weakEntry, 'event', 'install_click'));
  });

  test('prompt: pick a high-traffic drop-off path for a narrow experiment', () => {
    const rows = [];
    for (let i = 1; i <= 3; i += 1) {
      rows.push(
        { session_id: `drop-${i}`, entry_page: '/home', exit_page: '/signup', event: 'page_view', path: '/home', timestamp: i * 10 },
        { session_id: `drop-${i}`, entry_page: '/home', exit_page: '/signup', event: 'page_view', path: '/pricing', timestamp: i * 10 + 1 },
        { session_id: `drop-${i}`, entry_page: '/home', exit_page: '/signup', event: 'cta_click', timestamp: i * 10 + 2 },
      );
    }
    rows.push(
      { session_id: 'convert-1', entry_page: '/home', exit_page: '/signup', event: 'page_view', path: '/home', timestamp: 100 },
      { session_id: 'convert-1', entry_page: '/home', exit_page: '/signup', event: 'page_view', path: '/pricing', timestamp: 101 },
      { session_id: 'convert-1', entry_page: '/home', exit_page: '/signup', event: 'cta_click', timestamp: 102 },
      { session_id: 'convert-1', entry_page: '/home', exit_page: '/signup', event: 'signup', timestamp: 103 },
    );

    const result = report(rows);
    const home = result.entry_paths[0];
    const cta = findNode(home, 'event', 'cta_click');
    const terminal = cta.children[0];

    assert.equal(home.entry_page, '/home');
    assert.equal(home.sessions, 4);
    assert.equal(home.conversions, 1);
    assert.equal(cta.sessions, 4);
    assert.equal(terminal.type, 'drop_off');
    assert.equal(terminal.value, '/signup');
    assert.equal(terminal.sessions, 3);
  });

  test('prompt: identify content or docs entry pages that lead to deeper product pages or signup', () => {
    const result = report([
      { session_id: 'blog-intent', entry_page: '/blog/session-paths', exit_page: '/signup', event: 'page_view', path: '/blog/session-paths', timestamp: 1 },
      { session_id: 'blog-intent', entry_page: '/blog/session-paths', exit_page: '/signup', event: '$impression', timestamp: 2 },
      { session_id: 'blog-intent', entry_page: '/blog/session-paths', exit_page: '/signup', event: 'page_view', path: '/docs/setup', timestamp: 3 },
      { session_id: 'blog-intent', entry_page: '/blog/session-paths', exit_page: '/signup', event: 'page_view', path: '/pricing', timestamp: 4 },
      { session_id: 'blog-intent', entry_page: '/blog/session-paths', exit_page: '/signup', event: 'signup', timestamp: 5 },
      { session_id: 'docs-intent', entry_page: '/docs/plugin', exit_page: '/signup', event: 'page_view', path: '/docs/plugin', timestamp: 6 },
      { session_id: 'docs-intent', entry_page: '/docs/plugin', exit_page: '/signup', event: 'page_view', path: '/install', timestamp: 7 },
      { session_id: 'docs-intent', entry_page: '/docs/plugin', exit_page: '/signup', event: 'signup', timestamp: 8 },
      { session_id: 'vanity', entry_page: '/blog/changelog', exit_page: '/blog/changelog', event: 'page_view', path: '/blog/changelog', timestamp: 9 },
      { session_id: 'vanity', entry_page: '/blog/changelog', exit_page: '/blog/changelog', event: '$scroll_depth', timestamp: 10 },
    ]);

    const blogIntent = result.entry_paths.find((entry) => entry.entry_page === '/blog/session-paths');
    const docsIntent = result.entry_paths.find((entry) => entry.entry_page === '/docs/plugin');
    const vanity = result.entry_paths.find((entry) => entry.entry_page === '/blog/changelog');

    assert.equal(blogIntent.conversions, 1);
    assert.ok(findNode(blogIntent, 'page', '/docs/setup'));
    assert.ok(findNode(blogIntent, 'page', '/pricing'));
    assert.ok(findNode(blogIntent, 'goal', 'signup'));
    assert.equal(findNode(blogIntent, 'event', '$impression'), undefined);

    assert.equal(docsIntent.conversions, 1);
    assert.ok(findNode(docsIntent, 'page', '/install'));
    assert.ok(findNode(docsIntent, 'goal', 'signup'));

    assert.equal(vanity.conversions, 0);
    assert.equal(vanity.tree[0].type, 'drop_off');
    assert.equal(vanity.tree[0].value, '/blog/changelog');
    assert.equal(findNode(vanity, 'event', '$scroll_depth'), undefined);
  });
});
