import { readFileSync, writeFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const src = readFileSync(new URL('../src/tracker.src.js', import.meta.url), 'utf8');

const { code } = transformSync(src, {
  minify: true,
  target: 'es2015',
  loader: 'js',
});

const minified = code.trimEnd();

// Escape for template literal: backticks, backslashes, and ${
const escaped = minified
  .replaceAll('\\', '\\\\')
  .replaceAll('`', '\\`')
  .replaceAll('${', '\\${');

const output = `// AUTO-GENERATED — edit tracker.src.js instead
export const TRACKER_JS = \`${escaped}\`;
`;

writeFileSync(new URL('../src/tracker.js', import.meta.url), output);

console.log(`tracker.js built — ${minified.length} bytes minified (was ${src.length} source)`);
