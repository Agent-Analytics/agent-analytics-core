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
<script defer src="https://your-server.com/tracker.js" data-project="my-site" data-token="YOUR_TOKEN"></script>
```

Auto-tracks page views (including SPA navigations via patched `pushState`/`replaceState`), with URL, referrer, screen size, browser, OS, device type, and UTM params. Events are batched and flushed every 5s, or immediately on page hide via `sendBeacon`.

On `localhost` and `127.0.0.1`, the tracker skips all network requests and logs events to the browser console instead (prefixed `[aa-dev]`), so development traffic never pollutes production data.

```js
window.aa.track('signup', { plan: 'pro' });
window.aa.identify('user_123');
window.aa.page('Dashboard');
```

### Declarative event tracking

Track clicks without writing JavaScript — add `data-aa-event` to any HTML element:

```html
<button data-aa-event="cta_click" data-aa-event-id="hero_signup">Get Started</button>
```

When clicked, this fires a `cta_click` event with `{ id: "hero_signup" }`. Add properties with `data-aa-event-*` attributes. Use this for simple click tracking; use `window.aa.track()` for events triggered by non-click interactions or when properties need to be computed dynamically.

### Script attributes

| Attribute | Description |
|-----------|-------------|
| `data-project` | Project name (required) |
| `data-token` | Project token `aat_*` (required) |
| `data-link-domains` | Enable cross-subdomain identity linking |
| `data-do-not-track` | Set to `"true"` to honor the browser's DNT signal |

Set `localStorage.setItem('aa_disabled', 'true')` to disable tracking entirely (useful for internal teams or opt-out flows).

## Reading

All read endpoints require an API key via `X-API-Key` header or `?key=` param.

```bash
# Stats overview (time series, top events, session metrics)
curl "https://your-server.com/stats?project=my-site" -H "X-API-Key: KEY"

# Raw events
curl "https://your-server.com/events?project=my-site&event=page_view&limit=50" -H "X-API-Key: KEY"

# Projects discovered from tracked data
curl "https://your-server.com/projects" -H "X-API-Key: KEY"
```

## Endpoints

**Write** (project token in body):
- `POST /track` — single event (`{ project, token, event, properties?, user_id?, session_id?, timestamp? }`)
- `POST /track/batch` — up to 100 events (`{ events: [...] }`)
- `POST /identify` — merge an anonymous visitor id into a known user id

**Read** (API key required):
- `GET /stats?project=X` — aggregated overview with time series, top events, sessions. Optional: `since`, `groupBy` (hour/day/week/month)
- `GET /events?project=X` — raw event log. Optional: `event`, `session_id`, `since`, `limit`
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
  listProjects()
  getSessionStats({ project, since? })
  upsertSession(sessionData)
  cleanupSessions({ project, before_date })
}
```

Optional richer analytics methods like `query()` and `getProperties()` can still exist on adapters for non-OSS consumers, but the OSS public handler only exposes the endpoints listed above. All methods return promises. See `src/db/d1.js` for the reference implementation — `trackEvent` and `trackBatch` handle session upserts atomically via `db.batch()`.

## License

MIT
