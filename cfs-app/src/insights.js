/**
 * Impact preview (work items per option), the impact radar of saved filters and automation rules, screen placement
 * for new fields, and field health. Everything is computed from JQL and the project's schemes, never guessed.
 *
 * @file        src/insights.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-06
 */

import * as J from './jira';
import { getSettings } from './settings';
import { similarity, RULES } from './shared/guidelines';
import { schemesForIssueTypes } from './shared/screens';
import { shortType, typeLabel } from './shared/fieldtypes';
import { healthFlags, countFresh, relevantToProject, COUNT_VERSION } from './shared/health';
import { kvs } from '@forge/kvs';

const cfNum = (fieldId) => fieldId.split('_')[1];

// ---------- impact ----------

// tree: [{ id, value, children }]; projectKeys limit the count to the context's projects ([] = any project).
export const optionUsage = async (fieldId, tree, projectKeys = [], cascading = false) => {
  const scope = projectKeys.length ? `project in (${projectKeys.map((k) => `"${k}"`).join(',')}) AND ` : '';
  const n = cfNum(fieldId);
  const jobs = [];
  tree.forEach((p) => {
    jobs.push({ id: p.id, jql: cascading ? `${scope}cf[${n}] in cascadeOption(${p.id})` : `${scope}cf[${n}] = ${p.id}` });
    if (cascading) (p.children || []).forEach((c) => jobs.push({ id: c.id, jql: `${scope}cf[${n}] in cascadeOption(${p.id}, ${c.id})` }));
  });
  const out = {};
  await J.mapLimit(jobs.filter((j) => j.id), 8, async (j) => {
    out[j.id] = await J.countJql(j.jql).catch(() => null);
  });
  const total = await J.countJql(`${scope}cf[${n}] is not EMPTY`).catch(() => null);
  return { perOption: out, total };
};

// The impact of a plan, in words: which existing options it touches and how many work items carry them.
export const planImpact = (plan, usage) => {
  const lines = [];
  const used = (id) => (usage?.perOption?.[id] ?? null);
  plan.edits.forEach((e) => {
    const n = used(e.id);
    if (n) lines.push(`Renaming "${e.old}" changes the value in ${n} work item(s).`);
  });
  plan.disables.forEach((d) => {
    const n = used(d.id);
    if (n) lines.push(`"${d.value}" stays in ${n} work item(s) but can no longer be chosen.`);
  });
  return lines;
};

// ---------- screens ----------

// Screens of the project's create/edit/view screen schemes (for the given issue types, or all), and whether
// each screen is used by this project only. Shared screens are left alone: adding a field there would change
// other projects too.
export const projectScreens = async (projectId, issueTypeIds = []) => {
  const itss = await J.itssForProject(projectId);
  if (!itss) return [];
  const [itssProjects, mappings, allMappings, schemes, project] = await Promise.all([
    J.projectsOfItss(itss.id), J.itssMappings(itss.id), J.allItssMappings(), J.allScreenSchemes(), J.getProject(projectId).catch(() => null),
  ]);
  const itssShared = itssProjects.length > 1;
  // Each issue type has one screen scheme: its own mapping, or the default one only if it has none (a Bug with its
  // own scheme never shows the default scheme's screens).
  const schemeIds = schemesForIssueTypes(mappings, issueTypeIds.map(String), (project?.issueTypes || []).map((t) => String(t.id)));
  const itssBySchemes = {};
  allMappings.forEach((m) => {
    const k = String(m.screenSchemeId);
    itssBySchemes[k] = itssBySchemes[k] || new Set();
    itssBySchemes[k].add(String(m.issueTypeScreenSchemeId));
  });
  const screenUse = {};
  schemes.forEach((s) => Object.values(s.screens || {}).forEach((sid) => {
    screenUse[sid] = screenUse[sid] || new Set();
    screenUse[sid].add(String(s.id));
  }));
  const out = new Map();
  schemes.filter((s) => schemeIds.has(String(s.id))).forEach((s) => {
    const schemeShared = (itssBySchemes[String(s.id)]?.size || 0) > 1;
    Object.entries(s.screens || {}).forEach(([operation, sid]) => {
      const shared = itssShared || schemeShared || (screenUse[sid]?.size || 0) > 1
        || [...(screenUse[sid] || [])].some((sch) => !schemeIds.has(sch));
      if (!out.has(sid)) out.set(sid, { screenId: sid, exclusive: !shared, schemeName: s.name, operations: [] });
      out.get(sid).operations.push(operation);
    });
  });
  return [...out.values()];
};

// Smart placement: the new field goes right after the field on the tab whose name is most similar ("Contract end"
// after "Contract start"), or after the last field of the same type; otherwise it stays at the end.
const bestNeighbour = (fieldName, typeKey, have, all) => {
  let best = null;
  have.forEach((f) => {
    const score = similarity(f.name, fieldName);
    if (score >= 0.45 && (!best || score > best.score)) best = { id: f.id, name: f.name, score };
  });
  if (best) return best;
  const sameType = have.filter((f) => all[f.id] && all[f.id] === typeKey);
  return sameType.length ? { id: sameType[sameType.length - 1].id, name: sameType[sameType.length - 1].name } : null;
};

// onlyScreenIds: the screens the requester ticked (null = all of the project's own screens). Shared screens are
// never touched, even when someone sends their id.
export const addFieldToScreens = async (fieldId, projectId, issueTypeIds, onlyScreenIds = null) => {
  const wanted = onlyScreenIds ? new Set(onlyScreenIds.map(String)) : null;
  const screens = (await projectScreens(projectId, issueTypeIds)).filter((s) => !wanted || wanted.has(String(s.screenId)));
  // UC-05: at the bottom of the first tab. "smart" (admin page) puts it next to the most similar field instead.
  const smart = (await getSettings()).screenPlacement === 'smart';
  const added = [];
  const skipped = [];
  let types = null;
  let me = null;
  for (const s of screens) {
    const name = await J.screenName(s.screenId);
    if (!s.exclusive) {
      skipped.push(name);
      continue;
    }
    const tabs = await J.screenTabs(s.screenId);
    if (!tabs.length) continue;
    const have = await J.tabFields(s.screenId, tabs[0].id);
    if (!have.some((f) => f.id === fieldId)) {
      await J.addTabField(s.screenId, tabs[0].id, fieldId);
      if (smart && !types) {
        const custom = await J.customFields();
        types = Object.fromEntries(custom.map((f) => [f.id, shortType(f.schema?.custom)]));
        me = custom.find((f) => f.id === fieldId);
      }
      const n = smart && me ? bestNeighbour(me.name, types[fieldId], have, types) : null;
      if (n && n.id !== have[have.length - 1]?.id) {
        await J.moveTabField(s.screenId, tabs[0].id, fieldId, n.id).then(() => { s.after = n.name; }).catch(() => null);
      } else if (n) s.after = n.name;
    }
    added.push(s.after ? `${name} (after "${s.after}")` : name);
  }
  return { added, skipped };
};

// ---------- field health ----------

// Work items with a value, per field: on the whole site, or in one space (projectKey), as the app sees them. One
// stored record per scope; counts older than COUNT_TTL are counted again, eight at a time, within the time budget.
// Fields Jira cannot count (e.g. Approvals, development) stay null: unknown, never "unused". `pending` = fields still
// without a fresh count.
const countsKey = (projectKey) => (projectKey ? `health:valuecounts:${projectKey}` : 'health:valuecounts');
export const valueCounts = async (fieldIds, { budgetMs = 12000, projectKey = null } = {}) => {
  const key = countsKey(projectKey);
  const cache = (await kvs.get(key).catch(() => null)) || {};
  const t0 = Date.now();
  const todo = fieldIds.filter((id) => !countFresh(cache[id], t0));
  let changed = false;
  await J.mapLimit(todo, 8, async (id) => {
    if (Date.now() - t0 > budgetMs) return;
    const n = String(id).replace('customfield_', '');
    const jql = projectKey ? `project = "${projectKey}" AND cf[${n}] is not EMPTY` : `cf[${n}] is not EMPTY`;
    const count = await J.countJql(jql).catch(() => null);
    // The last activity: the newest update of a work item with a value (only fields that have values).
    const last = count > 0 ? await J.latestUpdated(jql).catch(() => null) : null;
    cache[id] = { v: COUNT_VERSION, n: typeof count === 'number' ? count : null, last, at: Date.now() };
    changed = true;
  });
  // Only fields that still exist are kept, so the record does not grow with deleted fields.
  if (changed) {
    const keep = Object.fromEntries(Object.entries(cache).filter(([id]) => fieldIds.includes(id) || countFresh(cache[id])));
    await kvs.set(key, keep).catch(() => null);
  }
  const now = Date.now();
  return {
    counts: Object.fromEntries(fieldIds.map((id) => [id, cache[id] ? cache[id].n : null])),
    lasts: Object.fromEntries(fieldIds.map((id) => [id, cache[id] ? cache[id].last || null : null])),
    pending: fieldIds.filter((id) => !countFresh(cache[id], now)).length,
  };
};

// The fields on any of the space's screens (its own and the shared ones): "on this space's screens".
export const projectScreenFieldIds = async (projectId) => {
  const screens = await projectScreens(projectId, []);
  const ids = new Set();
  await J.mapLimit(screens, 4, async (s) => {
    const tabs = await J.screenTabs(s.screenId).catch(() => []);
    for (const tab of tabs || []) {
      const fields = await J.tabFields(s.screenId, tab.id).catch(() => []);
      (fields || []).forEach((f) => ids.add(f.id));
    }
  });
  return ids;
};

// Field health in one of two scopes.
//   site (Jira administrators, no `project`): every changeable custom field of the site, values counted over the whole
//        site, "on no screen" from Jira's screen count, duplicates across all fields.
//   project (project administrators, `project` given): only the fields the space uses (relevantToProject, from the
//        overview's context scopes), values counted in the space, "not on this space's screens", duplicates only
//        among the fields the space sees. Nothing about other spaces' fields or work items is returned.
// project = { key, fields: overview rows ({ id, scope }), onScreens: Set of field IDs, incomplete }.
export const fieldHealth = async (projectId, { budgetMs, project = null } = {}) => {
  const all = await J.fieldsWithUsage();
  const open = all.filter((f) => !f.isLocked);
  const now = Date.now();
  if (!project) {
    const { counts, lasts, pending } = await valueCounts(open.map((f) => f.id), { budgetMs });
    const rows = open.map((f) => {
      const values = counts[f.id];
      const { flags, lastUsed } = healthFlags(f, values, now, { lastActivity: lasts[f.id] });
      return { id: f.id, name: f.name, type: typeLabel(f.schema?.custom), typeKey: shortType(f.schema?.custom), lastUsed, values, screens: f.screensCount, contexts: f.contextsCount, flags };
    });
    markDuplicates(rows, open);
    return {
      scope: 'site',
      countsPending: pending,
      siteCustomFields: all.length,
      lockedFields: all.length - open.length,
      projectFields: rows.length,
      flagged: rows.filter((r) => r.flags.length).length,
      rows: sortRows(rows),
    };
  }
  const scopeOf = new Map((project.fields || []).map((f) => [f.id, f.scope]));
  const candidates = open.filter((f) => scopeOf.has(f.id));
  const { counts, lasts, pending } = await valueCounts(candidates.map((f) => f.id), { budgetMs, projectKey: project.key });
  const rows = [];
  candidates.forEach((f) => {
    const values = counts[f.id];
    const onScreen = project.onScreens ? project.onScreens.has(f.id) : f.screensCount !== 0;
    if (!relevantToProject(scopeOf.get(f.id), { onScreen, values })) return;
    const { flags, lastUsed } = healthFlags(f, values, now, { scope: 'project', onScreen, lastActivity: lasts[f.id] });
    rows.push({ id: f.id, name: f.name, type: typeLabel(f.schema?.custom), typeKey: shortType(f.schema?.custom), lastUsed, values, screens: onScreen ? 1 : 0, onScreen, contextScope: scopeOf.get(f.id), flags });
  });
  markDuplicates(rows, candidates);
  return {
    scope: 'project',
    countsPending: pending,
    scopePending: !!project.incomplete,
    projectFields: rows.length,
    flagged: rows.filter((r) => r.flags.length).length,
    rows: sortRows(rows),
  };
};

// Possible duplicates: very similar names and the same type, among `pool` (all fields for the site scope, the
// space's fields for the project scope).
const markDuplicates = (rows, pool) => {
  rows.forEach((r) => {
    const dup = pool.find((o) => o.id !== r.id && shortType(o.schema?.custom) === r.typeKey && similarity(o.name, r.name) >= RULES.similarity);
    if (dup) r.flags.push({ code: 'duplicate', text: `Possible duplicate of "${dup.name}" (${dup.id})`, fieldId: dup.id, name: dup.name });
  });
};
const sortRows = (rows) => rows.sort((a, b) => b.flags.length - a.flags.length || a.name.localeCompare(b.name));

// ---------- impact radar ----------

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Saved filters whose JQL mentions the field, and which of them also mention one of the given values (renamed or
// disabled options). Read as the user: only filters the user may see. mine = the user owns it (can be fixed).
export const filtersMentioning = async (field, values = [], accountId = null, asUser = true) => {
  const n = cfNum(field.id);
  const nameRe = new RegExp(`"${escapeRe(field.name)}"`, 'i');
  let all;
  try {
    all = await J.visibleFilters(asUser);
  } catch (e) {
    return { checked: false, note: `Saved filters could not be read (${e.message.slice(0, 80)}).`, filters: [] };
  }
  const hits = all.filter((f) => f.jql && (f.jql.includes(`cf[${n}]`) || f.jql.includes(`customfield_${n}`) || nameRe.test(f.jql)));
  const lower = values.map((v) => v.toLowerCase());
  return {
    checked: true,
    scanned: all.length,
    filters: hits.map((f) => ({
      id: f.id, name: f.name, owner: f.owner?.displayName || '', mine: !!accountId && f.owner?.accountId === accountId,
      mentionsValue: lower.filter((v) => f.jql.toLowerCase().includes(v)), jql: f.jql,
    })),
  };
};

// Automation rules that use the field, from the index 16_automation_index.py stores on the approval space.
export const automationRulesFor = async (fieldId, approvalProjectKey) => {
  const idx = await J.getProjectProperty(approvalProjectKey, 'cfs-automation-index');
  if (!idx) return { indexed: false, rules: [], note: 'Automation rules are not checked on this site yet.' };
  return { indexed: true, at: idx.at, rules: (idx.fields || {})[fieldId] || [] };
};

// The rename of an option inside a filter's JQL: "Old" -> "New" in quoted values only.
export const renameInJql = (jql, from, to) => jql.replace(new RegExp(`(["'])${escapeRe(from)}\\1`, 'gi'), (m, q) => `${q}${to}${q}`);
