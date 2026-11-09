/**
 * In-app watchdog run from the five-minute sweep at most every 30 minutes: finds approval requests without approvers
 * and approved requests the app has not executed, labels them and raises one alert.
 *
 * @file        src/watchdog.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Watchdog inside the app (runs from the 5-minute sweep, at most every 30 minutes). Same checks as the CFS
// automation rules CFS 1 and CFS 2, but independent of the automation quota:
//   1. an approval request older than 10 minutes that is waiting for approval but has no approvers
//   2. a request approved more than 10 minutes ago that the app has not executed
// Each finding raises an alert work item (deduplicated per day) and labels the request cfs-watchdog.
import { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import * as J from './jira';
import { allPending } from './audit';
import { getSettings } from './settings';
import { raiseAlert } from './ops';
import { resolveTarget } from './approvalspace';

const EVERY = 30 * 60 * 1000;
const GRACE = 10 * 60 * 1000;

const approversFieldId = async () => {
  const fields = await J.app.get(route`/rest/api/3/field`);
  return fields.find((x) => x.name === 'Approvers' && x.schema?.custom?.endsWith(':multiuserpicker'))?.id;
};

const label = (key) => J.app.put(route`/rest/api/3/issue/${key}`, { update: { labels: [{ add: 'cfs-watchdog' }] } }).catch(() => null);

export const watchdog = async (force = false) => {
  const last = await kvs.get('heartbeat:watchdog');
  if (!force && last && Date.now() - last.at < EVERY) return last;
  const s = await getSettings();
  if (!s.configured || !s.approvalProjectKey) {
    const beat = { at: Date.now(), checked: 0, findings: [], note: 'not set up yet' };
    await kvs.set('heartbeat:watchdog', beat);
    return beat;
  }
  const findings = [];
  const open = (await allPending()).filter((p) => Date.now() - p.created > GRACE);
  // The configured approval step says which status waits and which field holds the approvers.
  const target = await resolveTarget().catch(() => null);
  const waiting = new RegExp(`^(${(target?.step?.statusName || 'waiting for approval').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})$`, 'i');
  if (open.length) {
    const fid = target?.step?.fieldId || await approversFieldId();
    const keys = open.map((p) => p.issueKey);
    const res = await J.app.post(route`/rest/api/3/search/jql`, { jql: `key in (${keys.join(',')})`, fields: ['status', ...(fid ? [fid] : [])], maxResults: 100 }).catch(() => ({ issues: [] }));
    for (const i of res.issues || []) {
      const p = open.find((x) => x.issueKey === i.key);
      const status = i.fields.status?.name || '';
      const approvers = fid ? i.fields[fid] || [] : null;
      if (p.status === 'pending' && p.engine === 'app' && !(p.approverIds || []).length) {
        findings.push(`${i.key}: app approval without approvers (${p.summary})`);
        await label(i.key);
      }
      if (p.status === 'pending' && p.engine !== 'app' && waiting.test(status) && approvers && !approvers.length) {
        findings.push(`${i.key}: waiting for approval but nobody is an approver (${p.summary})`);
        await label(i.key);
      }
      if (/waiting for support/i.test(status) && Date.now() - (p.decided || p.created) > GRACE) {
        findings.push(`${i.key}: approved but not executed by the app (app status ${p.status}${p.error ? `: ${p.error}` : ''})`);
        await label(i.key);
      }
    }
  }
  // An approved request the app no longer tracks as open (e.g. a lost record) is caught via Jira itself.
  const stuck = await J.app.post(route`/rest/api/3/search/jql`, {
    jql: `project = "${s.approvalProjectKey}" AND labels = custom-field-self-service AND status = "Waiting for support" AND updated <= -10m`, fields: ['summary'], maxResults: 20,
  }).catch(() => ({ issues: [] }));
  for (const i of stuck.issues || []) {
    if (!findings.some((f) => f.startsWith(`${i.key}:`))) {
      findings.push(`${i.key}: approved (Waiting for support) but not resolved by the app`);
      await label(i.key);
    }
  }
  if (findings.length) await raiseAlert('watchdog found stuck approval requests', findings.join('\n'));
  const beat = { at: Date.now(), checked: open.length, findings };
  await kvs.set('heartbeat:watchdog', beat);
  return beat;
};
