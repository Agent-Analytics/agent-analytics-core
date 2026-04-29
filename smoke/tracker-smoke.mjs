/* global window, document, history, scrollTo, process, Buffer */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const trackerModulePath = process.env.TRACKER_JS
  ? process.env.TRACKER_JS
  : join(repoRoot, 'src', 'tracker.js');
const SMOKE_HOST = process.env.AA_SMOKE_HOST || 'aa-smoke.test';
const TOKEN = 'tracker-smoke-token';
const PROJECT = 'tracker-smoke';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function html({
  title = 'Tracker Smoke Fixture',
  path = '/',
  spa = true,
  duplicate = false,
  meta404 = false,
  brokenTrack = false,
} = {}) {
  const scriptAttrs = [
    `src="${brokenTrack ? '/broken-tracker.js' : '/tracker.js'}"`,
    `data-token="${TOKEN}"`,
    `data-project="${PROJECT}"`,
    'data-track-clicks="true"',
    'data-track-outgoing="true"',
    'data-track-downloads="true"',
    'data-track-forms="true"',
    'data-track-errors="true"',
    'data-track-performance="true"',
    'data-track-scroll-depth="true"',
    'data-track-404="true"',
    spa ? 'data-track-spa="true"' : '',
  ].filter(Boolean).join(' ');
  const duplicateTag = duplicate ? `\n<script ${scriptAttrs}></script>` : '';
  return `<!doctype html>
<html class="aa-loading">
<head>
  <meta charset="utf-8">
  ${meta404 ? '<meta name="aa-status" content="404">' : ''}
  <title>${title}</title>
</head>
<body>
  <h1>${title}</h1>
  <button id="manual" type="button">Manual identify + track</button>
  <button id="decl" data-aa-event="cta_clicked" data-aa-event-plan="Pro" type="button">Declarative CTA</button>
  <button id="auto" class="primary cta" type="button">Auto CTA</button>
  <a id="outgoing" href="https://example.com/path?email=Leaky@Example.com&utm_source=keep&token=secret#frag">Outgoing</a>
  <a id="download" href="/files/report.pdf?email=Leaky@Example.com&download_token=secret#frag">Download</a>
  <form id="valid-form" name="validFixture" action="/submit?email=Leaky@Example.com&token=secret" method="post"><input name="ok" value="1"><button type="submit">Valid</button></form>
  <form id="invalid-form" name="invalidFixture" action="/invalid?email=Leaky@Example.com" method="post"><input name="required" required><button type="submit">Invalid</button></form>
  <form id="novalidate-form" name="novalidateFixture" action="/novalidate?email=Leaky@Example.com" method="post" novalidate><input name="required" required><button type="submit">Novalidate</button></form>
  <div style="height: 1400px; padding-top: 40px"><div id="impression" data-aa-impression="hero" data-aa-impression-slot="above-fold">Impression</div></div>
  <script ${scriptAttrs}></script>${duplicateTag}
  <script>
    window.__smokeErrors = [];
    window.addEventListener('error', function(e) { window.__smokeErrors.push(e.message || 'error'); });
    window.addEventListener('unhandledrejection', function(e) { window.__smokeErrors.push(String(e.reason && e.reason.message || e.reason || 'rejection')); });
    document.addEventListener('submit', function(e) { e.preventDefault(); });
    document.addEventListener('click', function(e) { if (e.target.closest && e.target.closest('a')) e.preventDefault(); }, true);
    document.getElementById('manual').addEventListener('click', function() {
      window.aa.identify('User-123', { email: '  TEST@Example.COM  ', email_hash: 'must-not-send', plan: 'Pro' });
      window.aa.track('post_identify_manual', { source: 'smoke' });
    });
    window.smoke = {
      pushSpa: function() { history.pushState({}, '', '${path.replace(/'/g, "\\'")}/spa?utm_campaign=spa-campaign&email=hidden@example.com'); },
      oversized: function() { window.aa.track('oversized_payload', { huge: 'x'.repeat(70 * 1024) }); },
      emitError: function() { setTimeout(function() { throw new Error('smoke boom'); }, 0); }
    };
  </script>
</body>
</html>`;
}

async function startCaptureServer() {
  const { TRACKER_JS: trackerJs } = await import(pathToFileURL(trackerModulePath).href + `?smoke=${Date.now()}`);
  const captures = [];
  let failTrack = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/tracker.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(trackerJs);
      return;
    }
    if (url.pathname === '/broken-tracker.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(trackerJs.replace(/new URL\((?:script|s)\.src\)\.origin\s*\+\s*['"]\/track['"]/, "new URL(s.src).origin + '/fail-track'"));
      return;
    }
    if (url.pathname === '/experiments/config') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ experiments: [{ key: 'headline', variants: [{ key: 'A', weight: 100 }, { key: 'B', weight: 0 }] }] }));
      return;
    }
    if (url.pathname === '/track' || url.pathname === '/track/batch' || url.pathname === '/identify' || url.pathname === '/fail-track') {
      const body = await readBody(req);
      if (url.pathname === '/fail-track' || failTrack) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      try {
        const parsed = JSON.parse(body || '{}');
        const items = Array.isArray(parsed.events) ? parsed.events : [parsed];
        for (const item of items) captures.push({ path: url.pathname, body: item });
      } catch (error) {
        captures.push({ path: url.pathname, parseError: error.message, raw: body });
      }
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname.startsWith('/files/') || url.pathname === '/submit' || url.pathname === '/invalid' || url.pathname === '/novalidate') {
      res.writeHead(204);
      res.end();
      return;
    }
    const page404 = url.pathname === '/not-found';
    res.writeHead(page404 ? 404 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    const noSpa = url.pathname.includes('no-spa');
    res.end(html({ title: page404 ? 'Missing Smoke Page' : 'Tracker Smoke Fixture', path: url.pathname, spa: !noSpa, duplicate: url.pathname.includes('duplicate'), meta404: page404, brokenTrack: url.pathname.includes('network-fail') }));
  });
  const port = await onceServer(server);
  return {
    port,
    captures,
    setFailTrack(value) { failTrack = value; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function flatten(captures) {
  return captures.map((c) => c.body).filter(Boolean);
}

function events(captures, name) {
  return flatten(captures).filter((e) => e.event === name);
}

async function eventually(assertion, { timeout = 7000, interval = 100 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { return assertion(); } catch (error) { last = error; await wait(interval); }
  }
  assertion();
  throw last;
}

async function clickNoNav(page, selector) {
  await page.locator(selector).click({ noWaitAfter: true });
}

async function run() {
  const capture = await startCaptureServer();
  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP ${SMOKE_HOST} 127.0.0.1`],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const uncaught = [];
  page.on('pageerror', (error) => uncaught.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') uncaught.push(msg.text());
  });

  const origin = `http://${SMOKE_HOST}:${capture.port}`;
  try {
    await page.goto(`${origin}/fixture?utm_source=google&utm_medium=cpc&utm_campaign=Smoke&email=leak@example.com&token=secret`, {
      waitUntil: 'domcontentloaded',
      referer: `${origin}/referrer?email=ref@example.com&token=refsecret&utm_source=refutm`,
    });
    await eventually(() => assert.equal(events(capture.captures, 'page_view').length, 1));
    const pageView = events(capture.captures, 'page_view')[0];
    assert.equal(pageView.project, PROJECT);
    assert.equal(pageView.token, TOKEN);
    assert.equal(pageView.properties.utm_source, 'google');
    assert.equal(pageView.properties.utm_medium, 'cpc');
    assert.equal(pageView.properties.utm_campaign, 'Smoke');
    assert.ok(!pageView.properties.url.includes('email='), pageView.properties.url);
    assert.ok(!pageView.properties.url.includes('token='), pageView.properties.url);
    assert.equal(pageView.properties.url, `${origin}/fixture`);
    assert.ok(!pageView.properties.referrer.includes('email='), pageView.properties.referrer);
    assert.ok(!pageView.properties.referrer.includes('token='), pageView.properties.referrer);

    await clickNoNav(page, '#manual');
    await eventually(() => assert.ok(capture.captures.some((c) => c.path === '/identify')));
    const identify = capture.captures.find((c) => c.path === '/identify').body;
    assert.equal(identify.user_id, 'User-123');
    assert.equal(identify.traits.email, 'test@example.com');
    assert.equal(identify.traits.plan, 'Pro');
    assert.ok(!('email_hash' in identify.traits));
    await eventually(() => assert.ok(events(capture.captures, 'post_identify_manual').some((e) => e.user_id === 'User-123')));

    const beforeDeclClicks = events(capture.captures, '$click').length;
    await clickNoNav(page, '#decl');
    await eventually(() => assert.equal(events(capture.captures, 'cta_clicked').length, 1));
    await wait(300);
    assert.equal(events(capture.captures, '$click').length, beforeDeclClicks, 'declarative click must not also auto-click');
    assert.equal(events(capture.captures, 'cta_clicked')[0].properties.plan, 'Pro');

    await clickNoNav(page, '#auto');
    await eventually(() => assert.ok(events(capture.captures, '$click').some((e) => e.properties.id === 'auto')));
    const autoClick = events(capture.captures, '$click').find((e) => e.properties.id === 'auto');
    assert.equal(autoClick.properties.tag, 'button');
    assert.equal(autoClick.properties.type, 'button');
    assert.match(autoClick.properties.classes, /primary/);

    await clickNoNav(page, '#outgoing');
    await eventually(() => assert.equal(events(capture.captures, 'outgoing_link').length, 1));
    const outgoing = events(capture.captures, 'outgoing_link')[0];
    assert.equal(outgoing.properties.hostname, 'example.com');
    assert.ok(!outgoing.properties.href.includes('email='), outgoing.properties.href);
    assert.ok(!outgoing.properties.href.includes('token='), outgoing.properties.href);
    assert.equal(outgoing.properties.href, 'https://example.com/path');

    await clickNoNav(page, '#download');
    await eventually(() => assert.equal(events(capture.captures, '$download').length, 1));
    const download = events(capture.captures, '$download')[0];
    assert.equal(download.properties.filename, 'report.pdf');
    assert.equal(download.properties.extension, 'pdf');
    assert.ok(!download.properties.href.includes('email='), download.properties.href);
    assert.ok(!download.properties.href.includes('download_token='), download.properties.href);

    await page.locator('#valid-form button').click();
    await page.locator('#invalid-form button').click();
    await page.locator('#novalidate-form button').click();
    await eventually(() => assert.equal(events(capture.captures, '$form_submit').length, 2));
    const formIds = events(capture.captures, '$form_submit').map((e) => e.properties.id).sort();
    assert.deepEqual(formIds, ['novalidate-form', 'valid-form']);
    for (const form of events(capture.captures, '$form_submit')) {
      assert.ok(!form.properties.action.includes('email='), form.properties.action);
    }

    await page.evaluate(() => window.smoke.pushSpa());
    await eventually(() => assert.ok(events(capture.captures, 'page_view').some((e) => e.properties.path === '/fixture/spa')));
    const spaPv = events(capture.captures, 'page_view').find((e) => e.properties.path === '/fixture/spa');
    assert.equal(spaPv.properties.utm_campaign, 'spa-campaign');
    assert.equal(spaPv.properties.url, `${origin}/fixture/spa`);

    await page.evaluate(() => window.smoke.oversized());
    await page.evaluate(() => window.aa.identify('User-123', {}));
    await eventually(() => assert.equal(events(capture.captures, 'oversized_payload').length, 1));
    const oversized = events(capture.captures, 'oversized_payload')[0];
    assert.ok(oversized.properties.huge.length <= 4096, 'oversized strings should be truncated');
    assert.ok(JSON.stringify(oversized).length <= 70_000, 'oversized payload should remain bounded');

    await page.evaluate(() => window.smoke.emitError());
    await eventually(() => assert.ok(events(capture.captures, '$error').some((e) => /smoke boom/.test(e.properties.message))));

    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await page.goto(`${origin}/next`, { waitUntil: 'domcontentloaded' });
    await eventually(() => assert.ok(events(capture.captures, '$scroll_depth').length >= 1));
    await eventually(() => assert.ok(events(capture.captures, '$performance').length >= 1));
    await eventually(() => assert.ok(events(capture.captures, '$impression').length >= 1));

    const beforeNoSpa = events(capture.captures, 'page_view').length;
    await page.goto(`${origin}/no-spa`, { waitUntil: 'domcontentloaded' });
    await eventually(() => assert.equal(events(capture.captures, 'page_view').length, beforeNoSpa + 1));
    await page.evaluate(() => history.pushState({}, '', '/no-spa/pushed'));
    await wait(500);
    assert.equal(events(capture.captures, 'page_view').length, beforeNoSpa + 1, 'SPA opt-out must not auto page');

    const beforeDupEvents = capture.captures.length;
    await page.goto(`${origin}/duplicate`, { waitUntil: 'domcontentloaded' });
    await eventually(() => assert.equal(events(capture.captures, 'page_view').filter((e) => e.properties.path === '/duplicate').length, 1));
    await clickNoNav(page, '#auto');
    await eventually(() => assert.equal(events(capture.captures, '$click').filter((e) => e.properties.path === '/duplicate' && e.properties.id === 'auto').length, 1));
    assert.ok(capture.captures.length > beforeDupEvents);

    await page.goto(`${origin}/not-found`, { waitUntil: 'domcontentloaded' });
    await eventually(() => assert.ok(events(capture.captures, '$404').some((e) => e.properties.path === '/not-found')));

    capture.setFailTrack(true);
    const beforeNetworkFail = capture.captures.length;
    await page.goto(`${origin}/network-fail`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => window.aa.track('network_fail_manual', { ok: true }));
    await wait(500);
    assert.equal(capture.captures.length, beforeNetworkFail, 'failing endpoint must not capture successful sends');
    assert.deepEqual(await page.evaluate(() => window.__smokeErrors), []);
    assert.deepEqual(uncaught.filter((message) => !/smoke boom|Failed to load resource/.test(message)), []);
  } finally {
    await browser.close();
    await capture.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
