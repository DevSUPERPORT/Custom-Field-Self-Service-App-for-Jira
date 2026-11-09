/**
 * Unit tests for the approval space logic: engine choice, suggestions, the configuration check and its wording.
 *
 * @file        test/approvalspace.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelection, suggestSelection, checkSetup, describeSetup, worst } from '../src/shared/approvalspace.js';

const STEP = { statusName: 'Waiting for Approval', fieldId: 'customfield_10003', fieldName: 'Approvers', conditionType: 'number', conditionValue: '1', exclude: ['reporter', 'assignee'] };
const JSM = {
  project: { key: 'CFS', name: 'Custom Field Self-Service (Test)', isJsm: true, type: 'service_desk' },
  workTypes: [
    { id: '10040', name: 'Task', workflow: 'default', approval: null },
    { id: '10049', name: 'Service Request with Approvals', workflow: 'approvals', approval: STEP },
  ],
  requestTypes: [
    { id: '7', name: 'Custom field change', issueTypeId: '10049', workTypeName: 'Service Request with Approvals', hidden: true, groups: [] },
    { id: '8', name: 'Get IT help', issueTypeId: '10040', workTypeName: 'Task', hidden: false, groups: ['General'] },
  ],
};
const BIZ = { project: { key: 'OPS', name: 'Operations', isJsm: false, type: 'business', typeLabel: 'Jira Work Management' }, workTypes: [{ id: '1', name: 'Task', workflow: 'simple', approval: null }], requestTypes: [] };

test('a request type on a work type with an approval step = full JSM engine, and it sets the work type', () => {
  const r = resolveSelection(JSM, { issueTypeId: '10040', requestTypeId: '7' });
  assert.equal(r.engine, 'jsm-request');
  assert.equal(r.workType.id, '10049', 'the request type decides the work type');
});

test('approval step without request type = decide in the work item; no step = the app approves', () => {
  assert.equal(resolveSelection(JSM, { issueTypeId: '10049' }).engine, 'jsm-workitem');
  assert.equal(resolveSelection(JSM, { issueTypeId: '10040' }).engine, 'app');
  assert.equal(resolveSelection(BIZ, { issueTypeId: '1' }).engine, 'app');
});

test('suggestions prefer the named request type, then a work type with an approval step', () => {
  assert.deepEqual(suggestSelection(JSM), { issueTypeId: '10049', requestTypeId: '7' });
  assert.deepEqual(suggestSelection({ ...JSM, requestTypes: [] }), { issueTypeId: '10049', requestTypeId: '' });
  assert.deepEqual(suggestSelection(BIZ), { issueTypeId: '1', requestTypeId: '' });
});

test('the check passes a complete JSM setup and explains the approval step', () => {
  const c = checkSetup(JSM, { requestTypeId: '7' }, { canCreate: true, requiredFields: [], approverCount: 2, appApproversField: 'customfield_10003' });
  assert.equal(worst(c.checks), 'ok');
  const step = c.checks.find((x) => x.label === 'Approval step');
  assert.match(step.detail, /1 approval\(s\) from "Approvers" at "Waiting for Approval"; reporter and assignee excluded/);
  assert.match(c.checks.find((x) => x.label === 'Request type').detail, /hidden from the portal/);
});

test('the check flags what would break requests', () => {
  const c = checkSetup(JSM, { requestTypeId: '7' }, { canCreate: false, requiredFields: ['Cost centre'], approverCount: 0, approversWithoutAccess: ['Pat'] });
  const fails = c.checks.filter((x) => x.level === 'fail').map((x) => x.label);
  assert.deepEqual(fails, ['App may create work items', 'Request type fields', 'Approver access', 'Approvers']);
  assert.equal(worst(checkSetup(JSM, { issueTypeId: '999' }).checks), 'fail', 'a work type that left the scheme');
  assert.equal(worst(checkSetup({ project: null }, {}).checks), 'fail');
});

test('a business project needs no request type and is described as an app approval', () => {
  const c = checkSetup(BIZ, { issueTypeId: '1' }, { canCreate: true, approverCount: 1 });
  assert.equal(c.engine, 'app');
  assert.ok(c.checks.some((x) => x.label === 'Request type' && x.level === 'ok'));
  assert.match(describeSetup(BIZ, { issueTypeId: '1' }).text, /the app runs the approval itself/);
});

test('the summary names work type, request type and where approvers decide', () => {
  const t = describeSetup(JSM, { requestTypeId: '7' }).text;
  assert.match(t, /"Service Request with Approvals" work items with the request type "Custom field change" \(hidden from the portal\) in CFS/);
  assert.match(t, /right here in the app/);
});
