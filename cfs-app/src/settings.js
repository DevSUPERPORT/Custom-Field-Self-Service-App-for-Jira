/**
 * App settings edited on the admin page, with defaults and validation; precedence is saved settings, then Forge
 * variables (first rollout), then defaults. Also the pilot scope check and the setup checklist state.
 *
 * @file        src/settings.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import { kvs } from '@forge/kvs';
import { CREATABLE } from './shared/fieldtypes';
import { RULES } from './shared/guidelines';
import { parseCatalogue } from './shared/catalogue';

export const DEFAULTS = {
  // Pilot scope: the app works only in these projects (page, agent, issue action). Empty = every project, but only
  // once an admin has saved the settings: a fresh installation is enabled nowhere until it is set up.
  enabledProjects: [],
  approvalProjectKey: '',
  // Work type and (JSM only) request type the app raises approval requests with. Empty = resolved from the names
  // below (settings saved before 4.19.0).
  approvalIssueTypeId: '',
  approvalRequestTypeId: '',
  requestTypeName: 'Custom field change',
  approverAccountIds: [],
  backupApproverAccountIds: [],
  requesterAsReporter: true,
  notifyRequester: true,
  reminderHours: 24,
  escalateHours: 48,
  minutesPerTicket: 20,
  minutesPerApproval: 3,
  alertsEnabled: true,
  selfTestFieldId: '',
  // v5 guard rails
  safeMode: false, // manual switch: every change needs SUPERPORT approval, nothing executes directly
  autoSafeModeRate: 30, // more direct changes than this within an hour (site-wide) switch safe mode on
  dailyQuota: 20, // direct changes per user and day; beyond that changes go to approval
  twoPersonThreshold: 100, // a change touching at least this many work items needs approval
  policyAddsOnly: true, // shared context: adding options only is approved by policy
  stage1MaxApprovers: 10, // non-admin requests: at most this many project admins as approvers
  digestEnabled: true,
  simulateNonAdminIds: [], // TEST ONLY: these users are treated as non-admins everywhere
  simulateProjectAdminIds: [], // TEST ONLY: these Jira admins are treated as project admins only
  // Options of a field whose context belongs to one space only (use case UC-02): 'approval' = a Jira administrator
  // approves every change a project admin makes; 'direct' = the project admin changes them right away (logged, the
  // guard rails still apply). Shared and global contexts always need a Jira administrator.
  projectAdminOptionEdits: 'approval',
  maxContextProjects: 10, // spaces in a new field's context, the own one included (UC-04)
  auditRetentionMonths: 0, // audit entries older than this are deleted every night; 0 = keep forever (UC-07)
  screenPlacement: 'bottom', // new fields go to the bottom of the first tab, or 'smart': next to the most similar field
  catalogue: [],
  rules: {
    nameMin: RULES.nameMin,
    nameMax: RULES.nameMax,
    maxOptions: RULES.maxOptions,
    maxOptionLength: RULES.maxOptionLength,
    similarity: RULES.similarity,
    // Version 1 of the field request (UC-03): the option types plus text, paragraph, number and date.
    allowedTypes: ['select', 'multiselect', 'multicheckboxes', 'radiobuttons', 'textfield', 'textarea', 'float', 'datepicker'],
    extraForbiddenNames: [],
  },
};

const fromEnv = () => {
  const e = {};
  if (process.env.APPROVER_ACCOUNT_IDS) e.approverAccountIds = process.env.APPROVER_ACCOUNT_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.REQUESTER_AS_REPORTER) e.requesterAsReporter = process.env.REQUESTER_AS_REPORTER !== 'false';
  if (process.env.APPROVAL_PROJECT_KEY) e.approvalProjectKey = process.env.APPROVAL_PROJECT_KEY;
  if (process.env.APPROVAL_REQUEST_TYPE) e.requestTypeName = process.env.APPROVAL_REQUEST_TYPE;
  if (process.env.MINUTES_PER_TICKET) e.minutesPerTicket = Number(process.env.MINUTES_PER_TICKET);
  if (process.env.MINUTES_PER_APPROVAL) e.minutesPerApproval = Number(process.env.MINUTES_PER_APPROVAL);
  return e;
};

let memo = null;

export const getSettings = async () => {
  if (memo && Date.now() - memo.at < 30000) return memo.value;
  const saved = (await kvs.get('settings')) || {};
  const value = { ...DEFAULTS, ...fromEnv(), ...saved, rules: { ...DEFAULTS.rules, ...(saved.rules || {}) }, configured: !!saved.updatedAt };
  memo = { at: Date.now(), value };
  return value;
};

const clampInt = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const keys = (a) => [...new Set((Array.isArray(a) ? a : String(a || '').split(/[\s,;]+/)).map((k) => String(k).trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9_]{1,9}$/.test(k)))];
const names = (a) => [...new Set((Array.isArray(a) ? a : String(a || '').split(/[\n;,]+/)).map((s) => String(s).trim()).filter(Boolean))];
const ids = (a) => [...new Set((Array.isArray(a) ? a : String(a || '').split(/[\s,;]+/)).map((s) => String(s).trim()).filter(Boolean))];

// The catalogue arrives as text from the admin page (one entry per line) or as a list (internal updates).
const catalogueOf = (input, cur) => {
  if (input === undefined) return cur;
  if (Array.isArray(input)) return input;
  const { entries, errors } = parseCatalogue(input);
  if (errors.length) throw new Error(`Catalogue: ${errors.join(' ')}`);
  return entries;
};

// Validates and stores; returns the effective settings.
export const saveSettings = async (input, by) => {
  const cur = await getSettings();
  const r = input.rules || {};
  const next = {
    enabledProjects: keys(input.enabledProjects ?? cur.enabledProjects),
    approvalProjectKey: keys([input.approvalProjectKey ?? cur.approvalProjectKey])[0] || cur.approvalProjectKey,
    approvalIssueTypeId: String(input.approvalIssueTypeId ?? cur.approvalIssueTypeId ?? '').replace(/\D/g, ''),
    approvalRequestTypeId: String(input.approvalRequestTypeId ?? cur.approvalRequestTypeId ?? '').replace(/\D/g, ''),
    requestTypeName: String(input.requestTypeName ?? cur.requestTypeName).trim().slice(0, 80) || DEFAULTS.requestTypeName,
    approverAccountIds: ids(input.approverAccountIds ?? cur.approverAccountIds),
    backupApproverAccountIds: ids(input.backupApproverAccountIds ?? cur.backupApproverAccountIds),
    requesterAsReporter: input.requesterAsReporter === undefined ? cur.requesterAsReporter : !!input.requesterAsReporter,
    notifyRequester: input.notifyRequester === undefined ? cur.notifyRequester : !!input.notifyRequester,
    reminderHours: clampInt(input.reminderHours ?? cur.reminderHours, 1, 720, 24),
    escalateHours: clampInt(input.escalateHours ?? cur.escalateHours, 1, 1440, 48),
    minutesPerTicket: clampInt(input.minutesPerTicket ?? cur.minutesPerTicket, 1, 600, 20),
    minutesPerApproval: clampInt(input.minutesPerApproval ?? cur.minutesPerApproval, 0, 600, 3),
    alertsEnabled: input.alertsEnabled === undefined ? cur.alertsEnabled : !!input.alertsEnabled,
    selfTestFieldId: String(input.selfTestFieldId ?? cur.selfTestFieldId).trim(),
    safeMode: input.safeMode === undefined ? cur.safeMode : !!input.safeMode,
    autoSafeModeRate: clampInt(input.autoSafeModeRate ?? cur.autoSafeModeRate, 5, 1000, 30),
    dailyQuota: clampInt(input.dailyQuota ?? cur.dailyQuota, 0, 1000, 20),
    twoPersonThreshold: clampInt(input.twoPersonThreshold ?? cur.twoPersonThreshold, 1, 1000000, 100),
    policyAddsOnly: input.policyAddsOnly === undefined ? cur.policyAddsOnly : !!input.policyAddsOnly,
    stage1MaxApprovers: clampInt(input.stage1MaxApprovers ?? cur.stage1MaxApprovers, 1, 20, 10),
    digestEnabled: input.digestEnabled === undefined ? cur.digestEnabled : !!input.digestEnabled,
    simulateNonAdminIds: ids(input.simulateNonAdminIds ?? cur.simulateNonAdminIds),
    simulateProjectAdminIds: ids(input.simulateProjectAdminIds ?? cur.simulateProjectAdminIds ?? []),
    projectAdminOptionEdits: (input.projectAdminOptionEdits ?? cur.projectAdminOptionEdits) === 'direct' ? 'direct' : 'approval',
    maxContextProjects: clampInt(input.maxContextProjects ?? cur.maxContextProjects, 1, 100, 10),
    auditRetentionMonths: clampInt(input.auditRetentionMonths ?? cur.auditRetentionMonths, 0, 120, 0),
    screenPlacement: (input.screenPlacement ?? cur.screenPlacement) === 'smart' ? 'smart' : 'bottom',
    catalogue: catalogueOf(input.catalogue, cur.catalogue),
    rules: {
      nameMin: clampInt(r.nameMin ?? cur.rules.nameMin, 1, 100, 3),
      nameMax: clampInt(r.nameMax ?? cur.rules.nameMax, 5, 255, 40),
      maxOptions: clampInt(r.maxOptions ?? cur.rules.maxOptions, 1, 10000, 100),
      maxOptionLength: clampInt(r.maxOptionLength ?? cur.rules.maxOptionLength, 5, 255, 60),
      similarity: Math.min(1, Math.max(0.5, Number(r.similarity ?? cur.rules.similarity) || 0.8)),
      allowedTypes: (r.allowedTypes ?? cur.rules.allowedTypes).filter((k) => CREATABLE.some((t) => t.key === k)),
      extraForbiddenNames: names(r.extraForbiddenNames ?? cur.rules.extraForbiddenNames).slice(0, 200),
    },
    updatedAt: Date.now(),
    updatedBy: by,
  };
  if (next.rules.nameMin > next.rules.nameMax) next.rules.nameMin = next.rules.nameMax;
  await kvs.set('settings', next);
  memo = null;
  return getSettings();
};

export const isEnabledFor = (settings, projectKey) => !!settings.configured && (!settings.enabledProjects.length || settings.enabledProjects.includes(projectKey));

// What a fresh installation still needs. Shown on the admin page and used to keep checks quiet until it is done.
export const setupState = (s, selfTestField = null, siteCheck = null) => {
  const steps = [
    { key: 'projects', label: 'Projects where the self-service runs', done: !!s.configured && s.enabledProjects.length > 0 },
    { key: 'space', label: 'Approval space', done: !!s.approvalProjectKey },
    { key: 'approvers', label: 'Approvers', done: s.approverAccountIds.length > 0 },
    { key: 'selftest', label: 'Self-test field', done: !!selfTestField },
    { key: 'sitecheck', label: 'Site compatibility check passed', done: !!siteCheck && siteCheck.level !== 'fail' },
  ];
  return { complete: steps.every((x) => x.done), steps };
};

// Internal: remember the field created from a catalogue template, so the next project reuses it.
export const setCatalogueFieldId = async (entryId, fieldId) => {
  const cur = await getSettings();
  const catalogue = cur.catalogue.map((e) => (e.id === entryId && !e.fieldId ? { ...e, fieldId } : e));
  const saved = (await kvs.get('settings')) || {};
  await kvs.set('settings', { ...saved, catalogue });
  memo = null;
};
