/**
 * Field Assistant's Rovo actions: the read actions, the previews that store a plan, and the single write action that
 * submits a plan by its ID. Every action is wrapped in the kill switch, and the role always comes from Jira, never
 * from the model's inputs.
 *
 * @file        src/actions.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Rovo agent "Field Assistant": actions over the same service as the settings page.
// Inputs come from the LLM and are never trusted: identity comes from Jira, every action checks AS THE USER that
// the caller can see the project, and only previews take free inputs. The one write action, submit-plan, takes a
// plan ID and nothing else, so the model can't change what the user saw and agreed to (see planner.js).
import { route } from '@forge/api';
import * as J from './jira';
import * as S from './service';
import * as P from './planner';
import { CREATABLE, typeByKey } from './shared/fieldtypes';
import { similarity } from './shared/guidelines';
import { cleanupSuggestions } from './shared/health';
import { guidelinesMarkdown } from './shared/guidelinesDoc';
import { getSettings, isEnabledFor } from './settings';
import { getDraft } from './plans';
import { getPending, requestsForProject } from './audit';
import { safeModeState } from './guards';
import { runSiteCheck, lastSiteCheck, applyFixes } from './sitecheck';
import { gateAction } from './maintenance';
import { licenseRefusal } from './license';

// Kill switch (maintenance.js): every exported action is wrapped in gateAction(kind, ...). 'read' actions still answer
// while changes are paused; 'write' actions are refused then. The previews count as writes: they store a plan and the
// user's draft, and exist only to lead to a change that could not be submitted anyway.

const me =async () => J.user.get(route`/rest/api/3/myself`);

const run = (fn) => async (payload) => {
  const unlicensed = licenseRefusal(payload?.context);
  if (unlicensed) return unlicensed;
  try {
    const projectKey = String(payload?.projectKey || payload?.context?.jira?.projectKey || '').trim().toUpperCase();
    if (!projectKey) return { error: 'Which project? Ask the user for the project key.' };
    const settings = await getSettings();
    if (!isEnabledFor(settings, projectKey)) return { error: `Custom Field Self-Service for Jira is not enabled for ${projectKey} ${settings.configured ? `(it runs in: ${settings.enabledProjects.join(', ') || 'all projects'})` : '(not set up on this site yet)'}. Nothing was changed. Your Jira administrators handle fields of other projects.` };
    if (!(await J.canBrowse(projectKey))) return { error: `You can't see project ${projectKey}. Nothing was changed.` };
    const { accountId } = await me();
    // The role comes from Jira for every call: Jira administrators change directly, project admins request (a Jira
    // administrator approves), everyone else asks their project admins first.
    const role = await J.roleOf(projectKey, accountId);
    const isAdmin = role !== 'none';
    const safe = await safeModeState(settings);
    const out = await fn({ projectKey, input: payload || {}, accountId, isAdmin, role, settings });
    const you = { 'jira-admin': 'Jira administrator: changes go live directly (guard rails still apply)', 'project-admin': `project admin of ${projectKey}: every change is a request that a Jira administrator approves`, none: `not a project admin of ${projectKey}: requests go to the project admins first` }[role];
    return { ...out, you, ...(safe.on ? { safeMode: `ON (${safe.reason}): every change needs a Jira administrator's approval` } : {}) };
  } catch (e) {
    return { error: e.message, nothingChanged: true };
  }
};

const findField = async (projectKey, ref) => {
  const ov = await S.overview(projectKey);
  const r = String(ref || '').trim().toLowerCase();
  const hits = ov.fields.filter((f) => f.id.toLowerCase() === r || f.name.toLowerCase() === r);
  if (hits.length === 1) return hits[0];
  const near = ov.fields.filter((f) => f.name.toLowerCase().includes(r)).slice(0, 8).map((f) => `${f.name} (${f.id})`);
  throw new Error(hits.length ? `Several fields match "${ref}". Use the field ID.` : `No field "${ref}" in ${projectKey}.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`);
};

// ---------- read ----------

// Other spaces sharing a field: named only if the person may browse them (Jira administrators see all).
const visibleKeys = async (keys, accountId, role) => {
  if (role === 'jira-admin') return keys;
  const ok = new Set(await J.browsable(accountId, keys));
  const shown = keys.filter((k) => ok.has(k));
  return keys.length > shown.length ? [...shown, `${keys.length - shown.length} other space(s)`] : shown;
};

export const listFields = gateAction('read', run(async ({ projectKey, accountId, role }) => {
  const ov = await S.overview(projectKey);
  const fields = ov.fields.filter((f) => !f.error);
  return {
    project: ov.project,
    note: role === 'jira-admin' ? 'You are a Jira administrator: option changes go live directly (guard rails still apply).' : 'Every option change by a project admin is a request that a Jira administrator approves.',
    fields: await Promise.all(fields.map(async (f) => ({
      id: f.id, name: f.name, type: f.type, scope: f.scope, sharedWith: await visibleKeys(f.sharedWith.map((p) => p.key), accountId, role),
      options: f.optionCount ? `${f.optionCount.active} active / ${f.optionCount.disabled} disabled` : undefined,
    }))),
    sources: { readAt: new Date(ov.cachedAt).toISOString(), from: `field contexts of ${projectKey}` },
  };
}));

export const fieldOptions = gateAction('read', run(async ({ projectKey, input, accountId, role }) => {
  const f = await findField(projectKey, input.field);
  const { field, perOption, total } = await S.getUsage(projectKey, f.id, { accountId, role });
  const { tree, openRequests } = await S.getOptions(projectKey, f.id);
  const show = (o) => ({ value: o.value, disabled: o.disabled, workItems: perOption[o.id] ?? null });
  return {
    field: { id: field.id, name: field.name, type: field.type, scope: field.scope, sharedWith: await visibleKeys(field.sharedWith.map((p) => p.key), accountId, role) },
    workItemsWithAValue: total,
    unusedOptions: tree.filter((o) => !o.disabled && perOption[o.id] === 0).map((o) => o.value),
    openRequests,
    options: tree.map((p) => ({ ...show(p), ...(field.cascading ? { children: p.children.map(show) } : {}) })),
    sources: { counts: 'work items per option, in the spaces you can see' },
  };
}));

export const findSimilarFields = gateAction('read', run(async ({ input, settings }) => {
  const ctx = await S.guidelineContext();
  const key = P.typeKeyOf(input.fieldType);
  const name = String(input.name || '');
  const sameType = ctx.customFields.filter((f) => !key || f.typeKey === key);
  const catalogue = settings.catalogue.filter((e) => !key || e.typeKey === key).map((e) => ({ name: e.name, fieldId: e.fieldId || 'created on first use', score: Number(similarity(name, e.name).toFixed(2)) })).sort((a, b) => b.score - a.score).slice(0, 5);
  return {
    instruction: 'Judge which of these could mean the same as the requested name in any language or wording (e.g. Kostenstelle = Cost centre). If one does, tell the user and offer preview-reuse; or pass its id as similarToFieldId to preview-new-field. Catalogue fields are pre-approved standards: prefer them.',
    requested: { name, fieldType: key },
    catalogue,
    closeByEditDistance: sameType.map((f) => ({ ...f, score: Number(similarity(name, f.name).toFixed(2)) })).filter((f) => f.score >= 0.6).sort((a, b) => b.score - a.score).slice(0, 10),
    allFieldsOfThisType: sameType.slice(0, 300).map((f) => `${f.name} (${f.id})`),
  };
}));

export const fieldHealthAction = gateAction('read', run(async ({ projectKey, role }) => {
  if (role === 'none') return { error: `Field health is for the project admins of ${projectKey}.` };
  const h = await S.health(projectKey, role);
  return {
    scope: h.scope === 'project' ? `only the fields ${projectKey} uses, counted in ${projectKey}` : 'every custom field of the site, counted site-wide',
    siteCustomFields: h.siteCustomFields, projectFields: h.projectFields, flagged: h.flagged,
    rows: h.rows.filter((r) => r.flags.length).slice(0, 40).map((r) => ({ id: r.id, name: r.name, type: r.type, lastUsed: r.lastUsed, workItemsWithValue: r.values, flags: r.flags.map((x) => x.text) })),
    cleanup: cleanupSuggestions(h.rows).map((s) => ({ kind: s.kind, fields: s.fieldIds.length, examples: s.fieldIds.slice(0, 8) })),
    suggestions: h.suggestions ? h.suggestions.items.slice(0, 8).map((x) => (x.kind === 'text' ? `Text field ${x.fieldName} (${x.fieldId}) holds only ${x.values.length} values in ${x.items} work items: could be a dropdown` : `People type "${x.key}: …" ${x.count} times in recent work items${role === 'jira-admin' ? ` (${x.values.slice(0, 5).map((v) => v.value).join(', ')})` : ''}: could be a field`)) : [],
    sources: { unused: h.scope === 'project' ? `work items of ${projectKey} with a value (JQL project = ${projectKey} AND cf[id] is not EMPTY), counted by the app` : 'work items with a value on the whole site (JQL cf[id] is not EMPTY), counted by the app', lastUsed: 'Jira field usage tracking (not tracked for most fields)', cleanupKinds: 'hidden = values but on no screen; retire = no value and on no screen; empty = on screens but never filled; duplicate = similar name and type; stale = not used for 180+ days', suggestions: h.suggestions ? `nightly scan ${new Date(h.suggestions.at).toISOString().slice(0, 10)}` : 'not scanned yet' },
  };
}));

export const guidelinesAction = gateAction('read', async () => {
  const settings = await getSettings();
  return {
    guidelines: guidelinesMarkdown(settings),
    typeKeysForInputs: CREATABLE.filter((t) => settings.rules.allowedTypes.includes(t.key)).map((t) => `${t.key} = ${t.label}`),
    catalogue: settings.catalogue.map((e) => `${e.name} (${typeByKey(e.typeKey)?.label}${e.options.length ? `: ${e.options.join(', ')}` : ''})${e.fieldId ? ` = ${e.fieldId}` : ''}`),
  };
});

// The user's own requests (all pilot projects, or one) and their saved draft.
export const myRequestsAction = gateAction('read', async (payload) => {
  try {
    const settings = await getSettings();
    const { accountId } = await me();
    const keys = payload?.projectKey ? [String(payload.projectKey).toUpperCase()] : settings.enabledProjects;
    if (payload?.projectKey && !(await J.canBrowse(keys[0]))) return { error: `You can't see project ${keys[0]}.` };
    const all = (await Promise.all(keys.map((k) => requestsForProject(k, 30)))).flat().filter((r) => r.requester === accountId);
    const draft = await getDraft(accountId);
    const site = await P.siteUrl();
    const admins = payload?.projectKey ? await J.projectAdmins(keys[0], 10).catch(() => ({ users: [] })) : null;
    return {
      requests: all.sort((a, b) => b.created - a.created).slice(0, 15).map((r) => ({
        request: r.issueKey, link: `${site}/browse/${r.issueKey}`, summary: r.summary, status: r.status, stage: r.stage === 'admin' ? 'project admin approval' : 'Jira administrator approval',
        created: new Date(r.created).toISOString().slice(0, 16).replace('T', ' '), ...(r.stage2 ? { continuedIn: r.stage2 } : {}), ...(r.error ? { problem: r.error } : {}),
      })),
      draft: draft ? { summary: draft.summary, project: draft.projectKey, kind: draft.kind, savedAt: new Date(draft.at).toISOString().slice(0, 16).replace('T', ' '), input: draft.input, hint: 'Offer to continue: run the matching preview again with these inputs.' } : null,
      ...(admins ? { projectAdmins: admins.users.map((u) => u.displayName) } : {}),
    };
  } catch (e) {
    return { error: e.message };
  }
});

// Details of one request, for its approvers, its requester and SUPERPORT.
export const requestDetailsAction = gateAction('read', async (payload) => {
  try {
    const key = String(payload?.issueKey || '').trim().toUpperCase();
    const p = await getPending(key);
    if (!p) return { error: `${key} is not a Custom Field Self-Service for Jira request.` };
    const settings = await getSettings();
    const { accountId } = await me();
    const allowed = p.requester === accountId || (p.approverIds || []).includes(accountId) || settings.approverAccountIds.includes(accountId) || (await J.isProjectAdmin(p.projectKey, accountId));
    if (!allowed) return { error: `Only the requester, the approvers and admins of ${p.projectKey} can see the details of ${key}.` };
    const names = await S.namesOf([p.requester, ...(p.approverIds || []), p.approver]);
    return {
      request: key, link: `${await P.siteUrl()}/browse/${key}`, summary: p.summary, project: p.projectKey, status: p.status,
      stage: p.stage === 'admin' ? 'stage 1: project admin approval' : 'final approval by a Jira administrator',
      requester: names[p.requester], approvers: (p.approverIds || []).map((id) => names[id]), decidedBy: p.approver ? names[p.approver] : null,
      risk: p.risk || 'unknown', whyApprovalIsNeeded: p.reason, changes: p.rows, briefing: (await J.isJiraAdmin(accountId)) ? p.briefing || [] : [],
      howToDecide: 'Approve or decline in the request itself (or on the admin page / "Requests for you"). Field Assistant cannot approve.',
    };
  } catch (e) {
    return { error: e.message };
  }
});

// ---------- previews (GET: they change nothing in Jira) ----------

export const previewNewFieldAction = gateAction('write', run(({ projectKey, input, accountId, isAdmin, role }) => P.previewNewField({ projectKey, input, accountId, isAdmin, role })));

export const previewOptionsAction = gateAction('write', run(async ({ projectKey, input, accountId, isAdmin, role }) => {
  const f = await findField(projectKey, input.field);
  return P.previewOptions({ projectKey, field: f, input, accountId, isAdmin, role });
}));

export const previewReuseAction = gateAction('write', run(({ projectKey, input, accountId, isAdmin, role }) => P.previewReuse({ projectKey, input, accountId, isAdmin, role })));

export const previewBundleAction = gateAction('write', run(({ projectKey, input, accountId, isAdmin, role }) => P.previewBundle({ projectKey, input, accountId, isAdmin, role })));
export const previewBulkAction = gateAction('write', run(({ projectKey, input, accountId, isAdmin, role }) => P.previewBulk({ projectKey, input, accountId, isAdmin, role })));
export const previewReplaceAction = gateAction('write', run(({ projectKey, input, accountId, isAdmin, role }) => P.previewBulk({ projectKey, input: { ...input, op: 'replace' }, accountId, isAdmin, role })));
export const bulkStatusAction = gateAction('read', run(({ projectKey, input, role }) => (role !== 'none' ? P.bulkStatus({ projectKey, input }) : { error: `Bulk changes are for the project admins of ${projectKey} and Jira administrators.` })));
export const undoBulkAction = gateAction('write', run(({ projectKey, input, accountId, isAdmin, role }) => P.undoBulk({ projectKey, input, accountId, isAdmin, role })));

// ---------- the one write action ----------

export const submitPlanAction = gateAction('write', async (payload) => {
  try {
    const { accountId } = await me();
    return await P.submitPlan({ planId: payload?.planId, accountId });
  } catch (e) {
    return { error: e.message, nothingChanged: true };
  }
});

// ---------- site readiness (Jira admins only) ----------
// "Is Custom Field Self-Service for Jira ready on this site?": runs the site compatibility check and returns a verdict, every
// finding in plain words and the fixes the app can apply itself. Applying them is a separate, confirmed action.
const VERDICT = {
  ok: 'Ready: every check passed on this site.',
  warn: 'Works, with notes: nothing blocks it, but some points are worth a look.',
  fail: 'Needs fixes before it can work reliably here.',
};
const assertSiteAdmin = async () => {
  const { accountId, displayName } = await me();
  if (!(await J.hasGlobalPermission(accountId, 'ADMINISTER'))) throw new Error('Only Jira administrators can check or fix the site setup of Custom Field Self-Service for Jira.');
  return { accountId, displayName };
};
const describeCheck = (r) => ({
  verdict: VERDICT[r.level],
  level: r.level,
  checkedAt: new Date(r.at).toISOString(),
  findings: r.checks.filter((c) => c.level !== 'ok').map((c) => ({ check: c.label, level: c.level, detail: c.detail, fix: c.fix ? { id: c.fix.id, does: c.fix.label } : null })),
  passed: r.checks.filter((c) => c.level === 'ok').map((c) => c.label),
  fixIds: (r.fixes || []).map((x) => x.id),
  manualSteps: r.checks.filter((c) => c.level !== 'ok' && !c.fix).map((c) => `${c.label}: ${c.detail}`),
});

export const siteReadinessAction = gateAction('read', async () => {
  try {
    const { accountId } = await assertSiteAdmin();
    return describeCheck(await runSiteCheck(accountId, { quick: true }));
  } catch (e) {
    return { error: e.message };
  }
});

export const siteFixAction = gateAction('write', async (payload) => {
  try {
    const { accountId } = await assertSiteAdmin();
    const ids = String(payload?.fixIds || '').split(/[\s,;]+/).filter(Boolean);
    if (!ids.length) return { error: 'Which fixes? Pass the fix IDs from site-readiness, or "all".' };
    let use = ids;
    if (ids.length === 1 && ids[0].toLowerCase() === 'all') use = ((await lastSiteCheck()) || { fixes: [] }).fixes.map((x) => x.id);
    const r = await applyFixes(use, accountId, { quick: true });
    return { applied: r.done, notApplied: r.failed, after: describeCheck(r.check) };
  } catch (e) {
    return { error: e.message };
  }
});
