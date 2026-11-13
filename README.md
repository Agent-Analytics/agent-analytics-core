# @agent-analytics/core

[![npm version](https://img.shields.io/npm/v/@agent-analytics/core?label=npm)](https://www.npmjs.com/package/@agent-analytics/core)
[![CI](https://github.com/Agent-Analytics/agent-analytics-core/actions/workflows/ci.yml/badge.svg)](https://github.com/Agent-Analytics/agent-analytics-core/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Privacy: default-minimal](https://img.shields.io/badge/privacy-default--minimal-2ea44f)
![Trust: readable tracker](https://img.shields.io/badge/trust-readable--tracker-6f42c1)
![Trust: checksum verified](https://img.shields.io/badge/trust-checksum--verified-0969da)

Analytics engine with zero dependencies. Bring your own database and auth, get a full analytics API that runs anywhere (Workers, Node, Deno, Bun).

```bash
npm install @agent-analytics/core
```

## Audited tracker surface

The browser tracker is a first-class audited artifact in this package, not a black-box snippet. You can inspect both the source that ships in npm and the hosted readable endpoint used by Agent Analytics Cloud:

- Readable source in this repository: [`src/tracker.src.js`](./src/tracker.src.js)
- Generated readable module exported by the package: [`src/tracker-source.js`](./src/tracker-source.js)
- Hosted readable endpoint: [`https://api.agentanalytics.sh/tracker.src.js`](https://api.agentanalytics.sh/tracker.src.js)
- Minified runtime endpoint: [`https://api.agentanalytics.sh/tracker.js`](https://api.agentanalytics.sh/tracker.js)

Default privacy contract:

- The tracker does not dynamically load third-party scripts, call `eval`/`new Function`, use `document.write`, collect form values, or do hard browser fingerprinting.
- Automatic `url` and `referrer` fields are sanitized to origin plus pathname; query strings are not stored except the standard UTM keys (`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`).
- Anonymous and session identifiers are scoped to the project token or project name; legacy unscoped storage keys are not migrated into the scoped identity.
- Local development on `localhost` and `127.0.0.1` logs to the console instead of sending network requests.
- Higher-sensitivity automatic capture is opt-in: generic clicks, forms, downloads, errors, web vitals, performance timing, scroll depth, outgoing links, and SPA route listeners are disabled unless configured. The default install snippet sets `data-track-vitals="true"`. `data-track-vitals="false"` leaves vitals off. Rage-click detection is part of generic click tracking (`data-track-clicks="true"`), not a separate listener.
- `aa.identify(userId, { email })` is explicit-only. Use a stable app/account id for `userId`; email is only for server-side project-scoped HMAC lookup and is stripped from event rows/profile traits by default.

Tracker behavior is covered by unit tests, including privacy guardrails in [`test/tracker-privacy-guardrails.test.mjs`](./test/tracker-privacy-guardrails.test.mjs), URL sanitization in [`test/tracker-url-sanitization.test.mjs`](./test/tracker-url-sanitization.test.mjs), rage-click detection in [`test/rage-click.test.mjs`](./test/rage-click.test.mjs), scoped storage/identity tests in [`test/storage-scoping.test.mjs`](./test/storage-scoping.test.mjs) and [`test/tracker-identity.test.mjs`](./test/tracker-identity.test.mjs), and route coverage for `/tracker.js` plus `/tracker.src.js` in [`test/handler-routes.test.mjs`](./test/handler-routes.test.mjs).

### Tracker checksum verification

The tracker build generates [`src/tracker-checksums.js`](./src/tracker-checksums.js), exporting `TRACKER_CHECKSUMS` with the sha256 digest for the minified served tracker. The `/tracker.js` route exposes the same value in the `X-Agent-Analytics-Tracker-SHA256` header so review can compare the served runtime artifact against the generated build output.

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

## Read-only SQL and property group-by

`POST /query` group_by accepts the existing fields plus one `properties.<key>`. The key uses `validatePropertyKey` (`^[A-Za-z0-9_]{1,128}$`). An invalid group-by key reports `Invalid property group-by key`. Two `properties.*` entries throw `INVALID_GROUP_BY`. Result rows use the key `properties.<key>`. Missing values group as null.

`validateReadOnlySql(sql)` returns `{ ok: true }` or `{ ok: false, error }`. It accepts one `SELECT` up to 20 KB. `events` and `sessions` may each be referenced once, so one join of the two tables is allowed and a self-join is not. After `FROM`, `JOIN`, or `IN`, the next operand must be `events`, `sessions`, a CTE name, or a parenthesized subquery or list. A table-valued function is rejected. It also rejects a leading `WITH`, a recursive CTE, `randomblob`, `zeroblob`, extra statements, bind parameters, write keywords outside string literals (`INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `ALTER`, `DROP`, `CREATE`, `ATTACH`, `DETACH`, `PRAGMA`, `VACUUM`, `REINDEX`), schema-qualified names (`main`, `temp`, quoted forms, and comments that split the dot), `sqlite_master`, `sqlite_schema`, `sqlite_temp_master`, `sqlite_temp_schema`, and any other table. A user `LIMIT` must be a plain non-negative integer. When the statement has no `LIMIT`, the wrapper inserts a newline and then `LIMIT 1001`, so a trailing `--` comment cannot swallow the cap.

`resolveSqlWindow(window, now?)` returns `{ date_from, date_to }`. Omit `window` for 7 inclusive UTC days ending today. `window` is `{ days }` (integer 1 through 90) or `{ date_from, date_to }` (`YYYY-MM-DD`, inclusive span at most 90 days). An invalid window throws `INVALID_WINDOW`.

`wrapProjectSql(sql, projectName, window)` returns `{ sql, params, returnLimit, probeTruncation, window }`. `params` is `[projectName, date_from, date_to, projectName, date_from, date_to]`. The date predicate uses `idx_events_project_date` and `idx_sessions_project_date`. `timestamp` and `start_time` are not the window columns because they do not have a project-scoped range index. The wrapper CTEs are:

- `events(id, event, properties, user_id, session_id, timestamp, date, country)`
- `sessions(session_id, user_id, project_id, start_time, end_time, duration, entry_page, exit_page, event_count, is_bounce, date)`

`resolved_user_id` is not exposed. The CTE bodies read `main.events` and `main.sessions` because SQLite reports a circular reference when a CTE selects from its own name. Callers that need truncation fetch `SQL_FETCH_CAP` (1001) and return at most `SQL_ROW_CAP` (1000). `probeTruncation` is true when the wrapper fetched one extra row to detect that cap. A user `LIMIT` of 1000 or below is left unchanged.

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
<script defer src="https://your-server.com/tracker.js" data-project="my-site" data-token="YOUR_TOKEN" data-track-vitals="true"></script>
```

Tracks the initial page view by default, with sanitized URL/referrer, screen size, browser, OS, device type, and allowlisted UTM params. The snippet sets `data-track-vitals="true"` so new installs send Core Web Vitals on `$web_vitals`. Set that attribute to `"false"` to leave vitals off. SPA route-change tracking is explicit opt-in: add `data-track-spa="true"` to listen for URL changes via patched `pushState`/`replaceState`, `popstate`, and `hashchange`. Events are batched and flushed every 5s, or immediately on page hide via `sendBeacon`.

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

### Automatic clicks and rage clicks

Generic click tracking is opt-in. Add `data-track-clicks="true"` to the tracker script:

```html
<script defer src="https://your-server.com/tracker.js" data-project="my-site" data-token="YOUR_TOKEN" data-track-clicks="true" data-track-vitals="true"></script>
```

A click on a link or button, including a click on something inside that control, emits `$click`. The tracked element is the nearest `a` or `button` (`Element.closest('a, button')`), the same node rage detection uses. Properties are `tag`, `id`, and `classes`, plus `href` and `is_external` for links or `type` for buttons. Visible label text and form values are not collected. Elements that already use `data-aa-event` are left to declarative tracking and do not also emit `$click`.

That same click path emits `rage_click` when **3 clicks hit that same element inside a rolling 1000ms window**. `rage_click` repeats the `$click` element properties and adds `click_count` (how many clicks in the window triggered the detection). Each qualifying click still emits `$click`; rage detection is additive.

Identity is that DOM node, not a CSS selector. Clicks on an inner icon count toward the surrounding link or button. Two controls that share a tag, id, or classes stay separate, including when their clicks are interleaved. One `rage_click` is sent per burst: further clicks on that node do not emit again while any click in the burst is still inside the 1000ms window. After the window no longer contains a click for that node, later clicks can start a new burst and emit again.

### Script attributes

| Attribute | Description |
|-----------|-------------|
| `data-project` | Project name (required) |
| `data-token` | Project token `aat_*` (required) |
| `data-link-domains` | Enable cross-subdomain identity linking |
| `data-do-not-track` | Set to `"true"` to honor the browser's DNT signal |
| `data-track-spa` | Set to `"true"` to track SPA route changes |
| `data-track-clicks` | Set to `"true"` to emit `$click` on links and buttons, and `rage_click` when one of those elements is clicked 3 times within 1000ms |
| `data-track-vitals` | Set to `"true"` to send `$web_vitals` with `cwv_lcp`, `cwv_inp`, `cwv_cls`, `cwv_fcp`, `cwv_ttfb`, and CSS selector targets (`cwv_lcp_target`, `cwv_inp_target`, `cwv_cls_target`). The default snippet sets `"true"`. `"false"` leaves vitals off. |

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
- `GET /stats?project=X` — aggregated overview with time series, top events, sessions, and countries. Optional: `since`, `groupBy` (hour/day/week/month)
- `GET /events?project=X` — raw event log. Optional: `event`, `session_id`, `since`, `limit`
- `GET /projects` — all projects derived from events data

**Utility:** `GET /health`, `GET /tracker.js`, `GET /tracker.src.js`

Stats includes `countries: [{ country, count, unique_users }]`, sorted by raw event count for the requested project and period. Country is a two-letter code or `null` for missing/unknown geography (including `XX` and `T1`). Country event counts sum to `totals.total_events`; users who appear in multiple countries count in each, so country user counts are not additive.

- `GET /tracker.js` — minified browser tracker with a source/privacy header.
- `GET /tracker.src.js` — readable, unminified tracker source served as `application/javascript` for auditability.

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
