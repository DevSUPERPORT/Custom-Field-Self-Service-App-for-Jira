# Review guide — Custom Field Self-Service for Jira

This guide takes an Atlassian reviewer from install to every main flow in about 30 minutes. The app runs only on
Atlassian (Forge); nothing outside Atlassian is needed.

## What you need

| Item | Why |
| --- | --- |
| A Jira Cloud site with Jira Service Management | Approval requests are raised in a service space |
| Two accounts: a **Jira administrator** and a **project administrator** of one software space who is not a Jira administrator | The two roles see different things |
| One software space (for example `TEST`) and one service space (for example `APPR`) | The pilot space and the approval space |

## 1. Install and set up (Jira administrator, 5 minutes)

1. Install the app on the site and approve its scopes (explained in
   [SECURITY-AND-PRIVACY.md](SECURITY-AND-PRIVACY.md#scopes-and-why-each-is-needed)).
2. Open **Settings → Apps → Custom Field Self-Service for Jira**. The admin page opens with a setup checklist.
3. Choose the pilot space `TEST`, the approval space `APPR` and yourself as approver; save.
4. Open **Site check** and run it. Use the one-click fixes it offers (for example "Create the hidden request type",
   "Create the self-test field"). Every line should be green or explained.

## 2. Jira administrator flows (10 minutes)

| # | Do | Expect |
| --- | --- | --- |
| A1 | `TEST` → Space settings → Custom Field Self-Service | The project's fields with usage counts |
| A2 | **New field** → pick "Dropdown", name it "Review Priority", add options High/Low → preview → create | The guideline check passes, the field is created on the space's screens, the audit log shows it |
| A3 | Open the field → add option "Medium", rename "Low" to "Minor" → preview | Before/after picture and the number of affected work items |
| A4 | Save | Done at once (Jira administrator); a notification offers **Undo** |
| A5 | Click **Undo** in the notification (or in the audit log) | The options are back as before; the audit log shows both entries |
| A6 | Admin page → Guidelines → add the reserved name "Customer" | Saved |

## 3. Project administrator flows (10 minutes)

Sign in as the project administrator.

| # | Do | Expect |
| --- | --- | --- |
| P1 | `TEST` → Space settings → Custom Field Self-Service | The same page; the admin page is not visible to this user |
| P2 | Try to create a field named "Customer" | Refused by the guideline from A6, with the reason |
| P3 | Request option "Urgent" on "Review Priority" | A request is raised in `APPR`; **My requests** shows it as waiting |
| P4 | Open any work item in `TEST` → **•••** → **Request a custom field** | A short form; the request goes to the project administrators first |
| P5 | Open **Field Assistant** in Rovo → "Add an option Critical to Review Priority" | The agent previews the change and asks for confirmation before raising a request |

Back as the Jira administrator: **Requests for you** shows P3 with a before/after picture → **Approve** → the option
appears in the field and the requester is notified. **Reject** works the same way with a reason.

## 4. Safety features (5 minutes)

| # | Do | Expect |
| --- | --- | --- |
| S1 | As project administrator, ask for an option change on a field used in many work items | Two-person rule: two approvals are needed |
| S2 | Admin page → Safe mode on | Direct changes stop; requests still work |
| S3 | Emergency switch (SUPERPORT only; we can demonstrate it on request) | Read-only: banner and disabled change buttons; offline: "temporarily unavailable" page |

## Where to look in the code

| Concern | File |
| --- | --- |
| Every entry point passes the emergency switch and the license check | `cfs-app/src/index.js`, `src/maintenance.js`, `src/license.js` |
| Role checks on the server | `cfs-app/src/jira.js` (permissions), `src/service.js` |
| Guard rails (daily limit, two-person rule, safe mode) | `cfs-app/src/guards.js` |
| Approval flow | `cfs-app/src/approvals.js` |
| Audit log and undo | `cfs-app/src/audit.js`, `src/shared/undo.js` |
| Personal data reporting | `cfs-app/src/privacy.js`, `src/shared/personal.js` |
| Tests | `cfs-app/test/*.test.mjs` (`npm test`) |

## Contact during the review

SUPERPORT, dev@superport.digital. We can give the reviewer a pre-configured test
site on request.
