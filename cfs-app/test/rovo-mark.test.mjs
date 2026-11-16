/**
 * EULA 8.4: changes made through the Field Assistant (Rovo) are marked in the audit log. Log entries and approval
 * requests written inside a Rovo action carry agent: 'Rovo (Field Assistant)'; the same writes from the app's own
 * pages do not, also when both run at the same time.
 *
 * @file        test/rovo-mark.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-13
 * @updated     2026-11-13
 */

// Run: node --test test/rovo-mark.test.mjs
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./support/forge-loader.mjs', import.meta.url);
const { writeLog, savePending, viaRovo, ROVO_AGENT } = await import('../src/audit.js');

afterEach(() => { delete globalThis.__fakeKvs; });
const logs = () => [...globalThis.__fakeKvs].filter(([k]) => k.startsWith('log:')).map(([, v]) => v);

test('log entries written inside a Rovo action are marked, others are not', async () => {
  globalThis.__fakeKvs = new Map();
  await viaRovo(async () => writeLog('ABC', [{ action: 'Add', option: 'Blue', via: 'Field Assistant' }]))();
  await writeLog('XYZ', [{ action: 'Add', option: 'Red', via: 'direct' }]);
  const byKey = Object.fromEntries(logs().map((l) => [l.projectKey, l]));
  assert.equal(byKey.ABC.agent, ROVO_AGENT);
  assert.equal(byKey.ABC.via, 'Field Assistant');
  assert.equal(byKey.XYZ.agent, undefined);
});

test('the mark follows the call through awaits and does not leak into a parallel call', async () => {
  globalThis.__fakeKvs = new Map();
  const tick = () => new Promise((r) => setTimeout(r, 5));
  await Promise.all([
    viaRovo(async () => { await tick(); await writeLog('ROVO', [{ action: 'Rename' }]); })(),
    (async () => { await tick(); await writeLog('PAGE', [{ action: 'Rename' }]); })(),
  ]);
  const byKey = Object.fromEntries(logs().map((l) => [l.projectKey, l]));
  assert.equal(byKey.ROVO.agent, ROVO_AGENT);
  assert.equal(byKey.PAGE.agent, undefined);
});

test('an approval request created through Rovo keeps the mark', async () => {
  globalThis.__fakeKvs = new Map();
  await viaRovo(() => savePending('CFS-1', { projectKey: 'ABC', created: 1, status: 'pending', summary: 's' }))();
  await savePending('CFS-2', { projectKey: 'ABC', created: 2, status: 'pending', summary: 's' });
  assert.equal(globalThis.__fakeKvs.get('pending:CFS-1').agent, ROVO_AGENT);
  assert.equal(globalThis.__fakeKvs.get('pending:CFS-2').agent, undefined);
});
