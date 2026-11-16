# Marketplace readiness checklist

State on 2026-11-09. ✅ done · ⏳ open (who acts is named).

## App and code

| Requirement | State | Where |
| --- | --- | --- |
| Forge app, production environment deployed as a tagged build | ✅ | `deploy-company.ps1`, SUPERPORT ops `state.json` |
| `forge lint`: no errors | ✅ | 4 warnings: the bulk Rovo actions are kept but not on the agent while bulk changes are off |
| Unit tests pass | ✅ | `cfs-app/test`, 130 tests |
| Scopes minimal and explained | ✅ | [SECURITY-AND-PRIVACY.md](SECURITY-AND-PRIVACY.md#scopes-and-why-each-is-needed) |
| No external egress ("Runs on Atlassian") | ✅ | manifest has no `external` permissions; `forge deploy` reports the app eligible |
| Personal data reporting and erasure | ✅ | `src/privacy.js`, weekly with the digest trigger |
| Paid via Atlassian: `app.licensing.enabled: true` | ✅ | manifest; released as a major version (`deploy-company.ps1 -ApproveMajor`) |
| License check | ✅ | `src/license.js`: blocks when Atlassian reports the license inactive (`active` or the older `isActive` false); no license object never blocks |
| DEV version for the team without licenses (Forge development environment, `install-dev.ps1`) | ✅ | Tagged DEV build in App Status → Development; not installed on a site yet |
| Emergency switch (pause / offline) wired to App Status and the status page | ✅ | `src/maintenance.js`; tested live on production, see the test report |
| Security vulnerability policy | ✅ | [SECURITY.md](../../SECURITY.md), contact dev@superport.digital |
| Vulnerability scan (Ecoscanner) clean | ⏳ Atlassian | Runs after the app is linked to the Marketplace listing |

## Account and listing

| Requirement | State | What to do |
| --- | --- | --- |
| Marketplace partner account for SUPERPORT | ✅ exists | Developer space SUPERPORT `11c4b5b8-6d0b-4388-a51f-ac53831216f4` is public on the Marketplace (partner 977327938; Group and Screen Self-Service live there). Managing it needs two-step verification |
| App in the partner's developer space | ✅ | Transferred on 2026-11-09 from SUPERPORT `13d44d18…` to the public SUPERPORT `11c4b5b8…`; app ID, environments, releases and App Status unchanged |
| App distribution set to "Sharing" | ✅ | Sharing with anyone |
| Listing text, highlights, links | ✅ | [LISTING.md](LISTING.md) |
| Logo 144 × 144, banner 1120 × 548, 3 screenshots 1840 × 900 | ✅ | [assets/](assets/) |
| Pricing: paid, free up to 10 users | ✅ proposal / ⏳ SUPERPORT | Tiers in [LISTING.md](LISTING.md#pricing-proposal-per-user-per-month-annual--10--monthly-set-by-atlassian); align the website's savings calculator |
| EULA URL | ✅ | https://www.superport.digital/en/apps/eula (covers this app); additions in [EULA-SUPPLEMENT.md](../legal/EULA-SUPPLEMENT.md) for the website |
| Privacy policy URL | ✅ | https://www.superport.digital/en/privacy; app notice ready: [privacy-policy.html](../legal/privacy-policy.html) |
| Documentation URL | ✅ | https://www.superport.digital/en/apps/custom-field-self-service |
| Support | ✅ | dev@superport.digital (a public support-portal URL can replace it) |
| Data security & privacy questionnaire | ✅ (answers) | [SECURITY-AND-PRIVACY.md](SECURITY-AND-PRIVACY.md) |
| Review guide for Atlassian | ✅ | [REVIEW-GUIDE.md](REVIEW-GUIDE.md) |
| Cloud Fortified (optional) | ⏳ later | Needs the security self-assessment and SLA |

## Submitting

1. Developer console (dev@superport.digital): Distribution → Sharing; fill the distribution details.
2. Partner portal (SUPERPORT's partner account): Create listing → Forge app → choose this app; "Paid via Atlassian".
3. Copy [LISTING.md](LISTING.md), upload [assets/](assets/), enter the pricing tiers, the URLs and the privacy answers.
4. Submit for approval; attach [REVIEW-GUIDE.md](REVIEW-GUIDE.md) for the reviewer.
5. After approval: superportdev and other installs accept the new major version in Jira → Apps → Manage apps.
