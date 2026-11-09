/**
 * Jira REST access layer with retries on rate limits: permission checks run as the user, while everything that reads
 * or changes configuration runs as the app, never with the project admin's own rights. Also project, screen, role and
 * option lookups used by every other module.
 *
 * @file        src/jira.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import api, { route } from '@forge/api';
import { getSettings } from './settings';

export class ApiError extends Error {
  constructor(status, method, path, text) {
    super(`${method} ${path} -> HTTP ${status}: ${String(text).slice(0, 400)}`);
    this.status = status;
  }
}

export class Forbidden extends Error {}

// Large sites rate-limit (429) and occasionally answer 502/503/504. 429 means the request was not processed, so it is
// retried for every method; gateway errors only for reads and idempotent writes. Waits follow Retry-After (capped) or
// back off 0.5 s, 1 s, 2 s. Total extra wait stays below ~8 s so a resolver still answers in time.
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const IDEMPOTENT = new Set(['GET', 'PUT', 'DELETE']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (who, method, path, body) => {
  let waited = 0;
  for (let attempt = 0; ; attempt += 1) {
    const res = await (who === 'user' ? api.asUser() : api.asApp()).requestJira(path, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const retryable = RETRY_STATUS.has(res.status) && (res.status === 429 || IDEMPOTENT.has(method));
    if (retryable && attempt < 3 && waited < 8000) {
      const after = Number(res.headers?.get?.('Retry-After'));
      const wait = Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt, 8000 - waited);
      waited += wait;
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, method, String(path.value || path), text);
    return text ? JSON.parse(text) : null;
  }
};

export const app = {
  get: (p) => call('app', 'GET', p),
  post: (p, b) => call('app', 'POST', p, b),
  put: (p, b) => call('app', 'PUT', p, b),
  del: (p) => call('app', 'DELETE', p),
};
export const user = {
  get: (p) => call('user', 'GET', p),
  post: (p, b) => call('user', 'POST', p, b),
  put: (p, b) => call('user', 'PUT', p, b),
};

// pathAt(startAt) must return a route; collects "values" over all pages.
export const paged = async (pathAt) => {
  const out = [];
  let startAt = 0;
  for (let i = 0; i < 50; i += 1) {
    const res = await app.get(pathAt(startAt));
    const vals = res.values || [];
    out.push(...vals);
    if (res.isLast !== false || vals.length === 0) break;
    startAt += vals.length;
  }
  return out;
};

export const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

// ---------- permissions ----------
// With an accountId (from Jira's invocation context, never from the browser) the app checks the person's
// permissions with its OWN rights (the app user is a Jira admin), so pages work without the per-user "Allow access"
// consent (product decision, 2026-10-20). Without one (Rovo actions, which only know the user through asUser) the
// check runs as the user.

const projectIds = new Map();
const projectId = async (key) => {
  if (!projectIds.has(key)) projectIds.set(key, Number((await app.get(route`/rest/api/3/project/${key}`)).id));
  return projectIds.get(key);
};

export const hasProjectPermission = async (accountId, projectKey, permission) => {
  const r = await app.post(route`/rest/api/3/permissions/check`, {
    accountId, projectPermissions: [{ permissions: [permission], projects: [await projectId(projectKey)] }],
  });
  return (r.projectPermissions || []).some((p) => p.permission === permission && (p.projects || []).length > 0);
};

export const hasGlobalPermission = async (accountId, permission) => {
  const r = await app.post(route`/rest/api/3/permissions/check`, { accountId, globalPermissions: [permission] });
  return (r.globalPermissions || []).includes(permission);
};

// accountId (optional): users on the admin page's test list count as non-admins, so the non-admin flow can be
// tested without a second account.
export const isProjectAdmin = async (projectKey, accountId) => {
  if (accountId && (await getSettings()).simulateNonAdminIds.includes(accountId)) return false;
  if (accountId) {
    // Exactly what Jira grants: the "Administer projects" permission, or Jira administrator. Role names or role
    // membership never count on their own.
    if (await hasProjectPermission(accountId, projectKey, 'ADMINISTER_PROJECTS').catch(() => false)) return true;
    return hasGlobalPermission(accountId, 'ADMINISTER').catch(() => false);
  }
  const r = await user.get(route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=ADMINISTER_PROJECTS`);
  return !!r.permissions?.ADMINISTER_PROJECTS?.havePermission;
};

// Jira administrators (global "Administer Jira") are the app's highest role: only they change fields directly and
// only they can give the final approval. Checked live with Jira, cached for a minute per person. The admin page's
// TEST ONLY lists can demote someone to project admin or non-admin, so the restricted views can be tried out.
const adminMemo = new Map();
export const isJiraAdmin = async (accountId) => {
  if (!accountId) return false;
  const s = await getSettings();
  if (s.simulateNonAdminIds.includes(accountId) || (s.simulateProjectAdminIds || []).includes(accountId)) return false;
  const m = adminMemo.get(accountId);
  if (m && Date.now() - m.at < 60000) return m.v;
  const v = await hasGlobalPermission(accountId, 'ADMINISTER').catch(() => false);
  adminMemo.set(accountId, { at: Date.now(), v });
  return v;
};

// The app reads Jira with its own rights; what it shows a person is cut down to the projects that person may browse
// (checked with Jira for that account, cached for a minute), so the app never reveals more than Jira would.
const browseMemo = new Map();
export const browsable = async (accountId, keys) => {
  const out = [];
  for (const k of [...new Set((keys || []).filter(Boolean))]) {
    const id = `${accountId}|${k}`;
    const m = browseMemo.get(id);
    let ok;
    if (m && Date.now() - m.at < 60000) ok = m.v;
    else {
      ok = await hasProjectPermission(accountId, k, 'BROWSE_PROJECTS').catch(() => false);
      browseMemo.set(id, { at: Date.now(), v: ok });
    }
    if (ok) out.push(k);
  }
  return out;
};

// Whether a change runs directly: the person themself is a Jira administrator; or, for a request a project admin
// approved at stage 1, that approver is a configured final approver AND a Jira administrator. Otherwise it is a
// request for a Jira administrator.
export const actsAsAdmin = async (accountId, approvedBy = null) => {
  if (!approvedBy) return isJiraAdmin(accountId);
  const s = await getSettings();
  if (![...s.approverAccountIds, ...s.backupApproverAccountIds].includes(approvedBy)) return false;
  return isJiraAdmin(approvedBy);
};

// The caller's role in a project: 'jira-admin' > 'project-admin' > 'none'.
export const ROLE_RANK = { none: 0, 'project-admin': 1, 'jira-admin': 2 };
export const roleOf = async (projectKey, accountId) => {
  if (await isJiraAdmin(accountId)) return 'jira-admin';
  return (await isProjectAdmin(projectKey, accountId)) ? 'project-admin' : 'none';
};

export const assertProjectAdmin = async (projectKey, accountId) => {
  if (!(await isProjectAdmin(projectKey, accountId))) {
    throw new Forbidden(`You are not an administrator of project ${projectKey}.`);
  }
};

export const canBrowse = async (projectKey) => {
  const r = await user.get(route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=BROWSE_PROJECTS`);
  return !!r.permissions?.BROWSE_PROJECTS?.havePermission;
};

// The people in the project's Administrators role (groups expanded), without app users. Read as the app.
export const projectAdmins = async (projectKey, max = 10) => {
  const roles = await app.get(route`/rest/api/3/project/${projectKey}/role`);
  const entry = Object.entries(roles).find(([n]) => n === 'Administrators') || Object.entries(roles).find(([n]) => /admin/i.test(n));
  if (!entry) return { users: [], groups: [], role: null };
  const roleId = String(entry[1]).split('/').pop();
  const role = await app.get(route`/rest/api/3/project/${projectKey}/role/${roleId}`);
  const ids = new Set();
  const groups = [];
  for (const a of role.actors || []) {
    if (a.type === 'atlassian-user-role-actor' && a.actorUser?.accountId) ids.add(a.actorUser.accountId);
    if (a.type === 'atlassian-group-role-actor') {
      groups.push(a.displayName || a.name);
      const gid = a.actorGroup?.groupId;
      const members = await app.get(gid ? route`/rest/api/3/group/member?groupId=${gid}&maxResults=50` : route`/rest/api/3/group/member?groupname=${a.name}&maxResults=50`).catch(() => ({ values: [] }));
      (members.values || []).filter((u) => u.accountType === 'atlassian' && u.active !== false).forEach((u) => ids.add(u.accountId));
    }
  }
  const users = [];
  for (const id of ids) {
    if (users.length >= max) break;
    const u = await app.get(route`/rest/api/3/user?accountId=${id}`).catch(() => null);
    // Only people Jira really lets administer the project (role membership alone is not enough).
    if (u && u.accountType === 'atlassian' && u.active !== false && (await hasProjectPermission(id, projectKey, 'ADMINISTER_PROJECTS').catch(() => false))) {
      users.push({ accountId: u.accountId, displayName: u.displayName });
    }
  }
  return { users, groups, role: entry[0] };
};

// Every project on the site that accountId administers, in one permission check (the app's rights).
export const allAdminProjects = async (accountId) => {
  if ((await getSettings()).simulateNonAdminIds.includes(accountId)) return [];
  const projects = await paged((s) => route`/rest/api/3/project/search?startAt=${s}&maxResults=100`);
  const out = [];
  for (let i = 0; i < projects.length; i += 100) {
    const chunk = projects.slice(i, i + 100);
    const r = await app.post(route`/rest/api/3/permissions/check`, {
      accountId, projectPermissions: [{ permissions: ['ADMINISTER_PROJECTS'], projects: chunk.map((p) => Number(p.id)) }],
    });
    const ok = new Set(((r.projectPermissions || [])[0]?.projects || []).map(String));
    chunk.filter((p) => ok.has(String(p.id))).forEach((p) => out.push({ id: String(p.id), key: p.key, name: p.name }));
  }
  return out;
};

// Every company-managed space accountId may browse (one permission check per 100 spaces): the space picker of a new
// field (UC-04). Team-managed spaces are left out, their fields work differently.
export const allBrowsableProjects = async (accountId) => {
  const projects = (await paged((s) => route`/rest/api/3/project/search?startAt=${s}&maxResults=100`)).filter((p) => p.style !== 'next-gen' && !p.simplified);
  const out = [];
  for (let i = 0; i < projects.length; i += 100) {
    const chunk = projects.slice(i, i + 100);
    const r = await app.post(route`/rest/api/3/permissions/check`, {
      accountId, projectPermissions: [{ permissions: ['BROWSE_PROJECTS'], projects: chunk.map((p) => Number(p.id)) }],
    });
    const ok = new Set(((r.projectPermissions || [])[0]?.projects || []).map(String));
    chunk.filter((p) => ok.has(String(p.id))).forEach((p) => out.push({ id: String(p.id), key: p.key, name: p.name }));
  }
  return out;
};

// The given projects that accountId administers (checked with the app's rights, see above).
export const adminProjects = async (accountId, keys) => {
  const out = [];
  for (const key of keys) {
    if (await isProjectAdmin(key, accountId).catch(() => false)) out.push({ key });
  }
  return out;
};

// ---------- reads (as the app) ----------

export const getProject = (key) => app.get(route`/rest/api/3/project/${key}?expand=issueTypes`);

export const allProjects = async () => {
  const list = await paged((s) => route`/rest/api/3/project/search?startAt=${s}&maxResults=100`);
  return Object.fromEntries(list.map((p) => [String(p.id), { key: p.key, name: p.name, type: p.projectTypeKey }]));
};

export const allIssueTypes = async () => {
  const list = await app.get(route`/rest/api/3/issuetype`);
  return Object.fromEntries(list.map((t) => [String(t.id), t.name]));
};

export const customFields = () => paged((s) => route`/rest/api/3/field/search?type=custom&expand=isLocked&startAt=${s}&maxResults=100`);

// Only the custom fields that have a context for this project (its own, shared or global). On classic sites without
// field schemes this is what keeps the overview small on sites with thousands of fields.
export const customFieldsForProject = (projectId) => paged((s) => route`/rest/api/3/field/search?type=custom&expand=isLocked&projectIds=${projectId}&startAt=${s}&maxResults=100`);

// Team-managed (next-gen) spaces keep their fields in the space itself; the context APIs don't apply to them.
const styleMemo = new Map();
export const projectStyle = async (projectKey) => {
  const hit = styleMemo.get(projectKey);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const p = await app.get(route`/rest/api/3/project/${projectKey}`);
  const value = { style: p.style || 'classic', simplified: !!p.simplified, type: p.projectTypeKey, id: String(p.id), name: p.name };
  styleMemo.set(projectKey, { at: Date.now(), value });
  return value;
};
export const isTeamManaged = (st) => st.style === 'next-gen' || st.simplified;

export const systemFieldNames = async () => (await app.get(route`/rest/api/3/field`)).filter((f) => !f.custom).map((f) => f.name);
// System fields people fill in or see on work items (UC-01 lists them read-only next to the custom fields).
export const systemFields = async () => (await app.get(route`/rest/api/3/field`))
  .filter((f) => !f.custom && f.schema && (f.orderable || f.navigable) && !/^(thumbnail|lastViewed|worklog|timetracking|attachment|issuelinks|subtasks|parent|project|issuekey|statusCategory|aggregate)/i.test(f.id))
  .map((f) => ({ id: f.id, name: f.name, schemaType: f.schema.system || f.schema.type }));

// Field schemes ("new field configuration"): null when the site does not use them.
export const fieldSchemeIdsForProject = async (projectId) => {
  try {
    const r = await app.get(route`/rest/api/3/config/fieldschemes?projectId=${projectId}`);
    return (r.values || []).map((s) => s.id);
  } catch (e) {
    if (e.status === 404 || e.status === 400) return null;
    throw e;
  }
};

export const fieldIdsInScheme = async (schemeId) => {
  const list = await paged((s) => route`/rest/api/3/config/fieldschemes/${schemeId}/fields?startAt=${s}&maxResults=100`);
  return new Set(list.map((f) => f.fieldId));
};

export const contexts = (fieldId) => paged((s) => route`/rest/api/3/field/${fieldId}/context?startAt=${s}&maxResults=100`);
export const projectMappings = (fieldId) => paged((s) => route`/rest/api/3/field/${fieldId}/context/projectmapping?startAt=${s}&maxResults=100`);
export const issueTypeMappings = (fieldId, contextId) => paged((s) => route`/rest/api/3/field/${fieldId}/context/issuetypemapping?contextId=${contextId}&startAt=${s}&maxResults=100`);
export const options = (fieldId, contextId) => paged((s) => route`/rest/api/3/field/${fieldId}/context/${contextId}/option?startAt=${s}&maxResults=100`);

// ---------- writes (as the app) ----------

export const addOptions = (fieldId, contextId, opts) => app.post(route`/rest/api/3/field/${fieldId}/context/${contextId}/option`, { options: opts });
export const updateOptions = (fieldId, contextId, opts) => app.put(route`/rest/api/3/field/${fieldId}/context/${contextId}/option`, { options: opts });
export const moveOptions = (fieldId, contextId, ids) => app.put(route`/rest/api/3/field/${fieldId}/context/${contextId}/option/move`, { customFieldOptionIds: ids, position: 'First' });
export const createField = (body) => app.post(route`/rest/api/3/field`, body);
export const getDefault = async (fieldId, contextId) => {
  const r = await app.get(route`/rest/api/3/field/${fieldId}/context/defaultValue?contextId=${contextId}`).catch(() => ({ values: [] }));
  const v = (r.values || []).find((x) => String(x.contextId) === String(contextId)) || {};
  return [v.optionId, v.cascadingOptionId, ...(v.optionIds || [])].filter(Boolean).map(String);
};
export const createContext = (fieldId, body) => app.post(route`/rest/api/3/field/${fieldId}/context`, body);
export const deleteContext = (fieldId, contextId) => app.del(route`/rest/api/3/field/${fieldId}/context/${contextId}`);
export const setDefault = (fieldId, defaultValues) => app.put(route`/rest/api/3/field/${fieldId}/context/defaultValue`, { defaultValues });
export const associateWithSchemes = (fieldId, schemeIds) => app.put(route`/rest/api/3/config/fieldschemes/fields`, { [fieldId]: [{ schemeIds }] });

// ---------- impact and health (as the app) ----------

// Work items matching a JQL (approximate count; the JQL must be bounded, which a field clause is).
export const countJql = async (jql) => (await app.post(route`/rest/api/3/search/approximate-count`, { jql })).count;
// When the most recently updated work item matching the JQL was updated (ISO date), or null.
export const latestUpdated = async (jql) => {
  const r = await app.post(route`/rest/api/3/search/jql`, { jql: `${jql} ORDER BY updated DESC`, fields: ['updated'], maxResults: 1 });
  return r?.issues?.[0]?.fields?.updated || null;
};

// ---------- work items (bulk replace, as the app) ----------

// One page of work items for a JQL with only the given fields (token-based search).
export const searchPage = (jql, fields, nextPageToken) => app.post(route`/rest/api/3/search/jql`, { jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) });
export const issueField = async (key, fieldId) => (await app.get(route`/rest/api/3/issue/${key}?fields=${fieldId}`)).fields?.[fieldId] ?? null;

// Sets one field without an e-mail per work item and also where the field is not on the edit screen. Where Jira
// refuses those two options to the app, it falls back to a plain edit (and remembers that for this run).
let quietEdit = true;
export const setIssueField = async (key, fieldId, value) => {
  const body = { fields: { [fieldId]: value } };
  if (quietEdit) {
    try {
      return await app.put(route`/rest/api/3/issue/${key}?notifyUsers=false&overrideScreenSecurity=true`, body);
    } catch (e) {
      if (!(e.status === 403 || (e.status === 400 && /override|notify|screen security/i.test(e.message)))) throw e;
      quietEdit = false;
    }
  }
  return app.put(route`/rest/api/3/issue/${key}`, body);
};

export const fieldsWithUsage = () => paged((s) => route`/rest/api/3/field/search?type=custom&expand=isLocked,lastUsed,screensCount,contextsCount&startAt=${s}&maxResults=100`);

// ---------- screens (as the app) ----------

export const itssForProject = async (projectId) => {
  const r = await app.get(route`/rest/api/3/issuetypescreenscheme/project?projectId=${projectId}`);
  return r.values?.[0]?.issueTypeScreenScheme || null;
};
export const projectsOfItss = (itssId) => paged((s) => route`/rest/api/3/issuetypescreenscheme/${itssId}/project?startAt=${s}&maxResults=50`);
export const itssMappings = (itssId) => paged((s) => route`/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${itssId}&startAt=${s}&maxResults=100`);
export const allItssMappings = () => paged((s) => route`/rest/api/3/issuetypescreenscheme/mapping?startAt=${s}&maxResults=100`);
export const allScreenSchemes = () => paged((s) => route`/rest/api/3/screenscheme?startAt=${s}&maxResults=100`);
export const screenTabs = (screenId) => app.get(route`/rest/api/3/screens/${screenId}/tabs`);
export const tabFields = (screenId, tabId) => app.get(route`/rest/api/3/screens/${screenId}/tabs/${tabId}/fields`);
export const addTabField = (screenId, tabId, fieldId) => app.post(route`/rest/api/3/screens/${screenId}/tabs/${tabId}/fields`, { fieldId });
export const moveTabField = (screenId, tabId, fieldId, after) => app.post(route`/rest/api/3/screens/${screenId}/tabs/${tabId}/fields/${fieldId}/move`, { after });
export const screenName = async (screenId) => {
  const r = await app.get(route`/rest/api/3/screens?id=${screenId}`);
  return r.values?.[0]?.name || String(screenId);
};

// ---------- reuse an existing field (as the app) ----------

export const allFieldSchemes = () => paged((s) => route`/rest/api/3/config/fieldschemes?startAt=${s}&maxResults=50`);
export const assignContextProjects = (fieldId, contextId, projectIds) => app.put(route`/rest/api/3/field/${fieldId}/context/${contextId}/project`, { projectIds: projectIds.map(String) });

// ---------- filters, properties ----------

// Saved filters visible to the caller (as the user when there is one), with their JQL. At most 300.
export const visibleFilters = async (asUser = true) => {
  const out = [];
  const who = asUser ? user : app;
  for (let startAt = 0; startAt < 300; startAt += 100) {
    // Only what the person can see: without their consent the lookup fails and the caller says "not checked" -
    // never the app's own (wider) view.
    const r = await who.get(route`/rest/api/3/filter/search?expand=jql,owner&maxResults=100&startAt=${startAt}`);
    out.push(...(r.values || []));
    if (r.isLast !== false || !(r.values || []).length) break;
  }
  return out;
};

export const updateFilterJql = (id, filter, jql) => user.put(route`/rest/api/3/filter/${id}`, { name: filter.name, jql });

export const getProjectProperty = async (projectKey, key) => {
  try {
    return (await app.get(route`/rest/api/3/project/${projectKey}/properties/${key}`)).value;
  } catch (e) {
    return null;
  }
};
export const setProjectProperty = (projectKey, key, value) => app.put(route`/rest/api/3/project/${projectKey}/properties/${key}`, value);
