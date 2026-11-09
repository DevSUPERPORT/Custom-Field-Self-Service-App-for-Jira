# Security policy

## Reporting a vulnerability

Please report security problems in Custom Field Self-Service for Jira privately, not in a public issue:

- E-mail: **dev@superport.digital** (SUPERPORT P.C.)
- Or through Atlassian's Marketplace security reporting (Ecosystem security), which reaches SUPERPORT as the vendor.

Include the site (if any), the steps to reproduce and what you expected. We acknowledge every report within two
business days.

## How SUPERPORT responds

| Severity (CVSS) | Fix released within |
| --- | --- |
| Critical | 2 weeks (Atlassian's requirement: 4 weeks) |
| High | 4 weeks (Atlassian: 6 weeks) |
| Medium | 8 weeks (Atlassian: 8 weeks) |
| Low | 12 weeks (Atlassian: 25 weeks) |

While a fix is prepared we can **pause changes** (read-only) or **take the app offline** for every customer within
about a minute, without shipping code, and say so on the public status page https://superapps.statuspage.io. The
switch is a server-side Forge environment variable that customers cannot change; details in
[docs/marketplace/SECURITY-AND-PRIVACY.md](docs/marketplace/SECURITY-AND-PRIVACY.md#emergency-switch-kill-switch).

## Design

- Runs on Atlassian (Forge). No calls to anything outside Atlassian, no remote back end, no secrets in the code.
- Every role check runs on the server against Jira (`mypermissions`, global permissions); the browser decides nothing.
- Every write path checks the guidelines, the approver, the two-person rule and the field lock, and is logged.
- Dependencies are the official `@forge/*` packages and React. `npm audit --omit=dev` is checked before each release
  (0 vulnerabilities on 2026-11-06); patched versions of transitive libraries are pinned with npm `overrides`.
