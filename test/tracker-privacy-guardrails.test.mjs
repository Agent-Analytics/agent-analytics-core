import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '..', 'src', 'tracker.src.js'), 'utf8');
const generated = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf8')
  .replace(/\/\*! Agent Analytics tracker[^\n]*\n?/, '');
const trackerText = `${source}\n${generated}`;

function assertNoPattern(pattern, description) {
  assert.equal(
    pattern.test(trackerText),
    false,
    `tracker must not contain ${description}: ${pattern}`,
  );
}

test('tracker has no browser-side email hashing primitives', () => {
  assertNoPattern(/\bcrypto\.subtle\b/i, 'Web Crypto digest usage');
  assertNoPattern(/\bSubtleCrypto\b/i, 'SubtleCrypto usage');
  assertNoPattern(/\bdigest\s*\(/i, 'digest() calls');
  assertNoPattern(/\bsha\s*-?\s*(1|2|256|384|512)\b/i, 'SHA hashing references');
  assertNoPattern(/\bmd5\b/i, 'MD5 hashing references');
  assertNoPattern(/email[^\n]{0,80}\bhash/i, 'email hashing references');
});

test('tracker has no hard fingerprinting APIs', () => {
  assertNoPattern(/\bnavigator\.hardwareConcurrency\b/i, 'hardwareConcurrency fingerprinting');
  assertNoPattern(/\bnavigator\.deviceMemory\b/i, 'deviceMemory fingerprinting');
  assertNoPattern(/\bnavigator\.plugins\b/i, 'plugin enumeration');
  assertNoPattern(/\bnavigator\.mimeTypes\b/i, 'mimeType enumeration');
  assertNoPattern(/\bnavigator\.getBattery\b/i, 'battery fingerprinting');
  assertNoPattern(/\bAudioContext\b|\bwebkitAudioContext\b/i, 'audio fingerprinting');
  assertNoPattern(/\bOfflineAudioContext\b|\bwebkitOfflineAudioContext\b/i, 'offline audio fingerprinting');
  assertNoPattern(/\bcanvas\.toDataURL\b|\bgetImageData\s*\(/i, 'canvas fingerprinting');
  assertNoPattern(/\bWEBGL_debug_renderer_info\b|\bgetParameter\s*\(\s*\w+\.(?:UNMASKED_VENDOR_WEBGL|UNMASKED_RENDERER_WEBGL)/i, 'WebGL renderer fingerprinting');
});

test('tracker does not dynamically load scripts or use eval-like behavior', () => {
  assertNoPattern(/createElement\s*\(\s*['"]script['"]\s*\)/i, 'dynamic script element creation');
  assertNoPattern(/\.appendChild\s*\([^)]*script/i, 'dynamic script insertion');
  assertNoPattern(/\.insertBefore\s*\([^)]*script/i, 'dynamic script insertion');
  assertNoPattern(/\beval\s*\(/i, 'eval()');
  assertNoPattern(/\bnew\s+Function\s*\(/i, 'Function constructor');
  assertNoPattern(/\bset(?:Timeout|Interval)\s*\(\s*['"`]/i, 'string timers');
  assertNoPattern(/\bimport\s*\(/i, 'dynamic import');
});

test('tracker does not write documents or collect form field values', () => {
  assertNoPattern(/\bdocument\.write(?:ln)?\s*\(/i, 'document.write/document.writeln');
  assertNoPattern(/\bFormData\s*\(/i, 'FormData collection');
  assertNoPattern(/querySelector(?:All)?\s*\(\s*['"][^'"]*(?:input|textarea|select)/i, 'form field selector collection');
  assertNoPattern(/\b(?:input|textarea|select|field|element|el)\b[^\n]{0,120}\.(?:value|defaultValue)\b/i, 'input/textarea/select value collection');
});
