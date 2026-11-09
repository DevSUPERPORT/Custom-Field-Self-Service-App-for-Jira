/**
 * "View as project admin" for Jira administrators: the role a call runs with (only ever lowered) and the list of
 * reading calls a preview may make.
 *
 * @file        src/shared/preview.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// A Jira administrator can look at the project page the way the space's project admins see it. The preview only ever
// LOWERS the role (never raises it), and only reading calls run in it: the services decide direct-or-request by the
// real person, so a change made in a preview would not be what a project admin's change does.
export const PREVIEW_ROLE = 'project-admin';
const RANK = { none: 0, 'project-admin': 1, 'jira-admin': 2 };

// Calls that only read (whatsNew and tour also note the visit, which is harmless).
export const PREVIEW_READS = new Set([
  'boot', 'overview', 'options', 'usage', 'optionsOf', 'newFieldMeta', 'screens', 'tour', 'checkField', 'audit', 'health',
  'inbox', 'whatsNew', 'getDraft', 'radar', 'guardState', 'whoami', 'fieldDetails', 'myRequests', 'projectIssueTypes',
  'latestChanges', 'bulkCatalog', 'bulkHistory', 'bulkGet',
]);

// The role a call runs with: the real one, or the preview role when that is lower. preview: { asRole, name }.
export const previewRole = (actual, asRole) => (asRole === PREVIEW_ROLE && RANK[actual] > RANK[PREVIEW_ROLE] ? PREVIEW_ROLE : actual);

// null when the call may run, else the reason it is refused.
export const previewRefusal = (actual, asRole, name) => {
  if (previewRole(actual, asRole) === actual) return null;
  return PREVIEW_READS.has(name) ? null : 'This is a preview of what project admins see: changes are switched off. Leave the preview to make changes.';
};
