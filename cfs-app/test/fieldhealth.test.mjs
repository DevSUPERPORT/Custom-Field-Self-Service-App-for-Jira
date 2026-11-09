/**
 * Field health findings: "Unused" comes from the work items themselves (no work item on the site has a value), not
 * only from Jira's last-used date, which Jira does not track for most fields; the clean-up suggestions are built from
 * the findings, so "need a look" fields always come with suggestions. Tester report of 2026-11-06: Unused showed 0
 * although 138 of 176 fields had no value, and Suggestions showed 0 next to 124 findings.
 *
 * @file        test/fieldhealth.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-06
 * @updated     2026-11-06
 */

// Run: node --test test/fieldhealth.test.mjs
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { healthFlags, cleanupSuggestions, countFresh, relevantToProject, COUNT_TTL, COUNT_RETRY, COUNT_VERSION, STALE_DAYS } from '../src/shared/health.js';

register('./support/forge-loader.mjs', import.meta.url);
const { valueCounts, fieldHealth } = await import('../src/insights.js');

const NOW = Date.parse('2026-11-06T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const codes = (r) => r.flags.map((f) => f.code).sort();

afterEach(() => { delete globalThis.__fakeJira; delete globalThis.__fakeKvs; });

test('unused: no value on any work item counts as unused, whatever Jira says about tracking', () => {
  for (const type of ['NOT_TRACKED', 'NO_INFORMATION', 'TRACKED']) {
    const { flags } = healthFlags({ lastUsed: { type }, screensCount: 2 }, 0, NOW);
    assert.deepEqual(flags.map((f) => f.code), ['never'], type);
    assert.equal(flags[0].text, 'No value on any work item');
  }
});

test('unused: values on work items are never "unused"; an old tracked date makes the field stale', () => {
  assert.deepEqual(healthFlags({ lastUsed: { type: 'NO_INFORMATION' }, screensCount: 1 }, 12, NOW).flags, []);
  const stale = healthFlags({ lastUsed: { type: 'TRACKED', value: daysAgo(STALE_DAYS + 20) }, screensCount: 1 }, 3, NOW);
  assert.deepEqual(stale.flags.map((f) => f.code), ['stale']);
  assert.equal(stale.flags[0].days, STALE_DAYS + 20);
  assert.equal(stale.lastUsed, daysAgo(STALE_DAYS + 20));
  assert.deepEqual(healthFlags({ lastUsed: { type: 'TRACKED', value: daysAgo(10) }, screensCount: 1 }, 3, NOW).flags, []);
});

test('unused: a field Jira cannot count (Approvals, development) is unknown, never unused', () => {
  assert.deepEqual(healthFlags({ lastUsed: { type: 'NO_INFORMATION' }, screensCount: 1 }, null, NOW).flags, []);
  // Without a count, Jira's own "tracked and never used" still counts.
  assert.deepEqual(healthFlags({ lastUsed: { type: 'TRACKED' }, screensCount: 1 }, null, NOW).flags.map((f) => f.code), ['never']);
});

test('on no screen is found next to the other findings', () => {
  assert.deepEqual(healthFlags({ lastUsed: { type: 'NOT_TRACKED' }, screensCount: 0 }, 0, NOW).flags.map((f) => f.code), ['never', 'noscreen']);
});

const row = (id, flags, values = 0) => ({ id, values, flags: flags.map((code) => ({ code })) });

test('suggestions: every finding leads to a suggestion, most urgent first', () => {
  const rows = [
    row('a', ['noscreen'], 40), // values nobody can see
    row('b', ['never', 'noscreen']), // retire
    row('c', ['never']), // on screens, never filled in
    row('d', ['duplicate'], 5),
    row('e', ['stale'], 2),
    row('f', [], 9), // healthy
  ];
  const s = cleanupSuggestions(rows);
  assert.deepEqual(s.map((x) => x.kind), ['hidden', 'retire', 'empty', 'duplicate', 'stale']);
  assert.deepEqual(s.map((x) => x.fieldIds), [['a'], ['b'], ['c'], ['d'], ['e']]);
  assert.ok(!s.some((x) => x.fieldIds.includes('f')));
});

test('suggestions: none for healthy fields; a field on no screen with an unknown count is not "hidden values"', () => {
  assert.deepEqual(cleanupSuggestions([row('f', [], 9)]), []);
  assert.deepEqual(cleanupSuggestions([row('g', ['noscreen'], null)]), []);
});

test('suggestions: with the tester\'s numbers, Suggestions is no longer 0', () => {
  // 124 need a look, 40 duplicates, 106 on no screen, 138 without values (of 176).
  const rows = Array.from({ length: 176 }, (_, i) => {
    const f = [];
    if (i < 138) f.push('never');
    if (i < 106) f.push('noscreen');
    if (i >= 130 && i < 170) f.push('duplicate');
    return row(`cf${i}`, f, i < 138 ? 0 : 7);
  });
  const s = cleanupSuggestions(rows);
  assert.ok(s.length >= 3);
  assert.equal(s.find((x) => x.kind === 'retire').fieldIds.length, 106);
  assert.equal(s.find((x) => x.kind === 'empty').fieldIds.length, 32);
  assert.equal(s.find((x) => x.kind === 'duplicate').fieldIds.length, 40);
});

test('counts: a count is reused for six hours, a failed one is retried after ten minutes', () => {
  const v = COUNT_VERSION;
  assert.equal(countFresh({ v, n: 3, at: NOW - COUNT_TTL + 1000 }, NOW), true);
  assert.equal(countFresh({ v, n: 3, at: NOW - COUNT_TTL - 1000 }, NOW), false);
  assert.equal(countFresh({ v, n: null, at: NOW - COUNT_RETRY - 1000 }, NOW), false);
  assert.equal(countFresh(undefined, NOW), false);
  // Counts stored before the last activity was kept are counted again.
  assert.equal(countFresh({ n: 3, at: NOW }, NOW), false);
});

test('last used: when Jira tracks nothing, the last update of a work item with a value is used (tester, 2026-11-09)', () => {
  // cf[10096] "Finance Model": 87 work items with a value, Jira lastUsed NO_INFORMATION.
  const r = healthFlags({ lastUsed: { type: 'NO_INFORMATION' }, screensCount: 0 }, 87, NOW, { lastActivity: daysAgo(3) });
  assert.equal(r.lastUsed, daysAgo(3));
  assert.deepEqual(r.flags.map((f) => f.code), ['noscreen']);
  // Jira's own date wins when it has one.
  assert.equal(healthFlags({ lastUsed: { type: 'TRACKED', value: daysAgo(1) }, screensCount: 1 }, 5, NOW, { lastActivity: daysAgo(9) }).lastUsed, daysAgo(1));
  // No work item updated for half a year: stale, also without Jira tracking.
  const old = healthFlags({ lastUsed: { type: 'NOT_TRACKED' }, screensCount: 1 }, 4, NOW, { lastActivity: daysAgo(STALE_DAYS + 5) });
  assert.deepEqual(old.flags.map((f) => f.code), ['stale']);
  // A field without values has no last use, whatever an old record says.
  assert.equal(healthFlags({ lastUsed: { type: 'NO_INFORMATION' }, screensCount: 1 }, 0, NOW, { lastActivity: daysAgo(2) }).lastUsed, null);
});

// Jira answering like a real test site: approximate-count per field; "Approvals" can't be counted (400 → offline here).
const jira = (counts, calls) => (who, path, opts) => {
  if (path.includes('/search/approximate-count')) {
    const id = /cf\[(\d+)\]/.exec(JSON.parse(opts.body).jql)[1];
    calls.push(id);
    return counts[id] === undefined ? undefined : { count: counts[id] };
  }
  if (path.includes('/search/jql')) return { issues: [{ key: 'FSST-1', fields: { updated: '2026-11-06T14:34:08.501+0200' } }] };
  return undefined;
};

test('value counts: counted once, stored, read from storage the next time', async () => {
  globalThis.__fakeKvs = new Map();
  const calls = [];
  globalThis.__fakeJira = jira({ 1: 0, 2: 14 }, calls);
  const first = await valueCounts(['customfield_1', 'customfield_2', 'customfield_3']);
  assert.deepEqual(first.counts, { customfield_1: 0, customfield_2: 14, customfield_3: null });
  assert.deepEqual(first.lasts, { customfield_1: null, customfield_2: '2026-11-06T14:34:08.501+0200', customfield_3: null }, 'last activity only for fields with values');
  assert.equal(first.pending, 0);
  assert.deepEqual(calls.sort(), ['1', '2', '3']);
  const again = await valueCounts(['customfield_1', 'customfield_2', 'customfield_3']);
  assert.deepEqual(again.counts, first.counts);
  assert.equal(calls.length, 3, 'nothing counted twice within the cache time');
});

test('value counts: when the time budget runs out, the rest is reported as pending', async () => {
  globalThis.__fakeKvs = new Map();
  globalThis.__fakeJira = jira({ 1: 1, 2: 2 }, []);
  const r = await valueCounts(['customfield_1', 'customfield_2'], { budgetMs: -1 });
  assert.equal(r.pending, 2);
  assert.deepEqual(r.counts, { customfield_1: null, customfield_2: null });
});

test('project scope: own and shared fields always; global fields only when the space uses them; others never', () => {
  assert.equal(relevantToProject('project'), true);
  assert.equal(relevantToProject('shared'), true);
  assert.equal(relevantToProject('global', { onScreen: true, values: 0 }), true);
  assert.equal(relevantToProject('global', { onScreen: false, values: 3 }), true);
  assert.equal(relevantToProject('global', { onScreen: false, values: 0 }), false);
  assert.equal(relevantToProject('global', { onScreen: false, values: null }), false);
  assert.equal(relevantToProject(undefined, { onScreen: true, values: 9 }), false, 'a field the space does not see');
});

test('project scope: findings speak about the space', () => {
  const { flags } = healthFlags({ lastUsed: { type: 'NO_INFORMATION' }, screensCount: 5 }, 0, NOW, { scope: 'project', onScreen: false });
  assert.deepEqual(flags.map((f) => [f.code, f.text]), [['never', 'No value on any work item in this space'], ['noscreen', "Not on this space's screens"]]);
  // On another space's screens (screensCount 5) does not count as on this space's screens, and the other way round.
  assert.deepEqual(healthFlags({ screensCount: 0 }, 4, NOW, { scope: 'project', onScreen: true }).flags, []);
});

// A test site: FSST's own field, a shared one, two global ones (one used in FSST, one not) and a field
// of another space only.
const SITE = [
  { id: 'customfield_1', name: 'Release Train', schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' }, lastUsed: { type: 'NO_INFORMATION' }, screensCount: 0, contextsCount: 1 },
  { id: 'customfield_2', name: 'Shared Region', schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' }, lastUsed: { type: 'NO_INFORMATION' }, screensCount: 3, contextsCount: 1 },
  { id: 'customfield_3', name: 'Global Used Here', schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' }, lastUsed: { type: 'NOT_TRACKED' }, screensCount: 9, contextsCount: 1 },
  { id: 'customfield_4', name: 'Global Not Here', schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' }, lastUsed: { type: 'NOT_TRACKED' }, screensCount: 2, contextsCount: 1 },
  { id: 'customfield_5', name: 'Release Trains', schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' }, lastUsed: { type: 'NO_INFORMATION' }, screensCount: 0, contextsCount: 1 },
  { id: 'customfield_9', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' }, isLocked: true, lastUsed: { type: 'TRACKED', value: daysAgo(1) }, screensCount: 4, contextsCount: 1 },
];
const OVERVIEW = [{ id: 'customfield_1', scope: 'project' }, { id: 'customfield_2', scope: 'shared' }, { id: 'customfield_3', scope: 'global' }, { id: 'customfield_4', scope: 'global' }];
const siteJira = (siteCounts, projectCounts, jqls) => (who, path, opts) => {
  if (path.includes('/field/search')) return { values: SITE, isLast: true };
  if (path.includes('/search/approximate-count')) {
    const jql = JSON.parse(opts.body).jql;
    jqls.push(jql);
    const id = /cf\[(\d+)\]/.exec(jql)[1];
    return { count: (jql.startsWith('project = "FSST"') ? projectCounts : siteCounts)[id] ?? 0 };
  }
  return undefined;
};

test('project administrator: only the fields FSST uses, counted in FSST, nothing about other spaces', async () => {
  globalThis.__fakeKvs = new Map();
  const jqls = [];
  globalThis.__fakeJira = siteJira({ 1: 0, 2: 50, 3: 900, 4: 300, 5: 0 }, { 1: 0, 2: 0, 3: 12, 4: 0 }, jqls);
  const h = await fieldHealth('10001', { project: { key: 'FSST', fields: OVERVIEW, onScreens: new Set(['customfield_2']) } });
  assert.equal(h.scope, 'project');
  assert.deepEqual(h.rows.map((r) => r.id).sort(), ['customfield_1', 'customfield_2', 'customfield_3']);
  assert.equal(h.siteCustomFields, undefined, 'no site totals for project admins');
  assert.ok(jqls.every((q) => q.startsWith('project = "FSST" AND ')), 'only this space is counted');
  const by = Object.fromEntries(h.rows.map((r) => [r.id, r]));
  assert.equal(by.customfield_2.values, 0, 'values elsewhere are not counted as used here');
  assert.deepEqual(codes(by.customfield_2), ['never']);
  assert.deepEqual(codes(by.customfield_3), ['noscreen'], 'global field used here but not on this space\'s screens');
  assert.equal(by.customfield_3.contextScope, 'global');
  // "Release Train" and "Release Trains" look alike, but the other space's field is not compared for FSST.
  assert.ok(!by.customfield_1.flags.some((f) => f.code === 'duplicate'));
});

test('Jira administrator: every changeable field of the site, counted site-wide, duplicates across the site', async () => {
  globalThis.__fakeKvs = new Map();
  const jqls = [];
  globalThis.__fakeJira = siteJira({ 1: 0, 2: 50, 3: 900, 4: 300, 5: 0 }, {}, jqls);
  const h = await fieldHealth('10001');
  assert.equal(h.scope, 'site');
  assert.deepEqual(h.rows.map((r) => r.id).sort(), ['customfield_1', 'customfield_2', 'customfield_3', 'customfield_4', 'customfield_5']);
  assert.equal(h.siteCustomFields, 6);
  assert.equal(h.lockedFields, 1);
  assert.ok(jqls.every((q) => !q.includes('project =')));
  const by = Object.fromEntries(h.rows.map((r) => [r.id, r]));
  assert.ok(by.customfield_1.flags.some((f) => f.code === 'duplicate' && f.fieldId === 'customfield_5'));
  assert.deepEqual(codes(by.customfield_4), []);
});

test('field health end to end: NO_INFORMATION fields without values are unused, the page gets suggestions', async () => {
  globalThis.__fakeKvs = new Map();
  const fields = [
    { id: 'customfield_1', name: 'Empty and hidden', schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' }, lastUsed: { type: 'NO_INFORMATION' }, screensCount: 0, contextsCount: 1 },
    { id: 'customfield_2', name: 'Used', schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' }, lastUsed: { type: 'NOT_TRACKED' }, screensCount: 3, contextsCount: 1 },
    { id: 'customfield_3', name: 'Empty on screens', schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' }, lastUsed: { type: 'NOT_TRACKED' }, screensCount: 2, contextsCount: 1 },
  ];
  const counts = { 1: 0, 2: 25, 3: 0 };
  globalThis.__fakeJira = (who, path, opts) => {
    if (path.includes('/field/search')) return { values: fields, isLast: true };
    if (path.includes('/config/fieldschemes')) return { values: [] };
    return jira(counts, [])(who, path, opts);
  };
  const h = await fieldHealth('10000');
  const by = Object.fromEntries(h.rows.map((r) => [r.id, r]));
  assert.deepEqual(codes(by.customfield_1), ['never', 'noscreen']);
  assert.deepEqual(codes(by.customfield_2), []);
  assert.deepEqual(codes(by.customfield_3), ['never']);
  assert.equal(by.customfield_2.values, 25);
  assert.equal(h.countsPending, 0);
  assert.deepEqual(cleanupSuggestions(h.rows).map((s) => s.kind), ['retire', 'empty']);
});

// Tester, 2026-11-09: cf[10119] has a global context and an FSST context. FSST must use (and edit) its own context,
// never the global one other spaces use.
test('context: a space with its own context uses it, even when the field also has a global context', async () => {
  const { resolveContext } = await import('../src/fields.js');
  const ctxs = [{ id: '10293', isGlobalContext: true }, { id: '10294', isGlobalContext: false }];
  const mappings = [{ contextId: '10293', isGlobalContext: true }, { contextId: '10294', projectId: '10001' }];
  assert.equal(resolveContext(ctxs, mappings, '10001').id, '10294', 'FSST: its own context');
  assert.equal(resolveContext(ctxs, mappings, '10002').id, '10293', 'another space: the global context');
  assert.equal(resolveContext([ctxs[1]], [mappings[1]], '10002'), null, 'a space without any context: none');
});
