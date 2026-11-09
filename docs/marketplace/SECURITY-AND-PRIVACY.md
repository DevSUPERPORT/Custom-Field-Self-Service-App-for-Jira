# Security and privacy

Custom Field Self-Service for Jira is an Atlassian Forge app that runs entirely on Atlassian's platform: it calls no
service outside Atlassian, keeps its data in Forge storage, and acts only within the permissions Jira gives it.

| Item | Answer |
| --- | --- |
| Hosting | Atlassian Forge (Runs on Atlassian): functions, storage and Custom UI are hosted by Atlassian |
| Data egress | None. The manifest declares no external fetch or remote; the code calls only Jira and Jira Service Management REST APIs through Forge |
| Data residency | Follows the customer's Forge data residency (Forge storage) |
| Authentication | Jira sign-in only; the app has no logins, passwords or tokens of its own |
| Secrets in code | None |
| Personal data | Atlassian account IDs only (who requested, approved or changed something); reported weekly to Atlassian, erased for closed accounts |
| AI | The Rovo agent "Field Assistant" uses Atlassian Rovo; it acts only through the app's own actions, with the user's rights, and previews every change before the user confirms it |
| Vulnerability handling | See SECURITY.md in the repository root and the emergency switch below |

## Scopes and why each is needed

| Scope | Used for |
| --- | --- |
| `read:jira-work` | Read custom fields, contexts, options, screens and work item counts (JQL) to show fields, usage and impact |
| `write:jira-work` | Create and comment approval requests; copy values when a text field is converted to a dropdown |
| `read:jira-user` | Show people's names, check a user's permissions in a project |
| `manage:jira-configuration` | Create custom fields, contexts and options, change options and defaults, put fields on screens, after the guideline check or an approval |
| `manage:jira-project` | Read a project's screen schemes and issue type screen schemes to find screens only that project uses |
| `read:servicedesk-request`, `write:servicedesk-request` | Raise approval requests in the approval space chosen by the Jira administrator, read and record approvals |
| `read:requesttype:jira-service-management`, `write:requesttype:jira-service-management` | Find the approval request type, and create a hidden one if the approval space has none |
| `storage:app` | Settings, audit log, approval records, undo snapshots, caches |

## Who can do what

The role is checked with Jira on the server for every call; the browser never decides it.

| Person | Can |
| --- | --- |
| Jira administrator | Configure the app (admin page), see the health of every field of the site, change fields directly (logged, undoable), approve requests |
| Project administrator | See the fields of their project (field health: only the fields their space uses, counted in their space; nothing about other spaces' fields or work items), request changes (approved by a Jira administrator unless the admin page allows direct option changes for fields only their project uses), undo their own changes as a request |
| Other users | Request a field from a work item; the project administrators decide first |

Guard rails on every change path: safe mode, a daily limit of direct changes per person, a two-person rule for changes
that touch many work items, a check that the approver is allowed and is not the requester, and a field lock against
parallel changes. Every executed change is written to the audit log with the person, time, old and new value.

## Data the app stores (Forge storage)

| Data | Contains | Kept |
| --- | --- | --- |
| Settings | Approval space, approvers (account IDs), guideline rules, catalogue | Until changed |
| Audit log | Who, when, which field, old and new value, approver, request key | Retention set by the Jira administrator (0 = keep); deleted nightly after that |
| Approval records | The requested change, requester and approvers, decision | With the audit log |
| Undo snapshots | The options of a field before a change | Needed for undo |
| Drafts, plans | A person's unsent form and Field Assistant previews | Plans 15 minutes; drafts 7 days |
| Caches | Field overview, option catalogue, usage suggestions | Minutes to a day, refreshed automatically |

## Personal data reporting

Once a week (the `weekly-digest` scheduled trigger runs it after the digest, `src/privacy.js`) the app reports every account ID it keeps to Atlassian's
personal data reporting API in batches of at most 90. For every account Atlassian reports as closed, the app replaces
the account ID with `closed-account` in records the site needs (audit log, requests) and deletes the records about that
person alone (drafts, tour, last visit, daily quota). Covered by `test/personal.test.mjs`.

## Emergency switch (kill switch)

SUPERPORT can pause or stop the app for every customer within about a minute, without shipping new code:

| Mode | Users see | The app does |
| --- | --- | --- |
| off | The app as usual | Everything |
| readonly | "Changes are paused" banner, change buttons disabled | Reads only; no writes to Jira, no e-mails, no approvals executed |
| on | "Temporarily unavailable" page with a link to the status page | Nothing; every resolver, Rovo action and scheduled job stops first |

The mode is the Forge environment variable `APP_MAINTENANCE`, read only on the server (`src/maintenance.js`).
Customers, Jira administrators and anyone reading the front-end code cannot change it: there is no setting, URL or
resolver for it, and unknown values fail closed to "on". SUPERPORT switches it with its ops tooling, which redeploys the
exact live build by its tag and updates the public status page https://superapps.statuspage.io. Covered by
`test/maintenance.test.mjs` and verified live on production on 2026-11-06.

## Licensing

The app is paid via Atlassian (`app.licensing.enabled: true`, free for up to 10 users). When Atlassian reports a site's
license as inactive (`active` or the older `isActive` false), every page, work item action and Rovo action stops with a
clear message and changes nothing (`src/license.js`). Installs without a license object — not from the Marketplace, or
the development and staging environments SUPERPORT's team uses — are not affected.
