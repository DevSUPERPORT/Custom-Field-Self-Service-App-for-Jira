/**
 * Backend of the project page and the work item action: every resolver behind the kill switch (with an explicit READS
 * allow-list) and the role check, plus the exports for the Rovo actions, the approval trigger and the scheduled jobs.
 * Hourly prewarming and the daily self-test also respect the kill switch.
 *
 * @file        src/index.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import Resolver from '@forge/resolver';
import { kvs } from '@forge/kvs';
import * as J from './jira';
import * as S from './service';
import * as B from './bulk';
import * as FA from './fieldadmin';
import { createApprovalRequest, withdrawRequest } from './approvals';
import { todosFor, resolveTodo, dismissTodo } from './followups';
import { requestsOf, requestsForProject } from './audit';
import { requestStatus } from './shared/status';
import { getSettings, isEnabledFor, saveSettings } from './settings';
import { seenProjects, allPending, readLog } from './audit';
import { runSelfTest } from './selftest';
import { decideAsUser, prepareDecision, finishDecision } from './approvals';
import { saveFormDraft, getFormDraft } from './plans';
import { filtersMentioning, automationRulesFor, projectScreens } from './insights';
import { fieldForProject } from './fields';
import { previewRole, previewRefusal } from './shared/preview';
import { safeModeState, quotaUsed } from './guards';
import { requestDiff } from './shared/diff';
import { undoStates, undoKeyOf, isUndoEntry } from './shared/undo';
import { typeByKey } from './shared/fieldtypes';
import { FEATURES, BULK_OFF } from './shared/features';
import { gateResolvers, availability, mayRun } from './maintenance';
import { licenseRefusal } from './license';

export { onIssueUpdated, sweep } from './approvals';
export {
  listFields, fieldOptions, findSimilarFields, fieldHealthAction, guidelinesAction, myRequestsAction, requestDetailsAction,
  previewNewFieldAction, previewOptionsAction, previewReuseAction, previewBundleAction, submitPlanAction,
  siteReadinessAction, siteFixAction, previewBulkAction, previewReplaceAction, bulkStatusAction, undoBulkAction,
} from './actions';
export { adminHandler } from './admin';
export { nightly } from './nightly';
import { driftNow, weekly as weeklyDigest } from './nightly';

const resolver = new Resolver();

// Kill switch (maintenance.js): every resolver passes it first, before any access check. Resolvers that only read
// (or only note a visit or fill the app's cache) are listed here; everything else counts as a write, so a new resolver
// is blocked in read-only mode unless it is added here on purpose. 'availability' is the one resolver that always
// answers, so the page can show why it is paused.
const READS = new Set([
  'boot', 'overview', 'options', 'usage', 'optionsOf', 'latestChanges', 'fieldDetails', 'adminProjects', 'whoami',
  'myRequests', 'projectIssueTypes', 'newFieldMeta', 'screens', 'tour', 'checkField', 'audit', 'health', 'issueContext',
  'inbox', 'bulkGet', 'bulkCatalog', 'bulkHistory', 'whatsNew', 'getDraft', 'radar', 'guardState',
]);
gateResolvers(resolver, READS);

// Every call knows which resolver it is (req.name), for the preview's reading-only check in handle.
const define = resolver.define.bind(resolver);
resolver.define = (name, fn) => define(name, (req) => fn({ ...req, name }));

class Disabled extends Error {}
class Unsupported extends Error {}

// The page asks first, so it can show "temporarily unavailable" or "changes are paused" before loading anything.
resolver.define('availability', availability);

const notEnabledText = (settings, projectKey) => (settings.configured
  ? `Custom Field Self-Service for Jira is not enabled for ${projectKey} yet. It runs in: ${settings.enabledProjects.join(', ') || 'all projects'}.`
  : 'Custom Field Self-Service for Jira is installed but not set up on this site yet.');

// Every call: the page's project from Jira's context (not from the browser), the pilot scope, and a fresh check of
// the caller's role with Jira itself: 'project-admin' (default) or 'jira-admin' for actions that change things
// directly. The role is never taken from the browser; the UI only hides what the server would refuse anyway.
// Errors go back as { error } so the UI can show them.
const ROLE_TEXT = { 'project-admin': 'project admins', 'jira-admin': 'Jira administrators' };
const handle = (fn, { role: needed = 'project-admin' } = {}) => async (req) => {
  const unlicensed = licenseRefusal(req.context);
  if (unlicensed) return unlicensed;
  try {
    const projectKey = req.context?.extension?.project?.key;
    if (!projectKey) throw new Error('No project context.');
    const settings = await getSettings();
    if (!isEnabledFor(settings, projectKey)) throw new Disabled(notEnabledText(settings, projectKey));
    const st = await J.projectStyle(projectKey).catch(() => null);
    if (st && J.isTeamManaged(st)) throw new Unsupported(`${projectKey} is a team-managed space. Its fields belong to the space itself and are managed in its own settings (Space settings → Fields), so Custom Field Self-Service for Jira does not apply here. It works in company-managed spaces.`);
    const actual = needed === 'none' ? 'none' : await J.roleOf(projectKey, req.context.accountId);
    // "View as project admin" (Jira administrators only): lowers the role, never raises it, and allows reading only.
    const asRole = req.payload?.asRole;
    const refused = previewRefusal(actual, asRole, req.name);
    if (refused) throw new J.Forbidden(refused);
    const role = previewRole(actual, asRole);
    if (J.ROLE_RANK[role] < J.ROLE_RANK[needed]) throw new J.Forbidden(`This is for ${ROLE_TEXT[needed]} only.`);
    const { asRole: ignored, ...payload } = req.payload || {};
    return await fn({ projectKey, payload, accountId: req.context.accountId, context: req.context, role, preview: role !== actual });
  } catch (e) {
    if (e instanceof Disabled) {
      // Jira admins can switch the project on right here; everyone else is told whom to ask.
      const canEnable = await J.hasGlobalPermission(req.context?.accountId, 'ADMINISTER').catch(() => false);
      return { error: e.message, disabled: true, canEnable, configured: !!(await getSettings()).configured };
    }
    return { error: e.message, forbidden: e instanceof J.Forbidden, disabled: false, unsupported: e instanceof Unsupported };
  }
};

// One click for a Jira admin on a project that is not enabled: adds it to the pilot. On a fresh installation it also
// makes the admin the first approver, so the app is usable at once; the rest is on the admin page.
resolver.define('enableHere', async (req) => {
  try {
    const projectKey = req.context?.extension?.project?.key;
    const accountId = req.context?.accountId;
    if (!projectKey) throw new Error('No project context.');
    if (!(await J.hasGlobalPermission(accountId, 'ADMINISTER'))) throw new J.Forbidden('Only Jira administrators can enable Custom Field Self-Service for Jira for a project.');
    const s = await getSettings();
    const next = { enabledProjects: s.configured && !s.enabledProjects.length ? [] : [...new Set([...(s.configured ? s.enabledProjects : []), projectKey])] };
    if (!s.approverAccountIds.length) next.approverAccountIds = [accountId];
    await saveSettings(next, accountId);
    return { ok: true, enabledProjects: next.enabledProjects, approverAdded: !s.approverAccountIds.length };
  } catch (e) {
    return { error: e.message, forbidden: e instanceof J.Forbidden };
  }
});

// Which other spaces share a field is shown only for spaces the person may browse; the rest are just counted.
const maskShared = async (ov, accountId, role) => {
  if (role === 'jira-admin' || !ov?.fields) return ov;
  const keys = [...new Set(ov.fields.flatMap((f) => (f.sharedWith || []).map((p) => p.key)))];
  const ok = new Set(await J.browsable(accountId, keys));
  return {
    ...ov,
    fields: ov.fields.map((f) => (f.sharedWith?.length ? { ...f, sharedWith: f.sharedWith.map((p) => (ok.has(p.key) ? p : { key: null, name: 'another space' })) } : f)),
  };
};
// Each field says how this person may change its options (direct / approval / readonly); the services check it
// again on every change.
const overviewOf = async ({ projectKey, payload, accountId, role }) => {
  const [ov, settings, system] = await Promise.all([S.overview(projectKey, !!payload.fresh, { cont: !!payload.cont }), getSettings(), S.systemFieldRows().catch(() => [])]);
  const masked = await maskShared(ov, accountId, role);
  return { ...masked, fields: (masked.fields || []).map((f) => (f.error ? f : { ...f, access: S.optionAccess(settings, f, role, projectKey) })), systemFields: system };
};
resolver.define('overview', handle(overviewOf));
const maskField = async (field, accountId, role) => (field ? (await maskShared({ fields: [field] }, accountId, role)).fields[0] : field);
// Requests: the cross-space briefing and the raw payload are for Jira administrators only.
const forRole = (p, role) => (role === 'jira-admin' ? p : (({ payload, briefing, ...rest }) => rest)(p));
resolver.define('options', handle(async ({ projectKey, payload, accountId, role }) => {
  const [r, settings] = await Promise.all([S.getOptions(projectKey, payload.fieldId), getSettings()]);
  return { ...r, field: { ...(await maskField(r.field, accountId, role)), access: S.optionAccess(settings, r.field, role, projectKey) } };
}));
resolver.define('usage', handle(async ({ projectKey, payload, accountId, role }) => {
  const r = await S.getUsage(projectKey, payload.fieldId, { accountId, role });
  return { ...r, field: await maskField(r.field, accountId, role) };
}));
resolver.define('optionsOf', handle(({ projectKey, payload }) => S.optionsOf(projectKey, payload.fieldId)));
resolver.define('applyOptions', handle(({ projectKey, payload, accountId }) => S.applyOptionChanges({
  projectKey, fieldId: payload.fieldId, contextId: payload.contextId, tree: payload.tree, accountId,
})));
// ---------- undo (audit log, notifications) ----------

// Undo state of every change in this space's log, as this person may use it. Bulk jobs and open undo requests are
// read once per call; everything else comes from the log itself (see shared/undo.js).
const undoInfo = async (projectKey, log, requests, { role, accountId }) => {
  const bulkIds = [...new Set(log.map((l) => l.bulkId).filter(Boolean))].slice(0, 40);
  const metas = Object.fromEntries((await Promise.all(bulkIds.map((id) => B.metaOf(id).catch(() => null)))).filter(Boolean).map((m) => [m.id, m]));
  const open = requests.filter((r) => ['pending', 'executing'].includes(r.status));
  const pending = [
    ...open.filter((r) => r.kind === 'options' && r.payload?.undoOf).map((r) => `batch:${r.payload.undoOf}`),
    ...Object.values(metas).filter((m) => m.undoRequest).map((m) => `bulk:${m.id}`),
  ];
  const undone = Object.values(metas).filter((m) => ['undone', 'undoing'].includes(m.status)).map((m) => `bulk:${m.id}`);
  const states = undoStates(log, { undone, pending });
  // Who may press Undo: Jira administrators everything; project admins option changes of this space (their undo is a
  // request unless they change their own fields directly) and the bulk changes they asked for themselves.
  const may = (key) => {
    if (key.startsWith('bulk:') && !FEATURES.bulk) return false;
    if (role === 'jira-admin') return true;
    if (key.startsWith('batch:')) return true;
    if (key.startsWith('bulk:')) return FEATURES.bulk && metas[key.slice(5)]?.accountId === accountId;
    return false;
  };
  return { states, may, metas };
};
const undoNeedsApproval = (settings, role, key) => role !== 'jira-admin' && !(settings.projectAdminOptionEdits === 'direct' && key.startsWith('batch:'));

resolver.define('undo', handle(async ({ projectKey, payload, accountId, role }) => {
  const key = payload.adminOpId ? `op:${payload.adminOpId}` : payload.jobId ? `bulk:${payload.jobId}` : payload.batchId ? `batch:${payload.batchId}` : '';
  if (!key) throw new Error('Nothing to undo.');
  if (key.startsWith('bulk:') && !FEATURES.bulk) throw new Error(BULK_OFF);
  // Checked here, not only on the page: already undone, or a later change on the same field that would be lost.
  const [log, requests] = await Promise.all([readLog(projectKey, 500), requestsForProject(projectKey)]);
  const { states, may } = await undoInfo(projectKey, log, requests, { role, accountId });
  if (!may(key)) throw new J.Forbidden(key.startsWith('op:') ? 'Only Jira administrators undo field administration steps.' : 'Only the person who asked for this bulk change, or a Jira administrator, can undo it.');
  const st = states[key];
  if (st === 'undone') throw new Error('This change was already undone.');
  if (st === 'pending') throw new Error('An undo of this change is already waiting for approval.');
  if (st === 'superseded') throw new Error('A later change on the same field came after this one. Undo the later change first, so nothing else is lost.');
  if (key.startsWith('op:')) return FA.undo({ projectKey, accountId, id: payload.adminOpId });
  if (key.startsWith('bulk:')) {
    const r = await B.undo({ projectKey, jobId: payload.jobId, accountId, createApproval: createApprovalRequest });
    return r.status === 'pending' ? { status: 'pending', issueKey: r.issueKey } : { status: 'bulk', job: r.job };
  }
  return S.undoBatch({ projectKey, batchId: payload.batchId, accountId });
}));

// After a live update: the newest changes since `since`, with their undo, for the notification on the page.
resolver.define('latestChanges', handle(async ({ projectKey, payload, accountId, role }) => {
  const since = Number(payload.since) || Date.now() - 120000;
  const log = await readLog(projectKey, 60);
  let fresh = log.filter((l) => l.ts > since && l.executed);
  // A bulk change logs its fields one by one, and the approved request adds a summary row without a field: when the
  // fields are there, the summary would only say the same thing twice.
  if (fresh.some((l) => l.bulkId)) fresh = fresh.filter((l) => l.bulkId || l.fieldId);
  if (!fresh.length) return { items: [] };
  const [requests, settings] = await Promise.all([requestsForProject(projectKey), getSettings()]);
  const { states, may } = await undoInfo(projectKey, log, requests, { role, accountId });
  const groups = [];
  fresh.forEach((l) => {
    const key = undoKeyOf(l) || `t:${l.ts}:${l.fieldId}`;
    const g = groups.find((x) => x.key === key);
    if (g) { g.count += 1; g.fields.add(l.fieldName || l.fieldId); return; }
    groups.push({ key, ts: l.ts, actor: l.actor, fieldName: l.fieldName || l.fieldId || '', fields: new Set([l.fieldName || l.fieldId]), action: l.action, option: l.option || '', count: 1, undoEntry: isUndoEntry(l), bulk: !!l.bulkId });
  });
  const names = await S.namesOf(groups.map((g) => g.actor));
  return {
    items: groups.slice(0, 3).map((g) => ({
      ts: g.ts, by: names[g.actor] || '', mine: g.actor === accountId, fieldName: g.fieldName, action: g.action, option: g.option, count: g.count, bulk: g.bulk, undoEntry: g.undoEntry,
      moreFields: Math.max(0, g.fields.size - 1),
      undo: states[g.key] === 'available' && may(g.key) ? { key: g.key, approval: undoNeedsApproval(settings, role, g.key) } : null,
    })),
  };
}));

// Any field's details (not only fields with options); Jira administrators also get this space's screens to manage.
resolver.define('fieldDetails', handle(({ projectKey, payload, role, accountId }) => FA.details({ projectKey, fieldId: payload.fieldId, role, accountId })));
// Direct field administration: Jira administrators only. Logged and undoable from the audit log.
resolver.define('adminFieldUpdate', handle(({ projectKey, payload, accountId }) => FA.update({ projectKey, accountId, fieldId: payload.fieldId, name: payload.name, description: payload.description }), { role: 'jira-admin' }));
resolver.define('adminFieldScreens', handle(({ projectKey, payload, accountId }) => FA.screens({ projectKey, accountId, fieldId: payload.fieldId, add: payload.add || [], remove: payload.remove || [], removeAll: !!payload.removeAll }), { role: 'jira-admin' }));
resolver.define('adminFieldProjects', handle(({ projectKey, payload, accountId }) => FA.projects({ projectKey, accountId, fieldId: payload.fieldId, contextId: payload.contextId, add: payload.add || [], remove: payload.remove || [] }), { role: 'jira-admin' }));
resolver.define('adminProjects', handle(() => FA.allSpaces(), { role: 'jira-admin' }));
// Field health: put one field on this space's own screens (the page calls it once per selected field).
resolver.define('healthAddScreens', handle(({ projectKey, payload, accountId }) => FA.addToOwnScreens({ projectKey, accountId, fieldId: String(payload.fieldId || ''), screenIds: payload.screenIds || null }), { role: 'jira-admin' }));
// Field health: did anyone change options outside the app? The nightly check, now, for this space.
resolver.define('driftCheckNow', handle(({ projectKey }) => driftNow(projectKey), { role: 'jira-admin' }));
// Field health: take one field out of use (the page calls it once per selected field).
resolver.define('healthTakeOut', handle(({ projectKey, payload, accountId }) => FA.takeOutOfUse({ projectKey, accountId, fieldId: String(payload.fieldId || '') }), { role: 'jira-admin' }));

// Who is looking: decides which tabs and actions the page offers (the server checks every call again anyway).
const whoamiOf = async ({ role, accountId, preview = false }) => {
  const settings = await getSettings();
  return {
    role,
    preview,
    approver: [...settings.approverAccountIds, ...settings.backupApproverAccountIds].includes(accountId),
    policy: { optionEdits: settings.projectAdminOptionEdits, maxContextProjects: settings.maxContextProjects, retentionMonths: settings.auditRetentionMonths },
    features: FEATURES,
  };
};
resolver.define('whoami', handle(whoamiOf));

// "My requests" (UC-03): the person's own requests with their status; open ones can be withdrawn.
const myRequestsOf = async ({ accountId }) => {
  const mine = await requestsOf(accountId, 1000);
  const names = await S.namesOf(mine.map((p) => p.approver).filter(Boolean));
  return {
    items: mine.slice(0, 200).map((p) => ({
      issueKey: p.issueKey, projectKey: p.projectKey, kind: p.kind, summary: p.summary, created: p.created, decided: p.decided || null,
      status: requestStatus(p), rows: p.rows || [], reason: p.declineReason || '', error: requestStatus(p) === 'fail' ? String(p.error || '').slice(0, 300) : '',
      approver: p.approver ? names[p.approver] || '' : '', fieldId: p.fieldId || p.createdFieldId || p.payload?.fieldId || '',
      fieldName: (['bulk', 'bulkundo'].includes(p.kind) && (p.payload?.description || p.summary)) || p.payload?.fieldName || p.payload?.draft?.name || p.payload?.plan?.field?.name || '',
    })),
  };
};
resolver.define('myRequests', handle(myRequestsOf));
resolver.define('withdraw', handle(async ({ payload, accountId }) => ({ result: await withdrawRequest(String(payload.issueKey || ''), accountId) })));

// Space picker of a new field: spaces this person may see (Jira checks the permission), and their issue types.
resolver.define('projectIssueTypes', handle(async ({ payload, accountId }) => {
  const keys = await J.browsable(accountId, (payload.keys || []).map(String).slice(0, 100));
  const out = {};
  await J.mapLimit(keys, 6, async (k) => {
    const p = await J.getProject(k).catch(() => null);
    if (p) out[k] = (p.issueTypes || []).map((t) => ({ id: String(t.id), name: t.name }));
  });
  return { issueTypes: out };
}));

// Follow-ups: a field approved for this space too, still missing on its screens (see followups.js).
resolver.define('todoAddScreens', handle(({ projectKey, payload, accountId }) => resolveTodo({ projectKey, fieldId: String(payload.fieldId || ''), screenIds: payload.screenIds || [], accountId })));
resolver.define('todoDismiss', handle(({ projectKey, payload, accountId }) => dismissTodo({ projectKey, fieldId: String(payload.fieldId || ''), accountId })));
resolver.define('reuse', handle(async ({ projectKey, payload, accountId, role }) => {
  const r = await S.reuseField({ projectKey, fieldId: payload.fieldId, accountId, addToScreens: payload.addToScreens !== false, issueTypeIds: payload.issueTypeIds || [] });
  // The plan names the other spaces of the context: only Jira administrators get it back.
  return role === 'jira-admin' ? r : { status: r.status, issueKey: r.issueKey, reasons: r.reasons, notes: r.status === 'pending' ? [] : r.notes, plan: { field: { name: r.plan?.field?.name } } };
}));

// Form data for case 1: EVERY project where the requester is project admin (product decision, 2026-10-20). Projects outside
// the self-service pilot are listed but can't be ticked yet.
const newFieldMetaOf = async ({ projectKey, accountId }) => {
  const settings = await getSettings();
  const [visible, own] = await Promise.all([J.allBrowsableProjects(accountId).catch(() => []), J.getProject(projectKey)]);
  const projects = visible.filter((p) => p.key !== projectKey && isEnabledFor(settings, p.key)).map((p) => ({ id: p.id, key: p.key, name: p.name, enabled: true }));
  return {
    current: projectKey,
    projects: [{ id: String(own.id), key: own.key, name: own.name, enabled: true, issueTypes: own.issueTypes.map((t) => ({ id: String(t.id), name: t.name, subtask: !!t.subtask })) }, ...projects.sort((a, b) => a.key.localeCompare(b.key))],
    maxContextProjects: settings.maxContextProjects,
    rules: { ...settings.rules, policyAddsOnly: settings.policyAddsOnly, twoPersonThreshold: settings.twoPersonThreshold },
    catalogue: settings.catalogue,
  };
};
resolver.define('newFieldMeta', handle(newFieldMetaOf));

// The ticked projects' OWN screens (by screen scheme), for "add to screens". Shared screens are left out: adding a
// field there would change other projects (product decision, 2026-10-20).
// UC-05: the screens of this space; only those it uses alone can be picked, shared ones are shown locked.
resolver.define('screens', handle(async ({ projectKey, payload }) => {
  const p = await J.getProject(projectKey);
  const screens = await projectScreens(p.id, payload.issueTypeIds || []);
  const out = [];
  for (const s of screens) {
    out.push({ projectKey, screenId: String(s.screenId), name: await J.screenName(s.screenId).catch(() => String(s.screenId)), schemeName: s.schemeName, operations: s.operations, exclusive: !!s.exclusive });
  }
  return { screens: out.sort((a, b) => (b.exclusive - a.exclusive) || a.name.localeCompare(b.name)) };
}));

// First-run tutorial: seen per user; the role decides which chapters it shows.
const tourKey = (accountId) => `tour:${String(accountId).replace(/[^a-zA-Z0-9:._#-]/g, '_')}`;
const tourOf = async ({ projectKey, accountId }) => {
  const settings = await getSettings();
  const [seen, jiraAdmin] = await Promise.all([kvs.get(tourKey(accountId)), J.hasGlobalPermission(accountId, 'ADMINISTER').catch(() => false)]);
  return { seen: !!seen, projectKey, approver: [...settings.approverAccountIds, ...settings.backupApproverAccountIds].includes(accountId), jiraAdmin };
};
resolver.define('tour', handle(tourOf));
resolver.define('tourSeen', handle(async ({ accountId }) => { await kvs.set(tourKey(accountId), Date.now()); return { ok: true }; }));

resolver.define('checkField', handle(({ payload }) => S.checkField(payload.draft)));
const DRAFT_KEYS = ['name', 'description', 'typeKey', 'optionsText', 'defaultValue', 'justification', 'global', 'addToScreens', 'screenIds', 'projectKeys', 'issueTypeIds', 'confirmWarnings'];
const cleanDraft = (d = {}) => Object.fromEntries(DRAFT_KEYS.filter((k) => d[k] !== undefined).map((k) => [k, d[k]]));
resolver.define('requestField', handle(({ projectKey, payload, accountId }) => S.requestNewField({ projectKey, draft: cleanDraft(payload.draft), accountId })));
resolver.define('audit', handle(async ({ projectKey, role, accountId }) => {
  const [r, settings] = await Promise.all([S.auditData(projectKey), getSettings()]);
  const { states, may } = await undoInfo(projectKey, r.log, r.requests, { role, accountId });
  // Every entry says whether this person can undo its change here, and if not, why.
  const log = r.log.map((l) => {
    const key = undoKeyOf(l);
    const state = key && l.executed ? states[key] || 'none' : 'none';
    return { ...l, undo: state === 'none' ? null : { key, state, can: may(key), approval: undoNeedsApproval(settings, role, key) } };
  });
  return { ...r, log, requests: r.requests.map((p) => ({ ...forRole(p, role), status: requestStatus(p) })), retentionMonths: settings.auditRetentionMonths };
}));
// Suggestions quote values from work items read by the app: the values themselves only for Jira administrators.
resolver.define('health', handle(async ({ projectKey, role }) => {
  const r = await S.health(projectKey, role);
  if (role === 'jira-admin' || !r.suggestions?.items) return r;
  return { ...r, suggestions: { ...r.suggestions, items: r.suggestions.items.map((x) => ({ ...x, values: (x.values || []).map((v) => ({ value: '…', count: v.count })), examples: [] })) } };
}));

// Work item action: tells the modal whether the app runs here, whether the user administers the project and,
// if not, who does (non-admins are told whom to contact; their requests go to those admins).
resolver.define('issueContext', handle(async ({ projectKey, context, accountId }) => {
  const isAdmin = await J.isProjectAdmin(projectKey, accountId);
  const settings = await getSettings();
  const admins = isAdmin ? null : await J.projectAdmins(projectKey, settings.stage1MaxApprovers).catch(() => ({ users: [] }));
  const asked = admins ? (settings.requesterAsReporter ? admins.users.filter((u) => u.accountId !== accountId) : admins.users.filter((u) => settings.approverAccountIds.includes(u.accountId))) : [];
  return { projectKey, issueKey: context.extension?.issue?.key, isAdmin, admins: asked.map((u) => u.displayName) };
}, { role: 'none' }));

// ---------- v5: inbox, decisions, what's new, drafts, impact radar, text to dropdown, bundle ----------

// Stage-1 requests of this project that the current user may decide.
const inboxOf = async ({ projectKey, accountId, role }) => {
  const open = (await allPending()).filter((p) => p.status === 'pending' && p.projectKey === projectKey && (p.approverIds || []).includes(accountId));
  const names = await S.namesOf(open.map((p) => p.requester));
  const todos = await todosFor(projectKey).catch(() => []);
  // The picture of each change (shared/diff.js). Project admins see the spaces they may browse; others are counted.
  const keys = [...new Set(open.flatMap((p) => [...(p.payload?.affected || []), ...(p.payload?.draft?.projectKeys || []), ...(p.payload?.plan?.contextStep?.sharedWith || [])]))];
  const visible = role === 'jira-admin' ? null : await J.browsable(accountId, keys).catch(() => [projectKey]);
  const typeLabel = (k) => typeByKey(k)?.label || k;
  return {
    items: open.map((p) => ({
      issueKey: p.issueKey, summary: p.summary, requester: names[p.requester], created: p.created, stage: p.stage, risk: p.risk, rows: p.rows, kind: p.kind,
      reason: p.reason || '', briefing: role === 'jira-admin' ? p.briefing || [] : [], diff: requestDiff(p, { typeLabel, visible }),
    })),
    todos: todos.map((t) => ({ fieldId: t.fieldId, fieldName: t.fieldName, origin: t.origin, issueKey: t.issueKey, at: t.at })),
  };
};
resolver.define('inbox', handle(inboxOf));

// ---------- bulk changes ----------
// Switched off with FEATURES.bulk (shared/features.js): every bulk call answers that bulk changes are not available.
const bulkOnly = (fn) => (ctx) => { if (!FEATURES.bulk) throw new Error(BULK_OFF); return fn(ctx); };
// Jira administrators: every option field of the space. Project admins: only the fields their space uses alone, and
// their change goes to a Jira administrator for approval (unless project admins change their own fields directly).
// bulk.js checks the role and the fields again at start and undo.
resolver.define('bulkScan', handle(bulkOnly(({ projectKey, payload, accountId, role }) => B.scan({ projectKey, input: payload.input, accountId, jobId: payload.jobId, role }))));
resolver.define('bulkStart', handle(bulkOnly(({ projectKey, payload, accountId }) => B.start({ projectKey, jobId: payload.jobId, accountId, exclude: payload.exclude || [], createApproval: createApprovalRequest }))));
resolver.define('bulkRun', handle(bulkOnly(async ({ projectKey, payload, role }) => { await B.get({ projectKey, jobId: payload.jobId, role }); return B.run({ jobId: payload.jobId }); })));
resolver.define('bulkUndo', handle(bulkOnly(({ projectKey, payload, accountId }) => B.undo({ projectKey, jobId: payload.jobId, accountId, createApproval: createApprovalRequest }))));
resolver.define('bulkGet', handle(bulkOnly(async ({ projectKey, payload, role, accountId }) => { const r = await B.get({ projectKey, jobId: payload.jobId, role }); return { ...r, job: { ...r.job, mine: r.job.accountId === accountId } }; })));
resolver.define('bulkCatalog', handle(bulkOnly(({ projectKey, payload, role }) => B.catalog({ projectKey, fresh: !!payload?.fresh, role }))));
resolver.define('bulkHistory', handle(bulkOnly(async ({ projectKey, accountId }) => (await B.history({ projectKey })).map((j) => ({ ...j, mine: j.accountId === accountId })))));

resolver.define('prepareDecide', handle(async ({ projectKey, payload, accountId }) => {
  const open = (await allPending()).find((p) => p.issueKey === payload.issueKey);
  if (!open || open.projectKey !== projectKey) throw new Error('This request does not belong to this project.');
  return prepareDecision(payload.issueKey, accountId);
}));
resolver.define('decide', handle(async ({ projectKey, payload, accountId }) => {
  const open = (await allPending()).find((p) => p.issueKey === payload.issueKey);
  if (!open || open.projectKey !== projectKey) throw new Error('This request does not belong to this project.');
  const reason = String(payload.reason || '').trim();
  if (payload.decision !== 'approve' && reason.length < 3 && !payload.recorded) throw new Error('Give a reason for the rejection: the requester sees it.');
  return { result: await finishDecision(payload.issueKey, payload.decision, accountId, { recorded: !!payload.recorded, reason }) };
}));

// Changes since the user's last visit, by others (or decided on requests).
const whatsNewOf = async ({ projectKey, accountId }) => {
  const key = `visit:${String(accountId).replace(/[^a-zA-Z0-9:._#-]/g, '_')}:${projectKey}`;
  const last = await kvs.get(key);
  await kvs.set(key, Date.now());
  if (!last) return { first: true, items: [] };
  const log = (await readLog(projectKey, 100)).filter((l) => l.ts > last && (l.actor !== accountId || String(l.via).startsWith('approved') || String(l.via).startsWith('declined') || l.action === 'Drift'));
  const names = await S.namesOf(log.map((l) => l.actor));
  // One line per change, not per row: rows written together (one request, one batch) or by one bulk job are grouped.
  const groups = [];
  log.forEach((l) => {
    const key = l.bulkId ? `b:${l.bulkId}|${l.via}` : `${l.via}|${l.ts}`;
    const g = groups.find((x) => x.key === key);
    if (g) { g.rows.push(l); return; }
    groups.push({ key, rows: [l] });
  });
  const textOf = ({ rows }) => {
    const l = rows[0];
    if (rows.length === 1 && !l.fieldId) return `${l.action}: ${l.option || l.fieldName}`;
    if (rows.length === 1) return `${l.action} ${l.option ? `"${l.option}" ` : ''}in ${l.fieldName || l.fieldId}`;
    const fields = [...new Set(rows.map((r) => r.fieldName || r.fieldId))];
    return fields.length === 1 ? `${rows.length} changes in ${fields[0]}` : `${l.action} in ${fields.length} fields (${fields.slice(0, 2).join(', ')}${fields.length > 2 ? ', …' : ''})`;
  };
  // Internal IDs (undo batches, bulk jobs) mean nothing to people: the words stay, the IDs go.
  const viaText = (v) => String(v || '').replace(/undo of \d+-\d+/, 'undo').replace(/bulk change B[A-Z0-9]+/, 'bulk change');
  return { since: last, items: groups.slice(0, 8).map((g) => ({ ts: g.rows[0].ts, text: textOf(g), by: names[g.rows[0].actor] || '', via: viaText(g.rows[0].via) })), total: groups.length };
};
resolver.define('whatsNew', handle(whatsNewOf));

resolver.define('getDraft', handle(({ projectKey, accountId }) => getFormDraft(accountId, projectKey)));
resolver.define('saveDraft', handle(async ({ projectKey, accountId, payload }) => { await saveFormDraft(accountId, projectKey, payload.draft); return { ok: true }; }));

// Impact radar for the options editor: saved filters (as the user) and automation rules that use the field.
resolver.define('radar', handle(async ({ projectKey, payload, accountId, role }) => {
  const { field } = await fieldForProject(projectKey, payload.fieldId);
  const settings = await getSettings();
  const [filters, rules] = await Promise.all([filtersMentioning(field, payload.values || [], accountId, true), automationRulesFor(field.id, settings.approvalProjectKey)]);
  // Automation rules can belong to any space: names only for Jira administrators, a count for everyone else.
  if (role !== 'jira-admin' && rules?.rules) return { filters, rules: { ...rules, rules: [], hiddenCount: rules.rules.length } };
  return { filters, rules };
}));

// Text to dropdown: a new select field with the text field's values; the old values are copied afterwards.
resolver.define('convertText', handle(async ({ projectKey, payload, accountId }) => {
  const sugg = await kvs.get(`suggest:${projectKey}`);
  const item = (sugg?.items || []).find((x) => x.kind === 'text' && x.fieldId === payload.fieldId);
  if (!item) throw new Error('This suggestion is no longer current. Wait for the next nightly scan.');
  const draft = {
    name: String(payload.name || '').trim(), description: `Dropdown replacing the text field ${item.fieldName} (${item.fieldId}).`, typeKey: 'select',
    optionsText: item.values.map((v) => v.value).join('\n'), defaultValue: '', justification: `The text field ${item.fieldName} only ever holds ${item.values.length} values; a dropdown keeps them consistent and reportable.`,
    global: false, addToScreens: true, projectKeys: [projectKey], issueTypeIds: [], migrateFrom: payload.migrate ? item.fieldId : undefined,
  };
  return S.requestNewField({ projectKey, draft: { ...draft, confirmWarnings: true }, accountId });
}, { role: 'jira-admin' }));

resolver.define('bundle', handle(({ projectKey, payload, accountId }) => S.runBundle({ projectKey, entryRefs: payload.entries || [], accountId })));

// Safe mode and quota, for a banner on the page.
const guardStateOf = async ({ accountId }) => {
  const settings = await getSettings();
  return { safe: await safeModeState(settings), quota: { used: await quotaUsed(accountId), limit: settings.dailyQuota }, threshold: settings.twoPersonThreshold };
};
resolver.define('guardState', handle(guardStateOf));

// Everything the page needs to open, in one call: one cold start instead of eight, and the access checks (settings,
// space style, role) run once. Each part fails on its own, so one slow or broken part never blanks the page.
const settled = (p) => p.then((value) => ({ value }), (e) => ({ error: e.message }));
resolver.define('boot', handle(async (ctx) => {
  const [me, guard, news, tour, meta, inbox, mine, overview] = await Promise.all([
    whoamiOf(ctx), guardStateOf(ctx), whatsNewOf(ctx), tourOf(ctx), newFieldMetaOf(ctx), inboxOf(ctx), myRequestsOf(ctx),
    overviewOf({ ...ctx, payload: {} }),
  ].map(settled));
  return {
    me, guard, news, tour, overview,
    rules: meta.value ? { value: meta.value.rules } : meta,
    counts: {
      inbox: inbox.value ? inbox.value.items.length + (inbox.value.todos || []).length : 0,
      mine: mine.value ? mine.value.items.filter((x) => x.status === 'waiting').length : 0,
    },
  };
}));

export const handler = resolver.getDefinitions();

// Hourly: keep the overview of recently used projects warm, so the page opens from the cache. It only reads Jira, so
// it still runs while changes are paused; not while the app is down.
export const prewarm = async () => {
  if (!mayRun('read')) return { skipped: 'maintenance' };
  const settings = await getSettings();
  const keys = (await seenProjects()).filter((k) => isEnabledFor(settings, k));
  return { warmed: await S.prewarm(keys) };
};

// Daily: self-test with alert on failure. It edits its own test field and can raise alerts: only when the kill switch
// is off.
// Weekly: personal data reporting to Atlassian and erasure of closed accounts (src/privacy.js).
export { reportPersonalData as privacyReport } from './privacy';
import { reportPersonalData } from './privacy';

// The weekly trigger runs the digest and the personal data report (Forge allows five scheduled triggers per app).
// Each runs on its own: a failing digest never skips the report, and the other way round. Both honour the kill switch.
export const weekly = async () => {
  const settle = (fn) => fn().catch((e) => ({ error: String(e?.message || e) }));
  return { digest: await settle(weeklyDigest), privacy: await settle(reportPersonalData) };
};

export const selftest = async () => (mayRun('write') ? runSelfTest('schedule') : { skipped: 'maintenance' });
