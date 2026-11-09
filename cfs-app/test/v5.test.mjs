/**
 * Unit tests for the v5 logic: option operations used by agent plans, the field catalogue, pattern detection and
 * default values.
 *
 * @file        test/v5.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseOps, applyOps, opsAreEmpty, describeOps, treeFingerprint } from '../src/shared/optionops.js';
import { parseCatalogue, formatCatalogue, matchCatalogue, findEntry } from '../src/shared/catalogue.js';
import { detectPatterns, textToDropdown } from '../src/shared/patterns.js';
import { computePlan } from '../src/shared/options.js';

const tree = [
  { key: 'id:1', id: '1', value: 'EMEA', disabled: false, children: [] },
  { key: 'id:2', id: '2', value: 'APAC', disabled: false, children: [] },
  { key: 'id:3', id: '3', value: 'Americas', disabled: false, children: [] },
  { key: 'id:4', id: '4', value: 'Old', disabled: true, children: [] },
];

test('ops: add, rename, disable; missing reported', () => {
  const ops = normaliseOps({ add: 'LATAM; Africa', rename: 'APAC => Asia Pacific', disable: 'Americas; Nowhere' });
  const { tree: t, missing } = applyOps(tree, ops);
  assert.deepEqual(missing, ['Nowhere']);
  assert.equal(t.find((o) => o.id === '2').value, 'Asia Pacific');
  assert.equal(t.find((o) => o.id === '3').disabled, true);
  assert.deepEqual(t.slice(-2).map((o) => o.value), ['LATAM', 'Africa']);
  assert.equal(tree[1].value, 'APAC', 'original not mutated');
});

test('ops: malformed rename is reported, empty ops detected', () => {
  const ops = normaliseOps({ rename: 'APAC' });
  assert.equal(applyOps(tree, ops).missing[0], 'APAC');
  assert.equal(opsAreEmpty(normaliseOps({})), true);
  assert.equal(opsAreEmpty(normaliseOps({ sortByUsage: 'true' })), false);
});

test('ops: disable unused and sort by usage', () => {
  const perOption = { 1: 5, 2: 0, 3: 12, 4: 0 };
  const { tree: t, unusedDisabled } = applyOps(tree, normaliseOps({ disableUnused: true, sortByUsage: true }), { perOption });
  assert.deepEqual(unusedDisabled, ['APAC']);
  assert.deepEqual(t.map((o) => o.value), ['Americas', 'EMEA', 'APAC', 'Old']);
  const plan = computePlan(tree, t);
  assert.equal(plan.disables.length, 1);
  assert.equal(plan.orders.length, 1);
});

test('ops: cascading add under existing and new parent', () => {
  const c = [{ key: 'id:1', id: '1', value: 'Hardware', disabled: false, children: [{ key: 'id:2', id: '2', value: 'Laptop', disabled: false }] }];
  const { tree: t } = applyOps(c, normaliseOps({ add: 'Hardware > Monitor; Software > IDE' }), { cascading: true });
  assert.deepEqual(t[0].children.map((x) => x.value), ['Laptop', 'Monitor']);
  assert.equal(t[1].value, 'Software');
  assert.equal(t[1].children[0].value, 'IDE');
});

test('ops: description and fingerprint', () => {
  const ops = normaliseOps({ add: 'X', rename: 'A => B', sortAlphabetically: true });
  assert.deepEqual(describeOps(ops), ['add "X"', 'rename "A" to "B"', 'sort A-Z, disabled last']);
  const f1 = treeFingerprint(tree);
  assert.equal(f1, treeFingerprint(JSON.parse(JSON.stringify(tree))));
  assert.notEqual(f1, treeFingerprint([...tree].reverse()));
  assert.notEqual(f1, treeFingerprint(tree.map((o) => (o.id === '1' ? { ...o, disabled: true } : o))));
});

test('catalogue: parse, format, match', () => {
  const text = '# standard fields\nCost centre | select | 1000; 2000; 3000 | Booking cost centre\nContract end | datepicker\nCustomer | select | A; B | | customfield_10117\nBroken line\nX | nosuchtype';
  const { entries, errors } = parseCatalogue(text);
  assert.equal(entries.length, 3);
  assert.equal(errors.length, 2);
  assert.deepEqual(entries[0].options, ['1000', '2000', '3000']);
  assert.equal(entries[1].options.length, 0);
  assert.equal(entries[2].fieldId, 'customfield_10117');
  assert.equal(matchCatalogue(entries, 'Cost Center', 'select').id, 'cost-centre');
  assert.equal(matchCatalogue(entries, 'Cost centre', 'textfield'), null);
  assert.equal(findEntry(entries, 'customer').name, 'Customer');
  assert.equal(parseCatalogue(formatCatalogue(entries)).entries.length, 3);
  assert.equal(parseCatalogue('A | select | x | d | field_1').errors.length, 1);
});

test('patterns: key-value in summaries and labels, existing fields skipped', () => {
  const issues = [
    { key: 'X-1', summary: 'Region: EMEA - laptop broken', labels: ['channel-web'] },
    { key: 'X-2', summary: '[Region: APAC] printer', labels: ['channel-phone'] },
    { key: 'X-3', summary: 'Region: EMEA, monitor', labels: ['channel-web'] },
    { key: 'X-4', summary: 'Region: Americas - VPN', labels: ['channel-email'] },
    { key: 'X-5', summary: 'Priority: high (dup)', labels: [] },
  ];
  const found = detectPatterns(issues, ['Product'], { minCount: 4 });
  const keys = found.map((f) => f.key);
  assert.ok(keys.includes('Region'), JSON.stringify(found));
  assert.ok(keys.includes('Channel'));
  assert.equal(found.find((f) => f.key === 'Region').values[0].value, 'EMEA');
  assert.ok(!detectPatterns(issues, ['Region', 'Channel'], { minCount: 4 }).length);
  const own = [1, 2, 3, 4, 5].map((n) => ({ key: `C-${n}`, summary: 'x', labels: [['cfs-alert', 'cfs-options', 'cfs-new-field'][n % 3]] }));
  assert.ok(detectPatterns(own, [], { minCount: 4 }).some((f) => f.key === 'Cfs'));
  assert.ok(!detectPatterns(own, [], { minCount: 4, ignorePrefixes: ['cfs'] }).length);
});

test('text to dropdown: few repeating values yes, free text no', () => {
  const s = textToDropdown(['Gold', 'Silver', 'gold', 'Bronze', 'Gold', 'Silver', 'Gold']);
  assert.equal(s.values.length, 3);
  assert.equal(s.values[0].value, 'Gold');
  assert.equal(textToDropdown(['a', 'b', 'c', 'd', 'e', 'f', 'g']), null);
  assert.equal(textToDropdown(['Gold', 'Gold']), null);
});

// ---------- 2026-10-20: one default value per field ----------
import { toTree as toTree2, computePlan as computePlan2, describePlan as describePlan2, validateTree as validateTree2, defaultOf } from '../src/shared/options.js';

test('default value: read, change, remove, describe', () => {
  const opts = [{ id: '1', value: 'A' }, { id: '2', value: 'B' }, { id: '3', value: 'C', disabled: true }];
  const t = toTree2(opts, ['1']);
  assert.equal(defaultOf(t).value, 'A');
  const moved = t.map((o) => ({ ...o, isDefault: o.id === '2' }));
  const p = computePlan2(t, moved);
  assert.deepEqual([p.defaultChange.fromValue, p.defaultChange.toValue], ['A', 'B']);
  assert.deepEqual(describePlan2(p).at(-1), { action: 'Default', option: 'B', old: 'A', new: 'B' });
  const removed = computePlan2(t, t.map((o) => ({ ...o, isDefault: false })));
  assert.equal(removed.defaultChange.toKey, null);
  assert.equal(computePlan2(t, t).defaultChange, undefined);
  assert.ok(validateTree2(t.map((o) => ({ ...o, isDefault: o.id === '3' }))).some((e) => /default value/.test(e)));
});

test('default value through agent ops, sort input', () => {
  const t = toTree2([{ id: '1', value: 'Web' }, { id: '2', value: 'Phone' }], ['1']);
  const { tree, missing } = applyOps(t, normaliseOps({ add: 'Chat', defaultValue: 'Chat', sort: 'a-z' }));
  assert.deepEqual(missing, []);
  assert.equal(defaultOf(tree).value, 'Chat');
  assert.deepEqual(tree.map((o) => o.value), ['Chat', 'Phone', 'Web']);
  const none = applyOps(t, normaliseOps({ defaultValue: 'none' }));
  assert.equal(defaultOf(none.tree), null);
  assert.deepEqual(applyOps(t, normaliseOps({ defaultValue: 'Fax' })).missing, ['Fax']);
  assert.notEqual(treeFingerprint(t), treeFingerprint(none.tree));
});
