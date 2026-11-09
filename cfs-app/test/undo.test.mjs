/**
 * Unit tests for the undo states of audit-log entries: available, undone, pending and superseded.
 *
 * @file        test/undo.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Run: node --test test/undo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undoStates, undoKeyOf, undoPayload } from '../src/shared/undo.js';

const e = (ts, extra) => ({ ts, executed: true, fieldId: 'customfield_1', action: 'Add', via: 'direct', ...extra });

test('only the latest change on a field can be undone; an undo frees the older one again', () => {
  const log = [e(3, { batchId: '3-1' }), e(2, { batchId: '2-1' }), e(1, { batchId: '1-1', fieldId: 'customfield_2' })];
  let s = undoStates(log);
  assert.equal(s['batch:3-1'], 'available');
  assert.equal(s['batch:2-1'], 'superseded');
  assert.equal(s['batch:1-1'], 'available', 'another field is independent');
  s = undoStates([e(4, { batchId: '4-1', via: 'undo of 3-1' }), ...log]);
  assert.equal(s['batch:3-1'], 'undone');
  assert.equal(s['batch:4-1'], 'none', 'an undo itself offers no undo');
  assert.equal(s['batch:2-1'], 'available');
});

test('bulk changes, admin steps and pending undo requests', () => {
  const log = [
    e(5, { action: 'Undo', new: 'administration step AB12', via: 'undo by a Jira administrator' }),
    e(4, { adminOp: 'AB12', action: 'Rename field' }),
    e(3, { bulkId: 'B1', batchId: '3-9', fieldId: 'customfield_7' }),
    e(2, { bulkId: 'B1', batchId: '3-8', fieldId: 'customfield_8' }),
    e(1, { batchId: '1-5', fieldId: 'customfield_9' }),
  ];
  const s = undoStates(log, { pending: ['batch:1-5'] });
  assert.equal(s['op:AB12'], 'undone');
  assert.equal(s['bulk:B1'], 'available');
  assert.equal(s['batch:1-5'], 'pending');
  assert.equal(undoStates([e(9, { batchId: '9-1', fieldId: 'customfield_8' }), ...log])['bulk:B1'], 'superseded');
  assert.equal(undoKeyOf(log[2]), 'bulk:B1');
  assert.deepEqual(undoPayload('bulk:B1'), { jobId: 'B1' });
  assert.deepEqual(undoPayload('batch:1-5'), { batchId: '1-5' });
});
