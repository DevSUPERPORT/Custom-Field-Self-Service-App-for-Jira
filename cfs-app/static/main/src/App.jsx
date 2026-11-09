/**
 * The project page: header with the call to action, role-based tabs with live updates, the "view as project admin"
 * preview, and the views for fields, one field, new field, requests, approvals, audit log, health and bulk changes.
 *
 * @file        static/main/src/App.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { view, realtime } from '@forge/bridge';
import { call, Msg, Skeleton, ToastHost, useToast, askAssistant, when, Mark, Icon, Tabs, Note, vt, setPreview, LangSwitch, performUndo, recentlyActed, useCanWrite, PAUSED_HINT } from './ui';
import { undoPayload } from '../../../src/shared/undo.js';
import { t } from './i18n';
import Inbox from './Inbox';
import FieldsTab from './FieldsTab';
import FieldView from './FieldView';
import NewField from './NewField';
import MyRequests from './MyRequests';
import AuditTab from './AuditTab';
import HealthTab from './HealthTab';
import Tour from './Tour';
import BulkTab from './BulkTab';

// What each role sees (the server checks every call again: hiding is for clarity, not for security).
const tabsFor = (role, counts, features = {}) => [
  { key: 'fields', label: t('Fields') },
  { key: 'requests', label: t('My requests'), count: counts.mine },
  { key: 'inbox', label: t('Requests for you'), count: counts.inbox, hot: counts.inbox > 0 },
  { key: 'audit', label: t('Audit log') },
  { key: 'health', label: t('Field health') },
  // Project admins too: their bulk changes cover the fields only their space uses (the server enforces it).
  // Shown only while bulk changes are switched on (shared/features.js).
  ...(features.bulk ? [{ key: 'bulk', label: t('Bulk changes') }] : []),
];
// The page's own cache in this browser (per person and space). Storage can be blocked or full: then there is no cache.
const readCache = (key) => {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) || 'null');
    return v && v.overview && v.me ? v : null;
  } catch (e) {
    return null;
  }
};
const writeCache = (key, value) => {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* no cache then */ }
};

const EVENT_TEXT = {
  changed: 'Fields changed',
  requested: 'Approval requested',
  declined: 'A request was rejected',
  cancelled: 'A request was withdrawn',
};

function Main() {
  const toast = useToast();
  const canWrite = useCanWrite();
  const [projectKey, setProjectKey] = useState('');
  const [tab, setTab] = useState('fields');
  const [me, setMe] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [field, setField] = useState(null);
  const [live, setLive] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [guard, setGuard] = useState(null);
  const [news, setNews] = useState(null);
  const [counts, setCounts] = useState({ inbox: 0, mine: 0 });
  const [tour, setTour] = useState(null);
  const [lastOpened, setLastOpened] = useState(null);
  const rules = useRef(null);

  // On very large sites the first read of the field list takes several passes: each pass returns what it has, the
  // page shows it with the progress, and asks for the rest.
  const finish = useCallback(async (first) => {
    let r = first;
    for (let i = 0; r.incomplete && i < 40; i += 1) {
      r = await call('overview', { cont: true });
      setData(r);
    }
  }, []);
  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      const r = await call('overview', { fresh });
      setData(r);
      setError(null);
      await finish(r);
    } catch (e) {
      setError(e);
    }
    setLoading(false);
  }, [finish]);

  const loadCounts = useCallback(() => {
    call('inbox').then((r) => setCounts((c) => ({ ...c, inbox: r.items.length + (r.todos || []).length }))).catch(() => null);
    call('myRequests').then((r) => setCounts((c) => ({ ...c, mine: r.items.filter((x) => x.status === 'waiting').length }))).catch(() => null);
  }, []);

  // Opening the page: one call for everything (boot on the server). Meanwhile the field list this person last saw here
  // shows at once from this browser, marked with its time; the server checks every action again anyway.
  const [ready, setReady] = useState(false);
  const skipFirstLoad = useRef(false);
  const cacheKey = useRef(null);
  const runBoot = useCallback(() => call('boot').then(async (b) => {
    if (b.me.error) throw new Error(b.me.error);
    setMe(b.me.value);
    if (b.rules.value) rules.current = b.rules.value;
    if (b.guard.value) setGuard(b.guard.value);
    if (b.news.value) setNews(b.news.value);
    if (b.tour.value) setTour((x) => ({ ...b.tour.value, open: x ? x.open : !b.tour.value.seen }));
    setCounts(b.counts);
    if (b.overview.value) {
      skipFirstLoad.current = true;
      setData(b.overview.value);
      setError(null);
      setReady(true);
      await finish(b.overview.value);
    } else setError(new Error(b.overview.error));
  }).catch((e) => setError(e)).finally(() => { setLoading(false); setReady(true); }), [finish]);
  useEffect(() => {
    view.getContext().then((c) => {
      const key = c.extension?.project?.key || '';
      setProjectKey(key);
      cacheKey.current = `cfs:v1:${c.accountId}:${key}`;
      const cached = readCache(cacheKey.current);
      if (cached) { setMe((m) => m || cached.me); setData((d) => d || cached.overview); }
    }).catch(() => null);
    runBoot();
  }, [runBoot]);

  // Remember the last complete field list for the next visit (this browser only; never the preview's).
  useEffect(() => {
    if (me && !me.preview && data && !data.incomplete && cacheKey.current) writeCache(cacheKey.current, { me, overview: data });
  }, [me, data]);

  // "View as project admin" (Jira administrators): the whole page again with a project admin's role, reading only.
  const preview = !!me?.preview;
  const togglePreview = () => {
    setPreview(!preview);
    setField(null);
    setTab('fields');
    setLoading(true);
    runBoot();
  };

  // A change by someone else: what it was, by whom, with Undo when this person may undo it (asked from the server,
  // because live events carry no details).
  const since = useRef(Date.now() - 5000);
  const tellChanges = useCallback(async () => {
    try {
      const r = await call('latestChanges', { since: since.current });
      (r.items || []).forEach((it) => { since.current = Math.max(since.current, it.ts); });
      const others = (r.items || []).filter((it) => !it.mine);
      if (!others.length) return false;
      others.forEach((it) => {
        const step = `${it.action}${it.option ? `: ${it.option}` : ''}`;
        const what = !it.bulk ? step
          : it.moreFields ? t(it.undoEntry ? 'Bulk change undone in {field} and {n} more' : 'Bulk change in {field} and {n} more', { field: it.fieldName, n: it.moreFields })
            : t(it.undoEntry ? 'Bulk change undone: {step}' : 'Bulk change: {step}', { step });
        toast(it.by ? t('{name} changed {field}', { name: it.by, field: it.fieldName }) : t('{field} changed', { field: it.fieldName }), 'info', {
          detail: it.count > 1 ? `${what} · ${t('{n} steps', { n: it.count })}` : what,
          action: it.undo
            ? { label: it.undo.approval ? t('Request undo') : t('Undo'), icon: 'undo', run: () => performUndo(undoPayload(it.undo.key)) }
            : { label: t('Audit log'), run: () => { vt(() => { setField(null); setTab('audit'); }); return { close: true }; } },
        });
      });
      return true;
    } catch (e) {
      return false;
    }
  }, [toast]);

  // Live updates: the backend announces every change and decision for this project.
  useEffect(() => {
    if (!projectKey) return undefined;
    let sub;
    realtime.subscribeGlobal(`cfs-${projectKey}`, (payload) => {
      // Status strings (e.g. SUBSCRIPTION_STARTED) arrive on the same callback: only objects are our events.
      let ev = payload;
      if (typeof payload === 'string') {
        try { ev = JSON.parse(payload); } catch (e) { return; }
      }
      if (!ev || typeof ev !== 'object' || !ev.type) return;
      if (ev.type === 'changed') tellChanges();
      else if (!recentlyActed()) toast(t(EVENT_TEXT[ev.type] || 'Update'));
      load(true);
      loadCounts();
      setRefreshKey((k) => k + 1);
    }).then((s) => { sub = s; setLive(true); }).catch(() => setLive(false));
    return () => { if (sub) sub.unsubscribe().catch(() => null); };
  }, [projectKey, load, toast, loadCounts, tellChanges]);

  // After an undo from a notification: the field list and the tab counts follow at once.
  useEffect(() => {
    const again = () => { load(true); loadCounts(); };
    window.addEventListener('cfs:refresh', again);
    return () => window.removeEventListener('cfs:refresh', again);
  }, [load, loadCounts]);

  // The field list: fresh when the Fields tab opens, then every minute while it is visible (not while a field is open).
  useEffect(() => {
    if (!ready || tab !== 'fields' || field) return undefined;
    if (skipFirstLoad.current) skipFirstLoad.current = false;
    else load(!!data);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, 60000);
    return () => clearInterval(timer);
  }, [tab, field, ready]);

  // Jira scrolls the page inside the app's frame: a field or another tab opens at its top, and Back returns to the
  // place in the list the field was opened from.
  const listScroll = useRef(0);
  const restoreTo = useRef(null);
  useLayoutEffect(() => {
    if (field) window.scrollTo(0, 0);
    else if (restoreTo.current !== null) { window.scrollTo(0, restoreTo.current); restoreTo.current = null; }
  }, [field]);
  useLayoutEffect(() => { if (!field) window.scrollTo(0, 0); }, [tab]);

  const go = (next) => vt(() => { setField(null); setTab(next); });
  const open = (f) => { listScroll.current = window.scrollY; vt(() => { setLastOpened(f.id); setField(f); }); };
  const back = () => { restoreTo.current = listScroll.current; vt(() => setField(null)); load(true); };
  // Other tabs (field health) open a field by its ID; back returns to that tab.
  const fieldById = (id) => (data?.fields || []).find((f) => f.id === id && !f.error) || null;

  if (error?.disabled) return <NotEnabled error={error} projectKey={projectKey} onEnabled={() => { setError(null); load(true); }} />;
  if (error?.forbidden) return <div className="setup"><Mark /><Msg tone="warning" title={t('Project admins only')}>{error.message} {t('Custom Field Self-Service for Jira is for the project admins of this space and for Jira administrators.')}</Msg></div>;
  if (error?.unsupported) return <div className="setup"><Mark /><Msg tone="info" title={t('Team-managed space')}>{error.message}</Msg></div>;

  const admin = me?.role === 'jira-admin';
  const name = data?.project?.name || projectKey;
  return (
    <div className="shell">
      <header className="app-head">
        <div className="wrap">
          <div className="head-top">
            <div className="brand">
              <Mark />
              <div className="brand-text">
                <span className="eyebrow">Custom Field Self-Service for Jira</span>
                <h1>{t('Fields in {name}', { name })}</h1>
              </div>
            </div>
            <div className="head-actions">
              <LangSwitch />
              <span className={`live ${live ? 'on' : ''}`} title={live ? t('This page updates by itself when something changes') : t('Live updates unavailable')} data-tour="live"><span className="dot" />{live ? t('live') : t('offline')}</span>
              <button type="button" className="btn ghost small" onClick={() => setTour((x) => ({ ...(x || {}), open: true }))} data-tour="tour">{t('Tour')}</button>
              {admin || preview ? <button type="button" className="btn ghost small" aria-pressed={preview} onClick={togglePreview} title={t('See this page the way the project admins of this space see it')}><Icon name="eye" />{preview ? t('Back to my view') : t('View as project admin')}</button> : null}
              <button type="button" className="btn ai small" onClick={() => askAssistant(`I work in project ${projectKey}. What can you do for me here? Keep it short.`)} data-tour="assistant"><Icon name="spark" />{t('Ask Field Assistant')}</button>
              {me ? (
                <button type="button" className="btn primary" disabled={!canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={() => go('new')} data-tour="cta"><Icon name="plus" />{admin ? t('Add field') : t('Request field')}</button>
              ) : null}
            </div>
          </div>
          {me ? <Tabs items={tabsFor(me.role, counts, me.features)} value={tab === 'new' ? '' : tab} onChange={go} label={t('Areas')} /> : <div style={{ height: 34 }} />}
        </div>
      </header>

      <main className="page">
        {tour?.open && me ? (
          <Tour role={me.role} approver={me.approver} policy={me.policy} projectKey={projectKey}
            onClose={() => { setTour({ ...tour, open: false }); if (!tour.seen) { call('tourSeen').catch(() => null); setTour({ ...tour, seen: true, open: false }); } }}
            onGo={(k) => { setField(null); setTab(k); }} />
        ) : null}
        <div className="stack">
          {preview ? <div className="banner"><Icon name="eye" /><div className="grow"><strong>{t('Preview: you see what project admins of this space see')}</strong><span>{t('Tabs, fields and actions follow their role; changes are switched off until you leave the preview.')}</span></div><button type="button" className="btn small" onClick={togglePreview}>{t('Back to my view')}</button></div> : null}
          {guard?.safe?.on ? <div className="banner"><Icon name="shield" /><div className="grow"><strong>{t('Safe mode is on')}</strong><span>{guard.safe.reason}. {t('Every change goes to a Jira administrator for approval until it is switched off.')}</span></div></div> : null}
          {news && news.items?.length ? (
            <div className="note accent enter">
              <Icon name="bell" />
              <div className="note-body">
                <strong>{t('Since your last visit ({when}): {n} change(s)', { when: when(news.since), n: news.total })}</strong>
                {news.items.map((n, i) => <span key={i}>{n.text}{n.by ? ` · ${n.by}` : ''} <span className="muted">({n.via})</span></span>)}
              </div>
              <button type="button" className="btn ghost small icon" aria-label={t('Dismiss')} onClick={() => setNews(null)}><Icon name="x" /></button>
            </div>
          ) : null}
          {!me ? <Skeleton lines={8} /> : null}
          {me && !field && tab !== 'new' ? (
            <p className="role-line"><Icon name={admin ? 'shield' : 'user'} className="role-ic" />{admin
              ? guard?.safe?.on ? t('You are a Jira administrator, but safe mode is on: your changes go to approval until it is switched off.') : t('You are a Jira administrator: your changes go live directly, are logged and can be undone.')
              : me.policy?.optionEdits === 'direct'
                ? t('You are a project admin: you change the options of fields only this space uses directly; everything else goes to a Jira administrator for approval.')
                : t('You are a project admin: your changes are sent to a Jira administrator for approval.')}</p>
          ) : null}
          {me && field ? (
            <div className="view" key={`f-${field.id}`}><FieldView field={field} fields={data?.fields || []} rules={rules.current || {}} projectKey={projectKey} role={me.role} onBack={back} backLabel={tab === 'health' ? t('Field health') : undefined} /></div>
          ) : null}
          {me && !field ? (
            <div className="view" key={tab}>
              {tab === 'fields' ? <FieldsTab data={data} error={error?.message} loading={loading} role={me.role} onOpen={open} onReload={() => load(true)} lastOpened={lastOpened} /> : null}
              {tab === 'new' ? <NewField fields={data?.fields || []} role={me.role} onChanged={() => { load(true); loadCounts(); }} onBack={() => go('fields')} onMine={() => go('requests')} safe={!!guard?.safe?.on} /> : null}
              {tab === 'requests' ? <MyRequests refreshKey={refreshKey} projectKey={projectKey} onCount={(n) => setCounts((c) => ({ ...c, mine: n }))} onNew={(where) => go(where === 'bulk' ? 'bulk' : 'new')} /> : null}
              {tab === 'inbox' ? <Inbox refreshKey={refreshKey} onCount={(n) => setCounts((c) => ({ ...c, inbox: n }))} /> : null}
              {tab === 'audit' ? <AuditTab refreshKey={refreshKey} role={me.role} policy={me.policy} /> : null}
              {tab === 'health' ? <HealthTab projectKey={projectKey} role={me.role} onChanged={() => load(true)}
                canOpen={(id) => !!fieldById(id)} onOpenField={(id) => open(fieldById(id))} /> : null}
              {tab === 'bulk' && me.features?.bulk ? <BulkTab role={me.role} policy={me.policy} /> : null}
            </div>
          ) : null}
        </div>
      </main>
      <footer className="foot"><span className="dot6" /><span>{t('An app by SUPERPORT')}</span></footer>
    </div>
  );
}

// Shown where the app is installed but not switched on. Jira admins switch it on with one click; everyone else
// sees whom to ask. On a fresh installation the first admin to do this also becomes the first approver.
function NotEnabled({ error, projectKey, onEnabled }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const enable = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await call('enableHere');
      setMsg({ tone: 'success', text: `${t('Enabled for {key}.', { key: projectKey })}${r.approverAdded ? ` ${t('You are the first approver; add more on the admin page.')}` : ''}` });
      setTimeout(onEnabled, 900);
    } catch (e) {
      setMsg({ tone: 'error', text: e.message });
    }
    setBusy(false);
  };
  return (
    <div className="setup enter">
      <div className="brand"><Mark /><div className="brand-text"><span className="eyebrow">Custom Field Self-Service for Jira</span><h1>{error.configured ? t('Not enabled for {key} yet', { key: projectKey || t('this project') }) : t('Welcome to Custom Field Self-Service for Jira')}</h1></div></div>
      <Note>{error.message}</Note>
      {error.canEnable ? (
        <div className="card stack">
          <h3>{error.configured ? t('Switch it on for {key}', { key: projectKey }) : t('Set it up in two steps')}</h3>
          <ol>
            <li><strong>{t('Enable it here:')}</strong> {t('project admins of {key} can then manage their fields within the guidelines.', { key: projectKey })}</li>
            <li><strong>{t('Finish the setup')}</strong> {t('on the admin page (Jira settings → Apps → Custom Field Self-Service for Jira): approval space, approvers and the self-test field. The checklist there shows what is left.')}</li>
          </ol>
          <div><button type="button" className="btn primary" disabled={busy} onClick={enable}>{busy ? t('Enabling…') : t('Enable for {key}', { key: projectKey })}</button></div>
          {msg ? <Msg tone={msg.tone}>{msg.text}</Msg> : null}
        </div>
      ) : (
        <p className="muted">{t('Ask your Jira administrator to enable Custom Field Self-Service for Jira for this project.')}</p>
      )}
    </div>
  );
}

export default function App() {
  return <ToastHost><Main /></ToastHost>;
}
