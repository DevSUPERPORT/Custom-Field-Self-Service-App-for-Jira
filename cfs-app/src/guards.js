/**
 * Guard rails that decide whether a change may run directly or needs approval: safe mode, the daily quota per user,
 * the two-person rule for changes touching many work items, and approver verification. They run inside the service
 * functions, so every change path is covered.
 *
 * @file        src/guards.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Guard rails that decide whether a change may execute directly or must go to SUPERPORT for approval.
// They apply to every path (settings page, Field Assistant, approved stage-1 requests), because they run inside
// the service functions, not in the callers.
//   safe mode        manual (admin page) or automatic (self-test failure, unusual change rate)
//   daily quota      direct changes per user and day
//   two-person rule  changes that touch many work items
import { kvs } from '@forge/kvs';
import { raiseAlert } from './ops';

const day = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const hour = () => new Date().toISOString().slice(0, 13).replace(/[-T]/g, '');
const safeKey = (id) => String(id).replace(/[^a-zA-Z0-9:._#-]/g, '_');

// ---------- safe mode ----------

export const safeModeState = async (settings) => {
  if (settings.safeMode) return { on: true, source: 'manual', reason: 'switched on by a Jira administrator on the admin page' };
  const auto = await kvs.get('safemode:auto');
  if (auto?.on) return { on: true, source: 'automatic', reason: auto.reason, at: auto.at };
  return { on: false };
};

export const tripSafeMode = async (reason) => {
  const cur = await kvs.get('safemode:auto');
  if (cur?.on) return;
  await kvs.set('safemode:auto', { on: true, reason, at: Date.now() });
  await raiseAlert('safe mode switched on automatically', `${reason}\n\nEvery change now needs a Jira administrator's approval. Switch it off on the admin page once checked.`);
};

export const clearAutoSafeMode = async (by) => {
  await kvs.set('safemode:auto', { on: false, clearedBy: by, at: Date.now() });
};

// ---------- quota and change rate ----------

export const quotaUsed = async (accountId) => (await kvs.get(`quota:${safeKey(accountId)}:${day()}`)) || 0;

// Called after every direct execution: counts for the user's quota and the site-wide hourly rate.
export const recordDirectChange = async (accountId, settings) => {
  const qk = `quota:${safeKey(accountId)}:${day()}`;
  await kvs.set(qk, ((await kvs.get(qk)) || 0) + 1);
  const rk = `rate:${hour()}`;
  const rate = ((await kvs.get(rk)) || 0) + 1;
  await kvs.set(rk, rate);
  if (rate > settings.autoSafeModeRate) await tripSafeMode(`${rate} direct changes within the hour ${hour()} UTC (limit ${settings.autoSafeModeRate}).`);
};

// ---------- the decision ----------

// affectedItems: work items whose value changes or becomes unselectable. Returns { approval, reasons }.
// Changes by project admins are always approved by a Jira administrator (the services check this before they get
// here); the guard rails below apply to the direct changes of Jira administrators, except the daily quota.
export const BY_JIRA_ADMIN = 'Changes from project admins are approved by a Jira administrator.';
export const guardDecision = async ({ settings, accountId, affectedItems = 0, admin = false }) => {
  const reasons = [];
  const safe = await safeModeState(settings);
  if (safe.on) reasons.push(`Safe mode is on (${safe.reason}).`);
  if (settings.dailyQuota >= 0 && !admin) {
    const used = await quotaUsed(accountId);
    if (used >= settings.dailyQuota) reasons.push(`Daily limit reached: ${used} of ${settings.dailyQuota} direct changes today.`);
  }
  if (affectedItems >= settings.twoPersonThreshold) reasons.push(`Two-person rule: the change touches ${affectedItems} work items (threshold ${settings.twoPersonThreshold}).`);
  return { approval: reasons.length > 0, reasons };
};

// Work items whose value a plan changes or makes unselectable.
export const affectedByPlan = (plan, perOption = {}) => [...plan.edits, ...plan.disables].reduce((n, x) => n + (perOption[x.id] || 0), 0);
