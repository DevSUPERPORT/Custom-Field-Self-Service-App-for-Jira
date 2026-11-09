/**
 * Daily and on-demand self-test with timed checks; the write check edits and restores a dedicated test field in the
 * approval space. A failure raises an alert for SUPERPORT and can switch on safe mode.
 *
 * @file        src/selftest.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Self-test: runs every day and on demand from the admin page. Every check reports ok / failed with timing; a
// failure raises an alert work item for SUPERPORT. The write check edits the dedicated field "CFS Selftest Options"
// (context: approval space only) and restores it, so nothing users rely on is touched.
import { kvs } from '@forge/kvs';
import * as J from './jira';
import { getSettings } from './settings';
import { checkNewField } from './shared/guidelines';
import { computePlan, toTree } from './shared/options';
import { executePlan, fieldForProject } from './fields';
import { approvalSetup } from './approvals';
import { overview, overviewComplete, guidelineContext } from './service';
import { raiseAlert, withFieldLock } from './ops';
import { savePlan, takePlan } from './plans';
import { tripSafeMode, safeModeState } from './guards';

import { SELFTEST_FIELD_NAME, findSelfTestField } from './sitecheck';

export { SELFTEST_FIELD_NAME, findSelfTestField };

const timed = async (name, fn) => {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, ms: Date.now() - t0, detail: detail || '' };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, detail: e.message.slice(0, 300) };
  }
};

const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

export const runSelfTest = async (trigger = 'schedule') => {
  const s = await getSettings();
  const pk = s.approvalProjectKey;
  const checks = [];
  // A fresh installation is not a failure: no alert, no safe mode until an admin has set it up.
  if (!s.configured || !pk) {
    const result = { at: Date.now(), trigger, ok: null, skipped: true, checks: [{ name: 'Setup', ok: false, ms: 0, detail: 'Not set up yet: finish the setup checklist on the admin page.' }] };
    await kvs.set('selftest:last', result);
    return result;
  }

  checks.push(await timed('Guideline rules', async () => {
    const ctx = await guidelineContext();
    const base = { name: 'Selftest Contract Kind', description: 'x', typeKey: 'select', optionsText: 'A\nB', projectKeys: [pk], justification: 'self-test', global: false };
    const ok = checkNewField(base, ctx);
    const red = checkNewField({ ...base, name: 'Status' }, ctx);
    const yellow = checkNewField({ ...base, global: true }, ctx);
    expect(red.result === 'red', `"Status" should be red, got ${red.result}`);
    expect(yellow.result !== 'green', 'a global context should need approval');
    return `sample request: ${ok.result}${ok.result !== 'green' ? ` (${ok.findings.map((f) => f.code).join(', ')})` : ''}; system name: red; global: ${yellow.result}`;
  }));

  checks.push(await timed('Background job (5-minute sweep)', async () => {
    const hb = await kvs.get('heartbeat:sweep');
    expect(hb, 'no heartbeat yet');
    const min = Math.round((Date.now() - hb.at) / 60000);
    expect(min <= 15, `last run ${min} minutes ago`);
    return `last run ${min} min ago, ${hb.open} open request(s)`;
  }));

  checks.push(await timed(`Read fields of ${pk}`, async () => {
    const ov = await overviewComplete(pk, true);
    const bad = ov.fields.filter((f) => f.error);
    expect(!bad.length, `could not read ${bad.length} field(s): ${bad.slice(0, 3).map((f) => f.name).join(', ')}`);
    return `${ov.fields.length} fields`;
  }));

  checks.push(await timed('Approval space', async () => {
    const setup = await approvalSetup();
    expect(!/Could not read/.test(setup.note), setup.note);
    expect(setup.approvers > 0, 'no approvers configured');
    return setup.note;
  }));

  let field = null;
  checks.push(await timed(`Write round-trip on "${SELFTEST_FIELD_NAME}"`, async () => {
    const all = await J.customFields();
    const f = findSelfTestField(all, s);
    expect(f, `field "${SELFTEST_FIELD_NAME}" not found (admin page → Settings → setup checklist → Create self-test field)`);
    field = (await fieldForProject(pk, f.id)).field;
    expect(field.editable === 'direct', `its context must belong to ${pk} only`);
    return withFieldLock(field.id, 'self-test', async () => {
      const before = toTree(await J.options(field.id, field.contextId));
      const active = before.filter((o) => !o.disabled);
      expect(active.length >= 2, 'needs at least two active options');
      const [a, b] = active;
      // 1. rename the first option and swap the first two, 2. verify, 3. restore and verify
      const changed = before.map((o) => (o.key === a.key ? { ...o, value: `${a.value} (selftest)` } : o));
      const ia = changed.findIndex((o) => o.key === a.key);
      const ib = changed.findIndex((o) => o.key === b.key);
      [changed[ia], changed[ib]] = [changed[ib], changed[ia]];
      await executePlan(field.id, field.contextId, computePlan(before, changed));
      const mid = toTree(await J.options(field.id, field.contextId));
      expect(mid.find((o) => o.key === a.key)?.value === `${a.value} (selftest)`, 'rename not visible');
      expect(mid.findIndex((o) => o.key === b.key) < mid.findIndex((o) => o.key === a.key), 'new order not visible');
      await executePlan(field.id, field.contextId, computePlan(mid, before));
      const after = toTree(await J.options(field.id, field.contextId));
      expect(after.map((o) => `${o.key}=${o.value}`).join('|') === before.map((o) => `${o.key}=${o.value}`).join('|'), 'restore failed');
      return `renamed, reordered and restored ${field.name} (${field.id})`;
    });
  }));

  checks.push(await timed('Usage counts (JQL)', async () => {
    expect(field, 'skipped: no self-test field');
    const n = await J.countJql(`project = "${pk}" AND cf[${field.id.split('_')[1]}] is EMPTY`);
    expect(Number.isFinite(n), 'count not a number');
    return `${n} work item(s) counted`;
  }));

  checks.push(await timed('Guard rails (plan IDs)', async () => {
    const owner = 'selftest:owner';
    const plan = await savePlan({ kind: 'selftest', projectKey: pk, accountId: owner, input: {}, summary: 'self-test' });
    let stranger = false;
    try { await takePlan(plan.id, 'selftest:stranger'); stranger = true; } catch (e) { /* expected */ }
    expect(!stranger, 'another user could submit someone else\'s plan');
    await takePlan(plan.id, owner);
    let twice = false;
    try { await takePlan(plan.id, owner); twice = true; } catch (e) { /* expected */ }
    expect(!twice, 'a plan could be submitted twice');
    let forged = false;
    try { await takePlan('P-ZZZZZZ', owner); forged = true; } catch (e) { /* expected */ }
    expect(!forged, 'an unknown plan ID was accepted');
    const safe = await safeModeState(s);
    return `foreign, repeated and unknown plan IDs refused; safe mode ${safe.on ? `ON (${safe.reason})` : 'off'}`;
  }));

  const ok = checks.every((c) => c.ok);
  const result = { at: Date.now(), trigger, ok, checks };
  await kvs.set('selftest:last', result);
  const hist = (await kvs.get('selftest:history')) || [];
  await kvs.set('selftest:history', [{ at: result.at, ok, failed: checks.filter((c) => !c.ok).map((c) => c.name) }, ...hist].slice(0, 30));
  if (!ok) {
    const failed = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('\n');
    await raiseAlert('self-test failed', failed);
    // Something basic is broken: nothing may execute directly until SUPERPORT has looked.
    await tripSafeMode(`self-test failed (${trigger}): ${failed.slice(0, 300)}`);
  }
  return result;
};

export const lastSelfTest = async () => ({ last: await kvs.get('selftest:last'), history: (await kvs.get('selftest:history')) || [] });
