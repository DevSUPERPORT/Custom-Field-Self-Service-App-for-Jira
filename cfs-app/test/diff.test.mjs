/**
 * Unit tests for the request picture: options before and after, the new field card, reuse spaces, bulk fields and the
 * masking of spaces a project admin may not see.
 *
 * @file        test/diff.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Run: node --test test/diff.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionsDiff, requestDiff, diffHeadline } from '../src/shared/diff.js';
import { computePlan } from '../src/shared/options.js';

const tree = (values) => values.map((v, i) => ({ key: `id:${i + 1}`, id: String(i + 1), value: v, disabled: false, isDefault: false, children: [] }));

test('options: every change is marked, new options appear, counts and work items add up', () => {
  const before = tree(['Red', 'Green', 'Blue']);
  before[0].isDefault = true;
  const edited = JSON.parse(JSON.stringify(before));
  edited[1].value = 'Lime';
  edited[2].disabled = true;
  edited[0].isDefault = false;
  edited[1].isDefault = true;
  edited.push({ key: 'new:1', value: 'Black', disabled: false, isDefault: false, children: [] });
  const plan = computePlan(before, edited);
  const d = optionsDiff(before, plan, { 2: 4, 3: 10 });
  assert.deepEqual(d.rows.map((r) => [r.value, r.state]), [['Red', 'same'], ['Lime', 'renamed'], ['Blue', 'retired'], ['Black', 'added']]);
  assert.equal(d.rows[1].old, 'Green');
  assert.equal(d.counts.added, 1);
  assert.equal(d.counts.retired, 1);
  assert.equal(d.workItems, 14);
  assert.deepEqual(d.defaultChange, { from: 'Red', to: 'Lime' });
  assert.ok(d.rows[0].wasDefault && d.rows[1].isDefault);
});

test('options: unknown usage gives no work-item total instead of a wrong one', () => {
  const before = tree(['A', 'B']);
  const edited = JSON.parse(JSON.stringify(before));
  edited[0].disabled = true;
  assert.equal(optionsDiff(before, computePlan(before, edited), null).workItems, null);
  const add = [...JSON.parse(JSON.stringify(before)), { key: 'new:1', value: 'C', disabled: false, children: [] }];
  assert.equal(optionsDiff(before, computePlan(before, add), null).workItems, 0, 'only additions touch no work item');
});

test('options: a new order is shown in the new order, children follow their parent', () => {
  const before = tree(['B', 'A']);
  before[0].children = [{ key: 'id:9', id: '9', value: 'b1', disabled: false }];
  const edited = JSON.parse(JSON.stringify(before)).reverse();
  edited[1].children.push({ key: 'new:2', value: 'b2', disabled: false });
  const d = optionsDiff(before, computePlan(before, edited));
  assert.deepEqual(d.rows.map((r) => at(r)), ['A', 'B', 'B > b1', 'B > b2']);
  assert.ok(d.reordered);
});
const at = (r) => (r.parent ? `${r.parent} > ${r.value}` : r.value);

test('request picture per kind, and other spaces are counted, not named, for project admins', () => {
  const field = requestDiff({ kind: 'field', projectKey: 'FSST', payload: { draft: { name: 'Region', typeKey: 'select', optionsText: 'North\nSouth', projectKeys: ['FSST', 'HR'] }, affected: ['FSST', 'HR'] }, rows: [] }, { typeLabel: () => 'Dropdown', visible: ['FSST'] });
  assert.equal(field.newField.type, 'Dropdown');
  assert.deepEqual(field.newField.options, ['North', 'South']);
  assert.deepEqual(field.spaces, ['FSST']);
  assert.equal(field.hiddenSpaces, 1);
  const reuse = requestDiff({ kind: 'reuse', projectKey: 'FSST', payload: { fieldName: 'Team', plan: { contextStep: { sharedWith: ['HR'] } }, affected: ['HR', 'FSST'] } });
  assert.deepEqual(reuse.reuse.added, ['FSST']);
  const bulk = requestDiff({ kind: 'bulk', projectKey: 'FSST', rows: [{ action: 'Bulk', option: 'Model', old: 'Vela', new: 'retired' }], briefing: ['2 field(s), 17 work item(s) affected, 0 default value(s) cleared.'], payload: { jobId: 'B1' } });
  assert.equal(bulk.bulk.fields.length, 1);
  assert.equal(bulk.workItems, 17);
  assert.match(diffHeadline(field), /new Dropdown with 2 options/);
});

test('undo of a bulk change: titled by what it undoes, with what goes back', () => {
  const d = requestDiff({ kind: 'bulkundo', projectKey: 'FSST', summary: 'Undo of a bulk change in FSST', rows: [{ action: 'Undo bulk change', option: 'Rename "A" to "B"', old: '', new: '1 field(s) back as before' }], payload: { jobId: 'B9', fieldName: '1 field', description: 'Undo: Rename "A" to "B"' } });
  assert.equal(d.field, 'Undo: Rename "A" to "B"');
  assert.equal(d.bulk.undo, true);
  assert.equal(d.bulk.back, '1 field(s) back as before');
});
