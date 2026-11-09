/**
 * Guard test for permissions: every project page resolver has a deliberate role (availability answers any signed-in
 * user), and the services, approvals and Rovo actions check Jira administrator rights themselves.
 *
 * @file        test/roles.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Run: node --test test/roles.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// Project admins read, request and decide their stage-1 requests; Jira administrators change things directly.
const EXPECTED = {
  'project-admin': ['overview', 'options', 'usage', 'optionsOf', 'applyOptions', 'reuse', 'newFieldMeta', 'screens', 'tour', 'tourSeen',
    'checkField', 'requestField', 'audit', 'health', 'inbox', 'prepareDecide', 'decide', 'whatsNew', 'getDraft', 'saveDraft', 'radar',
    'bundle', 'guardState', 'whoami', 'boot', 'fieldDetails', 'myRequests', 'withdraw', 'projectIssueTypes', 'todoAddScreens', 'todoDismiss',
    // Undo and bulk changes: project admins too, for their own space only. The services check again (tests below).
    'undo', 'latestChanges', 'bulkScan', 'bulkStart', 'bulkRun', 'bulkUndo', 'bulkGet', 'bulkCatalog', 'bulkHistory'],
  'jira-admin': ['convertText',
    'adminFieldUpdate', 'adminFieldScreens', 'adminFieldProjects', 'adminProjects', 'healthAddScreens', 'healthTakeOut', 'driftCheckNow'],
  none: ['issueContext'],
  custom: ['enableHere'],
  // SUPERPORT's kill switch: any signed-in user learns the mode and the status page, nothing else (maintenance.test.mjs).
  'signed-in': ['availability'],
};

const resolvers = () => {
  const code = src('src/index.js');
  const parts = code.split("resolver.define('").slice(1);
  return parts.map((p) => {
    const name = p.slice(0, p.indexOf("'"));
    const body = p;
    if (body.startsWith("availability', availability);")) return { name, role: 'signed-in', body };
    if (!/^[^\n]*handle\(/.test(body.split('\n')[0]) && !body.startsWith(`${name}', handle(`)) return { name, role: 'custom', body };
    const m = body.match(/\{ role: '([a-z-]+)' \}\)\);/);
    return { name, role: m ? m[1] : 'project-admin', body };
  });
};

test('every page resolver has a deliberate role', () => {
  const found = resolvers();
  const expected = Object.fromEntries(Object.entries(EXPECTED).flatMap(([role, names]) => names.map((n) => [n, role])));
  const unknown = found.filter((r) => !expected[r.name]).map((r) => r.name);
  assert.deepEqual(unknown, [], 'new resolvers need an entry in EXPECTED (decide who may call them)');
  const wrong = found.filter((r) => expected[r.name] !== r.role).map((r) => `${r.name}: ${r.role} (expected ${expected[r.name]})`);
  assert.deepEqual(wrong, []);
});

test('custom-guarded resolvers check Jira administrator rights themselves', () => {
  resolvers().filter((r) => r.role === 'custom').forEach((r) => assert.match(r.body.split('resolver.define(')[0], /ADMINISTER/, r.name));
});

test('the services refuse direct changes by anyone but Jira administrators', () => {
  const service = src('src/service.js');
  ['applyOptionChanges', 'reuseField', 'requestNewField', 'runBundle'].forEach((fn) => {
    const body = service.slice(service.indexOf(`export const ${fn} =`), service.indexOf('\nexport const', service.indexOf(`export const ${fn} =`) + 10));
    assert.match(body, /J\.actsAsAdmin\(accountId, approvedBy\)/, `${fn} must check the acting person (or the approver)`);
  });
  const bulk = src('src/bulk.js');
  assert.match(bulk.slice(bulk.indexOf('export const start ='), bulk.indexOf('export const approved')), /isJiraAdmin\(accountId\)/);
  assert.match(bulk.slice(bulk.indexOf('export const undo ='), bulk.indexOf('// ---------- the project')), /isJiraAdmin\(accountId\)/);
});

test('project admins: bulk changes stay inside their own space, undo is checked on the server', () => {
  const bulk = src('src/bulk.js');
  const start = bulk.slice(bulk.indexOf('export const start ='), bulk.indexOf('export const approved'));
  assert.match(start, /assertProjectAdmin\(projectKey, accountId\)/);
  assert.match(start, /chosen\.filter\(\(i\) => !ownItem\(i, projectKey\)\)/, 'every chosen field re-checked at start');
  assert.match(start, /if \(settings\.projectAdminOptionEdits !== 'direct'\) reasons\.push\(BY_JIRA_ADMIN\)/);
  assert.match(bulk.slice(bulk.indexOf('export const scan ='), bulk.indexOf('// ---------- start')), /role === 'jira-admin' \|\| ownField\(f, projectKey\)/);
  assert.match(bulk.slice(bulk.indexOf('export const catalog ='), bulk.indexOf('// ---------- reading')), /role === 'jira-admin' \|\| ownField\(f, projectKey\)/);
  const undo = bulk.slice(bulk.indexOf('export const undo ='), bulk.indexOf('const startUndo'));
  assert.match(undo, /m\.accountId !== accountId/, 'only the requester (or a Jira administrator) undoes a bulk change');
  const index = src('src/index.js');
  const u = index.slice(index.indexOf("resolver.define('undo'"), index.indexOf("resolver.define('latestChanges'"));
  assert.match(u, /if \(!may\(key\)\) throw new J\.Forbidden/);
  assert.match(u, /st === 'superseded'/, 'an older change is never undone over a later one');
  assert.match(index.slice(index.indexOf('const undoInfo'), index.indexOf('const undoNeedsApproval')), /if \(key\.startsWith\('op:'\)\) return false|return false;/);
});

test('final approvals need a Jira administrator at decision time', () => {
  const a = src('src/approvals.js');
  assert.match(a.slice(a.indexOf('export const verifyApprover'), a.indexOf('// Approve or decline from the app')), /isJiraAdmin\(approver\)/);
});

test('Rovo actions get the role from Jira and bulk needs at least a project admin', () => {
  const actions = src('src/actions.js');
  assert.match(actions, /const role = await J\.roleOf\(projectKey, accountId\)/);
  const planner = src('src/planner.js');
  assert.match(planner.slice(planner.indexOf('export const previewBulk'), planner.indexOf('export const previewBulk') + 300), /role === 'none'/);
  assert.match(planner.slice(planner.indexOf('export const previewBulk'), planner.indexOf('export const bulkStatus')), /B\.scan\(\{[^}]*role \}\)/);
  assert.match(planner.slice(planner.indexOf('export const undoBulk'), planner.indexOf('export const undoBulk') + 300), /role === 'none'/);
});

test('hardening from the security review stays in place', () => {
  const jira = src('src/jira.js');
  const isPA = jira.slice(jira.indexOf('export const isProjectAdmin'), jira.indexOf('export const assertProjectAdmin'));
  assert.doesNotMatch(isPA, /projectAdmins\(/, 'project admin = Jira permission only, never role membership');
  assert.doesNotMatch(jira.slice(jira.indexOf('export const visibleFilters'), jira.indexOf('export const visibleFilters') + 900), /who = app/, "no fallback to the app's view of filters");
  assert.match(jira.slice(jira.indexOf('export const actsAsAdmin'), jira.indexOf('export const actsAsAdmin') + 500), /approverAccountIds/, 'a stage-1 approver acts as admin only when a configured approver');
  const a = src('src/approvals.js');
  assert.match(a.slice(a.indexOf('export const verifyApprover'), a.indexOf('// Approve or decline from the app')), /approver === p\.approvedBy/, 'two-person: stage-1 approver can not give the final approval');
  const decision = a.slice(a.indexOf('const decisionFor'), a.indexOf('const nameOf'));
  assert.doesNotMatch(decision, /APPROVED_STATUS\) return \{ decision: 'approved'/, 'approval is never inferred from a status');
  assert.match(a, /claim !== claim\) return 'running elsewhere'/);
  const ops = src('src/ops.js');
  assert.match(ops, /publishGlobal\(`cfs-\$\{k\}`, \{ type: event\.type, at: Date\.now\(\) \}\)/, 'live events carry no identifiers');
  const index = src('src/index.js');
  assert.match(index, /draft: cleanDraft\(payload\.draft\)/, "requests take only the form's draft fields");
  assert.doesNotMatch(index.slice(index.indexOf('const DRAFT_KEYS'), index.indexOf('const cleanDraft')), /migrateFrom/);
});

test('project admins change options directly only on their own space, when the admin page allows it', () => {
  const service = src('src/service.js');
  const apply = service.slice(service.indexOf('export const applyOptionChanges'), service.indexOf('export const undoBatch'));
  assert.match(apply, /settings\.projectAdminOptionEdits === 'direct' && ownsContext\(field, projectKey\)\s*&& \(await J\.isProjectAdmin\(projectKey, accountId\)\)/);
  assert.match(apply, /!admin && !approvedBy/, 'never for approved requests or admins');
  assert.match(service, /export const ownsContext = \(field, projectKey\) => field\.scope === 'project' && field\.sharedWith\.length === 1 && field\.sharedWith\[0\]\.key === projectKey;/);
  const route = service.slice(service.indexOf('export const routeOptions'), service.indexOf('export const applyOptionChanges'));
  assert.match(route, /if \(!admin && !projectDirect\) return \{ route: 'approval'/);
  assert.match(route, /guardDecision\(/, 'guard rails apply to direct changes');
});

test('new fields: own space always, other spaces only when visible, limit enforced', () => {
  const service = src('src/service.js');
  const req = service.slice(service.indexOf('export const requestNewField'), service.indexOf('// ---------- onboarding bundle'));
  assert.match(req, /J\.browsable\(accountId, others\)/);
  assert.match(req, /keys\.length > settings\.maxContextProjects/);
  assert.match(req, /filter\(\(s\) => s\.exclusive\)/, 'only screens the own space uses alone');
});

test("withdraw is for the requester only, rejections carry the approver's reason", () => {
  const a = src('src/approvals.js');
  const w = a.slice(a.indexOf('export const withdrawRequest'), a.indexOf('export const processRequest'));
  assert.match(w, /p\.requester !== accountId/);
  assert.match(w, /p\.status !== 'pending'/);
  assert.match(a, /const why = mayExplain\(p, approver, s\)/);
  const index = src('src/index.js');
  assert.match(index, /Give a reason for the rejection/);
});
