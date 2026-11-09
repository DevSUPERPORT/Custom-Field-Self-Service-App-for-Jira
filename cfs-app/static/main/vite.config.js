/**
 * Vite configuration of the Custom UI (project page and admin page): relative asset paths for Forge's static
 * resource, output to build/, no source maps. The dev server alone adds a stand-in Forge bridge so the kill switch
 * screens can be previewed locally with ?maintenance=on|readonly.
 *
 * @file        static/main/vite.config.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local preview only (`npm run dev`, never the build Forge serves): a stand-in for Jira's Custom UI bridge that refuses
// every call, so the page starts outside Jira and ?maintenance=on|readonly can show the kill switch screens.
const localPreview = {
  name: 'cfs-local-preview',
  apply: 'serve',
  transformIndexHtml: () => [{
    tag: 'script',
    injectTo: 'head-prepend',
    children: "window.__cfsLocalPreview = true; window.__bridge = { callBridge: () => Promise.reject(new Error('Local preview: not running inside Jira.')) };",
  }],
};

// Custom UI is served from the app's static resource: relative asset paths, one bundle, no source maps.
export default defineConfig({
  plugins: [react(), localPreview],
  base: './',
  build: { outDir: 'build', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
});
