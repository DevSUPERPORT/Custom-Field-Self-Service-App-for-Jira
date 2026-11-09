/**
 * Guard test: the app ships without example or test-data names in the code people see, the agent instructions or the
 * manifest.
 *
 * @file        test/nosample.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Run: node --test test/nosample.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FORBIDDEN = /aurora|nova classic|showroom|aurora-demo|\bFSST\b|superportdev|superport1\.atlassian/i;
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  if (statSync(p).isDirectory()) return ['node_modules', 'build', 'assets'].includes(n) ? [] : walk(p);
  return /\.(js|jsx|mjs|txt|yml|html)$/.test(n) ? [p] : [];
});

test('no test-data names in the app, its UI, the agent or the manifest', () => {
  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'static', 'main', 'src')), join(ROOT, 'agent', 'prompt.txt'), join(ROOT, 'manifest.yml')];
  assert.ok(files.length > 20, `only ${files.length} files found`);
  const hits = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l]).filter(([, , l]) => FORBIDDEN.test(l)));
  assert.deepEqual(hits.map(([f, n, l]) => `${f.slice(ROOT.length)}:${n}: ${l.trim().slice(0, 80)}`), []);
});
