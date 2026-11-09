/**
 * Follow-ups for the other spaces of a new field: their project admins are told the field is not on their screens yet
 * and can add it to their own screens with one click. Stored as todo:<PROJECT>:<FIELD ID>.
 *
 * @file        src/followups.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// A new field whose context covers several spaces is put only on the requesting space's own screens (UC-05). The
// project admins of the other spaces get an e-mail on the request (when there is one) and a card under "Requests for
// you" on their own Custom Field Self-Service for Jira page. The card adds the field to that space's own screens only: the field and
// its spaces were already approved, and screens used by other spaces are never touched.
//   todo:<PROJECT>:<FIELD ID>   one open follow-up
import { kvs, WhereConditions } from '@forge/kvs';
import * as J from './jira';
import { notifyUsers } from './ops';
import { writeLog } from './audit';
import { fieldForProject } from './fields';
import { addFieldToScreens } from './insights';

const keyOf = (projectKey, fieldId) => `todo:${projectKey}:${fieldId}`;

export const inviteOtherSpaces = async ({ fieldId, fieldName, keys, origin, issueKey = null, actor = null }) => {
  const others = [...new Set(keys)].filter((k) => k && k !== origin);
  const invited = [];
  for (const k of others) {
    await kvs.set(keyOf(k, fieldId), { projectKey: k, fieldId, fieldName, origin, issueKey, actor, at: Date.now() });
    const admins = await J.projectAdmins(k, 10).catch(() => ({ users: [] }));
    const ids = admins.users.map((u) => u.accountId);
    let mailed = false;
    if (issueKey && ids.length) {
      mailed = await notifyUsers(issueKey, ids, `New field for ${k}: ${fieldName}`,
        `The field "${fieldName}" now also applies to ${k} (requested by ${origin}, ${issueKey}). It is not on the screens of ${k} yet.\n\nTo add it to your space's own screens: Project settings of ${k} → Custom Field Self-Service for Jira → Requests for you → Add to my screens.`);
    }
    invited.push({ projectKey: k, admins: ids.length, mailed });
  }
  return invited;
};

export const todosFor = async (projectKey) => {
  const out = [];
  let cursor;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(`todo:${projectKey}:`)).limit(50);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    out.push(...page.results.map((r) => r.value));
    cursor = page.nextCursor;
  } while (cursor && out.length < 200);
  return out.sort((a, b) => b.at - a.at);
};

export const dismissTodo = async ({ projectKey, fieldId, accountId }) => {
  const t = await kvs.get(keyOf(projectKey, fieldId));
  if (!t) return { status: 'gone' };
  await kvs.delete(keyOf(projectKey, fieldId));
  await writeLog(projectKey, [{ action: 'Screens', option: t.fieldName, old: '', new: 'not added (dismissed)', actor: accountId, fieldId, fieldName: t.fieldName, via: `follow-up of ${t.issueKey || t.origin}`, executed: true }]);
  return { status: 'dismissed' };
};

// Only the space's own screens (shared screens are skipped by addFieldToScreens), only for a field that still has a
// context covering this space.
export const resolveTodo = async ({ projectKey, fieldId, screenIds, accountId }) => {
  const t = await kvs.get(keyOf(projectKey, fieldId));
  if (!t) throw new Error('This field is not waiting for your screens any more.');
  const { project, field } = await fieldForProject(projectKey, fieldId);
  const r = await addFieldToScreens(field.id, project.id, [], (screenIds || []).map(String));
  await writeLog(projectKey, [{ action: 'Screens', option: field.name, old: '', new: r.added.join(', ') || 'no screen', actor: accountId, fieldId, fieldName: field.name, via: `follow-up of ${t.issueKey || t.origin}`, executed: true }]);
  await kvs.delete(keyOf(projectKey, fieldId));
  return { status: 'done', ...r };
};
