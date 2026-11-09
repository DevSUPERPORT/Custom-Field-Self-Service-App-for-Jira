/**
 * Health tab of the admin control centre: safe mode, the daily self-test, the site compatibility check, background
 * job heartbeats, alerts and publishing the guidelines.
 *
 * @file        static/main/src/admin/Health.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useState } from 'react';
import { call, Msg, Icon, IssueLink, Loz, Spinner, when, useToast, useCanWrite, PAUSED_HINT } from '../ui';
import { t } from '../i18n';
import { CheckLine, LEVEL_TONE } from './common';

// Site compatibility: what differs between Jira sites, with one-click fixes for what the app can set itself.
function SiteCheck({ state, reload }) {
  const canWrite = useCanWrite();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [fixed, setFixed] = useState(null);
  const r = state.siteCheck;
  const fixes = (r && r.fixes) || [];
  const run = async () => {
    setBusy(true);
    setErr('');
    setFixed(null);
    try {
      await call('siteCheck');
      toast(t('Site check finished.'), 'ok');
      reload();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  // One click: the app applies the fixes it offered (only its own settings and what it needs itself) and checks again.
  const fix = async (ids) => {
    setBusy(true);
    setErr('');
    try {
      setFixed(await call('siteFix', { fixIds: ids }));
      reload();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <section className="card stack rise" style={{ '--i': 2 }}>
      <div className="spread">
        <h3>{t('Site compatibility')}</h3>
        <div className="row">
          {fixes.length ? <button type="button" className="btn primary small" disabled={busy || !canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={() => fix(fixes.map((x) => x.id))}><Icon name="wand" />{t('Fix all ({n})', { n: fixes.length })}</button> : null}
          <button type="button" className="btn small line" disabled={busy} onClick={run}>{busy ? <Spinner /> : <Icon name="refresh" />}{busy ? t('Working… (up to a minute)') : t('Run site check')}</button>
        </div>
      </div>
      <p className="muted">{t('Checks what differs between Jira sites: size, field configuration, products, project types, the app\'s permissions, storage, and a timed read of a pilot project\'s fields. Run it after installing on a new site.')}</p>
      {err ? <Msg tone="error">{err}</Msg> : null}
      {fixed ? (
        <Msg tone={fixed.failed.length ? 'warning' : 'success'} title={fixed.failed.length ? t('Some fixes could not be applied') : t('Fixed')}>
          {fixed.done.map((x, i) => <span key={`d${i}`}>✓ {x}</span>)}
          {fixed.failed.map((x, i) => <span key={`f${i}`}>✗ {x}</span>)}
        </Msg>
      ) : null}
      {r ? (
        <div className="check-list">
          <div className="row">
            <Loz tone={LEVEL_TONE[r.level]}>{r.level === 'ok' ? t('Compatible') : r.level === 'warn' ? t('Compatible, with notes') : t('Needs a fix')}</Loz>
            <small>{t('Last run {when}', { when: when(r.at) })}</small>
          </div>
          {r.checks.map((c, i) => (
            <CheckLine key={i} c={c} i={i} action={c.fix ? <button type="button" className="btn small line" disabled={busy || !canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={() => fix([c.fix.id])}>{c.fix.label}</button> : null} />
          ))}
        </div>
      ) : <p className="muted">{t('Not run on this site yet.')}</p>}
    </section>
  );
}

// Health: safe mode, the self-test, the site check, the background jobs, alerts and the guidelines page.
export default function Health({ state, reload }) {
  const toast = useToast();
  const [running, setRunning] = useState('');
  const [err, setErr] = useState('');
  const [guide, setGuide] = useState(null);
  const last = state.selftest.last;
  const hbMin = state.heartbeat ? Math.round((Date.now() - state.heartbeat.at) / 60000) : null;

  // Runs one of the on-demand jobs; the page reloads afterwards to show the result.
  const job = async (key, name, then) => {
    setRunning(key);
    setErr('');
    try {
      const r = await call(name);
      if (then) then(r);
      else toast(t('Done.'), 'ok');
      reload();
    } catch (e) { setErr(e.message); }
    setRunning('');
  };
  const clearSafe = () => job('safe', 'clearSafeMode', () => toast(t('Automatic safe mode is off.'), 'ok'));

  const nightly = state.nightly;
  const nightlyText = nightly
    ? t('{drift} drift(s), suggestions {sugg}, {digest} digest(s)', {
      drift: nightly.drift,
      sugg: Object.entries(nightly.suggestions || {}).map(([k, v]) => `${k} ${v}`).join(', ') || '–',
      digest: nightly.digest,
    }) + (nightly.errors?.length ? ` · ${t('errors: {list}', { list: nightly.errors.join('; ') })}` : '')
    : t('not run yet');
  const jobs = [
    { key: 'n', name: t('Nightly: drift, suggestions, digest'), at: nightly?.at, result: nightlyText },
    {
      key: 'w', name: t('Watchdog in the app (every 30 min, no automation quota)'), at: state.watch?.at,
      result: state.watch ? (state.watch.findings.length ? state.watch.findings.join(' · ') : t('all clear ({n} open request(s) checked)', { n: state.watch.checked })) : t('not run yet'),
    },
    {
      key: 'a', name: t('Automation index (16_automation_index.py)'), at: state.automationIndex?.at,
      result: state.automationIndex ? t('{rules} rules, {fields} fields referenced', { rules: state.automationIndex.rules, fields: state.automationIndex.fields }) : t('not built yet'),
    },
    ...state.migrations.map((m, i) => ({
      key: `m${i}`, name: t('Copy values {from} → {to}', { from: m.fromFieldId, to: m.toFieldId }), at: m.lastRun || m.created,
      result: `${m.status}: ${t('{moved} copied, {skipped} skipped', { moved: m.moved, skipped: m.skipped })}${m.error ? ` (${m.error})` : ''}`,
    })),
  ];

  return (
    <div className="stack" data-tour="health">
      {state.safe.on ? (
        <div className="banner">
          <Icon name="shield" />
          <div className="grow">
            <strong>{t('Safe mode is on ({source})', { source: state.safe.source })}</strong>
            <span>{state.safe.reason}. {t('Every change needs a Jira administrator\'s approval until it is switched off.')}</span>
            {state.safe.source === 'automatic'
              ? <div><button type="button" className="btn small" disabled={!!running} onClick={clearSafe}>{running === 'safe' ? <Spinner /> : <Icon name="check" />}{t('Checked: switch automatic safe mode off')}</button></div>
              : <small>{t('Switch it off under Configuration → Guard rails.')}</small>}
          </div>
        </div>
      ) : null}
      {err ? <Msg tone="error">{err}</Msg> : null}

      <section className="card stack rise" style={{ '--i': 0 }} data-tour="health-selftest">
        <div className="spread">
          <div className="stack tight">
            <h3>{t('Self-test')}</h3>
            <div className="row">
              <Loz tone={last ? (last.ok ? 'green' : 'red') : ''}>{last ? (last.ok ? t('All checks pass') : t('Check failed')) : t('Not run yet')}</Loz>
              <small>
                {t('Last self-test {when} ({trigger})', { when: when(last?.at), trigger: last?.trigger || '–' })} · {hbMin === null ? t('5-minute job not run yet') : t('5-minute job ran {n} min ago', { n: hbMin })}
              </small>
            </div>
          </div>
          <button type="button" className="btn small line" disabled={!!running} onClick={() => job('self', 'selftest')}>{running === 'self' ? <Spinner /> : <Icon name="play" />}{running === 'self' ? t('Running…') : t('Run self-test now')}</button>
        </div>
        {last ? (
          <div className="t-wrap">
            <table className="t compact">
              <thead><tr><th>{t('Check')}</th><th>{t('Result')}</th><th className="r">{t('Time')}</th><th>{t('Detail')}</th></tr></thead>
              <tbody>
                {last.checks.map((c, i) => (
                  <tr key={i}>
                    <td className="fname">{c.name}</td>
                    <td><Loz tone={c.ok ? 'green' : 'red'}>{c.ok ? t('ok') : t('failed')}</Loz></td>
                    <td className="r num">{c.ms} ms</td>
                    <td><small>{c.detail}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <Msg tone={state.setup.usable ? 'success' : 'info'}>{state.setup.note}</Msg>
      </section>

      <section className="card stack rise" style={{ '--i': 1 }}>
        <div className="spread">
          <h3>{t('Background checks')}</h3>
          <div className="row">
            <button type="button" className="btn small line" disabled={!!running} onClick={() => job('nightly', 'runNightly')}>{running === 'nightly' ? <Spinner /> : <Icon name="clock" />}{t('Run nightly checks now')}</button>
            <button type="button" className="btn small line" disabled={!!running} onClick={() => job('watch', 'runWatchdog')}>{running === 'watch' ? <Spinner /> : <Icon name="pulse" />}{t('Run watchdog now')}</button>
            <button type="button" className="btn small line" disabled={!!running} onClick={() => job('weekly', 'runWeekly', (r) => setGuide({ weekly: true, chars: r.characters }))}>{running === 'weekly' ? <Spinner /> : <Icon name="mail" />}{t('Build weekly digest now')}</button>
          </div>
        </div>
        <div className="t-wrap">
          <table className="t compact">
            <thead><tr><th>{t('Check')}</th><th>{t('Last run')}</th><th>{t('Result')}</th></tr></thead>
            <tbody>
              {jobs.map((j) => <tr key={j.key}><td className="fname">{j.name}</td><td style={{ whiteSpace: 'nowrap' }}>{when(j.at)}</td><td><small>{j.result}</small></td></tr>)}
            </tbody>
          </table>
        </div>
      </section>

      <SiteCheck state={state} reload={reload} />

      <section className="card stack rise" style={{ '--i': 3 }}>
        <h3>{t('Alerts')}</h3>
        {state.alerts.length ? (
          <div className="t-wrap">
            <table className="t compact">
              <thead><tr><th>{t('Alert')}</th><th>{t('Summary')}</th><th>{t('Status')}</th><th>{t('Created')}</th></tr></thead>
              <tbody>
                {state.alerts.map((a) => <tr key={a.key}><td><IssueLink k={a.key} /></td><td>{a.summary}</td><td><Loz>{a.status}</Loz></td><td style={{ whiteSpace: 'nowrap' }}>{when(a.created)}</td></tr>)}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">{t('No alerts.')}</p>}
      </section>

      <section className="card stack rise" style={{ '--i': 4 }}>
        <h3>{t('Guidelines page')}</h3>
        <p className="muted">{t('The guidelines are generated from the configuration. Publishing stores them on the approval space; 13_guidelines_page.py turns them into the Confluence page that Request Resolver and Self service use.')}</p>
        <div><button type="button" className="btn small line" disabled={!!running} onClick={() => job('guide', 'guidelines', (r) => setGuide({ weekly: false, chars: r.markdown.length }))}>{running === 'guide' ? <Spinner /> : <Icon name="send" />}{t('Generate and publish')}</button></div>
        {guide ? (
          <Msg tone="success">
            {guide.weekly
              ? t('Weekly digest stored ({n} characters). Run 18_weekly_digest.py to publish it in CFSDOC.', { n: guide.chars })
              : t('Published ({n} characters). Run 13_guidelines_page.py to refresh the Confluence page.', { n: guide.chars })}
          </Msg>
        ) : null}
      </section>
    </div>
  );
}
