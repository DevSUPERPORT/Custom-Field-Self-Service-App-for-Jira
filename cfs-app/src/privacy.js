/**
 * Personal data reporting (Atlassian's user privacy requirement for apps that store account IDs): once a week the app
 * reports every account ID it keeps, and erases the personal data of accounts Atlassian reports as closed. Records the
 * site needs (audit log, requests) are kept with the person replaced by "closed-account"; records about that person
 * alone (drafts, tour, last visit, daily quota) are deleted.
 *
 * @file        src/privacy.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-06
 * @updated     2026-11-06
 */

import { privacy } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { mayRun } from './maintenance';
import { VALUE_PREFIXES, SINGLE_KEYS, PERSON_PREFIXES, accountsIn, accountOfKey, erase, writtenAt, reportBatches } from './shared/personal';

const BUDGET_MS = 10 * 60 * 1000;
const MAX_RECORDS = 50000;

// Every stored record under a prefix, page by page (100 per page), within the time budget.
const scan = async (prefix, onRecord, left) => {
  let cursor;
  let n = 0;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    for (const r of page.results) { await onRecord(r.key, r.value); n += 1; }
    cursor = page.nextCursor;
  } while (cursor && left() > 0 && n < MAX_RECORDS);
  return !cursor;
};

// account ID -> latest time the app wrote data about it.
const collect = async (left) => {
  const seen = new Map();
  const note = (id, at) => { if (!seen.has(id) || (at || 0) > (seen.get(id) || 0)) seen.set(id, at || seen.get(id) || null); };
  let complete = true;
  for (const prefix of VALUE_PREFIXES) {
    complete = (await scan(prefix, (key, value) => { const at = writtenAt(value); accountsIn(value).forEach((id) => note(id, at)); }, left)) && complete;
  }
  for (const key of SINGLE_KEYS) {
    const value = await kvs.get(key);
    if (value) accountsIn(value).forEach((id) => note(id, writtenAt(value)));
  }
  for (const prefix of PERSON_PREFIXES) {
    complete = (await scan(prefix, (key, value) => { const id = accountOfKey(key); if (id) note(id, writtenAt(value)); }, left)) && complete;
  }
  return { seen, complete };
};

// Erases the closed accounts everywhere the job looks.
const eraseClosed = async (closed, left) => {
  let updated = 0;
  let deleted = 0;
  const fix = async (key, value) => {
    const r = erase(value, closed);
    if (r.changed) { await kvs.set(key, r.value); updated += 1; }
  };
  for (const prefix of VALUE_PREFIXES) await scan(prefix, fix, left);
  for (const key of SINGLE_KEYS) {
    const value = await kvs.get(key);
    if (value) await fix(key, value);
  }
  for (const prefix of PERSON_PREFIXES) {
    await scan(prefix, async (key) => {
      const id = accountOfKey(key);
      if (id && closed.has(id)) { await kvs.delete(key); deleted += 1; }
    }, left);
  }
  return { updated, deleted };
};

/** The weekly job. Writes to storage, so it runs only while the kill switch is off. */
export const reportPersonalData = async () => {
  if (!mayRun('write')) return { skipped: 'maintenance' };
  const t0 = Date.now();
  const left = () => BUDGET_MS - (Date.now() - t0);
  const { seen, complete } = await collect(left);
  const closed = new Set();
  let reported = 0;
  for (const batch of reportBatches(seen)) {
    const answer = await privacy.reportPersonalData(batch);
    reported += batch.length;
    (answer || []).filter((a) => a.status === 'closed').forEach((a) => closed.add(a.accountId));
  }
  const erased = closed.size ? await eraseClosed(closed, left) : { updated: 0, deleted: 0 };
  const result = { at: Date.now(), reported, closed: closed.size, ...erased, complete };
  await kvs.set('heartbeat:privacy', result);
  return result;
};
