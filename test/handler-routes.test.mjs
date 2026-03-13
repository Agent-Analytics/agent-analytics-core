import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnalyticsHandler } from '../src/handler.js';

function makeHandler(overrides = {}) {
  return createAnalyticsHandler({
    db: {
      listProjects: async () => ['proj-a'],
      getStats: async () => ({ totals: { total_events: 1 } }),
      getEvents: async () => ([{ event: 'page_view' }]),
      ...overrides,
    },
    validateRead: () => ({ valid: true }),
    validateWrite: () => ({ valid: true }),
  });
}

test('core keeps OSS basic routes like stats and events', async () => {
  const handler = makeHandler();
  const { response } = await handler(new Request('https://api.test/stats?project=site-a', {
    headers: { 'X-API-Key': 'aak_test' },
  }));
  assert.equal(response.status, 200);
});

test('core no longer exposes richer read endpoints reserved for hosted paid', async () => {
  const handler = makeHandler();
  const removedRoutes = [
    'https://api.test/query',
    'https://api.test/properties?project=site-a',
    'https://api.test/sessions?project=site-a',
    'https://api.test/properties/received?project=site-a',
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
