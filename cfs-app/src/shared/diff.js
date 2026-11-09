/**
 * What a request changes, as a picture an approver reads in seconds: options with their state, the new field as a
 * card, spaces before and after, the fields of a bulk change and the totals. Pure functions built from what the
 * request stored, shared by the backend and the tests.
 *
 * @file        src/shared/diff.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Pure functions, shared by the backend (which sends the result to the page) and the unit tests. Built from what the
// request stored when it was raised (payload, rows), so the picture is exactly what the app will execute.

const at = (v, parent) => (parent ? `${parent} > ${v}` : v);

// Options of an option change: the old list with every change marked, new options where they will be, and how many
// work items carry each touched option (when the request recorded it).
// before: option tree [{ key, id, value, disabled, isDefault, children }]; plan: computePlan(); usage: { optionId: n }.
export const optionsDiff = (before = [], plan = {}, usage = null) => {
  const edits = new Map((plan.edits || []).map((e) => [String(e.id), e]));
  const off = new Set((plan.disables || []).map((d) => String(d.id)));
  const on = new Set((plan.enables || []).map((d) => String(d.id)));
  const dc = plan.defaultChange || null;
  const uses = (id) => (usage && id != null && usage[id] !== undefined ? usage[id] : null);
  const entry = (o, parent) => {
    const id = o.id != null ? String(o.id) : null;
    const e = id ? edits.get(id) : null;
    const state = id && off.has(id) ? 'retired' : id && on.has(id) ? 'restored' : e ? 'renamed' : o.disabled ? 'inactive' : 'same';
    return {
      key: o.key, value: e ? e.new : o.value, old: e ? e.old : null, parent: parent ? parent.value : null, state,
      uses: uses(id), isDefault: dc ? dc.toKey === o.key : !!o.isDefault, wasDefault: dc ? dc.fromKey === o.key : false,
    };
  };
  const added = (a) => ({ key: a.key, value: a.value, old: null, parent: a.parentValue || null, state: 'added', uses: null, isDefault: !!dc && dc.toKey === a.key, wasDefault: false });
  // One level at a time, in the order the change leaves it (plan.orders), new options where the API puts them.
  const orderOf = (parentKey) => (plan.orders || []).find((o) => (o.parentKey || null) === (parentKey || null));
  const level = (items, parentItem) => {
    const parentKey = parentItem ? parentItem.key : null;
    const list = [...items.map((o) => entry(o, parentItem)), ...(plan.adds || []).filter((a) => (a.parentKey || null) === parentKey).map(added)];
    const ord = orderOf(parentKey);
    if (ord && ord.keys) list.sort((a, b) => ord.keys.indexOf(a.key) - ord.keys.indexOf(b.key));
    return list;
  };
  const rows = [];
  level(before, null).forEach((p) => {
    rows.push(p);
    const src = before.find((x) => x.key === p.key);
    if (src || (plan.adds || []).some((a) => a.parentKey === p.key)) rows.push(...level(src ? src.children || [] : [], src || { key: p.key, value: p.value }));
  });
  const count = (s) => rows.filter((r) => r.state === s).length;
  const touched = rows.filter((r) => r.state === 'renamed' || r.state === 'retired');
  const known = touched.every((r) => r.uses !== null);
  return {
    rows,
    counts: { added: count('added'), renamed: count('renamed'), retired: count('retired'), restored: count('restored'), unchanged: count('same') + count('inactive') },
    reordered: (plan.orders || []).length > 0,
    defaultChange: dc ? { from: dc.fromValue || null, to: dc.toValue || null } : null,
    workItems: touched.length ? (known ? touched.reduce((n, r) => n + (r.uses || 0), 0) : null) : 0,
  };
};

const splitList = (s) => String(s || '').split(/[\n;]/).map((x) => x.trim()).filter(Boolean);
const optionText = (o) => (typeof o === 'string' ? o : o.value || [o.parent, o.child].filter(Boolean).join(' > '));

// A new field as a card: everything the app will create.
export const fieldCard = (payload = {}, typeLabel = (k) => k) => {
  const d = payload.draft || {};
  const options = (payload.options && payload.options.length ? payload.options.map(optionText) : splitList(d.optionsText));
  return {
    name: d.name || '', description: d.description || '', type: typeLabel(d.typeKey) || d.typeKey || '', options, defaultValue: d.defaultValue || '',
    global: !!d.global, spaces: d.global ? [] : (d.projectKeys || payload.affected || []), screens: Array.isArray(d.screenIds) ? d.screenIds.length : null,
    addToScreens: d.addToScreens !== false, issueTypes: (d.issueTypeIds || []).length, justification: d.justification || '', copyFrom: d.migrateFrom || null,
  };
};

// Who uses a field before and after a reuse.
export const reuseSpaces = (payload = {}, projectKey = '') => {
  const before = payload.plan?.contextStep?.sharedWith || [];
  const after = [...new Set([...before, projectKey].filter(Boolean))];
  return { field: payload.fieldName || payload.plan?.field?.name || '', before, after, added: after.filter((k) => !before.includes(k)), via: payload.plan?.via || '', addToScreens: payload.addToScreens !== false };
};

// A bulk change: one line per field (the rows the request stored).
export const bulkFields = (rows = []) => rows.filter((r) => r.action === 'Bulk' || r.action === '…').map((r) => ({ field: r.option, from: r.old, to: r.new, more: r.action === '…' }));

// The whole picture of one request. full = the viewer is a Jira administrator (else spaces they may not browse are
// counted, not named: `visible` lists the keys they may see).
export const requestDiff = (p, { typeLabel = (k) => k, visible = null } = {}) => {
  const payload = p.payload || {};
  const show = (keys) => (visible ? keys.filter((k) => visible.includes(k)) : keys);
  const hidden = (keys) => (visible ? keys.filter((k) => !visible.includes(k)).length : 0);
  const affected = [...new Set(payload.affected || payload.draft?.projectKeys || [p.projectKey].filter(Boolean))];
  const base = { kind: p.kind, spaces: show(affected), hiddenSpaces: hidden(affected), workItems: null, risk: p.risk || null };
  const justification = (p.rows || []).find((r) => r.action === 'Justification')?.new || payload.draft?.justification || '';
  if (p.kind === 'options' && payload.plan && payload.before) {
    const o = optionsDiff(payload.before, payload.plan, payload.usage || null);
    return { ...base, field: payload.fieldName || '', undoOf: payload.undoOf || null, options: o, workItems: o.workItems, valuesInField: payload.usageTotal ?? null, justification };
  }
  if (p.kind === 'field') {
    const card = fieldCard(payload, typeLabel);
    return { ...base, field: card.name, newField: { ...card, spaces: show(card.spaces) }, justification };
  }
  if (p.kind === 'reuse') {
    const r = reuseSpaces(payload, p.projectKey);
    return { ...base, field: r.field, reuse: { ...r, before: show(r.before), after: show(r.after), hiddenBefore: hidden(r.before) } };
  }
  if (p.kind === 'bulk' || p.kind === 'bulkundo') {
    const fields = bulkFields(p.rows);
    const m = /(\d+) work item\(s\) affected/.exec((p.briefing || []).join(' '));
    const back = p.kind === 'bulkundo' ? (p.rows || []).find((r) => r.action === 'Undo bulk change')?.new || '' : '';
    return { ...base, field: payload.description || p.summary || payload.fieldName || '', bulk: { jobId: payload.jobId || null, what: payload.description || p.summary || '', fields, undo: p.kind === 'bulkundo', back }, workItems: m ? Number(m[1]) : null };
  }
  if (p.kind === 'bundle') {
    return { ...base, bundle: (payload.items || []).map((i) => ({ name: i.entryName, kind: i.kind })) };
  }
  // Anything else (stage 1, older requests): the stored rows, cleaned up.
  return { ...base, field: payload.fieldName || payload.draft?.name || '', steps: (p.rows || []).filter((r) => r.action !== 'Justification').map((r) => ({ action: r.action, item: r.option || '', from: r.old || '', to: r.new || '' })), justification };
};

// Plain-language one-liner of the totals, for lists and notifications.
export const diffHeadline = (d) => {
  const parts = [];
  if (d.options) {
    const c = d.options.counts;
    if (c.added) parts.push(`${c.added} added`);
    if (c.renamed) parts.push(`${c.renamed} renamed`);
    if (c.retired) parts.push(`${c.retired} retired`);
    if (c.restored) parts.push(`${c.restored} restored`);
    if (d.options.reordered) parts.push('new order');
    if (d.options.defaultChange) parts.push('default changes');
  }
  if (d.newField) parts.push(`new ${d.newField.type || 'field'}${d.newField.options.length ? ` with ${d.newField.options.length} options` : ''}`);
  if (d.reuse) parts.push(`${d.reuse.added.join(', ') || 'this space'} joins`);
  if (d.bulk) parts.push(`${d.bulk.fields.length} field(s)`);
  return parts.join(' · ');
};

export { at };
