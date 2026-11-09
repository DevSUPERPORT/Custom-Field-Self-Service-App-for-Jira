/**
 * Unit tests for the Marketplace license gate: only an inactive license blocks; no license data never does.
 *
 * @file        test/license.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-06
 * @updated     2026-11-06
 */

// Run: node --test test/license.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { licenseInactive, licenseRefusal } from '../src/license.js';

test('an inactive license blocks, an active or missing one does not', () => {
  assert.equal(licenseInactive({ license: { isActive: false } }), true);
  assert.equal(licenseInactive({ license: { isActive: true } }), false);
  // Atlassian's current field is `active` (isActive is deprecated): an expired license must still block.
  assert.equal(licenseInactive({ license: { active: false } }), true);
  assert.equal(licenseInactive({ license: { active: true } }), false);
  assert.equal(licenseInactive({ license: { active: true, isActive: true } }), false);
  assert.equal(licenseInactive({}), false, 'private install, licensing off');
  assert.equal(licenseInactive(undefined), false);
  const r = licenseRefusal({ license: { isActive: false } });
  assert.ok(r.error && r.unlicensed && r.nothingChanged);
});

test('every project page resolver and every Rovo action passes the license gate', () => {
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(index.slice(index.indexOf('const handle = '), index.indexOf('const handle = ') + 300), /licenseRefusal\(req\.context\)/);
  const actions = readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  assert.match(actions.slice(actions.indexOf('const run = '), actions.indexOf('const run = ') + 200), /licenseRefusal\(payload\?\.context\)/);
});
