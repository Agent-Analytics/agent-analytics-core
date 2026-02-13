# @agent-analytics/core

Analytics engine with zero dependencies. Bring your own database and auth, get a full analytics API that runs anywhere (Workers, Node, Deno, Bun).

```bash
npm install @agent-analytics/core
```

## How it works

You give `createAnalyticsHandler` a database adapter and two auth functions. It gives you back a request handler.

```js
import { createAnalyticsHandler, D1Adapter } from '@agent-analytics/core';

const handle = createAnalyticsHandler({
  db: new D1Adapter(env.DB),
  validateWrite: (request, body) => {
    // check body.token for ingestion endpoints
    return { valid: true };
  },
  validateRead: (request, url) => {
    // check X-API-Key header for query endpoints
    return { valid: true };
  },
});

const { response, writeOps } = await handle(request);
// writeOps are DB write promises — pass them to ctx.waitUntil() on Workers
```

The handler returns a standard `Response`. Write operations are deferred so you can `waitUntil` them on Workers or just `await` them on Node. Set `useQueue: true` to get `queueMessages` instead of `writeOps` if you want to push writes to a queue.

Initialize your database with the included `schema.sql`.

## Cloudflare Workers

```js
import { createAnalyticsHandler, D1Adapter } from '@agent-analytics/core';

export default {
  async fetch(request, env, ctx) {
    const handle = createAnalyticsHandler({
      db: new D1Adapter(env.DB),
      validateWrite: (_request, body) => {
        const token = body?.token;
        if (!env.PROJECT_TOKENS) return { valid: true };
        if (!token || !env.PROJECT_TOKENS.split(',').includes(token))
          return { valid: false, error: 'invalid token' };
        return { valid: true };
      },
      validateRead: (request, url) => {
        const key = request.headers.get('X-API-Key') || url.searchParams.get('key');
        if (!env.API_KEYS || !key || !env.API_KEYS.split(',').includes(key))
          return { valid: false };
        return { valid: true };
      },
    });

    const { response, writeOps } = await handle(request);
    if (writeOps) writeOps.forEach(op => ctx.waitUntil(op));
    return response;
  },
};
```

## Client-side tracking

```html
<script src="https://your-server.com/tracker.js" data-project="my-site" data-token="YOUR_TOKEN"></script>
```

Auto-tracks page views (including SPA navigations via patched `pushState`/`replaceState`), with URL, referrer, screen size, browser, OS, device type, and UTM params. Events are batched and flushed every 5s, or immediately on page hide via `sendBeacon`.

```js
window.aa.track('signup', { plan: 'pro' });
window.aa.identify('user_123');
window.aa.page('Dashboard');
```

## Querying

All read endpoints require an API key via `X-API-Key` header or `?key=` param.

```bash
# Stats overview (time series, top events, session metrics)
curl "https://your-server.com/stats?project=my-site" -H "X-API-Key: KEY"

# Raw events
curl "https://your-server.com/events?project=my-site&event=page_view&limit=50" -H "X-API-Key: KEY"

# Flexible query — filter by properties, group, sort
curl -X POST "https://your-server.com/query" \
  -H "X-API-Key: KEY" -H "Content-Type: application/json" \
  -d '{"project":"my-site","metrics":["event_count","unique_users"],"group_by":["event"],"filters":[{"field":"properties.browser","op":"eq","value":"Chrome"}]}'
```

## Endpoints

**Write** (project token in body):
- `POST /track` — single event (`{ project, token, event, properties?, user_id?, session_id?, timestamp? }`)
- `POST /track/batch` — up to 100 events (`{ events: [...] }`)

**Read** (API key required):
- `GET /stats?project=X` — aggregated overview with time series, top events, sessions. Optional: `since`, `groupBy` (hour/day/week/month)
- `GET /events?project=X` — raw event log. Optional: `event`, `session_id`, `since`, `limit`
- `GET /sessions?project=X` — session list. Optional: `user_id`, `is_bounce`, `since`, `limit`
- `POST /query` — the big one. Metrics (`event_count`, `unique_users`, `session_count`, `bounce_rate`, `avg_duration`), `group_by`, `filters` on fields or `properties.*`, `order_by`, date range. Property filters use `json_extract` under the hood — keys are validated to prevent injection.
- `GET /properties?project=X` — event names + property keys seen in recent data
- `GET /properties/received?project=X` — which property keys appear on which event types (sampled)
- `GET /projects` — all projects derived from events data

**Utility:** `GET /health`, `GET /tracker.js`

## Writing a database adapter

The included `D1Adapter` works with Cloudflare D1. For other databases, implement this interface:

```js
class MyAdapter {
  trackEvent({ project, event, properties, user_id, session_id, timestamp })
  trackBatch(events)
  getStats({ project, since?, groupBy? })
  getEvents({ project, event?, session_id?, since?, limit? })
  query({ project, metrics?, filters?, date_from?, date_to?, group_by?, order_by?, order?, limit? })
  getProperties({ project, since? })
  getPropertiesReceived({ project, since?, sample? })
  listProjects()
  getSessions({ project, since?, user_id?, is_bounce?, limit? })
  getSessionStats({ project, since? })
  upsertSession(sessionData)
  cleanupSessions({ project, before_date })
}
```

All methods return promises. See `src/db/d1.js` for the reference implementation — `trackEvent` and `trackBatch` handle session upserts atomically via `db.batch()`.

## License

MIT
