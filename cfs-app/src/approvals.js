/**
 * Approval requests in Jira Service Management: raising two-stage requests, verifying who approved, executing the
 * stored change after approval, reminders, escalation and retries. The issue-updated trigger and the five-minute
 * sweep both wait while the kill switch pauses or stops the app.
 *
 * @file        src/approvals.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Yellow cases: an approval request in the approval space (JSM). The change itself is stored in Forge storage and
// executed by the app once the request is approved (trigger + 5-minute sweep). The sweep also reminds approvers,
// escalates to backup approvers, retries failed executions and raises alerts.
//
// Two stages (v5):
//   admin      a user who is not a project admin asked for something: the project's admins approve first. Once a
//              verified project admin approves, the app runs the plan as that admin's request - green changes
//              execute, yellow ones raise the SUPERPORT request (stage 2) automatically.
//   superport  yellow changes (shared contexts, global fields, guard rails): SUPERPORT approves.
// Before anything executes, the app checks WHO approved: an allowed approver of that stage, never the requester
// (test mode excepted). Anything else is blocked, commented and alerted.
import { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { app, user, projectAdmins, isJiraAdmin } from './jira';
import { savePending, getPending, updatePending, writeLog, allPending, saveSnapshot } from './audit';
import { executePlan, createWithScreens, executeReuse } from './fields';
import { getSettings, setCatalogueFieldId } from './settings';
import { withFieldLock, announce, notifyUsers, raiseAlert } from './ops';
import { migrate } from './nightly';
import { watchdog } from './watchdog';
import { runPlan } from './planner';
import { resolveTarget, createRequestType } from './approvalspace';
import { approved as bulkApproved, declined as bulkDeclined, continueJobs as continueBulkJobs, undoApproved as bulkUndoApproved, undoDeclined as bulkUndoDeclined } from './bulk';
import { ENGINES } from './shared/approvalspace';
import { inviteOtherSpaces } from './followups';
import { FEATURES, BULK_OFF } from './shared/features';
import { mayRun } from './maintenance';

const APPROVED_STATUS = process.env.APPROVED_STATUS || 'Waiting for support';
const WAITING_STATUS = process.env.WAITING_STATUS || 'Waiting for Approval';
const MAX_ATTEMPTS = 3;
const HOUR = 3600 * 1000;

// ---------- ADF ----------
const txt = (t, marks) => ({ type: 'text', text: String(t || '-'), ...(marks ? { marks } : {}) });
const para = (...content) => ({ type: 'paragraph', content });
const mention = (id) => ({ type: 'mention', attrs: { id } });
const cell = (t, header) => ({ type: header ? 'tableHeader' : 'tableCell', content: [para(txt(t))] });
const table = (rows) => ({
  type: 'table',
  content: [
    { type: 'tableRow', content: ['Action', 'Option / item', 'Old', 'New'].map((h) => cell(h, true)) },
    ...rows.map((r) => ({ type: 'tableRow', content: [r.action, r.option, r.old, r.new].map((v) => cell(v)) })),
  ],
});
const doc = (...content) => ({ type: 'doc', version: 1, content });

const findFields = async () => {
  const fields = await app.get(route`/rest/api/3/field`);
  const approvers = fields.find((x) => x.name === 'Approvers' && x.schema?.custom?.endsWith(':multiuserpicker'));
  const participants = fields.find((x) => x.schema?.custom?.endsWith(':sd-request-participants'));
  return { approversField: approvers?.id, participantsField: participants?.id };
};

// ---------- request type (JSM) ----------

export const approvalSetup = async () => {
  const s = await getSettings();
  const base = { approvers: s.approverAccountIds.length, backups: s.backupApproverAccountIds.length, testMode: !s.requesterAsReporter };
  if (!s.approvalProjectKey) return { ...base, usable: false, note: 'No approval space set yet: pick one on the Settings tab, or use Fix on the Health tab (site compatibility).' };
  try {
    const t = await resolveTarget();
    const as = t.requestType ? `"${t.workType.name}" work items with the request type "${t.requestType.name}"` : `"${t.workType.name}" work items`;
    const how = {
      'jsm-request': 'Approvers decide in the work item, the portal or in the app.',
      'jsm-workitem': 'No request type is set, so approvers decide in the work item only (admin page → Settings → Approvals to add one).',
      app: 'The work type has no Jira approval step, so the app runs the approval: approvers decide on the admin page or in "Requests for you".',
    }[t.engine];
    let note = `Requests are raised as ${as} in ${t.project.key} (${ENGINES[t.engine]}). ${how}`;
    if (!s.approverAccountIds.length) note += ' No approvers are set: add them on the admin page.';
    return { ...base, usable: t.engine !== 'jsm-workitem', engine: t.engine, note, requestType: t.requestType ? { id: t.requestType.id, name: t.requestType.name } : null };
  } catch (e) {
    return { ...base, usable: false, note: `Could not read the approval setup: ${e.message.slice(0, 160)}` };
  }
};

const raiseWithRequestType = async (deskId, type, summary, description, requester, onBehalf) => {
  const body = { serviceDeskId: String(deskId), requestTypeId: String(type.id), isAdfRequest: true, requestFieldValues: { summary, description } };
  if (onBehalf) {
    try {
      return { key: (await app.post(route`/rest/servicedeskapi/request`, { ...body, raiseOnBehalfOf: requester })).issueKey, onBehalf: true };
    } catch (e) {
      // the requester isn't a customer of the space: the app raises it and adds them as participant
    }
  }
  const key = (await app.post(route`/rest/servicedeskapi/request`, body)).issueKey;
  await app.post(route`/rest/servicedeskapi/request/${key}/participant`, { accountIds: [requester] }).catch(() => null);
  return { key, onBehalf: false };
};

// ---------- create ----------

export const createApprovalRequest = async ({ kind, projectKey, requester, summary, reason, briefing = [], rows, payload, risk = 'medium', stage = 'superport', approvers: stageApprovers = null, approvedBy = null, intro = [], logRows = null }) => {
  const s = await getSettings();
  // Whoever approved stage 1 is never also asked for the final approval.
  const approverIds = (stageApprovers || s.approverAccountIds).filter((id) => !approvedBy || id !== approvedBy || !s.requesterAsReporter);
  let target = await resolveTarget();
  // A JSM approval step without a request type gives work items that Jira only lets people approve inside the work
  // item. Never raise those: create the hidden request type first (the app has the scope), then use it.
  if (target.engine === 'jsm-workitem' && target.deskId) {
    try {
      await createRequestType({ projectKey: target.project.key, issueTypeId: target.workType.id, name: s.requestTypeName || 'Custom field change' }, 'app');
      target = await resolveTarget(true);
    } catch (e) {
      await raiseAlert('could not create the approval request type', `${target.project.key}: ${e.message}. Requests are raised without request type until this is fixed (admin page → Health → Site compatibility).`).catch(() => null);
    }
  }
  const proj = target.project;
  const it = target.workType;
  const found = await findFields();
  // The approval step names the field Jira reads approvers from; without a step the app keeps them itself.
  const approversField = target.step ? target.step.fieldId : null;
  const { participantsField } = found;
  const description = doc(
    para(txt('Requested by '), mention(requester), txt(` for project ${projectKey} via Custom Field Self-Service for Jira.`)),
    ...(approvedBy ? [para(txt('Approved for the project by its admin '), mention(approvedBy), txt('; this is the second stage.'))] : []),
    ...(stage === 'admin' ? [para(txt('Stage 1 of 2: ', [{ type: 'strong' }]), txt(`a project admin of ${projectKey} decides first: `), ...approverIds.flatMap((a) => [mention(a), txt(' ')]))] : []),
    ...intro.map((l) => para(txt(l))),
    para(txt('Why approval is needed: ', [{ type: 'strong' }]), txt(reason)),
    para(txt('Risk: ', [{ type: 'strong' }]), txt(risk)),
    table(rows),
    ...(briefing.length && stage !== 'admin' ? [para(txt('Approvers: the briefing with the impact on every space is in Jira settings → Apps → Custom Field Self-Service for Jira → Approvals (it is not shown here, because the requester can read this work item).'))] : []),
    para(txt(stage === 'admin'
      ? 'Approve to let the app carry out this request for the project (changes that need a Jira administrator then go to one automatically). Decline to reject it.'
      : 'Approve to let the app execute exactly this change. Decline to reject it. The app comments the result here and e-mails the requester.')),
  );
  const labels = ['custom-field-self-service', { field: 'cfs-new-field', options: 'cfs-options', reuse: 'cfs-reuse', stage1: 'cfs-stage1', bundle: 'cfs-bundle', bulk: 'cfs-bulk', bulkundo: 'cfs-undo' }[kind] || 'cfs-other', `cfs-risk-${risk}`];
  const fields = { project: { id: proj.id }, issuetype: { id: it.id }, summary: summary.slice(0, 250), description, labels };
  if (approversField && approverIds.length) fields[approversField] = approverIds.map((id) => ({ accountId: id }));
  let issue = null;
  let channel = target.engine === 'app' ? `"${it.name}" work item, app approval` : `"${it.name}" work item without request type`;
  const engine = target.engine;
  try {
    const type = target.requestType;
    if (engine === 'jsm-request' && target.deskId && type) {
      const r = await raiseWithRequestType(target.deskId, type, fields.summary, description, requester, s.requesterAsReporter);
      const extra = { labels };
      if (approversField && approverIds.length) extra[approversField] = fields[approversField];
      await app.put(route`/rest/api/3/issue/${r.key}`, { fields: extra }).catch(async () => {
        if (approversField && approverIds.length) await app.put(route`/rest/api/3/issue/${r.key}`, { fields: { [approversField]: fields[approversField] } }).catch(() => null);
      });
      issue = { key: r.key };
      channel = `request type "${type.name}"${r.onBehalf ? ', raised on behalf of the requester' : ', requester as participant'}`;
    }
  } catch (e) {
    issue = null;
  }
  if (!issue) {
    try {
      const who = s.requesterAsReporter ? { reporter: { id: requester } } : (participantsField ? { [participantsField]: [{ accountId: requester }] } : {});
      issue = await app.post(route`/rest/api/3/issue`, { fields: { ...fields, ...who } });
    } catch (e) {
      issue = await app.post(route`/rest/api/3/issue`, { fields });
    }
  }
  const created = Date.now();
  await savePending(issue.key, { issueKey: issue.key, kind, projectKey, requester, summary, reason, rows, ...(logRows ? { logRows } : {}), payload, created, status: 'pending', channel, attempts: 0, stage, approverIds, risk, briefing, approvedBy, engine: issue.engine || (channel.startsWith('request type') ? 'jsm-request' : engine === 'app' ? 'app' : 'jsm-workitem') });
  if (engine === 'app') {
    await comment(issue.key, doc(para(txt('Custom Field Self-Service for Jira runs this approval: '), ...approverIds.flatMap((a) => [mention(a), txt(' ')]), txt(stage === 'admin'
      ? `decide in "Requests for you" on ${projectKey}'s Custom Field Self-Service for Jira page.`
      : 'decide on the admin page (Jira settings → Apps → Custom Field Self-Service for Jira → Approvals).'))));
  }
  await writeLog(projectKey, (logRows || rows).map((r) => ({ ...r, actor: requester, fieldId: payload.fieldId || '', fieldName: payload.fieldName || payload.draft?.name || '', via: `${stage === 'admin' ? 'project admin approval' : 'approval'} requested: ${issue.key}` })));
  if (approverIds.length) {
    const where = stage === 'admin' ? ', or use "Requests for you" on the project\'s Custom fields page' : '';
    await notifyUsers(issue.key, approverIds, `Approval needed: ${summary}`, `${summary}\n\n${reason}\n\nRisk: ${risk}. Open ${issue.key} to approve or decline${where}.`);
  }
  return issue.key;
};

// Stage 1: a user who is not a project admin. Approvers = the project's Administrators role (groups expanded).
export const createStage1Request = async ({ projectKey, requester, plan, rows, preview = [] }) => {
  const s = await getSettings();
  const admins = await projectAdmins(projectKey, s.stage1MaxApprovers);
  let approvers = admins.users.map((u) => u.accountId).filter((id) => id !== requester || !s.requesterAsReporter);
  // Test mode: real project admins are not bothered with test requests; only admins who are also configured
  // SUPERPORT approvers receive them.
  const testNote = !s.requesterAsReporter ? ' Test mode: only project admins who are also configured approvers are asked.' : '';
  if (!s.requesterAsReporter) approvers = approvers.filter((id) => s.approverAccountIds.includes(id));
  if (!approvers.length) throw new Error(`${projectKey} has no project admin who could approve this${testNote ? ' (in test mode only admins who are configured approvers count)' : ''}. Ask a Jira administrator.`);
  const issueKey = await createApprovalRequest({
    kind: 'stage1', stage: 'admin', approvers, projectKey, requester,
    summary: `${projectKey} request: ${plan.summary}`,
    reason: `Requested by someone who is not a project admin of ${projectKey}.${admins.groups.length ? ` Admin group(s): ${admins.groups.join(', ')}.` : ''}${testNote}`,
    risk: 'low',
    briefing: preview,
    rows,
    payload: { plan: { kind: plan.kind, input: plan.input, projectKey: plan.projectKey, summary: plan.summary }, affected: [projectKey] },
  });
  await announce([projectKey], { type: 'requested', issueKey });
  return { issueKey, approvers: admins.users.filter((u) => approvers.includes(u.accountId)) };
};

// ---------- decide and execute ----------

const comment = (key, body) => app.post(route`/rest/api/3/issue/${key}/comment`, { body }).catch(() => null);

const transitionTo = async (key, wanted, resolution) => {
  const t = await app.get(route`/rest/api/3/issue/${key}/transitions`);
  const tr = t.transitions.find((x) => wanted.includes(x.to?.name)) || (resolution && t.transitions.find((x) => x.to?.statusCategory?.key === 'done'));
  if (!tr) return false;
  try {
    await app.post(route`/rest/api/3/issue/${key}/transitions`, { transition: { id: tr.id }, ...(resolution ? { fields: { resolution: { name: resolution } } } : {}) });
  } catch (e) {
    await app.post(route`/rest/api/3/issue/${key}/transitions`, { transition: { id: tr.id } }).catch(() => null);
  }
  return true;
};

// approved | declined | pending: the app's own record for app approvals, otherwise JSM's approval record with the
// status names as a fallback.
const decisionFor = async (key, p) => {
  if (p && p.engine === 'app') return p.appDecision ? { decision: p.appDecision.decision, approver: p.appDecision.by } : { decision: 'pending' };
  try {
    const r = await app.get(route`/rest/servicedeskapi/request/${key}/approval`);
    const vals = r.values || [];
    if (vals.some((v) => v.finalDecision === 'declined')) return { decision: 'declined' };
    const done = vals.find((v) => v.finalDecision === 'approved');
    if (done) return { decision: 'approved', approver: (done.approvers || []).find((a) => a.approverDecision === 'approved')?.approver?.accountId };
    if (vals.length) return { decision: 'pending' };
  } catch (e) {
    // fall through to the status
  }
  const issue = await app.get(route`/rest/api/3/issue/${key}?fields=status,resolution`);
  const st = issue.fields.status?.name;
  if (st === WAITING_STATUS || st === APPROVED_STATUS) return { decision: 'pending' };
  // Closing the work item without an approval record counts as declined (safe); approval needs a recorded decision.
  if (issue.fields.status?.statusCategory?.key === 'done' || issue.fields.resolution) return { decision: 'declined' };
  return { decision: 'pending' };
};

const nameOf = (p) => p.payload.fieldName || p.payload.draft?.name || p.payload.plan?.field?.name || '';
const lockId = (p) => p.payload.fieldId || p.payload.plan?.field?.id || `new:${p.payload.draft?.name || p.issueKey}`;

const runBundleItems = async (p) => {
  const done = p.bundleDone || {};
  const notes = [];
  for (const [i, item] of p.payload.items.entries()) {
    if (done[i]) { notes.push(`${item.entryName}: already done (${done[i]}).`); continue; }
    if (item.kind === 'reuse') {
      const n = await withFieldLock(item.plan.field.id, `approved ${p.issueKey}`, () => executeReuse(item.plan, p.payload.addToScreens, []));
      done[i] = item.plan.field.id;
      notes.push(`${item.entryName}: ${n.join(' ') || 'usable now.'}`);
    } else {
      const res = await createWithScreens(item.draft, item.options);
      done[i] = res.fieldId;
      await setCatalogueFieldId(item.entryId, res.fieldId).catch(() => null);
      notes.push(`${item.entryName}: field ${res.fieldId} created.`);
    }
    await updatePending(p.issueKey, { bundleDone: done });
  }
  return notes.join(' ');
};

const execute = async (p) => {
  let extra = '';
  let fieldId = p.payload.fieldId;
  let batchId;
  if (p.kind === 'stage1') {
    const r = await runPlan(p.payload.plan, { requester: p.requester, approvedBy: p.approver, trusted: true, checkFingerprint: true });
    const stage2 = r.issueKey ? ` It needs a Jira administrator's approval as well: ${r.issueKey} was raised automatically.` : '';
    return { extra: ` ${r.summary || ''}${stage2}`, fieldId: r.fieldId, stage2: r.issueKey };
  }
  if (p.kind === 'bundle') return { extra: ` ${await runBundleItems(p)}` };
  if ((p.kind === 'bulk' || p.kind === 'bulkundo') && !FEATURES.bulk) throw new Error(BULK_OFF);
  if (p.kind === 'bulk') {
    const r = await bulkApproved(p.payload.jobId, p.approver);
    const pr = r?.job?.progress || {};
    const left = r?.job?.status === 'running';
    return { extra: ` Bulk change ${p.payload.jobId}: ${pr.changed || 0} field(s) changed${pr.moved ? `, ${pr.moved} work item(s) updated` : ''} so far${left ? '; the rest continues in the background within minutes' : ''}. One-click undo: project page → Bulk changes or Audit log, or ask Field Assistant.` };
  }
  if (p.kind === 'bulkundo') {
    const r = await bulkUndoApproved(p.payload.jobId, p.approver);
    if (!r) return { extra: ` Bulk change ${p.payload.jobId} was already undone or is no longer finished; nothing to do.` };
    const u = r.job?.undo?.progress || {};
    return { extra: ` Undo of bulk change ${p.payload.jobId}: ${u.done || 0} field(s) back as before${u.restored ? `, ${u.restored} work-item value(s) back` : ''}${r.job?.status === 'undoing' ? '; the rest continues in the background within minutes' : ''}.` };
  }
  await withFieldLock(lockId(p), `approved ${p.issueKey}`, async () => {
    if (p.kind === 'options') {
      if (p.payload.before && !p.batchId) {
        batchId = await saveSnapshot({ projectKey: p.projectKey, fieldId: p.payload.fieldId, fieldName: p.payload.fieldName, contextId: p.payload.contextId, before: p.payload.before });
        await updatePending(p.issueKey, { batchId });
      } else {
        batchId = p.batchId;
      }
      await executePlan(p.payload.fieldId, p.payload.contextId, p.payload.plan);
    } else if (p.kind === 'reuse') {
      const notes = await executeReuse(p.payload.plan, p.payload.addToScreens, p.payload.issueTypeIds);
      extra = ` ${notes.join(' ')}`;
    } else {
      // A retry must not create the field twice: the created id is stored before anything else happens.
      if (p.createdFieldId) {
        fieldId = p.createdFieldId;
        extra = ` Field ${fieldId} was already created on an earlier attempt.`;
      } else {
        const res = await createWithScreens(p.payload.draft, p.payload.options);
        fieldId = res.fieldId;
        await updatePending(p.issueKey, { createdFieldId: fieldId });
        if (p.payload.catalogueId) await setCatalogueFieldId(p.payload.catalogueId, fieldId).catch(() => null);
        const keys = p.payload.draft.projectKeys || [];
        const invited = keys.length > 1 && !p.payload.draft.global
          ? await inviteOtherSpaces({ fieldId, fieldName: p.payload.draft.name, keys, origin: p.projectKey, issueKey: p.issueKey, actor: p.requester }).catch(() => [])
          : [];
        extra = ` Field ${res.fieldId} created.${res.notes.length ? ` ${res.notes.join(' ')}` : ''}${invited.length ? ` The project admins of ${invited.map((x) => x.projectKey).join(', ')} were told it is not on their screens yet.` : ''}`;
      }
    }
  });
  return { extra, fieldId, batchId };
};

// Who may approve: stage 1 = a CURRENT member of the project's Administrators role (after escalation also SUPERPORT);
// stage 2 = SUPERPORT approvers and backups. Never the requester, except in test mode.
export const verifyApprover = async (p, approver, s) => {
  if (!approver) return { ok: false, why: 'the app could not see who approved the request.' };
  if (approver === p.requester && s.requesterAsReporter) return { ok: false, why: 'the requester approved their own request.' };
  if (p.stage === 'admin') {
    const admins = await projectAdmins(p.projectKey, 50).catch(() => ({ users: [] }));
    const ok = admins.users.some((u) => u.accountId === approver) || (p.escalated && s.approverAccountIds.includes(approver));
    return ok ? { ok: true } : { ok: false, why: `the approver is not a project admin of ${p.projectKey}.` };
  }
  const allowed = [...s.approverAccountIds, ...s.backupApproverAccountIds, ...(p.approverIds || [])];
  if (!allowed.includes(approver)) return { ok: false, why: 'the approver is not one of the configured approvers.' };
  if (p.approvedBy && approver === p.approvedBy && s.requesterAsReporter) return { ok: false, why: 'the same person already approved the first stage; a second person has to decide.' };
  // The final approval is the highest step: the approver must hold Jira administrator rights when deciding.
  if (!(await isJiraAdmin(approver))) return { ok: false, why: 'the approver is not a Jira administrator (only Jira administrators give the final approval).' };
  return { ok: true };
};

// Approve or decline from the app (admin inbox, "Requests for you"), AS THE USER through JSM's approval API, so
// Jira itself checks that the user is an approver. Then the app processes the decision at once.
// Requests raised before the approval space had a request type are plain work items: Jira's approval API rejects
// them (vpOriginMissing). If the configured request type uses the same work type, the app attaches it once, after
// which the normal approval API works for them too. Returns true when the request now has a request type.
const attachRequestType = async (issueKey) => {
  const target = await resolveTarget(true).catch(() => null);
  if (!target || !target.requestType) return false;
  const fields = await app.get(route`/rest/api/3/field`);
  const rtField = fields.find((f) => f.schema?.custom?.endsWith(':vp-origin'));
  if (!rtField) return false;
  const issue = await app.get(route`/rest/api/3/issue/${issueKey}?fields=issuetype,project`);
  if (String(issue.fields.issuetype?.id) !== String(target.requestType.issueTypeId) || issue.fields.project?.key !== target.project.key) return false;
  await app.put(route`/rest/api/3/issue/${issueKey}`, { fields: { [rtField.id]: String(target.requestType.id) } });
  await updatePending(issueKey, { engine: 'jsm-request', channel: `request type "${target.requestType.name}" (attached later)` });
  return true;
};

// Step 1 of a decision from a page: checks the request and the decider, attaches a missing request type, and tells the
// page where to post the decision. The page then posts it with requestJira (as the user, so Jira itself checks the
// approver and asks for the user's permission if needed) and calls finishDecision.
export const prepareDecision = async (issueKey, accountId) => {
  const p = await getPending(issueKey);
  if (!p || p.status !== 'pending') throw new Error(`${issueKey} is not waiting for a decision.`);
  if (p.engine === 'app') return { mode: 'app' };
  let approvals;
  try {
    approvals = await app.get(route`/rest/servicedeskapi/request/${issueKey}/approval`);
  } catch (e) {
    if (!/vpOriginMissing|doesn't exist/.test(e.message)) throw e;
    const attached = await attachRequestType(issueKey).catch(() => false);
    if (!attached) throw new Error(`${issueKey} has no request type and none fits it, so Jira only takes the decision in the work item itself (open ${issueKey} → Approve).`);
    approvals = await app.get(route`/rest/servicedeskapi/request/${issueKey}/approval`);
  }
  const open = (approvals.values || []).find((a) => !a.finalDecision || a.finalDecision === 'pending');
  if (!open) return { mode: 'decided' };
  if (!(open.approvers || []).some((x) => x.approver?.accountId === accountId)) throw new Error(`You are not an approver of ${issueKey}.`);
  return { mode: 'jsm', path: `/rest/servicedeskapi/request/${issueKey}/approval/${open.id}` };
};

// Step 2: app approvals are recorded here; JSM decisions were already posted by the page, the app processes them.
export const finishDecision = async (issueKey, decision, accountId, { recorded = false, reason = '' } = {}) => {
  const p = await getPending(issueKey);
  if (!p) throw new Error(`${issueKey} is not a Custom Field Self-Service for Jira request.`);
  if (p.status === 'pending' && p.engine === 'app') return decideInApp(p, decision, accountId, reason);
  if (!recorded && p.status === 'pending') return decideAsUser(issueKey, decision, accountId, reason);
  return processRequest(issueKey, accountId, { reason });
};

// Server-side variant (Rovo and older callers): posts the decision as the user from the backend.
export const decideAsUser = async (issueKey, decision, accountId, reason = '') => {
  const p = await getPending(issueKey);
  if (!p || p.status !== 'pending') throw new Error(`${issueKey} is not waiting for a decision.`);
  if (p.engine === 'app') return decideInApp(p, decision, accountId, reason);
  // Reading the approval step needs JSM agent rights, which approvers often lack: the app reads it. The decision
  // itself is posted AS THE USER, so Jira still checks that this user is an approver of the request.
  let approvals;
  try {
    approvals = await app.get(route`/rest/servicedeskapi/request/${issueKey}/approval`);
  } catch (e) {
    if (!/vpOriginMissing|doesn't exist/.test(e.message)) throw e;
    // Older request without request type: attach it and try again.
    const attached = await attachRequestType(issueKey).catch(() => false);
    if (!attached) throw new Error(`${issueKey} was raised without a request type and the configured request type doesn't fit it, so Jira only takes the decision in the work item itself (open ${issueKey} → Approve).`);
    approvals = await app.get(route`/rest/servicedeskapi/request/${issueKey}/approval`);
  }
  const open = (approvals.values || []).find((a) => !a.finalDecision || a.finalDecision === 'pending');
  if (!open) throw new Error(`${issueKey} has no open approval step.`);
  if (!(open.approvers || []).some((x) => x.approver?.accountId === accountId)) throw new Error(`You are not an approver of ${issueKey}.`);
  try {
    await user.post(route`/rest/servicedeskapi/request/${issueKey}/approval/${open.id}`, { decision: decision === 'approve' ? 'approve' : 'decline' });
  } catch (e) {
    const consent = e.status === 401 || /consent|authoriz/i.test(e.message || '');
    throw new Error(consent
      ? `Jira needs your one-time permission for Custom Field Self-Service for Jira to record decisions in your name. Open ${issueKey} and approve there, or allow the app's access when Jira asks.`
      : `Jira refused the ${decision} (HTTP ${e.status || '?'}). Open ${issueKey} and decide there.`);
  }
  return processRequest(issueKey, accountId, { reason });
};

// App approvals: the app checks the decider like it checks a JSM approver (configured approver of this request,
// never the requester in production), records the decision and comments it on the work item.
const decideInApp = async (p, decision, accountId, reason = '') => {
  const s = await getSettings();
  const listed = (p.approverIds || []).includes(accountId) || (p.stage !== 'admin' && [...s.approverAccountIds, ...s.backupApproverAccountIds].includes(accountId));
  if (!listed) throw new Error(`You are not an approver of ${p.issueKey}.`);
  if (p.stage !== 'admin' && decision === 'approve' && !(await isJiraAdmin(accountId))) throw new Error('Only Jira administrators give the final approval.');
  if (p.stage !== 'admin' && p.approvedBy === accountId && s.requesterAsReporter) throw new Error('You approved the first stage, so someone else gives the final approval.');
  if (accountId === p.requester && s.requesterAsReporter) throw new Error('You asked for this change, so someone else has to decide (self-approvals are off).');
  const d = decision === 'approve' ? 'approved' : 'declined';
  await updatePending(p.issueKey, { appDecision: { decision: d, by: accountId, at: Date.now() } });
  await comment(p.issueKey, doc(para(txt(`${d === 'approved' ? 'Approved' : 'Declined'} in Custom Field Self-Service for Jira by `), mention(accountId), txt('.'))));
  return processRequest(p.issueKey, accountId, { reason });
};

// Who may give a reason for a rejection: the approvers of this request (the decision itself is checked by Jira or
// by decideInApp; this only keeps others from attaching a reason to someone else's decision).
const mayExplain = (p, accountId, s) => !!accountId && ((p.approverIds || []).includes(accountId) || [...s.approverAccountIds, ...s.backupApproverAccountIds].includes(accountId));
const cleanReason = (r) => String(r || '').trim().slice(0, 1000);

// The requester withdraws an open request (UC-03): status Withdrawn, nothing changes. Changes need a new request.
export const withdrawRequest = async (issueKey, accountId) => {
  const p = await getPending(issueKey);
  if (!p || p.requester !== accountId) throw new Error(`${issueKey} is not one of your requests.`);
  if (p.status !== 'pending') throw new Error(`${issueKey} is not waiting for approval any more, so it can't be withdrawn.`);
  await updatePending(issueKey, { status: 'withdrawn', decided: Date.now() });
  await comment(issueKey, doc(para(txt('Withdrawn by the requester in Custom Field Self-Service for Jira. Nothing was changed.'))));
  await transitionTo(issueKey, ['Canceled', 'Cancelled', 'Withdrawn', "Won't do", 'Declined', 'Done', 'Closed'], 'Withdrawn').catch(() => null);
  await writeLog(p.projectKey, (p.logRows || p.rows).map((r) => ({ ...r, actor: p.requester, fieldId: p.payload.fieldId || '', fieldName: nameOf(p), via: `withdrawn: ${issueKey}`, executed: false })));
  if (p.kind === 'bulk') await bulkDeclined(p.payload.jobId, 'withdrawn').catch(() => null);
  if (p.kind === 'bulkundo') await bulkUndoDeclined(p.payload.jobId).catch(() => null);
  await announce([p.projectKey], { type: 'cancelled', issueKey });
  return 'withdrawn';
};

export const processRequest = async (issueKey, actor, { reason = '' } = {}) => {
  const p = await getPending(issueKey);
  if (!p || !['pending', 'failed'].includes(p.status)) return 'not pending';
  const s = await getSettings();
  if (p.status === 'pending') {
    const d = await decisionFor(issueKey, p);
    if (d.decision === 'pending') return 'pending';
    const approver = d.approver || actor || '';
    if (d.decision === 'declined') {
      const why = mayExplain(p, approver, s) ? cleanReason(reason) : '';
      await updatePending(issueKey, { status: 'declined', decided: Date.now(), approver, ...(why ? { declineReason: why } : {}) });
      if (why) await comment(issueKey, doc(para(txt('Reason for the rejection: ', [{ type: 'strong' }]), txt(why))));
      if (p.kind === 'bulk') await bulkDeclined(p.payload.jobId).catch(() => null);
      if (p.kind === 'bulkundo') await bulkUndoDeclined(p.payload.jobId).catch(() => null);
      await writeLog(p.projectKey, (p.logRows || p.rows).map((r) => ({ ...r, actor: p.requester, approver, fieldId: p.payload.fieldId || '', fieldName: nameOf(p), via: `declined: ${issueKey}`, executed: false, ...(why ? { reason: why } : {}) })));
      if (s.notifyRequester) await notifyUsers(issueKey, [p.requester], `Rejected: ${p.summary}`, `Your request ${issueKey} was rejected: ${p.summary}. Nothing was changed.${why ? `\n\nReason: ${why}` : ' See the request for the reason.'}\n\nChanges need a new request.`);
      if (p.engine === 'app') await transitionTo(issueKey, ['Declined', 'Rejected', 'Canceled', 'Cancelled', "Won't do", 'Done', 'Closed'], 'Declined');
      await announce([p.projectKey], { type: 'declined', issueKey });
      return 'declined';
    }
    const verdict = await verifyApprover(p, approver, s);
    if (!verdict.ok) {
      await updatePending(issueKey, { status: 'blocked', approver, decided: Date.now(), error: verdict.why });
      await comment(issueKey, doc(para(txt(`Not executed: ${verdict.why} Nothing was changed. The app's approvers have been alerted.`))));
      await raiseAlert(`approval of ${issueKey} blocked`, `${p.summary}\n${verdict.why}`);
      await writeLog(p.projectKey, (p.logRows || p.rows).map((r) => ({ ...r, actor: p.requester, approver, fieldId: p.payload.fieldId || '', fieldName: nameOf(p), via: `blocked: ${issueKey} (${verdict.why})`, executed: false })));
      return 'blocked';
    }
    const claim = `${Date.now()}-${Math.random()}`;
    await updatePending(issueKey, { status: 'executing', approver, decided: Date.now(), claim });
    if ((await getPending(issueKey))?.claim !== claim) return 'running elsewhere';
    p.approver = approver;
  } else {
    if ((p.attempts || 0) >= MAX_ATTEMPTS) return 'gave up';
    const claim = `${Date.now()}-${Math.random()}`;
    await updatePending(issueKey, { status: 'executing', claim });
    if ((await getPending(issueKey))?.claim !== claim) return 'running elsewhere';
  }
  const attempts = (p.attempts || 0) + 1;
  try {
    const { extra, fieldId, batchId, stage2 } = await execute(p);
    await updatePending(issueKey, { status: 'done', fieldId, attempts, stage2 });
    if (p.kind !== 'stage1') await writeLog(p.projectKey, (p.logRows || p.rows).map((r) => ({ ...r, actor: p.requester, approver: p.approver, fieldId: fieldId || '', fieldName: nameOf(p), via: `approved: ${issueKey}`, executed: true, batchId })));
    await comment(issueKey, doc(para(txt(`${p.kind === 'stage1' ? 'Approved by a project admin and carried out' : 'Approved and executed'} by Custom Field Self-Service for Jira${attempts > 1 ? ` (attempt ${attempts})` : ''}.${extra}`)), table(p.rows)));
    await transitionTo(issueKey, ['Resolved', 'Done', 'Completed', 'Closed'], 'Done');
    const subject = stage2 ? `Approved by your project admin: ${p.summary}` : `Done: ${p.summary}`;
    const body = stage2 ? `Your project admin approved ${issueKey}. A Jira administrator approves the rest in ${stage2}; you'll get an e-mail when it is live.` : `Your request ${issueKey} was approved and the change is live: ${p.summary}.${extra}`;
    if (s.notifyRequester) await notifyUsers(issueKey, [p.requester], subject, body);
    await announce(p.payload.affected || [p.projectKey], { type: 'changed', issueKey, fieldId });
    return 'done';
  } catch (e) {
    const busy = e.name === 'Busy' || /Another change on this field/.test(e.message);
    await updatePending(issueKey, { status: 'failed', error: e.message, attempts: busy ? (p.attempts || 0) : attempts });
    if (!busy && attempts >= MAX_ATTEMPTS) {
      await comment(issueKey, doc(para(txt(`Approved, but the change failed ${attempts} times: ${e.message.slice(0, 500)}. A Jira administrator needs to check this by hand.`))));
      await writeLog(p.projectKey, (p.logRows || p.rows).map((r) => ({ ...r, actor: p.requester, approver: p.approver, fieldId: p.payload.fieldId || '', fieldName: nameOf(p), via: `failed: ${issueKey}`, executed: false, reason: e.message.slice(0, 300) })));
      await raiseAlert(`execution failed for ${issueKey}`, `${p.summary}\n${e.stack || e.message}`);
    } else if (!busy && attempts === 1) {
      await comment(issueKey, doc(para(txt(`Approved; the first attempt failed (${e.message.slice(0, 300)}). The app retries automatically within 5 minutes.`))));
    }
    return 'failed';
  }
};

// Reminders and escalation for requests waiting too long.
const remind = async (p, s) => {
  const age = Date.now() - p.created;
  const approvers = p.approverIds && p.approverIds.length ? p.approverIds : s.approverAccountIds;
  // Stage 1 escalates to SUPERPORT's approvers (nobody in the project decided), stage 2 to the backups.
  const backups = p.stage === 'admin' ? s.approverAccountIds : s.backupApproverAccountIds;
  if (!p.reminded && age > s.reminderHours * HOUR && approvers.length) {
    await comment(p.issueKey, doc(para(txt('Reminder: this request is waiting for approval since '), txt(new Date(p.created).toISOString().slice(0, 16).replace('T', ' ')), txt(' UTC. '), ...approvers.flatMap((a) => [mention(a), txt(' ')]))));
    await notifyUsers(p.issueKey, approvers, `Reminder: approval needed for ${p.issueKey}`, `${p.summary} is waiting for approval for more than ${s.reminderHours} hours.`);
    await updatePending(p.issueKey, { reminded: Date.now() });
  }
  if (!p.escalated && age > s.escalateHours * HOUR && backups.length) {
    const target = await resolveTarget().catch(() => null);
    const approversField = p.engine === 'app' ? null : target?.step?.fieldId || (await findFields()).approversField;
    const all = [...new Set([...approvers, ...backups])];
    if (approversField) await app.put(route`/rest/api/3/issue/${p.issueKey}`, { fields: { [approversField]: all.map((accountId) => ({ accountId })) } }).catch(() => null);
    await comment(p.issueKey, doc(para(txt(`Escalated after ${s.escalateHours} hours: ${p.stage === 'admin' ? 'Jira administrator' : 'backup'} approvers added. `), ...backups.flatMap((a) => [mention(a), txt(' ')]))));
    await notifyUsers(p.issueKey, backups, `Escalation: approval needed for ${p.issueKey}`, `${p.summary} has waited ${s.escalateHours} hours. You were added as approver.`);
    await updatePending(p.issueKey, { escalated: Date.now(), approverIds: all });
  }
};

// SUPERPORT can withdraw a request that should not be decided any more (e.g. stale test requests).
export const cancelRequest = async (issueKey, by, why) => {
  const p = await getPending(issueKey);
  if (!p || !['pending', 'failed'].includes(p.status)) throw new Error(`${issueKey} is not open.`);
  await updatePending(issueKey, { status: 'cancelled', decided: Date.now(), approver: by });
  if (p.kind === 'bulk') await bulkDeclined(p.payload.jobId, 'cancelled').catch(() => null);
  if (p.kind === 'bulkundo') await bulkUndoDeclined(p.payload.jobId).catch(() => null);
  await comment(issueKey, doc(para(txt(`Cancelled by a Jira administrator via Custom Field Self-Service for Jira: ${why || 'no longer needed'}. Nothing was changed.`))));
  await transitionTo(issueKey, ['Canceled', 'Cancelled'], null);
  await writeLog(p.projectKey, (p.logRows || p.rows).map((r) => ({ ...r, actor: p.requester, approver: by, fieldId: p.payload.fieldId || '', fieldName: nameOf(p), via: `cancelled: ${issueKey}`, executed: false })));
  await announce([p.projectKey], { type: 'cancelled', issueKey });
  return 'cancelled';
};

// Trigger: avi:jira:updated:issue
export const onIssueUpdated = async (event) => {
  // Kill switch: a decision executes changes, so nothing happens while the app is paused or down. The request stays
  // pending, and the sweep carries the decision out once the switch is off again.
  if (!mayRun('write')) return;
  const key = event?.issue?.key || '';
  const s = await getSettings();
  if (!key.startsWith(`${s.approvalProjectKey}-`)) return;
  const items = event.changelog?.items || [];
  if (!items.some((i) => i.field === 'status' || i.fieldId === 'status')) return;
  await processRequest(key, event.atlassianId);
};

// Every 5 minutes: decisions that the trigger missed, retries, reminders, escalation.
export const sweep = async () => {
  // Kill switch: everything below executes, reminds, alerts or copies values, so it waits until the switch is off.
  if (!mayRun('write')) return { checked: 0, skipped: 'maintenance' };
  const s = await getSettings();
  const open = await allPending();
  for (const p of open) {
    try {
      if (p.status === 'pending' && p.engine !== 'app' && p.engine !== 'jsm-request' && !String(p.channel || '').startsWith('request type') && !p.attachTried) {
        await updatePending(p.issueKey, { attachTried: Date.now() });
        await attachRequestType(p.issueKey).catch(() => false);
      }
      const r = await processRequest(p.issueKey, '');
      if (r === 'pending') await remind(p, s);
    } catch (e) {
      await raiseAlert(`sweep failed for ${p.issueKey}`, e.stack || e.message);
    }
  }
  await continueBulkJobs(60000).catch(async (e) => { await raiseAlert('bulk change job failed', e.stack || e.message); });
  const migrations = await migrate().catch(async (e) => { await raiseAlert('value copy job failed', e.stack || e.message); return 0; });
  await watchdog().catch(async (e) => { await raiseAlert('watchdog failed', e.stack || e.message); });
  await kvs.set('heartbeat:sweep', { at: Date.now(), open: open.length, migrations });
  return { checked: open.length };
};
