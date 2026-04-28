import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = path.join(repoRoot, 'README.md');

async function readReadme() {
  return readFile(readmePath, 'utf8');
}

test('README trust surface includes status, tests, license, and privacy/trust badges', async () => {
  const readme = await readReadme();
  assert.match(readme, /img\.shields\.io\/npm\/v\/@agent-analytics\/core/);
  assert.match(readme, /actions\/workflows\/ci\.yml\/badge\.svg/);
  assert.match(readme, /license-MIT/);
  assert.match(readme, /privacy-default--minimal/);
  assert.match(readme, /trust-readable--tracker/);
});

test('README links readable tracker source and hosted tracker endpoints', async () => {
  const readme = await readReadme();
  assert.match(readme, /Audited tracker surface/);
  assert.match(readme, /\.\/src\/tracker\.src\.js/);
  assert.match(readme, /\.\/src\/tracker-source\.js/);
  assert.match(readme, /https:\/\/api\.agentanalytics\.sh\/tracker\.src\.js/);
  assert.match(readme, /https:\/\/api\.agentanalytics\.sh\/tracker\.js/);
  assert.match(readme, /`GET \/tracker\.src\.js`/);
});

test('README documents default tracker privacy contract', async () => {
  const readme = await readReadme();
  const requiredTerms = [
    'Default privacy contract',
    'does not dynamically load third-party scripts',
    'eval',
    'new Function',
    'document.write',
    'collect form values',
    'hard browser fingerprinting',
    'sanitized to origin plus pathname',
    'utm_source',
    'Anonymous and session identifiers are scoped',
    'Local development on `localhost` and `127.0.0.1`',
    'Higher-sensitivity automatic capture is opt-in',
    'SPA route listeners are disabled unless configured',
    'aa.identify(userId, { email })',
    'stripped from event rows/profile traits by default',
  ];

  for (const term of requiredTerms) {
    assert.match(readme, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('README references tracker unit tests and privacy guardrails', async () => {
  const readme = await readReadme();
  const requiredTests = [
    'test/tracker-privacy-guardrails.test.mjs',
    'test/tracker-url-sanitization.test.mjs',
    'test/storage-scoping.test.mjs',
    'test/tracker-identity.test.mjs',
    'test/handler-routes.test.mjs',
  ];

  assert.match(readme, /Tracker behavior is covered by unit tests/);
  for (const testFile of requiredTests) {
    assert.match(readme, new RegExp(testFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
