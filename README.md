# Custom Field Self-Service for Jira

A SUPERPORT app for Jira Cloud, built on Atlassian Forge. Project administrators look after the custom fields of their
own project — create fields, add or rename dropdown options, put fields on screens — within guidelines their Jira
administrator sets. Changes that need it go to a Jira administrator for approval in Jira Service Management; every
executed change is logged and can be undone.

| | |
| --- | --- |
| Vendor | SUPERPORT P.C. (superport.digital) |
| Platform | Atlassian Forge, Jira Cloud (Jira Service Management for approvals) |
| Runs on Atlassian | Yes: no calls outside Atlassian, data in Forge storage |
| Version | 1.1.0, Marketplace version 3.1.0 (see [CHANGELOG.md](CHANGELOG.md)) |
| App ID | `ari:cloud:ecosystem::app/73eb7d75-cffc-403c-899b-1406d0b3826d` |
| Payment | Paid via Atlassian, free for up to 10 users |

This repository holds the app's source code, its tests and the documents for the Atlassian Marketplace review.

## For the Atlassian Marketplace review

| Document | What it covers |
| --- | --- |
| [docs/marketplace/REVIEW-GUIDE.md](docs/marketplace/REVIEW-GUIDE.md) | How to install, set up and test the app as a reviewer, step by step, and where to look in the code |
| [docs/marketplace/SECURITY-AND-PRIVACY.md](docs/marketplace/SECURITY-AND-PRIVACY.md) | Scopes and why, roles, stored data, personal data reporting, emergency switch, licensing |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability, how SUPERPORT responds |
| [PRIVACY.md](PRIVACY.md) | App privacy notice |
| EULA | https://www.superport.digital/en/apps/eula |
| Privacy policy | https://www.superport.digital/en/privacy |
| Documentation | https://www.superport.digital/en/apps/custom-field-self-service |
| Contact | dev@superport.digital |

## What it does

- **Project settings page** (project administrators): the project's custom fields with usage, options editor with a
  preview of the impact, new fields from a catalogue, field health with clean-up suggestions, "Requests for you" for
  decisions, an audit log with undo.
- **Jira admin page** (Jira administrators): which projects use the self-service, approval space and approvers,
  guidelines (naming, limits, reserved names), safe mode, site readiness check with one-click fixes.
- **Work item action** "Request a custom field": anyone can ask for a field; project administrators decide first.
- **Rovo agent "Field Assistant"**: the same requests in a conversation; every change is previewed and runs only after
  the user confirms.
- **Guard rails**: guideline check, approval by a Jira administrator, two-person rule for large changes, daily limit,
  field lock, safe mode, undo.
- **Emergency switch**: SUPERPORT can pause changes or take the app offline for all customers within a minute
  (see [SECURITY-AND-PRIVACY.md](docs/marketplace/SECURITY-AND-PRIVACY.md#emergency-switch-kill-switch)).
- **License check**: an inactive Marketplace license stops the app with a clear message and changes nothing.

## Repository layout

```
cfs-app/                 the Forge app
  manifest.yml           modules, scopes, scheduled jobs
  src/                   back end (resolvers, Rovo actions, triggers)
    maintenance.js       emergency switch: every entry point passes it first
    license.js           Marketplace license check
    privacy.js           weekly personal data report and erasure of closed accounts
    shared/              pure logic, shared with the tests and the UI
    frontend/            UI Kit work item action
  static/main/           Custom UI (React) for the project and admin pages
  agent/prompt.txt       Field Assistant instructions
  test/                  unit tests (node --test), fake Forge modules in test/support
docs/marketplace/        review guide, security and privacy
```

## Build and test

Requires Node.js 22 or later (the app runs on Forge's `nodejs24.x` runtime) and the Forge CLI.

```bash
cd cfs-app
npm ci
npm test            # unit tests (128)
npm run lint        # eslint
npm run build:ui    # Custom UI
forge lint
```

## Ownership

© 2026 SUPERPORT P.C. All rights reserved; see [LICENSE](LICENSE). The source code is published for the Atlassian
Marketplace review; it is not licensed for reuse.
