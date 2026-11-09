/**
 * Test double of @forge/realtime: records every live event the backend would publish to open pages.
 *
 * @file        test/support/fake-forge/realtime.mjs
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import { record } from './record.mjs';

export const publishGlobal = async (channel) => { record('realtime', { channel }); };
export const publish = async (channel) => { record('realtime', { channel }); };
