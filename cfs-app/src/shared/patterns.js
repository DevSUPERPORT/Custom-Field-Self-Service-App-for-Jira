/**
 * Pure pattern detection for the nightly suggestions: "Key: Value" in summaries, key-value labels, and text fields
 * that only ever hold a handful of values and would work better as a dropdown.
 *
 * @file        src/shared/patterns.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Nightly suggestions: information people keep typing by hand that a field would capture better.
//   1. "Key: Value" in summaries ("Region: EMEA - laptop broken", "[Channel: Phone] ...")
//   2. labels shaped key-value ("channel-web", "channel-phone")
//   3. text fields that only ever hold a handful of values (better as a dropdown)
// Pure functions: the scheduled job feeds them work items, the tests feed them samples.

import { similarity } from './guidelines.js';

const KEY_VALUE = /(?:^|[[(\s|,;])([A-Za-zÄÖÜäöü][A-Za-zÄÖÜäöüß ]{1,24}?)\s*:\s*([A-Za-z0-9ÄÖÜäöüß][A-Za-z0-9ÄÖÜäöüß .&/-]{0,30}?)(?=$|[\])|,;]| - | – )/g;
const STOP = new Set(['re', 'fw', 'fwd', 'aw', 'wg', 'http', 'https', 'note', 'todo', 'info', 'subject', 'betreff']);

const titleCase = (s) => s.trim().replace(/\s+/g, ' ').replace(/(^|\s)\S/g, (m) => m.toUpperCase());

const bump = (map, key, value, ref) => {
  const k = key.toLowerCase();
  if (!map[k]) map[k] = { key: titleCase(key), values: {}, count: 0, examples: [] };
  const e = map[k];
  const v = value.trim();
  e.values[v.toLowerCase()] = e.values[v.toLowerCase()] || { value: v, count: 0 };
  e.values[v.toLowerCase()].count += 1;
  e.count += 1;
  if (e.examples.length < 3 && ref && !e.examples.includes(ref)) e.examples.push(ref);
};

// issues: [{ key, summary, labels }]; existingNames: names of fields the project already has. ignorePrefixes: label
// prefixes that are not information (the app's own cfs-* labels, project keys).
export const detectPatterns = (issues, existingNames = [], { minCount = 4, minValues = 2, maxValues = 30, ignorePrefixes = [] } = {}) => {
  const ignore = new Set(ignorePrefixes.map((p) => p.toLowerCase()));
  const found = {};
  issues.forEach((i) => {
    const s = String(i.summary || '');
    let m;
    KEY_VALUE.lastIndex = 0;
    // eslint-disable-next-line no-cond-assign
    while ((m = KEY_VALUE.exec(s))) {
      const key = m[1].trim();
      if (!STOP.has(key.toLowerCase()) && !ignore.has(key.toLowerCase()) && key.split(' ').length <= 3) bump(found, key, m[2], i.key);
    }
    const prefixes = {};
    (i.labels || []).forEach((l) => {
      const mm = /^([a-z][a-z]{2,20})[-_:]([a-z0-9][a-z0-9_-]{0,30})$/i.exec(l);
      if (mm && !prefixes[mm[1].toLowerCase()] && !ignore.has(mm[1].toLowerCase())) {
        prefixes[mm[1].toLowerCase()] = true;
        bump(found, mm[1], mm[2], i.key);
      }
    });
  });
  return Object.values(found)
    .map((e) => ({ ...e, values: Object.values(e.values).sort((a, b) => b.count - a.count) }))
    .filter((e) => e.count >= minCount && e.values.length >= minValues && e.values.length <= maxValues)
    .filter((e) => !existingNames.some((n) => similarity(n, e.key) >= 0.8))
    .sort((a, b) => b.count - a.count)
    .map((e) => ({ kind: 'pattern', key: e.key, count: e.count, values: e.values, examples: e.examples }));
};

// values: the text field's values in recent work items. A dropdown suggestion when few distinct short values repeat.
export const textToDropdown = (values, { minItems = 6, maxDistinct = 12, maxLength = 40 } = {}) => {
  const clean = values.map((v) => String(v || '').trim()).filter(Boolean);
  if (clean.length < minItems) return null;
  const counts = {};
  clean.forEach((v) => {
    const k = v.toLowerCase();
    counts[k] = counts[k] || { value: v, count: 0 };
    counts[k].count += 1;
  });
  const distinct = Object.values(counts).sort((a, b) => b.count - a.count);
  if (distinct.length > maxDistinct || distinct.length < 2) return null;
  if (distinct.some((d) => d.value.length > maxLength)) return null;
  if (distinct.length / clean.length > 0.6) return null; // mostly unique: real free text
  return { items: clean.length, values: distinct };
};
