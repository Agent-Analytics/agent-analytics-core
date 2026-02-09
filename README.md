# @agent-analytics/core

Platform-agnostic analytics engine. Zero dependencies — uses only Web APIs. Plug in your own database and auth to get a full analytics API on any runtime (Cloudflare Workers, Node.js, Deno, Bun, etc).

## Install

```bash
npm install @agent-analytics/core
```

## Quick Start: Cloudflare Workers

```js
import { createAnalyticsHandler, D1Adapter } from '@agent-analytics/core';

export default {
  async fetch(request, env, ctx) {
    const db = new D1Adapter(env.DB);

    const validateWrite = (_request, body) => {
      const token = body?.token;
      if (!env.PROJECT_TOKENS) return { valid: true };
      if (!token || !env.PROJECT_TOKENS.split(',').includes(token))
        return { valid: false, error: 'invalid token' };
      return { valid: true };
    };

    const validateRead = (request, url) => {
      const key = request.headers.get('X-API-Key') || url.searchParams.get('key');
      if (!env.API_KEYS || !key || !env.API_KEYS.split(',').includes(key))
        return { valid: false };
      return { valid: true };
    };

    const handle = createAnalyticsHandler({ db, validateWrite, validateRead });
    const { response, writeOps } = await handle(request);

    if (writeOps) writeOps.forEach(op => ctx.waitUntil(op));
    return response;
  },
};
```

Initialize your D1 database with the included `schema.sql`, set `API_KEYS` and `PROJECT_TOKENS` as secrets, and deploy.

## Quick Start: Node.js

```js
import { createServer } from 'node:http';
import { createAnalyticsHandler } from '@agent-analytics/core';
// bring your own adapter — see "Database Adapter Interface" below
import { SqliteAdapter } from './db/sqlite.js';

const db = new SqliteAdapter('analytics.db');

const handleRequest = createAnalyticsHandler({
  db,
  validateWrite: (_req, body) => {
    const token = body?.token;
    if (!token || token !== process.env.PROJECT_TOKEN)
      return { valid: false, error: 'invalid token' };
    return { valid: true };
  },
  validateRead: (req, url) => {
    const key = req.headers.get('X-API-Key') || url.searchParams.get('key');
    if (!key || key !== process.env.API_KEY) return { valid: false };
    return { valid: true };
  },
});

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:8787`);
  let body = null;
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks).toString();
  }
  const request = new Request(url.toString(), { method: req.method, headers: req.headers, body });
  const { response } = await handleRequest(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(await response.text());
}).listen(8787, () => console.log('Listening on :8787'));
```

## Add Tracking to Your Site

Drop one line before `</body>`:

```html
<script src="https://your-server.com/tracker.js" data-project="my-site" data-token="YOUR_TOKEN"></script>
```

This auto-tracks page views (including SPA route changes) with URL, referrer, screen size, browser, OS, device type, and UTM params.

```js
// Track custom events
window.aa.track('signup', { plan: 'pro' });

// Identify a logged-in user (replaces anonymous ID)
window.aa.identify('user_123');

// Manually track a page view
window.aa.page('Dashboard');
```

Events are batched and flushed every 5 seconds, or immediately on page hide/unload via `sendBeacon`.

## Query Your Data

```bash
# Aggregated stats (last 7 days by default)
curl "https://your-server.com/stats?project=my-site" \
  -H "X-API-Key: YOUR_KEY"

# Raw events
curl "https://your-server.com/events?project=my-site&event=page_view&limit=50" \
  -H "X-API-Key: YOUR_KEY"

# Flexible query
curl -X POST "https://your-server.com/query" \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "project": "my-site",
    "metrics": ["event_count", "unique_users"],
    "group_by": ["event"],
    "filters": [{ "field": "properties.browser", "op": "eq", "value": "Chrome" }],
    "date_from": "2025-01-01",
    "limit": 20
  }'

# Discover event names and property keys
curl "https://your-server.com/properties?project=my-site" \
  -H "X-API-Key: YOUR_KEY"
```

## API Reference

### Ingestion (project token required)

#### `POST /track`

Track a single event.

```json
{
  "project": "my-site",
  "token": "pt_your_token",
  "event": "page_view",
  "properties": { "path": "/home", "browser": "Chrome" },
  "user_id": "user_123",
  "session_id": "sess_abc",
  "timestamp": 1706745600000
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `project` | yes | Project identifier |
| `token` | yes* | Project token (*optional if auth is open) |
| `event` | yes | Event name |
| `properties` | | Arbitrary JSON object |
| `user_id` | | User identifier |
| `session_id` | | Session identifier (enables session tracking) |
| `timestamp` | | Unix ms (defaults to `Date.now()`) |

Response: `{ "ok": true }`

#### `POST /track/batch`

Track up to 100 events at once.

```json
{
  "events": [
    { "project": "my-site", "token": "pt_abc", "event": "click", "user_id": "u1" },
    { "project": "my-site", "token": "pt_abc", "event": "scroll", "user_id": "u2" }
  ]
}
```

Response: `{ "ok": true, "count": 2 }`

### Query (API key required)

Pass your key via `X-API-Key` header or `?key=` query parameter.

#### `GET /stats`

Aggregated overview with time series, top events, and session metrics.

| Param | Default | Description |
|-------|---------|-------------|
| `project` | required | Project identifier |
| `since` | 7 days ago | ISO timestamp or date string |
| `groupBy` | `day` | `hour`, `day`, `week`, `month` |

Response:

```json
{
  "project": "my-site",
  "period": { "from": "2025-01-24", "to": "2025-01-31", "groupBy": "day" },
  "totals": { "unique_users": 1203, "total_events": 4821 },
  "timeSeries": [
    { "bucket": "2025-01-24", "unique_users": 180, "total_events": 712 }
  ],
  "events": [
    { "event": "page_view", "count": 3920, "unique_users": 1100 }
  ],
  "sessions": {
    "total_sessions": 1500,
    "bounce_rate": 0.42,
    "avg_duration": 185000,
    "pages_per_session": 3.2,
    "sessions_per_user": 1.2
  }
}
```

#### `GET /sessions`

List sessions with optional filters.

| Param | Default | Description |
|-------|---------|-------------|
| `project` | required | Project identifier |
| `since` | 7 days ago | ISO timestamp or date string |
| `user_id` | | Filter by user |
| `is_bounce` | | `0` or `1` |
| `limit` | 100 | Max 1000 |

#### `GET /events`

Raw event log.

| Param | Default | Description |
|-------|---------|-------------|
| `project` | required | Project identifier |
| `event` | | Filter by event name |
| `session_id` | | Filter by session |
| `since` | 7 days ago | ISO timestamp or date string |
| `limit` | 100 | Max 1000 |

#### `POST /query`

Flexible analytics query with metrics, grouping, filtering, and sorting.

```json
{
  "project": "my-site",
  "metrics": ["event_count", "unique_users"],
  "group_by": ["event", "date"],
  "filters": [
    { "field": "event", "op": "eq", "value": "page_view" },
    { "field": "properties.browser", "op": "eq", "value": "Chrome" }
  ],
  "date_from": "2025-01-01",
  "date_to": "2025-01-31",
  "order_by": "event_count",
  "order": "desc",
  "limit": 50
}
```

| Parameter | Description |
|-----------|-------------|
| `metrics` | `event_count`, `unique_users`, `session_count`, `bounce_rate`, `avg_duration` |
| `group_by` | `event`, `date`, `user_id`, `session_id` |
| `filters[].field` | `event`, `user_id`, `date`, or `properties.*` for JSON property filters |
| `filters[].op` | `eq`, `neq`, `gt`, `lt`, `gte`, `lte` |
| `order_by` | Any metric or group_by field |
| `limit` | Max 1000 (default: 100) |

#### `GET /properties`

Discover event names and property keys for a project.

| Param | Default | Description |
|-------|---------|-------------|
| `project` | required | Project identifier |
| `since` | 7 days ago | ISO timestamp or date string |

Response:

```json
{
  "project": "my-site",
  "events": [
    { "event": "page_view", "count": 3920, "unique_users": 1100, "first_seen": "2025-01-01", "last_seen": "2025-01-31" }
  ],
  "property_keys": ["browser", "device", "hostname", "os", "path", "referrer", "screen", "title", "url"]
}
```

#### `GET /projects`

List all projects (derived from events data).

Response:

```json
{
  "projects": [
    { "id": "my-site", "created": "2025-01-01", "last_active": "2025-01-31", "event_count": 4821 }
  ]
}
```

### Utility

#### `GET /health`

```json
{ "status": "ok", "service": "agent-analytics" }
```

#### `GET /tracker.js`

Serves the client-side tracking script. See [Add Tracking to Your Site](#add-tracking-to-your-site).

## `createAnalyticsHandler()`

The main factory function. Returns an async request handler.

```js
import { createAnalyticsHandler } from '@agent-analytics/core';

const handleRequest = createAnalyticsHandler({
  db,              // DbAdapter — your database implementation
  validateWrite,   // (request: Request, body: object) => { valid: boolean, error?: string }
  validateRead,    // (request: Request, url: URL) => { valid: boolean }
  useQueue,        // boolean (default: false) — return queueMessages instead of writeOps
  healthExtra,     // object (default: {}) — extra fields merged into /health response
});

const { response, writeOps, queueMessages } = await handleRequest(request);
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `db` | yes | Database adapter implementing the `DbAdapter` interface |
| `validateWrite` | yes | Auth function for ingestion endpoints (`/track`, `/track/batch`) |
| `validateRead` | yes | Auth function for query endpoints (`/stats`, `/events`, `/query`, etc) |
| `useQueue` | no | When `true`, returns `queueMessages` array instead of `writeOps` promises |
| `healthExtra` | no | Extra fields merged into the `/health` JSON response |

**Return value:**

| Field | Description |
|-------|-------------|
| `response` | Standard `Response` object — return this to the client |
| `writeOps` | Array of `Promise` — database write operations (when `useQueue` is false) |
| `queueMessages` | Array of event objects to enqueue (when `useQueue` is true) |

## Database Adapter Interface

All adapters must implement these methods:

| Method | Signature | Description |
|--------|-----------|-------------|
| `trackEvent` | `({ project, event, properties, user_id, session_id, timestamp }) => Promise` | Insert a single event (+ upsert session if `session_id` provided) |
| `trackBatch` | `(events[]) => Promise` | Insert multiple events atomically |
| `getStats` | `({ project, since?, groupBy? }) => Promise` | Aggregated stats with time series |
| `getEvents` | `({ project, event?, session_id?, since?, limit? }) => Promise` | Raw event query |
| `query` | `({ project, metrics?, filters?, date_from?, date_to?, group_by?, order_by?, order?, limit? }) => Promise` | Flexible analytics query |
| `getProperties` | `({ project, since? }) => Promise` | Discover event names and property keys |
| `listProjects` | `() => Promise` | List all projects |
| `getSessions` | `({ project, since?, user_id?, is_bounce?, limit? }) => Promise` | List sessions with filters |
| `getSessionStats` | `({ project, since? }) => Promise` | Aggregate session metrics |
| `upsertSession` | `(sessionData) => Promise` | Upsert a session row |
| `cleanupSessions` | `({ project, before_date }) => Promise` | Delete old sessions |

The included `D1Adapter` implements this interface for Cloudflare D1. See `src/db/d1.js`.

## Schema

Initialize your database with `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  event TEXT NOT NULL,
  properties TEXT,
  user_id TEXT,
  session_id TEXT,
  timestamp INTEGER NOT NULL,
  date TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_project_date ON events(project_id, date);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);

CREATE TABLE IF NOT EXISTS sessions (
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

CREATE INDEX IF NOT EXISTS idx_sessions_project_date ON sessions(project_id, date);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(project_id, user_id);
```

## Exports

```js
// Main entry: @agent-analytics/core
import {
  createAnalyticsHandler,  // Handler factory
  D1Adapter,               // Cloudflare D1 database adapter
  validatePropertyKey,     // Validates property keys (alphanumeric + underscores, 1-128 chars)
  today,                   // () => 'YYYY-MM-DD'
  daysAgo,                 // (n) => 'YYYY-MM-DD'
  parseSince,              // (since?) => 'YYYY-MM-DD' (defaults to 7 days ago)
  parseSinceMs,            // (since?) => epoch ms (defaults to 7 days ago)
  TRACKER_JS,              // Client-side tracking script source
} from '@agent-analytics/core';

// Sub-path export: @agent-analytics/core/ulid
import { ulid } from '@agent-analytics/core/ulid';  // ULID generator (time-sortable, 26 chars)
```

## License

MIT
