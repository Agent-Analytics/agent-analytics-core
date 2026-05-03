import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createAnalyticsHandler } from '../src/handler.js';
import { AnalyticsError, ERROR_CODES } from '../src/errors.js';
import { TRACKER_CHECKSUMS } from '../src/index.js';

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makeHandler(overrides = {}) {
  return createAnalyticsHandler({
    db: {
      listProjects: async () => ['proj-a'],
      getStats: async () => ({ totals: { total_events: 1 } }),
      getEvents: async () => ([{ event: 'page_view' }]),
      query: async () => ({ rows: [], count: 0 }),
      getPaths: async () => ({ project: 'site-a', goal_event: 'signup', period: { from: '2026-01-01', to: '2026-01-31' }, bounds: {}, entry_paths: [] }),
      getProperties: async () => ({ events: [], property_keys: [] }),
      getPropertiesReceived: async () => ({ properties: [], sample_size: 10 }),
      ...overrides,
    },
    validateRead: () => ({ valid: true }),
    validateWrite: () => ({ valid: true }),
  });
}

test('core serves minified tracker with source and privacy header', async () => {
  const handler = makeHandler();
  const { response } = await handler(new Request('https://api.test/tracker.js'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/javascript');
  assert.equal(response.headers.get('X-Agent-Analytics-Tracker-Checksum-Algorithm'), 'sha256');
  assert.equal(response.headers.get('X-Agent-Analytics-Tracker-SHA256'), TRACKER_CHECKSUMS.trackerMinifiedSha256);
  const text = await response.text();
  assert.equal(sha256Hex(text), TRACKER_CHECKSUMS.trackerMinifiedSha256);
  assert.equal(response.headers.get('X-Agent-Analytics-Tracker-SHA256'), sha256Hex(text));
  assert.match(text, /^\/\*! Agent Analytics tracker/);
  assert.match(text, /Source: \/tracker\.src\.js/);
  assert.match(text, /Privacy: no hard fingerprinting, dynamic script loading, eval, document\.write, or form value collection\./);
});

test('core serves readable tracker source as javascript', async () => {
  const handler = makeHandler();
  const { response } = await handler(new Request('https://api.test/tracker.src.js'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/javascript');
  const text = await response.text();
  assert.match(text, /\(function\(\) \{/);
  assert.match(text, /'use strict';/);
  assert.match(text, /function getAnonId\(\)/);
});

test('core keeps OSS basic routes like stats and events', async () => {
  const handler = makeHandler();
  const { response } = await handler(new Request('https://api.test/stats?project=site-a', {
    headers: { 'X-API-Key': 'aak_test' },
  }));
  assert.equal(response.status, 200);
});

test('core keeps OSS query and properties routes but excludes hosted-only reads', async () => {
  const handler = makeHandler();
  const keptRoutes = [
    'https://api.test/query',
    'https://api.test/paths',
    'https://api.test/properties?project=site-a',
    'https://api.test/properties/received?project=site-a',
  ];

  for (const url of keptRoutes) {
    const init = url.endsWith('/query') || url.endsWith('/paths')
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': 'aak_test' },
          body: JSON.stringify(url.endsWith('/paths')
            ? { project: 'site-a', goal_event: 'signup' }
            : { project: 'site-a', metrics: ['event_count'] }),
        }
      : { headers: { 'X-API-Key': 'aak_test' } };
    const { response } = await handler(new Request(url, init));
    assert.equal(response.status, 200);
  }

  const removedRoutes = [
    'https://api.test/sessions?project=site-a',
    'https://api.test/breakdown?project=site-a&property=path',
    'https://api.test/insights?project=site-a',
    'https://api.test/pages?project=site-a',
    'https://api.test/sessions/distribution?project=site-a',
    'https://api.test/heatmap?project=site-a',
  ];

  for (const url of removedRoutes) {
    const init = url.endsWith('/query')
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': 'aak_test' },
          body: JSON.stringify({ project: 'site-a', metrics: ['event_count'] }),
        }
      : { headers: { 'X-API-Key': 'aak_test' } };
    const { response } = await handler(new Request(url, init));
    assert.equal(response.status, 404);
  }
});

test('core /query returns invalid filter guidance payload from AnalyticsError details', async () => {
  const handler = makeHandler({
    query: async () => {
      throw new AnalyticsError(
        ERROR_CODES.INVALID_FILTER_FIELD,
        'invalid filter field: referrer. Event properties must use properties.<key>, for example properties.referrer',
        400,
        {
          suggested_field: 'properties.referrer',
          available_properties: {
            events: [{ event: 'page_view', count: 1, unique_users: 1, first_seen: '2026-04-02', last_seen: '2026-04-02' }],
            property_keys: ['referrer', 'utm_source'],
          },
        },
      );
    },
  });

  const { response } = await handler(new Request('https://api.test/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'aak_test' },
    body: JSON.stringify({ project: 'site-a', filters: [{ field: 'referrer', op: 'contains', value: 'clawflows.com' }] }),
  }));

  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.error, ERROR_CODES.INVALID_FILTER_FIELD);
  assert.equal(data.suggested_field, 'properties.referrer');
  assert.deepEqual(data.available_properties.property_keys, ['referrer', 'utm_source']);
});
