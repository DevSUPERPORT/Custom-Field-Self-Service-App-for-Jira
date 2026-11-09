/**
 * Entry point of the Custom UI: picks the language, switches on Jira's theme, and renders the project page or the
 * admin control centre behind the kill switch gate.
 *
 * @file        static/main/src/main.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { view } from '@forge/bridge';
import '@fontsource-variable/inter/wght.css';
import './styles.css';
import { setLocale, getLang, onLangChange } from './i18n';
import App from './App';
import { MaintenanceGate } from './Maintenance';

// One build for both places: the project settings page and Jira settings → Apps (the admin page module). The admin
// page's code is a chunk of its own, so the project page - opened far more often - loads less before it can start.
// Outside Jira (the local preview of the maintenance screens, see ui.jsx) the bridge throws at once: the page still starts.
const start = async () => {
  Promise.resolve().then(() => view.theme.enable()).catch(() => null);
  const ctx = await Promise.resolve().then(() => view.getContext()).catch(() => ({}));
  setLocale(ctx.locale || (import.meta.env.DEV ? new URLSearchParams(window.location.search).get('lang') : undefined));
  const admin = ctx.moduleKey === 'cfs-admin';
  const Page = admin ? (await import('./admin/AdminApp')).default : App;
  createRoot(document.getElementById('root')).render(<Root Page={Page} />);
};

// The language switch: the page starts again in the chosen language (its data comes back from the cache at once).
// SUPERPORT's kill switch comes first: the page loads only once the server has said it is not down.
function Root({ Page }) {
  const [lang, setLang] = useState(getLang());
  useEffect(() => onLangChange(setLang), []);
  return <MaintenanceGate><Page key={lang} /></MaintenanceGate>;
}
start();
