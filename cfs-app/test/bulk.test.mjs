/**
 * Unit tests for bulk changes: input, matching, the retire, restore, rename, add and replace plans, work-item values,
 * undo and totals.
 *
 * @file        test/bulk.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Run: node --test test/bulk.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseBulk, findMatches, planField, undoTarget, totals, replaceMap, replacedValue, writeForm, sameValue, valueKind } from '../src/shared/bulkops.js';

const flat = (values, extra = {}) => values.map((v, i) => ({ key: `id:${i + 1}`, id: String(i + 1), value: v, disabled: false, isDefault: false, children: [], ...(extra[v] || {}) }));
const MODELS = ['Vela', 'Sprint', 'Nova Classic', 'Atlas'];

test('input validation', () => {
  assert.ok(normaliseBulk({ op: 'retire', value: '' }).errors.length);
  assert.ok(normaliseBulk({ op: 'rename', value: 'A' }).errors.length, 'rename needs a new name');
  assert.ok(normaliseBulk({ op: 'add', value: 'X' }).errors.length, 'add needs like or picked fields');
  assert.equal(normaliseBulk({ op: 'retire', value: '  Nova   Classic ' }).bulk.value, 'Nova Classic');
});

test('matching is case and space insensitive, and finds cascading children', () => {
  const tree = flat(MODELS);
  tree[0].children = [{ key: 'id:9', id: '9', value: 'nova classic', disabled: false }];
  assert.deepEqual(findMatches(tree, 'NOVA  classic').map((h) => h.ref), ['Vela > nova classic', 'Nova Classic']);
});

test('retire disables the option, its trims, and clears it as default', () => {
  const tree = flat(MODELS, { 'Nova Classic': { isDefault: true } });
  tree[2].children = [{ key: 'id:20', id: '20', value: 'Base', disabled: false }, { key: 'id:21', id: '21', value: 'Sport', disabled: false }];
  const { bulk } = normaliseBulk({ op: 'retire', value: 'Nova Classic' });
  const r = planField(tree, bulk, { typeKey: 'cascadingselect' });
  assert.equal(r.action, 'change');
  assert.deepEqual(r.plan.disables.map((d) => d.value).sort(), ['Base', 'Nova Classic', 'Sport']);
  assert.ok(r.defaultCleared && r.plan.defaultChange && r.plan.defaultChange.toKey === null);
});

test('retire finishes the trims of a model that was retired earlier without them', () => {
  const tree = flat(MODELS, { 'Nova Classic': { disabled: true } });
  tree[2].children = [{ key: 'id:20', id: '20', value: 'Base', disabled: true }, { key: 'id:21', id: '21', value: 'Sport', disabled: false }];
  const r = planField(tree, normaliseBulk({ op: 'retire', value: 'Nova Classic' }).bulk, { typeKey: 'cascadingselect' });
  assert.equal(r.action, 'change');
  assert.deepEqual(r.plan.disables.map((d) => d.value), ['Sport']);
  tree[2].children[1].disabled = true;
  assert.equal(planField(tree, normaliseBulk({ op: 'retire', value: 'Nova Classic' }).bulk).reason, 'Already retired here.');
});

test('retire skips fields without it, or where it is already retired, and respects "keep defaults"', () => {
  const { bulk } = normaliseBulk({ op: 'retire', value: 'Nova Classic' });
  assert.equal(planField(flat(['Vela']), bulk).reason, 'Not in this field.');
  assert.equal(planField(flat(MODELS, { 'Nova Classic': { disabled: true } }), bulk).reason, 'Already retired here.');
  const keep = normaliseBulk({ op: 'retire', value: 'Nova Classic', clearDefault: false }).bulk;
  assert.equal(planField(flat(MODELS, { 'Nova Classic': { isDefault: true } }), keep).action, 'skip');
});

test('restore, rename (with conflict check) and add (like / after)', () => {
  const restored = planField(flat(MODELS, { 'Nova Classic': { disabled: true } }), normaliseBulk({ op: 'restore', value: 'Nova Classic' }).bulk);
  assert.deepEqual(restored.plan.enables.map((e) => e.value), ['Nova Classic']);
  const renamed = planField(flat(MODELS), normaliseBulk({ op: 'rename', value: 'Nova Classic', newValue: 'Nova Heritage' }).bulk);
  assert.deepEqual(renamed.plan.edits.map((e) => e.new), ['Nova Heritage']);
  assert.equal(planField(flat(MODELS), normaliseBulk({ op: 'rename', value: 'Vela', newValue: 'atlas' }).bulk).action, 'skip', 'name clash');
  const add = normaliseBulk({ op: 'add', value: 'Nova 2', like: 'Sprint', position: 'after' }).bulk;
  const added = planField(flat(MODELS), add);
  assert.deepEqual(added.tree.map((p) => p.value), ['Vela', 'Sprint', 'Nova 2', 'Nova Classic', 'Atlas']);
  assert.equal(planField(flat(['Lumen EV']), add).reason, `Doesn't have "Sprint".`);
  assert.equal(planField(flat([...MODELS, 'Nova 2']), add).reason, 'Already there.');
});

test('undo brings back names, states, order and default; added options are disabled, never deleted', () => {
  const before = flat(MODELS, { 'Nova Classic': { isDefault: true } });
  const current = flat(['Vela', 'Sprint', 'Nova Heritage', 'Atlas']);
  current[2].disabled = true;
  current.push({ key: 'id:99', id: '99', value: 'Nova 2', disabled: false, isDefault: false, children: [] });
  const t = undoTarget(current, before);
  assert.deepEqual(t.map((p) => `${p.value}:${p.disabled ? 'off' : 'on'}${p.isDefault ? '*' : ''}`), ['Vela:on', 'Sprint:on', 'Nova Classic:on*', 'Atlas:on', 'Nova 2:off']);
});

test('totals count only included changes', () => {
  const t = totals([
    { action: 'change', affected: 5, editable: 'direct', defaultCleared: true },
    { action: 'change', affected: 3, editable: 'approval', include: true },
    { action: 'change', affected: 9, include: false },
    { action: 'skip' },
  ]);
  assert.deepEqual(t, { fields: 4, change: 2, skip: 1, excluded: 1, approval: 1, blocked: 0, workItems: 8, defaultsCleared: 1, moved: 0 });
});

// ---------- replace in work items ----------

const SHOWROOM = ['Aurora Vela', 'Aurora Sprint', 'Aurora Atlas'];
const rep = (extra = {}) => normaliseBulk({ op: 'replace', value: 'Aurora Vela', newValue: 'Aurora Sprint', fields: 'Showroom Interested Model', ...extra }).bulk;

test('replace: input, field list and validation', () => {
  assert.deepEqual(rep().fieldNames, ['Showroom Interested Model']);
  assert.deepEqual(rep({ fields: 'alle' }).fieldNames, [], '"all" = every field');
  assert.deepEqual(rep({ fields: 'Showroom Model, Fleet Model' }).fieldNames, ['Showroom Model', 'Fleet Model']);
  assert.equal(rep().retireOld, true);
  assert.ok(normaliseBulk({ op: 'replace', value: 'Aurora Vela' }).errors.length, 'needs the replacement');
  assert.ok(normaliseBulk({ op: 'replace', value: 'Aurora Vela', newValue: 'aurora  vela' }).errors.length, 'not itself');
});

test('replace: preview moves the default, retires the old option; phases split the option work', () => {
  const tree = flat(SHOWROOM, { 'Aurora Vela': { isDefault: true } });
  const r = planField(tree, rep());
  assert.equal(r.action, 'change');
  assert.equal(r.rows[0].action, 'Replace');
  assert.deepEqual(r.plan.disables.map((d) => d.value), ['Aurora Vela']);
  assert.equal(r.plan.defaultChange.toValue, 'Aurora Sprint');
  assert.deepEqual(r.sources, [{ id: '1', parentId: null }]);
  assert.equal(planField(tree, rep(), {}, { phase: 'prep' }).action, 'skip', 'nothing to prepare: Sprint is active');
  const retire = planField(tree, rep(), {}, { phase: 'retire' });
  assert.deepEqual(retire.plan.disables.map((d) => d.value), ['Aurora Vela']);
  assert.equal(retire.rows.some((x) => x.action === 'Replace'), false);
  const keep = planField(tree, rep({ retireOld: false }));
  assert.equal(keep.action, 'change', 'values still change');
  assert.equal(keep.plan.disables.length, 0);
});

test('replace: a retired replacement is enabled first; a missing one is skipped or added right after', () => {
  const off = planField(flat(SHOWROOM, { 'Aurora Sprint': { disabled: true } }), rep(), {}, { phase: 'prep' });
  assert.deepEqual(off.plan.enables.map((e) => e.value), ['Aurora Sprint']);
  const lacking = flat(['Aurora Vela', 'Aurora Atlas']);
  assert.equal(planField(lacking, rep()).reason, `Doesn't have "Aurora Sprint".`);
  const added = planField(lacking, rep({ addMissing: true }), {}, { phase: 'prep' });
  assert.deepEqual(added.tree.map((p) => p.value), ['Aurora Vela', 'Aurora Sprint', 'Aurora Atlas']);
  assert.equal(planField(flat(['Aurora Atlas']), rep()).reason, 'Not in this field.');
});

test('replace: work-item values for single, multi and cascading fields', () => {
  const single = flat(SHOWROOM);
  const map = replaceMap(single, rep());
  assert.deepEqual(replacedValue({ id: '1', value: 'Aurora Vela' }, map, 'single'), { id: '2' });
  assert.equal(replacedValue({ id: '3' }, map, 'single'), null);
  assert.equal(replacedValue(null, map, 'single'), null);
  assert.deepEqual(replacedValue([{ id: '1' }, { id: '3' }], map, 'multi'), [{ id: '2' }, { id: '3' }]);
  assert.deepEqual(replacedValue([{ id: '1' }, { id: '2' }], map, 'multi'), [{ id: '2' }], 'no duplicate');
  const casc = flat(SHOWROOM);
  casc[0].children = [{ key: 'id:10', id: '10', value: 'Base', disabled: false }, { key: 'id:11', id: '11', value: 'Launch Edition', disabled: false }];
  casc[1].children = [{ key: 'id:20', id: '20', value: 'Base', disabled: false }];
  const cmap = replaceMap(casc, rep());
  assert.deepEqual(replacedValue({ id: '1', child: { id: '10' } }, cmap, 'cascading'), { id: '2', child: { id: '20' } }, 'same trim');
  assert.deepEqual(replacedValue({ id: '1', child: { id: '11' } }, cmap, 'cascading'), { id: '2' }, 'trim the new model lacks');
  assert.deepEqual(replacedValue({ id: '1' }, cmap, 'cascading'), { id: '2' });
  const preview = planField(casc, rep(), { typeKey: 'cascadingselect' });
  assert.ok(preview.rows.some((x) => x.action === 'Note' && /Launch Edition/.test(x.option)));
  assert.equal(valueKind({ typeKey: 'com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes' }), 'multi');
  assert.equal(valueKind({ typeKey: 'com.atlassian.jira.plugin.system.customfieldtypes:select' }), 'single');
});

test('replace: values compare by option IDs, ignoring order and labels', () => {
  assert.ok(sameValue([{ id: '2', value: 'x' }, { id: '3' }], [{ id: '3' }, { id: '2' }]));
  assert.ok(!sameValue({ id: '1' }, { id: '1', child: { id: '10' } }));
  assert.deepEqual(writeForm({ id: 5, value: 'A', self: 'u', child: { id: 6, value: 'B' } }), { id: '5', child: { id: '6' } });
  assert.equal(writeForm([]), null);
});
