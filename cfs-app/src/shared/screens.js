/**
 * Which of a space's screens a field may be put on, or taken off, from field health: only screens the space uses
 * alone, whatever IDs the page sent.
 *
 * @file        src/shared/screens.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// screens: the space's screens as projectScreens returns them ({ screenId, exclusive }); wanted: the screen IDs the
// person ticked (empty or null = all). Only screens this space uses alone qualify, whatever IDs were sent: a shared
// screen would change other spaces too.
export const ownScreenTargets = (screens, wanted = null) => {
  const pick = Array.isArray(wanted) && wanted.length ? new Set(wanted.map(String)) : null;
  return screens.filter((s) => s.exclusive && (!pick || pick.has(String(s.screenId))));
};

// The screen schemes that apply to the chosen issue types. An issue type has exactly one screen scheme: its own
// mapping in the space's issue type screen scheme, or the "default" mapping only when it has no own one. No issue types
// chosen means all of the space's issue types. mappings: [{ issueTypeId ('default' or an id), screenSchemeId }].
export const schemesForIssueTypes = (mappings, issueTypeIds = [], projectIssueTypeIds = []) => {
  const own = new Map(mappings.filter((m) => String(m.issueTypeId) !== 'default').map((m) => [String(m.issueTypeId), String(m.screenSchemeId)]));
  const def = mappings.find((m) => String(m.issueTypeId) === 'default');
  const types = (issueTypeIds.length ? issueTypeIds : projectIssueTypeIds).map(String);
  // Issue types unknown here (no list from Jira): every scheme of the space, rather than none.
  if (!types.length) return new Set(mappings.map((m) => String(m.screenSchemeId)));
  const out = new Set();
  types.forEach((t) => {
    const s = own.get(t) || (def ? String(def.screenSchemeId) : null);
    if (s) out.add(s);
  });
  return out;
};

// Taking a field out of use from field health. contexts: the field's contexts ({ global, projects: [{ id }] });
// current: the screens it is on ({ id, tabId, name }); own: this space's screens ({ screenId, exclusive }).
// A field only this space uses comes off every screen (nobody else can fill it in anyway). A field other spaces use
// too comes off this space's own screens only; screens shared with other spaces keep it.
export const removalTargets = ({ contexts, projectId, current, own }) => {
  const onlyHere = contexts.length > 0 && contexts.every((c) => !c.global && c.projects.length > 0 && c.projects.every((p) => String(p.id) === String(projectId)));
  const withTab = current.filter((s) => s.tabId);
  if (onlyHere) return { mode: 'everywhere', remove: withTab, keep: [] };
  const mine = new Set(own.filter((s) => s.exclusive).map((s) => String(s.screenId)));
  return { mode: 'this-space', remove: withTab.filter((s) => mine.has(String(s.id))), keep: withTab.filter((s) => !mine.has(String(s.id))) };
};
