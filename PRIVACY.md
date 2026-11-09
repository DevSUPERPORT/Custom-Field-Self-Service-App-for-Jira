# Privacy Policy — Custom Field Self-Service for Jira

_Last updated: 9 November 2026. App-specific privacy notice; the general terms and app privacy statement of SUPERPORT are at https://www.superport.digital/en/apps/eula and https://www.superport.digital/en/privacy._

This policy explains how **Custom Field Self-Service for Jira** ("the app"), provided by **SUPERPORT P.C.**
("SUPERPORT", "we"), handles data when it is installed on an Atlassian Jira Cloud site.

## 1. Summary

- The app runs entirely on Atlassian's cloud platform (Forge, "Runs on Atlassian").
- **No data leaves Atlassian.** The app sends nothing to SUPERPORT or to any other party. SUPERPORT has no access to
  your Jira site, your work items or the data the app stores.
- The app stores only what it needs to work, inside your site's Atlassian-hosted app storage, under your Atlassian data
  residency settings.

## 2. What the app processes and stores

| Data | Why | Where / how long |
| --- | --- | --- |
| Jira configuration: custom fields, contexts, options, screens of the spaces that use the app | To show, check and change fields | Read from Jira; a cached copy is refreshed hourly |
| Atlassian account IDs of people who request, approve, change or undo something | Audit log and approval records ("who did what") | App storage; kept as long as your Jira administrator's audit retention setting says (default: kept) |
| Change details: field and option names before and after a change, approval comments | Audit log, undo | As above |
| Counts and dates: per field, how many work items have a value and when such a work item was last updated | Field health ("unused", "last used") | App storage, recounted every 6 hours; no work item content |
| Short repeated text values and up to three work item keys found in the latest 100 work items of a space | Nightly suggestions (e.g. a text field that should be a dropdown) | App storage, replaced every night |
| Per-person conveniences: an unsent form, whether the introduction tour was seen, the last visit, a daily change counter | Usability and limits | App storage; forms 7 days, the rest until the person's account is closed or the app is uninstalled |

The app does **not** store names, e-mail addresses or other profile information; names are looked up from Jira when
shown. Approval requests are created as Jira work items in the approval space your Jira administrator chooses; they are
your Jira data and follow your Jira's rules.

## 3. People who leave

Every week the app reports the account IDs it stores to Atlassian's personal data reporting service. For every account
Atlassian reports as closed, the app replaces the account ID with "closed-account" in the audit log and approval
records, and deletes the records about that person alone.

## 4. AI features

The **Field Assistant** is an Atlassian Rovo agent. Conversations are processed by Atlassian Rovo under Atlassian's
terms and settings. The app only receives the actions the agent calls, with the permissions of the person using it,
and previews every change before it is made.

## 5. Your control

- Jira administrators choose which spaces use the app, who approves, and how long the audit log is kept.
- Uninstalling the app deletes its app storage according to Atlassian's Forge data retention.
- SUPERPORT can pause or stop the app for all customers in an emergency; this never sends or exposes data.

## 6. Sub-processors

Atlassian (hosting, storage, Rovo). SUPERPORT uses no other sub-processors for this app.

## 7. Contact

Questions about privacy or data protection: **dev@superport.digital** or mail@superport.digital, SUPERPORT P.C.,
Sorou 22, 151 25 Marousi (Athens), Greece. Security reports: see our security policy (SECURITY.md).

We will update this policy when the app's data handling changes; the date above shows the latest version.
