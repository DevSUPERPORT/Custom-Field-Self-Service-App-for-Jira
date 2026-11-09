/**
 * Call recorder shared by the Forge test doubles: every Jira request, storage operation and realtime event the
 * backend attempts is written here, so a test can prove the kill switch let nothing through.
 *
 * @file        test/support/fake-forge/record.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

export const calls = [];
export const record = (kind, detail = {}) => { calls.push({ kind, ...detail }); };
export const reset = () => { calls.length = 0; };

// POSTs that only read (JQL search, permission checks); everything else that isn't a GET changes Jira.
const READ_POST = /\/search\/jql|\/permissions\/check|\/mypermissions|\/bulk\/permission/;
export const jiraWrites = () => calls.filter((c) => c.kind === 'jira' && c.method !== 'GET' && !(c.method === 'POST' && READ_POST.test(c.path)));
export const storageWrites = () => calls.filter((c) => c.kind === 'kvs' && ['set', 'delete'].includes(c.op));
export const realtime = () => calls.filter((c) => c.kind === 'realtime');
