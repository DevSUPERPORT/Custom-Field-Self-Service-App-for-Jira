/**
 * Which audit-log entries can be undone, and why not: already undone, an undo waiting for approval, or a later change
 * on the same field that the undo would wipe out. Pure functions shared by the backend and the tests.
 *
 * @file        src/shared/undo.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// One change = one undo key: a bulk change (all its fields), an option change (one field), or an administration step.
// An option change puts the field back to its state BEFORE the change, so it may only be undone while it is the latest
// change on that field (a later one would be undone with it): older ones are 'superseded' until the later is undone.

export const undoKeyOf = (l) => (l.bulkId ? `bulk:${l.bulkId}` : l.adminOp ? `op:${l.adminOp}` : l.batchId ? `batch:${l.batchId}` : null);
export const isUndoEntry = (l) => /^undo\b/i.test(String(l.via || '')) || l.action === 'Undo';

// Keys whose change was undone, read from the log itself (undo entries name what they undid).
export const undoneKeys = (log) => {
  const out = new Set();
  log.forEach((l) => {
    const via = String(l.via || '');
    let m = /^undo of (\d+-\d+)/.exec(via);
    if (m) out.add(`batch:${m[1]}`);
    m = /^undo of bulk change (\w+)/.exec(via);
    if (m) out.add(`bulk:${m[1]}`);
    if (l.action === 'Undo') {
      m = /administration step (\w+)/.exec(l.new || '');
      if (m) out.add(`op:${m[1]}`);
    }
  });
  return out;
};

// log: newest first. extra.undone / extra.pending: keys known from elsewhere (bulk job status, open undo requests).
// Returns { key: 'available' | 'undone' | 'pending' | 'superseded' | 'none' }.
export const undoStates = (log, { undone = [], pending = [] } = {}) => {
  const done = new Set([...undoneKeys(log), ...undone]);
  const wait = new Set(pending);
  const out = {};
  const newer = {}; // fieldId -> option changes seen so far (newer ones), still in effect
  const optionKey = (k) => k && !k.startsWith('op:');
  for (const l of [...log].sort((a, b) => b.ts - a.ts)) {
    if (!l.executed) continue;
    const k = undoKeyOf(l);
    const f = l.fieldId || '';
    if (!k) continue;
    const later = (newer[f] || []).filter((x) => x !== k);
    if (!out[k]) {
      out[k] = isUndoEntry(l) ? 'none' : done.has(k) ? 'undone' : wait.has(k) ? 'pending' : optionKey(k) && later.length ? 'superseded' : 'available';
    } else if (out[k] === 'available' && optionKey(k) && later.length) {
      out[k] = 'superseded';
    }
    // Undo entries restore an older state and undone changes are gone: neither blocks an older change.
    if (optionKey(k) && !isUndoEntry(l) && !done.has(k) && f && !(newer[f] || []).includes(k)) (newer[f] = newer[f] || []).push(k);
  }
  return out;
};

// What the Undo button does for one key: the call payload for the 'undo' resolver.
export const undoPayload = (key) => {
  const [kind, id] = String(key || '').split(/:(.+)/);
  if (kind === 'bulk') return { jobId: id };
  if (kind === 'op') return { adminOpId: id };
  if (kind === 'batch') return { batchId: id };
  return null;
};
