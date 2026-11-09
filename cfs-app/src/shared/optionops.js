/**
 * Option changes as operations (add, rename, disable, enable, sort, clean up, default) that are replayed on the
 * field's current options whenever a plan runs. A request decided hours later still applies cleanly or fails loudly;
 * it never overwrites options that changed meanwhile.
 *
 * @file        src/shared/optionops.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Option changes described as operations (add, rename, disable, enable, sort, clean-up) instead of a full tree.
// Field Assistant's previews, stored plans and stage-1 requests keep the operations; the target tree is rebuilt
// from the field's CURRENT options whenever the plan runs, so a request decided hours later still applies cleanly
// or fails loudly - it never overwrites options that changed meanwhile.

import { sortAlphabetically } from './options.js';

const list = (s) => (Array.isArray(s) ? s : String(s || '').split(/[;\n]/)).map((x) => String(x).trim()).filter(Boolean);
const bool = (v) => v === true || String(v).toLowerCase() === 'true';

// Normalised operations from free inputs (agent) or a structured object.
export const normaliseOps = (i = {}) => ({
  add: list(i.add),
  rename: list(i.rename).map((pair) => pair.split(/=>|->/).map((x) => (x || '').trim())).filter((p) => p.length === 2 && p[0] && p[1]),
  badRename: list(i.rename).filter((pair) => { const p = pair.split(/=>|->/).map((x) => (x || '').trim()); return !(p.length === 2 && p[0] && p[1]); }),
  disable: list(i.disable),
  enable: list(i.enable),
  // `sort` ("a-z" | "usage") replaces the two booleans in the agent action; both spellings are accepted.
  sortAlphabetically: bool(i.sortAlphabetically) || /^a-?z|alpha/i.test(String(i.sort || '')),
  sortByUsage: bool(i.sortByUsage) || /usage/i.test(String(i.sort || '')),
  // defaultValue: an option (cascading "Parent > Child"), or "none" to remove the default; undefined = unchanged.
  defaultValue: i.defaultValue === undefined || String(i.defaultValue).trim() === '' ? undefined : String(i.defaultValue).trim(),
  disableUnused: bool(i.disableUnused),
  disabledToEnd: i.disabledToEnd === undefined ? true : bool(i.disabledToEnd),
});

export const opsAreEmpty = (o) => !(o.add.length || o.rename.length || o.disable.length || o.enable.length || o.sortAlphabetically || o.sortByUsage || o.disableUnused || o.defaultValue !== undefined);

export const describeOps = (o) => [
  ...o.add.map((v) => `add "${v}"`),
  ...o.rename.map(([a, b]) => `rename "${a}" to "${b}"`),
  ...o.disable.map((v) => `disable "${v}"`),
  ...o.enable.map((v) => `enable "${v}"`),
  ...(o.disableUnused ? ['disable every option no work item uses'] : []),
  ...(o.sortByUsage ? ['sort by usage (most used first)'] : []),
  ...(o.sortAlphabetically ? [`sort A-Z${o.disabledToEnd ? ', disabled last' : ''}`] : []),
  ...(o.defaultValue !== undefined ? [/^none$/i.test(o.defaultValue) ? 'remove the default value' : `make "${o.defaultValue}" the default value`] : []),
];

const clone = (tree) => tree.map((p) => ({ ...p, children: (p.children || []).map((c) => ({ ...c })) }));

// Applies the operations to the current tree. perOption: { optionId: work items } (needed for the usage-based
// operations). Returns { tree, missing, unusedDisabled }.
export const applyOps = (original, ops, { cascading = false, perOption = {} } = {}) => {
  let tree = clone(original);
  const locate = (ref) => {
    const [a, b] = ref.split('>').map((x) => x.trim().toLowerCase());
    const p = tree.find((x) => x.value.toLowerCase() === a);
    if (!p) return null;
    if (b === undefined) return { item: p, parent: null };
    const c = p.children.find((x) => x.value.toLowerCase() === b);
    return c ? { item: c, parent: p } : null;
  };
  const missing = [...(ops.badRename || [])];
  let n = 0;
  ops.rename.forEach(([from, to]) => {
    const hit = locate(from);
    if (hit) hit.item.value = to.includes('>') ? to.split('>').pop().trim() : to;
    else missing.push(from);
  });
  ops.disable.forEach((ref) => { const hit = locate(ref); if (hit) hit.item.disabled = true; else missing.push(ref); });
  ops.enable.forEach((ref) => { const hit = locate(ref); if (hit) hit.item.disabled = false; else missing.push(ref); });
  ops.add.forEach((v) => {
    n += 1;
    const [a, b] = v.split('>').map((x) => x.trim());
    if (cascading && b) {
      const p = tree.find((x) => x.value.toLowerCase() === a.toLowerCase());
      if (p) p.children.push({ key: `new:${n}`, value: b, disabled: false });
      else tree.push({ key: `new:${n}`, value: a, disabled: false, children: [{ key: `new:${n}c`, value: b, disabled: false }] });
    } else {
      tree.push({ key: `new:${n}`, value: a, disabled: false, children: [] });
    }
  });
  const unusedDisabled = [];
  if (ops.disableUnused) {
    const off = (o, parent) => {
      if (o.id && !o.disabled && perOption[o.id] === 0) {
        o.disabled = true;
        unusedDisabled.push(parent ? `${parent} > ${o.value}` : o.value);
      }
    };
    tree.forEach((p) => { p.children.forEach((c) => off(c, p.value)); off(p, null); });
  }
  const uses = (o) => (o.id ? perOption[o.id] || 0 : 0);
  const byUsage = (items, last) => {
    const cmp = (a, b) => uses(b) - uses(a) || a.value.localeCompare(b.value, 'de', { sensitivity: 'base' });
    if (!last) return [...items].sort(cmp);
    return [...items.filter((i) => !i.disabled).sort(cmp), ...items.filter((i) => i.disabled).sort(cmp)];
  };
  if (ops.defaultValue !== undefined) {
    const clear = () => tree.forEach((p) => { p.isDefault = false; p.children.forEach((c) => { c.isDefault = false; }); });
    if (/^none$/i.test(ops.defaultValue)) clear();
    else {
      const hit = locate(ops.defaultValue) || (() => {
        // a value added in this same change
        const [a, b] = ops.defaultValue.split('>').map((x) => x.trim().toLowerCase());
        const p = tree.find((x) => x.value.toLowerCase() === a);
        if (!p) return null;
        if (b === undefined) return { item: p };
        const c = p.children.find((x) => x.value.toLowerCase() === b);
        return c ? { item: c } : null;
      })();
      if (hit) { clear(); hit.item.isDefault = true; } else missing.push(ops.defaultValue);
    }
  }
  if (ops.sortByUsage) tree = byUsage(tree, ops.disabledToEnd).map((p) => ({ ...p, children: byUsage(p.children, ops.disabledToEnd) }));
  else if (ops.sortAlphabetically) tree = sortAlphabetically(tree, ops.disabledToEnd).map((p) => ({ ...p, children: sortAlphabetically(p.children, ops.disabledToEnd) }));
  return { tree, missing, unusedDisabled };
};

// The option fields the nightly drift check compares: own and shared contexts only, never the app's own self-test
// field: the daily self-test edits and restores it at about the same time, which was logged as drift every night.
export const driftCandidates = (fields, skipIds = []) => {
  const skip = new Set(skipIds.filter(Boolean));
  return fields.filter((x) => x.hasOptions && !x.error && x.scope !== 'global' && !skip.has(x.id));
};

// A stable fingerprint of an option tree: changes whenever an option is added, renamed, disabled or moved.
export const treeFingerprint = (tree) => {
  const s = tree.map((p) => `${p.key}=${p.value}|${p.disabled ? 1 : 0}${p.isDefault ? '*' : ''}[${(p.children || []).map((c) => `${c.key}=${c.value}|${c.disabled ? 1 : 0}${c.isDefault ? '*' : ''}`).join(',')}]`).join(';');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
};
