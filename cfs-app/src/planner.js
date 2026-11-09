/**
 * Previews and plan execution for Field Assistant and approved stage-1 requests: previews compute the exact change,
 * its impact and who must approve, and store it as a plan; submitPlan is the agent's only write path and runs a plan
 * only if it still matches Jira.
 *
 * @file        src/planner.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Previews and plan execution for Field Assistant (and approved stage-1 requests).
//
//   preview*   read-only: compute the exact change, its impact (work items, saved filters, automation rules), who
//              must approve, and store it as a plan. Returns the plan ID.
//   submitPlan the ONLY write path of the agent: takes a plan ID, checks owner, expiry, single use and that Jira
//              still looks like at the preview (fingerprint), then runs it - or, for a user who is not a project
//              admin, raises the stage-1 request to the project's admins.
//   runPlan    executes a stored plan through the normal service functions, so every guard rail applies.
import * as B from './bulk';
import { route } from '@forge/api';
import * as J from './jira';
import * as S from './service';
import { fieldForProject, optionTree, planReuse } from './fields';
import { normaliseOps, applyOps, opsAreEmpty, describeOps, treeFingerprint } from './shared/optionops';
import { computePlan, describePlan, planIsEmpty, validateTree } from './shared/options';
import { findEntry } from './shared/catalogue';
import { ALLOWED, typeByKey } from './shared/fieldtypes';
import { optionUsage, planImpact, filtersMentioning, automationRulesFor, renameInJql } from './insights';
import { savePlan, takePlan, PlanError, clearDraft } from './plans';
import { getSettings, isEnabledFor } from './settings';
import { createStage1Request, createApprovalRequest } from './approvals';
import { pendingForField } from './audit';
import { guardDecision, BY_JIRA_ADMIN } from './guards';
import { FEATURES, BULK_OFF } from './shared/features';

const list = (s) => (Array.isArray(s) ? s : String(s || '').split(/[;\n]/)).map((x) => String(x).trim()).filter(Boolean);
const bool = (v) => v === true || String(v).toLowerCase() === 'true';

let base = null;
export const siteUrl = async () => {
  if (!base) base = (await J.app.get(route`/rest/api/3/serverInfo`)).baseUrl;
  return base;
};
const browse = async (key) => `${await siteUrl()}/browse/${key}`;

const SYNONYMS = {
  dropdown: 'select', 'drop-down': 'select', select: 'select', 'single select': 'select', 'select list': 'select',
  'multi select': 'multiselect', 'multiple select': 'multiselect', multiselect: 'multiselect',
  checkbox: 'multicheckboxes', checkboxes: 'multicheckboxes', radio: 'radiobuttons', 'radio buttons': 'radiobuttons',
  text: 'textfield', 'short text': 'textfield', 'single line text': 'textfield', paragraph: 'textarea', 'text area': 'textarea', 'long text': 'textarea',
  number: 'float', numeric: 'float', date: 'datepicker', 'date time': 'datetime', datetime: 'datetime', 'date and time': 'datetime',
  user: 'userpicker', 'user picker': 'userpicker', person: 'userpicker', cascading: 'cascadingselect', 'cascading select': 'cascadingselect', labels: 'labels',
};

export const typeKeyOf = (t) => {
  const v = String(t || '').trim().toLowerCase();
  const byLabel = ALLOWED.find((a) => a.key === v || a.label.toLowerCase() === v);
  return byLabel ? byLabel.key : SYNONYMS[v] || v;
};

export const draftOf = (projectKey, i) => ({
  name: String(i.name || '').trim(),
  description: String(i.description || '').trim(),
  typeKey: typeKeyOf(i.fieldType),
  optionsText: list(i.options).join('\n'),
  defaultValue: String(i.defaultValue || '').trim(),
  justification: String(i.justification || '').trim(),
  global: bool(i.global),
  addToScreens: i.addToScreens === undefined ? true : bool(i.addToScreens),
  projectKeys: [projectKey],
  issueTypeIds: [],
  aiSimilarTo: String(i.similarToFieldId || '').trim() || undefined,
});

// Who decides, in words, for a user who is not a project admin.
const stage1Text = async (projectKey, accountId) => {
  const settings = await getSettings();
  const admins = await J.projectAdmins(projectKey, settings.stage1MaxApprovers).catch(() => ({ users: [] }));
  const asked = (settings.requesterAsReporter ? admins.users : admins.users.filter((u) => settings.approverAccountIds.includes(u.accountId)))
    .filter((u) => u.accountId !== accountId || !settings.requesterAsReporter);
  const names = asked.map((u) => u.displayName);
  return {
    who: `the project admins of ${projectKey}${names.length ? ` (${names.join(', ')})` : ''}`,
    text: `You are not a project admin of ${projectKey}, so submitting sends this to ${names.length ? names.join(', ') : 'the project admins'} for approval first. If they approve, the app carries it out; anything that touches other projects then also goes to a Jira administrator.`,
    names,
  };
};

// A project admin who is not a Jira administrator: every change is a request for a Jira administrator.
const byJiraAdminText = { who: 'a Jira administrator', text: `Submitting creates an approval request. ${BY_JIRA_ADMIN} The app carries it out as soon as it is approved.` };

const routeText = (decision) => {
  if (decision.route === 'direct') return { who: 'nobody', text: `Submitting executes it at once${decision.policy ? ` (approved by policy: ${decision.policy})` : ''}.` };
  if (decision.route === 'rejected') return { who: 'not possible', text: decision.reasons.join(' ') };
  return { who: 'a Jira administrator', text: `Submitting creates an approval request for a Jira administrator: ${decision.reasons.join(' ')}` };
};

// ---------- previews ----------

export const previewOptions = async ({ projectKey, field: ref, input, accountId, isAdmin, role }) => {
  const settings = await getSettings();
  const { field } = await fieldForProject(projectKey, ref.id);
  if (!field.hasOptions) return { result: 'not possible', why: `${field.name} has no options.` };
  if (field.editable === 'readonly' && role === 'none') return { result: 'not possible', why: `${field.name} uses the global context: a project admin requests changes to it, a Jira administrator decides.` };
  const open = await pendingForField(field.id);
  if (open.length) return { result: 'blocked', why: `${open.map((p) => p.issueKey).join(', ')} is still waiting for approval on this field. New changes are possible once it is decided.` };
  const ops = normaliseOps(input);
  if (opsAreEmpty(ops)) return { result: 'nothing to do', why: 'Say what to add, rename, disable, enable or sort.' };
  const original = await optionTree(field.id, field.contextId);
  // Counts only in spaces the person may browse (Jira administrators: all spaces of the context).
  const allKeys = S.scopeKeys(field, projectKey);
  const countKeys = role === 'jira-admin' ? allKeys : await J.browsable(accountId, allKeys.length ? allKeys : [projectKey]);
  const usage = await optionUsage(field.id, original, countKeys.length ? countKeys : [projectKey], field.cascading).catch(() => ({ perOption: {}, total: null }));
  const { tree, missing, unusedDisabled } = applyOps(original, ops, { cascading: field.cascading, perOption: usage.perOption });
  if (missing.length) return { result: 'not found', why: `These options don't exist in ${field.name}: ${missing.join(', ')}. Nothing was planned.`, existingOptions: original.map((o) => o.value) };
  const errors = validateTree(tree, settings.rules);
  if (errors.length) return { result: 'invalid', errors };
  const plan = computePlan(original, tree);
  if (planIsEmpty(plan)) return { result: 'no change', why: 'The options already look like this.' };
  const rows = describePlan(plan);
  const impact = planImpact(plan, usage);
  const values = [...plan.edits.map((e) => e.old), ...plan.disables.map((d) => d.value)];
  const [filters, rules] = await Promise.all([
    values.length ? filtersMentioning(field, values, accountId, true) : Promise.resolve(null),
    automationRulesFor(field.id, settings.approvalProjectKey),
  ]);
  const access = S.optionAccess(settings, field, role, projectKey);
  const routeInfo = !isAdmin ? await stage1Text(projectKey, accountId)
    : access === 'direct' ? routeText(await S.routeOptions({ settings, field, plan, perOption: usage.perOption, accountId, admin: role === 'jira-admin', projectDirect: role !== 'jira-admin' })) : byJiraAdminText;
  const toFix = filters && plan.edits.length ? filters.filters.filter((x) => x.mine && x.mentionsValue.length) : [];
  const fixMyFilters = bool(input.fixMyFilters) && toFix.length > 0;
  const saved = await savePlan({
    kind: 'options', projectKey, accountId,
    input: { fieldId: field.id, ops, fixMyFilters },
    fingerprint: treeFingerprint(original),
    summary: `${describeOps(ops).join(', ')} in "${field.name}"`.slice(0, 200),
    expect: { rows, lines: [...impact, routeInfo.text], filtersToFix: fixMyFilters ? toFix.map((x) => x.id) : [], renames: plan.edits.map((e) => [e.old, e.new]) },
  });
  return {
    planId: saved.id,
    expiresInMinutes: 15,
    field: { id: field.id, name: field.name, scope: field.scope, sharedWith: role === 'jira-admin' ? field.sharedWith.map((p) => p.key) : countKeys.filter((k) => k !== projectKey) },
    changes: rows,
    workItemImpact: impact.length ? impact : ['No existing work item value changes.'],
    ...(unusedDisabled.length ? { unusedDisabled } : {}),
    savedFilters: filters ? (filters.checked ? {
      scanned: filters.scanned,
      mentioningTheField: filters.filters.map((x) => `${x.name} (owner ${x.owner}${x.mentionsValue.length ? `; mentions ${x.mentionsValue.join(', ')}` : ''})`),
      yourFiltersTheAppCanFix: toFix.map((x) => x.name),
      willFixThem: fixMyFilters,
    } : { note: filters.note }) : 'not affected (nothing renamed or disabled)',
    automationRules: rules.indexed ? (rules.rules.length ? (role === 'jira-admin' ? rules.rules.map((r) => `${r.name} (${r.state})`) : `${rules.rules.length} rule(s) use this field (a Jira administrator sees which)`) : 'no rule uses this field') : rules.note,
    whoApproves: routeInfo.who,
    whatHappensOnSubmit: routeInfo.text,
    nextStep: `Show this to the user. Only after a clear yes, call submit-plan with planId ${saved.id}.`,
    sources: { field: field.id, context: field.contextName, usageJql: `cf[${field.id.split('_')[1]}] = <option id>`, optionsCountedIn: countKeys },
  };
};

export const previewNewField = async ({ projectKey, input, accountId, isAdmin, role }) => {
  const settings = await getSettings();
  const d = draftOf(projectKey, input);
  const check = await S.checkField(d);
  const interpretedAs = { name: d.name, type: typeByKey(d.typeKey)?.label || d.typeKey, options: d.optionsText ? d.optionsText.split('\n') : [], global: d.global, addToScreens: d.addToScreens };
  if (check.catalogueField) return previewReuse({ projectKey, input: { field: check.catalogueField.id, addToScreens: d.addToScreens }, accountId, isAdmin, role, note: `"${check.catalogueField.name}" is a standard field from the catalogue and already exists: it is reused instead of creating a copy.` });
  if (check.result === 'red') return { result: 'red', meaning: 'rejected: fix the findings and preview again', findings: check.findings, interpretedAs };
  let routeInfo;
  if (!isAdmin) routeInfo = await stage1Text(projectKey, accountId);
  else if (role !== 'jira-admin') routeInfo = byJiraAdminText;
  else {
    const g = await guardDecision({ settings, accountId, admin: true });
    const warn = check.result === 'yellow' ? ` Mind the warnings first: ${check.findings.filter((f) => f.level === 'yellow').map((f) => f.message).join(' ')}` : '';
    routeInfo = g.approval ? { who: 'a Jira administrator', text: `Submitting creates an approval request: ${g.reasons.join(' ')}` } : { who: 'nobody', text: `Submitting creates the field at once (you are a Jira administrator).${warn}` };
    // The admin saw the warnings in this preview and confirms by submitting.
    if (check.result === 'yellow') d.confirmWarnings = true;
  }
  const saved = await savePlan({
    kind: 'field', projectKey, accountId, input: { draft: d },
    summary: `new field "${d.name}" (${interpretedAs.type})`,
    expect: { result: check.result, rows: [{ action: 'New field', option: d.name, old: '', new: `${interpretedAs.type}${interpretedAs.options.length ? `; ${interpretedAs.options.length} options` : ''}` }, { action: 'Justification', option: '', old: '', new: d.justification }], lines: [routeInfo.text] },
  });
  return {
    planId: saved.id,
    expiresInMinutes: 15,
    result: check.result,
    meaning: { green: 'meets the guidelines', yellow: 'meets the guidelines but needs a Jira administrator\'s approval' }[check.result],
    ...(check.catalogue ? { catalogue: `Matches the pre-approved catalogue field "${check.catalogue}".` } : {}),
    findings: check.findings,
    interpretedAs,
    whoApproves: routeInfo.who,
    whatHappensOnSubmit: routeInfo.text,
    nextStep: `Show this to the user. Only after a clear yes, call submit-plan with planId ${saved.id}.`,
    sources: { guidelineCheck: 'deterministic rules from the admin page', comparedWith: 'all custom fields of the site' },
  };
};

export const previewReuse = async ({ projectKey, input, accountId, isAdmin, role, note }) => {
  const settings = await getSettings();
  const ctx = await S.guidelineContext();
  const ref = String(input.field || '').trim().toLowerCase();
  const hits = ctx.customFields.filter((f) => f.id.toLowerCase() === ref || f.name.toLowerCase() === ref);
  if (hits.length !== 1) return { error: hits.length ? `Several fields are called "${input.field}"; use the field ID.` : `No field "${input.field}" on this site.` };
  const plan = await planReuse(hits[0].id, projectKey);
  const addToScreens = input.addToScreens === undefined ? true : bool(input.addToScreens);
  if (plan.alreadyUsable && !addToScreens) return { result: 'nothing to do', why: `"${plan.field.name}" can already be used in ${projectKey} (${plan.via}).` };
  const routeInfo = !isAdmin ? await stage1Text(projectKey, accountId)
    : role === 'jira-admin' ? routeText(await S.routeReuse({ settings, plan, accountId, admin: true })) : byJiraAdminText;
  if (routeInfo.who === 'not possible') return { result: 'not possible', why: routeInfo.text };
  const steps = [
    ...(plan.needsScheme ? ['add the field to the project\'s field scheme'] : []),
    ...(plan.contextStep ? [role === 'jira-admin' ? `add ${projectKey} to the context "${plan.contextStep.contextName}" (shared by ${plan.contextStep.sharedWith.join(', ')})` : `add ${projectKey} to the field's context, which ${plan.contextStep.sharedWith.length} other space(s) use`] : []),
    ...(addToScreens ? ['add it to the project\'s own screens, next to the most similar field'] : []),
  ];
  const saved = await savePlan({
    kind: 'reuse', projectKey, accountId, input: { fieldId: plan.field.id, addToScreens },
    summary: `use the existing field "${plan.field.name}"`,
    expect: { contextStep: !!plan.contextStep, rows: [{ action: 'Reuse field', option: plan.field.name, old: '', new: steps.join('; ') }], lines: [routeInfo.text] },
  });
  return {
    planId: saved.id,
    expiresInMinutes: 15,
    ...(note ? { note } : {}),
    field: { id: plan.field.id, name: plan.field.name, type: plan.field.type },
    steps: steps.length ? steps : ['nothing to change: the field is already usable'],
    whoApproves: routeInfo.who,
    whatHappensOnSubmit: routeInfo.text,
    nextStep: `Show this to the user. Only after a clear yes, call submit-plan with planId ${saved.id}.`,
    sources: { field: plan.field.id, via: plan.via },
  };
};

export const previewBundle = async ({ projectKey, input, accountId, isAdmin, role }) => {
  const settings = await getSettings();
  if (!settings.catalogue.length) return { error: 'The field catalogue is empty. A Jira administrator fills it on the admin page.' };
  const refs = String(input.entries || '').trim().toLowerCase() === 'all' ? settings.catalogue.map((e) => e.id) : list(input.entries);
  const items = [];
  const ids = [];
  for (const ref of refs) {
    const e = findEntry(settings.catalogue, ref);
    if (!e) { items.push({ item: ref, what: 'not in the catalogue - skipped' }); continue; }
    ids.push(e.id);
    if (e.fieldId) {
      const p = await planReuse(e.fieldId, projectKey).catch((err) => ({ error: err.message }));
      if (p.error) items.push({ item: e.name, what: `error: ${p.error}` });
      else if (p.alreadyUsable) items.push({ item: e.name, what: 'already usable - nothing to do' });
      else items.push({ item: e.name, what: `reuse ${e.fieldId}${p.contextStep ? ' (shared context: needs Jira administrator approval)' : ''}` });
    } else {
      items.push({ item: e.name, what: `create (${typeByKey(e.typeKey)?.label}${e.options.length ? `, ${e.options.length} options` : ''})` });
    }
  }
  if (!ids.length) return { error: 'None of these is in the catalogue.', catalogue: settings.catalogue.map((e) => e.name) };
  const routeInfo = !isAdmin ? await stage1Text(projectKey, accountId)
    : role === 'jira-admin' ? { who: 'nobody for most items', text: 'Submitting sets up every item at once; items that need approval go into ONE request for a Jira administrator.' } : byJiraAdminText;
  const saved = await savePlan({
    kind: 'bundle', projectKey, accountId, input: { entries: ids },
    summary: `onboarding bundle: ${ids.length} catalogue field(s)`,
    expect: { rows: items.map((i) => ({ action: 'Bundle item', option: i.item, old: '', new: i.what })), lines: [routeInfo.text] },
  });
  return { planId: saved.id, expiresInMinutes: 15, items, whoApproves: routeInfo.who, whatHappensOnSubmit: routeInfo.text, nextStep: `Show this to the user. Only after a clear yes, call submit-plan with planId ${saved.id}.` };
};

// ---------- execution ----------

// ctx: { requester, approvedBy, trusted, checkFingerprint, via }. Returns { status, issueKey?, fieldId?, summary, details }.
// Bulk: scans in passes (~18 s each); a still-scanning job comes back with its jobId so the agent can continue it.
export const previewBulk = async ({ projectKey, input, accountId, role }) => {
  if (role === 'none') return { error: `Bulk changes are for the project admins of ${projectKey} (fields only this space uses) and Jira administrators.` };
  if (!FEATURES.bulk) return { error: BULK_OFF };
  const t0 = Date.now();
  const bulkInput = {
    op: input.op, value: input.value, newValue: input.newValue, like: input.like, position: input.position, clearDefault: !input.keepDefaults,
    fields: input.fields, retireOld: input.retireOld === undefined ? true : input.retireOld !== false && String(input.retireOld) !== 'false', addMissing: input.addMissing === true || String(input.addMissing) === 'true',
  };
  let r = await B.scan({ projectKey, input: bulkInput, accountId, jobId: input.jobId || undefined, role });
  while (!r.items && Date.now() - t0 < 14000) r = await B.scan({ projectKey, accountId, jobId: r.job.id, role });
  if (!r.items) return { status: 'still scanning', jobId: r.job.id, progress: r.job.progress, nextStep: `Call preview-bulk again with jobId ${r.job.id} to continue.` };
  const t = r.job.totals;
  const changing = r.items.filter((i) => i.action === 'change');
  const saved = await savePlan({
    kind: 'bulk', projectKey, accountId, input: { jobId: r.job.id },
    summary: `bulk change: ${r.job.description} (${t.change} fields)`,
    expect: { rows: changing.slice(0, 40).map((i) => ({ action: 'Bulk', option: i.fieldName, old: input.value, new: (i.rows || []).map((x) => x.action).join(', ') })), lines: [r.job.description] },
  });
  const replace = r.job.bulk?.op === 'replace';
  return {
    planId: saved.id, expiresInMinutes: 15, what: r.job.description,
    fieldsToChange: t.change, [replace ? 'workItemsToUpdate' : 'workItemsAffected']: t.workItems, [replace ? 'defaultsMoved' : 'defaultsCleared']: t.defaultsCleared, needApproval: t.approval, skipped: t.skip,
    ...(replace ? {
      skippedWhy: r.items.filter((i) => i.action === 'skip' && !/^Not in this field/.test(i.reason)).slice(0, 8).map((i) => `${i.fieldName}: ${i.reason}`),
      notes: [...new Set(changing.flatMap((i) => (i.rows || []).filter((x) => x.action === 'Note').map((x) => `${i.fieldName}: ${x.option}`)))].slice(0, 8),
    } : {}),
    notPossible: r.items.filter((i) => i.action === 'blocked').map((i) => `${i.fieldName}: ${i.reason}`).slice(0, 10),
    sample: changing.slice(0, 12).map((i) => `${i.fieldName}${i.affected ? ` (${i.affected} work item(s))` : ''}${i.defaultCleared ? ' - default cleared' : ''}`),
    undo: replace
      ? 'The whole batch can be undone in one click (Bulk changes tab, or ask me): the options come back and every work item gets its old value again, unless somebody changed it since.'
      : 'The whole batch can be undone in one click on the project page (Bulk changes), or by asking me.',
    reviewInApp: 'Project settings → Custom Field Self-Service for Jira → Bulk changes shows every field, where single fields can be unticked.',
    ...(role === 'jira-admin' ? {} : { scope: `Only the fields that ${projectKey} uses alone are included; fields shared with other spaces are changed by Jira administrators.`, approval: 'A Jira administrator approves the change before it runs (unless your admins let project admins change their own fields directly).' }),
    nextStep: `Show this to the user. Only after a clear yes, call submit-plan with planId ${saved.id}.`,
  };
};

// Status of one bulk change, or the latest ones of the project.
export const bulkStatus = async ({ projectKey, input }) => {
  if (!FEATURES.bulk) return { error: BULK_OFF };
  if (input.jobId) {
    const { job } = await B.get({ projectKey, jobId: String(input.jobId).trim() });
    return B.statusText(job);
  }
  const recent = (await B.history({ projectKey, max: 8 })).filter((j) => !['collecting', 'scanning', 'ready', 'failed'].includes(j.status));
  return { recent: recent.map((j) => ({ ...B.statusText(j), by: j.by })), note: recent.length ? 'Newest first.' : 'No bulk change has run in this project yet.' };
};

// Undo of a whole bulk change, after the user confirmed it in chat.
export const undoBulk = async ({ projectKey, input, accountId, role }) => {
  if (role === 'none') return { error: 'Only the person who asked for a bulk change, or a Jira administrator, can undo it.' };
  if (!FEATURES.bulk) return { error: BULK_OFF };
  if (!input.jobId) return { error: 'Which bulk change? Call bulk-status first and use its jobId.' };
  const r = await B.undo({ projectKey, jobId: String(input.jobId).trim(), accountId, createApproval: createApprovalRequest });
  if (r.status === 'pending') return { ...B.statusText(r.job), summary: `The undo was sent to a Jira administrator for approval as ${r.issueKey}. It runs as soon as it is approved.` };
  return { ...B.statusText(r.job), summary: r.job.status === 'undone' ? 'Undone completely.' : 'Undo started; the rest continues in the background within minutes (ask me for the status).' };
};

export const runPlan = async (plan, ctx) => {
  const { requester, approvedBy = null, trusted = false, checkFingerprint = false, via = 'Field Assistant' } = ctx;
  const { projectKey, input } = plan;
  if (plan.kind === 'options') {
    const { field } = await fieldForProject(projectKey, input.fieldId);
    const original = await optionTree(field.id, field.contextId);
    if (checkFingerprint && plan.fingerprint && treeFingerprint(original) !== plan.fingerprint) {
      throw new PlanError(`The options of ${field.name} changed since the preview. Nothing was changed; run the preview again.`);
    }
    const needUsage = input.ops.disableUnused || input.ops.sortByUsage;
    const usage = needUsage ? await optionUsage(field.id, original, S.scopeKeys(field, projectKey), field.cascading) : { perOption: {} };
    const { tree, missing } = applyOps(original, input.ops, { cascading: field.cascading, perOption: usage.perOption });
    if (missing.length) throw new Error(`These options no longer exist in ${field.name}: ${missing.join(', ')}. Nothing was changed.`);
    const r = await S.applyOptionChanges({ projectKey, fieldId: field.id, contextId: field.contextId, tree, accountId: requester, via, approvedBy });
    const summary = { done: `${r.rows?.length || 0} change(s) to ${field.name} are live${r.policy ? ` (approved by policy: ${r.policy})` : ''}.`, pending: `Sent to a Jira administrator for approval as ${r.issueKey}.`, nochange: 'Nothing to change.', invalid: `Not saved: ${(r.errors || []).join(' ')}` }[r.status];
    return { status: r.status, issueKey: r.issueKey, fieldId: field.id, summary, details: r };
  }
  if (plan.kind === 'field') {
    if (checkFingerprint && plan.expect?.result) {
      const now = await S.checkField(input.draft);
      if (now.result !== plan.expect.result) throw new PlanError(`The guideline result changed since the preview (${plan.expect.result} → ${now.result}). Nothing was changed; run the preview again.`);
    }
    const r = await S.requestNewField({ projectKey, draft: input.draft, accountId: requester, trusted, approvedBy });
    const summary = { created: `Field ${r.fieldId} "${input.draft.name}" created.${r.notes?.length ? ` ${r.notes.join(' ')}` : ''}`, reused: `Catalogue field ${r.fieldId} reused.`, pending: `Sent to a Jira administrator for approval as ${r.issueKey}.`, rejected: 'Rejected by the guideline check.' }[r.status] || r.status;
    return { status: r.status, issueKey: r.issueKey, fieldId: r.fieldId, summary, details: { status: r.status, findings: r.check?.findings, notes: r.notes } };
  }
  if (plan.kind === 'reuse') {
    if (checkFingerprint) {
      const now = await planReuse(input.fieldId, projectKey);
      if (!!now.contextStep !== !!plan.expect?.contextStep) throw new PlanError('The field\'s contexts changed since the preview. Nothing was changed; run the preview again.');
    }
    const r = await S.reuseField({ projectKey, fieldId: input.fieldId, accountId: requester, addToScreens: input.addToScreens, approvedBy, via: `${via} (reuse)` });
    const summary = { done: (r.notes || []).join(' '), pending: `Sent to a Jira administrator for approval as ${r.issueKey}.`, nochange: (r.notes || []).join(' '), rejected: (r.notes || []).join(' ') }[r.status];
    return { status: r.status, issueKey: r.issueKey, fieldId: input.fieldId, summary, details: { status: r.status, notes: r.notes } };
  }
  if (plan.kind === 'bulk') {
    if (!FEATURES.bulk) throw new PlanError(BULK_OFF);
    const r = await B.start({ projectKey, jobId: input.jobId, accountId: requester, createApproval: createApprovalRequest });
    const j = r.job;
    const summary = j.status === 'pending-approval'
      ? `Sent for approval as ${j.issueKey} (${(r.reasons || []).join(' ')}). It runs as one batch once approved.`
      : `Bulk change ${j.id} is ${j.status}: ${j.progress?.changed || 0} of ${j.progress?.total || 0} field(s) changed${j.progress?.moved ? `, ${j.progress.moved} work-item value(s) updated` : ''} so far${j.status === 'running' ? '; the rest continues in the background (ask me for the status)' : ''}. Undo in one click: ask me, or the Bulk changes tab.`;
    return { status: j.status === 'pending-approval' ? 'pending' : 'done', issueKey: j.issueKey, summary, details: { job: j } };
  }
  if (plan.kind === 'bundle') {
    const r = await S.runBundle({ projectKey, entryRefs: input.entries, accountId: requester, approvedBy });
    return { status: r.status, issueKey: r.issueKey, summary: r.results.map((x) => `${x.item}: ${x.status}`).join('; '), details: r };
  }
  throw new Error(`Unknown plan kind ${plan.kind}.`);
};

// The agent's only write action. Identity from Jira, everything else from the stored plan.
export const submitPlan = async ({ planId, accountId }) => {
  const plan = await takePlan(planId, accountId);
  const settings = await getSettings();
  if (!isEnabledFor(settings, plan.projectKey)) throw new PlanError(`${plan.projectKey} is no longer part of the pilot. Nothing was changed.`);
  if (!(await J.canBrowse(plan.projectKey))) throw new PlanError(`You can no longer see ${plan.projectKey}. Nothing was changed.`);
  const isAdmin = await J.isProjectAdmin(plan.projectKey, accountId);
  if (!isAdmin) {
    const r = await createStage1Request({ projectKey: plan.projectKey, requester: accountId, plan, rows: plan.expect?.rows || [], preview: plan.expect?.lines || [] });
    await clearDraft(accountId);
    return { status: 'sent to your project admins', request: r.issueKey, link: await browse(r.issueKey), approvers: r.approvers.map((u) => u.displayName), next: 'You get an e-mail when they decide.' };
  }
  const r = await runPlan(plan, { requester: accountId, checkFingerprint: true });
  let filters = null;
  if (r.status === 'done' && plan.kind === 'options' && plan.input.fixMyFilters && plan.expect?.filtersToFix?.length) {
    filters = [];
    for (const id of plan.expect.filtersToFix) {
      try {
        const f = await J.user.get(route`/rest/api/3/filter/${id}?expand=jql`);
        let jql = f.jql;
        plan.expect.renames.forEach(([from, to]) => { jql = renameInJql(jql, from, to); });
        if (jql !== f.jql) { await J.updateFilterJql(id, f, jql); filters.push(`${f.name}: updated`); } else filters.push(`${f.name}: nothing to replace`);
      } catch (e) {
        filters.push(`filter ${id}: not updated (${e.message.slice(0, 80)})`);
      }
    }
  }
  await clearDraft(accountId);
  return {
    status: r.status,
    result: r.summary,
    ...(r.issueKey ? { request: r.issueKey, link: await browse(r.issueKey) } : {}),
    ...(r.fieldId ? { fieldId: r.fieldId } : {}),
    ...(filters ? { yourFilters: filters } : {}),
    ...(r.status === 'done' && plan.kind === 'options' ? { undo: 'The admin can undo this in Custom fields → Audit log.' } : {}),
    sources: { plan: plan.id, auditLog: 'Project settings → Custom fields → Audit log' },
  };
};
