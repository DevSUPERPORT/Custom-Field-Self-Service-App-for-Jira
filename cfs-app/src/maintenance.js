/**
 * SUPERPORT's kill switch: reads the Forge environment variable APP_MAINTENANCE (off, readonly or on; unknown values
 * fail closed to on) and gives every resolver, Rovo action and trigger one way to refuse work while the app is paused
 * or down. Customers cannot change it: it is read only here, on the server.
 *
 * @file        src/maintenance.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// The switch is the Forge environment variable APP_MAINTENANCE of the app's environment:
//   off (or unset) - normal operation
//   readonly       - everything can be viewed, nothing can be changed (no writes to Jira, no e-mails, no alerts)
//   on             - the app refuses every request; the pages show "temporarily unavailable"
//
// Who can flip it: only the app's owner, with the Forge CLI (`forge variables set` followed by a deploy), in practice
// through the SUPERPORT ops panel. Customers, Jira admins and anyone who reads the Custom UI bundle cannot: the value
// lives in Atlassian's runtime, is read only on the server, and the app has no resolver, setting or URL that changes
// it. Nothing a caller sends (payload, context) is ever looked at here. The app holds no Forge or Statuspage
// credentials.
//
// Deliberately free of imports, so the tests can load it on its own.

/** Public status page shown to users while the app is paused or down. */
export const STATUS_PAGE_URL = 'https://superapps.statuspage.io';

const VAR = 'APP_MAINTENANCE';

/** 'off' | 'readonly' | 'on'. Anything that isn't one of the known values counts as 'on' (fail closed). */
export const maintenanceMode = (env = process.env) => {
  const raw = String((env && env[VAR]) ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'off') return 'off';
  if (raw === 'readonly' || raw === 'read-only') return 'readonly';
  return 'on';
};

const APP = 'Custom Field Self-Service for Jira';
// The same words as the pages (static/main/src/Maintenance.jsx), plus the status page link.
export const UNAVAILABLE_MESSAGE = `${APP} is temporarily unavailable. We've paused ${APP} for maintenance to keep your data safe. Nothing you've saved is lost, and we'll be back as soon as possible. You can follow the progress on our status page: ${STATUS_PAGE_URL}`;
export const READONLY_MESSAGE = `Changes are paused for maintenance to keep your data safe. You can still view everything; editing will be back as soon as possible. Status page: ${STATUS_PAGE_URL}`;

export class Unavailable extends Error {
  constructor(message, mode) {
    super(message);
    this.code = 'unavailable';
    this.mode = mode;
  }
}

/**
 * Throws when the app is down (any request) or read-only (requests that change something). kind is 'read' or
 * 'write'; anything other than 'read' counts as a write.
 */
export const requireAvailable = (kind) => {
  const mode = maintenanceMode();
  if (mode === 'on') throw new Unavailable(UNAVAILABLE_MESSAGE, mode);
  if (mode === 'readonly' && kind !== 'read') throw new Unavailable(READONLY_MESSAGE, mode);
};

/**
 * The answer a resolver or Rovo action gives instead of doing the work, or null when it may run. The pages and the
 * Rovo agent already read { error }; unavailable and mode tell the page to show the maintenance screens.
 */
export const refusal = (kind) => {
  try {
    requireAvailable(kind);
    return null;
  } catch (e) {
    return { error: e.message, unavailable: true, mode: e.mode, nothingChanged: true };
  }
};

/** The one resolver that must still answer while the app is down, so the page can say so. */
export const AVAILABILITY = 'availability';

/**
 * Routes every resolver.define of a Resolver through the kill switch: a resolver named in `reads` runs as a read,
 * every other one as a write. Keep `reads` an explicit allow-list, so a new resolver is blocked in read-only mode
 * unless it is added there on purpose.
 */
export const gateResolvers = (resolver, reads) => {
  const define = resolver.define.bind(resolver);
  resolver.define = (name, fn) => define(name, name === AVAILABILITY ? fn : async (req) => refusal(reads.has(name) ? 'read' : 'write') || fn(req));
  return resolver;
};

/** The 'availability' resolver: signed-in callers only, and it tells nothing but the mode and the status page. */
export const availability = async (req) => {
  if (!req?.context?.accountId) return { error: 'Sign in to Jira to use Custom Field Self-Service for Jira.', forbidden: true };
  return { mode: maintenanceMode(), statusUrl: STATUS_PAGE_URL };
};

/** A Rovo action behind the kill switch: kind 'read' still answers in read-only mode, 'write' does not. */
export const gateAction = (kind, fn) => async (...args) => refusal(kind) || fn(...args);

/**
 * Scheduled and event triggers: may this job run? 'read' jobs (cache warming, the app's own housekeeping) run unless
 * the app is down; 'write' jobs (anything that changes Jira, raises alerts or sends e-mails) only when the switch is off.
 */
export const mayRun = (kind) => {
  const mode = maintenanceMode();
  return mode === 'off' || (mode === 'readonly' && kind === 'read');
};
