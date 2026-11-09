/**
 * The page side of SUPERPORT's kill switch: asks the server for the mode before the project or admin page loads,
 * shows a full "temporarily unavailable" page with a shield-and-wrench maintenance visual while the app is down, and
 * a "changes are paused" banner while it is read-only. Both link to the public status page through Jira's router.
 *
 * @file        static/main/src/Maintenance.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useEffect, useState } from 'react';
import { t } from './i18n';
import { Icon, Mark, Skeleton, checkAvailability, onMaintenance, openStatusPage } from './ui';

const APP = 'Custom Field Self-Service for Jira';

// The maintenance visual: the app's shield (safety) with a wrench (maintenance) on the accent tint, in the app's
// tokens, so it follows Jira's light and dark theme.
export const MaintenanceArt = () => (
  <svg className="maint-art" viewBox="0 0 160 160" role="img" aria-label={t('Under maintenance')}>
    <circle className="maint-art-ring" cx="80" cy="80" r="76" />
    <circle className="maint-art-disc" cx="80" cy="80" r="62" />
    <path className="maint-art-shield" d="M80 34l34 12v26c0 24-15 42-34 50-19-8-34-26-34-50V46z" />
    <path className="maint-art-wrench" d="M93 62a13 13 0 0 0-17 15L62 91a5 5 0 0 0 7 7l14-14a13 13 0 0 0 15-17l-8 8-6-1-1-6z" />
    <circle className="maint-art-dot" cx="122" cy="40" r="9" />
    <path className="maint-art-pause" d="M119 36v8M125 36v8" />
  </svg>
);

// Full page while SUPERPORT has taken the app down (APP_MAINTENANCE=on). Purely informational.
export function Maintenance({ statusUrl }) {
  return (
    <div className="shell maint-page">
      <div className="setup maint-card" role="alert">
        <MaintenanceArt />
        <span className="eyebrow">{APP}</span>
        <h1>{t('{app} is temporarily unavailable', { app: APP })}</h1>
        <p className="maint-body">{t("We've paused {app} for maintenance to keep your data safe. Nothing you've saved is lost, and we'll be back as soon as possible. You can follow the progress on our status page.", { app: APP })}</p>
        <div><button type="button" className="btn dark" onClick={() => openStatusPage(statusUrl)}>{t('View status page')}<Icon name="external" /></button></div>
        <div className="maint-mark"><Mark /><span>{t('An app by SUPERPORT')}</span></div>
      </div>
    </div>
  );
}

// Banner above every page while changes are paused (APP_MAINTENANCE=readonly); the server refuses every change.
export function ReadonlyBanner({ statusUrl }) {
  return (
    <div className="maint-strip">
      <div className="banner amber" role="status">
        <Icon name="shield" />
        <div className="grow"><span>{t('Changes are paused for maintenance to keep your data safe. You can still view everything; editing will be back as soon as possible.')}</span></div>
        <button type="button" className="btn small" onClick={() => openStatusPage(statusUrl)}>{t('View status page')}<Icon name="external" /></button>
      </div>
    </div>
  );
}

// How often an open page asks for the mode: every minute in normal operation (reading calls pass in read-only mode,
// so only this check shows the banner), every 20 seconds while paused or down, so the page comes back by itself.
export const CHECK_EVERY = { off: 60000, readonly: 20000, on: 20000 };

// Wraps the page: nothing loads before the mode is known, and the page follows the mode while it is open.
export function MaintenanceGate({ children }) {
  const [state, setState] = useState(null);
  useEffect(() => {
    let alive = true;
    const off = onMaintenance((m) => { if (alive) setState(m); });
    checkAvailability().then((m) => { if (alive) setState(m); });
    return () => { alive = false; off(); };
  }, []);
  const mode = state ? state.mode : null;
  useEffect(() => {
    if (!mode) return undefined;
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') checkAvailability();
    }, CHECK_EVERY[mode] || 60000);
    return () => clearInterval(timer);
  }, [mode]);
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onShow = () => { if (document.visibilityState === 'visible') checkAvailability(); };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, []);
  if (!state) return <div className="setup"><Skeleton lines={6} /></div>;
  if (state.mode === 'on') return <Maintenance statusUrl={state.statusUrl} />;
  return (
    <>
      {state.mode === 'readonly' ? <ReadonlyBanner statusUrl={state.statusUrl} /> : null}
      {children}
    </>
  );
}
