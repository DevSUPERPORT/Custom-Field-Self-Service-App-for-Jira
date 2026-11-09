/**
 * Guard test: every literal passed to t() or tn() in the Custom UI has a German version with the same placeholders.
 *
 * @file        test/i18n.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Every literal passed to t() / tn() in the Custom UI needs an entry in i18n.de.js, with the same {placeholders}.
// Run: node --test test/i18n.test.mjs   (node test/i18n.test.mjs --missing prints what is missing)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../static/main/src/', import.meta.url));
const files = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(jsx?|mjs)$/.test(n) && !/i18n/.test(n) ? [p] : [];
});
// '...' or "..." string literals right after t( or as 2nd/3rd argument of tn(
const LIT = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"`;
const unq = (m) => (m[1] ?? m[2]).replace(/\\'/g, "'").replace(/\\"/g, '"');
export const keys = () => {
  const out = new Set();
  for (const f of files(SRC)) {
    const code = readFileSync(f, 'utf8');
    for (const m of code.matchAll(new RegExp(String.raw`\bt\(\s*(?:${LIT})`, 'g'))) out.add(unq(m));
    for (const m of code.matchAll(new RegExp(String.raw`\btn\(\s*[^,]+,\s*(?:${LIT})\s*,\s*(?:${LIT})`, 'g'))) {
      out.add(unq([null, m[1], m[2]]));
      out.add(unq([null, m[3], m[4]]));
    }
  }
  return [...out].sort();
};
const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

const DE = (await import(new URL('../static/main/src/i18n.de.js', import.meta.url))).default;

if (process.argv.includes('--missing')) {
  console.log(JSON.stringify(keys().filter((k) => DE[k] === undefined), null, 1));
} else {
  test('every shown text has a German version', () => {
    const missing = keys().filter((k) => DE[k] === undefined);
    assert.deepEqual(missing, []);
  });
  test('German texts keep the same placeholders', () => {
    const wrong = Object.entries(DE).filter(([en, de]) => holes(en) !== holes(de)).map(([en]) => en);
    assert.deepEqual(wrong, []);
  });
}
