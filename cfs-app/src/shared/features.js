/**
 * Feature switches shared by the backend and the page. Bulk changes are switched off for everyone (decision of
 * 2026-11-04); the code stays for a later release.
 *
 * @file        src/shared/features.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// bulk: one option change across many fields (Bulk changes tab, Field Assistant's bulk actions, undo of a bulk
// change). Switched off for everyone on 2026-11-04 by decision of SUPERPORT; the code stays for a later release.
// To bring it back: set bulk to true, add the four bulk actions to the Rovo agent again (manifest.yml), deploy.
export const FEATURES = Object.freeze({ bulk: false });

export const BULK_OFF = 'Bulk changes are not available in this version of Custom Field Self-Service for Jira. Change the fields one by one, or ask Field Assistant for single changes.';
