import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnalyticsHandler } from '../src/handler.js';

function makeHandler(overrides = {}) {
  return createAnalyticsHandler({
    db: {
      listProjects: async () => ['proj-a'],
      query: async () => ({ rows: [{ event_count: 1 }] }),
      getProperties: async () => ({ events: [], property_keys: [] }),
      ...overrides,
    },
    validateRead: () => ({ valid: true }),
    validateWrite: () => ({ valid: true }),
  });
}

test('core keeps OSS basic routes like query', async () => {
  const handler = makeHandler();
  const { response } = await handler(new Request('https://api.test/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'aak_test' },
    body: JSON.stringify({ project: 'site-a', metrics: ['event_count'] }),
  }));
  assert.equal(response.status, 200);
});

test('core no longer exposes richer read endpoints reserved for hosted paid', async () => {
  const handler = makeHandler();
  const removedRoutes = [
    'https://api.test/sessions?project=site-a',
    'https://api.test/properties/received?project=site-a',
    'https://api.test/breakdown?project=site-a&property=path',
    'https://api.test/insights?project=site-a',
    'https://api.test/pages?project=site-a',
    'https://api.test/sessions/distribution?project=site-a',
    'https://api.test/heatmap?project=site-a',
  ];

  for (const url of removedRoutes) {
    const { response } = await handler(new Request(url, { headers: { 'X-API-Key': 'aak_test' } }));
    assert.equal(response.status, 404);
  }
});
