/**
 * The admin control centre (Jira settings → Apps): header, setup checklist and production readiness, the Approvals,
 * Audit log, Configuration and Health tabs, and the tour.
 *
 * @file        static/main/src/admin/AdminApp.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { call, Msg, Skeleton, ToastHost, useToast, Mark, Icon, Loz, Tabs, Spinner, useAutoRefresh, vt, LangSwitch } from '../ui';
import { t } from '../i18n';
import { SpotlightTour } from '../Tour';
import Approvals from './Approvals';
import AuditLog from './AuditLog';
import Config from './Config';
import Health from './Health';

// The admin tour: one step per area, switching to its tab first.
const tourSteps = () => [
  {
    target: '[data-tour="admin-head"]',
    title: t('Welcome to the control centre'),
    body: t('Project admins manage their own custom fields within your guidelines. This page is where the Jira administrators keep control: four tabs, about one minute.'),
  },
  {
    target: '[data-tour="approvals"]', tab: 'approvals',
    title: t('Approvals'),
    body: t('Everything waiting for a decision: who asked, why approval is needed, the risk and what the app will create. Approve, reject with a comment, or cancel.'),
    list: [t('You also get an e-mail per request, plus a daily digest.'), t('Low-risk requests can be approved in one go.')],
  },
  {
    target: '[data-tour="audit"]', tab: 'audit',
    title: t('Audit log'),
    body: t('Every change and every request of all spaces, with who asked, who approved and the status. Filter by period, field, status and person.'),
  },
  {
    target: '[data-tour="cfg-policy"]', tab: 'config',
    title: t('Configuration'),
    body: t('Decide whether project admins change the options of fields only their space uses directly or after approval. Below: approval space and approvers, field types, retention, screens, pilot spaces and the guidelines.'),
    list: [t('Shared and global fields always need a Jira administrator.'), t('Nothing applies until you save; then within 30 seconds.')],
  },
  {
    target: '[data-tour="health"]', tab: 'health',
    title: t('Health'),
    body: t('The daily self-test, the site check, the background jobs, the watchdog for stuck requests and every alert. Run any check on demand.'),
  },
  {
    target: '[data-tour="cfg-guard"]', tab: 'config',
    title: t('Safety first'),
    body: t('Safe mode turns every change into an approval request. It also switches on by itself when the self-test fails or changes come in unusually fast.'),
    list: [t('Nobody can approve their own request.'), t('Every change is logged and can be traced.')],
  },
];

// Production readiness: anything that must not stay on in real use, in red at the top; approver gaps in amber.
function Production({ p }) {
  if (!p) return null;
  const warn = [
    ...(p.approversNotAdmin.length ? [t('These approvers are not Jira administrators and can\'t give the final approval: {list}.', { list: p.approversNotAdmin.join(', ') })] : []),
    ...(p.noApprover ? [t('No approver is set: requests from project admins can not be approved.')] : []),
    ...(p.oneApprover ? [t('Only one approver: add a backup approver, so requests are decided when that person is away (and they can never approve their own).')] : []),
  ];
  return (
    <>
      {p.testSettings.length ? (
        <div className="banner" role="alert">
          <Icon name="warn" />
          <div className="grow">
            <strong>{t('Test settings are on: switch them off before real use')}</strong>
            {p.testSettings.map((x) => <span key={x}>{x}</span>)}
          </div>
        </div>
      ) : null}
      {warn.length ? (
        <div className="banner amber">
          <Icon name="warn" />
          <div className="grow"><strong>{t('Approvals')}</strong>{warn.map((x) => <span key={x}>{x}</span>)}</div>
        </div>
      ) : null}
    </>
  );
}

// Setup checklist for a fresh installation: what is missing, and the one step the app can do itself.
function SetupChecklist({ state, reload, onGo }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const c = state.checklist;
  if (!c || c.complete) return null;
  const space = c.steps.find((x) => x.key === 'space');
  const createField = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await call('createSelfTestField');
      toast(r.created
        ? t('Created {id} in the approval space. Run the self-test on the Health tab.', { id: r.fieldId })
        : t('Found {id}; it is now used for the self-test.', { id: r.fieldId }), 'ok');
      reload();
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };
  return (
    <section className="card stack enter" aria-label={t('Finish the setup')}>
      <div className="stack tight">
        <h3>{t('Finish the setup')}</h3>
        <p className="muted">{t('Until these are done, Custom Field Self-Service for Jira stays switched off where it is not enabled, and the daily self-test, alerts and the watchdog stay quiet.')}</p>
      </div>
      <ol className="steps">
        {c.steps.map((x, i) => (
          <li key={x.key} style={{ '--i': i }}>
            <span className="n">{x.done ? <Icon name="check" /> : i + 1}</span>
            <span className="grow">{x.key === 'selftest' ? `${t(x.label)} ("${c.selfTestFieldName}")` : t(x.label)}</span>
            <Loz tone={x.done ? 'green' : ''}>{x.done ? t('Done') : t('To do')}</Loz>
            {x.key === 'selftest' && !x.done ? (
              <button type="button" className="btn small line" disabled={busy || !space?.done} onClick={createField}>{busy ? <Spinner /> : <Icon name="plus" />}{busy ? t('Creating…') : t('Create self-test field')}</button>
            ) : null}
            {x.key === 'sitecheck' && !x.done ? <button type="button" className="linkish" onClick={() => onGo('health')}>{t('Health → Site compatibility')}</button> : null}
            {['projects', 'space', 'approvers'].includes(x.key) && !x.done ? <button type="button" className="linkish" onClick={() => onGo('config')}>{t('Configuration')}</button> : null}
          </li>
        ))}
      </ol>
      <small>{t('Spaces, approval space and approvers: Configuration tab, then Save settings. Tip: a Jira administrator can also enable a space from its own Custom Field Self-Service for Jira page.')}</small>
      {err ? <Msg tone="error">{err}</Msg> : null}
    </section>
  );
}

function Main() {
  const toast = useToast();
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('approvals');
  const [tour, setTour] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [extraNames, setExtraNames] = useState({});
  const steps = useMemo(() => tourSteps(), []);

  const load = useCallback(() => call('state').then((s) => { setState(s); setError(null); }).catch((e) => setError(e)), []);
  // The saved settings as the configuration edits them (the catalogue as text), and the edited copy if any.
  const base = useMemo(() => (state ? { ...state.settings, catalogue: state.catalogueText } : null), [state]);
  const dirty = !!draft && !!base && JSON.stringify(draft) !== JSON.stringify(base);
  // Nothing being typed is ever replaced: no refresh while the configuration has unsaved changes or a decision runs.
  useAutoRefresh(load, { paused: dirty || deciding || saving });
  useEffect(() => { call('tour').then((x) => { if (!x.seen) setTour(true); }).catch(() => null); }, []);

  const update = useCallback((fn) => setDraft((cur) => {
    const next = fn(cur || base);
    return JSON.stringify(next) === JSON.stringify(base) ? null : next;
  }), [base]);
  const names = useMemo(() => ({ ...(state?.people || {}), ...extraNames }), [state, extraNames]);
  const onName = useCallback((id, name) => setExtraNames((n) => ({ ...n, [id]: name })), []);

  const save = async () => {
    const s = draft || base;
    setSaving(true);
    setSaveError('');
    try {
      await call('save', { settings: { ...s, rules: { ...s.rules, similarity: Number(s.rules.similarity) } } });
      await load();
      setDraft(null);
      toast(t('Saved. The app, the agent and the guideline check use the new settings within 30 seconds.'), 'ok');
    } catch (e) {
      setSaveError(e.message);
      toast(e.message, 'error');
    }
    setSaving(false);
  };
  const discard = () => { setDraft(null); setSaveError(''); };
  const closeTour = () => { setTour(false); call('tourSeen').catch(() => null); };
  const go = (next) => vt(() => setTab(next));

  if (error?.forbidden) {
    return <div className="setup"><Mark /><Msg tone="warning" title={t('Jira administrators only')}>{error.message}</Msg></div>;
  }
  if (error && !state) {
    return <div className="setup"><Mark /><Msg tone="error" title={t('The control centre could not load')}>{error.message}</Msg><div><button type="button" className="btn line" onClick={load}><Icon name="refresh" />{t('Try again')}</button></div></div>;
  }

  const waiting = state ? state.open.filter((p) => p.status === 'pending').length : 0;
  const tabs = [
    { key: 'approvals', label: t('Approvals'), count: waiting, hot: waiting > 0 },
    { key: 'audit', label: t('Audit log') },
    { key: 'config', label: dirty ? `${t('Configuration')} •` : t('Configuration') },
    { key: 'health', label: t('Health') },
  ];
  return (
    <div className="shell">
      <header className="app-head">
        <div className="wrap">
          <div className="head-top" data-tour="admin-head">
            <div className="brand">
              <Mark />
              <div className="brand-text">
                <span className="eyebrow">{t('Custom Field Self-Service for Jira · Jira administration')}</span>
                <h1>{t('Control centre')}</h1>
              </div>
            </div>
            <div className="head-actions">
              {state?.safe?.on ? <button type="button" className="st fail" onClick={() => go('health')} title={state.safe.reason}><Icon name="shield" />{t('Safe mode on')}</button> : null}
              <button type="button" className="btn ghost small" disabled={!state} onClick={() => setTour(true)} data-tour="tour"><Icon name="play" />{t('Tour')}</button>
              <LangSwitch />
            </div>
          </div>
          {state ? <Tabs items={tabs} value={tab} onChange={go} label={t('Areas')} /> : <div style={{ height: 34 }} />}
        </div>
      </header>

      <main className="page">
        {tour && state ? <SpotlightTour steps={steps} onClose={closeTour} onStep={(step) => { if (step?.tab) setTab(step.tab); }} /> : null}
        <div className="stack">
          {!state ? <Skeleton lines={10} /> : null}
          {state && error ? <Msg tone="error">{error.message}</Msg> : null}
          {state ? <SetupChecklist state={state} reload={load} onGo={go} /> : null}
          {state ? <Production p={state.production} /> : null}
          {state ? (
            <div className="view" key={tab}>
              {tab === 'approvals' ? <Approvals state={state} reload={load} onBusy={setDeciding} /> : null}
              {tab === 'audit' ? <AuditLog /> : null}
              {tab === 'config' ? (
                <Config state={state} s={draft || base} update={update} dirty={dirty} saving={saving} saveError={saveError}
                  onDiscard={discard} onSave={save} names={names} onName={onName} />
              ) : null}
              {tab === 'health' ? <Health state={state} reload={load} /> : null}
            </div>
          ) : null}
        </div>
      </main>
      <footer className="foot"><span className="dot6" /><span>{t('An app by SUPERPORT')}</span></footer>
    </div>
  );
}

// The control centre, with toasts.
export default function AdminApp() {
  return <ToastHost><Main /></ToastHost>;
}
