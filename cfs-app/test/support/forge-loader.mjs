/**
 * Module loader hook for the backend tests: resolves the backend's extension-less imports the way Forge's bundler
 * does, and swaps the Forge runtime modules for the recording test doubles in fake-forge/.
 *
 * @file        test/support/forge-loader.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

const FAKES = { '@forge/api': 'api.mjs', '@forge/kvs': 'kvs.mjs', '@forge/realtime': 'realtime.mjs', '@forge/resolver': 'resolver.mjs' };

export async function resolve(specifier, context, next) {
  if (FAKES[specifier]) return { url: new URL(`./fake-forge/${FAKES[specifier]}`, import.meta.url).href, shortCircuit: true };
  if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) && /\/src\//.test(context.parentURL || '')) return next(`${specifier}.js`, context);
  return next(specifier, context);
}
