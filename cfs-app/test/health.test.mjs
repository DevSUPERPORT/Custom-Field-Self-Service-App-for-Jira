/**
 * Tests for field health's screen targets (add to screens, take out of use) and the nightly drift check's candidates.
 *
 * @file        test/health.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Run: node --test test/health.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownScreenTargets, removalTargets, schemesForIssueTypes } from '../src/shared/screens.js';
import { driftCandidates } from '../src/shared/optionops.js';

const SCREENS = [
  { screenId: 10, exclusive: true },
  { screenId: 11, exclusive: true },
  { screenId: 12, exclusive: false },
];

test('screen targets: every own screen when nothing is ticked', () => {
  assert.deepEqual(ownScreenTargets(SCREENS).map((s) => s.screenId), [10, 11]);
  assert.deepEqual(ownScreenTargets(SCREENS, []).map((s) => s.screenId), [10, 11]);
});

test('screen targets: only the ticked own screens, IDs as strings or numbers', () => {
  assert.deepEqual(ownScreenTargets(SCREENS, ['11']).map((s) => s.screenId), [11]);
  assert.deepEqual(ownScreenTargets(SCREENS, [10]).map((s) => s.screenId), [10]);
});

test('screen targets: a shared screen is never a target, even when its ID is sent', () => {
  assert.deepEqual(ownScreenTargets(SCREENS, ['12']), []);
  assert.deepEqual(ownScreenTargets(SCREENS, ['12', '10']).map((s) => s.screenId), [10]);
});

const FIELDS = [
  { id: 'customfield_1', hasOptions: true, scope: 'project' },
  { id: 'customfield_2', hasOptions: true, scope: 'shared' },
  { id: 'customfield_3', hasOptions: true, scope: 'global' },
  { id: 'customfield_4', hasOptions: false, scope: 'project' },
  { id: 'customfield_5', hasOptions: true, scope: 'project', error: 'could not read' },
  { id: 'customfield_9', hasOptions: true, scope: 'project' },
];

test('drift check: own and shared option fields that could be read', () => {
  assert.deepEqual(driftCandidates(FIELDS).map((f) => f.id), ['customfield_1', 'customfield_2', 'customfield_9']);
});

test('drift check: the self-test field is skipped (it was reported as drift every night)', () => {
  assert.deepEqual(driftCandidates(FIELDS, ['customfield_9']).map((f) => f.id), ['customfield_1', 'customfield_2']);
  // no self-test field found on the site
  assert.deepEqual(driftCandidates(FIELDS, [undefined, null, '']).map((f) => f.id), ['customfield_1', 'customfield_2', 'customfield_9']);
});

const CUR = [
  { id: '10', tabId: '1', name: 'Own create' },
  { id: '12', tabId: '3', name: 'Shared with other spaces' },
  { id: '13', tabId: null, name: 'No tab info' },
];

test('take out of use: a field only this space uses leaves every screen', () => {
  const r = removalTargets({ contexts: [{ global: false, projects: [{ id: '100' }] }], projectId: 100, current: CUR, own: SCREENS });
  assert.equal(r.mode, 'everywhere');
  assert.deepEqual(r.remove.map((s) => s.id), ['10', '12']);
  assert.deepEqual(r.keep, []);
});

test('take out of use: a field other spaces use too leaves only this space\'s own screens', () => {
  const shared = [{ global: false, projects: [{ id: '100' }, { id: '200' }] }];
  const r = removalTargets({ contexts: shared, projectId: '100', current: CUR, own: SCREENS });
  assert.equal(r.mode, 'this-space');
  assert.deepEqual(r.remove.map((s) => s.id), ['10']);
  assert.deepEqual(r.keep.map((s) => s.id), ['12']);
  // a second context for another space, or a global context, counts as "used elsewhere" too
  assert.equal(removalTargets({ contexts: [{ global: false, projects: [{ id: '100' }] }, { global: false, projects: [{ id: '300' }] }], projectId: '100', current: CUR, own: SCREENS }).mode, 'this-space');
  assert.equal(removalTargets({ contexts: [{ global: true, projects: [] }], projectId: '100', current: CUR, own: SCREENS }).mode, 'this-space');
  // no context information at all: never everywhere
  assert.equal(removalTargets({ contexts: [], projectId: '100', current: CUR, own: SCREENS }).mode, 'this-space');
});

// FSST-like: Bug has its own screen scheme (20), everything else falls back to the default (10).
const MAP = [{ issueTypeId: 'default', screenSchemeId: 10 }, { issueTypeId: '10004', screenSchemeId: 20 }];

test('screens per issue type: Bug only shows the Bug screen scheme, never the default one too', () => {
  assert.deepEqual([...schemesForIssueTypes(MAP, ['10004'], ['10001', '10004'])], ['20']);
});

test('screens per issue type: types without an own mapping use the default scheme', () => {
  assert.deepEqual([...schemesForIssueTypes(MAP, ['10001'], ['10001', '10004'])], ['10']);
  assert.deepEqual([...schemesForIssueTypes(MAP, ['10001', '10004'], [])].sort(), ['10', '20']);
});

test('screens per issue type: all issue types of the space, and every scheme when the types are unknown', () => {
  assert.deepEqual([...schemesForIssueTypes(MAP, [], ['10004'])], ['20']);
  assert.deepEqual([...schemesForIssueTypes(MAP, [], ['10001', '10004'])].sort(), ['10', '20']);
  assert.deepEqual([...schemesForIssueTypes(MAP, [], [])].sort(), ['10', '20']);
});
