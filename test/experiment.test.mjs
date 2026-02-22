import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

/**
 * DJB2 hash — must match the implementation in tracker.src.js.
 */
function djb2Hash(str) {
  let hash = 0;
  for (let j = 0; j < str.length; j++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(j);
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash) % 100;
}

/**
 * Assign variant by bucket + weights.
 */
function assignVariant(bucket, variants) {
  let cumulative = 0;
  let assigned = variants[0].key;
  for (const v of variants) {
    cumulative += v.weight;
    if (bucket < cumulative) {
      assigned = v.key;
      break;
    }
  }
  return assigned;
}

describe('experiment hash assignment', () => {
  test('hash is deterministic (same input → same output)', () => {
    const input = 'signup_cta.anon_abc123def';
    const hash1 = djb2Hash(input);
    const hash2 = djb2Hash(input);
    const hash3 = djb2Hash(input);
    assert.equal(hash1, hash2);
    assert.equal(hash2, hash3);
  });

  test('hash produces values in range 0-99', () => {
    for (let i = 0; i < 1000; i++) {
      const input = `test_exp.user_${i}_${Math.random().toString(36)}`;
      const bucket = djb2Hash(input);
      assert.ok(bucket >= 0, `bucket ${bucket} should be >= 0`);
      assert.ok(bucket < 100, `bucket ${bucket} should be < 100`);
    }
  });

  test('distribution is reasonably even across buckets', () => {
    const buckets = new Array(100).fill(0);
    const numUsers = 10000;

    for (let i = 0; i < numUsers; i++) {
      const input = `experiment_name.user_${i}`;
      const bucket = djb2Hash(input);
      buckets[bucket]++;
    }

    // Each bucket should have roughly numUsers/100 = 100 entries
    // Allow ±50% variance (50-150 per bucket)
    const expected = numUsers / 100;
    let outOfRange = 0;
    for (let i = 0; i < 100; i++) {
      if (buckets[i] < expected * 0.5 || buckets[i] > expected * 1.5) {
        outOfRange++;
      }
    }
    // Allow up to 5% of buckets to be out of range
    assert.ok(outOfRange <= 5, `${outOfRange} buckets out of range (max 5 allowed)`);
  });

  test('different users get different assignments', () => {
    const assignments = new Set();
    for (let i = 0; i < 100; i++) {
      const bucket = djb2Hash(`test_exp.user_${i}`);
      assignments.add(bucket);
    }
    // With 100 users and 100 buckets, we should get at least 20 unique values
    assert.ok(assignments.size >= 20, `only ${assignments.size} unique buckets from 100 users`);
  });
});

describe('variant weight assignment', () => {
  test('50/50 split assigns correctly', () => {
    const variants = [{ key: 'control', weight: 50 }, { key: 'variant', weight: 50 }];

    // Bucket 0-49 → control, 50-99 → variant
    assert.equal(assignVariant(0, variants), 'control');
    assert.equal(assignVariant(25, variants), 'control');
    assert.equal(assignVariant(49, variants), 'control');
    assert.equal(assignVariant(50, variants), 'variant');
    assert.equal(assignVariant(75, variants), 'variant');
    assert.equal(assignVariant(99, variants), 'variant');
  });

  test('70/30 split assigns correctly', () => {
    const variants = [{ key: 'a', weight: 70 }, { key: 'b', weight: 30 }];

    assert.equal(assignVariant(0, variants), 'a');
    assert.equal(assignVariant(69, variants), 'a');
    assert.equal(assignVariant(70, variants), 'b');
    assert.equal(assignVariant(99, variants), 'b');
  });

  test('three-way split assigns correctly', () => {
    const variants = [
      { key: 'a', weight: 34 },
      { key: 'b', weight: 33 },
      { key: 'c', weight: 33 },
    ];

    assert.equal(assignVariant(0, variants), 'a');
    assert.equal(assignVariant(33, variants), 'a');
    assert.equal(assignVariant(34, variants), 'b');
    assert.equal(assignVariant(66, variants), 'b');
    assert.equal(assignVariant(67, variants), 'c');
    assert.equal(assignVariant(99, variants), 'c');
  });

  test('weights respected in aggregate', () => {
    const variants = [{ key: 'a', weight: 80 }, { key: 'b', weight: 20 }];
    let aCount = 0;
    let bCount = 0;

    for (let bucket = 0; bucket < 100; bucket++) {
      const result = assignVariant(bucket, variants);
      if (result === 'a') aCount++;
      else bCount++;
    }

    assert.equal(aCount, 80);
    assert.equal(bCount, 20);
  });
});

/**
 * Simulates experiment() with URL param forcing — must match tracker.src.js.
 *
 * @param {string} name - experiment name
 * @param {object[]} experimentConfig - array of { key, variants: [{ key, weight }] }
 * @param {object} cache - experimentCache object (mutated)
 * @param {string} userId
 * @param {string|null} searchString - simulated location.search (e.g. '?aa_variant_hero=control')
 * @param {string[]} [inlineVariants] - optional inline variant keys (for aa.experiment('name', ['a','b']))
 * @returns {{ variant: string|null, exposure: object|null }}
 */
function experimentWithForcing(name, experimentConfig, cache, userId, searchString, inlineVariants) {
  if (cache[name] !== undefined) return { variant: cache[name], exposure: null };

  // Resolve config
  let config = null;
  if (experimentConfig) {
    for (const exp of experimentConfig) {
      if (exp.key === name) { config = exp; break; }
    }
  }
  if (!config && inlineVariants) {
    const w = Math.floor(100 / inlineVariants.length);
    const remainder = 100 - (w * inlineVariants.length);
    config = { key: name, variants: inlineVariants.map((v, idx) => ({ key: v, weight: w + (idx === 0 ? remainder : 0) })) };
  }
  if (!config) return { variant: null, exposure: null };

  // URL param override
  if (searchString) {
    const params = new URLSearchParams(searchString);
    const urlForced = params.get('aa_variant_' + name);
    if (urlForced) {
      for (const v of config.variants) {
        if (v.key === urlForced) {
          cache[name] = urlForced;
          return { variant: urlForced, exposure: { experiment: name, variant: urlForced, forced: true } };
        }
      }
      // Invalid variant — fall through to hash
    }
  }

  // Normal hash assignment
  const bucket = djb2Hash(name + '.' + userId);
  const assigned = assignVariant(bucket, config.variants);
  cache[name] = assigned;
  return { variant: assigned, exposure: { experiment: name, variant: assigned } };
}

describe('URL param variant forcing', () => {
  const config = [
    { key: 'hero_headline', variants: [{ key: 'control', weight: 50 }, { key: 'new_copy', weight: 50 }] },
    { key: 'cta_test', variants: [{ key: 'control', weight: 34 }, { key: 'b', weight: 33 }, { key: 'c', weight: 33 }] },
  ];

  test('valid forced variant overrides hash assignment', () => {
    const cache = {};
    // Force 'new_copy' regardless of what hash would assign
    const result = experimentWithForcing('hero_headline', config, cache, 'user_999', '?aa_variant_hero_headline=new_copy');
    assert.equal(result.variant, 'new_copy');
  });

  test('forced variant is cached', () => {
    const cache = {};
    experimentWithForcing('hero_headline', config, cache, 'user_1', '?aa_variant_hero_headline=control');
    assert.equal(cache['hero_headline'], 'control');

    // Second call returns from cache (no exposure tracked)
    const result2 = experimentWithForcing('hero_headline', config, cache, 'user_1', '?aa_variant_hero_headline=control');
    assert.equal(result2.variant, 'control');
    assert.equal(result2.exposure, null); // from cache, no new exposure
  });

  test('exposure event includes forced: true', () => {
    const cache = {};
    const result = experimentWithForcing('hero_headline', config, cache, 'user_1', '?aa_variant_hero_headline=new_copy');
    assert.deepEqual(result.exposure, { experiment: 'hero_headline', variant: 'new_copy', forced: true });
  });

  test('normal hash exposure does NOT include forced property', () => {
    const cache = {};
    const result = experimentWithForcing('hero_headline', config, cache, 'user_1', null);
    assert.ok(result.exposure);
    assert.equal(result.exposure.forced, undefined);
  });

  test('invalid forced variant falls through to hash assignment', () => {
    const cache = {};
    const result = experimentWithForcing('hero_headline', config, cache, 'user_1', '?aa_variant_hero_headline=garbage');
    // Should get normal hash-assigned variant, not 'garbage'
    const expectedBucket = djb2Hash('hero_headline.user_1');
    const expectedVariant = assignVariant(expectedBucket, config[0].variants);
    assert.equal(result.variant, expectedVariant);
    assert.equal(result.exposure.forced, undefined);
  });

  test('no URL param → normal hash behavior', () => {
    const cache = {};
    const result = experimentWithForcing('hero_headline', config, cache, 'user_42', '');
    const expectedBucket = djb2Hash('hero_headline.user_42');
    const expectedVariant = assignVariant(expectedBucket, config[0].variants);
    assert.equal(result.variant, expectedVariant);
  });

  test('URL param for different experiment does not affect this one', () => {
    const cache = {};
    // URL has param for cta_test, not hero_headline
    const result = experimentWithForcing('hero_headline', config, cache, 'user_1', '?aa_variant_cta_test=b');
    const expectedBucket = djb2Hash('hero_headline.user_1');
    const expectedVariant = assignVariant(expectedBucket, config[0].variants);
    assert.equal(result.variant, expectedVariant);
  });

  test('forcing works with inline variants (no server config)', () => {
    const cache = {};
    const result = experimentWithForcing('local_test', null, cache, 'user_1', '?aa_variant_local_test=b', ['a', 'b']);
    assert.equal(result.variant, 'b');
    assert.equal(result.exposure.forced, true);
  });

  test('forcing works with multi-variant experiment', () => {
    const cache = {};
    const result = experimentWithForcing('cta_test', config, cache, 'user_1', '?aa_variant_cta_test=c');
    assert.equal(result.variant, 'c');
    assert.equal(result.exposure.forced, true);
  });
});
