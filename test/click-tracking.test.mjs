import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * classifyClick — mirrors the click tracking logic in tracker.src.js.
 * Takes an element-like object and returns the $click event properties,
 * or null if the click should be skipped.
 *
 * @param {{ tagName: string, href?: string, type?: string, textContent?: string, id?: string, className?: string }} el
 * @param {boolean} hasDeclarativeEvent - whether the element or ancestor has data-aa-event
 * @param {string} locationHostname - current page hostname
 * @returns {object|null}
 */
function classifyClick(el, hasDeclarativeEvent, locationHostname) {
  if (hasDeclarativeEvent) return null;
  if (!el) return null;

  var tag = el.tagName.toLowerCase();
  if (tag !== 'a' && tag !== 'button') return null;

  var props = {
    tag: tag,
    text: (el.textContent || '').trim().slice(0, 200),
    id: el.id || '',
    classes: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 200),
  };

  if (tag === 'a') {
    var href = el.href || '';
    props.href = href;
    try {
      var u = new URL(href);
      if (/^(mailto|tel|javascript):/.test(href)) return null;
      props.is_external = u.hostname !== locationHostname;
    } catch(_) {
      props.is_external = false;
    }
  } else {
    props.type = el.type || 'submit';
  }

  return props;
}

// --- Link classification ---

describe('click tracking links', () => {
  test('internal link', () => {
    const props = classifyClick(
      { tagName: 'A', href: 'https://example.com/about', textContent: 'About', id: 'nav-about', className: 'nav-link' },
      false, 'example.com'
    );
    assert.equal(props.tag, 'a');
    assert.equal(props.href, 'https://example.com/about');
    assert.equal(props.is_external, false);
    assert.equal(props.text, 'About');
    assert.equal(props.id, 'nav-about');
    assert.equal(props.classes, 'nav-link');
  });

  test('external link', () => {
    const props = classifyClick(
      { tagName: 'A', href: 'https://other.com/page', textContent: 'Visit', id: '', className: '' },
      false, 'example.com'
    );
    assert.equal(props.is_external, true);
  });

  test('link with no href has empty href and is_external false', () => {
    const props = classifyClick(
      { tagName: 'A', href: '', textContent: 'Link', id: '', className: '' },
      false, 'example.com'
    );
    assert.equal(props.href, '');
    assert.equal(props.is_external, false);
  });
});

// --- Skip conditions ---

describe('click tracking skip conditions', () => {
  test('skips mailto links', () => {
    const props = classifyClick(
      { tagName: 'A', href: 'mailto:user@example.com', textContent: 'Email', id: '', className: '' },
      false, 'example.com'
    );
    assert.equal(props, null);
  });

  test('skips tel links', () => {
    const props = classifyClick(
      { tagName: 'A', href: 'tel:+1234567890', textContent: 'Call', id: '', className: '' },
      false, 'example.com'
    );
    assert.equal(props, null);
  });

  test('skips javascript links', () => {
    const props = classifyClick(
      { tagName: 'A', href: 'javascript:void(0)', textContent: 'Click', id: '', className: '' },
      false, 'example.com'
    );
    assert.equal(props, null);
  });

  test('skips elements with declarative event', () => {
    const props = classifyClick(
      { tagName: 'A', href: 'https://example.com', textContent: 'Link', id: '', className: '' },
      true, 'example.com'
    );
    assert.equal(props, null);
  });

  test('skips null element', () => {
    const props = classifyClick(null, false, 'example.com');
    assert.equal(props, null);
  });

  test('skips non-link/button elements', () => {
    const props = classifyClick(
      { tagName: 'DIV', textContent: 'Div', id: '', className: '' },
      false, 'example.com'
    );
    assert.equal(props, null);
  });
});

// --- Button classification ---

describe('click tracking buttons', () => {
  test('submit button', () => {
    const props = classifyClick(
      { tagName: 'BUTTON', type: 'submit', textContent: 'Submit', id: 'btn-submit', className: 'btn primary' },
      false, 'example.com'
    );
    assert.equal(props.tag, 'button');
    assert.equal(props.type, 'submit');
    assert.equal(props.text, 'Submit');
    assert.equal(props.id, 'btn-submit');
    assert.equal(props.classes, 'btn primary');
    assert.equal(props.href, undefined);
    assert.equal(props.is_external, undefined);
  });

  test('button type defaults to submit when missing', () => {
    const props = classifyClick(
      { tagName: 'BUTTON', textContent: 'Click', id: '', className: '' },
      false, 'example.com'
    );
    assert.equal(props.type, 'submit');
  });

  test('reset button', () => {
    const props = classifyClick(
      { tagName: 'BUTTON', type: 'reset', textContent: 'Reset', id: '', className: '' },
      false, 'example.com'
    );
    assert.equal(props.type, 'reset');
  });

  test('button type=button', () => {
    const props = classifyClick(
      { tagName: 'BUTTON', type: 'button', textContent: 'Action', id: '', className: '' },
      false, 'example.com'
    );
    assert.equal(props.type, 'button');
  });
});

// --- Truncation ---

describe('click tracking truncation', () => {
  test('text truncated to 200 chars', () => {
    const props = classifyClick(
      { tagName: 'BUTTON', type: 'button', textContent: 'x'.repeat(500), id: '', className: '' },
      false, 'example.com'
    );
    assert.equal(props.text.length, 200);
  });

  test('classes truncated to 200 chars', () => {
    const props = classifyClick(
      { tagName: 'BUTTON', type: 'button', textContent: 'Click', id: '', className: 'c'.repeat(500) },
      false, 'example.com'
    );
    assert.equal(props.classes.length, 200);
  });

  test('text is trimmed', () => {
    const props = classifyClick(
      { tagName: 'BUTTON', type: 'button', textContent: '  Click Me  ', id: '', className: '' },
      false, 'example.com'
    );
    assert.equal(props.text, 'Click Me');
  });
});

// --- SVG className edge case ---

describe('click tracking className edge cases', () => {
  test('non-string className (e.g. SVGAnimatedString) falls back to empty', () => {
    const props = classifyClick(
      { tagName: 'BUTTON', type: 'button', textContent: 'X', id: '', className: { baseVal: 'icon' } },
      false, 'example.com'
    );
    assert.equal(props.classes, '');
  });

  test('null className gives empty classes', () => {
    const props = classifyClick(
      { tagName: 'BUTTON', type: 'button', textContent: 'X', id: '', className: null },
      false, 'example.com'
    );
    assert.equal(props.classes, '');
  });
});

// --- Build output checks ---

describe('click tracking in built tracker', () => {
  test('built tracker.js contains $click event name', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('$click'), 'tracker.js should contain $click');
  });

  test('built tracker.js contains data-track-clicks attribute', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('data-track-clicks'), 'tracker.js should reference data-track-clicks');
  });

  test('built tracker.js contains is_external property', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('is_external'), 'tracker.js should contain is_external');
  });
});
