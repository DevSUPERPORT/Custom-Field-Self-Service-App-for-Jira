/**
 * Operations helpers: field locks so two changes never run on one field at once, live updates to open pages, e-mail
 * to requesters and approvers, and alert work items for SUPERPORT (deduplicated per day).
 *
 * @file        src/ops.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { publishGlobal } from '@forge/realtime';
import { app } from './jira';
import { getSettings } from './settings';

// ---------- one change at a time per field ----------

const LOCK_MS = 90 * 1000;

export class Busy extends Error {
  constructor(message) {
    super(message);
    this.name = 'Busy';
  }
}

const lockKey = (fieldId) => `lock:${String(fieldId).replace(/[^a-zA-Z0-9:._#-]/g, "_")}`;
export const isFieldLocked = async (fieldId) => {
  const cur = await kvs.get(lockKey(fieldId)).catch(() => null);
  return !!(cur && cur.until > Date.now());
};

export const withFieldLock = async (fieldId, label, fn) => {
  const key = lockKey(fieldId);
  const cur = await kvs.get(key);
  if (cur && cur.until > Date.now()) throw new Busy(`Another change on this field is running (${cur.label}). Try again in a minute.`);
  const token = `${Date.now()}-${Math.random()}`;
  await kvs.set(key, { until: Date.now() + LOCK_MS, label, token });
  const mine = await kvs.get(key);
  if (!mine || mine.token !== token) throw new Busy('Another change on this field just started. Try again in a minute.');
  try {
    return await fn();
  } finally {
    const now = await kvs.get(key);
    if (now && now.token === token) await kvs.delete(key);
  }
};

// ---------- live updates for open settings pages ----------

export const announce = async (projectKeys, event) => {
  // Only the kind of event: any page of the app can listen, so no field IDs, request keys or people go out.
  await Promise.all([...new Set(projectKeys)].map((k) => publishGlobal(`cfs-${k}`, { type: event.type, at: Date.now() }).catch(() => null)));
};

// ---------- e-mail through Jira (works without a notification scheme) ----------

export const notifyUsers = async (issueKey, accountIds, subject, text) => {
  const users = [...new Set(accountIds.filter(Boolean))].map((accountId) => ({ accountId }));
  if (!users.length) return false;
  try {
    await app.post(route`/rest/api/3/issue/${issueKey}/notify`, {
      subject: subject.slice(0, 250),
      textBody: text,
      htmlBody: `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`,
      to: { reporter: false, assignee: false, watchers: false, voters: false, users },
    });
    return true;
  } catch (e) {
    return false;
  }
};

// ---------- alerts: a work item for SUPERPORT, at most one per problem per day ----------

export const alertContent = (title, detail) => ({
  summary: `Custom Field Self-Service for Jira: ${title}`.slice(0, 250),
  labels: ['custom-field-self-service', 'cfs-alert'],
  intro: 'Raised automatically by the app. Details:',
  detail: String(detail).slice(0, 3000),
  adf: { type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Raised automatically by the app. Details:' }] },
    { type: 'codeBlock', content: [{ type: 'text', text: String(detail).slice(0, 3000) }] },
  ] },
  emailSubject: `Custom Field Self-Service for Jira needs attention: ${title}`,
  emailBody: `${title}\n\n${String(detail).slice(0, 1500)}`,
});

// The work type alerts use: Task if the approval space has it, else its first standard work type.
export const alertWorkType = (issueTypes) => issueTypes.find((t) => t.name === 'Task') || issueTypes.find((t) => !t.subtask);

export const raiseAlert = async (title, detail) => {
  const s = await getSettings();
  if (!s.alertsEnabled || !s.approvalProjectKey) return null;
  const sig = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
  const key = `alert:${sig}`;
  const last = await kvs.get(key);
  if (last && Date.now() - last.at < 24 * 3600 * 1000) return last.issueKey;
  try {
    const proj = await app.get(route`/rest/api/3/project/${s.approvalProjectKey}?expand=issueTypes`);
    const it = alertWorkType(proj.issueTypes);
    const c = alertContent(title, detail);
    const issue = await app.post(route`/rest/api/3/issue`, { fields: {
      project: { id: proj.id }, issuetype: { id: it.id }, summary: c.summary,
      labels: c.labels,
      description: c.adf,
    } });
    await kvs.set(key, { at: Date.now(), issueKey: issue.key });
    if (s.approverAccountIds.length) await notifyUsers(issue.key, s.approverAccountIds, c.emailSubject, c.emailBody);
    return issue.key;
  } catch (e) {
    return null;
  }
};
