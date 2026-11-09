/**
 * The project's option catalog: every option field with its real options and where each value lives, the picker
 * choices and the plain-language summary shown before a bulk preview. Shared by the backend and the Bulk changes tab.
 *
 * @file        src/shared/catalog.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// The project's option catalog: every option field of a project with its real options, and every option value with
// where it lives. Pure logic shared by the backend (building it) and the Bulk changes tab (pickers, live summary),
// so what the pickers offer always comes from the project's own data - never from examples.

export const norm = (x) => String(x || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

// fields: overview rows (id, name, type, cascading, editable, scope, sharedWith); trees: { fieldId: compact tree }
// where a compact tree is [{ v, o (retired), d (default), c: [{ v, o, d }] }]. Values carry field indexes:
// f (has it), live (active there), off (retired there), def (default there), sub (as a sub-option there).
export const buildCatalog = (fields, trees) => {
  const values = new Map();
  const touch = (v, i, off, def, sub) => {
    const k = norm(v);
    if (!k) return;
    let e = values.get(k);
    if (!e) { e = { v, f: new Set(), live: new Set(), off: new Set(), def: new Set(), sub: new Set() }; values.set(k, e); }
    e.f.add(i);
    (off ? e.off : e.live).add(i);
    if (def) e.def.add(i);
    if (sub) e.sub.add(i);
  };
  fields.forEach((f, i) => (trees[f.id] || []).forEach((p) => {
    touch(p.v, i, p.o, p.d, false);
    (p.c || []).forEach((c) => touch(c.v, i, c.o || p.o, c.d, true));
  }));
  const arr = (s) => [...s].sort((a, b) => a - b);
  return {
    fields: fields.map((f) => ({
      id: f.id, name: f.name, type: f.type, cascading: !!f.cascading, editable: f.editable, scope: f.scope,
      sharedWith: (f.sharedWith || []).map((p) => (typeof p === 'string' ? p : p.key)), options: (trees[f.id] || []).length,
    })),
    values: [...values.values()]
      .map((e) => ({ v: e.v, f: arr(e.f), live: arr(e.live), off: arr(e.off), def: arr(e.def), sub: arr(e.sub) }))
      .sort((a, b) => b.f.length - a.f.length || a.v.localeCompare(b.v)),
  };
};

export const findValue = (cat, v) => (cat?.values || []).find((x) => norm(x.v) === norm(v)) || null;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const is = (n) => (n === 1 ? 'is' : 'are');
const has = (n) => (n === 1 ? 'has' : 'have');
const inter = (a, b) => a.filter((x) => b.includes(x));
const minus = (a, b) => a.filter((x) => !b.includes(x));

// Fields this space can change itself (everything but global contexts).
export const changeable = (cat, idx) => idx.filter((i) => cat.fields[i].editable !== 'readonly');

// Picker items for "which option": only what makes sense for the operation, with where it lives. Options that live
// only in global fields are shown but locked: only SUPERPORT can change those.
export const optionChoices = (cat, op) => (cat?.values || [])
  .filter((x) => (op === 'retire' ? x.live.length : op === 'restore' ? x.off.length : true))
  .map((x) => {
    const where = op === 'retire' ? x.live : op === 'restore' ? x.off : x.f;
    const locked = !changeable(cat, where).length;
    const bits = [];
    if (op === 'restore') bits.push(`retired in ${plural(x.off.length, 'field')}`);
    else if (op === 'retire') bits.push(`active in ${plural(x.live.length, 'field')}`);
    else bits.push(`in ${plural(x.f.length, 'field')}`);
    if (op !== 'restore' && x.off.length && x.live.length) bits.push(`retired in ${x.off.length}`);
    if (op !== 'restore' && x.live.length === 0) bits.push('retired everywhere');
    if (x.def.length) bits.push(`default in ${x.def.length}`);
    if (x.sub.length) bits.push(x.sub.length === x.f.length ? 'sub-option' : `sub-option in ${x.sub.length}`);
    return {
      value: x.v, label: x.v, meta: bits.join(' · '), weight: locked ? -1 : (op === 'restore' ? x.off.length : x.f.length),
      disabled: locked, disabledNote: `${bits[0]}, global only: only Jira administrators can change it`,
    };
  })
  .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));

// Picker items for "replace with": every other option, best first - the ones the same fields already have.
export const replacementChoices = (cat, value) => {
  const src = findValue(cat, value);
  if (!src) return [];
  return cat.values.filter((x) => norm(x.v) !== norm(value)).map((x) => {
    const both = inter(src.f, x.f).length;
    return {
      value: x.v, label: x.v, weight: both,
      meta: both === src.f.length ? `in all ${plural(src.f.length, 'field')} that have "${src.v}"` : both ? `in ${both} of the ${src.f.length} fields that have "${src.v}"` : `not in those fields yet (in ${plural(x.f.length, 'other field')})`,
    };
  }).sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));
};

const EDIT_NOTE = { approval: 'shared · needs approval', readonly: 'global · Jira administrators only' };
// Picker items for "which fields": the fields that have the option (all option fields when none is picked yet).
export const fieldChoices = (cat, value) => {
  const src = value ? findValue(cat, value) : null;
  const idx = src ? src.f : (cat?.fields || []).map((_, i) => i);
  return idx.map((i) => {
    const f = cat.fields[i];
    const state = src ? [src.live.includes(i) ? 'active' : 'retired', ...(src.def.includes(i) ? ['default'] : []), ...(src.sub.includes(i) ? ['sub-option'] : [])].join(', ') : `${plural(f.options, 'option')}`;
    return {
      value: f.id, label: f.name, meta: [f.type, state, EDIT_NOTE[f.editable]].filter(Boolean).join(' · '),
      disabled: f.editable === 'readonly', disabledNote: 'Global field: only Jira administrators can change it',
    };
  });
};

// The plain-language summary shown before any preview: what will happen where, and what will be skipped, from the
// catalog alone (the preview then adds the work items). form: { op, value, newValue, like, fieldIds, addMissing,
// retireOld, keepDefaults }. Returns { ok, lines: [{ tone, text }], scope (field indexes) }.
export const summarise = (cat, form) => {
  const out = { ok: false, lines: [], scope: [] };
  if (!cat) return out;
  const src = findValue(cat, form.value);
  const picked = (form.fieldIds || []).length ? cat.fields.map((f, i) => (form.fieldIds.includes(f.id) ? i : -1)).filter((i) => i >= 0) : null;
  const within = (a) => (picked ? inter(a, picked) : a);
  const ro = (a) => a.filter((i) => cat.fields[i].editable === 'readonly');
  const shared = (a) => a.filter((i) => cat.fields[i].editable === 'approval');
  const add = (tone, text) => out.lines.push({ tone, text });
  // The main line counts only what really changes; global fields are mentioned once, separately.
  const can = (a) => minus(a, ro(a)).length;
  const tail = (target) => {
    const r = ro(target).length;
    const s = shared(target).length;
    if (r && !can(target)) {
      out.lines = [{ tone: 'warning', text: `${v} is only in global ${r === 1 ? 'field' : 'fields'} here, which only Jira administrators can change. Ask one, or pick another option.` }];
      out.scope = [];
      out.ok = false;
      return;
    }
    if (r) add('info', `${plural(r, 'global field')} also ${has(r)} it: ${r === 1 ? 'it stays' : 'they stay'} as ${r === 1 ? 'it is' : 'they are'} (only Jira administrators can change global fields).`);
    if (s) add('info', `${plural(s, 'field')} ${is(s)} shared with other spaces: the batch goes to a Jira administrator for approval first.`);
    out.scope = minus(target, ro(target));
    out.ok = out.scope.length > 0;
  };
  const v = `"${String(form.value || '').trim()}"`;
  if (form.op === 'add') {
    const like = findValue(cat, form.like);
    const name = String(form.value || '').trim();
    if (!like || !name) return out;
    const target = within(like.f);
    const have = findValue(cat, name);
    const already = have ? inter(target, have.f) : [];
    const todo = minus(target, already);
    add('success', `Adds "${name}" to ${plural(can(todo), 'field')} that have "${like.v}"${form.position === 'after' ? `, right after it` : form.position === 'a-z' ? ', then sorts them A-Z' : ', at the end'}.`);
    if (already.length) add('info', `${plural(already.length, 'field')} already ${has(already.length)} it and ${already.length === 1 ? 'stays as it is' : 'stay as they are'}.`);
    tail(todo);
    return out;
  }
  if (!src) return out;
  if (form.op === 'retire') {
    const todo = within(src.live);
    const done = minus(within(src.off), todo);
    const defs = changeable(cat, inter(todo, src.def));
    add('success', `Retires ${v} in ${plural(can(todo), 'field')}. Work items keep their value; it just can't be chosen any more.`);
    if (defs.length) add('info', form.keepDefaults ? `${plural(defs.length, 'field')} ${defs.length === 1 ? 'uses' : 'use'} it as default and ${is(defs.length)} skipped.` : `It is the default value in ${plural(defs.length, 'field')}: the default is removed there.`);
    if (done.length) add('info', `Already retired in ${plural(done.length, 'field')}.`);
    tail(todo);
  } else if (form.op === 'restore') {
    const todo = within(src.off);
    add('success', `Makes ${v} selectable again in ${plural(can(todo), 'field')}.`);
    tail(todo);
  } else if (form.op === 'rename') {
    const name = String(form.newValue || '').trim();
    const todo = within(src.f);
    if (!name) return out;
    const clash = findValue(cat, name);
    const both = clash && norm(name) !== norm(form.value) ? inter(todo, clash.f) : [];
    add('success', `Renames ${v} to "${name}" in ${plural(can(minus(todo, both)), 'field')}. Work items show the new name at once.`);
    if (both.length) add('warning', `"${name}" already exists in ${plural(both.length, 'field')}: those are skipped (use Replace to merge the two).`);
    tail(minus(todo, both));
  } else if (form.op === 'replace') {
    const to = findValue(cat, form.newValue);
    const name = String(form.newValue || '').trim();
    if (!name) return out;
    const has = within(src.f);
    const withTo = to ? inter(has, to.f) : [];
    const lacking = minus(has, withTo);
    const todo = form.addMissing ? has : withTo;
    add('success', `Every work item with ${v} gets "${name}" instead, in ${plural(can(todo), 'field')}${form.retireOld ? `; then ${v} is retired there` : ''}.`);
    if (lacking.length) {
      add(form.addMissing ? 'info' : 'warning', form.addMissing
        ? `"${name}" is added to ${plural(lacking.length, 'field')} that don't have it yet.`
        : `${plural(lacking.length, 'field')} ${lacking.length === 1 ? "doesn't" : "don't"} have "${name}" and ${is(lacking.length)} skipped: ${lacking.slice(0, 4).map((i) => cat.fields[i].name).join(', ')}${lacking.length > 4 ? ', …' : ''}.`);
    }
    if (form.retireOld && inter(todo, src.def).length) add('info', `Where ${v} is the default, the default moves to "${name}".`);
    tail(todo);
  }
  return out;
};
