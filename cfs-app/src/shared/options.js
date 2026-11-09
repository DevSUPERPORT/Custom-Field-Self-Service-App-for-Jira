/**
 * Option planning for the options editor: turns the difference between the original and the edited option tree into
 * Jira API steps and a readable preview, including the default value.
 *
 * @file        src/shared/options.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Option maintenance (case 2): the editor works on a copy of the options, then this module turns the
// difference between the original and the edited copy into a plan of API steps and a readable preview.
//
// Tree shape used everywhere (flat fields simply have no children):
//   [{ key, id?, value, disabled, children: [{ key, id?, value, disabled }] }]
// key = "id:<optionId>" for existing options, "new:<n>" for options added in the editor.

import { RULES } from './guidelines.js';

// defaultIds: option ids that are the context's default value (one, or parent + child for cascading).
export const toTree = (options, defaultIds = []) => {
  const isDef = (id) => defaultIds.map(String).includes(String(id));
  const parents = options.filter((o) => !o.optionId).map((o) => ({
    key: `id:${o.id}`, id: o.id, value: o.value, disabled: !!o.disabled, isDefault: isDef(o.id), children: [],
  }));
  const byId = Object.fromEntries(parents.map((p) => [p.id, p]));
  options.filter((o) => o.optionId).forEach((o) => {
    const p = byId[o.optionId];
    if (p) p.children.push({ key: `id:${o.id}`, id: o.id, value: o.value, disabled: !!o.disabled, isDefault: isDef(o.id) });
  });
  return parents;
};

// The default option of a tree: the deepest item marked isDefault (a child implies its parent).
export const defaultOf = (tree) => {
  for (const p of tree) {
    const c = (p.children || []).find((x) => x.isDefault);
    if (c) return { key: c.key, value: `${p.value} > ${c.value}`, parentKey: p.key };
    if (p.isDefault) return { key: p.key, value: p.value, parentKey: null };
  }
  return null;
};

const levels = (tree) => [
  { parentKey: null, parentId: null, parentValue: null, items: tree },
  ...tree.map((p) => ({ parentKey: p.key, parentId: p.id || null, parentValue: p.value, items: p.children })),
];

const index = (tree) => {
  const m = new Map();
  tree.forEach((p) => {
    m.set(p.key, { ...p, parent: null });
    p.children.forEach((c) => m.set(c.key, { ...c, parent: p }));
  });
  return m;
};

export const computePlan = (original, edited) => {
  const before = index(original);
  const plan = { adds: [], edits: [], disables: [], enables: [], orders: [] };
  const was = defaultOf(original);
  const now = defaultOf(edited);
  if ((was && was.key) !== (now && now.key)) {
    plan.defaultChange = { fromKey: was?.key || null, fromValue: was?.value || null, toKey: now?.key || null, toValue: now?.value || null, toParentKey: now?.parentKey || null };
  }
  levels(edited).forEach((lvl) => {
    lvl.items.forEach((o) => {
      const old = before.get(o.key);
      if (!old) {
        plan.adds.push({ key: o.key, value: o.value, disabled: !!o.disabled, parentKey: lvl.parentKey, parentId: lvl.parentId, parentValue: lvl.parentValue });
        return;
      }
      if (old.value !== o.value) plan.edits.push({ id: o.id, old: old.value, new: o.value, parentValue: lvl.parentValue });
      if (!old.disabled && o.disabled) plan.disables.push({ id: o.id, value: o.value, parentValue: lvl.parentValue });
      if (old.disabled && !o.disabled) plan.enables.push({ id: o.id, value: o.value, parentValue: lvl.parentValue });
    });
    // Order: compare with the original order plus new options appended (where the API puts them).
    const origLevel = lvl.parentKey === null ? original : (original.find((p) => p.key === lvl.parentKey) || { children: [] }).children;
    const expected = [...origLevel.map((o) => o.key).filter((k) => lvl.items.some((i) => i.key === k)),
      ...lvl.items.filter((i) => !before.has(i.key)).map((i) => i.key)];
    const now = lvl.items.map((i) => i.key);
    if (now.join('|') !== expected.join('|')) {
      plan.orders.push({
        parentKey: lvl.parentKey, parentId: lvl.parentId, parentValue: lvl.parentValue, keys: now,
        oldValues: origLevel.map((o) => o.value), newValues: lvl.items.map((i) => i.value),
      });
    }
  });
  return plan;
};

export const planIsEmpty = (p) => !p || !(p.adds.length || p.edits.length || p.disables.length || p.enables.length || p.orders.length || p.defaultChange);

export const validateTree = (tree, rules = {}) => {
  const R = { ...RULES, ...rules };
  const errors = [];
  let count = 0;
  levels(tree).forEach((lvl) => {
    const seen = new Map();
    lvl.items.forEach((o) => {
      count += 1;
      const v = (o.value || '').trim();
      const where = lvl.parentValue ? ` under "${lvl.parentValue}"` : '';
      if (!v) errors.push(`Empty option${where}.`);
      else if (v !== o.value) errors.push(`"${o.value}"${where} has leading or trailing spaces.`);
      if (v.length > R.maxOptionLength) errors.push(`"${v.slice(0, 20)}…"${where} is longer than ${R.maxOptionLength} characters.`);
      const k = v.toLowerCase();
      if (v && seen.has(k)) errors.push(`Duplicate option${where}: "${seen.get(k)}" / "${v}" (upper/lower case ignored).`);
      else seen.set(k, v);
    });
  });
  if (count > R.maxOptions) errors.push(`At most ${R.maxOptions} options (${count}).`);
  const defaults = [];
  tree.forEach((p) => { if (p.isDefault) defaults.push(p); (p.children || []).forEach((c) => { if (c.isDefault) defaults.push(c); }); });
  defaults.filter((o) => o.disabled).forEach((o) => errors.push(`"${o.value}" is the default value, so it can't be disabled. Choose another default first.`));
  return errors;
};

const at = (v, parent) => (parent ? `${parent} > ${v}` : v);

// One row per change: { action, option, old, new } - used for the preview, the approval request and the log.
export const describePlan = (plan) => [
  ...plan.adds.map((a) => ({ action: 'Add', option: at(a.value, a.parentValue), old: '', new: a.value })),
  ...plan.edits.map((e) => ({ action: 'Edit', option: at(e.old, e.parentValue), old: e.old, new: e.new })),
  ...plan.disables.map((d) => ({ action: 'Disable', option: at(d.value, d.parentValue), old: 'active', new: 'disabled' })),
  ...plan.enables.map((d) => ({ action: 'Enable', option: at(d.value, d.parentValue), old: 'disabled', new: 'active' })),
  ...plan.orders.map((o) => ({
    action: 'Sort', option: o.parentValue ? `Options under "${o.parentValue}"` : 'All options',
    old: o.oldValues.join(', '), new: o.newValues.join(', '),
  })),
  ...(plan.defaultChange ? [{ action: 'Default', option: plan.defaultChange.toValue || plan.defaultChange.fromValue, old: plan.defaultChange.fromValue || 'none', new: plan.defaultChange.toValue || 'none' }] : []),
];

export const sortAlphabetically = (items, disabledToEnd) => {
  const cmp = (a, b) => a.value.localeCompare(b.value, 'de', { sensitivity: 'base' });
  if (!disabledToEnd) return [...items].sort(cmp);
  return [...items.filter((i) => !i.disabled).sort(cmp), ...items.filter((i) => i.disabled).sort(cmp)];
};
