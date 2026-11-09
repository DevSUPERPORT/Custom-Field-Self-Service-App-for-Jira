/**
 * Marketplace licensing: when the app is installed from the Atlassian Marketplace with licensing switched on, Forge
 * passes the site's license with every call. An inactive license (trial ended, not renewed) stops the app with a clear
 * message; an install without a license object (a private install, or licensing not switched on) is not affected.
 *
 * @file        src/license.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-06
 * @updated     2026-11-06
 */

export const LICENSE_MESSAGE = 'The Custom Field Self-Service for Jira license of this site is not active. Nothing was changed. A Jira administrator can renew it under Jira settings > Apps > Manage apps.';

/** True when Forge says the site's license is not active. Missing license data never blocks. */
export const licenseInactive = (context) => {
  const lic = context && context.license;
  // Atlassian reports `active`; `isActive` is the older, deprecated name. Either one false means inactive. No license
  // object (free, not from the Marketplace, development/staging environments) never blocks.
  return !!lic && typeof lic === 'object' && (lic.active === false || lic.isActive === false);
};

/** The answer a resolver or Rovo action gives instead of doing the work, or null. */
export const licenseRefusal = (context) => (licenseInactive(context) ? { error: LICENSE_MESSAGE, unlicensed: true, nothingChanged: true } : null);
