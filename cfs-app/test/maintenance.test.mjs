/**
 * Tests SUPERPORT's kill switch against the real backend loaded with recording doubles of the Forge modules: with
 * "on" every resolver, Rovo action and trigger in the manifest is refused with nothing read or written, with
 * "readonly" only the listed reads answer, and nothing a caller sends can switch it off.
 *
 * @file        test/maintenance.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Run: node --test test/maintenance.test.mjs
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./support/forge-loader.mjs', import.meta.url);
const rec = await import('./support/fake-forge/record.mjs');
const M = await import('../src/maintenance.js');
const index = await import('../src/index.js');
const actions = await import('../src/actions.js');

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const definedIn = (p) => [...src(p).matchAll(/resolver\.define\('([A-Za-z]+)'/g)].map((m) => m[1]);
const PAGE = definedIn('src/index.js');
const ADMIN = definedIn('src/admin.js');

// The resolvers that may still answer while changes are paused. Everything else must be refused: adding a name to
// READS in the code without adding it here fails this test, and so does a new resolver that isn't refused.
const PAGE_READS = ['boot', 'overview', 'options', 'usage', 'optionsOf', 'latestChanges', 'fieldDetails', 'adminProjects', 'whoami',
  'myRequests', 'projectIssueTypes', 'newFieldMeta', 'screens', 'tour', 'checkField', 'audit', 'health', 'issueContext',
  'inbox', 'bulkGet', 'bulkCatalog', 'bulkHistory', 'whatsNew', 'getDraft', 'radar', 'guardState'];
const ADMIN_READS = ['state', 'approvalSpace', 'previewAlert', 'previewDigest', 'siteCheck', 'auditAll', 'tour'];
const ROVO_READS = ['listFields', 'fieldOptions', 'findSimilarFields', 'fieldHealthAction', 'guidelinesAction', 'myRequestsAction',
  'requestDetailsAction', 'bulkStatusAction', 'siteReadinessAction'];

// Every function the manifest points at, by handler name in src/index.js.
const MANIFEST = [...src('manifest.yml').matchAll(/handler: index\.(\w+)/g)].map((m) => m[1]);
const RESOLVER_HANDLERS = ['handler', 'adminHandler'];
const TRIGGERS = ['prewarm', 'selftest', 'nightly', 'weekly', 'onIssueUpdated', 'sweep', 'privacyReport'];
const ROVO = MANIFEST.filter((h) => !RESOLVER_HANDLERS.includes(h) && !TRIGGERS.includes(h));

const set = (v) => { if (v === undefined) delete process.env.APP_MAINTENANCE; else process.env.APP_MAINTENANCE = v; };
afterEach(() => { set(undefined); rec.reset(); });

const HOSTILE = { APP_MAINTENANCE: 'off', maintenance: 'off', mode: 'off', env: { APP_MAINTENANCE: 'off' }, asRole: 'jira-admin' };
const PAYLOAD = { fieldId: 'customfield_10001', issueKey: 'CFS-1', jobId: 'B1', batchId: '1-1', decision: 'approve', reason: 'test', draft: { name: 'X' }, settings: {}, fixIds: ['all'] };
const callResolver = (handler, name, { payload = PAYLOAD, accountId = 'u-admin', context = {} } = {}) => handler(
  { call: { functionKey: name, payload }, context: { extension: { project: { key: 'PROJ' }, issue: { key: 'PROJ-1' } }, moduleKey: 'custom-field-self-service', ...context } },
  { principal: accountId ? { accountId } : {} },
);
const ROVO_PAYLOAD = { projectKey: 'PROJ', field: 'Region', name: 'Region', planId: 'P-ABC123', issueKey: 'CFS-1', fixIds: 'all', jobId: 'B1', value: 'A', op: 'retire' };

test('reading the switch: known values, and anything unknown fails closed to "on"', () => {
  assert.equal(M.maintenanceMode({}), 'off');
  assert.equal(M.maintenanceMode({ APP_MAINTENANCE: '' }), 'off');
  assert.equal(M.maintenanceMode({ APP_MAINTENANCE: ' OFF ' }), 'off');
  assert.equal(M.maintenanceMode({ APP_MAINTENANCE: 'readonly' }), 'readonly');
  assert.equal(M.maintenanceMode({ APP_MAINTENANCE: ' Read-Only ' }), 'readonly');
  assert.equal(M.maintenanceMode({ APP_MAINTENANCE: 'on' }), 'on');
  for (const v of ['of', 'false', '0', 'no', 'disabled', 'maintenance', 'true']) assert.equal(M.maintenanceMode({ APP_MAINTENANCE: v }), 'on', v);
  assert.equal(M.STATUS_PAGE_URL, 'https://superapps.statuspage.io');
});

test('the refusals say what the pages say: paused for maintenance, data safe, with the status page link', () => {
  assert.match(M.UNAVAILABLE_MESSAGE, /^Custom Field Self-Service for Jira is temporarily unavailable\. We've paused Custom Field Self-Service for Jira for maintenance to keep your data safe\. Nothing you've saved is lost/);
  assert.match(M.READONLY_MESSAGE, /^Changes are paused for maintenance to keep your data safe\. You can still view everything; editing will be back as soon as possible\./);
  for (const m of [M.UNAVAILABLE_MESSAGE, M.READONLY_MESSAGE]) assert.ok(m.endsWith('https://superapps.statuspage.io'), m);
});

test('the manifest and the code agree: every function is covered by these tests', () => {
  assert.ok(PAGE.length > 40 && ADMIN.length > 20, 'resolvers found');
  for (const h of MANIFEST) assert.equal(typeof index[h], 'function', `index.${h} is exported`);
  assert.deepEqual(ROVO.filter((h) => typeof actions[h] !== 'function'), [], 'every other manifest function is a Rovo action');
  assert.ok(PAGE.includes('availability') && ADMIN.includes('availability'));
  for (const r of PAGE_READS) assert.ok(PAGE.includes(r), `page read ${r} exists`);
  for (const r of ADMIN_READS) assert.ok(ADMIN.includes(r), `admin read ${r} exists`);
  // the ops panel finds the switch with exactly this check: grep -r APP_MAINTENANCE src
  assert.match(src('src/maintenance.js'), /APP_MAINTENANCE/);
});

test('APP_MAINTENANCE=on: every resolver refuses every caller, with nothing read or written', async () => {
  set('on');
  for (const [handler, names] of [[index.handler, PAGE], [index.adminHandler, ADMIN]]) {
    for (const name of names.filter((n) => n !== 'availability')) {
      for (const accountId of ['u-admin', 'u-other']) {
        rec.reset();
        const r = await callResolver(handler, name, { accountId });
        assert.equal(r.unavailable, true, name);
        assert.equal(r.mode, 'on', name);
        assert.match(r.error, /temporarily unavailable/, name);
        assert.deepEqual(rec.calls, [], `${name}: no Jira, storage or realtime call`);
      }
    }
  }
});

test('APP_MAINTENANCE=on: nothing a caller sends switches it off or gets around it', async () => {
  set('on');
  for (const [handler, names] of [[index.handler, PAGE], [index.adminHandler, ADMIN]]) {
    for (const name of names.filter((n) => n !== 'availability')) {
      const r = await callResolver(handler, name, { payload: { ...PAYLOAD, ...HOSTILE }, context: { environment: { APP_MAINTENANCE: 'off' }, APP_MAINTENANCE: 'off' } });
      assert.equal(r.unavailable, true, name);
    }
  }
  for (const h of ROVO) assert.equal((await actions[h]({ ...ROVO_PAYLOAD, ...HOSTILE })).unavailable, true, h);
  assert.equal(process.env.APP_MAINTENANCE, 'on');
  assert.deepEqual(rec.calls, []);
});

test('APP_MAINTENANCE=on: availability tells signed-in callers, and nobody else', async () => {
  set('on');
  for (const handler of [index.handler, index.adminHandler]) {
    assert.deepEqual(await callResolver(handler, 'availability'), { mode: 'on', statusUrl: 'https://superapps.statuspage.io' });
    const anon = await callResolver(handler, 'availability', { accountId: null });
    assert.equal(anon.forbidden, true);
    assert.equal(anon.mode, undefined);
  }
  assert.deepEqual(rec.calls, []);
});

test('APP_MAINTENANCE=on: Rovo actions and every trigger stop before touching anything', async () => {
  set('on');
  for (const h of ROVO) {
    const r = await actions[h](ROVO_PAYLOAD);
    assert.equal(r.unavailable, true, h);
    assert.match(r.error, /temporarily unavailable/, h);
  }
  for (const h of TRIGGERS) await index[h]({ issue: { key: 'CFS-1' }, changelog: { items: [{ field: 'status' }] }, atlassianId: 'u-admin' });
  assert.deepEqual(rec.calls, [], 'no Jira, storage or realtime call');
});

test('APP_MAINTENANCE=readonly: reads answer, every other resolver is refused with nothing written', async () => {
  set('readonly');
  for (const [handler, names, reads] of [[index.handler, PAGE, PAGE_READS], [index.adminHandler, ADMIN, ADMIN_READS]]) {
    for (const name of names.filter((n) => n !== 'availability')) {
      rec.reset();
      const r = await callResolver(handler, name);
      if (reads.includes(name)) {
        assert.notEqual(r?.unavailable, true, `${name} is a read`);
        assert.deepEqual(rec.jiraWrites(), [], `${name}: no Jira writes`);
      } else {
        assert.equal(r.unavailable, true, `${name} is refused`);
        assert.match(r.error, /Changes are paused/, name);
        assert.deepEqual(rec.calls, [], `${name}: nothing read or written`);
      }
    }
  }
  assert.deepEqual(await callResolver(index.handler, 'availability'), { mode: 'readonly', statusUrl: 'https://superapps.statuspage.io' });
});

test('APP_MAINTENANCE=readonly: Field Assistant answers but changes nothing', async () => {
  set('readonly');
  for (const h of ROVO) {
    rec.reset();
    const r = await actions[h](ROVO_PAYLOAD);
    if (ROVO_READS.includes(h)) assert.notEqual(r?.unavailable, true, `${h} is a read`);
    else {
      assert.equal(r.unavailable, true, `${h} is refused`);
      assert.deepEqual(rec.calls, [], h);
    }
    assert.deepEqual(rec.jiraWrites(), [], h);
  }
});

test('APP_MAINTENANCE=readonly: triggers that change Jira wait; housekeeping writes nothing to Jira', async () => {
  set('readonly');
  for (const h of ['sweep', 'onIssueUpdated', 'selftest', 'weekly', 'privacyReport']) {
    rec.reset();
    await index[h]({ issue: { key: 'CFS-1' }, changelog: { items: [{ field: 'status' }] }, atlassianId: 'u-admin' });
    assert.deepEqual(rec.calls, [], h);
  }
  rec.reset();
  const out = await index.nightly();
  assert.match(out.paused, /paused/);
  assert.deepEqual(rec.calls.filter((c) => c.kind !== 'kvs'), [], 'nightly: no Jira call, no live event');
  rec.reset();
  await index.prewarm();
  assert.deepEqual(rec.jiraWrites(), [], 'prewarm only reads');
  // sending the digest preview is a write even though showing it is a read
  const admin = src('src/admin.js');
  assert.match(admin.slice(admin.indexOf("resolver.define('previewDigest'"), admin.indexOf("resolver.define('siteCheck'")), /if \(payload\.send\) \{\s*\/\/[^\n]*\n\s*const refused = refusal\('write'\);\s*if \(refused\) return refused;/);
});

test('APP_MAINTENANCE=off (or unset): the gate lets calls through', async () => {
  for (const v of [undefined, 'off']) {
    set(v);
    rec.reset();
    const r = await callResolver(index.handler, 'overview');
    assert.notEqual(r?.unavailable, true);
    assert.ok(rec.calls.length > 0, 'the resolver ran');
    assert.deepEqual(await callResolver(index.handler, 'availability'), { mode: 'off', statusUrl: 'https://superapps.statuspage.io' });
    const w = await callResolver(index.handler, 'applyOptions');
    assert.notEqual(w?.unavailable, true);
  }
});

test('helpers: writes are the default, and only "read" is a read', () => {
  set('readonly');
  assert.doesNotThrow(() => M.requireAvailable('read'));
  for (const kind of ['write', undefined, 'READ', '']) assert.throws(() => M.requireAvailable(kind), /Changes are paused/);
  assert.equal(M.mayRun('read'), true);
  assert.equal(M.mayRun('write'), false);
  set('on');
  assert.throws(() => M.requireAvailable('read'), (e) => e.code === 'unavailable' && e.mode === 'on');
  assert.equal(M.mayRun('read'), false);
  set('off');
  assert.equal(M.refusal('write'), null);
  assert.equal(M.mayRun('write'), true);
});
