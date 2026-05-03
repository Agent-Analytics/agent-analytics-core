import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { TRACKER_CHECKSUMS, TRACKER_JS } from '../src/index.js';

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

test('tracker checksum manifest exposes deterministic sha256 digest for minified tracker only', () => {
  assert.equal(TRACKER_CHECKSUMS.algorithm, 'sha256');
  assert.equal(TRACKER_CHECKSUMS.trackerMinifiedSha256, sha256Hex(TRACKER_JS));
  assert.match(TRACKER_CHECKSUMS.trackerMinifiedSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(TRACKER_CHECKSUMS, 'trackerSourceSha256'), false);
  assert.equal(Object.hasOwn(TRACKER_CHECKSUMS, 'trackerReadableExportSha256'), false);
});

test('generated tracker checksum file is in sync with exported manifest', async () => {
  const generated = await import('../src/tracker-checksums.js');
  assert.deepEqual(generated.TRACKER_CHECKSUMS, TRACKER_CHECKSUMS);
});
