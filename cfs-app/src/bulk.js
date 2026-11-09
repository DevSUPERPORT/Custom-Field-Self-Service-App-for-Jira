/**
 * Bulk change engine: one option change across many fields of a project as one job, with scan, preview, one approval
 * when needed, execution in passes with progress, and one-click undo of the whole batch. Switched off for everyone by
 * the bulk feature flag; the code stays for a later release.
 *
 * @file        src/bulk.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Bulk changes: one option change across many fields of a project, as ONE job with one preview, one guard-rail
// decision (one approval when needed), background execution with progress, and one-click undo of the whole batch.
//
// Life of a job (bulk:<id>, items in chunks bulkitems:<id>:<n>, index bulkidx:<PROJECT>:<inverse time>):
//   collecting / scanning   the project's option fields are read in passes (time budget per call) and each field gets
//                           its plan and the number of work items it touches            -> ready
//   ready                   the requester reviews, unticks fields, starts               -> running | pending-approval
//   pending-approval        one approval request for the whole batch (approvals.js, kind 'bulk')  -> running | declined
//   running                 fields are changed one by one, in passes: the page drives them, the 5-minute sweep
//                           finishes them if the page is closed                            -> done (or partial)
//   undoing                 every changed field goes back to its snapshot, in reverse order  -> undone
// Every field is re-planned on its CURRENT options right before it changes, so a job decided hours later still applies
// cleanly or skips the field with a reason; nothing stale is ever written back.
import { kvs, WhereConditions } from '@forge/kvs';
import * as J from './jira';
import * as S from './service';
import { optionTree, executePlan } from './fields';
import { getSettings, isEnabledFor } from './settings';
import { saveSnapshot, getSnapshot, writeLog, allPending } from './audit';
import { withFieldLock, announce } from './ops';
import { guardDecision, recordDirectChange, BY_JIRA_ADMIN } from './guards';
import { normaliseBulk, planField, undoTarget, totals, describeBulk, BULK_OPS, replaceMap, replacedValue, writeForm, sameValue, valueKind } from './shared/bulkops';
import { computePlan, planIsEmpty, describePlan } from './shared/options';
import { buildCatalog } from './shared/catalog';

const CHUNK = 60;
const PAGE_BUDGET = 17000;
const inv = (ts) => String(9999999999999 - ts).padStart(13, '0');
const newId = () => `B${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296).toString(36).toUpperCase()}`;

// ---------- storage ----------

const getMeta = (id) => kvs.get(`bulk:${id}`);
export const metaOf = getMeta;

// Project admins work with the fields their space uses alone: nothing they do in bulk reaches another space.
const ownField = (f, projectKey) => f.scope === 'project' && (f.sharedWith || []).length === 1 && (f.sharedWith[0].key || f.sharedWith[0]) === projectKey;
const ownItem = (i, projectKey) => i.scope === 'project' && (i.sharedWith || []).length === 1 && i.sharedWith[0] === projectKey;
// Running / undoing jobs are also kept in a small index of their own, so the background sweep finds them however long
// the history grows.
const putMeta = async (m) => {
  const active = ['running', 'undoing'].includes(m.status);
  const was = !!m.active;
  m.active = active;
  await kvs.set(`bulk:${m.id}`, m);
  if (active && !was) await kvs.set(`bulkactive:${m.id}`, { id: m.id });
  if (!active && was) await kvs.delete(`bulkactive:${m.id}`).catch(() => null);
};
const getItems = async (m) => (await Promise.all(Array.from({ length: m.chunks || 0 }, (_, i) => kvs.get(`bulkitems:${m.id}:${i}`)))).flatMap((c) => c || []);
const putItems = async (m, items) => {
  const chunks = Math.max(1, Math.ceil(items.length / CHUNK));
  await Promise.all(Array.from({ length: chunks }, (_, i) => kvs.set(`bulkitems:${m.id}:${i}`, items.slice(i * CHUNK, (i + 1) * CHUNK))));
  m.chunks = chunks;
};
const list = async (prefix, max) => {
  const out = [];
  let cursor;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(Math.min(100, max - out.length));
    if (cursor) q = q.cursor(cursor);
    const r = await q.getMany();
    out.push(...r.results.map((x) => x.value));
    cursor = r.nextCursor;
  } while (cursor && out.length < max);
  return out;
};

const publicMeta = (m) => ({
  id: m.id, projectKey: m.projectKey, accountId: m.accountId, bulk: m.bulk, description: describeBulk(m.bulk), status: m.status,
  created: m.created, started: m.started || null, finished: m.finished || null, issueKey: m.issueKey || null,
  totals: m.totals || null, progress: m.progress || null, undo: m.undo || null, note: m.note || '', undoRequest: m.undoRequest || null,
});

const publicItem = (i) => ({
  fieldId: i.fieldId, fieldName: i.fieldName, typeLabel: i.typeLabel, scope: i.scope, editable: i.editable, action: i.action,
  reason: i.reason || '', rows: i.rows || [], affected: i.affected ?? null, defaultCleared: !!i.defaultCleared, include: i.include !== false,
  result: i.result || null, resultNote: i.resultNote || '', undone: !!i.undone,
  moved: i.moved || 0, failedItems: Object.keys(i.failed || {}).length, failNote: Object.values(i.failed || {})[0] || '',
  restored: i.restored || 0, changedSince: i.changedSince || 0, undoNote: i.undoNote || '', phase: i.phase || null,
});

// ---------- scan ----------

// Work items carrying the options a plan disables or renames (project scope of the field). Returns the count and its
// JQL clauses, so the batch can count each work item once (distinctCount).
const scopeJql = (field, projectKey) => {
  const keys = S.scopeKeys(field, projectKey);
  return keys.length ? `project in (${keys.map((k) => `"${k}"`).join(',')}) AND ` : '';
};
const affectedCount = async (field, projectKey, plan, sources) => {
  const scope = scopeJql(field, projectKey);
  const n = String(field.id).replace('customfield_', '');
  const hits = sources || [...plan.disables, ...plan.edits].filter((x) => x.id);
  const jql = (x) => {
    if (x.parentId) return `${scope}cf[${n}] in cascadeOption(${x.parentId}, ${x.id})`;
    if (!field.cascading) return `${scope}cf[${n}] = ${x.id}`;
    return x.parentValue ? null : `${scope}cf[${n}] in cascadeOption(${x.id})`;
  };
  const queries = [...new Set(hits.map(jql).filter(Boolean))];
  if (!queries.length) return { count: 0, clauses: [] };
  const counts = await Promise.all(queries.map((q) => J.countJql(q).catch(() => 0)));
  return { count: counts.reduce((a, b) => a + (b || 0), 0), clauses: queries };
};

// Distinct work items across the included fields: one item carrying the option in ten fields counts once. Very large
// batches fall back to the per-field sum (an upper bound), so the guard rails never under-count.
const MAX_CLAUSES = 400;
const distinctCount = async (items) => {
  const inc = items.filter((i) => i.action === 'change' && i.include !== false);
  if (inc.some((i) => i.affected && !i.jql)) return { n: null, why: 'scanned before work items were counted once' };
  const clauses = [...new Set(inc.flatMap((i) => i.jql))];
  if (!clauses.length) return { n: 0 };
  if (clauses.length > MAX_CLAUSES) return { n: null, why: `more than ${MAX_CLAUSES} queries` };
  try {
    return { n: await J.countJql(clauses.map((c) => `(${c})`).join(' OR ')) };
  } catch (e) {
    console.error(`bulk distinct count failed: ${e.message}`);
    return { n: null, why: e.message.slice(0, 160) };
  }
};
const withDistinct = async (items) => {
  const t = totals(items);
  const d = await distinctCount(items);
  return { ...t, workItemValues: t.workItems, workItems: d.n == null ? t.workItems : Math.min(d.n, t.workItems), distinct: d.n != null, distinctNote: d.why || '' };
};

// Starts a scan, or continues one (jobId). Returns the job and, once ready, its items.
export const scan = async ({ projectKey, input, accountId, jobId, role = 'jira-admin' }) => {
  const t0 = Date.now();
  const budgetLeft = () => PAGE_BUDGET - (Date.now() - t0);
  let m;
  let items;
  if (!jobId) {
    const { bulk, errors } = normaliseBulk(input || {});
    if (errors.length) throw new Error(errors.join(' '));
    const id = newId();
    m = { id, projectKey, accountId, bulk, status: 'collecting', created: Date.now(), progress: { done: 0, total: 0 } };
    items = [];
    await putItems(m, items);
    await putMeta(m);
    await kvs.set(`bulkidx:${projectKey}:${inv(m.created)}`, { id, projectKey, created: m.created });
  } else {
    m = await getMeta(jobId);
    if (!m || m.projectKey !== projectKey) throw new Error('This bulk change does not belong to this project.');
    if (m.accountId !== accountId) throw new Error('Only the person who started this bulk change can continue it.');
    items = await getItems(m);
  }
  if (m.status === 'collecting') {
    let ov = await S.overview(projectKey, false, { cont: true });
    while (ov.incomplete && budgetLeft() > 6000) ov = await S.overview(projectKey, false, { cont: true });
    if (ov.incomplete) {
      m.progress = { done: 0, total: 0, note: `Reading the project's fields (${ov.progress?.done || 0} of ${ov.progress?.total || '?'})…` };
      await putMeta(m);
      return { job: publicMeta(m) };
    }
    const only = m.bulk.onlyFieldIds ? new Set(m.bulk.onlyFieldIds) : null;
    let fields = ov.fields.filter((f) => f.hasOptions && !f.assets && (!only || only.has(f.id)) && (role === 'jira-admin' || ownField(f, projectKey)));
    if ((m.bulk.fieldNames || []).length) {
      const nrm = (x) => String(x || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
      const want = m.bulk.fieldNames.map(nrm);
      const picked = fields.filter((f) => want.includes(nrm(f.name)) || want.includes(nrm(f.id)));
      if (!picked.length) {
        const words = want.flatMap((w) => w.split(' ')).filter((w) => w.length > 3);
        const near = fields.filter((f) => words.some((w) => nrm(f.name).includes(w))).slice(0, 6).map((f) => `"${f.name}"`);
        m.status = 'failed';
        m.note = `No option field called ${m.bulk.fieldNames.map((x) => `"${x}"`).join(', ')} in ${projectKey}${role === 'jira-admin' ? '' : ' that only this space uses'}.${near.length ? ` Did you mean ${near.join(', ')}?` : ''}`;
        await putMeta(m);
        throw new Error(m.note);
      }
      fields = picked;
      m.bulk.fieldNames = picked.map((f) => f.name); // the picker sends IDs; people read names
    }
    items = fields.map((f) => ({
      fieldId: f.id, fieldName: f.name, typeKey: f.typeKey, typeLabel: f.type, cascading: !!f.cascading, contextId: f.contextId,
      scope: f.scope, editable: f.editable, sharedWith: (f.sharedWith || []).map((p) => p.key), action: 'scan',
    }));
    m.status = 'scanning';
    m.progress = { done: 0, total: items.length };
  }
  if (m.status === 'scanning') {
    const settings = await getSettings();
    const todo = items.filter((i) => i.action === 'scan');
    await J.mapLimit(todo, 6, async (it) => {
      if (budgetLeft() < 2500) return;
      try {
        const tree = await optionTree(it.fieldId, it.contextId);
        const r = planField(tree, m.bulk, it);
        if (r.action === 'skip') {
          Object.assign(it, { action: 'skip', reason: r.reason });
          return;
        }
        const outside = it.sharedWith.filter((k) => !isEnabledFor(settings, k));
        if (it.editable === 'readonly') Object.assign(it, { action: 'blocked', reason: 'Global context: only Jira administrators can change it.' });
        else if (outside.length) Object.assign(it, { action: 'blocked', reason: `Shared with ${outside.join(', ')} (outside the self-service).` });
        else Object.assign(it, { action: 'change' });
        const field = { id: it.fieldId, cascading: it.cascading, scope: it.scope, sharedWith: it.sharedWith.map((key) => ({ key })) };
        const a = await affectedCount(field, m.projectKey, r.plan, r.sources);
        Object.assign(it, { rows: r.rows, defaultCleared: r.defaultCleared, affected: a.count, jql: a.clauses });
      } catch (e) {
        Object.assign(it, { action: 'skip', reason: `Could not read the field: ${e.message.slice(0, 120)}` });
      }
    });
    const left = items.filter((i) => i.action === 'scan').length;
    m.progress = { done: items.length - left, total: items.length };
    if (!left) {
      m.status = 'ready';
      m.totals = await withDistinct(items);
    }
  }
  await putItems(m, items);
  await putMeta(m);
  return { job: publicMeta(m), items: m.status === 'ready' ? items.map(publicItem) : undefined };
};

// ---------- start (one guard-rail decision for the whole batch) ----------

export const start = async ({ projectKey, jobId, accountId, exclude = [], createApproval }) => {
  const m = await getMeta(jobId);
  if (!m || m.projectKey !== projectKey) throw new Error('This bulk change does not belong to this project.');
  if (m.accountId !== accountId) throw new Error('Only the person who prepared this bulk change can start it.');
  if (m.status !== 'ready') throw new Error(`This bulk change is ${m.status}.`);
  const admin = await J.isJiraAdmin(accountId);
  if (!admin) await J.assertProjectAdmin(projectKey, accountId);
  const items = await getItems(m);
  const ex = new Set(exclude.map(String));
  items.forEach((i) => { if (i.action === 'change') i.include = !ex.has(i.fieldId); });
  const t = await withDistinct(items);
  if (!t.change) throw new Error('No field is selected.');
  const settings = await getSettings();
  const reasons = [];
  const chosen = items.filter((i) => i.action === 'change' && i.include !== false);
  if (!admin) {
    // Checked again here, whatever the preview said: a project admin's bulk change stays inside the space.
    const foreign = chosen.filter((i) => !ownItem(i, projectKey));
    if (foreign.length) throw new J.Forbidden(`${foreign.slice(0, 3).map((i) => `"${i.fieldName}"`).join(', ')} ${foreign.length > 1 ? 'are' : 'is'} used by other spaces too. Only Jira administrators change shared fields in bulk.`);
    if (settings.projectAdminOptionEdits !== 'direct') reasons.push(BY_JIRA_ADMIN);
  }
  const shared = chosen.filter((i) => i.editable === 'approval');
  if (admin && shared.length && !(m.bulk.op === 'add' && settings.policyAddsOnly)) reasons.push(`${shared.length} field(s) are shared with other projects.`);
  const guard = await guardDecision({ settings, accountId, affectedItems: t.workItems, admin });
  reasons.push(...guard.reasons);
  m.totals = t;
  m.started = Date.now();
  m.progress = { done: 0, total: t.change, failed: 0 };
  await putItems(m, items);
  if (reasons.length) {
    const rows = items.filter((i) => i.action === 'change' && i.include !== false).slice(0, 60)
      .map((i) => ({ action: 'Bulk', option: i.fieldName, old: m.bulk.value, new: { retire: 'retired', restore: 'restored', rename: m.bulk.newValue, add: 'added', replace: `${m.bulk.newValue} (in ${i.affected || 0} work items)` }[m.bulk.op] }));
    m.issueKey = await createApproval({
      kind: 'bulk', projectKey, requester: accountId,
      summary: `Bulk change in ${projectKey}: ${describeBulk(m.bulk)} (${t.change} fields)`,
      reason: reasons.join(' '),
      briefing: [`${t.change} field(s), ${t.workItems} work item(s) affected, ${t.defaultsCleared} default value(s) cleared.`, `Job ${m.id}; it can be undone in one click after it ran.`],
      risk: t.workItems >= settings.twoPersonThreshold || shared.length ? 'high' : 'medium',
      rows: t.change > 60 ? [...rows, { action: '…', option: `${t.change - 60} more field(s)`, old: '', new: '' }] : rows,
      // One line in the audit log for the whole batch; the request itself lists every field.
      logRows: [{ action: 'Bulk change', option: describeBulk(m.bulk), old: '', new: `${t.change} field(s), ${t.workItems} work item(s)` }],
      payload: { jobId: m.id, fieldName: `${t.change} field${t.change === 1 ? '' : 's'}`, description: describeBulk(m.bulk), affected: [...new Set([projectKey, ...chosen.flatMap((i) => i.sharedWith || [])])] },
    });
    m.status = 'pending-approval';
    await announce([projectKey], { type: 'requested' }).catch(() => null);
    await putMeta(m);
    return { job: publicMeta(m), reasons };
  }
  m.status = 'running';
  await recordDirectChange(accountId, settings); // one job = one change for the site-wide rate
  await putMeta(m);
  return run({ jobId: m.id });
};

// Approved (approvals.js) or declined.
export const approved = async (jobId, approver) => {
  const m = await getMeta(jobId);
  if (!m || m.status !== 'pending-approval') return null;
  m.status = 'running';
  m.approvedBy = approver || null;
  await putMeta(m);
  return run({ jobId, budget: 15000 });
};
export const declined = async (jobId, status = 'declined') => {
  const m = await getMeta(jobId);
  if (m && m.status === 'pending-approval') {
    m.status = status;
    m.finished = Date.now();
    await putMeta(m);
  }
};

// ---------- run (in passes) ----------

const stepField = async (m, it, openByField) => {
  const open = (openByField[it.fieldId] || []).filter((k) => k !== m.issueKey);
  if (open.length) return { result: 'skipped', note: `${open[0]} is waiting for approval on this field.` };
  return withFieldLock(it.fieldId, `bulk ${m.id}`, async () => {
    const current = await optionTree(it.fieldId, it.contextId);
    const r = planField(current, m.bulk, it);
    if (r.action === 'skip') return { result: 'skipped', note: r.reason };
    if (r.plan.defaultChange) r.plan.defaultChange.typeKey = it.typeKey;
    const snapId = await saveSnapshot({ projectKey: m.projectKey, fieldId: it.fieldId, fieldName: it.fieldName, contextId: it.contextId, before: current, bulkId: m.id });
    it.snapId = snapId;
    await executePlan(it.fieldId, it.contextId, r.plan);
    await writeLog(m.projectKey, r.rows.map((row) => ({
      ...row, actor: m.accountId, approver: m.approvedBy || undefined, fieldId: it.fieldId, fieldName: it.fieldName,
      via: `bulk change ${m.id}${m.issueKey ? ` (approved: ${m.issueKey})` : ''}`, executed: true, batchId: snapId, bulkId: m.id,
    })));
    return { result: 'done', snapId, rows: r.rows };
  });
};

// ---------- replace: change the work items, in passes ----------

// Every work item changed is logged with its old and new value (chunks of 150), so the undo can put back exactly what
// was there - and leaves alone what somebody changed since.
const VALS = 150;
const valKey = (m, it, n) => `bulkvals:${m.id}:${it.fieldId}:${n}`;
const valCount = async (m, it) => (await kvs.get(`bulkvalsn:${m.id}:${it.fieldId}`)) || 0;
const readVals = async (m, it) => {
  const n = await valCount(m, it);
  return (await Promise.all(Array.from({ length: n }, (_, i) => kvs.get(valKey(m, it, i))))).flatMap((c) => c || []);
};
const appendVals = async (m, it, entries) => {
  if (!entries.length) return;
  let n = await valCount(m, it);
  let i = Math.max(0, n - 1);
  let cur = n ? (await kvs.get(valKey(m, it, i))) || [] : [];
  for (const e of entries) {
    if (cur.length >= VALS) { await kvs.set(valKey(m, it, i), cur); i += 1; cur = []; }
    cur.push(e);
  }
  await kvs.set(valKey(m, it, i), cur);
  n = i + 1;
  await kvs.set(`bulkvalsn:${m.id}:${it.fieldId}`, n);
};

const asField = (it) => ({ id: it.fieldId, cascading: it.cascading, scope: it.scope, sharedWith: (it.sharedWith || []).map((key) => ({ key })) });
const sourceJql = (m, it, map) => {
  const n = String(it.fieldId).replace('customfield_', '');
  const cascading = valueKind(it) === 'cascading';
  const parts = Object.keys(map).map((k) => {
    const [a, b] = k.split('>');
    if (b) return `cf[${n}] in cascadeOption(${a}, ${b})`;
    return cascading ? `cf[${n}] in cascadeOption(${a})` : `cf[${n}] = ${a}`;
  });
  return parts.length ? `${scopeJql(asField(it), m.projectKey)}(${parts.join(' OR ')}) ORDER BY key ASC` : null;
};

// Moves the work items still carrying the old option. True once a full search finds none left to change.
const moveValues = async (m, it, left) => {
  const map = replaceMap(await optionTree(it.fieldId, it.contextId), m.bulk);
  const jql = sourceJql(m, it, map);
  if (!jql) return true;
  const kind = valueKind(it);
  const done = new Set((await readVals(m, it)).map((e) => e.k));
  const failed = it.failed || {};
  const finish = (v) => { it.failed = Object.fromEntries(Object.entries(failed).slice(0, 300)); return v; };
  while (left() > 5000) {
    let token;
    let touched = 0;
    let outOfTime = false;
    do {
      const page = await J.searchPage(jql, [it.fieldId], token);
      // The search index can lag a few seconds behind an edit: work items changed already are skipped.
      const todo = (page.issues || []).filter((x) => !done.has(x.key) && !failed[x.key]);
      const entries = [];
      await J.mapLimit(todo, 5, async (x) => {
        if (left() < 3000) { outOfTime = true; return; }
        const old = x.fields?.[it.fieldId] ?? null;
        const next = replacedValue(old, map, kind);
        if (!next) return;
        touched += 1;
        try {
          await J.setIssueField(x.key, it.fieldId, next);
          entries.push({ k: x.key, o: writeForm(old), n: next });
          done.add(x.key);
        } catch (e) {
          failed[x.key] = e.message.replace(/^.*?HTTP /, 'HTTP ').slice(0, 180);
        }
      });
      await appendVals(m, it, entries);
      it.moved = (it.moved || 0) + entries.length;
      if (outOfTime || (page.nextPageToken && left() < 5000)) return finish(false);
      token = page.nextPageToken;
    } while (token);
    if (!touched) return finish(true);
  }
  return finish(false);
};

// One field of a replace: make the replacement available, move the work items, retire the old option. Resumes where
// the previous pass stopped (it.phase).
const stepReplace = async (m, it, openByField, left) => {
  if (!it.phase) {
    const open = (openByField[it.fieldId] || []).filter((k) => k !== m.issueKey);
    if (open.length) return { result: 'skipped', note: `${open[0]} is waiting for approval on this field.` };
  }
  return withFieldLock(it.fieldId, `bulk ${m.id}`, async () => {
    const via = `bulk change ${m.id}${m.issueKey ? ` (approved: ${m.issueKey})` : ''}`;
    // Option rows of a replace carry no per-row undo: undoing only the options would strand the work items.
    const log = (rows) => writeLog(m.projectKey, rows.map((row) => ({ ...row, actor: m.accountId, approver: m.approvedBy || undefined, fieldId: it.fieldId, fieldName: it.fieldName, via, executed: true, bulkId: m.id })));
    if (!it.phase) {
      const current = await optionTree(it.fieldId, it.contextId);
      const whole = planField(current, m.bulk, it);
      if (whole.action === 'skip') return { result: 'skipped', note: whole.reason };
      it.snapId = await saveSnapshot({ projectKey: m.projectKey, fieldId: it.fieldId, fieldName: it.fieldName, contextId: it.contextId, before: current, bulkId: m.id });
      const prep = planField(current, m.bulk, it, { phase: 'prep' });
      if (prep.action === 'change') {
        if (prep.plan.defaultChange) prep.plan.defaultChange.typeKey = it.typeKey;
        await executePlan(it.fieldId, it.contextId, prep.plan);
        await log(prep.rows.filter((r) => !['Replace', 'Note'].includes(r.action)));
      }
      it.phase = 'values';
    }
    if (it.phase === 'values') {
      if (!(await moveValues(m, it, left))) return { result: null };
      it.phase = 'retire';
    }
    if (it.phase === 'retire') {
      const rows = [{ action: 'Replace', option: `${m.bulk.value} in ${it.moved || 0} work item(s)`, old: m.bulk.value, new: m.bulk.newValue }];
      if (m.bulk.retireOld) {
        const current = await optionTree(it.fieldId, it.contextId);
        const r = planField(current, m.bulk, it, { phase: 'retire' });
        if (r.action === 'change') {
          if (r.plan.defaultChange) r.plan.defaultChange.typeKey = it.typeKey;
          await executePlan(it.fieldId, it.contextId, r.plan);
          rows.push(...r.rows);
        }
      }
      await log(rows);
      it.phase = 'done';
    }
    const failedN = Object.keys(it.failed || {}).length;
    return { result: 'done', note: `${it.moved || 0} work item(s) changed${failedN ? `; ${failedN} could not be changed (${Object.values(it.failed)[0]})` : ''}` };
  });
};

// Undo of one replace field, in three steps: options back as before, but with every option the work items had kept
// active for the moment (Jira won't set a retired option); then every work item that still has the value the bulk
// change gave it gets its old value; then the options get their exact old state (retired ones retired again).
const undoReplace = async (m, it, left) => withFieldLock(it.fieldId, `undo bulk ${m.id}`, async () => {
  const snap = await getSnapshot(it.snapId);
  const vals = await readVals(m, it);
  const toOptions = async (target, note) => {
    const current = await optionTree(it.fieldId, it.contextId);
    const plan = computePlan(current, target(current));
    if (planIsEmpty(plan)) return;
    if (plan.defaultChange) plan.defaultChange.typeKey = it.typeKey;
    await executePlan(it.fieldId, it.contextId, plan);
    if (note) await writeLog(m.projectKey, describePlan(plan).map((row) => ({ ...row, actor: m.undo.by, approver: m.undo.approvedBy || undefined, fieldId: it.fieldId, fieldName: it.fieldName, via: `undo of bulk change ${m.id}`, executed: true, bulkId: m.id })));
  };
  if (!it.undoPhase) {
    const needed = new Set(vals.flatMap((e) => {
      const w = writeForm(e.o);
      if (!w) return [];
      return Array.isArray(w) ? w.map((x) => x.id) : [w.id, ...(w.child ? [w.child.id] : [])];
    }));
    const keepActive = (p) => ({ ...p, disabled: needed.has(String(p.id)) ? false : p.disabled, children: (p.children || []).map((c) => ({ ...c, disabled: needed.has(String(c.id)) ? false : c.disabled })) });
    await toOptions((current) => undoTarget(current, snap.before).map(keepActive), false);
    it.undoPhase = 'values';
  }
  if (it.undoPhase === 'values') {
    let i = it.undoCursor || 0;
    while (i < vals.length && left() > 4000) {
      const slice = vals.slice(i, i + 25);
      await J.mapLimit(slice, 5, async (e) => {
        try {
          const cur = await J.issueField(e.k, it.fieldId);
          if (sameValue(cur, e.o)) { it.restored = (it.restored || 0) + 1; return; }
          if (!sameValue(cur, e.n)) { it.changedSince = (it.changedSince || 0) + 1; return; }
          await J.setIssueField(e.k, it.fieldId, e.o);
          it.restored = (it.restored || 0) + 1;
        } catch (err) {
          it.undoFailed = (it.undoFailed || 0) + 1;
          it.undoNote = `${e.k}: ${err.message.replace(/^.*?HTTP /, 'HTTP ').slice(0, 160)}`;
        }
      });
      i += slice.length;
      it.undoCursor = i;
    }
    if (i < vals.length) return false;
    it.undoPhase = 'options';
  }
  await toOptions((current) => undoTarget(current, snap.before), true);
  await writeLog(m.projectKey, [{ action: 'Replace', option: `${m.bulk.newValue} back to ${m.bulk.value} in ${it.restored || 0} work item(s)${it.changedSince ? ` (${it.changedSince} changed since, left as they are)` : ''}`, old: m.bulk.newValue, new: m.bulk.value, actor: m.undo.by, approver: m.undo.approvedBy || undefined, fieldId: it.fieldId, fieldName: it.fieldName, via: `undo of bulk change ${m.id}`, executed: true, bulkId: m.id }]);
  return true;
});

export const run = async ({ jobId, budget = PAGE_BUDGET }) => {
  const t0 = Date.now();
  const m = await getMeta(jobId);
  if (!m) throw new Error('Unknown bulk change.');
  if (!['running', 'undoing'].includes(m.status)) return { job: publicMeta(m) };
  // Lease: the open page, Field Assistant and the background sweep may all push the same job; one pass at a time.
  if (m.passUntil && m.passUntil > Date.now()) return { job: publicMeta(m) };
  const lease = `${Date.now()}-${Math.random()}`;
  m.passUntil = Date.now() + budget + 10000;
  m.passToken = lease;
  await putMeta(m);
  if ((await getMeta(jobId))?.passToken !== lease) return { job: publicMeta(m) };
  const items = await getItems(m);
  const undoing = m.status === 'undoing';
  const replace = m.bulk.op === 'replace';
  const left = () => budget - (Date.now() - t0);
  // Undo takes every field that was touched, also one that failed half-way.
  const touched = (i) => i.snapId && (i.result === 'done' || i.result === 'failed');
  const todo = undoing
    ? items.filter((i) => touched(i) && !i.undone).reverse()
    : items.filter((i) => i.action === 'change' && i.include !== false && !i.result);
  // Open approval requests per field, read once per pass (a field with its own pending request is skipped).
  const openByField = {};
  if (!undoing) {
    (await allPending()).filter((p) => p.status === 'pending').forEach((p) => {
      const f = p.payload?.fieldId || p.payload?.plan?.field?.id;
      if (f) (openByField[f] = openByField[f] || []).push(p.issueKey);
    });
  }
  // Different fields never touch each other: four at a time (two when each also edits many work items).
  await J.mapLimit(todo, replace ? 2 : 4, async (it) => {
    if (Date.now() - t0 > budget - 3000) return;
    try {
      if (undoing && replace) {
        if (await undoReplace(m, it, left)) it.undone = true;
      } else if (replace) {
        const r = await stepReplace(m, it, openByField, left);
        if (r.result) Object.assign(it, { result: r.result, resultNote: r.note || '' });
      } else if (undoing) {
        const snap = await getSnapshot(it.snapId);
        await withFieldLock(it.fieldId, `undo bulk ${m.id}`, async () => {
          const current = await optionTree(it.fieldId, it.contextId);
          const target = undoTarget(current, snap.before);
          const plan = computePlan(current, target);
          if (!planIsEmpty(plan)) {
            if (plan.defaultChange) plan.defaultChange.typeKey = it.typeKey;
            await executePlan(it.fieldId, it.contextId, plan);
            await writeLog(m.projectKey, describePlan(plan).map((row) => ({ ...row, actor: m.undo.by, approver: m.undo.approvedBy || undefined, fieldId: it.fieldId, fieldName: it.fieldName, via: `undo of bulk change ${m.id}`, executed: true, bulkId: m.id })));
          }
        });
        it.undone = true;
      } else {
        const r = await stepField(m, it, openByField);
        Object.assign(it, { result: r.result, resultNote: r.note || '', snapId: r.snapId || null });
      }
    } catch (e) {
      const busy = e.name === 'Busy' || /Another change on this field/.test(e.message);
      it.attempts = (it.attempts || 0) + 1;
      if (!busy || it.attempts >= 5) {
        if (undoing) { it.undone = true; it.undoNote = `Undo failed: ${e.message.slice(0, 160)}`; } else Object.assign(it, { result: 'failed', resultNote: e.message.slice(0, 200) });
      }
    }
  });
  const pendingLeft = undoing ? items.filter((i) => touched(i) && !i.undone).length : items.filter((i) => i.action === 'change' && i.include !== false && !i.result).length;
  const sum = (k) => items.reduce((n, i) => n + (i[k] || 0), 0);
  const done = items.filter((i) => i.result === 'done').length;
  const failed = items.filter((i) => i.result === 'failed').length;
  if (undoing) {
    m.undo.progress = { done: items.filter((i) => i.undone).length, total: items.filter(touched).length, restored: sum('restored'), changedSince: sum('changedSince'), failed: sum('undoFailed') };
    if (!pendingLeft) { m.status = 'undone'; m.undo.finished = Date.now(); }
  } else {
    m.progress = {
      done: items.filter((i) => i.result).length, total: items.filter((i) => i.action === 'change' && i.include !== false).length, changed: done, failed, skipped: items.filter((i) => i.result === 'skipped').length,
      moved: sum('moved'), itemsFailed: items.reduce((n, i) => n + Object.keys(i.failed || {}).length, 0),
    };
    if (!pendingLeft) { m.status = failed ? 'partial' : 'done'; m.finished = Date.now(); }
  }
  m.passUntil = 0;
  await putItems(m, items);
  await putMeta(m);
  if (!pendingLeft) {
    const keys = [...new Set([m.projectKey, ...items.flatMap((i) => i.sharedWith || [])])];
    await S.refresh(keys).catch(() => null);
    await announce(keys, { type: 'changed', by: m.accountId }).catch(() => null);
  }
  return { job: publicMeta(m), items: pendingLeft ? undefined : items.map(publicItem) };
};

// ---------- undo (one click for the whole batch) ----------

// Jira administrators undo at once. The project admin who asked for the bulk change may undo it too: directly when
// project admins change their own fields directly (admin page), otherwise as one approval request.
export const undo = async ({ projectKey, jobId, accountId, createApproval = null }) => {
  const m = await getMeta(jobId);
  if (!m || m.projectKey !== projectKey) throw new Error('This bulk change does not belong to this project.');
  if (!['done', 'partial'].includes(m.status)) throw new Error(['undone', 'undoing'].includes(m.status) ? 'This bulk change was already undone.' : `This bulk change is ${m.status}; only finished changes can be undone.`);
  if (!(await J.isJiraAdmin(accountId))) {
    await J.assertProjectAdmin(projectKey, accountId);
    if (m.accountId !== accountId) throw new J.Forbidden('Only the person who asked for this bulk change, or a Jira administrator, can undo it.');
    if (m.undoRequest) throw new Error(`The undo is already waiting for approval: ${m.undoRequest}.`);
    const settings = await getSettings();
    const guard = settings.projectAdminOptionEdits === 'direct' ? await guardDecision({ settings, accountId, affectedItems: m.totals?.workItems || 0 }) : { approval: true, reasons: [BY_JIRA_ADMIN] };
    if (guard.approval) {
      if (!createApproval) throw new Error('This undo needs approval by a Jira administrator.');
      const moved = m.progress?.moved || 0;
      m.undoRequest = await createApproval({
        kind: 'bulkundo', projectKey, requester: accountId,
        summary: `Undo of a bulk change in ${projectKey}: ${describeBulk(m.bulk)}`.slice(0, 250),
        reason: guard.reasons.join(' '),
        risk: 'low',
        briefing: [`Puts ${m.progress?.changed || 0} field(s) of ${projectKey} back exactly as they were before bulk change ${m.id}${moved ? `, and ${moved} work-item value(s) back to their old value unless changed since` : ''}.`, 'Risk: low. Only this space uses these fields. Recommendation: approve.'],
        rows: [{ action: 'Undo bulk change', option: describeBulk(m.bulk), old: '', new: `${m.progress?.changed || 0} field(s) back as before${moved ? `, ${moved} work-item value(s) back` : ''}` }],
        payload: { jobId: m.id, fieldName: `${m.progress?.changed || 0} field${m.progress?.changed === 1 ? '' : 's'}`, description: `Undo: ${describeBulk(m.bulk)}`, affected: [projectKey] },
      });
      await putMeta(m);
      await announce([projectKey], { type: 'requested' }).catch(() => null);
      return { job: publicMeta(m), status: 'pending', issueKey: m.undoRequest };
    }
  }
  return startUndo(m, accountId, null);
};
const startUndo = async (m, by, approvedBy) => {
  m.status = 'undoing';
  m.undoRequest = null;
  m.undo = { by, approvedBy: approvedBy || undefined, at: Date.now(), progress: { done: 0, total: m.progress?.changed || 0 } };
  await putMeta(m);
  return run({ jobId: m.id });
};
// The undo request of a project admin was approved (approvals.js), or declined / withdrawn.
export const undoApproved = async (jobId, approver) => {
  const m = await getMeta(jobId);
  if (!m || !['done', 'partial'].includes(m.status)) return null;
  return startUndo(m, m.accountId, approver);
};
export const undoDeclined = async (jobId) => {
  const m = await getMeta(jobId);
  if (m && m.undoRequest) { m.undoRequest = null; await putMeta(m); }
};

// ---------- the project's option catalog (the smart pickers on the Bulk changes tab) ----------

// Every option field of the project with its real options, and every option value with where it lives: the fields that
// have it, where it is active, retired or the default, and where it is a sub-option. Built in passes like the
// overview (large projects), cached for a few minutes in size-bounded chunks, cleared whenever fields change.
const CAT_TTL = 10 * 60 * 1000;
const CAT_MAX_OPTIONS = 3000;
const catKey = (k) => `cache:optcat:${k}`;
const compactTree = (tree) => tree.slice(0, CAT_MAX_OPTIONS).map((p) => ({
  v: p.value, o: p.disabled ? 1 : 0, d: p.isDefault ? 1 : 0,
  c: (p.children || []).slice(0, CAT_MAX_OPTIONS).map((c) => ({ v: c.value, o: c.disabled ? 1 : 0, d: c.isDefault ? 1 : 0 })),
}));
const readCat = async (projectKey, meta) => {
  const parts = await Promise.all(Array.from({ length: meta.chunks || 0 }, (_, i) => kvs.get(`${catKey(projectKey)}:${i}`)));
  return Object.fromEntries(parts.flatMap((p) => p || []).map((r) => [r.id, r.t]));
};
const writeCat = async (projectKey, trees, meta) => {
  const chunks = [];
  let cur = [];
  let size = 0;
  Object.entries(trees).forEach(([id, t]) => {
    const n = JSON.stringify(t).length;
    if (cur.length && size + n > 150000) { chunks.push(cur); cur = []; size = 0; }
    cur.push({ id, t });
    size += n;
  });
  if (cur.length) chunks.push(cur);
  await Promise.all(chunks.map((c, i) => kvs.set(`${catKey(projectKey)}:${i}`, c)));
  await kvs.set(catKey(projectKey), { ...meta, chunks: chunks.length });
};
export const catalog = async ({ projectKey, fresh = false, role = 'jira-admin' }) => {
  const t0 = Date.now();
  const left = () => PAGE_BUDGET - (Date.now() - t0);
  const ov = await S.overview(projectKey, false, { cont: true });
  if (ov.incomplete) return { incomplete: true, progress: { done: ov.progress?.done || 0, total: ov.progress?.total || 0, note: "Reading the project's fields" } };
  const fields = ov.fields.filter((f) => f.hasOptions && !f.assets && (role === 'jira-admin' || ownField(f, projectKey)));
  const meta = fresh ? null : await kvs.get(catKey(projectKey));
  const valid = meta && Date.now() - meta.at < CAT_TTL;
  const trees = valid ? await readCat(projectKey, meta) : {};
  const todo = fields.filter((f) => !trees[f.id]);
  await J.mapLimit(todo, 6, async (f) => {
    if (left() < 3000) return;
    try {
      trees[f.id] = compactTree(await optionTree(f.id, f.contextId));
    } catch {
      trees[f.id] = [];
    }
  });
  const at = valid ? meta.at : Date.now();
  if (todo.length) await writeCat(projectKey, trees, { at });
  const missing = fields.filter((f) => !trees[f.id]).length;
  if (missing) return { incomplete: true, progress: { done: fields.length - missing, total: fields.length, note: 'Reading the options' } };
  return { ...buildCatalog(fields, trees), at };
};

// ---------- reading ----------

// Plain-language status for Field Assistant.
export const statusText = (j) => {
  const p = j.progress || {};
  const u = j.undo?.progress || {};
  return {
    jobId: j.id, what: j.description, status: j.status, started: j.started ? new Date(j.started).toISOString() : null,
    fieldsChanged: p.changed || 0, fieldsTotal: p.total || j.totals?.change || 0, workItemsUpdated: p.moved || 0,
    workItemsFailed: p.itemsFailed || 0, fieldsFailed: p.failed || 0, approvalRequest: j.issueKey || null,
    ...(j.undo ? { undo: { fieldsRestored: u.done || 0, workItemsRestored: u.restored || 0, leftAsTheyAre: u.changedSince || 0, failed: u.failed || 0 } } : {}),
    canUndo: ['done', 'partial'].includes(j.status),
    ...(['done', 'partial'].includes(j.status) ? {
      undoWill: `Every option goes back to exactly how it was before this change (one that was already retired before stays retired)${j.progress?.moved ? `, and the ${j.progress.moved} changed work-item value(s) go back, except any somebody changed since` : ''}.`,
    } : {}),
  };
};

export const get = async ({ projectKey, jobId, role = 'jira-admin' }) => {
  const m = await getMeta(jobId);
  if (!m || m.projectKey !== projectKey) throw new Error('Unknown bulk change.');
  // Project admins see the fields of their own space; a Jira administrator's change may also list shared fields.
  const all = await getItems(m);
  const items = role === 'jira-admin' ? all : all.filter((i) => ownItem(i, projectKey));
  return { job: publicMeta(m), items: items.map(publicItem), hiddenItems: all.length - items.length };
};

// Previews that were never applied only clutter the list: each person sees their latest one (for a day); older ones
// were replaced by a newer scan. Everything that ran stays.
const PREVIEW = new Set(['collecting', 'scanning', 'ready', 'failed']);
export const history = async ({ projectKey, max = 25 }) => {
  const idx = await list(`bulkidx:${projectKey}:`, max * 2);
  const metas = (await Promise.all(idx.map((x) => getMeta(x.id)))).filter(Boolean);
  const seen = new Set();
  const shown = metas.filter((m) => {
    if (!PREVIEW.has(m.status)) return true;
    const latest = !seen.has(m.accountId);
    seen.add(m.accountId);
    return latest && Date.now() - m.created < 86400000;
  }).slice(0, max);
  const names = await S.namesOf(shown.map((m) => m.accountId)).catch(() => ({}));
  return shown.map((m) => ({ ...publicMeta(m), by: names[m.accountId] || m.accountId }));
};

// Background: the 5-minute sweep finishes running / undoing jobs whose page was closed.
export const continueJobs = async (budget = 60000) => {
  const t0 = Date.now();
  const ids = [...new Set([...(await list('bulkactive:', 200)), ...(await list('bulkidx:', 200))].map((x) => x.id))];
  for (const id of ids) {
    if (Date.now() - t0 > budget) break;
    const m = await getMeta(id);
    if (m && ['running', 'undoing'].includes(m.status) && !(m.passUntil > Date.now())) {
      await run({ jobId: m.id, budget: Math.min(60000, Math.max(10000, budget - (Date.now() - t0))) }).catch(() => null);
    }
  }
};

export const OPS = BULK_OPS;
