import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnalyticsHandler, ERROR_CODES, AnalyticsError } from '../src/index.js';

// --- Helpers ---

const noop = () => ({ valid: true });
const deny = () => ({ valid: false });
const denyWith = (msg) => () => ({ valid: false, error: msg });

const stubDb = {
  trackEvent: async () => {},
  trackBatch: async () => {},
  listProjects: async () => [],
  getStats: async () => ({}),
  getEvents: async () => [],
  getSessions: async () => [],
  getProperties: async () => ({}),
  getPropertiesReceived: async () => ({}),
  query: async () => ({ data: [] }),
};

function makeHandler(overrides = {}) {
  return createAnalyticsHandler({
    db: stubDb,
    validateWrite: noop,
    validateRead: noop,
    ...overrides,
  });
}

function req(method, path, body) {
  const init = { method, headers: { 'User-Agent': 'test-agent' } };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const r = new Request(`http://localhost${path}`, init);
  // Patch .json() for stubbed request bodies
  if (body) {
    r._body = body;
    const origJson = r.json.bind(r);
    r.json = async () => {
      try { return await origJson(); } catch { return r._body; }
    };
  }
  return r;
}

async function getError(handler, method, path, body) {
  const { response } = await handler(req(method, path, body));
  const data = await response.json();
  return { status: response.status, ...data };
}

// --- ERROR_CODES export ---

test('ERROR_CODES is frozen and has all codes', () => {
  assert.ok(Object.isFrozen(ERROR_CODES));
  const expected = [
    'AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND', 'PROJECT_REQUIRED',
    'MISSING_FIELDS', 'INVALID_BODY', 'BATCH_TOO_LARGE', 'INVALID_METRIC',
    'INVALID_GROUP_BY', 'INVALID_FILTER_OP', 'INVALID_PROPERTY_KEY',
    'QUERY_FAILED', 'INTERNAL_ERROR',
  ];
  for (const code of expected) {
    assert.equal(ERROR_CODES[code], code, `ERROR_CODES.${code} should equal "${code}"`);
  }
});

test('AnalyticsError has code, message, status', () => {
  const err = new AnalyticsError('TEST_CODE', 'test message', 418);
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'TEST_CODE');
  assert.equal(err.message, 'test message');
  assert.equal(err.status, 418);
});

// --- Handler error responses ---

test('404 on unknown route', async () => {
  const h = makeHandler();
  const err = await getError(h, 'GET', '/nonexistent');
  assert.equal(err.status, 404);
  assert.equal(err.error, ERROR_CODES.NOT_FOUND);
  assert.ok(err.message);
});

test('401 on read endpoint without auth', async () => {
  const h = makeHandler({ validateRead: deny });
  const err = await getError(h, 'GET', '/stats?project=p1');
  assert.equal(err.status, 401);
  assert.equal(err.error, ERROR_CODES.AUTH_REQUIRED);
});

test('400 on read endpoint without project', async () => {
  const h = makeHandler();
  const err = await getError(h, 'GET', '/stats');
  assert.equal(err.status, 400);
  assert.equal(err.error, ERROR_CODES.PROJECT_REQUIRED);
});

test('400 on POST /track missing fields', async () => {
  const h = makeHandler();
  const err = await getError(h, 'POST', '/track', { project: 'p1' });
  assert.equal(err.status, 400);
  assert.equal(err.error, ERROR_CODES.MISSING_FIELDS);
});

test('403 on POST /track with denied auth', async () => {
  const h = makeHandler({ validateWrite: deny });
  const err = await getError(h, 'POST', '/track', { project: 'p1', event: 'click' });
  assert.equal(err.status, 403);
  assert.equal(err.error, ERROR_CODES.FORBIDDEN);
});

test('403 on POST /track preserves custom auth error message', async () => {
  const h = makeHandler({ validateWrite: denyWith('invalid token') });
  const err = await getError(h, 'POST', '/track', { project: 'p1', event: 'click' });
  assert.equal(err.error, ERROR_CODES.FORBIDDEN);
  assert.equal(err.message, 'invalid token');
});

test('400 on POST /track/batch with non-array', async () => {
  const h = makeHandler();
  const err = await getError(h, 'POST', '/track/batch', { events: 'not-array' });
  assert.equal(err.status, 400);
  assert.equal(err.error, ERROR_CODES.INVALID_BODY);
});

test('400 on POST /track/batch with >100 events', async () => {
  const h = makeHandler();
  const events = Array.from({ length: 101 }, (_, i) => ({ project: 'p', event: `e${i}` }));
  const err = await getError(h, 'POST', '/track/batch', { events });
  assert.equal(err.status, 400);
  assert.equal(err.error, ERROR_CODES.BATCH_TOO_LARGE);
});

test('400 on POST /query without project', async () => {
  const h = makeHandler();
  const err = await getError(h, 'POST', '/query', {});
  assert.equal(err.status, 400);
  assert.equal(err.error, ERROR_CODES.PROJECT_REQUIRED);
});

test('INVALID_METRIC propagates through POST /query', async () => {
  const badDb = {
    ...stubDb,
    query: async (opts) => {
      throw new AnalyticsError(ERROR_CODES.INVALID_METRIC, 'invalid metric: bad_metric', 400);
    },
  };
  const h = makeHandler({ db: badDb });
  const err = await getError(h, 'POST', '/query', { project: 'p1', metrics: ['bad_metric'] });
  assert.equal(err.status, 400);
  assert.equal(err.error, ERROR_CODES.INVALID_METRIC);
});

test('QUERY_FAILED for non-AnalyticsError in query', async () => {
  const badDb = {
    ...stubDb,
    query: async () => { throw new Error('sqlite exploded'); },
  };
  const h = makeHandler({ db: badDb });
  const err = await getError(h, 'POST', '/query', { project: 'p1' });
  assert.equal(err.status, 400);
  assert.equal(err.error, ERROR_CODES.QUERY_FAILED);
});

test('500 INTERNAL_ERROR for unexpected handler crash', async () => {
  const badDb = {
    ...stubDb,
    getStats: async () => { throw new Error('unexpected'); },
  };
  const h = makeHandler({ db: badDb });
  const err = await getError(h, 'GET', '/stats?project=p1');
  assert.equal(err.status, 500);
  assert.equal(err.error, ERROR_CODES.INTERNAL_ERROR);
});

// --- Response shape ---

test('all error responses have { error, message } shape', async () => {
  const h = makeHandler({ validateRead: deny });

  const cases = [
    ['GET', '/nonexistent'],
    ['GET', '/stats?project=p1'],
    ['GET', '/stats'],
  ];

  for (const [method, path] of cases) {
    const { response } = await h(req(method, path));
    const data = await response.json();
    assert.ok(typeof data.error === 'string', `${method} ${path}: error should be string`);
    assert.ok(typeof data.message === 'string', `${method} ${path}: message should be string`);
    assert.ok(data.error === data.error.toUpperCase(), `${method} ${path}: error code should be UPPER_CASE`);
  }
});
