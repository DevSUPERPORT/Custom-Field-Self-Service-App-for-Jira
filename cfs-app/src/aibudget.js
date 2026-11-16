/**
 * SUPERPORT's AI stop: reads the Forge environment variable AI_BUDGET, which SUPERPORT's App Status app sets (with a
 * redeploy, like APP_MAINTENANCE) to turn the AI features off on every site at once. Customers cannot change it: it is
 * read only here, on the server.
 *
 * @file        src/aibudget.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-16
 * @updated     2026-11-16
 */

// Contract (App Status, kind "rovo"): compact JSON {"stop":false}; {"stop":true} = AI features off on every site.
// Unset, empty, invalid JSON or any other shape counts as {"stop":false} (the customer's switch still defaults to off)
// and is logged once per value. Other fields are ignored.
//
// Deliberately free of imports, so the tests can load it on its own.

const VAR = 'AI_BUDGET';
const warned = new Set();

/** True only when AI_BUDGET is a JSON object with stop === true. */
export const vendorAiStop = (env = process.env, warn = console.warn) => {
  const raw = String((env && env[VAR]) ?? '').trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.stop === 'boolean') return parsed.stop === true;
  if (!warned.has(raw)) {
    warned.add(raw);
    warn(`${VAR} is ${raw ? 'not {"stop":true|false}' : 'not set'}; AI features are not stopped by the vendor.`);
  }
  return false;
};

/** What every Rovo action answers while SUPERPORT has stopped the AI features. */
export const AI_STOPPED_MESSAGE = 'AI features of this app are temporarily turned off by the app vendor. Please try again later.';
