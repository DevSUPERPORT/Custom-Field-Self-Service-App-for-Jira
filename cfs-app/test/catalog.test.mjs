/**
 * Unit tests for the project option catalog: building it from real option trees, the picker choices and the summary
 * shown before a preview, with neutral names only.
 *
 * @file        test/catalog.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Run: node --test test/catalog.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, optionChoices, replacementChoices, fieldChoices, summarise, findValue } from '../src/shared/catalog.js';

const opt = (v, o = 0, d = 0, c = []) => ({ v, o, d, c });
const FIELDS = [
  { id: 'cf_1', name: 'Product', type: 'Select list (single)', editable: 'direct', scope: 'project', sharedWith: [] },
  { id: 'cf_2', name: 'Products used', type: 'Select list (multiple)', editable: 'direct', scope: 'project', sharedWith: [] },
  { id: 'cf_3', name: 'Product and variant', type: 'Cascading select', cascading: true, editable: 'approval', scope: 'shared', sharedWith: [{ key: 'P1' }, { key: 'P2' }] },
  { id: 'cf_4', name: 'Global product', type: 'Select list (single)', editable: 'readonly', scope: 'global', sharedWith: [] },
];
const TREES = {
  cf_1: [opt('Alpha', 0, 1), opt('Beta'), opt('Gamma')],
  cf_2: [opt('Alpha', 1), opt('Beta'), opt('Delta')],
  cf_3: [opt('Alpha', 0, 0, [opt('Basic'), opt('Plus', 0, 1)]), opt('Beta', 0, 0, [opt('Basic')])],
  cf_4: [opt('Alpha'), opt('Beta')],
};
const cat = buildCatalog(FIELDS, TREES);

test('catalog: where each value lives (active, retired, default, sub-option), case-insensitive', () => {
  const a = findValue(cat, ' alpha ');
  assert.deepEqual([a.f, a.live, a.off, a.def], [[0, 1, 2, 3], [0, 2, 3], [1], [0]]);
  assert.deepEqual(findValue(cat, 'Basic').sub, [2]);
  assert.deepEqual(findValue(cat, 'Plus').def, [2]);
  assert.deepEqual(cat.fields[2].sharedWith, ['P1', 'P2']);
  assert.equal(cat.values[0].v, 'Alpha', 'most widely used first');
});

test('option choices depend on the operation', () => {
  assert.ok(optionChoices(cat, 'restore').every((x) => x.label === 'Alpha'), 'only retired somewhere');
  assert.match(optionChoices(cat, 'retire').find((x) => x.label === 'Alpha').meta, /active in 3 fields · retired in 1 · default in 1/);
  assert.equal(optionChoices(cat, 'rename').length, cat.values.length);
});

test('replacement choices rank options the same fields already have', () => {
  const r = replacementChoices(cat, 'Alpha');
  assert.equal(r[0].label, 'Beta');
  assert.match(r[0].meta, /in all 4 fields/);
  assert.ok(!r.some((x) => x.label === 'Alpha'));
  assert.match(r.find((x) => x.label === 'Delta').meta, /in 1 of the 4 fields/);
});

test('field choices: only fields that have the option; global fields locked', () => {
  const f = fieldChoices(cat, 'Gamma');
  assert.deepEqual(f.map((x) => x.label), ['Product']);
  const all = fieldChoices(cat, 'Alpha');
  assert.equal(all.find((x) => x.value === 'cf_4').disabled, true);
  assert.match(all.find((x) => x.value === 'cf_2').meta, /retired/);
  assert.equal(fieldChoices(cat, '').length, 4, 'no option yet = every option field');
});

test('summary: retire, with defaults, already retired, locked and shared fields', () => {
  const s = summarise(cat, { op: 'retire', value: 'Alpha' });
  assert.ok(s.ok);
  assert.match(s.lines[0].text, /in 2 fields/, "the global field is not counted");
  assert.ok(s.lines.some((l) => /default value in 1 field/.test(l.text)));
  assert.ok(s.lines.some((l) => /Already retired in 1 field/.test(l.text)));
  assert.ok(s.lines.some((l) => /1 global field also has it/.test(l.text)));
  assert.ok(s.lines.some((l) => /shared with other spaces/.test(l.text)));
  assert.deepEqual(s.scope, [0, 2], 'global field left out');
  assert.deepEqual(summarise(cat, { op: 'retire', value: 'Alpha', fieldIds: ['cf_1'] }).scope, [0]);
});

test('options only in global fields are locked; the summary says so plainly', () => {
  const locked = buildCatalog(FIELDS, { cf_4: [opt('Omega')] });
  const o = optionChoices(locked, 'retire')[0];
  assert.equal(o.disabled, true);
  assert.match(o.disabledNote, /only Jira administrators/);
  const s = summarise(locked, { op: 'retire', value: 'Omega' });
  assert.equal(s.ok, false);
  assert.equal(s.lines.length, 1);
  assert.match(s.lines[0].text, /only in global field here/);
});

test('summary: replace lists fields lacking the replacement unless it is added there', () => {
  const s = summarise(cat, { op: 'replace', value: 'Alpha', newValue: 'Delta', retireOld: true });
  assert.ok(s.lines.some((l) => l.tone === 'warning' && /don't have "Delta" and are skipped/.test(l.text)));
  assert.deepEqual(s.scope, [1]);
  const add = summarise(cat, { op: 'replace', value: 'Alpha', newValue: 'Delta', addMissing: true, retireOld: true });
  assert.ok(add.lines.some((l) => /is added to 3 fields/.test(l.text)));
  assert.ok(add.lines.some((l) => /default moves to "Delta"/.test(l.text)));
});

test('summary: rename clash, add next to, restore, nothing chosen yet', () => {
  assert.ok(summarise(cat, { op: 'rename', value: 'Alpha', newValue: 'beta' }).lines.some((l) => /already exists in 4 fields/.test(l.text)));
  const add = summarise(cat, { op: 'add', value: 'Gamma', like: 'Beta', position: 'after' });
  assert.match(add.lines[0].text, /Adds "Gamma" to 2 fields that have "Beta", right after it/);
  assert.ok(add.lines.some((l) => /1 field already has it and stays as it is/.test(l.text)));
  assert.match(summarise(cat, { op: 'restore', value: 'Alpha' }).lines[0].text, /selectable again in 1 field/);
  assert.equal(summarise(cat, { op: 'retire', value: '' }).ok, false);
});
