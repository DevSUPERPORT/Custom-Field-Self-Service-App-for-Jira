/**
 * The self-service operations shared by the project page, Field Assistant and approved stage-1 requests: overview,
 * options, usage, new fields, reuse, undo, health and bundles. Every change runs through the guard rails before it
 * may execute directly.
 *
 * @file        src/service.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// The self-service operations, shared by the settings page (resolver), Field Assistant (plans) and approved
// stage-1 requests. Callers have checked the pilot scope; unless trusted is set, they have also checked AS THE USER
// that the caller administers projectKey. trusted = an approved stage-1 request: a project admin decided, and the
// approvals module verified that admin against the project's Administrators role.
//
// Every change runs through the guard rails (guards.js) before it may execute directly.
import { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import * as J from './jira';
import { fieldOverview, fieldForProject, optionTree, executePlan, createWithScreens, planReuse, executeReuse } from './fields';
import { computePlan, planIsEmpty, validateTree, describePlan } from './shared/options';
import { checkNewField } from './shared/guidelines';
import { matchCatalogue, findEntry } from './shared/catalogue';
import { shortType, typeByKey } from './shared/fieldtypes';
import { writeLog, readLog, requestsForProject, saveSnapshot, getSnapshot, pendingForField, markSeen } from './audit';
import { createApprovalRequest } from './approvals';
import { optionUsage, planImpact, fieldHealth, projectScreens, valueCounts, projectScreenFieldIds } from './insights';
import { inviteOtherSpaces } from './followups';
import { getSettings, isEnabledFor, setCatalogueFieldId } from './settings';
import { withFieldLock, announce } from './ops';
import { guardDecision, affectedByPlan, BY_JIRA_ADMIN, recordDirectChange } from './guards';

// An hourly job keeps the overview warm, so a page opens from the cache; own changes refresh it at once.
const OVERVIEW_TTL = 75 * 60 * 1000;

// ---------- overview ----------

// The overview is cached in chunks of 120 fields: one KVS value per chunk keeps every value small on sites with
// thousands of fields. A page request works for at most ~18 s and returns what it has with incomplete: true; the
// page then asks again (cont) and the next pass continues where this one stopped.
const CHUNK = 120;
const PAGE_BUDGET_MS = 18000;
const readChunks = async (key, meta) => {
  const parts = await Promise.all(Array.from({ length: meta.chunks }, (_, i) => kvs.get(`${key}:${i}`)));
  return Object.fromEntries(parts.flatMap((p) => (p || [])).map((r) => [r.id, r]));
};
const writeChunks = async (key, described, meta) => {
  const rows = Object.values(described).filter(Boolean);
  const chunks = Math.ceil(rows.length / CHUNK);
  await Promise.all(Array.from({ length: chunks }, (_, i) => kvs.set(`${key}:${i}`, rows.slice(i * CHUNK, (i + 1) * CHUNK))));
  // Fields described as "not in this project" are remembered by id only.
  const skipped = Object.entries(described).filter(([, r]) => !r).map(([id]) => id);
  await kvs.set(key, { ...meta, chunks, skipped: skipped.slice(0, 5000) });
};

export const overview = async (projectKey, fresh = false, { cont = false, budgetMs = PAGE_BUDGET_MS } = {}) => {
  const key = `cache:overview:${projectKey}`;
  markSeen(projectKey).catch(() => null);
  const meta = await kvs.get(key).catch(() => null);
  if (!fresh && meta && meta.complete && meta.chunks !== undefined && Date.now() - meta.at < OVERVIEW_TTL) {
    const rows = Object.values(await readChunks(key, meta));
    return { project: meta.project, fieldSchemes: meta.fieldSchemes, fields: rows.sort((a, b) => a.name.localeCompare(b.name)), cachedAt: meta.at, progress: meta.progress, incomplete: false };
  }
  let prior = {};
  if (cont && meta && !meta.complete && meta.chunks !== undefined && Date.now() - meta.started < 30 * 60 * 1000) {
    prior = await readChunks(key, meta);
    (meta.skipped || []).forEach((id) => { prior[id] = null; });
  }
  const started = Object.keys(prior).length ? meta.started : Date.now();
  const data = await fieldOverview(projectKey, { prior, deadline: Date.now() + budgetMs });
  const at = Date.now();
  await writeChunks(key, data.described, { at, started, complete: !data.incomplete, project: data.project, fieldSchemes: data.fieldSchemes, progress: data.progress }).catch(() => null);
  const { described, ...rest } = data;
  return { ...rest, cachedAt: at };
};

// Background jobs (nightly, pre-warm, self-test) need the whole list: keep continuing until it is complete.
export const overviewComplete = async (projectKey, fresh = true) => {
  let r = await overview(projectKey, fresh, { budgetMs: 120000 });
  for (let i = 0; r.incomplete && i < 20; i += 1) r = await overview(projectKey, false, { cont: true, budgetMs: 120000 });
  return r;
};

export const refresh = async (keys) => {
  await Promise.all(keys.flatMap((k) => [kvs.delete(`cache:overview:${k}`).catch(() => null), kvs.delete(`cache:optcat:${k}`).catch(() => null)]));
};

const viaText = (via, approvedBy) => (approvedBy ? `${via}, approved by a project admin` : via);

// ---------- case 2: options ----------

export const scopeKeys = (field, projectKey) => (field.scope === 'global' ? [] : (field.sharedWith.length ? field.sharedWith.map((p) => p.key) : [projectKey]));
const affected = (field, projectKey) => (scopeKeys(field, projectKey).length ? scopeKeys(field, projectKey) : [projectKey]);

export const getOptions = async (projectKey, fieldId) => {
  const { field } = await fieldForProject(projectKey, fieldId);
  if (!field.hasOptions) throw new Error('This field has no options.');
  const tree = await optionTree(field.id, field.contextId);
  const open = (await pendingForField(field.id)).map((p) => p.issueKey);
  return { field, tree, openRequests: open };
};

// Work items per option. For anyone but a Jira administrator, only the projects that person may browse are counted.
export const getUsage = async (projectKey, fieldId, { accountId, role } = {}) => {
  const { field, tree } = await getOptions(projectKey, fieldId);
  const all = scopeKeys(field, projectKey);
  const keys = role === 'jira-admin' || !accountId ? all : await J.browsable(accountId, all.length ? all : [projectKey]);
  const hidden = all.length ? all.length - keys.length : 0;
  return { field, ...(await optionUsage(field.id, tree, keys.length ? keys : [projectKey], field.cascading)), ...(hidden ? { note: `Counted in the ${keys.length} space(s) you can see; ${hidden} other space(s) share this field.` } : {}) };
};


const optionsRisk = (plan, impact) => {
  if (!plan.edits.length && !plan.disables.length) return 'low';
  return impact.length ? 'medium' : 'low';
};

const optionsBriefing = (field, projectKey, plan, usage, guard) => {
  const others = field.sharedWith.filter((p) => p.key !== projectKey);
  const impact = planImpact(plan, usage);
  const lines = [];
  if (field.scope === 'shared') lines.push(`Context "${field.contextName}" is shared by ${field.sharedWith.map((p) => p.key).join(', ')}; ${usage.total ?? 'unknown'} work item(s) there have a value in this field.`);
  else lines.push(`Context "${field.contextName}" belongs to ${projectKey} only; ${usage.total ?? 'unknown'} work item(s) have a value in this field.`);
  if (guard?.reasons?.length) lines.push(`Sent for approval by the guard rails: ${guard.reasons.join(' ')}`);
  lines.push(...impact);
  const risk = optionsRisk(plan, impact);
  if (risk === 'low' && !plan.edits.length && !plan.disables.length) lines.push('Risk: low. Only new options or a new order; no existing value changes. Recommendation: approve.');
  else if (risk === 'medium') lines.push(`Risk: medium. Existing values change or become unselectable${others.length ? ` in ${others.map((p) => p.key).join(', ')}` : ''}. Recommendation: approve once the people using this field agree.`);
  else lines.push('Risk: low. The edited or disabled options are not used in any work item. Recommendation: approve.');
  return { lines, risk };
};

// A context that belongs to this space alone: changing its options affects nobody else (UC-02).
export const ownsContext = (field, projectKey) => field.scope === 'project' && field.sharedWith.length === 1 && field.sharedWith[0].key === projectKey;

// How the caller may change a field's options: 'direct', 'approval' (a request for a Jira administrator) or
// 'readonly'. Jira administrators: any context. Project admins: their own space's contexts directly when the
// Jira administrators chose so on the admin page (projectAdminOptionEdits = 'direct'), everything else by request.
export const optionAccess = (settings, field, role, projectKey) => {
  if (!field.hasOptions || field.assets) return 'readonly';
  if (role === 'jira-admin') return 'direct';
  if (role !== 'project-admin') return 'readonly';
  return settings.projectAdminOptionEdits === 'direct' && ownsContext(field, projectKey) ? 'direct' : 'approval';
};

// The routing decision for an option plan, shared by the change itself and the preview.
// Jira administrators change options directly (any context, shared and global too); project admins only their own
// space's contexts and only when the admin page allows it (projectDirect). Both pass the guard rails (safe mode,
// two-person rule; the daily quota for project admins). Everything else is a request for a Jira administrator.
export const routeOptions = async ({ settings, field, plan, perOption, accountId, admin = false, projectDirect = false }) => {
  const affectedItems = affectedByPlan(plan, perOption);
  if (!admin && !projectDirect) return { route: 'approval', reasons: [field.scope === 'shared' ? `${BY_JIRA_ADMIN} The context is shared with ${field.sharedWith.length} other space(s), so the change affects them too.` : BY_JIRA_ADMIN], affectedItems };
  const guard = await guardDecision({ settings, accountId, affectedItems, admin });
  if (guard.approval) return { route: 'approval', reasons: guard.reasons, guard, affectedItems };
  return { route: 'direct', policy: null, affectedItems };
};

export const applyOptionChanges = async ({ projectKey, fieldId, contextId, tree, accountId, via = 'direct', undoOf = null, approvedBy = null }) => {
  const settings = await getSettings();
  const { field } = await fieldForProject(projectKey, fieldId);
  if (!field.hasOptions) throw new Error('This field has no options.');
  if (contextId && field.contextId !== String(contextId)) throw new Error('The field context changed meanwhile. Reload and try again.');
  // Jira administrators may change any context (global and shared too); for everyone else every change - also on a
  // global or shared context - is a request that a Jira administrator decides.
  const admin = await J.actsAsAdmin(accountId, approvedBy);
  // Checked again here, with Jira, at the moment of the change: the setting, a context of this space alone, and the
  // caller's "Administer projects" permission in this space.
  const projectDirect = !admin && !approvedBy && settings.projectAdminOptionEdits === 'direct' && ownsContext(field, projectKey)
    && (await J.isProjectAdmin(projectKey, accountId));
  const open = await pendingForField(field.id);
  if (open.length) throw new Error(`${open.map((p) => p.issueKey).join(', ')} is still waiting for approval on this field. Wait for that decision first, so the two changes can't clash.`);
  const errors = validateTree(tree, settings.rules);
  if (errors.length) return { status: 'invalid', errors };
  return withFieldLock(field.id, `${via} by ${projectKey}`, async () => {
    const original = await optionTree(field.id, field.contextId);
    const plan = computePlan(original, tree);
    if (planIsEmpty(plan)) return { status: 'nochange' };
    if (plan.defaultChange) plan.defaultChange.typeKey = field.typeKey;
    const rows = describePlan(plan);
    const usage = await optionUsage(field.id, original, scopeKeys(field, projectKey), field.cascading).catch(() => ({ perOption: {}, total: null }));
    const impact = planImpact(plan, usage);
    const decision = await routeOptions({ settings, field, plan, perOption: usage.perOption, accountId: approvedBy || accountId, admin, projectDirect });
    if (decision.route === 'approval') {
      const brief = optionsBriefing(field, projectKey, plan, usage, decision.guard);
      const issueKey = await createApprovalRequest({
        kind: 'options', projectKey, requester: accountId, approvedBy,
        summary: `${undoOf ? 'Undo: options' : 'Options'} of "${field.name}" (${field.id})${field.scope === 'shared' ? ' - shared context' : ''}, ${projectKey}`,
        reason: decision.reasons.join(' '),
        briefing: brief.lines, risk: brief.risk,
        rows, payload: { fieldId: field.id, fieldName: field.name, contextId: field.contextId, plan, before: original, undoOf, affected: affected(field, projectKey), usage: touchedUsage(plan, usage), usageTotal: usage.total ?? null },
      });
      await announce([projectKey], { type: 'requested', issueKey, fieldId: field.id });
      // The impact counts cover every project of the context: the approver sees them, the requester only if admin.
      return { status: 'pending', issueKey, rows, impact: admin ? impact : [], reasons: decision.reasons };
    }
    const batchId = await saveSnapshot({ projectKey, fieldId: field.id, fieldName: field.name, contextId: field.contextId, before: original });
    await executePlan(field.id, field.contextId, plan);
    const how = decision.policy ? `auto-approved by policy (${decision.policy})` : undoOf ? `undo of ${undoOf}` : projectDirect ? 'direct (project admin, own space)' : via;
    await writeLog(projectKey, rows.map((r) => ({ ...r, actor: accountId, approver: approvedBy || undefined, fieldId: field.id, fieldName: field.name, via: viaText(how, approvedBy), executed: true, batchId })));
    await recordDirectChange(approvedBy || accountId, settings); // the site-wide rate behind automatic safe mode
    await refresh(affected(field, projectKey));
    await announce(affected(field, projectKey), { type: 'changed', fieldId: field.id, by: accountId });
    return { status: 'done', rows, impact, batchId, policy: decision.policy, fieldName: field.name };
  });
};

// Work items per option, for the options a plan renames or retires only (kept with the request for the approver).
const touchedUsage = (plan, usage) => Object.fromEntries([...plan.edits, ...plan.disables].filter((x) => x.id != null && usage?.perOption?.[x.id] != null).map((x) => [x.id, usage.perOption[x.id]]));

// Undo an executed option change: back to the stored "before" state. Options added since can't be deleted
// (never offered), so they are disabled instead. Shared contexts go through approval again.
export const undoBatch = async ({ projectKey, batchId, accountId }) => {
  const snap = await getSnapshot(batchId);
  if (!snap || snap.projectKey !== projectKey) throw new Error('Nothing to undo for this entry.');
  if (snap.bulkId) throw new Error('This change is part of a bulk change: undo the whole bulk change instead.');
  const current = await optionTree(snap.fieldId, snap.contextId);
  const curIds = new Set(current.flatMap((p) => [p.key, ...p.children.map((c) => c.key)]));
  const target = snap.before
    .filter((p) => curIds.has(p.key))
    .map((p) => ({ ...p, children: p.children.filter((c) => curIds.has(c.key)) }));
  const known = new Set(target.flatMap((p) => [p.key, ...p.children.map((c) => c.key)]));
  current.forEach((p) => {
    if (!known.has(p.key)) target.push({ ...p, disabled: true, children: p.children.map((c) => ({ ...c, disabled: true })) });
    else {
      const t = target.find((x) => x.key === p.key);
      p.children.filter((c) => !known.has(c.key)).forEach((c) => t.children.push({ ...c, disabled: true }));
    }
  });
  return applyOptionChanges({ projectKey, fieldId: snap.fieldId, contextId: snap.contextId, tree: target, accountId, undoOf: batchId });
};

// Options of any field the project can see, to copy them into another field.
export const optionsOf = async (projectKey, fieldId) => {
  const { field, tree } = await getOptions(projectKey, fieldId);
  return { field: { id: field.id, name: field.name }, values: tree.filter((p) => !p.disabled).map((p) => ({ value: p.value, children: p.children.filter((c) => !c.disabled).map((c) => c.value) })) };
};

// ---------- reuse an existing field instead of creating a duplicate ----------

export const routeReuse = async ({ settings, plan, accountId, admin = false }) => {
  if (plan.contextStep) {
    const outside = plan.contextStep.sharedWith.filter((k) => !isEnabledFor(settings, k));
    if (outside.length) return { route: 'rejected', reasons: [admin ? `The context of "${plan.field.name}" belongs to ${outside.join(', ')}, outside the self-service. Ask a Jira administrator.` : `"${plan.field.name}" belongs to spaces outside the self-service. Ask a Jira administrator.`] };
  }
  if (!admin) return { route: 'approval', reasons: [BY_JIRA_ADMIN] };
  if (plan.contextStep) {
    if (!admin) return { route: 'approval', reasons: [`${plan.project.key} joins the context "${plan.contextStep.contextName}", which ${plan.contextStep.sharedWith.join(', ')} use. Its options then apply to all of them.`] };
  }
  const guard = await guardDecision({ settings, accountId, admin });
  if (guard.approval) return { route: 'approval', reasons: guard.reasons, guard };
  return { route: 'direct' };
};

export const reuseField = async ({ projectKey, fieldId, accountId, addToScreens = true, issueTypeIds = [], approvedBy = null, via = 'direct (reuse)' }) => {
  const settings = await getSettings();
  const plan = await planReuse(fieldId, projectKey);
  if (plan.alreadyUsable && !addToScreens) return { status: 'nochange', plan, notes: [`"${plan.field.name}" can already be used in ${projectKey} (${plan.via}).`] };
  const admin = await J.actsAsAdmin(accountId, approvedBy);
  const decision = await routeReuse({ settings, plan, accountId: approvedBy || accountId, admin });
  if (decision.route === 'rejected') return { status: 'rejected', plan, notes: decision.reasons };
  if (decision.route === 'approval') {
    const members = plan.contextStep ? plan.contextStep.sharedWith : [];
    const n = plan.field.id.split('_')[1];
    const used = members.length ? await J.countJql(`project in (${members.map((k) => `"${k}"`).join(',')}) AND cf[${n}] is not EMPTY`).catch(() => null) : null;
    const issueKey = await createApprovalRequest({
      kind: 'reuse', projectKey, requester: accountId, approvedBy,
      summary: `Reuse "${plan.field.name}" (${plan.field.id}) in ${projectKey}`,
      reason: decision.reasons.join(' '),
      risk: 'low',
      briefing: [
        `Reusing instead of creating a duplicate field keeps reports consistent${members.length ? ` across ${[...members, projectKey].join(', ')}` : ''}.`,
        ...(members.length ? [`${used ?? 'Unknown number of'} work item(s) in ${members.join(', ')} have a value in this field; joining does not change them.`] : []),
        ...(decision.guard ? [`Sent for approval by the guard rails: ${decision.guard.reasons.join(' ')}`] : []),
        `Risk: low. ${members.length ? 'Future option changes become shared and need approval. ' : ''}Recommendation: approve.`,
      ],
      rows: [{ action: 'Reuse field', option: plan.field.name, old: members.join(', '), new: [...members, projectKey].join(', ') }],
      payload: { fieldId: plan.field.id, fieldName: plan.field.name, plan, addToScreens, issueTypeIds, affected: [...members, projectKey] },
    });
    await announce([projectKey], { type: 'requested', issueKey, fieldId: plan.field.id });
    return { status: 'pending', issueKey, plan, reasons: decision.reasons };
  }
  const notes = await withFieldLock(plan.field.id, `reuse in ${projectKey}`, () => executeReuse(plan, addToScreens, issueTypeIds));
  await writeLog(projectKey, [{ action: 'Reuse field', option: plan.field.name, old: '', new: `usable in ${projectKey} (${plan.via})`, actor: accountId, approver: approvedBy || undefined, fieldId: plan.field.id, fieldName: plan.field.name, via: viaText(via, approvedBy), executed: true }]);
  await recordDirectChange(approvedBy || accountId, settings);
  await refresh([projectKey]);
  await announce([projectKey], { type: 'changed', fieldId: plan.field.id, by: accountId });
  return { status: 'done', plan, notes: notes.length ? notes : [`"${plan.field.name}" can now be used in ${projectKey}.`] };
};

// ---------- case 1: new fields ----------

export const guidelineContext = async () => {
  const [custom, system, settings] = await Promise.all([J.customFields(), J.systemFieldNames(), getSettings()]);
  return { customFields: custom.map((f) => ({ id: f.id, name: f.name, typeKey: shortType(f.schema?.custom) })), systemFieldNames: system, rules: settings.rules };
};

// A catalogue entry is pre-approved: its yellow findings (similar names, duplicates) are waived, except a global
// context. Red findings stay red.
const withCatalogue = (check, entry) => {
  if (!entry || check.result !== 'yellow') return { ...check, catalogue: entry ? entry.name : undefined };
  const left = check.findings.filter((f) => f.level === 'red' || f.code === 'global-context');
  const waived = check.findings.filter((f) => !left.includes(f));
  return {
    ...check,
    result: left.some((f) => f.level === 'red') ? 'red' : left.length ? 'yellow' : 'green',
    findings: [...left, ...waived.map((f) => ({ ...f, level: 'waived', message: `${f.message} (waived: "${entry.name}" is a pre-approved catalogue field)` }))],
    catalogue: entry.name,
  };
};

export const checkField = async (draft) => {
  const [ctx, settings] = await Promise.all([guidelineContext(), getSettings()]);
  const entry = matchCatalogue(settings.catalogue, draft.name, draft.typeKey);
  const check = withCatalogue(checkNewField(draft, ctx), entry && !entry.fieldId ? entry : null);
  if (entry?.fieldId) check.catalogueField = { id: entry.fieldId, name: entry.name };
  return check;
};

const fieldBriefing = (check, ctx) => {
  const lines = [];
  check.findings.filter((f) => f.level === 'yellow').forEach((f) => {
    const target = f.fieldId ? ctx.customFields.find((c) => c.id === f.fieldId) : null;
    if (f.code === 'similar-field' && target) lines.push(`"${target.name}" (${target.id}) already exists with the same type. Recommendation: decline and let the project reuse that field ("Use this field" in the app).`);
    else if (f.code === 'ai-similar' && target) lines.push(`Rovo sees "${target.name}" (${target.id}) as a possible duplicate in other wording or language. Recommendation: check whether it covers the need; if yes, decline and let the project reuse it.`);
    else if (f.code === 'global-context') lines.push('A global context makes the field available with these options in every project on the field schemes involved. Recommendation: approve only if most projects need it; otherwise ask for project contexts.');
    else if (f.code === 'name-taken') lines.push('The same name with another type makes JQL and filters ambiguous. Recommendation: ask for a distinct name.');
    else lines.push(f.message);
  });
  return lines;
};

export const requestNewField = async ({ projectKey, draft, accountId, trusted = false, approvedBy = null }) => {
  const settings = await getSettings();
  const keys = [...new Set((draft.projectKeys || []).filter(Boolean))];
  if (!keys.length) keys.push(projectKey);
  // Jira administrators create directly, for any project of the pilot; everyone else requests, and only for projects
  // they administer. Whoever approved a request counts as the actor for that decision.
  const admin = await J.actsAsAdmin(accountId, approvedBy);
  for (const k of keys) {
    if (!isEnabledFor(settings, k)) throw new Error(`${k} is not part of the self-service pilot.`);
  }
  // UC-04: the own space always, further spaces only those the requester may see, at most maxContextProjects in all.
  if (!trusted && !admin && !approvedBy) {
    await J.assertProjectAdmin(projectKey, accountId);
    if (!keys.includes(projectKey)) throw new Error(`A new field always applies to your own space ${projectKey}.`);
    const others = keys.filter((k) => k !== projectKey);
    const visible = new Set(await J.browsable(accountId, others));
    const hidden = others.filter((k) => !visible.has(k));
    if (hidden.length) throw new J.Forbidden(`You can't see ${hidden.join(', ')}, so you can't add ${hidden.length > 1 ? 'them' : 'it'} to a field.`);
  }
  if (!approvedBy && !trusted && !draft.global && keys.length > settings.maxContextProjects) {
    throw new Error(`At most ${settings.maxContextProjects} spaces per field, ${projectKey} included. Remove ${keys.length - settings.maxContextProjects}.`);
  }
  for (const k of keys.filter((x) => x !== projectKey)) {
    const st = await J.projectStyle(k).catch(() => null);
    if (st && J.isTeamManaged(st)) throw new Error(`${k} is a team-managed space: its fields belong to the space itself.`);
  }
  if (trusted && keys.some((k) => k !== projectKey)) throw new Error('An approved request only applies to its own project.');
  // A catalogue entry that already exists as a field: reuse it instead of creating another copy.
  const entry = matchCatalogue(settings.catalogue, draft.name, draft.typeKey);
  if (entry?.fieldId && !draft.global) {
    const r = await reuseField({ projectKey, fieldId: entry.fieldId, accountId, addToScreens: draft.addToScreens !== false, issueTypeIds: draft.issueTypeIds || [], approvedBy, via: `catalogue "${entry.name}" (reuse)` });
    return { ...r, status: r.status === 'done' ? 'reused' : r.status, fieldId: entry.fieldId, catalogue: entry.name };
  }
  const projects = await Promise.all(keys.map((k) => J.getProject(k)));
  const d = { ...draft, projectKeys: keys, projectIds: projects.map((p) => String(p.id)) };
  // UC-05: only screens the own space uses alone. The other spaces' admins add it to theirs (follow-ups).
  if (d.addToScreens !== false) {
    const own = projects.find((p) => p.key === projectKey);
    const exclusive = own ? (await projectScreens(own.id, d.issueTypeIds || []).catch(() => [])).filter((s) => s.exclusive).map((s) => String(s.screenId)) : [];
    d.screenIds = Array.isArray(d.screenIds) ? d.screenIds.map(String).filter((id) => exclusive.includes(id)) : exclusive;
    d.addToScreens = d.screenIds.length > 0;
  }
  const otherKeys = d.global ? [] : keys.filter((k) => k !== projectKey);
  const ctx = await guidelineContext();
  const check = withCatalogue(checkNewField(d, ctx), entry);
  const reuse = check.findings.find((f) => (f.code === 'similar-field' || f.code === 'ai-similar') && f.fieldId && f.level === 'yellow');
  const rows = [
    { action: 'New field', option: d.name, old: '', new: `${typeByKey(d.typeKey)?.label || d.typeKey}; ${d.global ? 'global context' : `context ${keys.join(', ')}`}${d.addToScreens ? `; add to ${Array.isArray(d.screenIds) ? `${d.screenIds.length} screen(s)` : 'screens'}` : ''}${(d.issueTypeIds || []).length ? `; ${d.issueTypeIds.length} issue type(s)` : ''}${entry ? `; catalogue "${entry.name}"` : ''}` },
    ...(check.options.length ? [{ action: 'Options', option: d.name, old: '', new: check.options.map((o) => (typeof o === 'string' ? o : o.value || [o.parent, o.child].filter(Boolean).join(' > '))).join(', ').slice(0, 900) }] : []),
    ...(d.defaultValue ? [{ action: 'Default', option: d.name, old: '', new: d.defaultValue }] : []),
    ...(d.migrateFrom ? [{ action: 'Copy values', option: d.name, old: d.migrateFrom, new: 'the existing values of this text field are copied into the new field' }] : []),
    ...(otherKeys.length ? [{ action: 'Other spaces', option: d.name, old: '', new: `${otherKeys.join(', ')}: their project admins are told and add it to their own screens` }] : []),
  ];
  if (check.result === 'red') return { status: 'rejected', check };
  let reasons = check.findings.filter((f) => f.level === 'yellow').map((f) => f.message);
  let guard = null;
  // A Jira administrator sees the warnings first and creates anyway only when confirmed (confirmWarnings).
  if (admin && check.result === 'yellow' && !draft.confirmWarnings && !approvedBy) return { status: 'confirm', check };
  if (admin) {
    guard = await guardDecision({ settings, accountId: approvedBy || accountId, admin });
    if (guard.approval) reasons = guard.reasons;
  } else reasons = [BY_JIRA_ADMIN, ...reasons];
  if (!admin || guard?.approval) {
    const issueKey = await createApprovalRequest({
      kind: 'field', projectKey, requester: accountId, approvedBy,
      summary: `New custom field "${d.name}" for ${keys.join(', ')}`,
      reason: reasons.join(' '),
      risk: d.global ? 'medium' : 'low',
      briefing: [...fieldBriefing(check, ctx), ...(guard?.approval ? [`Sent for approval by the guard rails: ${guard.reasons.join(' ')}`] : [])],
      rows: [...rows, { action: 'Justification', option: '', old: '', new: d.justification }],
      payload: { draft: d, options: check.options, affected: keys, catalogueId: entry?.id },
    });
    await announce([projectKey], { type: 'requested', issueKey });
    return { status: 'pending', issueKey, check, reuseFieldId: reuse?.fieldId, reasons };
  }
  const res = await createWithScreens(d, check.options);
  if (entry) await setCatalogueFieldId(entry.id, res.fieldId).catch(() => null);
  if (otherKeys.length) res.invited = await inviteOtherSpaces({ fieldId: res.fieldId, fieldName: d.name, keys, origin: projectKey, actor: accountId }).catch(() => []);
  await writeLog(projectKey, rows.map((r) => ({ ...r, actor: accountId, approver: approvedBy || undefined, fieldId: res.fieldId, fieldName: d.name, via: viaText(entry ? `catalogue "${entry.name}"` : 'by a Jira administrator', approvedBy), executed: true })));
  await recordDirectChange(approvedBy || accountId, settings);
  await refresh(keys);
  await announce(keys, { type: 'changed', fieldId: res.fieldId, by: accountId });
  return { status: 'created', ...res, check };
};

// ---------- onboarding bundle: several catalogue fields in one go ----------

// Items that may run directly do so; everything that needs approval goes into ONE approval request.
export const runBundle = async ({ projectKey, entryRefs, accountId, approvedBy = null, addToScreens = true }) => {
  const settings = await getSettings();
  const project = await J.getProject(projectKey);
  const ctx = await guidelineContext();
  const results = [];
  const queued = [];
  const admin = await J.actsAsAdmin(accountId, approvedBy);
  for (const ref of entryRefs) {
    const entry = findEntry(settings.catalogue, ref);
    if (!entry) { results.push({ item: ref, status: 'unknown', note: 'not in the catalogue' }); continue; }
    try {
      if (entry.fieldId) {
        const plan = await planReuse(entry.fieldId, projectKey);
        if (plan.alreadyUsable) { results.push({ item: entry.name, status: 'already there', note: plan.via }); continue; }
        const decision = await routeReuse({ settings, plan, accountId: approvedBy || accountId, admin });
        if (decision.route === 'rejected') { results.push({ item: entry.name, status: 'rejected', note: decision.reasons.join(' ') }); continue; }
        if (decision.route === 'approval') { queued.push({ kind: 'reuse', entry, plan, reason: decision.reasons.join(' ') }); continue; }
        const notes = await withFieldLock(plan.field.id, `bundle in ${projectKey}`, () => executeReuse(plan, addToScreens, []));
        await writeLog(projectKey, [{ action: 'Reuse field', option: entry.name, old: '', new: `usable in ${projectKey}`, actor: accountId, approver: approvedBy || undefined, fieldId: plan.field.id, fieldName: plan.field.name, via: viaText(`bundle: catalogue "${entry.name}"`, approvedBy), executed: true }]);
        results.push({ item: entry.name, status: 'done', fieldId: plan.field.id, note: notes.join(' ') });
      } else {
        const d = {
          name: entry.name, description: entry.description, typeKey: entry.typeKey, optionsText: entry.options.join('\n'), defaultValue: '',
          justification: `Standard field "${entry.name}" from the catalogue (onboarding bundle).`, global: false, addToScreens,
          projectKeys: [projectKey], projectIds: [String(project.id)], issueTypeIds: [],
        };
        const check = withCatalogue(checkNewField(d, ctx), entry);
        if (check.result === 'red') { results.push({ item: entry.name, status: 'rejected', note: check.findings.filter((f) => f.level === 'red').map((f) => f.message).join(' ') }); continue; }
        if (!admin) { queued.push({ kind: 'field', entry, draft: d, options: check.options, reason: BY_JIRA_ADMIN }); continue; }
        const guard = await guardDecision({ settings, accountId: approvedBy || accountId, admin });
        if (check.result === 'yellow' || guard.approval) { queued.push({ kind: 'field', entry, draft: d, options: check.options, reason: guard.approval ? guard.reasons.join(' ') : check.findings.filter((f) => f.level === 'yellow').map((f) => f.message).join(' ') }); continue; }
        const res = await createWithScreens(d, check.options);
        await setCatalogueFieldId(entry.id, res.fieldId).catch(() => null);
        await writeLog(projectKey, [{ action: 'New field', option: entry.name, old: '', new: `${typeByKey(entry.typeKey)?.label}; catalogue`, actor: accountId, approver: approvedBy || undefined, fieldId: res.fieldId, fieldName: entry.name, via: viaText(`bundle: catalogue "${entry.name}"`, approvedBy), executed: true }]);
        results.push({ item: entry.name, status: 'created', fieldId: res.fieldId, note: res.notes.join(' ') });
      }
    } catch (e) {
      results.push({ item: entry.name, status: 'error', note: e.message.slice(0, 200) });
    }
  }
  let issueKey = null;
  if (queued.length) {
    issueKey = await createApprovalRequest({
      kind: 'bundle', projectKey, requester: accountId, approvedBy,
      summary: `Onboarding bundle for ${projectKey}: ${queued.map((q) => q.entry.name).join(', ')}`.slice(0, 250),
      reason: queued.map((q) => `${q.entry.name}: ${q.reason}`).join(' '),
      risk: 'low',
      briefing: ['All items are pre-approved catalogue fields; approval is needed only for the reasons listed per item.', 'Risk: low. Recommendation: approve.'],
      rows: queued.map((q) => ({ action: q.kind === 'reuse' ? 'Reuse field' : 'New field', option: q.entry.name, old: '', new: q.reason })),
      payload: { items: queued.map((q) => ({ kind: q.kind, entryId: q.entry.id, entryName: q.entry.name, plan: q.plan, draft: q.draft, options: q.options })), addToScreens, affected: [projectKey] },
    });
    queued.forEach((q) => results.push({ item: q.entry.name, status: 'sent for approval', request: issueKey }));
    await announce([projectKey], { type: 'requested', issueKey });
  }
  await refresh([projectKey]);
  if (results.some((r) => ['done', 'created'].includes(r.status))) await announce([projectKey], { type: 'changed', by: accountId });
  return { status: issueKey ? (results.some((r) => ['done', 'created'].includes(r.status)) ? 'partly pending' : 'pending') : 'done', results, issueKey };
};

// System fields, read-only in the overview (UC-01). The same for every space; kept for an hour.
let systemMemo = null;
export const systemFieldRows = async () => {
  if (!systemMemo || Date.now() - systemMemo.at > 3600000) {
    const list = await J.systemFields();
    systemMemo = { at: Date.now(), rows: list.map((f) => ({ id: f.id, name: f.name, type: 'System field', schemaType: f.schemaType, scope: 'system', sharedWith: [], issueTypes: ['All'], hasOptions: false, optionCount: null, access: 'readonly', system: true })) };
  }
  return systemMemo.rows;
};

// ---------- health, log, stats ----------

// Jira administrators: every field of the site. Project administrators: only the fields this space uses, from the
// overview (the Fields tab's cached list, kept warm hourly) and this space's screens.
export const health = async (projectKey, role = 'project-admin') => {
  const p = await J.getProject(projectKey);
  let project = null;
  if (role !== 'jira-admin') {
    const [ov, onScreens] = await Promise.all([overview(projectKey, false), projectScreenFieldIds(p.id).catch(() => null)]);
    project = { key: projectKey, fields: ov.fields, onScreens, incomplete: !!ov.incomplete };
  }
  const [h, suggestions] = await Promise.all([fieldHealth(p.id, { project }), kvs.get(`suggest:${projectKey}`)]);
  return { ...h, suggestions: suggestions || null };
};

// The space's log and requests. Only what the page shows is read: no Jira search, no approval-space lookup, so the
// tab opens fast even with many requests.
export const auditData = async (projectKey) => {
  const [log, requests, settings] = await Promise.all([readLog(projectKey, 500), requestsForProject(projectKey), getSettings()]);
  const ids = [...new Set([...log.flatMap((l) => [l.actor, l.approver]), ...requests.map((r) => r.requester)].filter(Boolean))];
  const names = await namesOf(ids);
  return { log, requests, names, stats: stats(log, settings) };
};

// Display names, 50 people per request (the audit log, inbox and requests each name many people); one at a time
// only for the few the bulk lookup did not return.
export const namesOf = async (ids) => {
  const names = {};
  const all = [...new Set(ids.filter(Boolean).map(String))];
  const chunks = [];
  for (let i = 0; i < all.length; i += 50) chunks.push(all.slice(i, i + 50));
  await J.mapLimit(chunks, 3, async (chunk) => {
    const q = new URLSearchParams([...chunk.map((id) => ['accountId', id]), ['maxResults', '50']]);
    const r = await J.app.get(route`/rest/api/3/user/bulk?${q}`).catch(() => null);
    (r?.values || []).forEach((u) => { names[u.accountId] = u.displayName; });
  });
  await J.mapLimit(all.filter((id) => names[id] === undefined), 5, async (id) => {
    const u = await J.app.get(route`/rest/api/3/user?accountId=${id}`).catch(() => null);
    names[id] = u ? u.displayName : id;
  });
  return names;
};

// Time saved: every change done here would otherwise be a SUPERPORT ticket. The basis is set on the admin page.
export const stats = (log, settings) => {
  const ticket = settings.minutesPerTicket;
  const approval = settings.minutesPerApproval;
  const executed = log.filter((l) => l.executed);
  const self = new Set(executed.filter((l) => !String(l.via).startsWith('approved')).map((l) => l.batchId || `${l.ts}`)).size;
  const approved = new Set(executed.filter((l) => String(l.via).startsWith('approved')).map((l) => l.via)).size;
  const minutes = self * ticket + approved * Math.max(0, ticket - approval);
  return { selfService: self, approved, minutes, basis: { ticket, approval } };
};

// ---------- hourly pre-warm ----------

export const prewarm = async (projectKeys) => {
  const done = [];
  for (const k of projectKeys) {
    try {
      await overviewComplete(k, true);
      done.push(k);
    } catch (e) {
      // a project may have been deleted or the app lost access; skip it
    }
  }
  // Field health counts the work items with a value per field (site-wide for Jira administrators, per space for
  // project administrators); counting them here keeps the tab fast.
  const fields = (await J.fieldsWithUsage().catch(() => [])).filter((f) => !f.isLocked).map((f) => f.id);
  await valueCounts(fields, { budgetMs: 240000 }).catch(() => null);
  for (const k of done) {
    const ov = await overview(k, false).catch(() => null);
    const ids = new Set((ov?.fields || []).map((f) => f.id));
    await valueCounts(fields.filter((id) => ids.has(id)), { budgetMs: 120000, projectKey: k }).catch(() => null);
  }
  return done;
};
