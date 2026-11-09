/**
 * The five statuses of requests and audit entries (Waiting for approval, Done, Fail, Rejected, Withdrawn) and the
 * duplicate check for pasted option lists, shared by the backend and the page.
 *
 * @file        src/shared/status.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

export const STATUSES = ['waiting', 'done', 'fail', 'rejected', 'withdrawn'];

const BY_REQUEST = {
  pending: 'waiting', executing: 'waiting', done: 'done', failed: 'fail', blocked: 'fail', declined: 'rejected', cancelled: 'withdrawn', withdrawn: 'withdrawn',
};
export const requestStatus = (p) => BY_REQUEST[p?.status] || 'waiting';

// The entry written when a request is raised ("approval requested: KEY"). Once the request is decided it has its own
// entry (done, rejected, withdrawn, fail), so lists show this one only while the request is still waiting.
export const isRequestEntry = (l) => /approval requested:/.test(String(l?.via || ''));
export const keyOfEntry = (l) => (String(l?.via || '').match(/[A-Z][A-Z0-9_]+-\d+/) || [])[0] || '';

// Audit entries: executed changes are done; the rest says in "via" what happened to the request behind it.
export const logStatus = (l) => {
  if (l?.executed) return 'done';
  if (isRequestEntry(l)) return 'waiting';
  const via = String(l?.via || '');
  if (/^declined/.test(via)) return 'rejected';
  if (/^(cancelled|withdrawn)/.test(via)) return 'withdrawn';
  if (/^(blocked|failed)/.test(via)) return 'fail';
  if (/^requested/.test(via)) return 'waiting';
  return l?.action === 'Drift' ? 'done' : 'fail';
};

// Pasted lists (one option per line, e.g. from Excel): what is new, what repeats an existing option or an earlier
// line. Case and surrounding spaces don't make a different option.
export const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
export const splitLines = (text, existing = []) => {
  const seen = new Set(existing.map(norm));
  const fresh = [];
  const dupes = [];
  String(text || '').split(/\r?\n/).map((l) => l.replace(/\t+/g, ' ').trim()).filter(Boolean).forEach((line) => {
    const k = norm(line);
    if (seen.has(k)) dupes.push(line);
    else {
      seen.add(k);
      fresh.push(line);
    }
  });
  return { fresh, dupes };
};
