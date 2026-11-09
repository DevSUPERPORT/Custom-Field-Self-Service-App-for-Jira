/**
 * Test double of @forge/kvs: an empty store that records every read, write and query the backend attempts.
 *
 * @file        test/support/fake-forge/kvs.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import { record } from './record.mjs';

const query = () => {
  record('kvs', { op: 'query' });
  const chain = {
    where: () => chain, limit: () => chain, cursor: () => chain, sort: () => chain, index: () => chain,
    getMany: async () => ({ results: [], nextCursor: undefined }),
    getOne: async () => undefined,
  };
  return chain;
};

// A test may keep values: globalThis.__fakeKvs = new Map(). Without it storage stays empty.
export const kvs = {
  get: async (key) => { record('kvs', { op: 'get', key }); return globalThis.__fakeKvs ? globalThis.__fakeKvs.get(key) : undefined; },
  set: async (key, value) => { record('kvs', { op: 'set', key }); if (globalThis.__fakeKvs) globalThis.__fakeKvs.set(key, value); },
  delete: async (key) => { record('kvs', { op: 'delete', key }); if (globalThis.__fakeKvs) globalThis.__fakeKvs.delete(key); },
  query,
};
const condition = (name) => (...args) => ({ condition: name, args });
export const WhereConditions = { beginsWith: condition('BEGINS_WITH'), equalTo: condition('EQUAL_TO'), between: condition('BETWEEN') };
