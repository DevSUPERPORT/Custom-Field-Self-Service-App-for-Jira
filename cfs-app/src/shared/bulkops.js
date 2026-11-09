/**
 * Pure bulk change logic shared by the backend and the tests: matching, per-field plans for retire, restore, rename,
 * add and replace, work-item value mapping, the undo target and totals. Every field is changed by replaying
 * operations on its current options.
 *
 * @file        src/shared/bulkops.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Bulk changes: one option change applied to many fields at once (retire a discontinued value everywhere, rename it,
// add a new value to many fields, restore a retired value, or replace it in the work items by another value and then
// retire it). Pure logic, shared by the backend and unit tests:
// matching, the per-field operations, the undo target and the totals. The operations reuse optionops.js, so every
// field is changed by replaying the operations on its CURRENT options - never by overwriting a stale copy.

import { normaliseOps, applyOps } from './optionops.js';
import { computePlan, planIsEmpty, describePlan } from './options.js';

export const BULK_OPS = {
  retire: 'Retire (disable) an option everywhere',
  restore: 'Restore a retired option everywhere',
  rename: 'Rename an option everywhere',
  add: 'Add an option to many fields',
  replace: 'Replace an option in the work items, then retire it',
};

const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\n]/)).map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean);
// "all" (alle, every, *) = no limit: Field Assistant must say so explicitly instead of leaving the fields out.
const ALL_FIELDS = /^(\*|all|all fields|every field|everywhere|alle|alle felder|überall|ueberall)$/i;
const fieldList = (v) => { const l = listOf(v); return l.length === 1 && ALL_FIELDS.test(l[0]) ? [] : l; };

// Validated input. value: the option to look for; newValue: rename target, or (replace) the option that takes its
// place; position: 'end' | 'after' | 'a-z' (add only); fieldNames: limit to these fields (names or IDs).
export const normaliseBulk = (i = {}) => {
  const op = String(i.op || '').toLowerCase();
  const out = {
    op: BULK_OPS[op] ? op : null,
    value: String(i.value || '').replace(/\s+/g, ' ').trim(),
    newValue: String(i.newValue || '').replace(/\s+/g, ' ').trim(),
    // add: the fields to add to are those that already have `like` (e.g. another car model); position 'after' puts
    // the new option right behind it, 'a-z' sorts the field, 'end' appends.
    like: String(i.like || '').replace(/\s+/g, ' ').trim(),
    position: /a-?z|alpha/i.test(String(i.position || '')) ? 'a-z' : /after/i.test(String(i.position || '')) ? 'after' : 'end',
    clearDefault: i.clearDefault === undefined ? true : !!i.clearDefault,
    includeTrims: i.includeTrims === undefined ? true : !!i.includeTrims,
    onlyFieldIds: Array.isArray(i.onlyFieldIds) ? i.onlyFieldIds.map(String) : null,
    fieldNames: fieldList(i.fieldNames ?? i.fields),
    // replace: retire the old option afterwards (default), and add the replacement where a field lacks it.
    retireOld: i.retireOld === undefined ? true : !!i.retireOld,
    addMissing: !!i.addMissing,
  };
  const errors = [];
  if (!out.op) errors.push('Pick what to do: retire, restore, rename, add or replace.');
  if (!out.value) errors.push('Enter the option value.');
  if (out.value.length > 255) errors.push('The option value is too long.');
  if (out.op === 'rename' && !out.newValue) errors.push('Enter the new name.');
  if (out.op === 'replace' && !out.newValue) errors.push('Enter the option that replaces it.');
  if (out.op === 'replace' && out.newValue && norm(out.value) === norm(out.newValue)) errors.push('The replacement is the same option.');
  if (out.op === 'add' && !out.like && !(out.onlyFieldIds && out.onlyFieldIds.length)) errors.push('Say which fields get the new option: those that have a given existing option ("like"), or pick the fields.');
  if (out.op === 'add' && out.position === 'after' && !out.like) out.position = 'end';
  if (out.op === 'rename' && norm(out.value) === norm(out.newValue) && out.value === out.newValue) errors.push('The new name is the same as the old one.');
  return { bulk: out, errors };
};

// Where the value sits in a field: top-level options, and (cascading) child options under any parent.
export const findMatches = (tree, value) => {
  const v = norm(value);
  const hits = [];
  tree.forEach((p) => {
    if (norm(p.value) === v) hits.push({ level: 'parent', ref: p.value, item: p, parent: null });
    (p.children || []).forEach((c) => { if (norm(c.value) === v) hits.push({ level: 'child', ref: `${p.value} > ${c.value}`, item: c, parent: p }); });
  });
  return hits;
};

const isDefaultUnder = (hit) => hit.item.isDefault || (hit.level === 'parent' && (hit.item.children || []).some((c) => c.isDefault));
const ref = (item, parent) => (parent ? `${parent.value} > ${item.value}` : item.value);

// Replace: each place the old option sits, with the option that takes its place at the same level (for a trim: under
// the same model). `to` is null where the field doesn't have it.
export const replacePairs = (tree, bulk) => findMatches(tree, bulk.value).map((h) => {
  const siblings = h.parent ? h.parent.children || [] : tree;
  return { ...h, to: siblings.find((s) => s !== h.item && norm(s.value) === norm(bulk.newValue)) || null };
});

// The plan for one field: { action: 'change' | 'skip', reason, ops, tree, plan, rows, defaultCleared, matched, sources }.
// field: { typeKey, cascading } ; tree: its current options. A replace runs in phases (opts.phase): 'prep' makes the
// replacement available, the work items are changed, then 'retire' retires the old option; no phase = the whole preview.
export const planField = (tree, bulk, field = {}, opts = {}) => {
  const cascading = !!field.cascading || /cascading/i.test(field.typeKey || '');
  const hits = findMatches(tree, bulk.value);
  const opsIn = { disable: [], enable: [], rename: [], add: [] };
  let defaultCleared = false;
  const extraRows = [];
  let sources = null;
  const skip = (reason) => ({ action: 'skip', reason, matched: hits.map((h) => h.ref) });
  if (bulk.op === 'retire') {
    const live = hits.filter((h) => !h.item.disabled);
    // Trims count even under a model that was retired earlier on its own: "everywhere" leaves nothing active under it.
    const trims = bulk.includeTrims ? hits.filter((h) => h.level === 'parent').flatMap((h) => (h.item.children || []).filter((c) => !c.disabled).map((c) => `${h.item.value} > ${c.value}`)) : [];
    if (!hits.length) return skip('Not in this field.');
    if (!live.length && !trims.length) return skip('Already retired here.');
    live.forEach((h) => opsIn.disable.push(h.ref));
    trims.forEach((t) => opsIn.disable.push(t));
    if (hits.some(isDefaultUnder)) {
      if (!bulk.clearDefault) return skip('It is the default value here; allow clearing defaults to retire it.');
      opsIn.defaultValue = 'none';
      defaultCleared = true;
    }
  } else if (bulk.op === 'restore') {
    const off = hits.filter((h) => h.item.disabled);
    if (!hits.length) return skip('Not in this field.');
    if (!off.length) return skip('Already active here.');
    off.forEach((h) => opsIn.enable.push(h.ref));
    if (bulk.includeTrims) off.filter((h) => h.level === 'parent').forEach((h) => (h.item.children || []).filter((c) => c.disabled).forEach((c) => opsIn.enable.push(`${h.item.value} > ${c.value}`)));
  } else if (bulk.op === 'rename') {
    if (!hits.length) return skip('Not in this field.');
    for (const h of hits) {
      const siblings = h.parent ? h.parent.children : tree;
      if (siblings.some((s) => s !== h.item && norm(s.value) === norm(bulk.newValue))) return skip(`"${bulk.newValue}" already exists next to it.`);
      opsIn.rename.push(`${h.ref} => ${bulk.newValue}`);
    }
  } else if (bulk.op === 'replace') {
    const pairs = replacePairs(tree, bulk);
    if (!pairs.length) return skip('Not in this field.');
    const lacking = pairs.filter((p) => !p.to);
    if (lacking.length && !(bulk.addMissing && lacking.every((p) => p.level === 'parent'))) {
      return skip(`Doesn't have "${bulk.newValue}"${lacking[0].parent ? ` under "${lacking[0].parent.value}"` : ''}.`);
    }
    if (lacking.length) opsIn.add.push(bulk.newValue);
    pairs.filter((p) => p.to && p.to.disabled).forEach((p) => opsIn.enable.push(ref(p.to, p.parent)));
    sources = pairs.map((p) => ({ id: p.item.id, parentId: p.parent ? p.parent.id : null })).filter((x) => x.id);
    extraRows.push({ action: 'Replace', option: bulk.value, old: bulk.value, new: bulk.newValue });
    // Trims of the old model that the new one doesn't have: those work items keep only the model.
    pairs.filter((p) => p.level === 'parent' && p.to).forEach((p) => {
      const lost = (p.item.children || []).filter((c) => !(p.to.children || []).some((t) => norm(t.value) === norm(c.value))).map((c) => c.value);
      if (lost.length) extraRows.push({ action: 'Note', option: `${lost.join(', ')}: not under "${p.to.value}"`, old: '', new: 'model only' });
    });
    if (bulk.retireOld) {
      pairs.filter((p) => !p.item.disabled).forEach((p) => opsIn.disable.push(p.ref));
      if (bulk.includeTrims) pairs.filter((p) => p.level === 'parent').forEach((p) => (p.item.children || []).filter((c) => !c.disabled).forEach((c) => opsIn.disable.push(ref(c, p.item))));
      // A default on the old option moves to the replacement (a default trim to the same trim, if the new model has it).
      const d = pairs.find(isDefaultUnder);
      if (d) {
        const dc = d.level === 'parent' && (d.item.children || []).find((c) => c.isDefault);
        const tc = dc && d.to && (d.to.children || []).find((t) => norm(t.value) === norm(dc.value));
        opsIn.defaultValue = d.parent ? `${d.parent.value} > ${bulk.newValue}` : tc ? `${bulk.newValue} > ${tc.value}` : bulk.newValue;
        defaultCleared = true;
      }
    }
    if (opts.phase === 'prep') { opsIn.disable = []; delete opsIn.defaultValue; }
    if (opts.phase === 'retire') { opsIn.add = []; opsIn.enable = []; }
  } else if (bulk.op === 'add') {
    if (tree.some((p) => norm(p.value) === norm(bulk.value))) return skip('Already there.');
    if (bulk.like && !tree.some((p) => norm(p.value) === norm(bulk.like))) return skip(`Doesn't have "${bulk.like}".`);
    opsIn.add.push(bulk.value);
    if (bulk.position === 'a-z') opsIn.sortAlphabetically = true;
  } else {
    return skip('Unknown operation.');
  }
  const ops = normaliseOps(opsIn);
  if (opsIn.defaultValue) ops.defaultValue = opsIn.defaultValue;
  const applied = applyOps(tree, ops, { cascading });
  let next = applied.tree;
  const { missing } = applied;
  if (missing.length) return skip(`Could not find ${missing.join(', ')} any more.`);
  // A new option goes right behind its anchor: `like` (add), or the option it replaces (replace).
  const anchorValue = bulk.op === 'add' && bulk.position === 'after' ? bulk.like : bulk.op === 'replace' ? bulk.value : '';
  const addedValue = bulk.op === 'replace' ? bulk.newValue : bulk.value;
  if (anchorValue) {
    const added = next.find((p) => !p.id && norm(p.value) === norm(addedValue));
    const anchor = next.findIndex((p) => norm(p.value) === norm(anchorValue));
    if (added && anchor >= 0) {
      next = next.filter((p) => p !== added);
      next.splice(next.findIndex((p) => norm(p.value) === norm(anchorValue)) + 1, 0, added);
    }
  }
  const plan = computePlan(tree, next);
  // A replace changes work items even when the options stay as they are (keep the old option, replacement active).
  if (planIsEmpty(plan) && !(bulk.op === 'replace' && !opts.phase)) return skip('Nothing to change.');
  const rows = opts.phase === 'retire' ? describePlan(plan) : [...extraRows, ...describePlan(plan)];
  return { action: 'change', ops: opsIn, plan, tree: next, rows, defaultCleared, matched: hits.map((h) => h.ref), sources };
};

// ---------- replace: the work-item values ----------

// What a field holds: one option, several (multi select, checkboxes) or model + trim (cascading).
export const valueKind = (field = {}) => (field.cascading || /cascading/i.test(field.typeKey || '') ? 'cascading' : /multi|checkbox/i.test(field.typeKey || '') ? 'multi' : 'single');

// Option ID map on the field's current options (after the prep phase): old ID -> new ID; for a model also its trims by
// name (a trim the new model lacks maps to null: the work item keeps the model only). Trim-level keys: "parent>child".
export const replaceMap = (tree, bulk) => {
  const map = {};
  replacePairs(tree, bulk).filter((p) => p.to && p.to.id && p.item.id).forEach((p) => {
    if (p.level === 'child') { map[`${p.parent.id}>${p.item.id}`] = { to: String(p.to.id) }; return; }
    const children = {};
    (p.item.children || []).forEach((c) => {
      const t = (p.to.children || []).find((x) => norm(x.value) === norm(c.value));
      children[String(c.id)] = t && t.id ? String(t.id) : null;
    });
    map[String(p.item.id)] = { to: String(p.to.id), children };
  });
  return map;
};

// A value in the form the Jira edit API takes ({id}, [{id}], {id, child:{id}}), or null for empty.
export const writeForm = (v) => {
  if (v == null || (Array.isArray(v) && !v.length)) return null;
  if (Array.isArray(v)) return v.map((x) => ({ id: String(x.id) }));
  return v.child ? { id: String(v.id), child: { id: String(v.child.id) } } : { id: String(v.id) };
};
const valueKey = (v) => {
  const w = writeForm(v);
  if (!w) return '';
  return Array.isArray(w) ? w.map((x) => x.id).sort().join(',') : `${w.id}${w.child ? `>${w.child.id}` : ''}`;
};
export const sameValue = (a, b) => valueKey(a) === valueKey(b);

// The new value of one work item, or null when it doesn't carry the old option.
export const replacedValue = (value, map, kind) => {
  const w = writeForm(value);
  if (!w) return null;
  if (Array.isArray(w)) {
    if (!w.some((x) => map[x.id])) return null;
    const ids = [];
    w.forEach((x) => { const id = map[x.id] ? map[x.id].to : x.id; if (!ids.includes(id)) ids.push(id); });
    return ids.map((id) => ({ id }));
  }
  if (kind === 'cascading') {
    const trim = w.child && map[`${w.id}>${w.child.id}`];
    if (trim) return { id: w.id, child: { id: trim.to } };
    const model = map[w.id];
    if (!model) return null;
    const child = w.child ? model.children?.[w.child.id] : null;
    return child ? { id: model.to, child: { id: child } } : { id: model.to };
  }
  return map[w.id] ? { id: map[w.id].to } : null;
};

// Undo: the target tree that brings a field back to `before`, starting from `current`. Options the bulk change
// added are disabled (options are never deleted); everything else gets its old name, state, order and default.
export const undoTarget = (current, before) => {
  const curKeys = new Set(current.flatMap((p) => [p.key, ...(p.children || []).map((c) => c.key)]));
  const target = before
    .filter((p) => curKeys.has(p.key))
    .map((p) => ({ ...p, children: (p.children || []).filter((c) => curKeys.has(c.key)).map((c) => ({ ...c })) }));
  const known = new Set(target.flatMap((p) => [p.key, ...p.children.map((c) => c.key)]));
  current.forEach((p) => {
    if (!known.has(p.key)) target.push({ ...p, isDefault: false, disabled: true, children: (p.children || []).map((c) => ({ ...c, isDefault: false, disabled: true })) });
    else {
      const t = target.find((x) => x.key === p.key);
      (p.children || []).filter((c) => !known.has(c.key)).forEach((c) => t.children.push({ ...c, isDefault: false, disabled: true }));
    }
  });
  return target;
};

// Totals for the preview: fields to change / skip / needing approval, work items affected, defaults cleared.
export const totals = (items) => {
  const change = items.filter((i) => i.action === 'change' && i.include !== false);
  return {
    fields: items.length,
    change: change.length,
    skip: items.filter((i) => i.action === 'skip').length,
    excluded: items.filter((i) => i.action === 'change' && i.include === false).length,
    approval: change.filter((i) => i.editable === 'approval').length,
    blocked: change.filter((i) => i.editable === 'readonly').length,
    workItems: change.reduce((n, i) => n + (i.affected || 0), 0),
    defaultsCleared: change.filter((i) => i.defaultCleared).length,
    moved: change.reduce((n, i) => n + (i.moved || 0), 0),
  };
};

// One line for people.
// Where: every field that has the option, or the fields picked by name.
const where = (b, all) => ((b.fieldNames || []).length ? `in ${b.fieldNames.length > 2 ? `${b.fieldNames.length} fields` : b.fieldNames.map((n) => `"${n}"`).join(' and ')}` : all);
export const describeBulk = (b) => ({
  retire: `Retire "${b.value}"${b.includeTrims ? ' (with its trims/sub-options)' : ''} ${where(b, 'everywhere')}${b.clearDefault ? ', clearing it as default value' : ''}`,
  restore: `Restore "${b.value}" ${where(b, 'everywhere it was retired')}`,
  rename: `Rename "${b.value}" to "${b.newValue}" ${where(b, 'everywhere')}`,
  add: `Add "${b.value}" to every field ${b.like ? `that has "${b.like}"` : 'you picked'}${b.position === 'a-z' ? ' (then sort A-Z)' : b.position === 'after' ? ` (right after "${b.like}")` : ' (at the end)'}`,
  replace: `Replace "${b.value}" with "${b.newValue}" in all work items${(b.fieldNames || []).length ? ` of ${b.fieldNames.map((n) => `"${n}"`).join(', ')}` : ''}${b.retireOld ? `, then retire "${b.value}"` : ''}`,
}[b.op] || '');
