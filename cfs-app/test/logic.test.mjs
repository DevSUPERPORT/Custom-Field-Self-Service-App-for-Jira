/**
 * Unit tests for the deterministic core: the guideline check for new fields and option planning.
 *
 * @file        test/logic.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNewField, similarity, suggestName, parseOptions } from '../src/shared/guidelines.js';
import { toTree, computePlan, describePlan, validateTree, sortAlphabetically } from '../src/shared/options.js';

const ctx = {
  customFields: [
    { id: 'customfield_10116', name: 'CFS Test Customer Segment', typeKey: 'select' },
    { id: 'customfield_10080', name: 'Product Group', typeKey: 'select' },
    { id: 'customfield_10079', name: 'Product', typeKey: 'textfield' },
  ],
  systemFieldNames: ['Summary', 'Status'],
};
const base = { name: 'Contract Type', description: 'Type of contract', typeKey: 'select', optionsText: 'Framework\nOne-off', projectKeys: ['CFS'], justification: 'Reporting', global: false };

test('green request', () => {
  const r = checkNewField(base, ctx);
  assert.equal(r.result, 'green', JSON.stringify(r.findings));
  assert.equal(r.options.length, 2);
});
test('similar name and same type -> yellow with field id', () => {
  const r = checkNewField({ ...base, name: 'Product Groups' }, ctx);
  assert.equal(r.result, 'yellow');
  assert.equal(r.findings[0].fieldId, 'customfield_10080');
});
test('same name, other type -> yellow', () => {
  assert.equal(checkNewField({ ...base, name: 'Product' }, ctx).result, 'yellow');
});
test('system field name -> red', () => {
  const r = checkNewField({ ...base, name: 'Status' }, ctx);
  assert.equal(r.result, 'red');
  assert.ok(r.findings.some((f) => f.code === 'system-field'));
  assert.equal(checkNewField({ ...base, name: 'Due date' }, ctx).result, 'red');
});
test('type not allowed -> red', () => {
  assert.equal(checkNewField({ ...base, typeKey: 'multigrouppicker' }, ctx).result, 'red');
});
test('naming convention -> red with suggestion', () => {
  const r = checkNewField({ ...base, name: 'CFS - contract  type!' }, ctx);
  assert.equal(r.result, 'red');
  const f = r.findings.find((x) => x.code === 'naming');
  assert.equal(f.suggestion, 'Contract type');
  assert.equal(suggestName('[CFS] cost centre', ['CFS']), 'Cost centre');
});
test('global context -> yellow', () => {
  assert.equal(checkNewField({ ...base, global: true }, ctx).result, 'yellow');
});
test('select without options / duplicate options -> red', () => {
  assert.equal(checkNewField({ ...base, optionsText: '' }, ctx).result, 'red');
  const r = checkNewField({ ...base, optionsText: 'Framework\nframework' }, ctx);
  assert.ok(r.findings.some((f) => f.code === 'options-duplicate'));
});
test('cascading options parse and duplicates per parent', () => {
  const p = parseOptions('Hardware > Laptops\nHardware > Monitors\nSoftware', true);
  assert.deepEqual(p.map((x) => [x.value, x.children.length]), [['Hardware', 2], ['Software', 0]]);
  const r = checkNewField({ ...base, typeKey: 'cascadingselect', optionsText: 'A > x\nA > X' }, ctx);
  assert.equal(r.result, 'red');
});
test('missing justification / description -> red', () => {
  assert.equal(checkNewField({ ...base, justification: ' ' }, ctx).result, 'red');
  assert.equal(checkNewField({ ...base, description: '' }, ctx).result, 'red');
});
test('similarity basics', () => {
  assert.equal(similarity('Kostenstelle', 'kostenstelle'), 1);
  assert.ok(similarity('Customer segment', 'Customer segments') > 0.9);
  assert.ok(similarity('Region', 'Priority') < 0.8);
});

// ---------- options ----------
const raw = [
  { id: '1', value: 'Enterprise', disabled: false },
  { id: '2', value: 'SMB', disabled: false },
  { id: '3', value: 'Non-profit', disabled: true },
];
const casc = [
  { id: '10', value: 'Hardware' }, { id: '11', value: 'Software' },
  { id: '12', value: 'Laptops', optionId: '10' }, { id: '13', value: 'Monitors', optionId: '10' },
];
const clone = (t) => t.map((p) => ({ ...p, children: p.children.map((c) => ({ ...c })) }));

test('no change -> empty plan', () => {
  const t = toTree(raw);
  const p = computePlan(t, clone(t));
  assert.equal(describePlan(p).length, 0);
});
test('edit, disable, enable, add at end', () => {
  const t = toTree(raw);
  const e = clone(t);
  e[0].value = 'Enterprise (500+)';
  e[1].disabled = true;
  e[2].disabled = false;
  e.push({ key: 'new:1', value: 'Startup', disabled: false, children: [] });
  const p = computePlan(t, e);
  assert.deepEqual(describePlan(p).map((r) => r.action), ['Add', 'Edit', 'Disable', 'Enable']);
  assert.equal(p.orders.length, 0, 'append at end needs no move');
});
test('add in the middle and manual sort produce an order step', () => {
  const t = toTree(raw);
  const e = clone(t);
  e.splice(1, 0, { key: 'new:1', value: 'Mid-market', disabled: false, children: [] });
  const p = computePlan(t, e);
  assert.equal(p.orders.length, 1);
  assert.deepEqual(p.orders[0].keys, ['id:1', 'new:1', 'id:2', 'id:3']);
});
test('A-Z sort with disabled to the end', () => {
  const items = toTree([{ id: '1', value: 'b' }, { id: '2', value: 'A', disabled: true }, { id: '3', value: 'c' }]);
  assert.deepEqual(sortAlphabetically(items, true).map((i) => i.value), ['b', 'c', 'A']);
  assert.deepEqual(sortAlphabetically(items, false).map((i) => i.value), ['A', 'b', 'c']);
});
test('cascading: child add under new parent, child sort', () => {
  const t = toTree(casc);
  assert.equal(t[0].children.length, 2);
  const e = clone(t);
  e[0].children.reverse();
  e.push({ key: 'new:1', value: 'Services', disabled: false, children: [{ key: 'new:2', value: 'Consulting', disabled: false }] });
  const p = computePlan(t, e);
  assert.equal(p.adds.length, 2);
  assert.equal(p.adds[1].parentKey, 'new:1');
  assert.equal(p.orders.length, 1);
  assert.equal(p.orders[0].parentValue, 'Hardware');
});
test('validation: duplicates ignoring case, empty, spaces', () => {
  const t = toTree(raw);
  const e = clone(t);
  e.push({ key: 'new:1', value: 'smb', disabled: false, children: [] });
  e.push({ key: 'new:2', value: '', disabled: false, children: [] });
  e.push({ key: 'new:3', value: ' x', disabled: false, children: [] });
  const errs = validateTree(e);
  assert.equal(errs.length, 3, errs.join(' | '));
});

test('AI-flagged duplicate -> yellow, unknown id ignored', () => {
  const r = checkNewField({ ...base, name: 'Kostenstelle', aiSimilarTo: 'customfield_10080' }, ctx);
  assert.equal(r.result, 'yellow');
  assert.ok(r.findings.some((f) => f.code === 'ai-similar'));
  assert.equal(checkNewField({ ...base, aiSimilarTo: 'customfield_99999' }, ctx).result, 'green');
});

test('admin rules: allowed types, name length, reserved names, option limits', () => {
  const rules = { allowedTypes: ['textfield'], nameMax: 10, extraForbiddenNames: ['Cost centre'], maxOptions: 2 };
  assert.equal(checkNewField(base, { ...ctx, rules }).findings.some((f) => f.code === 'type-not-allowed'), true);
  const long = checkNewField({ ...base, typeKey: 'textfield', name: 'Contract Type Long' }, { ...ctx, rules });
  assert.ok(long.findings.some((f) => f.code === 'naming'));
  assert.equal(checkNewField({ ...base, typeKey: 'textfield', name: 'Cost centre' }, { ...ctx, rules }).result, 'red');
  const many = checkNewField({ ...base, optionsText: 'A\nB\nC' }, { ...ctx, rules: { maxOptions: 2 } });
  assert.ok(many.findings.some((f) => f.code === 'options-limit'));
  assert.equal(validateTree(toTree([{ id: '1', value: 'A' }, { id: '2', value: 'B' }, { id: '3', value: 'C' }]), { maxOptions: 2 }).length, 1);
});

test('cascading select is never offered for a new field, even when old settings still allow it', async () => {
  const { CREATABLE, OPTION_TYPES } = await import('../src/shared/fieldtypes.js');
  assert.ok(!CREATABLE.some((t) => t.key === 'cascadingselect'));
  assert.ok(OPTION_TYPES.has('cascadingselect'), 'existing cascading fields stay editable');
  const r = checkNewField({ ...base, typeKey: 'cascadingselect', optionsText: 'A > x' }, { ...ctx, rules: { ...(ctx.rules || {}), allowedTypes: ['select', 'cascadingselect'] } });
  assert.equal(r.result, 'red');
  assert.ok(r.findings.some((f) => f.code === 'type-not-allowed' && /two select lists/.test(f.message)));
});
