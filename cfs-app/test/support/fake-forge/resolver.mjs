/**
 * The real @forge/resolver (plain JavaScript, no runtime needed), handed to the backend as an ES module default
 * export the way Forge's bundler does, so the tests call resolvers exactly as Jira would.
 *
 * @file        test/support/fake-forge/resolver.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export default require('@forge/resolver').default;
