/**
 * Where the app keeps Atlassian account IDs, and how a closed account is erased: pure functions shared by the weekly
 * personal-data job (src/privacy.js) and the tests. Atlassian requires apps that store account IDs to report them and
 * to erase the personal data of accounts that were closed.
 *
 * @file        src/shared/personal.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-06
 * @updated     2026-11-06
 */

// Storage the job reads. Values: records whose fields name people (audit log, requests, administration steps, bulk
// jobs, follow-ups, settings, safe mode). Per-person keys: records about one person only (drafts, tour, last visit,
// daily quota), deleted whole when that account is closed.
export const VALUE_PREFIXES = ['log:', 'pending:', 'adminop:', 'bulk:', 'todo:', 'plan:'];
export const SINGLE_KEYS = ['settings', 'safemode:auto'];
export const PERSON_PREFIXES = ['draft:', 'uidraft:', 'tour:', 'tour-admin:', 'visit:', 'quota:'];

// Field names that hold one account ID, and lists of account IDs.
const ONE = new Set(['actor', 'approver', 'requester', 'approvedBy', 'by', 'undoneBy', 'accountId', 'clearedBy']);
const MANY = new Set(['approverIds', 'approverAccountIds', 'backupApproverAccountIds', 'simulateNonAdminIds', 'simulateProjectAdminIds']);

// Atlassian account IDs: "557058:2f6c…" (prefix, colon, UUID) or the older 24-character form.
export const ACCOUNT_ID = /^(\d{1,10}:[0-9a-f-]{36}|[0-9a-z]{24})$/i;
const isAccount = (v) => typeof v === 'string' && ACCOUNT_ID.test(v);

/** What a closed person's ID is replaced with in records that are kept (the audit log stays complete, without them). */
export const CLOSED = 'closed-account';

/** Every account ID a stored value names (deep). */
export const accountsIn = (value, out = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => accountsIn(v, out));
  else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => {
      if (ONE.has(k) && isAccount(v)) out.add(v);
      else if (MANY.has(k) && Array.isArray(v)) v.filter(isAccount).forEach((id) => out.add(id));
      else if (v && typeof v === 'object') accountsIn(v, out);
    });
  }
  return out;
};

/** The account a per-person key belongs to, or null. */
export const accountOfKey = (key) => {
  const prefix = PERSON_PREFIXES.find((p) => key.startsWith(p));
  if (!prefix) return null;
  const rest = key.slice(prefix.length);
  const m = /^(\d{1,10}:[0-9a-f-]{36}|[0-9a-z]{24})(?=$|:)/i.exec(rest);
  return m ? m[1] : null;
};

/**
 * The value with every closed account erased: a field naming one becomes CLOSED, lists drop it. Returns
 * { value, changed }; the input is not modified.
 */
export const erase = (value, closed) => {
  let changed = false;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      if (ONE.has(k) && typeof x === 'string' && closed.has(x)) { changed = true; return [k, CLOSED]; }
      if (MANY.has(k) && Array.isArray(x) && x.some((id) => closed.has(id))) { changed = true; return [k, x.filter((id) => !closed.has(id))]; }
      return [k, walk(x)];
    }));
  };
  const out = walk(value);
  return { value: out, changed };
};

/** The time a record was last written (for "updatedAt" in the report), or null. */
export const writtenAt = (value) => {
  const t = value && typeof value === 'object' ? Math.max(0, ...['ts', 'at', 'created', 'decided', 'finished'].map((k) => Number(value[k]) || 0)) : 0;
  return t > 0 ? t : null;
};

/** Accounts for one report call: at most `limit` (Atlassian takes 90), each with the latest time it was written. */
export const reportBatches = (seen, limit = 90, now = Date.now()) => {
  const rows = [...seen.entries()].map(([accountId, at]) => ({ accountId, updatedAt: new Date(at || now).toISOString() }));
  const out = [];
  for (let i = 0; i < rows.length; i += limit) out.push(rows.slice(i, i + limit));
  return out;
};
