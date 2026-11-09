/**
 * Unit tests for personal data reporting: which account IDs the app keeps, how closed accounts are erased, and the
 * report batches of at most 90 accounts.
 *
 * @file        test/personal.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-06
 * @updated     2026-11-06
 */

// Run: node --test test/personal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountsIn, accountOfKey, erase, reportBatches, writtenAt, CLOSED } from '../src/shared/personal.js';

const A = '557058:2f6c1b3a-1111-4c2d-9e8f-0123456789ab';
const B = '712020:9a8b7c6d-2222-4e5f-8a9b-abcdefabcdef';
const OLD = '5b10a2844c20165700ede21g';

test('finds account IDs in log entries, requests, settings and per-person keys', () => {
  const found = accountsIn({ actor: A, approver: B, via: 'direct', rows: [{ action: 'Add' }], appDecision: { by: OLD } });
  assert.deepEqual([...found].sort(), [A, B, OLD].sort());
  assert.deepEqual([...accountsIn({ approverAccountIds: [A, 'not-an-id'], backupApproverAccountIds: [B] })].sort(), [A, B].sort());
  assert.equal(accountsIn({ fieldName: A, summary: B }).size, 0, 'only fields that name people count');
  assert.equal(accountOfKey(`draft:${A}`), A);
  assert.equal(accountOfKey(`uidraft:${A}:FSST`), A);
  assert.equal(accountOfKey(`visit:${OLD}:FSST`), OLD);
  assert.equal(accountOfKey('log:FSST:123'), null);
});

test('erasing a closed account keeps the record and removes only that person', () => {
  const entry = { ts: 5, actor: A, approver: B, approverIds: [A, B], rows: [{ action: 'Add', option: A }] };
  const r = erase(entry, new Set([A]));
  assert.ok(r.changed);
  assert.equal(r.value.actor, CLOSED);
  assert.equal(r.value.approver, B);
  assert.deepEqual(r.value.approverIds, [B]);
  assert.equal(r.value.rows[0].option, A, 'option text is not a person');
  assert.equal(entry.actor, A, 'the input is not modified');
  assert.equal(erase(entry, new Set([OLD])).changed, false);
});

test('reports in batches of at most 90 with the latest write time', () => {
  const seen = new Map(Array.from({ length: 200 }, (_, i) => [`${100000 + i}:2f6c1b3a-1111-4c2d-9e8f-0123456789ab`, 1700000000000]));
  const b = reportBatches(seen);
  assert.deepEqual(b.map((x) => x.length), [90, 90, 20]);
  assert.equal(b[0][0].updatedAt, new Date(1700000000000).toISOString());
  assert.equal(writtenAt({ ts: 3, decided: 9 }), 9);
  assert.equal(writtenAt({}), null);
});
