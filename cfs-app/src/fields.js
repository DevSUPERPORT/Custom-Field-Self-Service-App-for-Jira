/**
 * Field overview, option changes and new fields (with screens and default value), all read and written as the app.
 * Also stores the option fingerprint the nightly drift check compares against.
 *
 * @file        src/fields.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import { kvs } from '@forge/kvs';
import * as J from './jira';
import { OPTION_TYPES, shortType, isSystemType, typeLabel, typeByKey, fullType, fullSearcher } from './shared/fieldtypes';
import { toTree } from './shared/options';
import { treeFingerprint } from './shared/optionops';
import { addFieldToScreens } from './insights';

// Drift detection: after every change the app makes, the resulting option state is stored. The nightly job
// compares it with Jira; a difference means someone changed the options outside the app.
export const stateKey = (fieldId, contextId) => `optstate:${fieldId}:${contextId}`;
export const rememberOptionState = async (fieldId, contextId) => {
  const tree = toTree(await J.options(fieldId, contextId));
  await kvs.set(stateKey(fieldId, contextId), { hash: treeFingerprint(tree), at: Date.now(), count: tree.length });
};

// Assets (CMDB) object fields are managed in Assets, not through options: always read-only here.
const isAssets = (custom = '') => /cmdb|assets/i.test(custom);

const EDITABLE = { project: 'direct', shared: 'approval', global: 'readonly' };

// The context that applies to the project: its own (non-global) context first, else the global one. Option changes
// from this space go to this context only, never to the global one other spaces use.
export const resolveContext = (ctxs, mappings, projectId) => {
  const own = mappings.find((m) => !m.isGlobalContext && String(m.projectId) === String(projectId));
  if (own) return ctxs.find((c) => String(c.id) === String(own.contextId));
  return ctxs.find((c) => c.isGlobalContext) || null;
};

const describeField = async (f, project, cache) => {
  const [ctxs, mappings] = await Promise.all([J.contexts(f.id), J.projectMappings(f.id)]);
  const ctx = resolveContext(ctxs, mappings, project.id);
  if (!ctx) return null;
  const projectIds = ctx.isGlobalContext ? [] : mappings.filter((m) => String(m.contextId) === String(ctx.id)).map((m) => String(m.projectId));
  let scope = 'global';
  if (!ctx.isGlobalContext) scope = projectIds.length > 1 ? 'shared' : 'project';
  let issueTypes = ['All'];
  if (!ctx.isAnyIssueType) {
    const its = await J.issueTypeMappings(f.id, ctx.id);
    issueTypes = its.map((m) => cache.issueTypes[String(m.issueTypeId)] || m.issueTypeId);
  }
  const key = shortType(f.schema?.custom);
  const hasOptions = OPTION_TYPES.has(key) && isSystemType(f.schema?.custom);
  const assets = isAssets(f.schema?.custom);
  let optionCount = null;
  if (hasOptions) {
    const opts = await J.options(f.id, ctx.id);
    optionCount = { active: opts.filter((o) => !o.disabled).length, disabled: opts.filter((o) => o.disabled).length };
  }
  return {
    id: f.id,
    name: f.name,
    description: f.description || '',
    typeKey: key,
    type: assets ? 'Assets object' : typeLabel(f.schema?.custom),
    assets,
    readonlyReason: assets ? 'Assets object field: its values are objects managed in Assets, not options.' : undefined,
    cascading: key === 'cascadingselect',
    hasOptions,
    contextId: String(ctx.id),
    contextName: ctx.name,
    scope,
    // The space has its own context, and other spaces use the field's global context.
    alsoGlobal: !ctx.isGlobalContext && ctxs.some((c) => c.isGlobalContext),
    sharedWith: projectIds.map((id) => cache.projects[id] || { key: id, name: id }),
    issueTypes,
    optionCount,
    editable: assets ? 'readonly' : EDITABLE[scope],
  };
};

export const loadCache = async () => {
  const [projects, issueTypes] = await Promise.all([J.allProjects(), J.allIssueTypes()]);
  return { projects, issueTypes };
};

// All custom fields whose context covers the project. With field schemes on, a field must also be
// associated with the project's field scheme to be usable there, so only those are listed.
// prior: rows already described in an earlier, unfinished pass (fieldId -> row or null). deadline: stop taking new
// fields after this time, so a page request always answers; the caller continues in the next call.
export const fieldOverview = async (projectKey, { prior = {}, deadline = Infinity } = {}) => {
  const project = await J.getProject(projectKey);
  const [cache, schemeIds] = await Promise.all([loadCache(), J.fieldSchemeIdsForProject(project.id)]);
  let inScheme = null;
  if (schemeIds && schemeIds.length) {
    const sets = await Promise.all(schemeIds.map((s) => J.fieldIdsInScheme(s)));
    inScheme = new Set(sets.flatMap((s) => [...s]));
  }
  const all = await J.customFieldsForProject(project.id).catch(() => J.customFields());
  const candidates = all.filter((f) => !f.isLocked && (!inScheme || inScheme.has(f.id)));
  const out = { ...prior };
  const todo = candidates.filter((f) => !(f.id in out));
  await J.mapLimit(todo, 8, async (f) => {
    if (Date.now() > deadline) return;
    out[f.id] = await describeField(f, project, cache).catch((e) => ({ id: f.id, name: f.name, error: e.message.slice(0, 200) }));
  });
  const ids = new Set(candidates.map((f) => f.id));
  const rows = Object.entries(out).filter(([id, r]) => ids.has(id) && r).map(([, r]) => r);
  const done = candidates.filter((f) => f.id in out).length;
  return {
    project: { id: project.id, key: project.key, name: project.name },
    fieldSchemes: !!inScheme,
    fields: rows.sort((a, b) => a.name.localeCompare(b.name)),
    progress: { done, total: candidates.length },
    incomplete: done < candidates.length,
    described: out,
  };
};

export const fieldForProject = async (projectKey, fieldId) => {
  const project = await J.getProject(projectKey);
  const all = await J.customFields();
  const f = all.find((x) => x.id === fieldId);
  if (!f) throw new Error(`Field ${fieldId} not found.`);
  const row = await describeField(f, project, await loadCache());
  if (!row) throw new Error(`Field ${fieldId} has no context for project ${projectKey}.`);
  return { project, field: row };
};

export const optionTree = async (fieldId, contextId) => {
  const [opts, defaults] = await Promise.all([J.options(fieldId, contextId), J.getDefault(fieldId, contextId)]);
  return toTree(opts, defaults);
};

// Jira's default-value body for a field type; no option = remove the default.
const DEFAULT_TYPE = { select: 'option.single', radiobuttons: 'option.single', multiselect: 'option.multiple', multicheckboxes: 'option.multiple', cascadingselect: 'option.cascading' };
export const defaultBody = (typeKey, contextId, optionId, childId) => {
  const type = DEFAULT_TYPE[typeKey] || 'option.single';
  if (!optionId) return type === 'option.multiple' ? { type, contextId: String(contextId), optionIds: [] } : { type, contextId: String(contextId) };
  if (type === 'option.multiple') return { type, contextId: String(contextId), optionIds: [String(optionId)] };
  if (type === 'option.cascading') return { type, contextId: String(contextId), optionId: String(optionId), ...(childId ? { cascadingOptionId: String(childId) } : {}) };
  return { type, contextId: String(contextId), optionId: String(optionId) };
};

// ---------- case 2: execute an option plan ----------

export const executePlan = async (fieldId, contextId, plan) => {
  const current = await J.options(fieldId, contextId);
  const byId = Object.fromEntries(current.map((o) => [String(o.id), o]));
  const keyToId = {};
  const idOf = (k) => (k.startsWith('id:') ? k.slice(3) : keyToId[k]);
  // Re-runnable: an option that already exists with the same value (under the same parent) is reused, so a run
  // that failed half-way can simply be repeated without duplicates.
  const existing = (value, parentId) => current.find((o) => o.value.toLowerCase() === value.toLowerCase()
    && String(o.optionId || '') === String(parentId || ''));

  // 1. New parent / flat options, then new children (their parent may be new as well)
  const topAdds = plan.adds.filter((a) => !a.parentKey);
  topAdds.forEach((a) => { const hit = existing(a.value, null); if (hit) keyToId[a.key] = String(hit.id); });
  const topNew = topAdds.filter((a) => !keyToId[a.key]);
  if (topNew.length) {
    const res = await J.addOptions(fieldId, contextId, topNew.map((a) => ({ value: a.value, disabled: !!a.disabled })));
    topNew.forEach((a) => {
      const hit = res.options.find((o) => o.value === a.value);
      if (hit) keyToId[a.key] = String(hit.id);
    });
  }
  const childAdds = plan.adds.filter((a) => a.parentKey);
  childAdds.forEach((a) => { const hit = existing(a.value, a.parentId || idOf(a.parentKey)); if (hit) keyToId[a.key] = String(hit.id); });
  const childNew = childAdds.filter((a) => !keyToId[a.key]);
  if (childNew.length) {
    const body = childNew.map((a) => ({ value: a.value, disabled: !!a.disabled, optionId: a.parentId || idOf(a.parentKey) }));
    const res = await J.addOptions(fieldId, contextId, body);
    childNew.forEach((a, i) => {
      const hit = res.options.find((o) => o.value === a.value && String(o.optionId) === String(body[i].optionId));
      if (hit) keyToId[a.key] = String(hit.id);
    });
  }

  // 2. Text corrections, disable / enable: one update with the full state of each touched option
  const upd = {};
  const touch = (id) => {
    const o = byId[String(id)];
    if (!o) throw new Error(`Option ${id} no longer exists; reload and try again.`);
    upd[id] = upd[id] || { id: String(id), value: o.value, disabled: !!o.disabled };
    return upd[id];
  };
  plan.edits.forEach((e) => { touch(e.id).value = e.new; });
  plan.disables.forEach((d) => { touch(d.id).disabled = true; });
  plan.enables.forEach((d) => { touch(d.id).disabled = false; });
  if (Object.keys(upd).length) await J.updateOptions(fieldId, contextId, Object.values(upd));

  // 3. Order, per level
  for (const o of plan.orders) {
    const ids = o.keys.map(idOf).filter(Boolean);
    if (ids.length) await J.moveOptions(fieldId, contextId, ids);
  }

  // 4. Default value (after the adds: the new default may be a new option)
  if (plan.defaultChange) {
    const dc = plan.defaultChange;
    let body;
    if (!dc.toKey) body = defaultBody(dc.typeKey, contextId, null);
    else if (dc.toParentKey) body = defaultBody(dc.typeKey, contextId, idOf(dc.toParentKey), idOf(dc.toKey));
    else body = defaultBody(dc.typeKey, contextId, idOf(dc.toKey));
    if (dc.toKey && !(body.optionId || (body.optionIds || []).length)) throw new Error(`The new default "${dc.toValue}" could not be found; reload and try again.`);
    await J.setDefault(fieldId, [body]);
  }
  await rememberOptionState(fieldId, contextId).catch(() => null);
  return keyToId;
};

// ---------- case 1: create a new field ----------

const defaultValueFor = (draft, ctxId, created) => {
  const v = (draft.defaultValue || '').trim();
  if (!v) return null;
  const t = typeByKey(draft.typeKey);
  const find = (val, parent) => created.find((o) => o.value === val && (parent ? String(o.optionId) === String(parent) : !o.optionId));
  if (t.cascading) {
    const [p, c] = v.split('>').map((s) => s.trim());
    const po = find(p);
    if (!po) return null;
    const co = c ? find(c, po.id) : null;
    return { type: 'option.cascading', contextId: ctxId, optionId: String(po.id), ...(co ? { cascadingOptionId: String(co.id) } : {}) };
  }
  if (draft.typeKey === 'select' || draft.typeKey === 'radiobuttons') {
    const o = find(v);
    return o ? { type: 'option.single', contextId: ctxId, optionId: String(o.id) } : null;
  }
  if (draft.typeKey === 'multiselect' || draft.typeKey === 'multicheckboxes') {
    const ids = v.split(',').map((s) => find(s.trim())).filter(Boolean).map((o) => String(o.id));
    return ids.length ? { type: 'option.multiple', contextId: ctxId, optionIds: ids } : null;
  }
  if (draft.typeKey === 'textfield') return { type: 'textfield', contextId: ctxId, text: v };
  if (draft.typeKey === 'textarea') return { type: 'textarea', contextId: ctxId, text: v };
  if (draft.typeKey === 'float' && !Number.isNaN(Number(v))) return { type: 'float', contextId: ctxId, number: Number(v) };
  if (draft.typeKey === 'labels') return { type: 'labels', contextId: ctxId, labels: v.split(/[\s,]+/).filter(Boolean) };
  return null;
};

export const createNewField = async (draft, parsedOptions) => {
  const t = typeByKey(draft.typeKey);
  const field = await J.createField({
    name: draft.name.trim(), description: draft.description.trim(),
    type: fullType(t.key), searcherKey: fullSearcher(t.key),
  });
  const notes = [];
  const ctxs = await J.contexts(field.id);
  const globalCtx = ctxs.find((c) => c.isGlobalContext);
  let ctxId;
  if (draft.global) {
    ctxId = String(globalCtx.id);
  } else {
    const ctx = await J.createContext(field.id, {
      name: `${draft.name.trim()} - ${draft.projectKeys.join(' + ')}`,
      description: `Requested via Custom Field Self-Service for Jira: ${draft.justification.trim()}`.slice(0, 255),
      projectIds: draft.projectIds.map(String),
      issueTypeIds: (draft.issueTypeIds || []).map(String),
    });
    ctxId = String(ctx.id);
    if (globalCtx) {
      try {
        await J.deleteContext(field.id, globalCtx.id);
      } catch (e) {
        notes.push('Jira kept the empty global default context; the project context takes precedence.');
      }
    }
  }
  let created = [];
  if (t.options && parsedOptions.length) {
    const res = await J.addOptions(field.id, ctxId, parsedOptions.map((o) => ({ value: o.value })));
    created = res.options;
    if (t.cascading) {
      const kids = parsedOptions.flatMap((p) => {
        const parent = created.find((o) => o.value === p.value);
        return (p.children || []).map((c) => ({ value: c.value, optionId: String(parent.id) }));
      });
      if (kids.length) created = created.concat((await J.addOptions(field.id, ctxId, kids)).options);
    }
  }
  if (t.options) await rememberOptionState(field.id, ctxId).catch(() => null);
  const dv = defaultValueFor(draft, ctxId, created);
  if (dv) await J.setDefault(field.id, [dv]);
  else if ((draft.defaultValue || '').trim()) notes.push('The default value did not match an option and was not set.');

  // Field schemes: make the field usable in the selected projects.
  const schemes = new Set();
  for (const pid of draft.projectIds) {
    const ids = await J.fieldSchemeIdsForProject(pid);
    (ids || []).forEach((s) => schemes.add(Number(s)));
  }
  if (schemes.size) await J.associateWithSchemes(field.id, [...schemes]);
  return { fieldId: field.id, contextId: ctxId, options: created.length, notes };
};

// Used for green requests and for approved yellow ones.
export const createWithScreens = async (d, options) => {
  const res = await createNewField(d, options);
  if (d.addToScreens) {
    const added = [];
    const skipped = [];
    for (const pid of d.projectIds) {
      const r = await addFieldToScreens(res.fieldId, pid, d.issueTypeIds || [], Array.isArray(d.screenIds) ? d.screenIds : null).catch((e) => ({ added: [], skipped: [`(${e.message.slice(0, 80)})`] }));
      added.push(...r.added);
      skipped.push(...r.skipped);
    }
    res.screens = { added, skipped };
    if (added.length) res.notes.push(`Added to screens: ${added.join(', ')}.`);
    if (skipped.length) res.notes.push(`Not added to shared screens (used by other projects): ${skipped.join(', ')} - a Jira administrator can add it there.`);
  }
  // Text to dropdown: copy the old text values into the new field, in batches, through the 5-minute job.
  if (d.migrateFrom) {
    await kvs.set(`mig:${res.fieldId}`, { fromFieldId: d.migrateFrom, toFieldId: res.fieldId, toFieldName: d.name, contextId: res.contextId, typeKey: d.typeKey, projectKeys: d.projectKeys, moved: 0, skipped: 0, status: 'queued', created: Date.now() });
    res.notes.push(`Values of ${d.migrateFrom} are copied into the new field over the next minutes (work items where it is empty).`);
  }
  return res;
};

// ---------- reuse an existing field in a project ----------

// What it takes to make an existing field usable in a project: association with the project's field scheme(s)
// and, if the field has only project contexts, adding the project to one of them (that context is then shared).
export const planReuse = async (fieldId, projectKey) => {
  const project = await J.getProject(projectKey);
  const f = (await J.customFields()).find((x) => x.id === fieldId);
  if (!f) throw new Error(`Field ${fieldId} not found.`);
  if (f.isLocked) throw new Error(`"${f.name}" is managed by Jira or an app and can't be reused here.`);
  const [ctxs, mappings, cache, schemeIds] = await Promise.all([J.contexts(f.id), J.projectMappings(f.id), loadCache(), J.fieldSchemeIdsForProject(project.id)]);
  const own = mappings.find((m) => !m.isGlobalContext && String(m.projectId) === String(project.id));
  const globalCtx = ctxs.find((c) => c.isGlobalContext);
  let inScheme = true;
  if (schemeIds && schemeIds.length) {
    const sets = await Promise.all(schemeIds.map((s) => J.fieldIdsInScheme(s)));
    inScheme = sets.some((set) => set.has(f.id));
  }
  // On this site a field's global default context can't be deleted, so it often lingers without options while a
  // project context holds the real ones. For select-type fields such an empty global context doesn't count.
  const key = shortType(f.schema?.custom);
  const hasOptions = OPTION_TYPES.has(key) && isSystemType(f.schema?.custom);
  let usableGlobal = !!globalCtx;
  const projCtxs = ctxs.filter((c) => !c.isGlobalContext);
  let best = null;
  if (hasOptions && projCtxs.length) {
    const counts = await Promise.all(projCtxs.map(async (c) => ({ c, n: (await J.options(f.id, c.id)).length })));
    best = counts.sort((a, b) => b.n - a.n)[0];
    if (globalCtx && best.n > 0) usableGlobal = (await J.options(f.id, globalCtx.id)).length > 0;
  }
  let contextStep = null;
  if (!own && !usableGlobal) {
    if (!projCtxs.length) throw new Error(`"${f.name}" has no context that could be extended.`);
    const target = best ? best.c : projCtxs[0];
    const members = mappings.filter((m) => String(m.contextId) === String(target.id)).map((m) => cache.projects[String(m.projectId)]?.key || String(m.projectId));
    contextStep = { contextId: String(target.id), contextName: target.name, sharedWith: members };
  }
  return {
    field: { id: f.id, name: f.name, type: typeLabel(f.schema?.custom), typeKey: shortType(f.schema?.custom) },
    project: { id: String(project.id), key: project.key, name: project.name, issueTypes: project.issueTypes.map((t) => String(t.id)) },
    schemeIds: (schemeIds || []).map(Number),
    needsScheme: !inScheme,
    contextStep,
    via: own ? 'own context' : usableGlobal ? 'global context' : `context "${contextStep.contextName}"`,
    alreadyUsable: !!(own || usableGlobal) && inScheme,
  };
};

export const executeReuse = async (plan, addToScreens, issueTypeIds = []) => {
  const notes = [];
  if (plan.needsScheme && plan.schemeIds.length) {
    // Keep every existing association: the field stays in the schemes that already hold it.
    const holding = [];
    for (const s of await J.allFieldSchemes()) {
      if ((await J.fieldIdsInScheme(s.id)).has(plan.field.id)) holding.push(Number(s.id));
    }
    await J.associateWithSchemes(plan.field.id, [...new Set([...holding, ...plan.schemeIds])]);
    notes.push('Added to the project\'s field scheme.');
  }
  if (plan.contextStep) {
    await J.assignContextProjects(plan.field.id, plan.contextStep.contextId, [plan.project.id]);
    notes.push(`Project added to context "${plan.contextStep.contextName}" (now shared by ${[...plan.contextStep.sharedWith, plan.project.key].join(', ')}).`);
  }
  if (addToScreens) {
    const r = await addFieldToScreens(plan.field.id, plan.project.id, issueTypeIds).catch((e) => ({ added: [], skipped: [`(${e.message.slice(0, 80)})`] }));
    if (r.added.length) notes.push(`Added to screens: ${r.added.join(', ')}.`);
    if (r.skipped.length) notes.push(`Not added to shared screens: ${r.skipped.join(', ')}.`);
  }
  return notes;
};
