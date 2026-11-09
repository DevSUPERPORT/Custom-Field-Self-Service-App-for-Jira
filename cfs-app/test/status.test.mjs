/**
 * Tests for the shared statuses of requests and audit entries and the duplicate check of pasted option lists.
 *
 * @file        test/status.test.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Run: node --test test/status.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestStatus, logStatus, splitLines, isRequestEntry, keyOfEntry } from '../src/shared/status.js';

test('requests map to the five statuses', () => {
  assert.equal(requestStatus({ status: 'pending' }), 'waiting');
  assert.equal(requestStatus({ status: 'executing' }), 'waiting');
  assert.equal(requestStatus({ status: 'done' }), 'done');
  assert.equal(requestStatus({ status: 'failed' }), 'fail');
  assert.equal(requestStatus({ status: 'blocked' }), 'fail');
  assert.equal(requestStatus({ status: 'declined' }), 'rejected');
  assert.equal(requestStatus({ status: 'withdrawn' }), 'withdrawn');
  assert.equal(requestStatus({ status: 'cancelled' }), 'withdrawn');
});

test('audit entries map to the five statuses', () => {
  assert.equal(logStatus({ executed: true, via: 'direct' }), 'done');
  assert.equal(logStatus({ executed: false, via: 'declined: CFS-1' }), 'rejected');
  assert.equal(logStatus({ executed: false, via: 'withdrawn: CFS-1' }), 'withdrawn');
  assert.equal(logStatus({ executed: false, via: 'failed: CFS-1' }), 'fail');
  assert.equal(logStatus({ executed: false, via: 'blocked: CFS-1 (x)' }), 'fail');
  assert.equal(logStatus({ via: 'approval requested: FSST-69' }), 'waiting');
  assert.equal(logStatus({ via: 'project admin approval requested: FSST-70' }), 'waiting');
  assert.ok(isRequestEntry({ via: 'approval requested: FSST-69' }));
  assert.equal(keyOfEntry({ via: 'withdrawn: FSST-69' }), 'FSST-69');
});

test('pasted lists: duplicates of existing options and of earlier lines are skipped', () => {
  const r = splitLines('5200 QA\n5300 Personal\n3100 Vertrieb DACH\n5300  personal\n\n', ['3100 Vertrieb DACH']);
  assert.deepEqual(r.fresh, ['5200 QA', '5300 Personal']);
  assert.deepEqual(r.dupes, ['3100 Vertrieb DACH', '5300  personal']);
});
