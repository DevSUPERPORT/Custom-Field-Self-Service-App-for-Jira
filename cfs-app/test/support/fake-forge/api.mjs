/**
 * Test double of @forge/api: records every Jira request and answers it with an error, so the backend can be loaded
 * and called outside the Forge runtime without reaching any site.
 *
 * @file        test/support/fake-forge/api.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import { record } from './record.mjs';

// A test may answer Jira itself: globalThis.__fakeJira = (who, path, opts) => body (JSON) or undefined (offline).
const offline = (who) => async (path, opts = {}) => {
  record('jira', { who, path: String(path), method: String(opts.method || 'GET').toUpperCase() });
  const body = globalThis.__fakeJira ? await globalThis.__fakeJira(who, String(path), opts) : undefined;
  if (body !== undefined) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body };
  return { ok: false, status: 500, headers: { get: () => null }, text: async () => '{"errorMessages":["offline (test)"]}', json: async () => ({}) };
};
const product = (who) => ({ requestJira: offline(who), requestConfluence: offline(who) });

export const route = (strings, ...values) => strings.reduce((out, s, i) => out + s + (i < values.length ? encodeURIComponent(String(values[i])) : ''), '');
export const asApp = () => product('app');
export const asUser = () => product('user');
export const fetch = offline('fetch');
const api = { asApp, asUser, fetch };
export default api;

// Personal data reporting (src/privacy.js): no closed accounts in the tests.
export const privacy = { reportPersonalData: async () => [] };
