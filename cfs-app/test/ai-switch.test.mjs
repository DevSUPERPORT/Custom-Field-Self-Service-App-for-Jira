/**
 * EULA 8.4: the AI features (the Field Assistant Rovo agent) are off by default and only Jira administrators switch
 * them on, on the admin page. Off means every Rovo action in the manifest refuses before doing anything; the switch
 * is saved only by a Jira administrator (checked with Jira on the server) and every change is in the audit log.
 * The pages are told (whoami.ai) and show no AI button and no Field Assistant tour step while AI is off.
 *
 * @file        test/ai-switch.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-16
 * @updated     2026-11-16
 */

// Run: node --test test/ai-switch.test.mjs
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';

register('./support/forge-loader.mjs', import.meta.url);
const rec = await import('./support/fake-forge/record.mjs');
const settings = await import('../src/settings.js');
const index = await import('../src/index.js');
const actions = await import('../src/actions.js');

const OFF = 'AI features of this app are turned off. A Jira administrator can turn them on in the app\'s Configuration (Jira settings > Apps > Custom Field Self-Service for Jira > Configuration).';
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// Every function of the Field Assistant: the actions the rovo:agent lists, by their handler in src/index.js.
const manifest = src('manifest.yml').replace(/\r\n/g, '\n');
const fnOf = Object.fromEntries([...manifest.matchAll(/- key: (cfs-[a-z-]+)\n\s+name: [^\n]+\n\s+function: ([a-z-]+)/g)].map((m) => [m[1], m[2]]));
const handlerOf = Object.fromEntries([...manifest.matchAll(/- key: (act-[a-z-]+)\n\s+handler: index\.(\w+)/g)].map((m) => [m[1], m[2]]));
const agentBlock = manifest.slice(manifest.indexOf('rovo:agent:'), manifest.indexOf('\n  action:'));
const AGENT_ACTIONS = [...agentBlock.matchAll(/^\s+- (cfs-[a-z-]+)$/gm)].map((m) => m[1]);
const ROVO = Object.keys(fnOf).map((k) => handlerOf[fnOf[k]]);
const ROVO_PAYLOAD = { projectKey: 'PROJ', field: 'Region', name: 'Region', planId: 'P-ABC123', issueKey: 'CFS-1', fixIds: 'all', jobId: 'B1', value: 'A', op: 'retire' };

// Jira's answer to the permission check: only u-admin has "Administer Jira".
const jira = () => {
  globalThis.__fakeJira = (who, path, opts) => {
    if (!path.includes('/permissions/check')) return undefined;
    const body = JSON.parse(opts.body || '{}');
    return { globalPermissions: body.accountId === 'u-admin' ? (body.globalPermissions || []) : [], projectPermissions: [] };
  };
};
const callAdmin = (name, payload, accountId) => index.adminHandler(
  { call: { functionKey: name, payload }, context: { moduleKey: 'cfs-admin' } },
  { principal: { accountId } },
);
const aiLog = () => [...globalThis.__fakeKvs].filter(([k, v]) => k.startsWith('log:') && v.action === 'AI features').map(([, v]) => v);

afterEach(() => { delete globalThis.__fakeKvs; delete globalThis.__fakeJira; rec.reset(); });

test('the manifest and the code agree: every action of the agent is one of the tested Rovo functions', () => {
  assert.ok(AGENT_ACTIONS.length >= 10, 'agent actions found');
  for (const a of AGENT_ACTIONS) assert.equal(typeof actions[handlerOf[fnOf[a]]], 'function', a);
  for (const h of ROVO) assert.equal(typeof actions[h], 'function', h);
});

test('default off: a fresh installation and an existing one without the setting both count as off', async () => {
  globalThis.__fakeKvs = new Map();
  assert.equal(settings.DEFAULTS.aiEnabled, false);
  assert.equal(await settings.aiEnabled(), false, 'nothing stored');
  globalThis.__fakeKvs.set('settings', { enabledProjects: ['PROJ'], approverAccountIds: ['u-admin'], updatedAt: 1 });
  assert.equal(await settings.aiEnabled(), false, 'saved before the switch existed');
  for (const v of ['true', 1, 'on', {}]) {
    globalThis.__fakeKvs.set('settings', { updatedAt: 1, aiEnabled: v });
    assert.equal(await settings.aiEnabled(), false, `only true switches it on, not ${JSON.stringify(v)}`);
  }
  globalThis.__fakeKvs.set('settings', { updatedAt: 1, aiEnabled: true });
  assert.equal(await settings.aiEnabled(), true);
});

test('off: every Rovo action refuses with the friendly text and touches nothing in Jira', async () => {
  globalThis.__fakeKvs = new Map([['settings', { enabledProjects: ['PROJ'], updatedAt: 1 }]]);
  jira();
  for (const h of ROVO) {
    rec.reset();
    const r = await actions[h](ROVO_PAYLOAD);
    assert.equal(r.aiDisabled, true, h);
    assert.equal(r.error, OFF, h);
    assert.equal(r.nothingChanged, true, h);
    assert.deepEqual(rec.calls.filter((c) => c.kind !== 'kvs' || c.op !== 'get'), [], `${h}: only the setting was read`);
  }
  assert.equal(settings.AI_OFF_MESSAGE, OFF);
});

test('on: the Rovo actions do their work again', async () => {
  globalThis.__fakeKvs = new Map([['settings', { enabledProjects: ['PROJ'], updatedAt: 1, aiEnabled: true }]]);
  jira();
  const g = await actions.guidelinesAction({});
  assert.equal(g.aiDisabled, undefined);
  assert.match(g.guidelines, /\S/, 'the guidelines come back');
  for (const h of ROVO) {
    rec.reset();
    const r = await actions[h](ROVO_PAYLOAD);
    assert.ok(r && typeof r === 'object', h);
    assert.notEqual(r.aiDisabled, true, h);
    assert.notEqual(r.error, OFF, h);
  }
});

test('a non-admin cannot switch the AI features on: the server asks Jira, the browser is not trusted', async () => {
  globalThis.__fakeKvs = new Map([['settings', { enabledProjects: ['PROJ'], updatedAt: 1 }]]);
  jira();
  for (const payload of [{ settings: { aiEnabled: true } }, { settings: { aiEnabled: true }, role: 'jira-admin', isAdmin: true }]) {
    const r = await callAdmin('save', payload, 'u-other');
    assert.equal(r.forbidden, true);
    assert.match(r.error, /Only Jira administrators/);
  }
  assert.equal(globalThis.__fakeKvs.get('settings').aiEnabled, undefined, 'nothing saved');
  assert.equal(await settings.aiEnabled(), false);
  assert.deepEqual(aiLog(), []);
  assert.equal((await actions.guidelinesAction({})).aiDisabled, true, 'the agent stays off');
});

test('a Jira administrator switches it on and off; each change is logged with who, when and on/off', async () => {
  globalThis.__fakeKvs = new Map([['settings', { enabledProjects: ['PROJ'], updatedAt: 1 }]]);
  jira();
  const t0 = Date.now();
  const on = await callAdmin('save', { settings: { aiEnabled: true } }, 'u-admin');
  assert.equal(on.error, undefined);
  assert.equal(on.aiEnabled, true);
  assert.equal(await settings.aiEnabled(), true);
  assert.notEqual((await actions.guidelinesAction({})).aiDisabled, true, 'the agent works');
  let log = aiLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].actor, 'u-admin');
  assert.equal(log[0].old, 'off');
  assert.equal(log[0].new, 'on');
  assert.equal(log[0].executed, true);
  assert.ok(log[0].ts >= t0);
  // Saving other settings keeps the switch as it is and logs nothing new.
  await callAdmin('save', { settings: { reminderHours: 12 } }, 'u-admin');
  assert.equal(await settings.aiEnabled(), true);
  assert.equal(aiLog().length, 1);
  await new Promise((r) => setTimeout(r, 5));
  const off = await callAdmin('save', { settings: { aiEnabled: false } }, 'u-admin');
  assert.equal(off.aiEnabled, false);
  log = aiLog();
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((l) => `${l.old}>${l.new}`).sort(), ['off>on', 'on>off']);
  assert.equal((await actions.guidelinesAction({})).aiDisabled, true, 'off again at once');
});

// ---------- SUPERPORT's AI stop (App Status, Forge variable AI_BUDGET) ----------

const budget = await import('../src/aibudget.js');
const STOPPED = 'AI features of this app are temporarily turned off by the app vendor. Please try again later.';
const setBudget = (v) => { if (v === undefined) delete process.env.AI_BUDGET; else process.env.AI_BUDGET = v; };

test('AI_BUDGET: only a JSON object with stop: true stops; unset, invalid or another shape is no stop and warns once', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const stop = (v) => budget.vendorAiStop(v === undefined ? {} : { AI_BUDGET: v }, warn);
  assert.equal(stop('{"stop":true}'), true);
  assert.equal(stop(' {"stop":true,"limit":5,"note":"x"} '), true, 'other fields are ignored');
  assert.equal(stop('{"stop":false}'), false);
  assert.equal(stop('{"stop":false,"limit":0}'), false);
  assert.deepEqual(warnings, [], 'valid values do not warn');
  assert.equal(stop(undefined), false, 'unset');
  assert.equal(stop(''), false, 'empty');
  // Warnings are remembered per value for the whole process (earlier tests already saw "unset"), so count new ones.
  const bad = ['true', '{stop:true}', '{"stop":"true"}', '{"stop":1}', '[true]', 'null', '{}', '{"Stop":true}'];
  const before = warnings.length;
  for (const v of bad) {
    assert.equal(stop(v), false, `no stop for ${JSON.stringify(v)}`);
    assert.equal(stop(v), false, `still no stop for ${JSON.stringify(v)}`);
  }
  assert.equal(warnings.length - before, bad.length, 'one warning per bad value, not one per call');
  assert.match(warnings.at(-1), /AI_BUDGET/);
  assert.equal(budget.vendorAiStop({ AI_BUDGET: '{"stop":true}' }), true);
  assert.equal(budget.AI_STOPPED_MESSAGE, STOPPED);
});

test('AI_BUDGET stop: every Rovo action refuses with the vendor text, even when a Jira administrator turned AI on', async () => {
  globalThis.__fakeKvs = new Map([['settings', { enabledProjects: ['PROJ'], updatedAt: 1, aiEnabled: true }]]);
  jira();
  setBudget('{"stop":true}');
  try {
    for (const h of ROVO) {
      rec.reset();
      const r = await actions[h](ROVO_PAYLOAD);
      assert.equal(r.error, STOPPED, h);
      assert.equal(r.aiStopped, true, h);
      assert.equal(r.aiDisabled, true, h);
      assert.equal(r.nothingChanged, true, h);
      assert.deepEqual(rec.calls, [], `${h}: nothing was read or changed`);
    }
    // The admin's own switch stays stored as it is.
    assert.equal(await settings.aiEnabled(), true);
    // Customer switch off and vendor stop: the vendor text, so nobody looks for a setting they cannot change.
    globalThis.__fakeKvs.set('settings', { enabledProjects: ['PROJ'], updatedAt: 1 });
    assert.equal((await actions.guidelinesAction({})).error, STOPPED);
  } finally {
    setBudget(undefined);
  }
});

test('AI_BUDGET {"stop":false}: the Rovo actions work when a Jira administrator turned AI on, and stay off when not', async () => {
  globalThis.__fakeKvs = new Map([['settings', { enabledProjects: ['PROJ'], updatedAt: 1, aiEnabled: true }]]);
  jira();
  setBudget('{"stop":false}');
  try {
    const g = await actions.guidelinesAction({});
    assert.equal(g.aiDisabled, undefined);
    assert.match(g.guidelines, /\S/);
    globalThis.__fakeKvs.set('settings', { enabledProjects: ['PROJ'], updatedAt: 1 });
    const off = await actions.guidelinesAction({});
    assert.equal(off.error, OFF, 'the customer text while only the customer switch is off');
    assert.equal(off.aiStopped, undefined);
  } finally {
    setBudget(undefined);
  }
});

test('the admin page is told about the stop next to the AI switch', () => {
  assert.match(src('src/admin.js'), /aiStopped: vendorAiStop\(\)/);
  assert.match(src('static/main/src/admin/Config.jsx'), /\{state\.aiStopped\s*\?/);
});

// ---------- What the pages are told: whoami.ai (every user of the page), the work item dialog, the hidden buttons ----------

const callPage = (name, accountId = 'u-admin', payload = {}) => index.handler(
  { call: { functionKey: name, payload }, context: { extension: { project: { key: 'PROJ' }, issue: { key: 'PROJ-1' } }, moduleKey: 'custom-field-self-service' } },
  { principal: { accountId } },
);
const withBudget = async (v, fn) => { setBudget(v); try { return await fn(); } finally { setBudget(undefined); } };

test('aiState: off by default, on only when saved on, off while the vendor stopped it, off on any error', async () => {
  globalThis.__fakeKvs = new Map();
  assert.deepEqual(await settings.aiState(), { enabled: false, stopped: false }, 'nothing stored');
  globalThis.__fakeKvs.set('settings', { enabledProjects: ['PROJ'], updatedAt: 1 });
  assert.deepEqual(await settings.aiState(), { enabled: false, stopped: false }, 'saved before the switch existed');
  globalThis.__fakeKvs.set('settings', { enabledProjects: ['PROJ'], updatedAt: 1, aiEnabled: 'true' });
  assert.deepEqual(await settings.aiState(), { enabled: false, stopped: false }, 'only true is on');
  globalThis.__fakeKvs.set('settings', { enabledProjects: ['PROJ'], updatedAt: 1, aiEnabled: true });
  assert.deepEqual(await settings.aiState(), { enabled: true, stopped: false });
  assert.deepEqual(await withBudget('{"stop":true}', () => settings.aiState()), { enabled: false, stopped: true }, 'vendor stop wins');
  assert.deepEqual(await withBudget('{"stop":false}', () => settings.aiState()), { enabled: true, stopped: false });
  // Storage fails: off, and no exception reaches the page.
  globalThis.__fakeKvs = { get: () => { throw new Error('KVS down'); }, set: () => {}, delete: () => {} };
  assert.deepEqual(await settings.aiState(), { enabled: false, stopped: false });
  assert.deepEqual(await withBudget('{"stop":true}', () => settings.aiState()), { enabled: false, stopped: true });
});

test('aiState is cheap: one storage read, nothing else', async () => {
  globalThis.__fakeKvs = new Map([['settings', { updatedAt: 1, aiEnabled: true }]]);
  rec.reset();
  await settings.aiState();
  assert.deepEqual(rec.calls.map((c) => `${c.kind}:${c.op}:${c.key}`), ['kvs:get:settings']);
});

test('whoami and boot tell the page whether AI is effectively on, read fresh on every call', async () => {
  globalThis.__fakeKvs = new Map([['settings', { enabledProjects: ['PROJ'], updatedAt: 1 }]]);
  jira();
  const off = await callPage('whoami');
  assert.equal(off.error, undefined, off.error);
  assert.deepEqual(off.ai, { enabled: false, stopped: false }, 'off by default');
  // Switched on by a Jira administrator: the very next call says so (no 30-second memo).
  await callAdmin('save', { settings: { aiEnabled: true } }, 'u-admin');
  assert.deepEqual((await callPage('whoami')).ai, { enabled: true, stopped: false }, 'on when saved');
  const boot = await callPage('boot');
  assert.deepEqual(boot.me.value.ai, { enabled: true, stopped: false }, 'boot carries it too');
  assert.deepEqual(await withBudget('{"stop":true}', async () => (await callPage('whoami')).ai), { enabled: false, stopped: true }, 'off while the vendor stopped it');
  await callAdmin('save', { settings: { aiEnabled: false } }, 'u-admin');
  assert.deepEqual((await callPage('whoami')).ai, { enabled: false, stopped: false }, 'off again at once');
});

test('the work item dialog is told too, for everyone who may open it', async () => {
  globalThis.__fakeKvs = new Map([['settings', { enabledProjects: ['PROJ'], updatedAt: 1 }]]);
  jira();
  const off = await callPage('issueContext');
  assert.equal(off.error, undefined, off.error);
  assert.deepEqual(off.ai, { enabled: false, stopped: false });
  globalThis.__fakeKvs.set('settings', { enabledProjects: ['PROJ'], updatedAt: 1, aiEnabled: true });
  assert.deepEqual((await callPage('issueContext', 'u-other')).ai, { enabled: true, stopped: false });
  const dialog = src('src/frontend/issue.jsx');
  assert.match(dialog, /if \(state\.ai\?\.enabled !== true\) \{/, 'no Field Assistant button unless on');
  assert.match(dialog, /Configuration/, 'says where a Jira administrator turns it on');
});

// The pages: every AI entry point is rendered only while AI is on (useAiOn), askAssistant itself does nothing while
// off, the tour's Field Assistant step is left out, and the browser cache never keeps an "on".
const UI = 'static/main/src';
const uiFiles = (dir) => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? uiFiles(`${dir}/${d.name}`) : /\.jsx?$/.test(d.name) ? [`${dir}/${d.name}`] : []));

test('UI: every AI button and every askAssistant call is behind the AI state', () => {
  let buttons = 0;
  for (const f of uiFiles(UI)) {
    src(f).split(/\r?\n/).forEach((line, i) => {
      if (/rovo\.open\(/.test(line)) assert.equal(f, `${UI}/ui.jsx`, `${f}:${i + 1}: Rovo is opened only through askAssistant`);
      // (The tour's step points at [data-tour="assistant"]: checked on its own below.)
      if (!/askAssistant\(|className="btn ai|(?<!\[)data-tour="assistant"/.test(line) || /export const askAssistant/.test(line)) return;
      buttons += 1;
      assert.match(line, /\{(?:[\w.]+ && )*aiOn(?: && [\w.]+)* \?/, `${f}:${i + 1}: AI entry point not hidden while AI is off`);
    });
  }
  // Header, new field, options editor, and three on the field health tab.
  assert.ok(buttons >= 6, `all AI entry points found (${buttons})`);
  const ui = src(`${UI}/ui.jsx`);
  assert.match(ui, /export const askAssistant = \(prompt\) => \(aiOn\r?\n?\s*\?/, 'askAssistant does nothing while off');
  assert.match(ui, /let aiOn = false;/, 'off until the server says otherwise');
  assert.match(ui, /ai\.enabled === true/, 'only enabled: true counts');
  const app = src(`${UI}/App.jsx`);
  assert.match(app, /setAi\(me\?\.ai\)/, 'the page follows whoami');
  assert.match(app, /call\('whoami'\)/, 'and asks again when shown again');
  assert.match(app, /me: \{ \.\.\.me, ai: undefined \}/, 'the cache never keeps the AI state');
  assert.match(app, /<Tour [^>]*ai=\{aiOn\}/);
  assert.match(src(`${UI}/Tour.jsx`), /\.\.\.\(ai \? \[\{\s*target: '\[data-tour="assistant"\]'/, 'tour step only while on');
});

test('Configuration: the switch with one line on what it means, in English and German; the vendor notice replaces it', () => {
  const cfg = src(`${UI}/admin/Config.jsx`);
  const de = src(`${UI}/i18n.de.js`);
  const OFF_EN = 'AI features are off. The Field Assistant (Rovo) and all AI buttons are hidden.';
  assert.ok(cfg.includes(`t('${OFF_EN}')`));
  assert.ok(de.includes(`'${OFF_EN}': 'KI-Funktionen sind aus. Der Field Assistant (Rovo) und alle KI-Schaltflächen sind ausgeblendet.'`));
  assert.match(cfg, /\{state\.aiStopped\s*\?\s*<Msg tone="warning">\{t\('Temporarily turned off by the app vendor/, 'vendor notice instead of the line');
  assert.match(cfg, /<Check checked=\{s\.aiEnabled === true\}/, 'the switch shows the saved setting, also while stopped');
});
