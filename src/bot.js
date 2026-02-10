/**
 * Bot detection for analytics filtering.
 *
 * Returns true for known bots, crawlers, and headless browsers.
 * Conservative: only matches clearly-identified bots, NOT generic HTTP
 * libraries (node-fetch, undici, axios) since the CLI uses those.
 */

const BOT_PATTERN = new RegExp(
  [
    // Empty/null UA — real browsers always send one
    '^$',

    // Search engines
    'googlebot', 'bingbot', 'slurp', 'duckduckbot', 'baiduspider',
    'yandexbot', 'sogou', 'exabot', 'ia_archiver',

    // Social previews
    'facebookexternalhit', 'facebot', 'twitterbot', 'linkedinbot',
    'whatsapp', 'telegrambot', 'discordbot', 'slackbot',

    // SEO tools
    'ahrefsbot', 'semrushbot', 'mj12bot', 'dotbot',
    'screaming frog', 'rogerbot', 'megaindex',

    // AI crawlers
    'gptbot', 'chatgpt-user', 'anthropic-ai', 'claudebot', 'amazonbot',
    'bytespider', 'cohere-ai', 'perplexitybot',

    // Headless browsers
    'headlesschrome', 'phantomjs', 'puppeteer', 'playwright', 'selenium',

    // Performance / monitoring
    'lighthouse', 'pagespeed', 'uptimerobot', 'pingdom',
    'datadog', 'site24x7', 'statuscake',

    // Scripting tools
    'curl/', 'wget/', 'libwww-perl', 'python-requests',
    'scrapy', 'go-http-client', 'httpie/',

    // Generic patterns (word-boundary safe to avoid e.g. "Cubot")
    'crawl[er/]', 'spider[/\\s;,)-]', 'scrape[r/]',
    '\\bbot[/\\s;,)-]',
  ].join('|'),
  'i'
);

/**
 * Returns true if the User-Agent indicates a bot, crawler, or headless browser.
 *
 * @param {string|null|undefined} userAgent
 * @returns {boolean}
 */
export function isBot(userAgent) {
  if (!userAgent) return true;
  return BOT_PATTERN.test(userAgent);
}
