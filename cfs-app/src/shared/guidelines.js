/**
 * Deterministic guideline check for new custom field requests (types, naming, options, duplicates), so the same
 * request always gets the same result. The form runs it live and the backend runs it again before anything is
 * created.
 *
 * @file        src/shared/guidelines.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Guideline check for new custom field requests. Deterministic, so the same request always gets the same
// result. The rules are a proposal from the briefing; the product owner provides the final ones. Change them here only:
// the form uses this for the live check and the backend runs it again before anything is created.

import { typeByKey, isCreatable } from './fieldtypes.js';

export const RULES = {
  nameMin: 3,
  nameMax: 40,
  nameChars: /^[\p{L}\p{N} \-/&()]+$/u,
  maxOptions: 100,
  maxOptionLength: 60,
  similarity: 0.8, // normalised edit-distance ratio from which two names count as "very similar"
};

// Names of Jira system fields a custom field must not reuse (checked case-insensitively, together with the
// system field names the site itself reports).
export const SYSTEM_FIELD_NAMES = [
  'Summary', 'Description', 'Status', 'Priority', 'Due date', 'Assignee', 'Reporter', 'Labels', 'Components',
  'Fix versions', 'Affects versions', 'Resolution', 'Resolved', 'Created', 'Updated', 'Environment',
  'Attachment', 'Comment', 'Issue type', 'Work type', 'Project', 'Key', 'Sprint', 'Parent', 'Time tracking',
  'Original estimate', 'Remaining estimate', 'Time spent', 'Watchers', 'Votes', 'Security level',
  'Start date', 'Rank', 'Team', 'Story points', 'Flagged', 'Request type', 'Organizations', 'Approvers',
];

export const LEVELS = { green: 0, yellow: 1, red: 2 };

const normalise = (s) => (s || '')
  .toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]/g, '');

const levenshtein = (a, b) => {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
};

export const similarity = (a, b) => {
  const x = normalise(a);
  const y = normalise(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
};

// "Parent > Child" lines for cascading selects, one value per line otherwise.
export const parseOptions = (text, cascading) => {
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!cascading) return lines.map((value) => ({ value }));
  const parents = [];
  lines.forEach((line) => {
    const [p, c] = line.split('>').map((s) => (s || '').trim());
    let parent = parents.find((x) => x.value === p);
    if (!parent) {
      parent = { value: p, children: [] };
      parents.push(parent);
    }
    if (c) parent.children.push({ value: c });
  });
  return parents;
};

export const suggestName = (name, projectKeys = [], nameMax = RULES.nameMax) => {
  let s = (name || '').trim().replace(/\s+/g, ' ');
  projectKeys.forEach((k) => {
    s = s.replace(new RegExp(`^\\[?${k}\\]?\\s*[-:_]?\\s*`, 'i'), '');
  });
  s = s.replace(/[^\p{L}\p{N} \-/&()]/gu, '').replace(/\s+/g, ' ').trim();
  if (s) s = s[0].toUpperCase() + s.slice(1);
  return s.slice(0, nameMax).trim();
};

const dupes = (values) => {
  const seen = new Map();
  const out = [];
  values.forEach((v) => {
    const k = v.toLowerCase();
    if (seen.has(k)) out.push(`"${seen.get(k)}" / "${v}"`);
    else seen.set(k, v);
  });
  return out;
};

/**
 * draft: { name, description, typeKey, optionsText, global, projectKeys, justification }
 * ctx:   { customFields: [{ id, name, typeKey }], systemFieldNames: [string] }
 * returns { result: 'green' | 'yellow' | 'red', findings: [{ level, code, message, suggestion?, fieldId? }], options }
 */
export const checkNewField = (draft, ctx) => {
  const findings = [];
  const add = (level, code, message, extra = {}) => findings.push({ level, code, message, ...extra });
  const R = { ...RULES, ...(ctx.rules || {}) };
  const name = draft.name || '';
  const type = (R.allowedTypes && !R.allowedTypes.includes(draft.typeKey)) || !isCreatable(draft.typeKey) ? null : typeByKey(draft.typeKey);
  const keys = draft.projectKeys || [];

  // Required inputs
  if (!name.trim()) add('red', 'name-missing', 'Enter a field name.');
  if (!(draft.description || '').trim()) add('red', 'description-missing', 'Enter a description so others know what the field is for.');
  if (!(draft.justification || '').trim()) add('red', 'justification-missing', 'Enter a short justification.');
  if (!draft.global && keys.length === 0) add('red', 'projects-missing', 'Choose at least one project.');

  // Field type on the allowed list
  if (!type && draft.typeKey === 'cascadingselect') add('red', 'type-not-allowed', 'Cascading select is not offered for new fields: use two select lists instead (for example "Brand" and "Model").');
  else if (!type) add('red', 'type-not-allowed', 'This field type is not on the allowed list.');

  // Naming convention
  if (name.trim()) {
    const problems = [];
    if (name !== name.trim() || /\s{2,}/.test(name)) problems.push('no leading, trailing or double spaces');
    if (name.trim().length < R.nameMin || name.trim().length > R.nameMax) problems.push(`${R.nameMin}–${R.nameMax} characters`);
    if (!RULES.nameChars.test(name.trim())) problems.push('letters, digits, spaces and - / & ( ) only');
    if (name.trim()[0] && name.trim()[0] !== name.trim()[0].toUpperCase()) problems.push('starts with a capital letter');
    if (keys.some((k) => new RegExp(`^\\[?${k}\\]?\\s*[-:_ ]`, 'i').test(name.trim()))) problems.push('no project key prefix');
    if (problems.length) {
      const suggestion = suggestName(name, keys, R.nameMax);
      add('red', 'naming', `Naming convention: ${problems.join('; ')}.`, suggestion && suggestion !== name ? { suggestion } : {});
    }
  }

  // System field collision
  const sys = new Set([...SYSTEM_FIELD_NAMES, ...(ctx.systemFieldNames || []), ...(R.extraForbiddenNames || [])].map((s) => s.toLowerCase()));
  if (name.trim() && sys.has(name.trim().toLowerCase())) add('red', 'system-field', `"${name.trim()}" is a Jira system field or a reserved name.`);

  // Same or very similar existing custom field
  if (name.trim() && type) {
    const hits = (ctx.customFields || [])
      .map((f) => ({ ...f, score: similarity(name, f.name) }))
      .filter((f) => f.score >= R.similarity)
      .sort((a, b) => b.score - a.score);
    const sameType = hits.filter((f) => f.typeKey === draft.typeKey);
    if (sameType.length) {
      const f = sameType[0];
      add('yellow', 'similar-field',
        `${f.score === 1 ? 'A field with the same name' : 'A very similar field'} of the same type exists: "${f.name}" (${f.id}). Consider extending its context to your project instead of creating a new field.`,
        { fieldId: f.id });
    } else if (hits.some((f) => f.score === 1)) {
      const f = hits.find((h) => h.score === 1);
      // Not in the briefing's table: an identical name with a different type is legal in Jira but confusing
      // in JQL and filters, so SUPERPORT decides.
      add('yellow', 'name-taken', `The name "${f.name}" is already used by a field of another type (${f.id}). A Jira administrator approves this.`);
    }
  }

  // Options
  let options = [];
  if (type && type.options) {
    options = parseOptions(draft.optionsText, type.cascading);
    const values = options.map((o) => o.value);
    const all = type.cascading ? [...values, ...options.flatMap((o) => o.children.map((c) => `${o.value} > ${c.value}`))] : values;
    if (!values.length) add('red', 'options-missing', 'A select field needs at least one option.');
    const d = dupes(values);
    if (d.length) add('red', 'options-duplicate', `Duplicate options (upper/lower case ignored): ${d.join(', ')}.`);
    if (type.cascading) {
      options.forEach((o) => {
        const dc = dupes(o.children.map((c) => c.value));
        if (dc.length) add('red', 'options-duplicate', `Duplicate options under "${o.value}": ${dc.join(', ')}.`);
      });
    }
    if (all.length > R.maxOptions) add('red', 'options-limit', `At most ${R.maxOptions} options (${all.length} entered).`);
    const long = all.filter((v) => v.length > R.maxOptionLength);
    if (long.length) add('red', 'option-length', `Options may have at most ${R.maxOptionLength} characters: ${long.slice(0, 3).join(', ')}.`);
  }

  // Global context
  if (draft.global) add('yellow', 'global-context', 'A global context affects every project. A Jira administrator approves this.');

  // Duplicate the Rovo agent spotted (other wording or language, e.g. "Kostenstelle" vs "Cost centre").
  // The agent only names the field; the consequence (yellow, SUPERPORT decides) is fixed here.
  if (draft.aiSimilarTo && !findings.some((f) => f.code === 'similar-field')) {
    const f = (ctx.customFields || []).find((x) => x.id === draft.aiSimilarTo);
    if (f) add('yellow', 'ai-similar', `Rovo flagged "${f.name}" (${f.id}) as a possible duplicate. A Jira administrator decides whether a new field is needed.`, { fieldId: f.id });
  }

  const result = findings.reduce((acc, f) => (LEVELS[f.level] > LEVELS[acc] ? f.level : acc), 'green');
  return { result, findings, options };
};
