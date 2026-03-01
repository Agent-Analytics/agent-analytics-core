import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * classifyDownload — mirrors the download tracking logic in tracker.src.js.
 * Takes a link href and returns { href, filename, extension } or null if not a download.
 *
 * @param {string} href - the link's href attribute
 * @param {boolean} hasDeclarativeEvent - whether element has data-aa-event
 * @returns {object|null}
 */
function classifyDownload(href, hasDeclarativeEvent) {
  if (hasDeclarativeEvent) return null;
  if (!href) return null;

  var DL_EXT = /\.(pdf|xlsx?|docx?|txt|rtf|csv|exe|key|pps|pptx?|7z|pkg|rar|gz|zip|avi|mov|mp4|mpeg|wmv|midi|mp3|wav|wma|dmg|iso|msi)$/i;

  try {
    var url = new URL(href);
    if (!url.protocol.startsWith('http')) return null;
    var path = url.pathname;
    var m = path.match(DL_EXT);
    if (m) {
      return {
        href: url.origin + url.pathname,
        filename: path.split('/').pop(),
        extension: m[1].toLowerCase()
      };
    }
  } catch(_) {}
  return null;
}

// --- Extension matching ---

describe('download tracking extension matching', () => {
  test('matches .pdf', () => {
    const r = classifyDownload('https://example.com/report.pdf', false);
    assert.equal(r.extension, 'pdf');
    assert.equal(r.filename, 'report.pdf');
  });

  test('matches .zip', () => {
    const r = classifyDownload('https://example.com/files/archive.zip', false);
    assert.equal(r.extension, 'zip');
    assert.equal(r.filename, 'archive.zip');
  });

  test('matches .docx', () => {
    const r = classifyDownload('https://example.com/doc.docx', false);
    assert.equal(r.extension, 'docx');
  });

  test('matches .doc', () => {
    const r = classifyDownload('https://example.com/doc.doc', false);
    assert.equal(r.extension, 'doc');
  });

  test('matches .xlsx', () => {
    const r = classifyDownload('https://example.com/data.xlsx', false);
    assert.equal(r.extension, 'xlsx');
  });

  test('matches .xls', () => {
    const r = classifyDownload('https://example.com/data.xls', false);
    assert.equal(r.extension, 'xls');
  });

  test('matches .pptx', () => {
    const r = classifyDownload('https://example.com/slides.pptx', false);
    assert.equal(r.extension, 'pptx');
  });

  test('matches .ppt', () => {
    const r = classifyDownload('https://example.com/slides.ppt', false);
    assert.equal(r.extension, 'ppt');
  });

  test('matches .mp4', () => {
    const r = classifyDownload('https://example.com/video.mp4', false);
    assert.equal(r.extension, 'mp4');
  });

  test('matches .mp3', () => {
    const r = classifyDownload('https://example.com/song.mp3', false);
    assert.equal(r.extension, 'mp3');
  });

  test('matches .dmg', () => {
    const r = classifyDownload('https://example.com/app.dmg', false);
    assert.equal(r.extension, 'dmg');
  });

  test('matches .exe', () => {
    const r = classifyDownload('https://example.com/installer.exe', false);
    assert.equal(r.extension, 'exe');
  });

  test('matches .iso', () => {
    const r = classifyDownload('https://example.com/image.iso', false);
    assert.equal(r.extension, 'iso');
  });

  test('matches .csv', () => {
    const r = classifyDownload('https://example.com/data.csv', false);
    assert.equal(r.extension, 'csv');
  });

  test('matches .7z', () => {
    const r = classifyDownload('https://example.com/archive.7z', false);
    assert.equal(r.extension, '7z');
  });

  test('matches .rar', () => {
    const r = classifyDownload('https://example.com/archive.rar', false);
    assert.equal(r.extension, 'rar');
  });

  test('matches .gz', () => {
    const r = classifyDownload('https://example.com/archive.gz', false);
    assert.equal(r.extension, 'gz');
  });

  test('matches .txt', () => {
    const r = classifyDownload('https://example.com/readme.txt', false);
    assert.equal(r.extension, 'txt');
  });

  test('matches .wav', () => {
    const r = classifyDownload('https://example.com/audio.wav', false);
    assert.equal(r.extension, 'wav');
  });

  test('matches .msi', () => {
    const r = classifyDownload('https://example.com/setup.msi', false);
    assert.equal(r.extension, 'msi');
  });
});

// --- Non-download extensions ---

describe('download tracking ignores non-download extensions', () => {
  test('ignores .html', () => {
    assert.equal(classifyDownload('https://example.com/page.html', false), null);
  });

  test('ignores .js', () => {
    assert.equal(classifyDownload('https://example.com/app.js', false), null);
  });

  test('ignores .php', () => {
    assert.equal(classifyDownload('https://example.com/index.php', false), null);
  });

  test('ignores .css', () => {
    assert.equal(classifyDownload('https://example.com/style.css', false), null);
  });

  test('ignores .png', () => {
    assert.equal(classifyDownload('https://example.com/image.png', false), null);
  });

  test('ignores .jpg', () => {
    assert.equal(classifyDownload('https://example.com/photo.jpg', false), null);
  });

  test('ignores no extension', () => {
    assert.equal(classifyDownload('https://example.com/page', false), null);
  });
});

// --- Query string stripping ---

describe('download tracking query string handling', () => {
  test('strips query string from href', () => {
    const r = classifyDownload('https://example.com/report.pdf?token=abc123&user=test', false);
    assert.equal(r.href, 'https://example.com/report.pdf');
  });

  test('strips hash from href', () => {
    const r = classifyDownload('https://example.com/report.pdf#section', false);
    assert.equal(r.href, 'https://example.com/report.pdf');
  });

  test('preserves path in href', () => {
    const r = classifyDownload('https://cdn.example.com/assets/docs/report.pdf', false);
    assert.equal(r.href, 'https://cdn.example.com/assets/docs/report.pdf');
    assert.equal(r.filename, 'report.pdf');
  });
});

// --- Case insensitivity ---

describe('download tracking case insensitivity', () => {
  test('matches .PDF uppercase', () => {
    const r = classifyDownload('https://example.com/report.PDF', false);
    assert.equal(r.extension, 'pdf');
  });

  test('matches .Zip mixed case', () => {
    const r = classifyDownload('https://example.com/archive.Zip', false);
    assert.equal(r.extension, 'zip');
  });

  test('matches .DOCX all caps', () => {
    const r = classifyDownload('https://example.com/file.DOCX', false);
    assert.equal(r.extension, 'docx');
  });
});

// --- Skip conditions ---

describe('download tracking skip conditions', () => {
  test('skips mailto links', () => {
    assert.equal(classifyDownload('mailto:user@example.com', false), null);
  });

  test('skips tel links', () => {
    assert.equal(classifyDownload('tel:+1234567890', false), null);
  });

  test('skips javascript links', () => {
    assert.equal(classifyDownload('javascript:void(0)', false), null);
  });

  test('skips elements with data-aa-event', () => {
    assert.equal(classifyDownload('https://example.com/report.pdf', true), null);
  });

  test('skips empty href', () => {
    assert.equal(classifyDownload('', false), null);
  });

  test('skips null href', () => {
    assert.equal(classifyDownload(null, false), null);
  });
});

// --- Edge cases ---

describe('download tracking edge cases', () => {
  test('handles URL with port', () => {
    const r = classifyDownload('https://example.com:8080/file.pdf', false);
    assert.equal(r.extension, 'pdf');
    assert.equal(r.href, 'https://example.com:8080/file.pdf');
  });

  test('handles URL with encoded characters', () => {
    const r = classifyDownload('https://example.com/my%20report.pdf', false);
    assert.equal(r.extension, 'pdf');
  });

  test('handles root-level file', () => {
    const r = classifyDownload('https://example.com/report.pdf', false);
    assert.equal(r.filename, 'report.pdf');
  });
});

// --- Build output checks ---

describe('download tracking in built tracker', () => {
  test('built tracker.js contains $download event name', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('$download'), 'tracker.js should contain $download');
  });

  test('built tracker.js contains data-track-downloads attribute', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('data-track-downloads'), 'tracker.js should reference data-track-downloads');
  });

  test('built tracker.js contains extension regex', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'tracker.js'), 'utf-8');
    assert.ok(content.includes('pdf'), 'tracker.js should contain pdf extension');
    assert.ok(content.includes('xlsx'), 'tracker.js should contain xlsx extension');
  });
});
