/**
 * Backend of the admin page (Jira settings → Apps): settings, approval health, self-test, alerts, the site check, the
 * site-wide audit log and decisions. Only Jira administrators get an answer, and every resolver passes the kill
 * switch first, with an explicit list of the reads that still work while changes are paused.
 *
 * @file        src/admin.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import Resolver from '@forge/resolver';
import { route } from '@forge/api';
import * as J from './jira';
import { getSettings, saveSettings, DEFAULTS, setupState } from './settings';
import { approvalSetup, cancelRequest, decideAsUser, prepareDecision, finishDecision } from './approvals';
import { checkSpace, createRequestType } from './approvalspace';
import { alertContent, alertWorkType, notifyUsers } from './ops';
import { allPending, allRequests, readAllLogs } from './audit';
import { requestStatus } from './shared/status';
import { safeModeState, clearAutoSafeMode } from './guards';
import { formatCatalogue } from './shared/catalogue';
import { migrations, nightly, weekly, digestGroups, digestMessage } from './nightly';
import { watchdog } from './watchdog';
import { namesOf } from './service';
import { runSelfTest, lastSelfTest, findSelfTestField, SELFTEST_FIELD_NAME } from './selftest';
import { runSiteCheck, lastSiteCheck, applyFixes, createSelfTestField, lookupSelfTestField } from './sitecheck';
import { guidelinesMarkdown } from './shared/guidelinesDoc';
import { CREATABLE, typeByKey } from './shared/fieldtypes';
import { requestDiff } from './shared/diff';
import { kvs } from '@forge/kvs';
import { gateResolvers, availability, refusal } from './maintenance';

// Checked with the app's own rights for the accountId Jira provides, so no per-user consent is needed.
const assertJiraAdmin = async (accountId) => {
  if (!accountId || !(await J.hasGlobalPermission(accountId, 'ADMINISTER'))) throw new J.Forbidden('Only Jira administrators can open these settings.');
};

const handle = (fn) => async (req) => {
  try {
    await assertJiraAdmin(req.context.accountId);
    return await fn({ payload: req.payload || {}, accountId: req.context.accountId });
  } catch (e) {
    return { error: e.message, forbidden: e instanceof J.Forbidden };
  }
};

const resolver = new Resolver();

// Kill switch (maintenance.js): every resolver passes it first, before the Jira administrator check. Only the
// resolvers listed here still answer while changes are paused; every other one counts as a write, so a new resolver
// is blocked in read-only mode unless it is added here on purpose. 'availability' always answers.
const READS = new Set(['state', 'approvalSpace', 'previewAlert', 'previewDigest', 'siteCheck', 'auditAll', 'tour']);
gateResolvers(resolver, READS);
resolver.define('availability', availability);

resolver.define('state', handle(async () => {
  const s = await getSettings();
  const [setup, selftest, open, heartbeat, nightly, safe, migs, index, watch] = await Promise.all([
    approvalSetup(), lastSelfTest(), allPending(), kvs.get('heartbeat:sweep'), kvs.get('heartbeat:nightly'), safeModeState(s), migrations(),
    J.getProjectProperty(s.approvalProjectKey, 'cfs-automation-index'), kvs.get('heartbeat:watchdog'),
  ]);
  const names = await namesOf(open.flatMap((p) => [p.requester, ...(p.approverIds || [])]));
  const alerts = await J.app.post(route`/rest/api/3/search/jql`, {
    jql: `project = "${s.approvalProjectKey}" AND labels = cfs-alert ORDER BY created DESC`, maxResults: 10, fields: ['summary', 'status', 'created'],
  }).catch(() => ({ issues: [] }));
  const [selfTestField, siteCheck] = await Promise.all([lookupSelfTestField(s).catch(() => null), lastSiteCheck()]);
  // Production readiness: test switches that must be off, and approvers who can't give the final approval.
  const approvers = [...new Set([...s.approverAccountIds, ...s.backupApproverAccountIds])];
  const notAdmin = [];
  for (const id of approvers) if (!(await J.hasGlobalPermission(id, 'ADMINISTER').catch(() => false))) notAdmin.push(id);
  const approverNames = await namesOf([...notAdmin, ...s.simulateNonAdminIds, ...(s.simulateProjectAdminIds || []), ...s.approverAccountIds, ...s.backupApproverAccountIds]);
  const production = {
    testSettings: [
      ...(!s.requesterAsReporter ? ['Self-approvals are allowed (test mode).'] : []),
      ...(s.simulateNonAdminIds.length ? [`Treated as non-admins (test): ${s.simulateNonAdminIds.map((id) => approverNames[id] || id).join(', ')}.`] : []),
      ...((s.simulateProjectAdminIds || []).length ? [`Treated as project admins only (test): ${s.simulateProjectAdminIds.map((id) => approverNames[id] || id).join(', ')}.`] : []),
    ],
    approversNotAdmin: notAdmin.map((id) => approverNames[id] || id),
    noApprover: !s.approverAccountIds.length,
    oneApprover: s.approverAccountIds.length + s.backupApproverAccountIds.length === 1,
  };
  return {
    production,
    settings: s,
    // Display names of the people in the settings' user pickers.
    people: approverNames,
    checklist: { ...setupState(s, selfTestField, siteCheck), selfTestFieldName: selfTestField ? selfTestField.name : SELFTEST_FIELD_NAME },
    siteCheck,
    defaults: DEFAULTS,
    types: CREATABLE.map((t) => ({ key: t.key, label: t.label })),
    setup,
    selftest,
    heartbeat,
    nightly,
    watch,
    safe,
    catalogueText: formatCatalogue(s.catalogue),
    // Every project on the site, for the pilot-projects picker.
    projects: Object.values(await J.allProjects().catch(() => ({}))).sort((a, b) => a.key.localeCompare(b.key)),
    migrations: migs,
    automationIndex: index ? { at: index.at, rules: index.rules || 0, fields: Object.keys(index.fields || {}).length } : null,
    open: open.map((p) => ({
      issueKey: p.issueKey, summary: p.summary, projectKey: p.projectKey, status: p.status, created: p.created, attempts: p.attempts || 0, error: p.error || '', kind: p.kind,
      fieldName: p.payload?.fieldName || p.payload?.draft?.name || p.payload?.plan?.field?.name || '', description: p.payload?.draft?.description || '',
      projects: p.payload?.draft?.projectKeys || p.payload?.affected || [p.projectKey], typeKey: p.payload?.draft?.typeKey || '', requesterId: p.requester,
      stage: p.stage || 'superport', risk: p.risk || 'medium', reason: p.reason || '', rows: p.rows || [], briefing: p.briefing || [],
      requester: names[p.requester] || p.requester, approvers: (p.approverIds || []).map((id) => names[id] || id),
      diff: requestDiff(p, { typeLabel: (k) => typeByKey(k)?.label || k }),
    })),
    alerts: (alerts.issues || []).map((i) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status?.name, created: i.fields.created })),
  };
}));

// Approval space: options + configuration check for the (unsaved) selection on the Settings tab.
resolver.define('approvalSpace', handle(({ payload }) => checkSpace(payload || {})));
resolver.define('createRequestType', handle(({ payload, accountId }) => createRequestType(payload || {}, accountId)));

// "How it looks": exactly what the app would raise or send, built by the same functions as the real thing.
resolver.define('previewAlert', handle(async ({ payload }) => {
  const s = await getSettings();
  const key = String(payload.projectKey || s.approvalProjectKey);
  const proj = await J.app.get(route`/rest/api/3/project/${key}?expand=issueTypes`).catch(() => null);
  const it = proj ? alertWorkType(proj.issueTypes) : null;
  const c = alertContent(`execution failed for ${key}-99`, `Approved, but the change failed 3 times: Jira answered HTTP 409 (option "Benelux" already exists).\nField: Region (customfield_10117), context ${key}.\nNothing was changed; the request stays open for a retry.`);
  const names = await namesOf(s.approverAccountIds);
  const last = await J.app.post(route`/rest/api/3/search/jql`, { jql: `project = "${key}" AND labels = cfs-alert ORDER BY created DESC`, maxResults: 1, fields: ['summary'] }).catch(() => ({ issues: [] }));
  return { ...c, project: proj ? `${proj.key} · ${proj.name}` : key, workType: it ? it.name : '?', recipients: s.approverAccountIds.map((id) => names[id] || id), dedupe: 'At most one per problem and day.', lastReal: last.issues?.[0] ? { key: last.issues[0].key, summary: last.issues[0].fields.summary } : null };
}));
resolver.define('previewDigest', handle(async ({ accountId, payload }) => {
  const s = await getSettings();
  const groups = await digestGroups(s);
  const names = await namesOf(Object.keys(groups));
  const mine = groups[accountId] || [];
  const all = Object.values(groups).flat().filter((p, i, a) => a.findIndex((x) => x.issueKey === p.issueKey) === i);
  const m = digestMessage(mine.length ? mine : all);
  if (payload.send) {
    // Showing the digest is a read; sending it is not.
    const refused = refusal('write');
    if (refused) return refused;
    if (!m.anchor) throw new Error('Nothing is waiting, so there is no digest to send.');
    const ok = await notifyUsers(m.anchor, [accountId], `[Preview] ${m.subject}`, m.text);
    if (!ok) throw new Error('Jira did not accept the e-mail (the app needs to see the request it is attached to).');
    return { sent: true };
  }
  return { ...m, forYou: mine.length > 0, recipients: Object.keys(groups).map((a) => `${names[a] || a} (${groups[a].length})`), when: 'Every night with the nightly checks, only to approvers with something waiting.' };
}));

// Site compatibility check (Health tab and setup checklist).
resolver.define('siteCheck', handle(({ accountId }) => runSiteCheck(accountId)));
resolver.define('siteFix', handle(({ payload, accountId }) => applyFixes(payload.fixIds || [], accountId)));

// Setup checklist: creates the field the daily self-test edits and restores, in the approval space only.
resolver.define('createSelfTestField', handle(({ accountId }) => createSelfTestField(accountId)));

resolver.define('save', handle(({ payload, accountId }) => saveSettings(payload.settings || {}, accountId)));

resolver.define('selftest', handle(() => runSelfTest('admin page')));

resolver.define('cancel', handle(({ payload, accountId }) => cancelRequest(payload.issueKey, accountId, payload.why)));

// Approval inbox: decide as the user through JSM (Jira checks the user is an approver), then the app executes.
resolver.define('prepareDecide', handle(({ payload, accountId }) => prepareDecision(payload.issueKey, accountId)));
resolver.define('decide', handle(async ({ payload, accountId }) => {
  const reason = String(payload.reason || '').trim();
  if (payload.decision !== 'approve' && reason.length < 3 && !payload.recorded) throw new Error('Give a reason for the rejection: the requester sees it.');
  return { result: await finishDecision(payload.issueKey, payload.decision, accountId, { recorded: !!payload.recorded, reason }) };
}));

// The site-wide audit log (UC-07: Jira administrators see every space): changes and requests with their status.
resolver.define('auditAll', handle(async () => {
  const [log, requests, s] = await Promise.all([readAllLogs(3000), allRequests(1000), getSettings()]);
  const names = await namesOf([...new Set([...log.flatMap((l) => [l.actor, l.approver]), ...requests.flatMap((r) => [r.requester, r.approver])].filter(Boolean))]);
  return {
    log,
    requests: requests.map((p) => ({ issueKey: p.issueKey, projectKey: p.projectKey, summary: p.summary, created: p.created, decided: p.decided || null, status: requestStatus(p), requester: p.requester, approver: p.approver || null, reason: p.declineReason || '', fieldName: p.payload?.fieldName || p.payload?.draft?.name || '', rows: p.rows || [] })).sort((a, b) => b.created - a.created),
    names,
    retentionMonths: s.auditRetentionMonths,
  };
}));

// One click for every low-risk SUPERPORT request the user can approve. Each one is still checked individually.
resolver.define('approveLowRisk', handle(async ({ accountId }) => {
  const open = (await allPending()).filter((p) => p.status === 'pending' && (p.stage || 'superport') === 'superport' && p.risk === 'low');
  const results = [];
  for (const p of open) {
    try {
      results.push({ issueKey: p.issueKey, result: await decideAsUser(p.issueKey, 'approve', accountId) });
    } catch (e) {
      results.push({ issueKey: p.issueKey, error: e.message });
    }
  }
  return { results };
}));

resolver.define('runNightly', handle(() => nightly()));
resolver.define('runWatchdog', handle(() => watchdog(true)));
resolver.define('runWeekly', handle(() => weekly()));

// First-visit tour of the control centre, per admin.
const tourKey = (accountId) => `tour-admin:${String(accountId).replace(/[^a-zA-Z0-9:._#-]/g, '_')}`;
resolver.define('tour', handle(async ({ accountId }) => ({ seen: !!(await kvs.get(tourKey(accountId))) })));
resolver.define('tourSeen', handle(async ({ accountId }) => { await kvs.set(tourKey(accountId), Date.now()); return { ok: true }; }));

resolver.define('clearSafeMode', handle(async ({ accountId }) => {
  await clearAutoSafeMode(accountId);
  return { ok: true };
}));

resolver.define('guidelines', handle(async () => {
  const s = await getSettings();
  const markdown = guidelinesMarkdown(s);
  // Published as a property of the approval space, from where 13_guidelines_page.py builds the Confluence page.
  await J.app.put(route`/rest/api/3/project/${s.approvalProjectKey}/properties/cfs-guidelines`, { markdown, at: Date.now() }).catch(() => null);
  return { markdown };
}));

export const adminHandler = resolver.getDefinitions();
