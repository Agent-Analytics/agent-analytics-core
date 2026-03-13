/**
 * Bot detection for analytics filtering.
 *
 * Returns true for known bots, crawlers, and headless browsers.
 * Conservative: only matches clearly-identified bots, plus Node.js HTTP
 * clients (real browsers never send these User-Agents).
 */

const BOT_RULES = Object.freeze([
  {
    category: 'ai_agent',
    matchers: [
      { regex: /chatgpt-user/i, actor: 'ChatGPT-User' },
      { regex: /gptbot/i, actor: 'GPTBot' },
      { regex: /anthropic-ai/i, actor: 'Anthropic-AI' },
      { regex: /claudebot/i, actor: 'ClaudeBot' },
      { regex: /amazonbot/i, actor: 'Amazonbot' },
      { regex: /bytespider/i, actor: 'Bytespider' },
      { regex: /cohere-ai/i, actor: 'Cohere-AI' },
      { regex: /perplexitybot/i, actor: 'PerplexityBot' },
    ],
  },
  {
    category: 'search_crawler',
    matchers: [
      { regex: /googlebot/i, actor: 'Googlebot' },
      { regex: /bingbot/i, actor: 'Bingbot' },
      { regex: /slurp/i, actor: 'Slurp' },
      { regex: /duckduckbot/i, actor: 'DuckDuckBot' },
      { regex: /baiduspider/i, actor: 'Baiduspider' },
      { regex: /yandexbot/i, actor: 'YandexBot' },
      { regex: /sogou/i, actor: 'Sogou' },
      { regex: /exabot/i, actor: 'Exabot' },
      { regex: /ia_archiver/i, actor: 'ia_archiver' },
    ],
  },
  {
    category: 'social_preview',
    matchers: [
      { regex: /facebookexternalhit/i, actor: 'facebookexternalhit' },
      { regex: /facebot/i, actor: 'Facebot' },
      { regex: /twitterbot/i, actor: 'Twitterbot' },
      { regex: /linkedinbot/i, actor: 'LinkedInBot' },
      { regex: /whatsapp/i, actor: 'WhatsApp' },
      { regex: /telegrambot/i, actor: 'TelegramBot' },
      { regex: /discordbot/i, actor: 'Discordbot' },
      { regex: /slackbot/i, actor: 'Slackbot' },
    ],
  },
  {
    category: 'seo_research',
    matchers: [
      { regex: /ahrefsbot/i, actor: 'AhrefsBot' },
      { regex: /semrushbot/i, actor: 'SemrushBot' },
      { regex: /mj12bot/i, actor: 'MJ12bot' },
      { regex: /dotbot/i, actor: 'DotBot' },
      { regex: /screaming frog/i, actor: 'Screaming Frog' },
      { regex: /rogerbot/i, actor: 'Rogerbot' },
      { regex: /megaindex/i, actor: 'MegaIndex' },
    ],
  },
  {
    category: 'headless_browser',
    matchers: [
      { regex: /headlesschrome/i, actor: 'HeadlessChrome' },
      { regex: /phantomjs/i, actor: 'PhantomJS' },
      { regex: /puppeteer/i, actor: 'Puppeteer' },
      { regex: /playwright/i, actor: 'Playwright' },
      { regex: /selenium/i, actor: 'Selenium' },
    ],
  },
  {
    category: 'monitoring_perf',
    matchers: [
      { regex: /lighthouse/i, actor: 'Lighthouse' },
      { regex: /pagespeed/i, actor: 'PageSpeed' },
      { regex: /uptimerobot/i, actor: 'UptimeRobot' },
      { regex: /pingdom/i, actor: 'Pingdom' },
      { regex: /datadog/i, actor: 'Datadog' },
      { regex: /site24x7/i, actor: 'Site24x7' },
      { regex: /statuscake/i, actor: 'StatusCake' },
    ],
  },
  {
    category: 'automation_script',
    matchers: [
      { regex: /curl\//i, actor: 'curl' },
      { regex: /wget\//i, actor: 'wget' },
      { regex: /libwww-perl/i, actor: 'libwww-perl' },
      { regex: /python-requests/i, actor: 'python-requests' },
      { regex: /scrapy/i, actor: 'Scrapy' },
      { regex: /go-http-client/i, actor: 'Go-http-client' },
      { regex: /httpie\//i, actor: 'HTTPie' },
      { regex: /node-fetch/i, actor: 'node-fetch' },
      { regex: /undici/i, actor: 'undici' },
      { regex: /axios\//i, actor: 'axios' },
      { regex: /got\//i, actor: 'got' },
      { regex: /node\//i, actor: 'node' },
      { regex: /deno\//i, actor: 'deno' },
      { regex: /bun\//i, actor: 'bun' },
    ],
  },
]);

const GENERIC_PATTERNS = Object.freeze([
  /([A-Za-z][A-Za-z0-9._-]*Crawler)/i,
  /([A-Za-z][A-Za-z0-9._-]*Spider)/i,
  /([A-Za-z][A-Za-z0-9._-]*Scraper)/i,
  /\bbot[/\s;,)-]/i,
  /crawl[er/]/i,
  /spider[/\s;,)-]/i,
  /scrape[r/]/i,
]);

/**
 * Returns normalized bot metadata for a User-Agent.
 *
 * @param {string|null|undefined} userAgent
 * @returns {{ isBot: boolean, category: string|null, actor: string|null }}
 */
export function classifyBot(userAgent) {
  if (!userAgent) {
    return { isBot: true, category: 'generic_bot', actor: 'Unknown' };
  }

  for (const rule of BOT_RULES) {
    for (const matcher of rule.matchers) {
      if (matcher.regex.test(userAgent)) {
        return { isBot: true, category: rule.category, actor: matcher.actor };
      }
    }
  }

  for (const pattern of GENERIC_PATTERNS) {
    const match = userAgent.match(pattern);
    if (!match) continue;
    const actor = match[1] || 'Unknown';
    return { isBot: true, category: 'generic_bot', actor };
  }

  return { isBot: false, category: null, actor: null };
}

/**
 * Returns true if the User-Agent indicates a bot, crawler, or headless browser.
 *
 * @param {string|null|undefined} userAgent
 * @returns {boolean}
 */
export function isBot(userAgent) {
  return classifyBot(userAgent).isBot;
}
