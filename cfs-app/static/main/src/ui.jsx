/**
 * Shared UI of the Custom UI: backend calls (which follow the kill switch and say when a change is refused), icons,
 * pills, tabs, toasts, dialogs, undo helpers and motion helpers.
 *
 * @file        static/main/src/ui.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useEffect, useLayoutEffect, useState, createContext, useContext, useCallback, useRef } from 'react';
import { flushSync, createPortal } from 'react-dom';
import { invoke, rovo, router, requestJira } from '@forge/bridge';
import { t, tn, getLocale, getLang, chooseLang } from './i18n';
import appIcon from './assets/app-icon-128.png';
import { PREVIEW_READS } from '../../../src/shared/preview.js';

// ---------- backend ----------

// "View as project admin": every call asks the server for the lower role; the server lowers it only for Jira
// administrators, and only for reading calls.
let asRole = null;
export const setPreview = (on) => { asRole = on ? 'project-admin' : null; };

// When this person last changed something: the live update about their own action is not announced a second time.
let lastWrite = 0;
export const recentlyActed = (ms = 10000) => Date.now() - lastWrite < ms;

// ---------- SUPERPORT's kill switch ----------
// The server decides (APP_MAINTENANCE, read only there): 'off', 'readonly' (changes paused) or 'on' (app down). The
// page asks once before it loads anything, and every refused call updates it, so a switch made while the page is open
// shows at the next click. Nothing here can change the mode on the server.
export const STATUS_PAGE_URL = 'https://superapps.statuspage.io';
let maintenance = { mode: 'off', statusUrl: STATUS_PAGE_URL };
const maintenanceListeners = new Set();
export const getMaintenance = () => maintenance;
// True while changes are allowed. Buttons that change something are disabled while changes are paused, so nobody
// clicks into a refusal; the server refuses them anyway.
export const useCanWrite = () => {
  const [mode, setMode] = useState(maintenance.mode);
  useEffect(() => onMaintenance((m) => setMode(m.mode)), []);
  return mode === 'off';
};
export const PAUSED_HINT = () => t('Changes are paused for maintenance to keep your data safe. You can still view everything; editing will be back as soon as possible.');
export const onMaintenance = (fn) => { maintenanceListeners.add(fn); return () => maintenanceListeners.delete(fn); };
const setMaintenance = (mode, statusUrl) => {
  const next = { mode: ['off', 'readonly', 'on'].includes(mode) ? mode : 'on', statusUrl: /^https:\/\//.test(statusUrl || '') ? statusUrl : maintenance.statusUrl };
  if (next.mode === maintenance.mode && next.statusUrl === maintenance.statusUrl) return;
  maintenance = next;
  maintenanceListeners.forEach((fn) => fn(next));
};
// Local preview of the two screens without Forge: `npm run dev` in static/main, then open
// http://localhost:5173/?maintenance=on or ?maintenance=readonly (add &lang=de for German). Only the Vite dev server
// honours it (import.meta.env.DEV is false in the build Forge serves, and vite.config.js marks the local preview).
const devPreview = () => (import.meta.env.DEV && typeof window !== 'undefined' && window.__cfsLocalPreview
  ? new URLSearchParams(window.location.search).get('maintenance') : null);
// If the answer doesn't come, the page loads as usual: the server refuses every call anyway while the app is paused.
export const checkAvailability = async () => {
  const preview = devPreview();
  if (preview) { setMaintenance(preview, STATUS_PAGE_URL); return maintenance; }
  try {
    const r = await invoke('availability');
    if (r && !r.error) setMaintenance(r.mode, r.statusUrl);
  } catch (e) { /* see above */ }
  return maintenance;
};
// The public status page, opened by Jira in a new tab (the page itself runs in a sandboxed frame). Outside Jira (local
// preview) the browser opens it.
export const openStatusPage = async (url = maintenance.statusUrl) => {
  try {
    await router.open(url);
  } catch (e) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};

export const call = async (name, payload) => {
  if (!PREVIEW_READS.has(name) && name !== 'saveDraft' && name !== 'tourSeen') lastWrite = Date.now();
  const res = await invoke(name, asRole ? { ...(payload || {}), asRole } : payload);
  if (res && res.unavailable) {
    // Refused by the kill switch: said in the person's language; while the app is down the whole page switches over.
    setMaintenance(res.mode === 'readonly' ? 'readonly' : 'on');
    const e = new Error(res.mode === 'readonly'
      ? t('Changes are paused for maintenance to keep your data safe. You can still view everything; editing will be back as soon as possible.')
      : t('{app} is temporarily unavailable', { app: 'Custom Field Self-Service for Jira' }));
    e.unavailable = true;
    throw e;
  }
  if (res && res.error) {
    const e = new Error(res.error);
    e.forbidden = res.forbidden;
    e.disabled = res.disabled;
    e.canEnable = res.canEnable;
    e.configured = res.configured;
    e.unsupported = res.unsupported;
    throw e;
  }
  return res;
};

export const askAssistant = (prompt) => rovo.open({ type: 'forge', agentName: 'Field Assistant', agentKey: 'field-assistant', prompt }).catch(() => null);

// Approve / Decline: the app checks the request, then the decision is posted from the page AS THE USER through Jira's
// own connection (Jira checks the approver and asks for permission if needed), then the app carries it out. A
// rejection carries its reason, which the requester sees.
export const decideRequest = async (issueKey, decision, reason = '') => {
  const prep = await call('prepareDecide', { issueKey });
  if (prep.mode === 'jsm') {
    const res = await requestJira(prep.path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ decision: decision === 'approve' ? 'approve' : 'decline' }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Jira refused the ${decision} for ${issueKey} (HTTP ${res.status}). ${txt.slice(0, 160)}`);
    }
  }
  return call('decide', { issueKey, decision, reason, recorded: prep.mode === 'jsm' || prep.mode === 'decided' });
};

// The page runs in a sandboxed frame on another host: a plain relative link would point there. router.open opens
// the work item on the Jira site itself, in a new tab.
export const IssueLink = ({ k }) => (
  <a href={`/browse/${k}`} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); router.open(`/browse/${k}`).catch(() => null); }}>{k}</a>
);

// Dates and times in the viewer's own language and time zone.
export const when = (ts) => (ts ? new Date(ts).toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }) : '–');
export const day = (ts) => (ts ? new Date(ts).toLocaleDateString(getLocale(), { dateStyle: 'medium' }) : '–');
export const time = (ts) => new Date(ts).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });

// ---------- icons (stroke icons, 24 px grid) ----------

const P = {
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  warn: <><path d="M12 3l9 16H3z" /><path d="M12 10v4M12 17h.01" /></>,
  check: <path d="M5 12l5 5L20 7" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>,
  grip: <><circle cx="9" cy="6" r="1.2" /><circle cx="15" cy="6" r="1.2" /><circle cx="9" cy="12" r="1.2" /><circle cx="15" cy="12" r="1.2" /><circle cx="9" cy="18" r="1.2" /><circle cx="15" cy="18" r="1.2" /></>,
  az: <><path d="M4 18l3-12 3 12M5 14h4" /><path d="M14 6h6l-6 12h6" /></>,
  za: <><path d="M4 6h6L4 18h6" /><path d="M14 18l3-12 3 12M15 14h4" /></>,
  left: <path d="M15 18l-6-6 6-6" />,
  right: <path d="M9 18l6-6-6-6" />,
  down: <path d="M6 9l6 6 6-6" />,
  refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>,
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></>,
  screen: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  layers: <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></>,
  shield: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" /><path d="M10 21h4" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  inbox: <><path d="M3 13l3-8h12l3 8v6H3z" /><path d="M3 13h5l1 3h6l1-3h5" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 8v4l3 2" /></>,
  pulse: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  wand: <><path d="M4 20L16 8" /><path d="M14 4v2M18 8h2M17.5 4.5l-1.4 1.4M19 2v0" /></>,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13 7l4 4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  send: <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />,
  flag: <><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>,
  play: <path d="M7 4l12 8-12 8z" />,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3" /></>,
  pause: <><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
};
export const Icon = ({ name, className, label }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : 'true'} role={label ? 'img' : undefined} aria-label={label}>{P[name]}</svg>
);

// The SUPERPORT mark (white on ink).
// The app's own icon (Custom Field Self-Service for Jira), the same tile Jira shows in its Apps menus.
export const Mark = () => <img className="mark" src={appIcon} alt="" aria-hidden="true" />;

// A check that draws itself: success moments (toasts, "sent", "saved").
export const Tick = ({ className = 'tick' }) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M7.5 12.5l3 3 6-6.5" /></svg>
);

// ---------- toasts ----------

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

// toast(text) or toast(text, 'ok' | 'info' | 'error'): ok shows the drawing check.
// toast(text, tone, { action: { label, run }, detail }): a notification with a button (Undo, View). It stays longer and
// does not leave while the pointer is on it. run() may return { text, tone } to show the outcome in the same place,
// or { close: true } to just close it.
const TOAST_MS = 5600;
const ACTION_MS = 12000;
export const ToastHost = ({ children }) => {
  const [items, setItems] = useState([]);
  const timers = useRef(new Map());
  const patchItem = (id, p) => setItems((x) => x.map((it) => (it.id === id ? { ...it, ...p } : it)));
  const drop = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    patchItem(id, { out: true });
    setTimeout(() => setItems((x) => x.filter((it) => it.id !== id)), 300);
  }, []);
  const schedule = useCallback((id, ms) => {
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => drop(id), ms));
  }, [drop]);
  const push = useCallback((text, tone = 'info', opts = {}) => {
    const id = Math.random();
    setItems((x) => [...x.slice(-3), { id, text, tone, action: opts.action || null, detail: opts.detail || '' }]);
    schedule(id, opts.ms || (opts.action ? ACTION_MS : TOAST_MS));
    return id;
  }, [schedule]);
  const act = async (it) => {
    clearTimeout(timers.current.get(it.id));
    patchItem(it.id, { busy: true });
    try {
      const r = (await it.action.run()) || {};
      if (r.close) { drop(it.id); return; }
      patchItem(it.id, { busy: false, action: null, detail: '', text: r.text || t('Done.'), tone: r.tone || 'ok' });
    } catch (e) {
      patchItem(it.id, { busy: false, action: null, detail: '', text: e.message, tone: 'error' });
    }
    schedule(it.id, TOAST_MS + 1500);
  };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((it) => (
          <div key={it.id} className={`toast ${it.out ? 'out' : ''} ${it.action ? 'has-action' : ''}`}
            onMouseEnter={() => { if (it.action && !it.busy) clearTimeout(timers.current.get(it.id)); }}
            onMouseLeave={() => { if (it.action && !it.busy) schedule(it.id, 4000); }}>
            {it.busy ? <Spinner /> : it.tone === 'ok' ? <Tick /> : it.tone === 'error' ? <Icon name="warn" className="tick" /> : <Icon name="bell" className="ticon" />}
            <span className="toast-text">{it.busy ? t('Working…') : it.text}{it.detail && !it.busy ? <small>{it.detail}</small> : null}</span>
            {it.action && !it.busy ? <button type="button" className="toast-act" onClick={() => act(it)}>{it.action.icon ? <Icon name={it.action.icon} /> : null}{it.action.label}</button> : null}
            {!it.busy ? <button type="button" className="toast-x" aria-label={t('Dismiss')} onClick={() => drop(it.id)}><Icon name="x" /></button> : null}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
};

// ---------- undo (notifications, audit log, bulk changes) ----------

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// Every open view reloads (useAutoRefresh listens): after an undo from a notification, nothing on the page is stale.
export const refreshViews = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('cfs:refresh')); };
// Runs one undo on the server and says what happened, in words for the notification. payload: { batchId } |
// { adminOpId } | { jobId }. A bulk change is driven to its end here (the server also finishes it in the background).
export const performUndo = async (payload) => {
  const r = await call('undo', payload).finally(() => setTimeout(refreshViews, 400));
  if (r.status === 'bulk') {
    let job = r.job;
    for (let i = 0; job && job.status === 'undoing' && i < 200; i += 1) {
      await pause(600);
      job = (await call('bulkRun', { jobId: job.id })).job;
    }
    const u = job?.undo?.progress || {};
    return { text: job?.status === 'undone' ? tn(u.done || 0, 'Undone: {n} field is back as before.', 'Undone: {n} fields are back as before.') : t('Undo started; it finishes in the background.'), tone: 'ok' };
  }
  return undoOutcome(r);
};
export const undoOutcome = (r) => {
  if (r.status === 'pending') return { text: t('Undo sent for approval as {key}.', { key: r.issueKey }), tone: 'ok' };
  if (r.status === 'undone') return { text: t('Undone.'), tone: 'ok' };
  if (r.status === 'done') return { text: tn((r.rows || []).length, 'Undone: {n} change.', 'Undone: {n} changes.'), tone: 'ok' };
  if (r.status === 'invalid') return { text: (r.errors || []).join(' '), tone: 'error' };
  return { text: t('Nothing to undo: already in that state.'), tone: 'info' };
};

// ---------- small pieces ----------

export const Loz = ({ tone, children }) => <span className={`loz ${tone || ''}`}>{children}</span>;

export const Msg = ({ tone = 'info', title, children }) => (
  <div className={`msg ${tone}`} role={tone === 'error' ? 'alert' : undefined}>{title ? <strong>{title}</strong> : null}{children}</div>
);

// A quiet note with an icon, as in the SUPERPORT design.
export const Note = ({ icon = 'info', tone = '', children }) => (
  <div className={`note ${tone}`}><Icon name={icon} /><div className="note-body">{children}</div></div>
);

export const Skeleton = ({ lines = 6 }) => <div aria-busy="true" aria-label={t('Loading')}>{Array.from({ length: lines }, (_, i) => <div key={i} className="skel" style={{ width: `${55 + ((i * 37) % 45)}%`, animationDelay: `${i * 80}ms` }} />)}</div>;

export const Empty = ({ icon = 'inbox', title, children }) => (
  <div className="empty enter"><Icon name={icon} /><strong className="ink">{title}</strong>{children ? <span>{children}</span> : null}</div>
);

export const Spinner = () => <span className="spin" aria-hidden="true" />;

// The five statuses of requests and audit entries (UC-03, UC-07).
const STATUS_TEXT = { waiting: 'Waiting for approval', done: 'Done', fail: 'Fail', rejected: 'Rejected', withdrawn: 'Withdrawn' };
const STATUS_ICON = { done: 'check', fail: 'warn', rejected: 'x', withdrawn: 'undo' };
export const Status = ({ s }) => (
  <span className={`st ${s}`}>{s === 'waiting' ? <span className="d" /> : <Icon name={STATUS_ICON[s] || 'info'} />}{t(STATUS_TEXT[s] || s)}</span>
);
export const statusText = (s) => t(STATUS_TEXT[s] || s);

// Context scope of a field (UC-01): Only-project, Multiple, Global, System.
export const Ctx = ({ f }) => {
  if (f.scope === 'system') return <span className="ctx system">{t('System')}</span>;
  if (f.scope === 'global') return <span className="ctx global">{t('Global')}</span>;
  if (f.scope === 'shared') return <span className="ctx shared" title={(f.sharedWith || []).map((p) => (p.key ? `${p.key} ${p.name}` : p.name)).join(', ')}>{t('Multiple · {n} spaces', { n: (f.sharedWith || []).length })}</span>;
  // Its own context here; other spaces may use the field's global context (changes here never reach them).
  if (f.alsoGlobal) {
    return <span className="ctx project" title={t('This space has its own context: changes here affect only this space. Other spaces use the field\'s global context.')}><span className="d" />{t('Only this space')} <span className="muted">· {t('global for other spaces')}</span></span>;
  }
  return <span className="ctx project"><span className="d" />{t('Only this space')}</span>;
};

// ---------- motion helpers ----------

// Animates a number from its previous value to the new one.
export const CountUp = ({ value, decimals = 0, ms = 900 }) => {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const target = Number(value) || 0;
    if (still()) { setShown(target); from.current = target; return undefined; }
    const start = performance.now();
    const a = from.current;
    let raf;
    const step = (now) => {
      const k = Math.min(1, (now - start) / ms);
      const e = 1 - (1 - k) ** 4;
      setShown(a + (target - a) * e);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return <span className="num">{shown.toLocaleString(getLocale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</span>;
};

// FLIP: children with data-flip="<key>" glide from their old place to the new one when the list changes order.
export const useFlip = (ref, deps) => {
  const last = useRef(new Map());
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const now = new Map();
    el.querySelectorAll(':scope > [data-flip]').forEach((node) => {
      const r = node.getBoundingClientRect();
      now.set(node.dataset.flip, r.top);
      const before = last.current.get(node.dataset.flip);
      if (!reduce && before !== undefined && Math.abs(before - r.top) > 1) {
        node.animate([{ transform: `translateY(${before - r.top}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' });
      }
    });
    last.current = now;
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
};

// A page-level change with a view transition where the browser has one (Chrome): the old view fades out, the new one
// rises in, and elements sharing a view-transition-name (the field title) morph into each other.
// A transition that doesn't finish within a second (the browser paused painting) is skipped, so the page never hangs.
export const vt = (fn) => {
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (typeof document === 'undefined' || !document.startViewTransition || reduce || still() || document.visibilityState !== 'visible') { fn(); return; }
  const tr = document.startViewTransition(() => flushSync(fn));
  const timer = setTimeout(() => { try { tr.skipTransition(); } catch (e) { /* already done */ } }, 1000);
  tr.finished.finally(() => clearTimeout(timer)).catch(() => null);
};

// Motion watchdog: if the animation clock doesn't move while the page is shown, every animation is switched off
// (html.still), so nothing stays half faded in. It switches back on as soon as the clock runs again.
const still = () => typeof document !== 'undefined' && document.documentElement.classList.contains('still');
if (typeof document !== 'undefined' && document.timeline) {
  let last = document.timeline.currentTime;
  setInterval(() => {
    const now = document.timeline.currentTime;
    if (document.visibilityState === 'visible') document.documentElement.classList.toggle('still', now === last);
    last = now;
  }, 700);
}

// Tabs with an ink bar that slides to the active tab.
export const Tabs = ({ items, value, onChange, label }) => {
  const wrap = useRef(null);
  const [ink, setInk] = useState({ x: 0, w: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const el = wrap.current?.querySelector('[aria-selected="true"]');
      setInk(el ? { x: el.offsetLeft, w: el.offsetWidth } : { x: 0, w: 0 });
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro && wrap.current) ro.observe(wrap.current);
    return () => ro && ro.disconnect();
  }, [value, items.map((i) => `${i.key}${i.count || ''}`).join('|')]);
  return (
    <nav className="tabs" role="tablist" aria-label={label} ref={wrap}>
      {items.map((it) => (
        <button key={it.key} type="button" role="tab" aria-selected={value === it.key} className={`tab ${value === it.key ? 'active' : ''}`} onClick={() => onChange(it.key)} data-tour={`tab-${it.key}`}>
          {it.label}{it.count ? <span className={`count ${it.hot ? 'hot' : ''}`}>{it.count}</span> : null}
        </button>
      ))}
      <span className="tab-ink" style={{ width: ink.w, transform: `translateX(${ink.x}px)` }} />
    </nav>
  );
};

// Segmented control (two to four choices) with a thumb that slides.
export const Segmented = ({ items, value, onChange, label, small = false }) => {
  const wrap = useRef(null);
  const [thumb, setThumb] = useState({ x: 0, w: 0 });
  useLayoutEffect(() => {
    const el = wrap.current?.querySelector('[aria-pressed="true"]');
    if (el) setThumb({ x: el.offsetLeft - 4, w: el.offsetWidth });
  }, [value]);
  return (
    <div className={`seg ${small ? 'small' : ''}`} role="group" aria-label={label} ref={wrap}>
      <span className="thumb" style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }} />
      {items.map((it) => <button key={it.key} type="button" aria-pressed={value === it.key} onClick={() => onChange(it.key)}>{it.label}</button>)}
    </div>
  );
};

// English / German for this person, in the page header (overrides the Jira language, remembered in this browser).
// The labels stay in their own language so anyone can find theirs.
export const LangSwitch = () => (
  <Segmented items={[{ key: 'en', label: 'EN' }, { key: 'de', label: 'DE' }]} value={getLang()} onChange={chooseLang} label={t('Language')} small />
);

// Keeps a view fresh: loads when the view opens and again every minute while the page is visible - unless paused
// (someone is editing, a job is running), so nothing being typed is ever replaced. Refresh buttons call load directly.
export const useAutoRefresh = (load, { paused = false, every = 60000 } = {}) => {
  const fn = useRef(load);
  fn.current = load;
  const hold = useRef(paused);
  hold.current = paused;
  useEffect(() => {
    fn.current(false);
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && !hold.current) fn.current(true);
    }, every);
    const now = () => { if (!hold.current) fn.current(true); };
    window.addEventListener('cfs:refresh', now);
    return () => { clearInterval(timer); window.removeEventListener('cfs:refresh', now); };
  }, [every]);
};

// The app's frame is as tall as its content, so a dialog at the top of the frame can be far off-screen once the page
// is scrolled. Dialogs open where the person last clicked (the button that opened them), else at the top.
// The backdrop is fixed to the frame's viewport, so the place is measured in viewport coordinates (clientY) and kept
// inside it; on a frame shorter than the dialog the backdrop scrolls, so the buttons are always reachable.
let lastPointerY = null;
if (typeof document !== 'undefined') document.addEventListener('pointerdown', (e) => { lastPointerY = e.clientY; }, true);
// The point clicked is always on screen, so the dialog opens with its title just above it (not further: the part of
// the frame above the click may be scrolled away by Jira's own page).
export const dialogTop = () => {
  if (lastPointerY == null) return 48;
  return Math.max(16, lastPointerY - 48);
};

export const Modal = ({ title, onClose, children, footer, wide = false }) => {
  const [top, setTop] = useState(() => dialogTop());
  const box = useRef(null);
  // Near the bottom of the frame the dialog moves up just enough for its buttons to stay inside.
  useLayoutEffect(() => {
    const h = box.current ? box.current.offsetHeight : 0;
    const room = (window.innerHeight || 0) - h - 16;
    if (h && top > room) setTop(Math.max(16, room));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  // Rendered at the page root: the views animate in with a transform, and a transformed parent would make the
  // fixed backdrop relative to that view instead of the screen (the dialog would open out of sight).
  const dialog = (
    <div className="backdrop" style={{ paddingTop: top }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog;
};
