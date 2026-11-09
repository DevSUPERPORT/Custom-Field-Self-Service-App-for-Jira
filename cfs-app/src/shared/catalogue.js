/**
 * Field catalogue of standard fields SUPERPORT has pre-approved: parsing and formatting the one-entry-per-line text
 * from the admin page, and matching a request against it so catalogue fields are green or reused.
 *
 * @file        src/shared/catalogue.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Field catalogue: standard fields SUPERPORT has pre-approved. A request that matches an entry is green; an entry
// that already has a field ID is reused instead of creating another copy.
//
// Text format on the admin page, one entry per line:
//   Name | type | option; option; ... | description | customfield_12345 (optional)

import { ALLOWED } from './fieldtypes.js';
import { similarity } from './guidelines.js';

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export const parseCatalogue = (text) => {
  const entries = [];
  const errors = [];
  String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).forEach((line, i) => {
    const [name, type, opts, description, fieldId] = line.split('|').map((x) => (x || '').trim());
    const t = ALLOWED.find((a) => a.key === (type || '').toLowerCase() || a.label.toLowerCase() === (type || '').toLowerCase());
    if (!name || !t) {
      errors.push(`Line ${i + 1}: needs "Name | type" with a type key like select, textfield, multiselect.`);
      return;
    }
    if (fieldId && !/^customfield_\d+$/.test(fieldId)) {
      errors.push(`Line ${i + 1}: "${fieldId}" is not a field ID (customfield_12345).`);
      return;
    }
    entries.push({
      id: slug(name),
      name,
      typeKey: t.key,
      options: t.options ? String(opts || '').split(';').map((o) => o.trim()).filter(Boolean) : [],
      description: description || `${name} (standard field from the catalogue)`,
      fieldId: fieldId || '',
    });
  });
  return { entries, errors };
};

export const formatCatalogue = (entries = []) => entries
  .map((e) => [e.name, e.typeKey, (e.options || []).join('; '), e.description || '', e.fieldId || ''].join(' | ').replace(/( \| )+$/, ''))
  .join('\n');

// The catalogue entry a request means: same type and (nearly) the same name.
export const matchCatalogue = (entries = [], name, typeKey) => {
  let best = null;
  entries.forEach((e) => {
    if (typeKey && e.typeKey !== typeKey) return;
    const score = similarity(e.name, name);
    if (score >= 0.8 && (!best || score > best.score)) best = { entry: e, score };
  });
  return best ? best.entry : null;
};

export const findEntry = (entries = [], ref) => {
  const r = String(ref || '').trim().toLowerCase();
  return entries.find((e) => e.id === r || e.name.toLowerCase() === r || e.fieldId === r)
    || matchCatalogue(entries, ref, null);
};
