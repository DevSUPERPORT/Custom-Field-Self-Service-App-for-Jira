/**
 * Reads the approval space live from Jira with the app's rights: work types, the approval step of each workflow and
 * every request type, hidden ones included. Also the configuration check, the request type helper and the target the
 * approval module uses when it raises a request.
 *
 * @file        src/approvalspace.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import api, { route } from '@forge/api';
import { app, hasProjectPermission } from './jira';
import { getSettings, saveSettings } from './settings';
import { resolveSelection, checkSetup, describeSetup, suggestSelection, worst } from './shared/approvalspace';

const TYPE_LABEL = { service_desk: 'Jira Service Management', business: 'Jira Work Management', software: 'Jira Software', product_discovery: 'Product Discovery' };
const LEGACY_ISSUE_TYPE = process.env.APPROVAL_ISSUE_TYPE || 'Service Request with Approvals';

const fieldNames = async () => Object.fromEntries((await app.get(route`/rest/api/3/field`)).map((f) => [f.id, f.name]));

// Work type id -> { workflow, approval step } from the project's workflow scheme.
const approvalSteps = async (projectId, workTypeIds) => {
  const ws = await app.get(route`/rest/api/3/workflowscheme/project?projectId=${projectId}`);
  const scheme = ws.values?.[0]?.workflowScheme || {};
  const byType = Object.fromEntries(workTypeIds.map((id) => [id, scheme.issueTypeMappings?.[id] || scheme.defaultWorkflow || 'jira']));
  const names = [...new Set(Object.values(byType))];
  const res = await app.post(route`/rest/api/3/workflows`, { workflowNames: names });
  const statusName = Object.fromEntries((res.statuses || []).map((s) => [String(s.id), s.name]));
  const fields = await fieldNames();
  const steps = {};
  for (const w of res.workflows || []) {
    const st = (w.statuses || []).find((s) => s.approvalConfiguration && String(s.approvalConfiguration.active) === 'true');
    steps[w.name] = st ? {
      statusId: String(st.statusReference),
      statusName: statusName[String(st.statusReference)] || String(st.statusReference),
      fieldId: st.approvalConfiguration.fieldId,
      fieldName: fields[st.approvalConfiguration.fieldId] || st.approvalConfiguration.fieldId,
      conditionType: st.approvalConfiguration.conditionType,
      conditionValue: st.approvalConfiguration.conditionValue,
      exclude: st.approvalConfiguration.exclude || [],
      transitionApproved: st.approvalConfiguration.transitionApproved,
      transitionRejected: st.approvalConfiguration.transitionRejected,
    } : null;
  }
  return Object.fromEntries(Object.entries(byType).map(([id, wf]) => [id, { workflow: wf, approval: steps[wf] || null }]));
};

const serviceDesk = async (projectKey) => {
  const desks = await sdPaged((s) => route`/rest/servicedeskapi/servicedesk?start=${s}&limit=100`);
  return desks.find((d) => d.projectKey === projectKey) || null;
};

// The servicedeskapi pages with start/limit/isLastPage instead of startAt/isLast.
const sdPaged = async (pathAt) => {
  const out = [];
  let start = 0;
  for (let i = 0; i < 20; i += 1) {
    const res = await app.get(pathAt(start));
    out.push(...(res.values || []));
    if (res.isLastPage !== false || !(res.values || []).length) break;
    start += res.values.length;
  }
  return out;
};

export const spaceOptions = async (projectKey) => {
  const key = String(projectKey || '').toUpperCase();
  const errors = [];
  if (!key) return { project: null, workTypes: [], requestTypes: [], errors: ['No approval space set yet.'] };
  let p;
  try {
    p = await app.get(route`/rest/api/3/project/${key}`);
  } catch (e) {
    return { project: null, workTypes: [], requestTypes: [], errors: [`${key}: ${e.message.slice(0, 160)}`] };
  }
  const isJsm = p.projectTypeKey === 'service_desk';
  const project = { id: String(p.id), key: p.key, name: p.name, type: p.projectTypeKey, typeLabel: TYPE_LABEL[p.projectTypeKey] || p.projectTypeKey, isJsm };
  const types = (await app.get(route`/rest/api/3/issuetype/project?projectId=${project.id}`)).filter((t) => !t.subtask && (t.hierarchyLevel ?? 0) === 0);
  let steps = {};
  try {
    steps = await approvalSteps(project.id, types.map((t) => String(t.id)));
  } catch (e) {
    errors.push(`Workflows could not be read: ${e.message.slice(0, 120)}`);
  }
  const workTypes = types.map((t) => ({ id: String(t.id), name: t.name, workflow: steps[String(t.id)]?.workflow || '', approval: steps[String(t.id)]?.approval || null }));
  let requestTypes = [];
  let deskId = null;
  if (isJsm) {
    try {
      const desk = await serviceDesk(project.key);
      deskId = desk ? String(desk.id) : null;
      if (desk) {
        const groups = Object.fromEntries((await sdPaged((s) => route`/rest/servicedeskapi/servicedesk/${desk.id}/requesttypegroup?start=${s}&limit=100`)).map((g) => [String(g.id), g.name]));
        const list = await sdPaged((s) => route`/rest/servicedeskapi/servicedesk/${desk.id}/requesttype?start=${s}&limit=100&includeHiddenRequestTypesInSearch=true`);
        const workTypeName = Object.fromEntries(workTypes.map((t) => [t.id, t.name]));
        requestTypes = list.map((r) => ({
          id: String(r.id), name: r.name, description: r.description || '', issueTypeId: String(r.issueTypeId),
          workTypeName: workTypeName[String(r.issueTypeId)] || `work type ${r.issueTypeId}`,
          groups: (r.groupIds || []).map((g) => groups[String(g)] || g), hidden: !(r.groupIds || []).length,
        })).sort((a, b) => a.name.localeCompare(b.name));
      }
    } catch (e) {
      errors.push(`Request types could not be read: ${e.message.slice(0, 120)}`);
    }
  }
  return { project, workTypes, requestTypes, deskId, errors };
};

// Facts the check needs beyond the options: app permissions, the request type's required fields, approver access.
const facts = async (opts, sel, s) => {
  const out = { approverCount: s.approverAccountIds.length, selfApprovals: !s.requesterAsReporter };
  if (!opts.project) return out;
  const r = resolveSelection(opts, sel);
  try {
    const perms = await app.get(route`/rest/api/3/mypermissions?projectKey=${opts.project.key}&permissions=CREATE_ISSUES,BROWSE_PROJECTS,ADD_COMMENTS,TRANSITION_ISSUES`);
    out.canCreate = ['CREATE_ISSUES', 'BROWSE_PROJECTS', 'ADD_COMMENTS', 'TRANSITION_ISSUES'].every((k) => perms.permissions?.[k]?.havePermission);
  } catch (e) {
    out.canCreate = undefined;
  }
  const fields = await app.get(route`/rest/api/3/field`);
  out.appApproversField = fields.find((x) => x.name === 'Approvers' && x.schema?.custom?.endsWith(':multiuserpicker'))?.id;
  if (r.requestType && opts.deskId) {
    try {
      const f = await app.get(route`/rest/servicedeskapi/servicedesk/${opts.deskId}/requesttype/${r.requestType.id}/field`);
      out.requiredFields = (f.requestTypeFields || []).filter((x) => x.required && !['summary', 'description'].includes(x.fieldId)).map((x) => x.name);
    } catch (e) {
      out.requiredFields = undefined;
    }
  }
  const names = {};
  const without = [];
  for (const id of [...new Set([...s.approverAccountIds, ...s.backupApproverAccountIds])].slice(0, 15)) {
    if (!(await hasProjectPermission(id, opts.project.key, 'BROWSE_PROJECTS').catch(() => true))) {
      names[id] = names[id] || (await app.get(route`/rest/api/3/user?accountId=${id}`).catch(() => ({ displayName: id }))).displayName;
      without.push(names[id]);
    }
  }
  out.approversWithoutAccess = without;
  return out;
};

// For the admin page: options + check for a (possibly unsaved) selection. Settings in `draft` override saved ones.
export const checkSpace = async ({ projectKey, issueTypeId, requestTypeId, draft = {} }) => {
  const s = { ...(await getSettings()), ...draft };
  const opts = await spaceOptions(projectKey || s.approvalProjectKey);
  let sel = { issueTypeId: issueTypeId ?? '', requestTypeId: requestTypeId ?? '' };
  const suggested = !sel.issueTypeId && !sel.requestTypeId;
  if (suggested) sel = suggestSelection(opts, s.requestTypeName);
  const result = checkSetup(opts, sel, await facts(opts, sel, s));
  const d = describeSetup(opts, sel);
  return {
    options: opts, selection: { issueTypeId: result.workType?.id || sel.issueTypeId, requestTypeId: result.requestType?.id || '' }, suggested,
    engine: result.engine, summary: d.text, checks: result.checks, level: worst(result.checks), errors: opts.errors,
  };
};

// Creates the request type the app raises approvals with: hidden from the portal (no group), on the chosen work type.
export const createRequestType = async ({ projectKey, issueTypeId, name }, by) => {
  const opts = await spaceOptions(projectKey);
  if (!opts.project?.isJsm || !opts.deskId) throw new Error(`${projectKey} is not a Jira Service Management project, so it has no request types.`);
  const wt = opts.workTypes.find((t) => t.id === String(issueTypeId));
  if (!wt) throw new Error('Pick the work type first.');
  const wanted = String(name || 'Custom field change').trim().slice(0, 60) || 'Custom field change';
  const existing = opts.requestTypes.find((r) => r.name.toLowerCase() === wanted.toLowerCase() && r.issueTypeId === wt.id);
  if (existing) return { requestType: existing, created: false };
  let r;
  try {
    // Experimental in the JSM API: Jira insists on the opt-in header.
    const res = await api.asApp().requestJira(route`/rest/servicedeskapi/servicedesk/${opts.deskId}/requesttype`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-ExperimentalApi': 'opt-in' },
      body: JSON.stringify({
        issueTypeId: wt.id, name: wanted,
        description: 'Custom field changes that need SUPERPORT approval. Raised by Custom Field Self-Service for Jira, a SUPERPORT app for Jira.',
        helpText: 'Raised automatically by Custom Field Self-Service for Jira; not meant to be filled in by hand.',
      }),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(text.slice(0, 300)), { status: res.status });
    r = JSON.parse(text);
  } catch (e) {
    throw new Error(`Jira refused to create the request type (HTTP ${e.status || '?'}): ${e.message.slice(0, 200)}`);
  }
  await saveSettings({ approvalProjectKey: opts.project.key, approvalIssueTypeId: wt.id, approvalRequestTypeId: String(r.id), requestTypeName: r.name }, by);
  return { requestType: { id: String(r.id), name: r.name, issueTypeId: wt.id, hidden: true }, created: true };
};

// What the approval module uses when it raises a request. Saved IDs win; older settings (names only) still work.
let memo = null;
export const resolveTarget = async (fresh = false) => {
  const s = await getSettings();
  const sig = `${s.approvalProjectKey}|${s.approvalIssueTypeId}|${s.approvalRequestTypeId}|${s.requestTypeName}`;
  if (!fresh && memo && memo.sig === sig && Date.now() - memo.at < 5 * 60 * 1000) return memo.value;
  const opts = await spaceOptions(s.approvalProjectKey);
  if (!opts.project) throw new Error(`Approval space ${s.approvalProjectKey} could not be read.`);
  let sel = { issueTypeId: s.approvalIssueTypeId || '', requestTypeId: s.approvalRequestTypeId || '' };
  if (!sel.issueTypeId && !sel.requestTypeId) {
    const legacy = opts.workTypes.find((t) => t.name === LEGACY_ISSUE_TYPE);
    const rt = opts.requestTypes.find((r) => r.name.trim().toLowerCase() === String(s.requestTypeName).trim().toLowerCase() && (!legacy || r.issueTypeId === legacy.id));
    sel = { issueTypeId: rt ? rt.issueTypeId : legacy?.id || suggestSelection(opts).issueTypeId, requestTypeId: rt ? rt.id : '' };
  }
  const r = resolveSelection(opts, sel);
  if (!r.workType) throw new Error(`The approval work type is not in ${s.approvalProjectKey}'s issue type scheme. Fix it on the admin page (Settings → Approvals).`);
  const value = { project: opts.project, deskId: opts.deskId, workType: r.workType, requestType: r.requestType, step: r.step, engine: r.engine };
  memo = { sig, at: Date.now(), value };
  return value;
};
