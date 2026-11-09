/**
 * Site compatibility check: size, field configuration model, products, project types, the app's permissions, storage,
 * the approval space and a timed field read, with fixes the app can apply itself. The latest result is kept for the
 * admin page.
 *
 * @file        src/sitecheck.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import * as J from './jira';
import { getSettings, saveSettings } from './settings';
import { overview } from './service';
import { checkSpace, createRequestType } from './approvalspace';
import { createNewField } from './fields';
import { safeModeState, clearAutoSafeMode } from './guards';

export const SELFTEST_FIELD_NAME = 'Field Self-Service Self-test';
const LEGACY_SELFTEST_FIELD_NAME = 'CFS Selftest Options';
export const findSelfTestField = (all, s) => (s.selfTestFieldId ? all.find((x) => x.id === s.selfTestFieldId) : null)
  || all.find((x) => x.name === SELFTEST_FIELD_NAME) || all.find((x) => x.name === LEGACY_SELFTEST_FIELD_NAME) || null;

// Targeted lookup (a few small searches instead of listing every custom field: fast on sites with thousands).
export const lookupSelfTestField = async (s) => {
  const found = [];
  if (s.selfTestFieldId) {
    const r = await J.app.get(route`/rest/api/3/field/search?type=custom&id=${s.selfTestFieldId}`).catch(() => ({ values: [] }));
    found.push(...(r.values || []));
  }
  for (const name of [SELFTEST_FIELD_NAME, LEGACY_SELFTEST_FIELD_NAME]) {
    if (found.length) break;
    const r = await J.app.get(route`/rest/api/3/field/search?type=custom&query=${name}&maxResults=50`).catch(() => ({ values: [] }));
    found.push(...(r.values || []));
  }
  return findSelfTestField(found, s);
};

// The field the daily self-test edits and restores, in the approval space only.
export const createSelfTestField = async (accountId) => {
  const s = await getSettings();
  if (!s.approvalProjectKey) throw new Error('Pick and save the approval space first.');
  const existing = await lookupSelfTestField(s);
  if (existing) {
    await saveSettings({ selfTestFieldId: existing.id }, accountId);
    return { fieldId: existing.id, created: false };
  }
  const project = await J.getProject(s.approvalProjectKey);
  const res = await createNewField({
    name: SELFTEST_FIELD_NAME, description: "Used by Custom Field Self-Service for Jira's daily self-test (edited and restored automatically). Do not use.",
    typeKey: 'select', global: false, projectKeys: [project.key], projectIds: [String(project.id)], issueTypeIds: [], justification: 'daily self-test',
  }, [{ value: 'Alpha' }, { value: 'Beta' }, { value: 'Gamma' }]);
  await saveSettings({ selfTestFieldId: res.fieldId }, accountId);
  return { fieldId: res.fieldId, created: true };
};

const LEVEL = { ok: 0, warn: 1, fail: 2 };

const timed = async (fn) => {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
};

export const runSiteCheck = async (accountId, { quick = false } = {}) => {
  const s = await getSettings();
  const checks = [];
  const add = (level, label, detail, fix = null) => checks.push({ level, label, detail, ...(fix ? { fix } : {}) });
  const guard = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      add('fail', label, `Could not check: ${e.message.slice(0, 200)}`);
    }
  };

  await guard('Jira API', async () => {
    const { value, ms } = await timed(() => J.app.get(route`/rest/api/3/serverInfo`));
    add(ms > 3000 ? 'warn' : 'ok', 'Jira API', `${value.baseUrl} answers in ${ms} ms${ms > 3000 ? ': slow; pages may take longer on this site' : ''}.`);
  });

  let fieldCount = 0;
  await guard('Site size', async () => {
    const [f, p] = await Promise.all([
      J.app.get(route`/rest/api/3/field/search?type=custom&maxResults=1`),
      J.app.get(route`/rest/api/3/project/search?maxResults=1`),
    ]);
    fieldCount = f.total || 0;
    const big = fieldCount > 1500 || (p.total || 0) > 1000;
    add(big ? 'warn' : 'ok', 'Site size', `${fieldCount} custom fields, ${p.total || 0} projects.${big ? ' Large site: the field list of a project is read in passes and pre-warmed hourly in the background.' : ''}`);
  });

  await guard('Field configuration', async () => {
    let schemes = false;
    try {
      await J.app.get(route`/rest/api/3/config/fieldschemes?maxResults=1`);
      schemes = true;
    } catch (e) {
      if (![400, 403, 404].includes(e.status)) throw e;
    }
    add('ok', 'Field configuration', schemes
      ? 'This site uses field schemes: a project lists the fields of its field scheme(s).'
      : 'Classic field configurations: a project lists the fields that have a context for it.');
  });

  await guard('Jira Service Management', async () => {
    try {
      const r = await J.app.get(route`/rest/servicedeskapi/servicedesk?limit=1`);
      add('ok', 'Jira Service Management', (r.values || []).length ? 'Service spaces found: approvals can use JSM approval steps and request types.' : 'No service space on this site: approvals run in the app itself (any company-managed project works as approval space).');
    } catch (e) {
      add('ok', 'Jira Service Management', 'Not available here: approvals run in the app itself (approval space can be any company-managed project).');
    }
  });

  const pilot = s.enabledProjects.length ? s.enabledProjects : [];
  if (!s.configured) add('warn', 'Pilot projects', 'Not set up yet: enable a project from its Custom Field Self-Service for Jira page or on the Settings tab.');
  else if (!pilot.length) add('warn', 'Pilot projects', 'Enabled for ALL projects. On big sites start with a few pilot projects.');
  for (const key of pilot.slice(0, 25)) {
    await guard(`Project ${key}`, async () => {
      let st;
      try {
        st = await J.projectStyle(key);
      } catch (e) {
        add('fail', `Project ${key}`, `Not found or not visible to the app (${e.status || e.message.slice(0, 80)}). Remove it from the pilot or check the app's project access.`,
          pilot.length > 1 ? { id: `unpilot:${key}`, label: `Remove ${key} from the pilot` } : null);
        return;
      }
      if (J.isTeamManaged(st)) {
        add('warn', `Project ${key}`, 'Team-managed space: its fields are managed in the space itself; Custom Field Self-Service for Jira shows a notice there instead.',
          pilot.length > 1 ? { id: `unpilot:${key}`, label: `Remove ${key} from the pilot` } : null);
        return;
      }
      const perms = await J.app.get(route`/rest/api/3/mypermissions?projectKey=${key}&permissions=BROWSE_PROJECTS`);
      const browse = perms.permissions?.BROWSE_PROJECTS?.havePermission;
      add(browse ? 'ok' : 'fail', `Project ${key}`, browse
        ? `${st.name}: company-managed, the app can read its work items (usage counts, impact).`
        : `${st.name}: the app cannot browse it, so usage counts and impact stay empty. Give "atlassian-addons-project-access" Browse projects in its permission scheme.`);
    });
  }

  await guard('App storage', async () => {
    const k = `sitecheck:probe:${Date.now()}`;
    await kvs.set(k, { x: 1 });
    const back = await kvs.get(k);
    await kvs.delete(k);
    add(back && back.x === 1 ? 'ok' : 'fail', 'App storage', back && back.x === 1 ? 'Write, read and delete work.' : 'Storage did not return what was written.');
  });

  await guard('Permission checks', async () => {
    const admin = await J.hasGlobalPermission(accountId, 'ADMINISTER');
    add(admin ? 'ok' : 'fail', 'Permission checks', admin ? 'The app can check Jira permissions for users (no per-user consent needed).' : 'The permission check did not recognise you as Jira admin.');
  });

  const usablePilot = pilot.filter((k) => checks.some((c) => c.label === `Project ${k}` && c.level === 'ok'));
  if (s.approvalProjectKey) {
    await guard('Approval space', async () => {
      const r = await checkSpace({ projectKey: s.approvalProjectKey, issueTypeId: s.approvalIssueTypeId || '', requestTypeId: s.approvalRequestTypeId || '' });
      const fixFor = {
        'Work type': { id: 'worktype:auto', label: 'Pick the best work type for approvals' },
        'Request type': { id: 'reqtype:create', label: `Create the hidden request type "${s.requestTypeName || 'Custom field change'}"` },
        Approvers: { id: 'approvers:me', label: 'Make me the first approver' },
        'Self-approvals': { id: 'selfapprove:off', label: 'Switch self-approvals off' },
      };
      const notes = r.checks.filter((c) => c.level !== 'ok');
      if (!notes.length) add('ok', 'Approval space', `${s.approvalProjectKey}: ready (${r.summary.slice(0, 220)})`);
      for (const c of notes) add(c.level, `Approval: ${c.label}`, c.detail, fixFor[c.label] || null);
    });
  } else {
    add('fail', 'Approval space', 'Not set yet: approval requests have nowhere to go.',
      usablePilot.length ? { id: 'space:auto', label: `Use ${usablePilot[0]} as approval space` } : null);
  }
  if (!s.approverAccountIds.length && !checks.some((c) => c.fix?.id === 'approvers:me')) {
    add('fail', 'Approvers', 'No approvers are set.', { id: 'approvers:me', label: 'Make me the first approver' });
  }
  // Only Jira administrators give the final approval: an approver without those rights can't decide anything.
  await guard('Approver rights', async () => {
    const ids = [...new Set([...s.approverAccountIds, ...s.backupApproverAccountIds])];
    const bad = [];
    for (const id of ids) if (!(await J.hasGlobalPermission(id, 'ADMINISTER').catch(() => false))) bad.push(id);
    if (bad.length) add('warn', 'Approver rights', `${bad.length} of ${ids.length} approver(s) are not Jira administrators, so they can't give the final approval. Replace them on the Settings tab.`);
    else if (ids.length) add('ok', 'Approver rights', `All ${ids.length} approver(s) are Jira administrators.`);
  });
  if (s.simulateNonAdminIds.length || (s.simulateProjectAdminIds || []).length) {
    add('warn', 'Test settings', 'TEST ONLY lists are set (users treated as non-admins or project admins). Empty them on the Settings tab before real use.');
  }
  await guard('Self-test field', async () => {
    const f = await lookupSelfTestField(s);
    if (f) add('ok', 'Self-test field', `${f.name} (${f.id}).`);
    else add('warn', 'Self-test field', 'Missing: the daily self-test cannot check writes.', s.approvalProjectKey ? { id: 'selftest:create', label: 'Create the self-test field' } : null);
  });
  await guard('Safe mode', async () => {
    const safe = await safeModeState(s);
    if (safe.on && safe.source !== 'manual') add('warn', 'Safe mode', `Switched on automatically: ${String(safe.reason || '').slice(0, 200)}`, { id: 'safemode:clear', label: 'Switch automatic safe mode off' });
    else if (safe.on) add('warn', 'Safe mode', 'Switched on on the Settings tab: every change needs approval.');
  });

  const first = pilot.find((k) => !checks.some((c) => c.label === `Project ${k}` && c.level !== 'ok'));
  if (first && !quick) {
    await guard('Field list speed', async () => {
      const { value, ms } = await timed(() => overview(first, true));
      const p = value.progress || { done: value.fields.length, total: value.fields.length };
      add(value.incomplete || ms > 15000 ? 'warn' : 'ok', 'Field list speed', `${first}: ${p.done} of ${p.total} fields read in ${Math.round(ms / 100) / 10} s${value.incomplete ? '; the rest follows in further passes (the page does this by itself)' : ''}.`);
    });
  }

  const level = checks.reduce((w, c) => (LEVEL[c.level] > LEVEL[w] ? c.level : w), 'ok');
  const result = { at: Date.now(), level, checks, fieldCount, fixes: checks.filter((c) => c.fix).map((c) => c.fix) };
  await kvs.set('sitecheck:last', result);
  return result;
};

export const lastSiteCheck = () => kvs.get('sitecheck:last');

// Applies the fixes the check offered. Each fix only touches the app's own settings or creates what the app itself
// needs (its self-test field, its hidden request type); shared Jira configuration such as permission schemes is never
// changed here. Returns what was done and the fresh check.
export const applyFixes = async (ids, accountId, { quick = false } = {}) => {
  const wanted = [...new Set((Array.isArray(ids) ? ids : String(ids || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean))];
  const done = [];
  const failed = [];
  for (const id of wanted) {
    try {
      const s = await getSettings();
      const [kind, arg] = id.split(':');
      if (kind === 'unpilot') {
        const rest = s.enabledProjects.filter((k) => k !== arg);
        if (!rest.length) throw new Error(`removing ${arg} would leave the pilot empty, which means ALL projects. Add another project first.`);
        await saveSettings({ enabledProjects: rest }, accountId);
        done.push(`${arg} removed from the pilot.`);
      } else if (id === 'space:auto') {
        const last = (await kvs.get('sitecheck:last')) || { checks: [] };
        const key = s.enabledProjects.find((k) => last.checks.some((c) => c.label === `Project ${k}` && c.level === 'ok'));
        if (!key) throw new Error('no company-managed pilot project the app can read.');
        const r = await checkSpace({ projectKey: key, issueTypeId: '', requestTypeId: '' });
        await saveSettings({ approvalProjectKey: key, approvalIssueTypeId: r.selection.issueTypeId || '', approvalRequestTypeId: r.selection.requestTypeId || '' }, accountId);
        const wt = (r.options.workTypes || []).find((t) => t.id === r.selection.issueTypeId);
        done.push(`${key} is now the approval space (work type "${wt ? wt.name : r.selection.issueTypeId || '?'}").`);
      } else if (id === 'worktype:auto') {
        const r = await checkSpace({ projectKey: s.approvalProjectKey, issueTypeId: '', requestTypeId: '' });
        await saveSettings({ approvalIssueTypeId: r.selection.issueTypeId || '', approvalRequestTypeId: r.selection.requestTypeId || '' }, accountId);
        done.push('Approval work type picked.');
      } else if (id === 'reqtype:create') {
        const r = await createRequestType({ projectKey: s.approvalProjectKey, issueTypeId: s.approvalIssueTypeId, name: s.requestTypeName }, accountId);
        done.push(`Request type "${r.requestType.name}" ${r.created ? 'created' : 'selected'}.`);
      } else if (id === 'approvers:me') {
        await saveSettings({ approverAccountIds: [...new Set([...s.approverAccountIds, accountId])] }, accountId);
        done.push('You are now an approver.');
      } else if (id === 'selfapprove:off') {
        await saveSettings({ requesterAsReporter: true }, accountId);
        done.push('Self-approvals switched off.');
      } else if (id === 'selftest:create') {
        const r = await createSelfTestField(accountId);
        done.push(`Self-test field ${r.fieldId} ${r.created ? 'created' : 'found'}.`);
      } else if (id === 'safemode:clear') {
        await clearAutoSafeMode(accountId);
        done.push('Automatic safe mode switched off.');
      } else {
        throw new Error('unknown fix.');
      }
    } catch (e) {
      failed.push(`${id}: ${e.message.slice(0, 200)}`);
    }
  }
  const check = await runSiteCheck(accountId, { quick });
  return { done, failed, check };
};
