/**
 * Approval space logic without Jira calls, shared by the backend, the admin page and the tests: picks one of three
 * approval engines (JSM with request type, JSM on the work item, app approval), suggests a setup and checks the
 * configuration.
 *
 * @file        src/shared/approvalspace.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Approval space logic without any Jira calls, so it can be unit-tested and shared by the backend and the admin page.
//
// The approval space is a project, a work type from that project's issue type scheme and, in a Jira Service
// Management project, optionally a request type. From what Jira reports about them the app picks one of three
// approval engines:
//   jsm-request   JSM approval step + a request type on that work type: approvers decide in the work item, the portal
//                 or in the app (Approve / Decline buttons go through JSM's approval API as the user)
//   jsm-workitem  JSM approval step, no request type: approvers decide in the work item only
//   app           no JSM approval step (any other project or work type): the app runs the approval itself; approvers
//                 decide on the admin page or in "Requests for you", the app verifies them and comments the decision

export const ENGINES = {
  'jsm-request': 'Jira Service Management approval with request type',
  'jsm-workitem': 'Jira Service Management approval on the work item',
  app: 'App approval (decided in Custom Field Self-Service for Jira)',
};

// opts: what spaceOptions() read from Jira. sel: { issueTypeId, requestTypeId } chosen on the admin page.
// A chosen request type wins: JSM binds every request type to exactly one work type.
export const resolveSelection = (opts, sel = {}) => {
  const rt = (opts.requestTypes || []).find((r) => String(r.id) === String(sel.requestTypeId || '')) || null;
  const issueTypeId = String(rt ? rt.issueTypeId : sel.issueTypeId || '');
  const wt = (opts.workTypes || []).find((t) => String(t.id) === issueTypeId) || null;
  const step = wt ? wt.approval || null : null;
  let engine = 'app';
  if (step && rt) engine = 'jsm-request';
  else if (step) engine = 'jsm-workitem';
  return { requestType: rt, workType: wt, step, engine };
};

// Suggests a sensible default when nothing is chosen yet: a request type named like the wanted one, else the first
// work type with an approval step, else the first work type.
export const suggestSelection = (opts, wantedName = 'Custom field change') => {
  const norm = (x) => String(x || '').trim().toLowerCase();
  const withStep = new Set((opts.workTypes || []).filter((t) => t.approval).map((t) => String(t.id)));
  const rt = (opts.requestTypes || []).find((r) => norm(r.name) === norm(wantedName) && withStep.has(String(r.issueTypeId)))
    || (opts.requestTypes || []).find((r) => norm(r.name) === norm(wantedName));
  if (rt) return { issueTypeId: String(rt.issueTypeId), requestTypeId: String(rt.id) };
  const wt = (opts.workTypes || []).find((t) => t.approval) || (opts.workTypes || [])[0];
  return { issueTypeId: wt ? String(wt.id) : '', requestTypeId: '' };
};

const conditionText = (step) => {
  if (!step) return '';
  const n = step.conditionType === 'number' ? `${step.conditionValue || 1} approval(s)` : step.conditionType === 'percent' ? `${step.conditionValue}% of approvers` : 'all approvers';
  const ex = (step.exclude || []).length ? `; ${step.exclude.join(' and ')} excluded` : '';
  return `${n} from "${step.fieldName || step.fieldId}" at "${step.statusName}"${ex}`;
};

// One sentence for people: where requests go and how they are decided.
export const describeSetup = (opts, sel) => {
  const r = resolveSelection(opts, sel);
  const space = `${opts.project?.key || '?'}`;
  if (!r.workType) return { ...r, text: `Pick the work type the app creates in ${space}.` };
  const as = r.requestType ? `"${r.workType.name}" work items with the request type "${r.requestType.name}"${r.requestType.hidden ? ' (hidden from the portal)' : ''}` : `"${r.workType.name}" work items`;
  const how = {
    'jsm-request': `Jira asks for ${conditionText(r.step)}. Approvers decide in the work item, in the portal or right here in the app.`,
    'jsm-workitem': `Jira asks for ${conditionText(r.step)}. Without a request type approvers decide in the work item only; pick or create a request type to decide in the app too.`,
    app: 'This work type has no Jira approval step, so the app runs the approval itself: approvers decide on this admin page or in "Requests for you"; the app checks who decided and comments it on the work item.',
  }[r.engine];
  return { ...r, text: `Requests become ${as} in ${space}. ${how}` };
};

// The check list shown under the settings. facts: extra things the backend measured (permissions, fields).
export const checkSetup = (opts, sel, facts = {}) => {
  const out = [];
  const add = (level, label, detail) => out.push({ level, label, detail });
  const r = resolveSelection(opts, sel);
  if (!opts.project) {
    add('fail', 'Approval space', 'The project could not be read with the app\'s rights.');
    return { checks: out, ...r };
  }
  add('ok', 'Approval space', `${opts.project.key} · ${opts.project.name} (${opts.project.isJsm ? 'Jira Service Management' : opts.project.typeLabel || opts.project.type}).`);
  if (facts.canCreate === false) add('fail', 'App may create work items', 'The app user lacks "Create work items" in this space. Add atlassian-addons-project-access to the permission scheme.');
  else if (facts.canCreate) add('ok', 'App may create work items', 'Create, browse, comment and transition: granted.');
  if (!r.workType) add('fail', 'Work type', sel.issueTypeId ? 'The chosen work type is not in this space\'s issue type scheme any more.' : 'No work type chosen.');
  else add('ok', 'Work type', `"${r.workType.name}" is in the space's issue type scheme.`);
  if (r.workType) {
    if (r.step) add('ok', 'Approval step', `Workflow "${r.workType.workflow}": ${conditionText(r.step)}.`);
    // Outside Jira Service Management app approvals are the normal, supported setup; in a JSM space a work type without
    // an approval step usually means the wrong work type was picked, so it stays a note there.
    else add(opts.project.isJsm ? 'warn' : 'ok', 'Approval step', `Workflow "${r.workType.workflow || '?'}" has no Jira approval step: the app runs the approval itself.`);
  }
  if (r.step && facts.appApproversField && r.step.fieldId !== facts.appApproversField) {
    add('warn', 'Approvers field', `The workflow reads approvers from ${r.step.fieldName || r.step.fieldId}; the app fills that field.`);
  }
  if (opts.project.isJsm) {
    if (sel.requestTypeId && !r.requestType) add('fail', 'Request type', 'The chosen request type does not exist any more.');
    else if (r.requestType) {
      add('ok', 'Request type', `"${r.requestType.name}" uses "${r.workType ? r.workType.name : '?'}"${r.requestType.hidden ? ', hidden from the portal (only the app raises it)' : `, visible in the portal (${(r.requestType.groups || []).join(', ')})`}.`);
      if ((facts.requiredFields || []).length) add('fail', 'Request type fields', `Required fields the app cannot fill: ${facts.requiredFields.join(', ')}. Make them optional.`);
      else if (facts.requiredFields) add('ok', 'Request type fields', 'Only summary and description are required.');
    } else add('warn', 'Request type', 'None: approvers decide in the work item only. Pick one or create "Custom field change".');
  } else add('ok', 'Request type', 'Not needed: request types exist only in Jira Service Management projects.');
  for (const a of facts.approversWithoutAccess || []) add('fail', 'Approver access', `${a} cannot browse ${opts.project.key}, so they would never see the request.`);
  if (facts.approverCount === 0) add('fail', 'Approvers', 'No approvers are set.');
  if (facts.selfApprovals) add('warn', 'Self-approvals', 'Allowed (test mode). Switch off before real use.');
  return { checks: out, ...r };
};

export const worst = (checks) => (checks.some((c) => c.level === 'fail') ? 'fail' : checks.some((c) => c.level === 'warn') ? 'warn' : 'ok');
