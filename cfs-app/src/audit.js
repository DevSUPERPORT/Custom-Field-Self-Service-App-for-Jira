/**
 * Audit log and pending approval requests in Forge storage: writing and reading log entries per project, the stored
 * change behind each request, request indexes, snapshots for undo and retention pruning.
 *
 * @file        src/audit.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

//   log:<PROJECT>:<inverse time>:<n>   one executed change: who, when, field, old, new
//   pending:<ISSUE KEY>                the stored change behind an approval request
//   req:<PROJECT>:<inverse time>       index of a project's approval requests
import { kvs, WhereConditions } from '@forge/kvs';

const inv = (ts) => String(9999999999999 - ts).padStart(13, '0');

export const writeLog = async (projectKey, entries) => {
  const ts = Date.now();
  await Promise.all(entries.map((e, i) => kvs.set(`log:${projectKey}:${inv(ts)}:${String(i).padStart(3, '0')}`, { ts, projectKey, ...e })));
};

const listPrefix = async (prefix, max) => {
  const out = [];
  let cursor;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(Math.min(100, max - out.length));
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    out.push(...page.results.map((r) => r.value));
    cursor = page.nextCursor;
  } while (cursor && out.length < max);
  return out;
};

export const readLog = (projectKey, max = 200) => listPrefix(`log:${projectKey}:`, max);

export const savePending = async (issueKey, pending) => {
  await kvs.set(`pending:${issueKey}`, pending);
  await kvs.set(`req:${pending.projectKey}:${inv(pending.created)}`, { issueKey, created: pending.created, summary: pending.summary, projectKey: pending.projectKey });
};

export const getPending = (issueKey) => kvs.get(`pending:${issueKey}`);
export const updatePending = async (issueKey, patch) => {
  const p = await kvs.get(`pending:${issueKey}`);
  if (p) await kvs.set(`pending:${issueKey}`, { ...p, ...patch });
  return p ? { ...p, ...patch } : null;
};

export const requestsForProject = async (projectKey, max = 50) => {
  const idx = await listPrefix(`req:${projectKey}:`, max);
  return Promise.all(idx.map(async (r) => ({ ...r, ...(await getPending(r.issueKey)) })));
};

// Undo: the option state before an executed change.   snap:<batch id>
export const saveSnapshot = async (snap) => {
  const batchId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await kvs.set(`snap:${batchId}`, { ...snap, ts: Date.now() });
  return batchId;
};
export const getSnapshot = (batchId) => kvs.get(`snap:${batchId}`);

export const openPendingKeys = async () => (await listPrefix('pending:', 500)).filter((p) => p.status === 'pending').map((p) => p.issueKey);

// Open approval requests that would change this field (used to block conflicting changes).
export const pendingForField = async (fieldId) => (await listPrefix('pending:', 500))
  .filter((p) => ['pending', 'executing', 'failed'].includes(p.status) && (p.payload?.fieldId === fieldId || p.payload?.plan?.field?.id === fieldId));

export const allPending = async () => (await listPrefix('pending:', 500)).filter((p) => ['pending', 'failed'].includes(p.status));

// Every request of one person (all statuses), newest first: "My requests".
export const requestsOf = async (accountId, max = 1000) => (await listPrefix('pending:', max))
  .filter((p) => p.requester === accountId).sort((a, b) => (b.created || 0) - (a.created || 0));

// All requests (all statuses), for the Jira administrators' approval queue and site-wide audit log.
export const allRequests = (max = 1000) => listPrefix('pending:', max);

// The whole log of the site (Jira administrators), newest first.
export const readAllLogs = async (max = 3000) => (await listPrefix('log:', max)).sort((a, b) => b.ts - a.ts);

// Retention (UC-07): deletes log entries older than the cutoff. Entries are never changed otherwise. Works within a
// time budget; the next night continues.
export const pruneLog = async (cutoff, budgetMs = 60000) => {
  const stop = Date.now() + budgetMs;
  let cursor;
  let deleted = 0;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith('log:')).limit(100);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    const old = page.results.filter((r) => (r.value?.ts || 0) < cutoff);
    await Promise.all(old.map((r) => kvs.delete(r.key)));
    deleted += old.length;
    cursor = page.nextCursor;
  } while (cursor && Date.now() < stop);
  return { deleted, complete: !cursor };
};

// Projects whose settings page was opened recently: their overview is pre-warmed every hour.
export const markSeen = (projectKey) => kvs.set(`seen:${projectKey}`, { projectKey, at: Date.now() });
export const seenProjects = async () => (await listPrefix('seen:', 200)).filter((s) => Date.now() - s.at < 14 * 24 * 3600 * 1000).map((s) => s.projectKey);
