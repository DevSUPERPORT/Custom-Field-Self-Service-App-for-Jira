/**
 * Jira custom field types in plain language, and the list of types a project admin may request; every other type is
 * only shown by name in the overview.
 *
 * @file        src/shared/fieldtypes.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Field types in plain language. ALLOWED is the list a project admin may request (proposal until the product owner
// provides the final guidelines); every other type is only shown by name in the overview.

const P = 'com.atlassian.jira.plugin.system.customfieldtypes:';

export const ALLOWED = [
  { key: 'textfield', label: 'Text (single line)', searcher: 'textsearcher' },
  { key: 'textarea', label: 'Paragraph', searcher: 'textsearcher' },
  { key: 'float', label: 'Number', searcher: 'exactnumber' },
  { key: 'datepicker', label: 'Date', searcher: 'daterange' },
  { key: 'datetime', label: 'Date and time', searcher: 'datetimerange' },
  { key: 'select', label: 'Select list (single)', searcher: 'multiselectsearcher', options: true },
  { key: 'multiselect', label: 'Select list (multiple)', searcher: 'multiselectsearcher', options: true },
  { key: 'multicheckboxes', label: 'Checkboxes', searcher: 'multiselectsearcher', options: true },
  { key: 'radiobuttons', label: 'Radio buttons', searcher: 'multiselectsearcher', options: true },
  // Existing cascading fields stay readable and editable; new ones are never created (SUPERPORT, 2026-10-26: the type
  // causes problems for everyone). Use two select lists instead.
  { key: 'cascadingselect', label: 'Cascading select', searcher: 'cascadingselectsearcher', options: true, cascading: true, create: false },
  { key: 'userpicker', label: 'User picker (single)', searcher: 'userpickergroupsearcher' },
  { key: 'labels', label: 'Labels', searcher: 'labelsearcher' },
];

const OTHER = {
  multiuserpicker: 'User picker (multiple)',
  grouppicker: 'Group picker (single)',
  multigrouppicker: 'Group picker (multiple)',
  url: 'URL',
  readonlyfield: 'Text (read only)',
  version: 'Version picker (single)',
  multiversion: 'Version picker (multiple)',
  project: 'Project picker',
};

export const OPTION_TYPES = new Set(ALLOWED.filter((t) => t.options).map((t) => t.key));

// The types a new field can have.
export const CREATABLE = ALLOWED.filter((t) => t.create !== false);
export const isCreatable = (key) => CREATABLE.some((t) => t.key === key);

export const shortType = (schemaCustom = '') => schemaCustom.split(':').pop();

export const isSystemType = (schemaCustom = '') => schemaCustom.startsWith(P);

export const typeLabel = (schemaCustom = '') => {
  const k = shortType(schemaCustom);
  const t = ALLOWED.find((a) => a.key === k);
  if (t && isSystemType(schemaCustom)) return t.label;
  if (OTHER[k] && isSystemType(schemaCustom)) return OTHER[k];
  return `Other (${k})`;
};

export const typeByKey = (key) => ALLOWED.find((t) => t.key === key);

export const fullType = (key) => P + key;
export const fullSearcher = (key) => P + typeByKey(key).searcher;
