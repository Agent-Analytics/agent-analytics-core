import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * classifyForm — mirrors the form submission tracking logic in tracker.src.js.
 * Takes a form-like object and returns $form_submit properties, or null if skipped.
 *
 * @param {{ tagName: string, id?: string, name?: string, action?: string, method?: string, className?: string, hasNovalidate?: boolean, isValid?: boolean }} form
 * @param {boolean} hasDeclarativeEvent - whether the form has data-aa-event
 * @returns {object|null}
 */
function classifyForm(form, hasDeclarativeEvent) {
  if (!form || form.tagName !== 'FORM') return null;
  if (hasDeclarativeEvent) return null;
  // If form doesn't have novalidate and has checkValidity, check it
  if (!form.hasNovalidate && form.isValid === false) return null;

  return {
    id: form.id || '',
    name: form.name || '',
    action: (form.action || '').slice(0, 500),
    method: (form.method || 'GET').toUpperCase(),
    classes: (form.className && typeof form.className === 'string' ? form.className : '').slice(0, 200)
  };
}

// --- Basic form classification ---

describe('form tracking basic', () => {
  test('form with all attributes', () => {
    const props = classifyForm({
      tagName: 'FORM',
      id: 'contact-form',
      name: 'contact',
      action: 'https://example.com/submit',
      method: 'post',
      className: 'form-inline',
      hasNovalidate: false,
      isValid: true
    }, false);
    assert.equal(props.id, 'contact-form');
    assert.equal(props.name, 'contact');
    assert.equal(props.action, 'https://example.com/submit');
    assert.equal(props.method, 'POST');
    assert.equal(props.classes, 'form-inline');
  });

  test('form with no optional attributes', () => {
    const props = classifyForm({
      tagName: 'FORM',
      hasNovalidate: true
    }, false);
    assert.equal(props.id, '');
    assert.equal(props.name, '');
    assert.equal(props.action, '');
    assert.equal(props.method, 'GET');
    assert.equal(props.classes, '');
  });

  test('method defaults to GET when missing', () => {
    const props = classifyForm({
      tagName: 'FORM',
      hasNovalidate: true
    }, false);
    assert.equal(props.method, 'GET');
  });

  test('method is uppercased', () => {
    const props = classifyForm({
      tagName: 'FORM',
      method: 'post',
      hasNovalidate: true
    }, false);
    assert.equal(props.method, 'POST');
  });

  test('GET method stays GET', () => {
    const props = classifyForm({
      tagName: 'FORM',
      method: 'get',
      hasNovalidate: true
    }, false);
    assert.equal(props.method, 'GET');
  });
});

// --- Skip conditions ---

describe('form tracking skip conditions', () => {
  test('skips forms with data-aa-event', () => {
    const props = classifyForm({
      tagName: 'FORM',
      id: 'test',
      hasNovalidate: true
    }, true);
    assert.equal(props, null);
  });

  test('skips null form', () => {
    assert.equal(classifyForm(null, false), null);
  });

  test('skips non-FORM elements', () => {
    assert.equal(classifyForm({ tagName: 'DIV' }, false), null);
  });

  test('skips invalid form without novalidate', () => {
    const props = classifyForm({
      tagName: 'FORM',
      id: 'test',
      hasNovalidate: false,
      isValid: false
    }, false);
    assert.equal(props, null);
  });

  test('tracks invalid form with novalidate', () => {
    const props = classifyForm({
      tagName: 'FORM',
      id: 'test',
      hasNovalidate: true,
      isValid: false
    }, false);
    assert.notEqual(props, null);
    assert.equal(props.id, 'test');
  });
});

// --- Truncation ---

describe('form tracking truncation', () => {
  test('action truncated to 500 chars', () => {
    const props = classifyForm({
      tagName: 'FORM',
      action: 'https://example.com/' + 'x'.repeat(600),
      hasNovalidate: true
    }, false);
    assert.equal(props.action.length, 500);
  });

  test('classes truncated to 200 chars', () => {
    const props = classifyForm({
      tagName: 'FORM',
      className: 'c'.repeat(500),
      hasNovalidate: true
    }, false);
    assert.equal(props.classes.length, 200);
  });

  test('short action is not truncated', () => {
    const props = classifyForm({
      tagName: 'FORM',
      action: '/submit',
      hasNovalidate: true
    }, false);
    assert.equal(props.action, '/submit');
  });
});

// --- className edge cases ---

describe('form tracking className edge cases', () => {
  test('non-string className gives empty classes', () => {
    const props = classifyForm({
      tagName: 'FORM',
      className: { baseVal: 'icon' },
      hasNovalidate: true
    }, false);
    assert.equal(props.classes, '');
  });

  test('null className gives empty classes', () => {
    const props = classifyForm({
      tagName: 'FORM',
      className: null,
      hasNovalidate: true
    }, false);
    assert.equal(props.classes, '');
  });

  test('undefined className gives empty classes', () => {
    const props = classifyForm({
      tagName: 'FORM',
      hasNovalidate: true
    }, false);
    assert.equal(props.classes, '');
  });
});

// --- Build output checks ---

describe('form tracking in built tracker', () => {
  test('built tracker.js contains $form_submit event name', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('$form_submit'), 'tracker.js should contain $form_submit');
  });

  test('built tracker.js contains data-track-forms attribute', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('data-track-forms'), 'tracker.js should reference data-track-forms');
  });

  test('built tracker.js contains submit event listener', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('submit'), 'tracker.js should contain submit listener');
  });
});
