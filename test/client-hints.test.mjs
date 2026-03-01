import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * applyClientHints — mirrors the Client Hints logic in tracker.src.js.
 * Takes a dev object (browser, browser_version, os, device) and a
 * navigator.userAgentData-like object. Mutates dev in place.
 */
function applyClientHints(dev, uad) {
  if (!uad) return dev;
  if (typeof uad.mobile === 'boolean' && uad.mobile) dev.device = 'mobile';
  if (uad.platform) {
    var plat = uad.platform;
    if (plat === 'macOS') dev.os = 'macOS';
    else if (plat === 'Windows') dev.os = 'Windows';
    else if (plat === 'Android') dev.os = 'Android';
    else if (plat === 'Chrome OS' || plat === 'ChromeOS') dev.os = 'ChromeOS';
    else if (plat === 'Linux') dev.os = 'Linux';
    else if (plat === 'iOS') dev.os = 'iOS';
  }
  if (uad.brands && uad.brands.length) {
    for (var bi = 0; bi < uad.brands.length; bi++) {
      var bn = uad.brands[bi].brand;
      if (bn === 'Google Chrome') { dev.browser = 'Chrome'; dev.browser_version = uad.brands[bi].version; break; }
      if (bn === 'Microsoft Edge') { dev.browser = 'Edge'; dev.browser_version = uad.brands[bi].version; break; }
      if (bn === 'Opera') { dev.browser = 'Opera'; dev.browser_version = uad.brands[bi].version; break; }
    }
  }
  return dev;
}

function makeDev(overrides) {
  return { browser: 'Chrome', browser_version: '120', os: 'macOS', device: 'desktop', ...overrides };
}

// --- Null/missing userAgentData ---

describe('client hints with no userAgentData', () => {
  test('returns dev unchanged when uad is null', () => {
    const dev = makeDev();
    applyClientHints(dev, null);
    assert.equal(dev.browser, 'Chrome');
    assert.equal(dev.os, 'macOS');
    assert.equal(dev.device, 'desktop');
  });

  test('returns dev unchanged when uad is undefined', () => {
    const dev = makeDev();
    applyClientHints(dev, undefined);
    assert.equal(dev.browser, 'Chrome');
  });
});

// --- OS mapping ---

describe('client hints OS mapping', () => {
  test('maps macOS', () => {
    const dev = makeDev({ os: 'Unknown' });
    applyClientHints(dev, { platform: 'macOS', brands: [] });
    assert.equal(dev.os, 'macOS');
  });

  test('maps Windows', () => {
    const dev = makeDev({ os: 'Unknown' });
    applyClientHints(dev, { platform: 'Windows', brands: [] });
    assert.equal(dev.os, 'Windows');
  });

  test('maps Android', () => {
    const dev = makeDev({ os: 'Unknown' });
    applyClientHints(dev, { platform: 'Android', brands: [] });
    assert.equal(dev.os, 'Android');
  });

  test('maps Chrome OS', () => {
    const dev = makeDev({ os: 'Unknown' });
    applyClientHints(dev, { platform: 'Chrome OS', brands: [] });
    assert.equal(dev.os, 'ChromeOS');
  });

  test('maps ChromeOS (alternative spelling)', () => {
    const dev = makeDev({ os: 'Unknown' });
    applyClientHints(dev, { platform: 'ChromeOS', brands: [] });
    assert.equal(dev.os, 'ChromeOS');
  });

  test('maps Linux', () => {
    const dev = makeDev({ os: 'Unknown' });
    applyClientHints(dev, { platform: 'Linux', brands: [] });
    assert.equal(dev.os, 'Linux');
  });

  test('maps iOS', () => {
    const dev = makeDev({ os: 'Unknown' });
    applyClientHints(dev, { platform: 'iOS', brands: [] });
    assert.equal(dev.os, 'iOS');
  });

  test('unknown platform leaves os unchanged', () => {
    const dev = makeDev({ os: 'macOS' });
    applyClientHints(dev, { platform: 'FuchsiaOS', brands: [] });
    assert.equal(dev.os, 'macOS');
  });

  test('empty platform leaves os unchanged', () => {
    const dev = makeDev({ os: 'Linux' });
    applyClientHints(dev, { platform: '', brands: [] });
    assert.equal(dev.os, 'Linux');
  });
});

// --- Brand matching ---

describe('client hints brand matching', () => {
  test('matches Google Chrome', () => {
    const dev = makeDev({ browser: 'Unknown', browser_version: '' });
    applyClientHints(dev, {
      brands: [
        { brand: 'Not_A Brand', version: '8' },
        { brand: 'Chromium', version: '126' },
        { brand: 'Google Chrome', version: '126' },
      ],
    });
    assert.equal(dev.browser, 'Chrome');
    assert.equal(dev.browser_version, '126');
  });

  test('matches Microsoft Edge', () => {
    const dev = makeDev({ browser: 'Unknown', browser_version: '' });
    applyClientHints(dev, {
      brands: [
        { brand: 'Not_A Brand', version: '8' },
        { brand: 'Chromium', version: '126' },
        { brand: 'Microsoft Edge', version: '126' },
      ],
    });
    assert.equal(dev.browser, 'Edge');
    assert.equal(dev.browser_version, '126');
  });

  test('matches Opera', () => {
    const dev = makeDev({ browser: 'Unknown', browser_version: '' });
    applyClientHints(dev, {
      brands: [
        { brand: 'Chromium', version: '126' },
        { brand: 'Opera', version: '112' },
      ],
    });
    assert.equal(dev.browser, 'Opera');
    assert.equal(dev.browser_version, '112');
  });

  test('Chrome takes priority over Chromium-only brands list', () => {
    const dev = makeDev({ browser: 'Unknown' });
    applyClientHints(dev, {
      brands: [
        { brand: 'Chromium', version: '126' },
      ],
    });
    // No recognized brand — browser stays unchanged
    assert.equal(dev.browser, 'Unknown');
  });

  test('empty brands array leaves browser unchanged', () => {
    const dev = makeDev({ browser: 'Safari' });
    applyClientHints(dev, { brands: [] });
    assert.equal(dev.browser, 'Safari');
  });

  test('null brands leaves browser unchanged', () => {
    const dev = makeDev({ browser: 'Firefox' });
    applyClientHints(dev, { brands: null });
    assert.equal(dev.browser, 'Firefox');
  });
});

// --- Mobile override ---

describe('client hints mobile override', () => {
  test('mobile true sets device to mobile', () => {
    const dev = makeDev({ device: 'desktop' });
    applyClientHints(dev, { mobile: true, brands: [] });
    assert.equal(dev.device, 'mobile');
  });

  test('mobile false does not change device', () => {
    const dev = makeDev({ device: 'desktop' });
    applyClientHints(dev, { mobile: false, brands: [] });
    assert.equal(dev.device, 'desktop');
  });

  test('mobile undefined does not change device', () => {
    const dev = makeDev({ device: 'tablet' });
    applyClientHints(dev, { brands: [] });
    assert.equal(dev.device, 'tablet');
  });

  test('mobile string "true" does not change device (type check)', () => {
    const dev = makeDev({ device: 'desktop' });
    applyClientHints(dev, { mobile: 'true', brands: [] });
    assert.equal(dev.device, 'desktop');
  });
});

// --- Build output checks ---

describe('client hints in built tracker', () => {
  test('built tracker.js contains userAgentData', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('userAgentData'), 'tracker.js should contain userAgentData');
  });

  test('built tracker.js contains Google Chrome brand', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('Google Chrome'), 'tracker.js should contain Google Chrome brand');
  });

  test('built tracker.js contains Microsoft Edge brand', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('Microsoft Edge'), 'tracker.js should contain Microsoft Edge brand');
  });
});
