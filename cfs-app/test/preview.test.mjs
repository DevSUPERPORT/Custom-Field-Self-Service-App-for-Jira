/**
 * Guard test for "view as project admin": it only ever lowers the role, and allows reading calls only.
 *
 * @file        test/preview.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Run: node --test test/preview.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { previewRole, previewRefusal, PREVIEW_READS } from '../src/shared/preview.js';

const resolverNames = () => [...readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').matchAll(/resolver\.define\('([A-Za-z]+)'/g)].map((m) => m[1]);

test('the preview lowers a Jira administrator to project admin, and never raises anyone', () => {
  assert.equal(previewRole('jira-admin', 'project-admin'), 'project-admin');
  assert.equal(previewRole('project-admin', 'project-admin'), 'project-admin');
  assert.equal(previewRole('none', 'project-admin'), 'none');
  assert.equal(previewRole('project-admin', 'jira-admin'), 'project-admin');
  assert.equal(previewRole('jira-admin', undefined), 'jira-admin');
  assert.equal(previewRole('jira-admin', 'none'), 'jira-admin');
});

test('in a preview only reading calls run; outside a preview nothing is refused', () => {
  ['applyOptions', 'requestField', 'decide', 'prepareDecide', 'withdraw', 'bundle', 'reuse', 'undo', 'healthAddScreens', 'healthTakeOut', 'tourSeen', 'saveDraft', 'todoAddScreens']
    .forEach((n) => assert.ok(previewRefusal('jira-admin', 'project-admin', n), `${n} must be refused in a preview`));
  ['boot', 'overview', 'health', 'audit', 'inbox'].forEach((n) => assert.equal(previewRefusal('jira-admin', 'project-admin', n), null, n));
  ['applyOptions', 'decide'].forEach((n) => assert.equal(previewRefusal('jira-admin', undefined, n), null));
  // a project admin asking for the preview is simply themselves
  assert.equal(previewRefusal('project-admin', 'project-admin', 'applyOptions'), null);
});

test('every reading call of the preview is a real resolver, and none of them changes anything', () => {
  const names = new Set(resolverNames());
  [...PREVIEW_READS].forEach((n) => assert.ok(names.has(n), `${n} is not a resolver`));
  const writes = ['applyOptions', 'undo', 'adminFieldUpdate', 'adminFieldScreens', 'adminFieldProjects', 'withdraw', 'todoAddScreens', 'todoDismiss', 'reuse', 'tourSeen', 'requestField',
    'bulkScan', 'bulkStart', 'bulkRun', 'bulkUndo', 'prepareDecide', 'decide', 'saveDraft', 'convertText', 'bundle', 'healthAddScreens', 'healthTakeOut', 'driftCheckNow', 'enableHere'];
  writes.forEach((n) => assert.ok(!PREVIEW_READS.has(n), `${n} changes things and must not run in a preview`));
});
