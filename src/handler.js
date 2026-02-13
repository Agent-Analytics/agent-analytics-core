/**
 * Core analytics handler — platform-agnostic.
 *
 * Consumers provide { db, validateWrite, validateRead } to plug in
 * their own auth and database layer.
 */

import { TRACKER_JS } from './tracker.js';
import { isBot } from './bot.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  'Access-Control-Allow-Credentials': 'false',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

const ROUTES = {
  'POST /track':              handleTrack,
  'POST /track/batch':        handleTrackBatch,
  'GET /projects':            handleListProjects,
  'GET /stats':               handleStats,
  'GET /sessions':            handleSessions,
  'GET /events':              handleEvents,
  'POST /query':              handleQuery,
  'GET /properties/received': handlePropertiesReceived,
  'GET /properties':          handleProperties,
};

/**
 * Create an analytics request handler.
 *
 * @param {Object} opts
 * @param {import('./db/adapter.js').DbAdapter} opts.db
 * @param {(request: Request, body: any) => { valid: boolean, error?: string }} opts.validateWrite — required
 * @param {(request: Request, url: URL) => { valid: boolean }} opts.validateRead — required
 * @param {boolean} [opts.useQueue=false]
 * @param {Object} [opts.healthExtra={}]
 * @returns {(request: Request) => Promise<{ response: Response, writeOps?: Promise[], queueMessages?: any[] }>}
 */
export function createAnalyticsHandler({ db, validateWrite, validateRead, useQueue = false, healthExtra = {} }) {
  if (!validateWrite) throw new Error('validateWrite is required — provide an auth function for write endpoints');
  if (!validateRead) throw new Error('validateRead is required — provide an auth function for read endpoints');

  return async function handleRequest(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return { response: new Response(null, { headers: CORS_HEADERS }) };
    }

    if (path === '/health') {
      return { response: json({ status: 'ok', service: 'agent-analytics', ...healthExtra }) };
    }

    if (path === '/tracker.js') {
      return {
        response: new Response(TRACKER_JS, {
          headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=3600', ...CORS_HEADERS },
        }),
      };
    }

    try {
      const handler = ROUTES[`${request.method} ${path}`];
      if (handler) return await handler({ request, url, db, validateWrite, validateRead, useQueue });

      return { response: json({ error: 'not found' }, 404) };
    } catch (err) {
      console.error('Error:', err);
      return { response: json({ error: 'internal error' }, 500) };
    }
  };
}

// --- Individual handlers ---

async function handleTrack({ request, db, validateWrite, useQueue }) {
  const ua = request.headers.get('User-Agent');
  if (isBot(ua)) {
    return { response: json({ ok: true }) };
  }

  const body = await request.json();
  const { project, event, properties, user_id, session_id, timestamp } = body;

  if (!project || !event) {
    return { response: json({ error: 'project and event required' }, 400) };
  }

  const auth = validateWrite(request, body);
  if (!auth.valid) {
    return { response: json({ error: auth.error || 'forbidden' }, 403) };
  }

  const eventData = { project, event, properties, user_id, session_id, timestamp: timestamp || Date.now() };

  if (useQueue) {
    return { response: json({ ok: true }), queueMessages: [eventData] };
  }

  const writeOp = db.trackEvent(eventData)
    .catch(err => console.error('Track write failed:', err));

  return { response: json({ ok: true }), writeOps: [writeOp] };
}

async function handleTrackBatch({ request, db, validateWrite, useQueue }) {
  const ua = request.headers.get('User-Agent');
  if (isBot(ua)) {
    return { response: json({ ok: true }) };
  }

  const body = await request.json();
  const { events } = body;

  if (!Array.isArray(events) || events.length === 0) {
    return { response: json({ error: 'events array required' }, 400) };
  }
  if (events.length > 100) {
    return { response: json({ error: 'max 100 events per batch' }, 400) };
  }

  const auth = validateWrite(request, body);
  if (!auth.valid) {
    return { response: json({ error: auth.error || 'forbidden' }, 403) };
  }

  const normalized = events.map(e => ({
    project: e.project,
    event: e.event,
    properties: e.properties,
    user_id: e.user_id,
    session_id: e.session_id,
    timestamp: e.timestamp || Date.now(),
  }));

  if (useQueue) {
    return { response: json({ ok: true, count: events.length }), queueMessages: normalized };
  }

  const writeOp = db.trackBatch(normalized)
    .catch(err => console.error('Batch write failed:', err));

  return { response: json({ ok: true, count: events.length }), writeOps: [writeOp] };
}

async function handleListProjects({ request, url, db, validateRead }) {
  const auth = validateRead(request, url);
  if (!auth.valid) {
    return { response: json({ error: 'unauthorized - API key required' }, 401) };
  }

  const projects = await db.listProjects();
  return { response: json({ projects }) };
}

async function handleStats({ request, url, db, validateRead }) {
  const auth = validateRead(request, url);
  if (!auth.valid) {
    return { response: json({ error: 'unauthorized - API key required' }, 401) };
  }

  const project = url.searchParams.get('project');
  if (!project) return { response: json({ error: 'project required' }, 400) };

  const since = url.searchParams.get('since') || undefined;
  const groupBy = url.searchParams.get('groupBy') || 'day';
  const stats = await db.getStats({ project, since, groupBy });

  return { response: json({ project, ...stats }) };
}

async function handleEvents({ request, url, db, validateRead }) {
  const auth = validateRead(request, url);
  if (!auth.valid) {
    return { response: json({ error: 'unauthorized - API key required' }, 401) };
  }

  const project = url.searchParams.get('project');
  if (!project) return { response: json({ error: 'project required' }, 400) };

  const event = url.searchParams.get('event');
  const session_id = url.searchParams.get('session_id');
  const since = url.searchParams.get('since') || undefined;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 100, 1), 1000);

  const events = await db.getEvents({ project, event, session_id, since, limit });
  return { response: json({ project, events }) };
}

async function handleQuery({ request, url, db, validateRead }) {
  const auth = validateRead(request, url);
  if (!auth.valid) {
    return { response: json({ error: 'unauthorized - API key required' }, 401) };
  }

  const body = await request.json();
  if (!body.project) return { response: json({ error: 'project required' }, 400) };

  try {
    const result = await db.query(body);
    return { response: json({ project: body.project, ...result }) };
  } catch (err) {
    console.error('Query error:', err);
    return { response: json({ error: 'query failed' }, 400) };
  }
}

async function handleSessions({ request, url, db, validateRead }) {
  const auth = validateRead(request, url);
  if (!auth.valid) {
    return { response: json({ error: 'unauthorized - API key required' }, 401) };
  }

  const project = url.searchParams.get('project');
  if (!project) return { response: json({ error: 'project required' }, 400) };

  const since = url.searchParams.get('since') || undefined;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 100, 1), 1000);
  const user_id = url.searchParams.get('user_id');
  const is_bounce_raw = url.searchParams.get('is_bounce');
  const is_bounce = is_bounce_raw !== null ? Number(is_bounce_raw) : undefined;

  const sessions = await db.getSessions({ project, since, user_id, is_bounce, limit });
  return { response: json({ project, sessions }) };
}

async function handlePropertiesReceived({ request, url, db, validateRead }) {
  const auth = validateRead(request, url);
  if (!auth.valid) {
    return { response: json({ error: 'unauthorized - API key required' }, 401) };
  }

  const project = url.searchParams.get('project');
  if (!project) return { response: json({ error: 'project required' }, 400) };

  const since = url.searchParams.get('since') || undefined;
  const sample = parseInt(url.searchParams.get('sample')) || 5000;
  const result = await db.getPropertiesReceived({ project, since, sample });

  return { response: json({ project, ...result }) };
}

async function handleProperties({ request, url, db, validateRead }) {
  const auth = validateRead(request, url);
  if (!auth.valid) {
    return { response: json({ error: 'unauthorized - API key required' }, 401) };
  }

  const project = url.searchParams.get('project');
  if (!project) return { response: json({ error: 'project required' }, 400) };

  const since = url.searchParams.get('since') || undefined;
  const result = await db.getProperties({ project, since });

  return { response: json({ project, ...result }) };
}
