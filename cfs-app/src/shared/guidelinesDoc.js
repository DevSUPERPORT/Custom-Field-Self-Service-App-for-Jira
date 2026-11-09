/**
 * Generates the custom field guidelines in words from the live admin settings, for Field Assistant, the admin page
 * and the Confluence guidelines page, so the three cannot drift apart.
 *
 * @file        src/shared/guidelinesDoc.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import { CREATABLE, typeByKey } from './fieldtypes.js';
import { SYSTEM_FIELD_NAMES } from './guidelines.js';

export const guidelinesMarkdown = (s) => {
  const r = s.rules;
  const types = CREATABLE.filter((t) => r.allowedTypes.includes(t.key)).map((t) => t.label);
  const reserved = [...SYSTEM_FIELD_NAMES.slice(0, 14), ...(r.extraForbiddenNames || [])];
  return `# Custom field guidelines

These rules decide what happens to a request for a new custom field or an option change. The app "Custom Field Self-Service for Jira" checks them automatically; this page is generated from the app's settings and explains them for people and for the AI agents (Field Assistant, Request Resolver, Self service).

## Who may change what

- **Project admins** change the fields of the projects they administer${s.enabledProjects.length ? ` (pilot projects: ${s.enabledProjects.join(', ')})` : ''}. The app checks this on every call.
- **Everyone else** can ask too (Field Assistant or the work item action): the request goes to the project's admins first. If one of them approves, the app carries it out; anything that touches other projects then goes to a Jira administrator as well.
- The **global default context** of a field can't be changed by anyone through the app.
- Changes run with the app's own rights and are logged: who, when, which field, old and new value. Option changes can be undone from the audit log.
- **Context for this project only:** the project admin changes options directly.
- **Context shared with other projects:** the change goes to a Jira administrator for approval, because it affects every project involved.
- **Global context:** read-only for project admins. Ask a Jira administrator.
- Options are **never deleted**, only disabled. A disabled option stays in existing work items but can no longer be chosen. Renaming an option changes the value in every work item that has it.

## Green, yellow, red

| Result | Meaning | When |
|---|---|---|
| Green | Created or changed immediately | All checks pass and the context belongs to the project only |
| Yellow | A Jira administrator approves first | A field with the same or a very similar name and the same type exists; the same name exists with another type; a global context is requested; Rovo flagged a likely duplicate in other wording or language; options of a shared context change; an existing field is reused through a shared context |
| Red | Rejected with the reason | A rule below is broken |

## Guard rails

- **Preview first:** Field Assistant shows every change with its impact (work items, saved filters, automation rules) and who must approve. It can only submit exactly that preview, by its plan ID, after you confirm; a plan expires after 15 minutes and works once.
- **Daily limit:** at most ${s.dailyQuota} direct changes per person and day; more go to a Jira administrator for approval.
- **Two-person rule:** a change that touches ${s.twoPersonThreshold} or more work items needs approval.
- **Safe mode:** when the daily self-test fails or changes come in unusually fast, every change needs a Jira administrator's approval until one has checked.${s.policyAddsOnly ? '\n- **Policy:** adding options to a shared context is approved automatically (no rename, no disable, no new order).' : ''}

## Rules for new fields

- **Name:** ${r.nameMin} to ${r.nameMax} characters, starts with a capital letter, only letters, digits, spaces and \`- / & ( )\`, no double spaces, no project key at the start. The app suggests a corrected name.
- **Not a reserved name:** for example ${reserved.join(', ')}.
- **Description and justification are required.**
- **Allowed types:** ${types.join(', ')}.
- **Options (select types):** at least one, no duplicates (upper and lower case count as the same), at most ${r.maxOptions} options of at most ${r.maxOptionLength} characters. Cascading selects are entered as "Parent > Child".
- **Similar names:** names that are at least ${Math.round(r.similarity * 100)} % alike (ignoring case and spaces) count as "very similar".

${(s.catalogue || []).length ? `## Standard fields (catalogue)

These fields are pre-approved. Asking for one of them is green; if it already exists, it is reused instead of creating a copy. Field Assistant can set several up at once ("set up the standard fields for our project").

${s.catalogue.map((e) => `- **${e.name}** (${typeByKey(e.typeKey)?.label || e.typeKey}${e.options.length ? `: ${e.options.join(', ')}` : ''})${e.fieldId ? ` = ${e.fieldId}` : ''}: ${e.description}`).join('\n')}

` : ''}## Before you request a new field

Check whether the field already exists, also under another name or in another language (for example "Kostenstelle" and "Cost centre"). Reusing a field keeps Jira fast and reports consistent: the app offers **Use this field** when it finds one, and the Field Assistant in Rovo chat does this check for you.

## Approvals

- Approval requests appear in the service space **${s.approvalProjectKey}**${s.requestTypeName ? ` (request type "${s.requestTypeName}" once it exists)` : ''}. Each one carries a briefing computed by the app: affected projects and work items, risk and a recommendation.
- Approvers are reminded after ${s.reminderHours} hours${s.backupApproverAccountIds.length ? `; after ${s.escalateHours} hours backup approvers are added` : ''}.
- The app executes the approved change, comments the result and e-mails the requester. Before it executes, it checks who approved: only an allowed approver, never the requester. Anything else is blocked and the approvers are alerted.
- Automation rules in ${s.approvalProjectKey} watch the app from the outside: requests without approvers and approved requests that were not executed raise an alert.

## How to ask

- In Jira: **Space settings → Apps → Custom fields** (overview, options, request new field, audit log, field health).
- In Rovo chat: choose the agent **Field Assistant** and describe what you need, for example "I need a dropdown Contract type in PRJ with Framework, One-off, Retainer".
- From any work item: **⋯ → Request a custom field**.
`;
};
