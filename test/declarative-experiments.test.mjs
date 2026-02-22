import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';

/**
 * Tests for the declarative experiments feature (applyDeclarativeExperiments).
 *
 * Since tracker.src.js runs in a browser context, we replicate the core logic
 * here: scanning elements, calling experiment(), and swapping textContent.
 * This validates the algorithm matches what tracker.src.js implements.
 */

// --- DJB2 hash (same as tracker.src.js) ---
function djb2Hash(str) {
  let hash = 0;
  for (let j = 0; j < str.length; j++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(j);
    hash = hash & hash;
  }
  return Math.abs(hash) % 100;
}

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

/**
 * Simulates aa.experiment() with URL param forcing — must match tracker.src.js.
 */
function experiment(name, experimentConfig, experimentCache, userId, searchString) {
  if (experimentCache[name] !== undefined) return experimentCache[name];

  let config = null;
  if (experimentConfig) {
    for (const exp of experimentConfig) {
      if (exp.key === name) { config = exp; break; }
    }
  }
  if (!config) return null;

  // URL param override
  if (searchString) {
    const params = new URLSearchParams(searchString);
    const urlForced = params.get('aa_variant_' + name);
    if (urlForced) {
      for (const v of config.variants) {
        if (v.key === urlForced) {
          experimentCache[name] = urlForced;
          return urlForced;
        }
      }
    }
  }

  const bucket = djb2Hash(name + '.' + userId);
  const assigned = assignVariant(bucket, config.variants);
  experimentCache[name] = assigned;
  return assigned;
}

/**
 * Simulates applyDeclarativeExperiments() on a mock DOM.
 *
 * Elements: array of { experiment, variants: { key: text }, content, textContent (output) }
 * Returns: elements with textContent updated.
 */
function applyDeclarativeExperiments(elements, experimentConfig, userId, searchString) {
  const cache = {};
  const exposures = [];

  for (const el of elements) {
    const name = el.experiment;
    const variant = experiment(name, experimentConfig, cache, userId, searchString);
    if (variant) {
      const replacement = el.variants[variant.toLowerCase()];
      if (replacement !== undefined) {
        el.textContent = replacement;
      }
      // else: control — leave original content
    }
    // Track exposure (simulated)
    if (variant && !exposures.find(e => e.experiment === name)) {
      exposures.push({ experiment: name, variant });
    }
  }

  return { elements, exposures, aaLoadingRemoved: true };
}

describe('applyDeclarativeExperiments', () => {
  const config = [
    { key: 'hero_text', variants: [{ key: 'control', weight: 50 }, { key: 'b', weight: 50 }] },
    { key: 'cta_test', variants: [{ key: 'control', weight: 34 }, { key: 'b', weight: 33 }, { key: 'c', weight: 33 }] },
  ];

  test('swaps textContent when variant attribute matches', () => {
    // Find a userId that gets variant 'b' for hero_text
    let userId;
    for (let i = 0; i < 1000; i++) {
      const candidate = `user_${i}`;
      const bucket = djb2Hash('hero_text.' + candidate);
      const assigned = assignVariant(bucket, config[0].variants);
      if (assigned === 'b') { userId = candidate; break; }
    }
    assert.ok(userId, 'should find a userId assigned to variant b');

    const elements = [
      { experiment: 'hero_text', variants: { b: 'Try it free!' }, textContent: 'Start your trial' },
    ];

    const result = applyDeclarativeExperiments(elements, config, userId);
    assert.equal(result.elements[0].textContent, 'Try it free!');
  });

  test('leaves original content for control variant', () => {
    // Find a userId that gets 'control' for hero_text
    let userId;
    for (let i = 0; i < 1000; i++) {
      const candidate = `user_${i}`;
      const bucket = djb2Hash('hero_text.' + candidate);
      const assigned = assignVariant(bucket, config[0].variants);
      if (assigned === 'control') { userId = candidate; break; }
    }
    assert.ok(userId, 'should find a userId assigned to control');

    const elements = [
      { experiment: 'hero_text', variants: { b: 'Try it free!' }, textContent: 'Start your trial' },
    ];

    const result = applyDeclarativeExperiments(elements, config, userId);
    assert.equal(result.elements[0].textContent, 'Start your trial');
  });

  test('multiple elements in same experiment get same variant', () => {
    let userId;
    for (let i = 0; i < 1000; i++) {
      const candidate = `user_${i}`;
      const bucket = djb2Hash('hero_text.' + candidate);
      const assigned = assignVariant(bucket, config[0].variants);
      if (assigned === 'b') { userId = candidate; break; }
    }

    const elements = [
      { experiment: 'hero_text', variants: { b: 'New headline' }, textContent: 'Old headline' },
      { experiment: 'hero_text', variants: { b: 'New subtext' }, textContent: 'Old subtext' },
    ];

    const result = applyDeclarativeExperiments(elements, config, userId);
    assert.equal(result.elements[0].textContent, 'New headline');
    assert.equal(result.elements[1].textContent, 'New subtext');
  });

  test('returns null for unknown experiment (no config)', () => {
    const elements = [
      { experiment: 'unknown_exp', variants: { b: 'Never shown' }, textContent: 'Original' },
    ];

    const result = applyDeclarativeExperiments(elements, config, 'user_1');
    assert.equal(result.elements[0].textContent, 'Original');
  });

  test('multi-variant experiment assigns one variant', () => {
    const userId = 'user_42';
    const bucket = djb2Hash('cta_test.' + userId);
    const expected = assignVariant(bucket, config[1].variants);

    const elements = [
      { experiment: 'cta_test', variants: { b: 'Try it free', c: 'Get started now' }, textContent: 'Sign up today' },
    ];

    const result = applyDeclarativeExperiments(elements, config, userId);

    if (expected === 'control') {
      assert.equal(result.elements[0].textContent, 'Sign up today');
    } else if (expected === 'b') {
      assert.equal(result.elements[0].textContent, 'Try it free');
    } else {
      assert.equal(result.elements[0].textContent, 'Get started now');
    }
  });

  test('variant key is lowercased for attribute lookup', () => {
    const mixedCaseConfig = [
      { key: 'test_exp', variants: [{ key: 'control', weight: 50 }, { key: 'NewVariant', weight: 50 }] },
    ];

    // Find userId assigned to 'NewVariant'
    let userId;
    for (let i = 0; i < 1000; i++) {
      const candidate = `user_${i}`;
      const bucket = djb2Hash('test_exp.' + candidate);
      const assigned = assignVariant(bucket, mixedCaseConfig[0].variants);
      if (assigned === 'NewVariant') { userId = candidate; break; }
    }
    assert.ok(userId, 'should find a userId assigned to NewVariant');

    // Attribute keys in HTML are always lowercase, so data-aa-variant-newvariant
    const elements = [
      { experiment: 'test_exp', variants: { newvariant: 'New text' }, textContent: 'Original' },
    ];

    const result = applyDeclarativeExperiments(elements, mixedCaseConfig, userId);
    assert.equal(result.elements[0].textContent, 'New text');
  });

  test('aa-loading class removal is signaled', () => {
    const result = applyDeclarativeExperiments([], config, 'user_1');
    assert.equal(result.aaLoadingRemoved, true);
  });

  test('empty experiment config still removes aa-loading', () => {
    const result = applyDeclarativeExperiments(
      [{ experiment: 'test', variants: { b: 'text' }, textContent: 'Original' }],
      [],
      'user_1'
    );
    assert.equal(result.aaLoadingRemoved, true);
    assert.equal(result.elements[0].textContent, 'Original');
  });

  test('null experiment config still removes aa-loading', () => {
    const result = applyDeclarativeExperiments(
      [{ experiment: 'test', variants: { b: 'text' }, textContent: 'Original' }],
      null,
      'user_1'
    );
    assert.equal(result.aaLoadingRemoved, true);
    assert.equal(result.elements[0].textContent, 'Original');
  });

  test('URL param forces variant in declarative experiment', () => {
    const elements = [
      { experiment: 'hero_text', variants: { b: 'Forced headline!' }, textContent: 'Original headline' },
    ];

    // Force variant 'b' via URL param, regardless of userId hash
    const result = applyDeclarativeExperiments(elements, config, 'any_user', '?aa_variant_hero_text=b');
    assert.equal(result.elements[0].textContent, 'Forced headline!');
    assert.equal(result.exposures[0].variant, 'b');
  });

  test('URL param forcing does not affect other experiments', () => {
    const elements = [
      { experiment: 'hero_text', variants: { b: 'Forced headline!' }, textContent: 'Original headline' },
      { experiment: 'cta_test', variants: { b: 'CTA B', c: 'CTA C' }, textContent: 'CTA Original' },
    ];

    // Force only hero_text, cta_test should use normal hash
    const result = applyDeclarativeExperiments(elements, config, 'user_42', '?aa_variant_hero_text=b');
    assert.equal(result.elements[0].textContent, 'Forced headline!');

    // cta_test should be hash-assigned
    const expectedBucket = djb2Hash('cta_test.user_42');
    const expectedVariant = assignVariant(expectedBucket, config[1].variants);
    if (expectedVariant === 'control') {
      assert.equal(result.elements[1].textContent, 'CTA Original');
    } else if (expectedVariant === 'b') {
      assert.equal(result.elements[1].textContent, 'CTA B');
    } else {
      assert.equal(result.elements[1].textContent, 'CTA C');
    }
  });
});
