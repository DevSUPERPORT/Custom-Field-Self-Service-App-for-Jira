/**
 * Field details for everyone on the project page, and direct field administration for Jira administrators: name,
 * description, the spaces that use a field, the screens that show it, and taking it out of use. Every change is
 * logged with its inverse so the audit log can undo it in one click; fields are never deleted.
 *
 * @file        src/fieldadmin.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import { kvs } from '@forge/kvs';
import { route } from '@forge/api';
import * as J from './jira';
import { fieldForProject } from './fields';
import { writeLog } from './audit';
import { refresh } from './service';
import { announce, withFieldLock } from './ops';
import { projectScreens } from './insights';
import { ownScreenTargets, removalTargets } from './shared/screens';

const opId = () => `A${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296).toString(36).toUpperCase()}`;

const contextsWithProjects = async (fieldId) => {
  const [contexts, mappings, projects] = await Promise.all([J.contexts(fieldId), J.projectMappings(fieldId).catch(() => []), J.allProjects()]);
  return contexts.map((c) => ({
    id: String(c.id), name: c.name, global: !!c.isGlobalContext,
    projects: mappings.filter((m) => String(m.contextId) === String(c.id) && m.projectId)
      .map((m) => ({ id: String(m.projectId), key: projects[String(m.projectId)]?.key || String(m.projectId), name: projects[String(m.projectId)]?.name || '' })),
  }));
};

const fieldScreens = async (fieldId) => {
  const r = await J.app.get(route`/rest/api/3/field/${fieldId}/screens?expand=tab&maxResults=100`).catch(() => null);
  return r ? (r.values || []).map((s) => ({ id: String(s.id), name: s.name, tabId: s.tab ? String(s.tab.id) : null, tabName: s.tab?.name || '' })) : null;
};

// Everything about one field, for the details view (any field, not only those with options).
export const details = async ({ projectKey, fieldId, role, accountId }) => {
  const { field, project } = await fieldForProject(projectKey, fieldId);
  const n = String(fieldId).replace('customfield_', '');
  const [meta, contexts, screens, inProject, site] = await Promise.all([
    J.app.get(route`/rest/api/3/field/search?type=custom&id=${fieldId}&expand=lastUsed,screensCount,contextsCount,isLocked`).then((r) => (r.values || [])[0] || {}).catch(() => ({})),
    contextsWithProjects(fieldId).catch(() => []),
    fieldScreens(fieldId),
    J.countJql(`project = "${projectKey}" AND cf[${n}] is not EMPTY`).catch(() => null),
    J.countJql(`cf[${n}] is not EMPTY`).catch(() => null),
  ]);
  // Spaces and screens of other projects, and the site-wide count, only for Jira administrators; everyone else sees
  // the spaces they may browse and a count of the others.
  let shownContexts = contexts;
  let shownScreens = screens;
  if (role !== 'jira-admin') {
    const ok = new Set(await J.browsable(accountId, contexts.flatMap((c) => c.projects.map((p) => p.key))));
    shownContexts = contexts.map((c) => {
      const visible = c.projects.filter((p) => ok.has(p.key));
      const hidden = c.projects.length - visible.length;
      return { ...c, name: c.global || visible.length ? c.name : 'Context of other spaces', projects: visible, hiddenProjects: hidden };
    });
    shownScreens = null;
  }
  const shownField = role === 'jira-admin' ? field : { ...field, sharedWith: [] };
  const out = {
    field: shownField, projectId: String(project.id), description: meta.description ?? field.description ?? '', locked: !!meta.isLocked,
    lastUsed: (meta.lastUsed?.type === 'TRACKED' ? meta.lastUsed.value || null : null)
      || (inProject > 0 ? await J.latestUpdated(`project = "${projectKey}" AND cf[${n}] is not EMPTY`).catch(() => null) : null),
    contexts: shownContexts, screens: shownScreens, usage: { project: inProject, site: role === 'jira-admin' ? site : null },
  };
  // Jira administrators manage the field right there: this space's screens with whether the field is on them.
  if (role === 'jira-admin') {
    const own = await projectScreens(project.id, []).catch(() => []);
    const on = new Set((screens || []).map((s) => s.id));
    out.projectScreens = await J.mapLimit(own, 6, async (s) => ({
      screenId: String(s.screenId), name: await J.screenName(s.screenId).catch(() => String(s.screenId)), shared: !s.exclusive,
      operations: s.operations, onScreen: on.has(String(s.screenId)),
    }));
  }
  return out;
};

const contextKeys = async (fieldId, projectKey) => [...new Set([projectKey, ...(await contextsWithProjects(fieldId).catch(() => [])).flatMap((c) => c.projects.map((p) => p.key))])];

const record = async ({ projectKey, accountId, fieldId, fieldName, rows, inverse }) => {
  const id = opId();
  await kvs.set(`adminop:${id}`, { id, projectKey, fieldId, fieldName, inverse, by: accountId, at: Date.now() });
  await writeLog(projectKey, rows.map((r) => ({ ...r, actor: accountId, fieldId, fieldName, via: 'by a Jira administrator', executed: true, adminOp: id })));
  const keys = await contextKeys(fieldId, projectKey);
  await refresh(keys);
  await announce(keys, { type: 'changed', fieldId, by: accountId });
  return id;
};

// Name and description.
const applyUpdate = async (fieldId, { name, description }) => {
  const body = {};
  if (name !== undefined) body.name = name;
  if (description !== undefined) body.description = description;
  await J.app.put(route`/rest/api/3/field/${fieldId}`, body);
};
export const update = async ({ projectKey, accountId, fieldId, name, description }) => {
  const { field } = await fieldForProject(projectKey, fieldId);
  const before = await J.app.get(route`/rest/api/3/field/search?type=custom&id=${fieldId}`).then((r) => (r.values || [])[0] || {});
  const next = {};
  const rows = [];
  if (name !== undefined && String(name).trim() !== before.name) {
    const nm = String(name).replace(/\s+/g, ' ').trim();
    if (nm.length < 2 || nm.length > 255) throw new Error('The name needs 2 to 255 characters.');
    next.name = nm;
    rows.push({ action: 'Rename field', option: before.name, old: before.name, new: nm });
  }
  if (description !== undefined && String(description).trim() !== String(before.description || '').trim()) {
    next.description = String(description).trim();
    rows.push({ action: 'Description', option: before.name, old: before.description || '', new: next.description });
  }
  if (!rows.length) return { status: 'nochange' };
  await applyUpdate(fieldId, next);
  const inverse = { kind: 'update', fieldId, ...(next.name ? { name: before.name } : {}), ...(next.description !== undefined ? { description: before.description || '' } : {}) };
  const op = await record({ projectKey, accountId, fieldId, fieldName: next.name || field.name, rows, inverse });
  return { status: 'done', rows, op };
};

// Screens: add to this space's screens, remove from any screen ("take out of use" = remove from all).
const applyScreens = async (fieldId, { add = [], remove = [] }) => {
  const done = { add: [], remove: [] };
  for (const s of add) {
    const tabs = await J.screenTabs(s.screenId);
    const tabId = s.tabId || String(tabs?.[0]?.id || '');
    if (!tabId) throw new Error(`Screen ${s.screenId} has no tab to put the field on.`);
    await J.addTabField(s.screenId, tabId, fieldId).catch((e) => { if (!/already/i.test(e.message)) throw e; });
    done.add.push({ screenId: String(s.screenId), tabId });
  }
  for (const s of remove) {
    await J.app.del(route`/rest/api/3/screens/${s.screenId}/tabs/${s.tabId}/fields/${fieldId}`).catch((e) => { if (e.status !== 404) throw e; });
    done.remove.push({ screenId: String(s.screenId), tabId: String(s.tabId) });
  }
  return done;
};
export const screens = async ({ projectKey, accountId, fieldId, add = [], remove = [], removeAll = false }) => {
  const { field } = await fieldForProject(projectKey, fieldId);
  const current = (await fieldScreens(fieldId)) || [];
  const removeList = removeAll ? current.filter((s) => s.tabId).map((s) => ({ screenId: s.id, tabId: s.tabId, name: s.name })) : remove;
  const onIds = new Set(current.map((s) => s.id));
  const addList = add.filter((s) => !onIds.has(String(s.screenId)));
  if (!addList.length && !removeList.length) return { status: 'nochange' };
  const done = await applyScreens(fieldId, { add: addList, remove: removeList });
  const names = Object.fromEntries(current.map((s) => [s.id, s.name]));
  const rows = [
    ...done.add.map((s) => ({ action: 'Add to screen', option: field.name, old: '', new: addList.find((x) => String(x.screenId) === s.screenId)?.name || s.screenId })),
    ...done.remove.map((s) => ({ action: removeAll ? 'Take out of use' : 'Remove from screen', option: field.name, old: names[s.screenId] || s.screenId, new: '' })),
  ];
  const op = await record({ projectKey, accountId, fieldId, fieldName: field.name, rows, inverse: { kind: 'screens', fieldId, add: done.remove, remove: done.add } });
  return { status: 'done', rows, op };
};

// Field health, one field per call (the page loops with progress, so a long selection never hits the resolver's
// time limit): put the field on this space's own screens. Only screens this space uses alone are touched, whatever
// ids the caller sends; the step is logged and undoable like any other.
export const addToOwnScreens = async ({ projectKey, accountId, fieldId, screenIds = null }) => {
  if (!/^customfield_\d+$/.test(fieldId)) throw new Error(`"${fieldId}" is not a custom field ID.`);
  const project = await J.getProject(projectKey);
  const own = ownScreenTargets(await projectScreens(project.id, []), screenIds);
  if (!own.length) throw new Error('This space has no screens of its own to put the field on; shared screens are changed in Jira itself.');
  const add = await J.mapLimit(own, 6, async (s) => ({ screenId: String(s.screenId), name: await J.screenName(s.screenId).catch(() => String(s.screenId)) }));
  return withFieldLock(fieldId, 'add to screens', () => screens({ projectKey, accountId, fieldId, add }));
};

// Field health, one field per call: take the field out of use. Which screens it leaves is decided here, never by
// the page (see removalTargets): every screen when only this space uses the field, else this space's own screens.
// Logged and undoable like any other step; the values in work items stay.
export const takeOutOfUse = async ({ projectKey, accountId, fieldId }) => {
  if (!/^customfield_\d+$/.test(fieldId)) throw new Error(`"${fieldId}" is not a custom field ID.`);
  const project = await J.getProject(projectKey);
  const [contexts, current, own] = await Promise.all([contextsWithProjects(fieldId), fieldScreens(fieldId), projectScreens(project.id, [])]);
  if (current === null) throw new Error('Could not read the screens of this field. Try again.');
  const t = removalTargets({ contexts, projectId: project.id, current, own });
  if (!t.remove.length) return { status: 'nochange', mode: t.mode, kept: t.keep.map((s) => s.name) };
  const r = await withFieldLock(fieldId, 'take out of use', () => screens({ projectKey, accountId, fieldId, remove: t.remove.map((s) => ({ screenId: s.id, tabId: s.tabId })) }));
  return { ...r, mode: t.mode, kept: t.keep.map((s) => s.name) };
};

// Spaces: which projects a context applies to.
const applyProjects = async (fieldId, contextId, { add = [], remove = [] }) => {
  if (add.length) await J.assignContextProjects(fieldId, contextId, add);
  if (remove.length) await J.app.post(route`/rest/api/3/field/${fieldId}/context/${contextId}/project/remove`, { projectIds: remove.map(String) });
};
export const projects = async ({ projectKey, accountId, fieldId, contextId, add = [], remove = [] }) => {
  const { field } = await fieldForProject(projectKey, fieldId);
  const ctx = (await contextsWithProjects(fieldId)).find((c) => c.id === String(contextId));
  if (!ctx) throw new Error('This context no longer exists. Reload and try again.');
  if (ctx.global) throw new Error('A global context applies to every space already; choose spaces on a project context.');
  const have = new Set(ctx.projects.map((p) => p.id));
  const addIds = add.map(String).filter((id) => !have.has(id));
  const removeIds = remove.map(String).filter((id) => have.has(id));
  if (removeIds.length && removeIds.length >= ctx.projects.length) throw new Error('A context needs at least one space. Keep one, or take the field out of use instead.');
  if (!addIds.length && !removeIds.length) return { status: 'nochange' };
  await applyProjects(fieldId, contextId, { add: addIds, remove: removeIds });
  const all = await J.allProjects();
  const keyOf = (id) => all[id]?.key || id;
  const rows = [
    ...(addIds.length ? [{ action: 'Add spaces', option: `${field.name} (${ctx.name})`, old: '', new: addIds.map(keyOf).join(', ') }] : []),
    ...(removeIds.length ? [{ action: 'Remove spaces', option: `${field.name} (${ctx.name})`, old: removeIds.map(keyOf).join(', '), new: '' }] : []),
  ];
  const op = await record({ projectKey, accountId, fieldId, fieldName: field.name, rows, inverse: { kind: 'projects', fieldId, contextId: String(contextId), add: removeIds, remove: addIds } });
  return { status: 'done', rows, op };
};

// Undo of one administration step: its stored inverse operation.
export const undo = async ({ projectKey, accountId, id }) => {
  const op = await kvs.get(`adminop:${id}`);
  if (!op || op.projectKey !== projectKey) throw new Error('This change can no longer be undone from here.');
  if (op.undone) throw new Error('This change was already undone.');
  const inv = op.inverse;
  if (inv.kind === 'update') await applyUpdate(inv.fieldId, inv);
  else if (inv.kind === 'screens') await applyScreens(inv.fieldId, { add: inv.add, remove: inv.remove });
  else if (inv.kind === 'projects') await applyProjects(inv.fieldId, inv.contextId, { add: inv.add, remove: inv.remove });
  await kvs.set(`adminop:${id}`, { ...op, undone: Date.now(), undoneBy: accountId });
  await writeLog(projectKey, [{ action: 'Undo', option: op.fieldName, old: '', new: `administration step ${id}`, actor: accountId, fieldId: op.fieldId, fieldName: op.fieldName, via: 'undo by a Jira administrator', executed: true }]);
  const keys = await contextKeys(op.fieldId, projectKey);
  await refresh(keys);
  await announce(keys, { type: 'changed', fieldId: op.fieldId, by: accountId });
  return { status: 'undone' };
};

// Spaces for the pickers (Jira administrators).
export const allSpaces = async () => Object.entries(await J.allProjects()).map(([id, p]) => ({ id, key: p.key, name: p.name, type: p.type }))
  .sort((a, b) => a.key.localeCompare(b.key));
