/**
 * Field health: which findings a field gets, and the clean-up suggestions built from them. Pure functions, shared by
 * the server (src/insights.js), the project page (HealthTab.jsx) and the tests.
 *
 * "Unused" is decided by the work items themselves: a field is unused when no work item has a value (JQL
 * `cf[id] is not EMPTY` counts 0). Jira's own "last used" date is only a hint: Jira reports it as NOT_TRACKED or
 * NO_INFORMATION for most fields, so it cannot tell unused fields apart.
 *
 * Two scopes: Jira administrators see every changeable custom field of the site, counted over the whole site (scope
 * "site"); project administrators see only the fields their space uses, counted over their space's work items and
 * checked against their space's screens (scope "project").
 *
 * @file        src/shared/health.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-06
 * @updated     2026-11-06
 */

const DAY = 24 * 3600 * 1000;

/** A field not used for this many days counts as stale (when Jira tracks its last use). */
export const STALE_DAYS = 180;

/** How long a counted number of values stays valid; a failed count is retried sooner. */
export const COUNT_TTL = 6 * 3600 * 1000;
export const COUNT_RETRY = 10 * 60 * 1000;

/** Stored counts carry this version; older entries (without the last activity date) are counted again. */
export const COUNT_VERSION = 2;

/** Whether a cached count is still good at `now`. */
export const countFresh = (entry, now = Date.now()) => !!entry && entry.v === COUNT_VERSION
  && (now - (entry.at || 0)) < (entry.n === null ? COUNT_RETRY : COUNT_TTL);

/**
 * Findings for one field. `values`: work items with a value in the scope (null = not counted / Jira cannot count
 * this field type). `opts.scope`: 'site' (default) or 'project'; `opts.onScreen`: whether the field is on one of the
 * space's screens (project scope; the site scope uses Jira's screensCount); `opts.lastActivity`: when a work item with
 * a value was last updated (in the scope), used when Jira does not track the field's last use - Jira reports
 * NO_INFORMATION or NOT_TRACKED for most fields. Returns { flags, lastUsed }; each flag has a code, an English text
 * (Rovo, logs), the scope and the numbers the page needs to show it in the user's language.
 */
export const healthFlags = (field, values = null, now = Date.now(), { scope = 'site', onScreen, lastActivity = null } = {}) => {
  const flags = [];
  const here = scope === 'project';
  const lu = field.lastUsed || {};
  const tracked = lu.type === 'TRACKED' && lu.value ? lu.value : null;
  const lastUsed = tracked || (values > 0 ? lastActivity : null) || null;
  if (values === 0) {
    flags.push({ code: 'never', text: here ? 'No value on any work item in this space' : 'No value on any work item', scope });
  } else if (lastUsed) {
    const days = Math.floor((now - new Date(lastUsed).getTime()) / DAY);
    if (days >= STALE_DAYS) flags.push({ code: 'stale', text: `Not used for ${days} days`, days });
  } else if (lu.type === 'TRACKED' && values === null) {
    // Jira tracks the field and has never seen a value; used when the count is not available.
    flags.push({ code: 'never', text: 'Never used' });
  }
  const visible = here ? !!onScreen : field.screensCount !== 0;
  if (!visible) flags.push({ code: 'noscreen', text: here ? "Not on this space's screens" : 'On no screen', scope });
  return { flags, lastUsed };
};

/**
 * Whether a field belongs in a project administrator's field health: fields whose context includes the space (scope
 * 'project' or 'shared' in the overview) always; global fields only when the space uses them (on one of its screens
 * or with values in its work items). Fields the overview does not list for the space never.
 */
export const relevantToProject = (overviewScope, { onScreen = false, values = null } = {}) => {
  if (overviewScope === 'project' || overviewScope === 'shared') return true;
  if (overviewScope === 'global') return !!onScreen || values > 0;
  return false;
};

const has = (r, code) => r.flags.some((f) => f.code === code);

/**
 * Clean-up suggestions from the health rows, most urgent first. Each: { kind, fieldIds }. Kinds:
 *   hidden    values exist but the field is on no screen: people can't see or edit them
 *   retire    no value anywhere and on no screen: nobody uses it, nobody can fill it in
 *   empty     on screens, but nobody ever filled it in
 *   duplicate looks like another field (similar name, same type)
 *   stale     not used for STALE_DAYS days or more
 */
export const cleanupSuggestions = (rows) => {
  const pick = (test) => rows.filter(test).map((r) => r.id);
  return [
    { kind: 'hidden', fieldIds: pick((r) => has(r, 'noscreen') && r.values > 0) },
    { kind: 'retire', fieldIds: pick((r) => has(r, 'noscreen') && has(r, 'never')) },
    { kind: 'empty', fieldIds: pick((r) => !has(r, 'noscreen') && has(r, 'never')) },
    { kind: 'duplicate', fieldIds: pick((r) => has(r, 'duplicate')) },
    { kind: 'stale', fieldIds: pick((r) => has(r, 'stale')) },
  ].filter((s) => s.fieldIds.length > 0);
};
