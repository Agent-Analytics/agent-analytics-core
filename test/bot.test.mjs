import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBot } from '../src/bot.js';

// --- Known bots should be detected ---

test('detects search engine bots', () => {
  const bots = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)',
    'DuckDuckBot/1.0; (+http://duckduckgo.com/duckduckbot.html)',
    'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
    'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
  ];
  for (const ua of bots) {
    assert.ok(isBot(ua), `should detect: ${ua}`);
  }
});

test('detects social preview bots', () => {
  const bots = [
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0)',
    'WhatsApp/2.21.12.21',
    'TelegramBot (like TwitterBot)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  ];
  for (const ua of bots) {
    assert.ok(isBot(ua), `should detect: ${ua}`);
  }
});

test('detects SEO tool bots', () => {
  const bots = [
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
    'Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)',
    'Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot)',
    'Screaming Frog SEO Spider/17.0',
  ];
  for (const ua of bots) {
    assert.ok(isBot(ua), `should detect: ${ua}`);
  }
});

test('detects AI crawlers', () => {
  const bots = [
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)',
    'ChatGPT-User/1.0',
    'Anthropic-AI',
    'ClaudeBot/1.0',
    'Amazonbot/0.1',
    'Mozilla/5.0 (compatible; Bytespider)',
  ];
  for (const ua of bots) {
    assert.ok(isBot(ua), `should detect: ${ua}`);
  }
});

test('detects headless browsers', () => {
  const bots = [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Unknown; Linux x86_64) AppleWebKit/538.1 (KHTML, like Gecko) PhantomJS/2.1.1 Safari/538.1',
    'Puppeteer',
    'Playwright/1.40',
    'Selenium',
  ];
  for (const ua of bots) {
    assert.ok(isBot(ua), `should detect: ${ua}`);
  }
});

test('detects monitoring tools', () => {
  const bots = [
    'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Trident/5.0); UptimeRobot/2.0',
    'Pingdom.com_bot_version_1.4_(http://www.pingdom.com/)',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html) Lighthouse',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 PageSpeed',
    'Datadog/Synthetics',
  ];
  for (const ua of bots) {
    assert.ok(isBot(ua), `should detect: ${ua}`);
  }
});

test('detects scripting tools', () => {
  const bots = [
    'curl/7.88.1',
    'wget/1.21.3',
    'libwww-perl/6.67',
    'python-requests/2.31.0',
    'Scrapy/2.11.0',
    'Go-http-client/2.0',
    'HTTPie/3.2.2',
  ];
  for (const ua of bots) {
    assert.ok(isBot(ua), `should detect: ${ua}`);
  }
});

test('detects generic bot patterns', () => {
  const bots = [
    'Mozilla/5.0 (compatible; CustomCrawler/1.0)',
    'CustomSpider/1.0 (http://example.com)',
    'WebScraper/2.0',
  ];
  for (const ua of bots) {
    assert.ok(isBot(ua), `should detect: ${ua}`);
  }
});

// --- Real browsers should NOT be detected ---

test('allows real desktop browsers', () => {
  const browsers = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  ];
  for (const ua of browsers) {
    assert.ok(!isBot(ua), `should allow: ${ua}`);
  }
});

test('allows real mobile browsers', () => {
  const browsers = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  ];
  for (const ua of browsers) {
    assert.ok(!isBot(ua), `should allow: ${ua}`);
  }
});

// --- Edge cases ---

test('null/undefined/empty UA treated as bot', () => {
  assert.ok(isBot(null), 'null should be bot');
  assert.ok(isBot(undefined), 'undefined should be bot');
  assert.ok(isBot(''), 'empty string should be bot');
});

test('Cubot phone is NOT a bot', () => {
  const cubot = 'Mozilla/5.0 (Linux; Android 12; Cubot Note 30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36';
  assert.ok(!isBot(cubot), 'Cubot phone should not be detected as bot');
});

test('Node.js default UA is NOT a bot', () => {
  // Node.js fetch sends "node" or "undici" as UA — must not block CLI usage
  const nodeUAs = [
    'node',
    'undici',
    'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)',
    'axios/1.6.2',
  ];
  for (const ua of nodeUAs) {
    assert.ok(!isBot(ua), `should allow CLI UA: ${ua}`);
  }
});
