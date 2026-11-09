/**
 * Scheduled checks beyond the self-test: nightly drift detection, suggestions and the approvers' digest e-mail, the
 * weekly digest stored on the approval space, and the text-to-dropdown value migration. While changes are paused only
 * housekeeping runs; while the app is down nothing runs.
 *
 * @file        src/nightly.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Scheduled checks beyond the self-test:
//   nightly  drift detection (options changed outside the app), suggestions (patterns in summaries and labels,
//            text fields that should be dropdowns), the approvers' daily digest e-mail
//   weekly   a digest of the week per pilot project, stored on the approval space for 16_weekly_digest.py
//   migrate  (every 5 minutes, from the sweep) copies text values into a new dropdown, 50 work items per run
import { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import * as J from './jira';
import { overview, overviewComplete, stats } from './service';
import { stateKey } from './fields';
import { toTree } from './shared/options';
import { treeFingerprint, driftCandidates } from './shared/optionops';
import { detectPatterns, textToDropdown } from './shared/patterns';
import { writeLog, readLog, allPending, pruneLog } from './audit';
import { getSettings } from './settings';
import { notifyUsers, raiseAlert, isFieldLocked } from './ops';
import { lookupSelfTestField } from './sitecheck';
import { mayRun } from './maintenance';

const search = (jql, fields, maxResults = 100) => J.app.post(route`/rest/api/3/search/jql`, { jql, fields, maxResults }).then((r) => r.issues || []);
const cf = (id) => id.split('_')[1];

const driftCheck = async (projectKey, ov, seen, skipIds, via = 'nightly check') => {
  const found = [];
  const todo = driftCandidates(ov.fields, skipIds).filter((f) => {
    const k = stateKey(f.id, f.contextId);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // Six at a time: fast enough for the on-demand check from the project page, gentle on Jira.
  await J.mapLimit(todo, 6, async (f) => {
    // A change running right now is not drift: its own state is stored when it finishes.
    if (await isFieldLocked(f.id)) return;
    const k = stateKey(f.id, f.contextId);
    const tree = toTree(await J.options(f.id, f.contextId));
    const hash = treeFingerprint(tree);
    const known = await kvs.get(k);
    if (known && known.hash !== hash) {
      found.push({ fieldId: f.id, name: f.name, before: known.count, now: tree.length });
      await writeLog(projectKey, [{ action: 'Drift', option: f.name, old: `${known.count} options (as last set by the app)`, new: `${tree.length} options now`, fieldId: f.id, fieldName: f.name, via: `changed outside the app (${via})`, executed: false }]);
    }
    await kvs.set(k, { hash, at: Date.now(), count: tree.length });
  });
  return found;
};

// The same check for one space, on demand from the project page (Jira administrators): did anyone change options
// outside the app since the app last set them? Uses the field list the page already has (cached), not a fresh read.
export const driftNow = async (projectKey) => {
  const s = await getSettings();
  const selfTest = await lookupSelfTestField(s).catch(() => null);
  const ov = await overview(projectKey, false);
  const skip = [selfTest?.id];
  const found = await driftCheck(projectKey, ov, new Set(), skip, 'checked on request');
  return { found, checked: driftCandidates(ov.fields, skip).length, skippedSelfTest: !!selfTest && ov.fields.some((f) => f.id === selfTest.id), incomplete: !!ov.incomplete };
};

const suggestions = async (projectKey, ov) => {
  const issues = await search(`project = "${projectKey}" ORDER BY created DESC`, ['summary', 'labels']);
  const names = ov.fields.map((f) => f.name);
  const s = await getSettings();
  const ignorePrefixes = ['cfs', 'custom', 'rovo', 'match', ...s.enabledProjects, s.approvalProjectKey];
  const items = detectPatterns(issues.map((i) => ({ key: i.key, summary: i.fields.summary, labels: i.fields.labels || [] })), names, { ignorePrefixes });
  for (const f of ov.fields.filter((x) => x.typeKey === 'textfield' && !x.error)) {
    const rows = await search(`project = "${projectKey}" AND cf[${cf(f.id)}] is not EMPTY ORDER BY updated DESC`, [f.id]).catch(() => []);
    const s = textToDropdown(rows.map((r) => r.fields[f.id]));
    if (s) items.unshift({ kind: 'text', fieldId: f.id, fieldName: f.name, ...s });
  }
  await kvs.set(`suggest:${projectKey}`, { at: Date.now(), items: items.slice(0, 20) });
  return items.length;
};

// Open requests per approver.
export const digestGroups = async (s) => {
  const open = (await allPending()).filter((p) => p.status === 'pending');
  const byApprover = {};
  open.forEach((p) => (p.approverIds && p.approverIds.length ? p.approverIds : s.approverAccountIds).forEach((a) => {
    byApprover[a] = byApprover[a] || [];
    byApprover[a].push(p);
  }));
  return byApprover;
};

// The e-mail one approver gets: the same text for the real digest and the admin page's preview.
export const digestMessage = (list) => {
  const sorted = [...list].sort((x, y) => x.created - y.created);
  const lines = sorted.map((p) => `- ${p.issueKey} (${p.risk || '?'} risk, waiting ${Math.round((Date.now() - p.created) / 3600000)} h): ${p.summary}`);
  const low = sorted.filter((p) => p.risk === 'low').length;
  return {
    anchor: sorted[0]?.issueKey || null,
    subject: `Custom fields: ${sorted.length} request(s) wait for your decision`,
    text: `${lines.join('\n')}\n\n${low ? `${low} of them are low risk. ` : ''}Decide in each request, or on the admin page (Jira settings → Apps → Custom Field Self-Service for Jira).`,
    items: sorted.map((p) => ({ issueKey: p.issueKey, risk: p.risk || '?', hours: Math.round((Date.now() - p.created) / 3600000), summary: p.summary })),
  };
};

const digest = async (s) => {
  let sent = 0;
  for (const [a, list] of Object.entries(await digestGroups(s))) {
    const m = digestMessage(list);
    if (await notifyUsers(m.anchor, [a], m.subject, m.text)) sent += 1;
  }
  return sent;
};

export const nightly = async () => {
  // Kill switch: "on" stops everything; "readonly" keeps only the app's own housekeeping (audit retention, the
  // heartbeat). Drift checks and suggestions lead to alerts, and the digest sends e-mails: they wait until it is off.
  if (!mayRun('read')) return { skipped: 'maintenance' };
  const s = await getSettings();
  const out = { drift: [], suggestions: {}, digest: 0, errors: [] };
  if (mayRun('write')) {
    const seen = new Set();
    const selfTest = await lookupSelfTestField(s).catch(() => null);
    for (const key of s.enabledProjects) {
      try {
        const ov = await overviewComplete(key, true);
        out.drift.push(...(await driftCheck(key, ov, seen, [selfTest?.id])));
        out.suggestions[key] = await suggestions(key, ov);
      } catch (e) {
        out.errors.push(`${key}: ${e.message.slice(0, 200)}`);
      }
    }
    if (out.drift.length) await raiseAlert('options changed outside the app', out.drift.map((d) => `${d.name} (${d.fieldId}): ${d.before} -> ${d.now} options`).join('\n'));
    if (s.digestEnabled) out.digest = await digest(s).catch(() => 0);
  } else out.paused = 'changes are paused (maintenance): only housekeeping ran';
  // Retention (UC-07): entries older than the configured months go; 0 = keep forever.
  if (s.auditRetentionMonths > 0) {
    const cutoff = Date.now() - s.auditRetentionMonths * 30.44 * 24 * 3600 * 1000;
    out.pruned = (await pruneLog(cutoff).catch(() => ({ deleted: 0 }))).deleted;
  }
  await kvs.set('heartbeat:nightly', { at: Date.now(), drift: out.drift.length, suggestions: out.suggestions, digest: out.digest, errors: out.errors });
  return out;
};

// ---------- weekly digest ----------

export const weekly = async () => {
  // Kill switch: the digest is written to the approval space, so only when the switch is off.
  if (!mayRun('write')) return { skipped: 'maintenance' };
  const s = await getSettings();
  const since = Date.now() - 7 * 24 * 3600 * 1000;
  const lines = [`# Custom fields: the week until ${new Date().toISOString().slice(0, 10)}`, ''];
  for (const key of s.enabledProjects) {
    const log = (await readLog(key, 500)).filter((l) => l.ts >= since);
    const st = stats(log, s);
    const executed = log.filter((l) => l.executed);
    const sugg = await kvs.get(`suggest:${key}`);
    lines.push(`## ${key}`, '');
    lines.push(`- ${executed.length} change(s) executed: ${st.selfService} by the project itself, ${st.approved} after approval.`);
    lines.push(`- Jira administrator time saved: ${(st.minutes / 60).toFixed(1)} h.`);
    const drift = log.filter((l) => l.action === 'Drift');
    if (drift.length) lines.push(`- ${drift.length} option set(s) changed outside the app: ${drift.map((d) => d.fieldName).join(', ')}.`);
    const fields = [...new Set(executed.map((l) => l.fieldName).filter(Boolean))];
    if (fields.length) lines.push(`- Fields touched: ${fields.join(', ')}.`);
    if (sugg?.items?.length) lines.push(`- Suggestions: ${sugg.items.slice(0, 3).map((x) => (x.kind === 'text' ? `turn "${x.fieldName}" into a dropdown` : `a field for "${x.key}"`)).join('; ')}.`);
    lines.push('');
  }
  const open = (await allPending()).filter((p) => p.status === 'pending');
  lines.push('## Waiting for a decision', '', ...(open.length ? open.map((p) => `- ${p.issueKey}: ${p.summary} (${p.stage === 'admin' ? 'project admin' : 'Jira administrator'}, ${p.risk || '?'} risk)`) : ['- nothing']), '');
  const markdown = lines.join('\n');
  await J.setProjectProperty(s.approvalProjectKey, 'cfs-weekly-digest', { markdown, at: Date.now() });
  return { characters: markdown.length };
};

// ---------- text to dropdown: value migration ----------

export const migrate = async () => {
  const page = await kvs.query().where('key', WhereConditions.beginsWith('mig:')).limit(20).getMany();
  const jobs = page.results.filter((r) => ['queued', 'running'].includes(r.value.status));
  for (const { key, value: m } of jobs) {
    try {
      const options = toTree(await J.options(m.toFieldId, m.contextId));
      const byValue = Object.fromEntries(options.map((o) => [o.value.toLowerCase(), o.id]));
      const skip = (m.skippedKeys || []).slice(0, 200);
      const jql = `project in (${m.projectKeys.map((k) => `"${k}"`).join(',')}) AND cf[${cf(m.fromFieldId)}] is not EMPTY AND cf[${cf(m.toFieldId)}] is EMPTY${skip.length ? ` AND key not in (${skip.join(',')})` : ''} ORDER BY key ASC`;
      const issues = await search(jql, [m.fromFieldId], 50);
      if (!issues.length) {
        await kvs.set(key, { ...m, status: 'done', finished: Date.now() });
        await writeLog(m.projectKeys[0], [{ action: 'Copy values', option: m.toFieldId, old: m.fromFieldId, new: `${m.moved} work item(s) copied, ${m.skipped} without a matching option`, fieldId: m.toFieldId, fieldName: m.toFieldName || m.toFieldId, via: 'text to dropdown (background job)', executed: true }]);
        continue;
      }
      let moved = 0;
      const skipped = [];
      for (const i of issues) {
        const id = byValue[String(i.fields[m.fromFieldId] || '').trim().toLowerCase()];
        if (!id) { skipped.push(i.key); continue; }
        const value = ['multiselect', 'multicheckboxes'].includes(m.typeKey) ? [{ id: String(id) }] : { id: String(id) };
        try {
          await J.app.put(route`/rest/api/3/issue/${i.key}`, { fields: { [m.toFieldId]: value } });
          moved += 1;
        } catch (e) {
          skipped.push(i.key);
        }
      }
      await kvs.set(key, { ...m, status: 'running', moved: m.moved + moved, skipped: m.skipped + skipped.length, skippedKeys: [...skip, ...skipped].slice(0, 200), lastRun: Date.now() });
    } catch (e) {
      await kvs.set(key, { ...m, status: 'failed', error: e.message.slice(0, 300) });
      await raiseAlert(`value copy into ${m.toFieldId} failed`, e.stack || e.message);
    }
  }
  return jobs.length;
};

export const migrations = async () => (await kvs.query().where('key', WhereConditions.beginsWith('mig:')).limit(20).getMany()).results.map((r) => r.value);
