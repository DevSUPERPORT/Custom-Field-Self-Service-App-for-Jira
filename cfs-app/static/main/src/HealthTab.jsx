/**
 * Field health tab: unused fields (no work item has a value), fields on no screen, possible duplicates, clean-up
 * suggestions built from them and the nightly pattern suggestions, with filters and bulk actions to put fields on this
 * space's screens or take them out of use.
 *
 * @file        static/main/src/HealthTab.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-06
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { call, Msg, Skeleton, Loz, IssueLink, askAssistant, when, useToast, useAutoRefresh, Icon, Modal, Note, useCanWrite, PAUSED_HINT } from './ui';
import { t, tn, getLocale } from './i18n';
import { cleanupSuggestions } from '../../../src/shared/health.js';

const TONE = { stale: 'yellow', never: 'yellow', noscreen: '', duplicate: 'red' };
// The field's context as the Fields tab names it (project scope).
const SCOPE_LABEL = { project: 'Only this space', shared: 'Multiple', global: 'Global' };
const flagText = (f) => {
  if (f.code === 'never') {
    if (f.text === 'Never used') return t('Never used');
    return f.scope === 'project' ? t('No value in this space') : t('No value on any work item');
  }
  if (f.code === 'stale') return f.days != null ? t('Not used for {n} days', { n: f.days }) : f.text;
  if (f.code === 'noscreen') return f.scope === 'project' ? t('Not on this space\'s screens') : t('On no screen');
  if (f.code === 'duplicate') return f.name ? t('Possible duplicate of "{name}" ({id})', { name: f.name, id: f.fieldId }) : f.text;
  return f.text;
};

// Clean-up suggestions from the findings: what each group means and what to do. `select` = which bulk action the
// selected fields lead to (Jira administrators); `ask` = a Field Assistant question instead.
const CLEANUP = {
  hidden: {
    title: (n, here) => (here
      ? tn(n, '{n} field has values here but is not on this space\'s screens', '{n} fields have values here but are not on this space\'s screens')
      : tn(n, '{n} field holds values but is on no screen', '{n} fields hold values but are on no screen')),
    text: (here) => (here
      ? t('People in this space can\'t see or edit these values. Ask a Jira administrator to put the fields on this space\'s screens.')
      : t('People can\'t see or edit these values. Put the fields back on this space\'s screens, or take them out of use on purpose.')),
    select: 'add',
  },
  retire: {
    title: (n, here) => (here
      ? tn(n, '{n} field has no value here and is not on this space\'s screens', '{n} fields have no value here and are not on this space\'s screens')
      : tn(n, '{n} field has no value and is on no screen', '{n} fields have no value and are on no screen')),
    text: (here) => (here
      ? t('Nobody in this space has filled them in and nobody can. Ask a Jira administrator whether they can be removed from this space.')
      : t('Nobody has filled them in and nobody can: candidates to delete in Jira (Settings → Work items → Fields).')),
    ask: (ids, key) => `Project ${key}: these custom fields have no value on any work item and are on no screen: ${ids.join(', ')}. Which can be deleted safely, and which should be kept? Group them and explain why.`,
  },
  empty: {
    title: (n, here) => (here
      ? tn(n, '{n} field is on this space\'s screens but was never filled in here', '{n} fields are on this space\'s screens but were never filled in here')
      : tn(n, '{n} field is on screens but was never filled in', '{n} fields are on screens but were never filled in')),
    text: (here) => (here
      ? t('No work item in this space has a value. Check with your team whether they are still needed.')
      : t('No work item on the site has a value. Check whether they are still needed; taking them out of use tidies up the screens.')),
    select: 'remove',
  },
  duplicate: {
    title: (n) => tn(n, '{n} field looks like a duplicate', '{n} fields look like duplicates'),
    text: () => t('Similar name and the same type as another field. Keep one of each pair and retire the other.'),
    ask: (ids, key) => `Project ${key}: these custom fields look like duplicates of other fields: ${ids.join(', ')}. For each pair, which one should stay, and how do we move the values?`,
  },
  stale: {
    title: (n) => tn(n, '{n} field has not been used for 180 days or more', '{n} fields have not been used for 180 days or more'),
    text: () => t('Jira last saw a value long ago. Ask the space whether the field is still needed.'),
    select: 'remove',
  },
};

function Cleanup({ items, admin, here, projectKey, onShow, onSelect }) {
  if (!items.length) return <p className="muted">{t('No clean-up needed: every field is used, on a screen and unique.')}</p>;
  return (
    <div className="stack">
      {items.map((s) => {
        const c = CLEANUP[s.kind];
        return (
          <div key={s.kind} className="card spread" style={{ gap: 12 }}>
            <div><strong>{c.title(s.fieldIds.length, here)}</strong><div><small>{c.text(here)}</small></div></div>
            <div className="row">
              <button type="button" className="btn line small" onClick={() => onShow(s)}>{t('Show them')}</button>
              {admin && c.select ? <button type="button" className="btn small" onClick={() => onSelect(s)}>{t('Select them')}</button> : null}
              {admin && c.ask ? <button type="button" className="btn ai small" onClick={() => askAssistant(c.ask(s.fieldIds.slice(0, 60), projectKey))}>✦ {t('Ask Field Assistant')}</button> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Nightly suggestions: text fields that should be dropdowns, and "Key: Value" information people type by hand.
function Suggestions({ data, projectKey, onChanged, admin }) {
  const canWrite = useCanWrite();
  const toast = useToast();
  const [names, setNames] = useState({});
  const [migrate, setMigrate] = useState({});
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState({});
  if (!data) return <small className="muted">{t('Patterns in work items: not scanned yet (the nightly scan looks at the latest 100 work items).')}</small>;
  if (!data.items.length) return <small className="muted">{t('Patterns in work items: nothing found (scan of {date}).', { date: when(data.at) })}</small>;
  const convert = async (s) => {
    setBusy(s.fieldId);
    try {
      const r = await call('convertText', { fieldId: s.fieldId, name: names[s.fieldId] || `${s.fieldName} (list)`, migrate: migrate[s.fieldId] !== false });
      setResult({ ...result, [s.fieldId]: r });
      if (r.status === 'created') { toast(t('Created {id}.', { id: r.fieldId })); onChanged(); }
      if (r.status === 'pending') toast(t('Sent for approval as {key}.', { key: r.issueKey }));
    } catch (e) {
      setResult({ ...result, [s.fieldId]: { status: 'error', error: e.message } });
    }
    setBusy(null);
  };
  return (
    <div className="stack">
      <small>{t('Scan of {date}. Suggestions are computed from your data, never invented; nothing changes until you act.', { date: when(data.at) })}</small>
      {data.items.map((s) => (s.kind === 'text' ? (
        <div key={s.fieldId} className="card stack" style={{ gap: 8 }}>
          <div><strong>{t('“{name}” should probably be a dropdown', { name: s.fieldName })}</strong><div><small>{t('{items} work items, only {n} different values', { items: s.items, n: s.values.length })}{admin ? `: ${s.values.map((v) => `${v.value} (${v.count})`).join(', ')}` : ''}</small></div></div>
          <div className="row">
            <input type="text" value={names[s.fieldId] ?? `${s.fieldName} (list)`} onChange={(e) => setNames({ ...names, [s.fieldId]: e.target.value })} style={{ width: 240 }} aria-label={t('Name of the new dropdown')} />
            <label className="check small"><input type="checkbox" checked={migrate[s.fieldId] !== false} onChange={(e) => setMigrate({ ...migrate, [s.fieldId]: e.target.checked })} />{t('copy the existing values')}</label>
            {admin ? <button type="button" className="btn primary small" disabled={!!busy || !!result[s.fieldId]?.status && result[s.fieldId].status !== 'error' || !canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={() => convert(s)}>{busy === s.fieldId ? t('Working…') : t('Create dropdown')}</button> : <small className="muted">{t('A Jira administrator can turn this into a dropdown.')}</small>}
          </div>
          {result[s.fieldId]?.status === 'created' ? <Msg tone="success" title={t('Created {id}', { id: result[s.fieldId].fieldId })}>{result[s.fieldId].notes.join(' ')}</Msg> : null}
          {result[s.fieldId]?.status === 'pending' ? <Msg tone="info" title={t('Sent for approval')}><IssueLink k={result[s.fieldId].issueKey} /></Msg> : null}
          {result[s.fieldId]?.status === 'rejected' ? <Msg tone="error">{result[s.fieldId].check.findings.filter((f) => f.level === 'red').map((f) => f.message).join(' ')}</Msg> : null}
          {result[s.fieldId]?.status === 'error' ? <Msg tone="error">{result[s.fieldId].error}</Msg> : null}
        </div>
      ) : (
        <div key={s.key} className="card spread">
          <div><strong>{t('People type “{key}: …” by hand', { key: s.key })}</strong><div><small>{t('{n} mentions in recent work items', { n: s.count })}{admin ? ` (${t('e.g. {examples}', { examples: s.examples.join(', ') })}): ${s.values.slice(0, 8).map((v) => `${v.value} (${v.count})`).join(', ')}` : ''}</small></div></div>
          {admin ? <button type="button" className="btn ai small" onClick={() => askAssistant(`Project ${projectKey}: people write "${s.key}: ..." in summaries or labels, with the values ${s.values.slice(0, 12).map((v) => v.value).join(', ')}. Check whether a field for this exists and, if not, preview a dropdown "${s.key}" with these options.`)}>✦ {t('Turn into a field')}</button> : null}
        </div>
      )))}
    </div>
  );
}

// Findings to filter by. The server's flag codes: stale / never (usage), noscreen, duplicate.
const has = (code) => (r) => r.flags.some((f) => f.code === code);
const FINDINGS = [
  { key: 'flagged', label: 'Need a look', test: (r) => r.flags.length > 0 },
  { key: 'noscreen', label: 'On no screen', test: has('noscreen') },
  { key: 'duplicate', label: 'Possible duplicate', test: has('duplicate') },
  { key: 'unused', label: 'Unused', test: (r) => has('stale')(r) || has('never')(r) },
  { key: 'all', label: 'All fields', test: () => true },
];

// The filter and the last result survive opening a field and coming back (the tab remounts): the list shows at once,
// at the same place, and refreshes in the background.
const remembered = { finding: 'flagged', q: '', data: null, projectKey: null, focus: null };

// Several fields at once, onto this space's screens (add) or out of use (remove): one call per field with progress,
// so a long selection never runs into a time limit, can be stopped, and one failing field does not stop the rest.
// Every field is its own logged step; "Undo all" reverses the ones that changed.
const JOB = {
  add: { resolver: 'healthAddScreens', done: 'added to screens', nochange: 'already on them', notDone: 'Not added', undone: 'Undone: {n} field(s) are off the screens again.' },
  remove: { resolver: 'healthTakeOut', done: 'taken out of use', nochange: 'on none of these screens', notDone: 'Not taken out of use', undone: 'Undone: {n} field(s) are back on their screens.' },
};
function ScreenJob({ mode, fields, onClose, onChanged }) {
  const canWrite = useCanWrite();
  const toast = useToast();
  const job = JOB[mode];
  const [screens, setScreens] = useState(null);
  const [ids, setIds] = useState(null);
  const [error, setError] = useState('');
  const [run, setRun] = useState(null);
  const stop = useRef(false);
  useEffect(() => {
    if (mode !== 'add') return;
    call('screens', {}).then((r) => { setScreens(r.screens); setIds(r.screens.filter((s) => s.exclusive).map((s) => s.screenId)); }).catch((e) => setError(e.message));
  }, [mode]);
  const own = (screens || []).filter((s) => s.exclusive);
  const shared = (screens || []).filter((s) => !s.exclusive);
  const running = run && !run.finished;

  const start = async () => {
    stop.current = false;
    const results = [];
    setRun({ done: 0, results, finished: false });
    for (const f of fields) {
      if (stop.current) break;
      try {
        const r = await call(job.resolver, mode === 'add' ? { fieldId: f.id, screenIds: ids } : { fieldId: f.id });
        results.push({ id: f.id, name: f.name, status: r.status, op: r.op, kept: r.kept || [], everywhere: r.mode === 'everywhere' });
      } catch (e) {
        results.push({ id: f.id, name: f.name, status: 'error', error: e.message });
      }
      setRun({ done: results.length, results: [...results], finished: false });
    }
    setRun({ done: results.length, results: [...results], finished: true, stopped: stop.current && results.length < fields.length });
    onChanged();
  };

  const undoAll = async () => {
    const ops = run.results.filter((r) => r.status === 'done' && r.op && !r.undone);
    setRun({ ...run, undoing: true });
    let failed = 0;
    const results = [...run.results];
    for (const r of ops) {
      try {
        await call('undo', { adminOpId: r.op });
        results[results.indexOf(r)] = { ...r, undone: true };
      } catch (e) {
        failed += 1;
      }
    }
    setRun({ ...run, results, undoing: false });
    toast(failed ? t('{n} step(s) could not be undone; see the audit log.', { n: failed }) : t(job.undone, { n: ops.length }), failed ? 'error' : 'ok');
    onChanged();
  };

  const n = (s) => (run ? run.results.filter((r) => r.status === s && !r.undone).length : 0);
  const undone = run ? run.results.filter((r) => r.undone).length : 0;
  const failures = run ? run.results.filter((r) => r.status === 'error') : [];
  const kept = run ? run.results.filter((r) => r.kept && r.kept.length && !r.undone) : [];
  const title = mode === 'add'
    ? tn(fields.length, 'Put {n} field on this space\'s screens', 'Put {n} fields on this space\'s screens')
    : tn(fields.length, 'Take {n} field out of use', 'Take {n} fields out of use');
  let footer;
  if (!run) {
    footer = <>
      <button type="button" className="btn ghost" onClick={onClose}>{t('Cancel')}</button>
      {mode === 'add'
        ? <button type="button" className="btn primary" disabled={!ids || !ids.length || !canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={start}><Icon name="plus" />{tn(fields.length, 'Add {n} field', 'Add {n} fields')}</button>
        : <button type="button" className="btn danger" onClick={start}>{title}</button>}
    </>;
  } else if (running) {
    footer = <button type="button" className="btn ghost" disabled={stop.current} onClick={() => { stop.current = true; setRun({ ...run }); }}>{stop.current ? t('Stopping…') : t('Stop after this field')}</button>;
  } else {
    footer = <>
      {n('done') ? <button type="button" className="btn ghost" disabled={run.undoing} onClick={undoAll}><Icon name="undo" />{run.undoing ? t('Undoing…') : t('Undo all')}</button> : null}
      <button type="button" className="btn primary" autoFocus onClick={onClose}>{t('Close')}</button>
    </>;
  }

  return (
    <Modal title={title} onClose={running ? () => null : onClose} footer={footer} wide>
      {error ? <Msg tone="error">{error}</Msg> : null}
      {!run && mode === 'add' ? (
        <div className="stack">
          {screens === null && !error ? <Skeleton lines={3} /> : null}
          {screens && !own.length ? <Msg tone="warning" title={t('No screens of its own')}>{t('This space shares all its screens with other spaces. Adding fields there would change those spaces too, so do it in Jira itself.')}</Msg> : null}
          {own.length ? (
            <div className="stack tight">
              <small>{t('The fields go to the bottom of the first tab of each ticked screen. Fields already on a screen are left as they are.')}</small>
              <div className="screens">{own.map((s) => (
                <label key={s.screenId} className="screen-row">
                  <input type="checkbox" checked={(ids || []).includes(s.screenId)} onChange={(e) => setIds(e.target.checked ? [...ids, s.screenId] : ids.filter((x) => x !== s.screenId))} />
                  <span className="grow"><span>{s.name}</span><small>{s.operations.join(', ')}</small></span>
                </label>
              ))}</div>
            </div>
          ) : null}
          {shared.length ? <small className="muted">{tn(shared.length, '{n} screen is shared with other spaces and is left alone.', '{n} screens are shared with other spaces and are left alone.')}</small> : null}
          <small>{fields.slice(0, 12).map((f) => f.name).join(', ')}{fields.length > 12 ? ` ${t('and {n} more', { n: fields.length - 12 })}` : ''}</small>
        </div>
      ) : null}
      {!run && mode === 'remove' ? (
        <div className="stack">
          <ul className="plain">
            <li><Icon name="check" /> {t('A field only this space uses comes off every screen: nobody can fill it in any more.')}</li>
            <li><Icon name="check" /> {t('A field other spaces use too comes off this space\'s own screens only; shared screens keep it.')}</li>
            <li><Icon name="check" /> {t('Values already in work items stay, nothing is deleted, and Undo puts the fields back.')}</li>
          </ul>
          <small>{fields.slice(0, 12).map((f) => f.name).join(', ')}{fields.length > 12 ? ` ${t('and {n} more', { n: fields.length - 12 })}` : ''}</small>
        </div>
      ) : null}
      {run ? (
        <div className="stack" aria-live="polite">
          <div className="stack tight">
            <small>{run.finished
              ? t('Finished: {done} of {total} field(s) handled.', { done: run.done, total: fields.length })
              : t('Working on field {i} of {total}…', { i: Math.min(run.done + 1, fields.length), total: fields.length })}</small>
            <div className="progressline"><i style={{ width: `${Math.round((run.done / Math.max(1, fields.length)) * 100)}%` }} /></div>
          </div>
          {run.finished ? (
            <div className="tally">
              <span><strong>{n('done')}</strong> {t(job.done)}</span>
              <span><strong>{n('nochange')}</strong> {t(job.nochange)}</span>
              <span className={failures.length ? 'bad' : ''}><strong>{failures.length}</strong> {t('failed')}</span>
              {undone ? <span><strong>{undone}</strong> {t('undone')}</span> : null}
            </div>
          ) : null}
          {run.stopped ? <Note>{t('Stopped: the remaining fields were not touched.')}</Note> : null}
          {failures.length ? <Msg tone="error" title={t(job.notDone)}>{failures.map((r) => <span key={r.id}><strong>{r.name}</strong>: {r.error}<br /></span>)}</Msg> : null}
          {run.finished && kept.length ? <Note>{t('Other spaces use these fields too, so these shared screens keep them:')} {kept.map((r) => `${r.name} (${r.kept.join(', ')})`).join('; ')}</Note> : null}
          {run.finished && n('done') ? <small>{t('Each field is a separate step in the audit log and can also be undone there.')}</small> : null}
        </div>
      ) : null}
    </Modal>
  );
}

export default function HealthTab({ projectKey, onChanged, role, onOpenField, canOpen = () => false }) {
  const canWrite = useCanWrite();
  const admin = role === 'jira-admin';
  const [data, setDataState] = useState(remembered.projectKey === projectKey ? remembered.data : null);
  const setData = (d) => { remembered.data = d; remembered.projectKey = projectKey; setDataState(d); };
  const [error, setError] = useState('');
  const [finding, setFindingState] = useState(remembered.finding);
  const [q, setQState] = useState(remembered.q);
  const setFinding = (v) => { remembered.finding = v; setFindingState(v); };
  const setQ = (v) => { remembered.q = v; setQState(v); };
  const [sel, setSel] = useState(() => new Set());
  // A clean-up suggestion opened from above: the table shows exactly its fields until it is cleared.
  const [focus, setFocusState] = useState(remembered.projectKey === projectKey ? remembered.focus : null);
  const setFocus = (v) => { remembered.focus = v; setFocusState(v); };
  const tableTop = useRef(null);
  const [bulk, setBulk] = useState(null);
  const [drift, setDrift] = useState(null);
  // The nightly "changed outside the app" check, now (Jira administrators). Each change found is logged as Drift.
  const checkDrift = async () => {
    setDrift({ busy: true });
    try {
      setDrift(await call('driftCheckNow'));
    } catch (e) {
      setDrift({ error: e.message });
    }
  };
  const headBox = useRef(null);
  const load = () => call('health').then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message));
  useAutoRefresh(load, { paused: !!bulk || sel.size > 0 });
  // While the server is still counting values (first visit, or counts older than six hours), ask again shortly.
  const pending = (data?.countsPending || 0) + (data?.scopePending ? 1 : 0);
  const here = data?.scope === 'project';
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setTimeout(load, 5000);
    return () => clearTimeout(timer);
  }, [data]);
  const rows = useMemo(() => {
    if (!data) return [];
    const only = focus ? new Set(focus.fieldIds) : null;
    const test = only ? (r) => only.has(r.id) : (FINDINGS.find((x) => x.key === finding) || FINDINGS[0]).test;
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return data.rows.filter(test).filter((r) => words.every((w) => `${r.name} ${r.id} ${r.type}`.toLowerCase().includes(w)));
  }, [data, finding, q, focus]);
  const visibleSel = rows.filter((r) => sel.has(r.id));
  useEffect(() => {
    if (headBox.current) headBox.current.indeterminate = visibleSel.length > 0 && visibleSel.length < rows.length;
  });
  if (error) return <Msg tone="error">{error}</Msg>;
  if (!data) return <Skeleton lines={8} />;
  const counts = Object.fromEntries(FINDINGS.map((x) => [x.key, data.rows.filter(x.test).length]));
  const cleanup = cleanupSuggestions(data.rows);
  const suggestionCount = cleanup.length + (data.suggestions?.items?.length || 0);
  const toTable = () => setTimeout(() => tableTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  const show = (s) => { setFocus({ kind: s.kind, fieldIds: s.fieldIds }); setQ(''); toTable(); };
  const select = (s) => { show(s); setSel(new Set(s.fieldIds)); };
  const toggle = (id, on) => setSel((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const toggleAll = (on) => setSel((s) => { const n = new Set(s); rows.forEach((r) => (on ? n.add(r.id) : n.delete(r.id))); return n; });
  const open = (id) => { if (canOpen(id)) onOpenField(id); };

  return (
    <div className="stack">
      <div className="cards">
        <div className="card"><div className="big">{data.projectFields}</div><small>{here ? t('custom fields this space uses') : t('changeable custom fields on the site')}</small></div>
        <div className="card"><div className="big">{data.flagged}</div><small>{t('need a look')}</small></div>
        <div className="card"><div className="big">{suggestionCount}</div><small>{t('suggestions')}</small></div>
        {here ? null : <div className="card"><div className="big">{data.siteCustomFields}</div><small>{t('custom fields on the site, incl. {n} locked by Jira or apps', { n: data.lockedFields ?? 0 })}</small></div>}
      </div>
      <small className="muted">{here
        ? t('Only the fields this space uses: its own and shared fields, and global fields that are on its screens or have values here. Counts are this space\'s work items.')
        : t('Every changeable custom field of the site, with counts over all work items. Project admins see only the fields of their space.')}</small>
      <h3>{t('Suggestions')}</h3>
      {data.countsPending ? <Msg tone="info">{tn(data.countsPending, 'Counting the work items with a value: {n} field still to check. The numbers update by themselves.', 'Counting the work items with a value: {n} fields still to check. The numbers update by themselves.')}</Msg> : null}
      {data.scopePending ? <Msg tone="info">{t('Still reading which fields this space uses. The list updates by itself.')}</Msg> : null}
      <Cleanup items={cleanup} admin={admin} here={here} projectKey={projectKey} onShow={show} onSelect={select} />
      <Suggestions data={data.suggestions} projectKey={projectKey} onChanged={onChanged} admin={admin} />
      <div className="spread" ref={tableTop}>
        <h3>{t('Fields')}</h3>
        <div className="row">
          {admin ? <button type="button" className="btn line" disabled={drift?.busy} onClick={checkDrift}><Icon name="refresh" />{drift?.busy ? t('Checking…') : t('Check for outside changes')}</button> : null}
          <button type="button" className="btn ai" onClick={() => askAssistant(`Project ${projectKey}: look at the field health and propose a clean-up: which fields or options should be disabled, merged or retired, and why?`)}>✦ {t('Get a clean-up proposal')}</button>
        </div>
      </div>
      {drift?.error ? <Msg tone="error">{drift.error}</Msg> : null}
      {drift && !drift.busy && !drift.error ? (
        drift.found.length
          ? <Msg tone="warning" title={tn(drift.found.length, '{n} field was changed outside the app', '{n} fields were changed outside the app')}>{drift.found.map((d) => (d.before === d.now ? t('{name}: options edited', { name: d.name }) : t('{name}: {before} → {now} options', { name: d.name, before: d.before, now: d.now }))).join('; ')}. {t('Logged as Drift in the audit log.')}</Msg>
          : <Msg tone="success" title={t('No changes outside the app')}>{t('Checked {n} option fields of this space against what the app last set.', { n: drift.checked })}{drift.skippedSelfTest ? ` ${t('The app\'s own self-test field is left out: the daily self-test changes it on purpose.')}` : ''}</Msg>
      ) : null}
      <div className="toolbar">
        <div className="search">
          <Icon name="search" />
          <label htmlFor="health-search" className="sr">{t('Search fields')}</label>
          <input id="health-search" type="search" placeholder={t('Search name or ID')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="pills" role="group" aria-label={t('Filter by finding')}>
          {FINDINGS.map((x) => (
            <button key={x.key} type="button" className="pill" aria-pressed={!focus && finding === x.key} onClick={() => { setFocus(null); setFinding(x.key); }}>
              {x.key === 'noscreen' && here ? t('Not on this space\'s screens') : t(x.label)} <span className="n">({counts[x.key]})</span>
            </button>
          ))}
        </div>
      </div>
      {focus ? (
        <div className="row">
          <Loz tone="blue">{CLEANUP[focus.kind].title(focus.fieldIds.length, here)}</Loz>
          <button type="button" className="btn ghost small" onClick={() => setFocus(null)}>{t('Show all findings again')}</button>
        </div>
      ) : null}
      {!focus && finding === 'unused' ? <small className="muted">{here ? t('Unused: no work item in this space has a value, or Jira last saw a value 180 or more days ago.') : t('Unused: no work item on the site has a value, or Jira last saw a value 180 or more days ago.')}</small> : null}
      {admin ? (
        // A fixed slot: ticking the first field must not move the table under the pointer.
        <div className={`selbar ${sel.size ? 'on' : ''}`} role="region" aria-label={t('Selected fields')} aria-live="polite">
          {sel.size ? <>
            <strong>{tn(sel.size, '{n} field selected', '{n} fields selected')}</strong>
            <span className="grow" />
            <button type="button" className="btn primary small" disabled={!canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={() => setBulk({ mode: 'add', fields: data.rows.filter((r) => sel.has(r.id)) })}><Icon name="screen" />{t('Put on this space\'s screens')}</button>
            <button type="button" className="btn small" onClick={() => setBulk({ mode: 'remove', fields: data.rows.filter((r) => sel.has(r.id)) })}>{t('Take out of use')}</button>
            <button type="button" className="btn ghost small" onClick={() => setSel(new Set())}>{t('Clear selection')}</button>
          </> : <small className="muted">{t('Tick fields (or all of them in the header) to put them on this space\'s screens or take them out of use in one go.')}</small>}
        </div>
      ) : null}
      <div className="t-wrap"><table className="t health-t">
        <thead><tr>
          {admin ? <th className="sel"><input ref={headBox} type="checkbox" aria-label={t('Select all shown fields')} checked={rows.length > 0 && visibleSel.length === rows.length} onChange={(e) => toggleAll(e.target.checked)} /></th> : null}
          <th>{t('Field')}</th><th>{t('Type')}</th><th className="col-opt" title={here ? t('Work items of this space that have a value in this field') : t('Work items on the whole site that have a value in this field')}>{t('With a value')}</th><th className="col-opt" title={t('When a work item with a value in this field was last updated. Jira does not record when a field value itself changed.')}>{t('Last used')}</th><th>{here ? t('On this space\'s screens') : t('Screens')}</th><th className="col-opt">{here ? t('Context') : t('Contexts')}</th><th>{t('Findings')}</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => {
            const can = canOpen(r.id);
            return (
              <tr key={r.id} className={can ? 'click' : ''} aria-selected={admin ? sel.has(r.id) : undefined}
                onClick={can ? () => open(r.id) : undefined} tabIndex={can ? 0 : undefined}
                onKeyDown={can ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(r.id); } : undefined}
                aria-label={can ? t('Open {name}', { name: r.name }) : undefined}>
                {admin ? <td className="sel" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={t('Select {name}', { name: r.name })} checked={sel.has(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} /></td> : null}
                <td><div style={{ fontWeight: 600 }}>{r.name}</div><small>{r.id}</small></td>
                <td>{r.type}</td><td className="col-opt">{r.values == null ? '–' : r.values.toLocaleString()}</td><td className="col-opt">{r.lastUsed ? new Date(r.lastUsed).toLocaleDateString(getLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '–'}</td>
                <td>{here ? (r.onScreen ? t('Yes') : t('No')) : (r.screens ?? '–')}</td><td className="col-opt">{here ? (SCOPE_LABEL[r.contextScope] ? t(SCOPE_LABEL[r.contextScope]) : '–') : (r.contexts ?? '–')}</td>
                <td><div className="row" style={{ gap: 4 }}>{r.flags.map((f) => (f.code === 'duplicate' && f.fieldId && canOpen(f.fieldId)
                  ? <button key={f.code} type="button" className="loz red linky" title={t('Open the other field')} onClick={(e) => { e.stopPropagation(); open(f.fieldId); }}>{flagText(f)}</button>
                  : <Loz key={f.code} tone={TONE[f.code]}>{flagText(f)}</Loz>))}</div></td>
              </tr>
            );
          })}
          {!rows.length ? <tr><td colSpan={admin ? 8 : 7} className="muted">{q ? t('No field matches.') : t('Nothing to clean up.')}</td></tr> : null}
        </tbody>
      </table></div>
      {bulk ? <ScreenJob mode={bulk.mode} fields={bulk.fields} onClose={() => { setBulk(null); setSel(new Set()); load(); }} onChanged={() => { load(); onChanged(); }} /> : null}
    </div>
  );
}
