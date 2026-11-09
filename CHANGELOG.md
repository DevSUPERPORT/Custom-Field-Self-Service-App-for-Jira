# Changelog

## 1.1.0 — 2026-11-09 (Marketplace listing version)

- Paid via Atlassian: licensing switched on (a major Forge version; existing installs accept it in Manage apps).
- License check honours Atlassian's current `active` flag as well as the deprecated `isActive`.
- Review documents, app privacy notice; EULA at superport.digital.

## 1.0.2 — 2026-11-09

- Field health: "Last used" shows when a work item with a value was last updated, because Jira tracks the last use
  of only a few fields (most showed nothing although they had values); "not used for 180 days" uses the same date.
  The field page's "last value change" became "last used" with the same date. Dates are written unambiguously.
- Fields: a space that has its own context while the field also has a global one is marked "Only this space ·
  global for other spaces"; the field page marks the context the space uses ("Used here") and describes the global one
  as "every other space without its own context".
- The Forge development and staging environments are never license-checked.

## 1.0.1 — 2026-11-06

- Field health: "Unused" now means no work item on the site has a value (counted per field, cached six hours);
  Jira's own usage tracking is unavailable for most fields, so Unused used to show 0.
- Field health: clean-up suggestions built from the findings (values on no screen, no value and no screen, never
  filled in, duplicates, stale), with Show / Select actions; "Suggestions" no longer shows 0 next to many findings.
- Field health: findings shown in the page's language; "With a value" column; the Field Assistant gets the same data.
- `npm run lint` lints the back end on Windows too.
- Field health per role: project admins see only the fields their space uses, counted in their space and checked
  against their space's screens; Jira admins see every changeable field of the site.

## 1.0.0 — 2026-11-06 (Marketplace release candidate)

- **Emergency switch**: SUPERPORT can pause changes (read-only) or take the app offline for all customers through its
  ops tooling and App Status. Open pages follow the switch within 20–60 seconds: a "changes are paused" banner with
  every change button disabled, or a "temporarily unavailable" page that comes back by itself.
- **Personal data reporting**: weekly report of stored account IDs to Atlassian; closed accounts are erased.
- **Marketplace license check**: an inactive license stops the app with a clear message.
- **Releases are tagged**, so the emergency switch always redeploys the live build.
- While changes are paused, every change button is disabled with the reason; a page coming back into view checks the
  switch at once.
- Dependencies: Forge packages updated; patched versions of prosemirror-view, fast-uri, glob and minimatch pinned
  (`npm audit`: 0 vulnerabilities).
- The personal data report runs inside the weekly trigger (Forge allows five scheduled triggers).
- Bulk changes are switched off for everyone (code kept behind a feature flag for a later release).

## 0.9 — 2026-11-05

- Emergency switch on the server (`APP_MAINTENANCE`) for every resolver, Rovo action and scheduled job.

## 0.8 — 2026-11-03

- "Requests for you" shows the requested change as a before/after picture.
- Undo from the audit log and from the notification after a change; project administrators' undo goes to approval.
- Fixes from the live tests as Jira administrator and project administrator in the test space.
