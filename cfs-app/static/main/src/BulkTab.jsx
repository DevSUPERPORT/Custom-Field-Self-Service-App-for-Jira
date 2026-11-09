/**
 * Bulk changes tab: a guided form built from the space's own options, a plain-language summary, a per-field preview
 * with opt-out, live progress, and one-click undo of the whole batch. Hidden while the bulk feature flag is off.
 *
 * @file        static/main/src/BulkTab.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, Msg, Loz, Skeleton, IssueLink, Modal, when, time, useToast, Note, refreshViews } from './ui';
import Picker from './Picker';
import { findValue, optionChoices, replacementChoices, fieldChoices, summarise } from '../../../src/shared/catalog.js';
import { t, tn } from './i18n';

const OPS = [
  { key: 'retire', label: 'Retire an option', help: 'It can no longer be chosen anywhere. Work items keep their value.' },
  { key: 'replace', label: 'Replace in work items', help: 'Every work item gets another option instead, then the old one is retired.' },
  { key: 'rename', label: 'Rename an option', help: 'New name in every field. Work items show it at once.' },
  { key: 'add', label: 'Add a new option', help: 'Into every field that has a given option, right next to it.' },
  { key: 'restore', label: 'Restore an option', help: 'Make a retired option selectable again.' },
];
const STATUS = {
  ready: ['blue', 'ready'], running: ['blue', 'running'], 'pending-approval': ['yellow', 'waiting for approval'], done: ['green', 'done'],
  partial: ['yellow', 'partly done'], undoing: ['purple', 'undoing'], undone: ['', 'undone'], declined: ['red', 'declined'],
  withdrawn: ['', 'withdrawn'], cancelled: ['', 'cancelled'],
  collecting: ['', 'scanning'], scanning: ['', 'scanning'], failed: ['red', 'failed'],
};
const ACTION = { change: ['green', 'will change'], skip: ['', 'skipped'], blocked: ['red', 'not possible'] };
const RESULT = { done: ['green', 'changed'], skipped: ['', 'skipped'], failed: ['red', 'failed'] };
const EMPTY_FORM = { value: '', newValue: '', like: '', position: 'after', keepDefaults: false, includeTrims: true, fieldIds: [], retireOld: true, addMissing: false };
// The shown word of a STATUS / ACTION entry, translated when it is drawn; an unknown code is shown as it is.
const word = (table, k) => (table[k] ? t(table[k][1]) : k);

const Progress = ({ done, total, label }) => {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="progress-bar" style={{ width: `${pct}%` }} />
      <span className="progress-text">{label} · {done} / {total}</span>
    </div>
  );
};

const Step = ({ n, done, label, htmlFor, hint, children }) => (
  <div className={`step ${done ? 'done' : ''}`}>
    <span className="step-n" aria-hidden="true">{done ? '✓' : n}</span>
    <div className="step-body">
      {label ? <label className="field" htmlFor={htmlFor}>{label}</label> : null}
      {children}
      {hint ? <div className="hint small">{hint}</div> : null}
    </div>
  </div>
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each work item counts once, however many fields carry the option. With fields unticked, the exact count is not
// known without asking Jira again, so it shows an upper bound.
const workItemsShown = (job, included, exclude, sum) => {
  const distinct = job.totals?.workItems ?? sum(included, 'affected');
  return exclude.length ? `≤ ${Math.min(distinct, sum(included, 'affected'))}` : distinct;
};

export default function BulkTab({ role = 'jira-admin', policy = {} }) {
  const toast = useToast();
  const admin = role === 'jira-admin';
  // Project admins: their own space's fields only; the change is a request unless they change their own fields directly.
  const viaApproval = !admin && policy.optionEdits !== 'direct';
  const [op, setOp] = useState('retire');
  const [form, setForm] = useState(EMPTY_FORM);
  const [cat, setCat] = useState(null);
  const [catProgress, setCatProgress] = useState(null);
  const [catErr, setCatErr] = useState('');
  const [job, setJob] = useState(null);
  const [items, setItems] = useState(null);
  const [exclude, setExclude] = useState([]);
  const [show, setShow] = useState('change');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [hist, setHist] = useState(null);
  const [confirmUndo, setConfirmUndo] = useState(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const loadHistory = useCallback(() => call('bulkHistory').then(setHist).catch(() => setHist([])), []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  // The space's own fields and options, read in passes on large sites.
  const loadCatalog = useCallback(async (fresh = false) => {
    setCatErr('');
    setCatProgress({ done: 0, total: 0, note: t('Reading this space’s fields') });
    try {
      let r = await call('bulkCatalog', { fresh });
      while (alive.current && r.incomplete) {
        setCatProgress(r.progress);
        r = await call('bulkCatalog', {});
      }
      if (alive.current) setCat(r);
    } catch (e) {
      setCatErr(e.message);
    }
    setCatProgress(null);
  }, []);
  useEffect(() => { loadCatalog(); }, [loadCatalog]);
  // Every minute: the history, and the space's options while nothing is being chosen (a silent read, no progress bar).
  const busyRef = useRef(false);
  busyRef.current = !!busy || !!form.value || !!form.like;
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      loadHistory();
      if (!busyRef.current) call('bulkCatalog', {}).then((r) => { if (alive.current && !r.incomplete) setCat(r); }).catch(() => null);
    }, 60000);
    return () => clearInterval(timer);
  }, [loadHistory]);

  const patch = (p) => setForm((f) => ({ ...f, ...p }));
  const chooseOp = (k) => {
    setOp(k);
    // Keep the chosen option when it still makes sense for the new operation.
    const keep = form.value && optionChoices(cat, k).some((x) => x.value === form.value) && k !== 'add';
    setForm({ ...EMPTY_FORM, value: keep ? form.value : '', fieldIds: keep ? form.fieldIds : [] });
  };

  // Drives a job until it settles: scanning -> ready, running / undoing -> done / undone.
  const drive = async (first, step) => {
    let r = first;
    setJob(r.job);
    while (alive.current && r.job && ['collecting', 'scanning', 'running', 'undoing'].includes(r.job.status)) {
      await sleep(400);
      r = await step(r.job.id);
      setJob(r.job);
    }
    if (r.items) setItems(r.items);
    return r;
  };

  const scan = async () => {
    setErr('');
    setItems(null);
    setExclude([]);
    setBusy('scan');
    try {
      const input = {
        op, value: form.value, newValue: form.newValue, like: form.like, position: form.position, clearDefault: !form.keepDefaults,
        includeTrims: form.includeTrims, fieldNames: form.fieldIds, retireOld: form.retireOld, addMissing: form.addMissing,
      };
      const first = await call('bulkScan', { input });
      await drive(first, (jobId) => call('bulkScan', { jobId }));
    } catch (e) {
      setErr(e.message);
    }
    setBusy('');
  };

  const startJob = async () => {
    setErr('');
    setBusy('start');
    try {
      const first = await call('bulkStart', { jobId: job.id, exclude });
      if (first.job.status === 'pending-approval') {
        setJob(first.job);
        toast(t('Sent for approval as {key}', { key: first.job.issueKey }));
      } else {
        const r = await drive(first, (jobId) => call('bulkRun', { jobId }));
        const result = [
          tn(r.job.progress?.changed || 0, '{n} field changed', '{n} fields changed'),
          r.job.progress?.moved ? tn(r.job.progress.moved, '{n} work-item value updated', '{n} work-item values updated') : null,
        ].filter(Boolean).join(', ');
        const done = ['done', 'partial'].includes(r.job.status);
        // The form starts fresh: the option it named may not exist any more (renamed, retired).
        setForm(EMPTY_FORM);
        toast(t('Bulk change {status}: {result}', { status: t(r.job.status), result }), done ? 'ok' : 'info', done ? {
          action: { label: t('Undo'), icon: 'undo', run: () => undoJob(r.job.id, true) },
        } : {});
        loadCatalog(true);
      }
      loadHistory();
    } catch (e) {
      setErr(e.message);
    }
    setBusy('');
  };

  // window.confirm is blocked in the Forge sandbox (it silently answers "cancel"), so undo asks in the app's own dialog.
  // fromToast: the notification shows the outcome itself (returned), errors go there too.
  const undoJob = async (id, fromToast = false) => {
    setConfirmUndo(null);
    setErr('');
    setBusy(`undo:${id}`);
    let out = null;
    try {
      const first = await call('bulkUndo', { jobId: id });
      if (first.status === 'pending') {
        setJob(first.job);
        out = { text: t('Undo sent for approval as {key}.', { key: first.issueKey }), tone: 'ok' };
      } else {
        const r = await drive(first, (jobId) => call('bulkRun', { jobId }));
        const result = [
          tn(r.job.undo?.progress?.done || 0, '{n} field restored', '{n} fields restored'),
          r.job.undo?.progress?.restored ? tn(r.job.undo.progress.restored, '{n} work-item value back', '{n} work-item values back') : null,
        ].filter(Boolean).join(', ');
        out = { text: t('Undone: {result}', { result }), tone: 'ok' };
      }
      if (!fromToast) toast(out.text, out.tone);
      loadHistory();
      loadCatalog(true);
      refreshViews();
    } catch (e) {
      if (fromToast) { setBusy(''); throw e; }
      setErr(e.message);
    }
    setBusy('');
    return out;
  };
  const undoButton = (j) => {
    if (!['done', 'partial'].includes(j.status)) return null;
    if (j.undoRequest) return <span className="small muted">{t('Undo waiting for approval:')} <IssueLink k={j.undoRequest} /></span>;
    if (!admin && j.mine === false) return null;
    return (
      <button type="button" className="btn small" disabled={!!busy} onClick={() => setConfirmUndo({ id: j.id, what: j.description, fields: j.progress?.changed || 0, moved: j.progress?.moved || 0 })}>
        {busy === `undo:${j.id}` ? t('Undoing…') : viaApproval ? t('Request undo') : t('Undo')}
      </button>
    );
  };

  const openJob = async (id) => {
    setErr('');
    try {
      const r = await call('bulkGet', { jobId: id });
      setJob(r.job);
      setItems(r.items);
      setShow(['done', 'partial', 'undone', 'undoing'].includes(r.job.status) ? 'result' : 'change');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setErr(e.message);
    }
  };

  // ---------- choices and the live summary, all from the space's own data ----------
  const opInfo = OPS.find((o) => o.key === op);
  const src = findValue(cat, form.value);
  const like = findValue(cat, form.like);
  const optionItems = useMemo(() => optionChoices(cat, op === 'add' ? 'rename' : op), [cat, op]);
  const withItems = useMemo(() => (op === 'replace' && form.value ? replacementChoices(cat, form.value) : []), [cat, op, form.value]);
  const anchor = op === 'add' ? form.like : form.value;
  const fieldItems = useMemo(() => (cat && anchor ? fieldChoices(cat, anchor) : []), [cat, anchor]);
  const summary = useMemo(() => summarise(cat, { op, ...form }), [cat, op, form]);
  const newName = String(form.newValue || '').trim();
  const addName = String(form.value || '').trim();
  const hasDefaults = src && src.def.length > 0;
  const hasTrims = src && cat && src.f.some((i) => cat.fields[i].cascading && !src.sub.includes(i));
  const lacking = op === 'replace' && src && newName ? src.f.filter((i) => !(findValue(cat, newName)?.f || []).includes(i)).length : 0;
  const optionDone = op === 'add' ? !!addName : !!src;
  const detailDone = op === 'replace' ? !!newName : op === 'rename' ? !!newName && newName !== form.value : op === 'add' ? !!like : true;
  const scopeCount = anchor ? (findValue(cat, anchor)?.f.length || 0) : 0;

  const scanning = job && ['collecting', 'scanning'].includes(job.status);
  const running = job && ['running', 'undoing'].includes(job.status);
  const ready = job && job.status === 'ready' && items;
  const changeItems = (items || []).filter((i) => i.action === 'change');
  const included = changeItems.filter((i) => !exclude.includes(i.fieldId));
  const sum = (arr, k) => arr.reduce((n, i) => n + (i[k] || 0), 0);
  const shown = (items || []).filter((i) => (show === 'all' ? true : show === 'result' ? i.result : i.action === show));
  const isReplace = (job?.bulk?.op || op) === 'replace';
  const withOptions = cat ? cat.fields.filter((f) => f.options > 0) : [];
  const noFields = cat && !withOptions.length;
  const allGlobal = cat && withOptions.length > 0 && withOptions.every((f) => f.editable === 'readonly');

  return (
    <div className="bulk">
      {confirmUndo ? (
        <Modal
          title={t('Undo the whole bulk change?')}
          onClose={() => setConfirmUndo(null)}
          footer={<><span className="grow" /><button type="button" className="btn" onClick={() => setConfirmUndo(null)}>{t('Cancel')}</button><button type="button" className="btn primary" onClick={() => undoJob(confirmUndo.id)}>{viaApproval ? t('Send undo for approval') : tn(confirmUndo.fields, 'Undo {n} field', 'Undo {n} fields')}</button></>}
        >
          <p>{confirmUndo.what}</p>
          <p className="muted">{t('Every field goes back to how it was before: names, active/retired, order and default value. Options the bulk change added are retired, never deleted. Each field gets its own entry in the audit log.')}</p>
          {viaApproval ? <p className="muted">{t('Your undo goes to a Jira administrator for approval, like any change by a project admin.')}</p> : null}
          {confirmUndo.moved ? <p className="muted">{tn(confirmUndo.moved, '{n} work-item value goes back to its old value.', '{n} work-item values go back to their old value.')} {t('A work item somebody changed since is left as it is.')}</p> : null}
        </Modal>
      ) : null}
      <div className="card">
        <div className="spread">
          <h3 style={{ margin: 0 }}>{t('Bulk change')}</h3>
          {cat ? (
            <span className="small">
              {tn(withOptions.length, '{n} field with options', '{n} fields with options')} · {tn(cat.values.length, '{n} option in this space', '{n} options in this space')} · {t('read {time}', { time: time(cat.at) })}
              {' '}<button type="button" className="btn small subtle" onClick={() => loadCatalog(true)} disabled={!!catProgress}>{t('Refresh')}</button>
            </span>
          ) : null}
        </div>
        <p className="muted">{t('One change across the fields of this space. Everything below comes from this space’s own fields; you preview before anything changes, and the whole batch can be undone in one click.')}</p>
        {!admin ? (
          <Note icon="shield">
            <span><strong>{t('Only the fields this space uses alone are listed.')}</strong> {t('Fields shared with other spaces are changed by Jira administrators, so nothing you do here reaches another space.')}</span>
            {viaApproval ? <span>{t('You preview the change; a Jira administrator approves it before it runs. You can follow it under My requests.')}</span> : null}
          </Note>
        ) : null}

        {catProgress ? <Progress done={catProgress.done || 0} total={catProgress.total || 0} label={catProgress.note || t('Reading this space’s options')} /> : null}
        {catErr ? <Msg tone="error" title={t('Couldn’t read this space’s fields')}>{catErr} <button type="button" className="btn small" onClick={() => loadCatalog(true)}>{t('Try again')}</button></Msg> : null}
        {noFields ? <Msg tone="info" title={t('Nothing to change in bulk here yet')}>{admin ? t('This space has no dropdown, checkbox, radio-button or cascading fields. As soon as it uses one, its options show up here.') : t('This space has no dropdown, checkbox, radio-button or cascading field of its own. Fields shared with other spaces are changed by a Jira administrator: use Request field or ask one.')}</Msg> : null}

        {allGlobal ? <Msg tone="info" title={t('Only Jira administrators can change these fields')}>{t('All {n} fields with options in this space are global (shared by every space), so their options are managed by Jira administrators. Use Request field for a field of your own, or ask a Jira administrator.', { n: withOptions.length })}</Msg> : null}
        {cat && !noFields && !allGlobal ? (
          <>
            <div className="ops" role="radiogroup" aria-label={t('What do you want to do?')}>
              {OPS.map((o) => (
                <button key={o.key} type="button" role="radio" aria-checked={op === o.key} className={`op ${op === o.key ? 'on' : ''}`} onClick={() => chooseOp(o.key)}>
                  <strong>{t(o.label)}</strong><small>{t(o.help)}</small>
                </button>
              ))}
            </div>

            {op === 'add' ? (
              <Step n={1} done={!!addName} label={t('New option')} htmlFor="b-new-opt"
                hint={addName && findValue(cat, addName) ? tn(findValue(cat, addName).f.length, 'Already in {n} field of this space: it stays as it is.', 'Already in {n} fields of this space: those stay as they are.') : t('The name exactly as people should see it.')}>
                <input id="b-new-opt" type="text" value={form.value} onChange={(e) => patch({ value: e.target.value })} autoComplete="off" />
              </Step>
            ) : (
              <Step n={1} done={optionDone} label={op === 'restore' ? t('Which retired option?') : t('Which option?')} htmlFor="b-opt">
                <Picker
                  id="b-opt" label={t('Option')} items={optionItems} value={form.value}
                  onChange={(v) => setForm({ ...EMPTY_FORM, value: v })}
                  placeholder={op === 'restore' ? t('Pick a retired option') : t('Pick an option of this space')}
                  searchPlaceholder={tn(optionItems.length, 'Search {n} option', 'Search {n} options')}
                  emptyText={op === 'restore' ? t('No retired options in this space.') : t('No option matches.')}
                />
              </Step>
            )}

            {optionDone && op === 'replace' ? (
              <Step n={2} done={detailDone} label={t('Replace it with')} htmlFor="b-with"
                hint={newName ? (lacking ? null : t('Every field that has "{old}" also has "{new}".', { old: form.value, new: newName })) : t('Options the same fields already have are listed first.')}>
                <Picker
                  id="b-with" label={t('Replacement')} items={withItems} value={form.newValue}
                  onChange={(v, it) => patch({ newValue: v, addMissing: it?.created ? true : form.addMissing })}
                  placeholder={t('Pick the option that takes its place')} searchPlaceholder={t('Search, or type a new option')}
                  create={{ label: t('Use the new option'), meta: t('not in any field yet: added where it is needed') }}
                />
                {newName && lacking ? (
                  <label className="check" style={{ marginTop: 6 }}>
                    <input type="checkbox" checked={form.addMissing} onChange={(e) => patch({ addMissing: e.target.checked })} />
                    {tn(lacking, 'Add "{name}" to the {n} field that doesn’t have it yet (otherwise it is skipped)', 'Add "{name}" to the {n} fields that don’t have it yet (otherwise they are skipped)', { name: newName })}
                  </label>
                ) : null}
                <label className="check" style={{ marginTop: 6 }}>
                  <input type="checkbox" checked={form.retireOld} onChange={(e) => patch({ retireOld: e.target.checked })} />
                  {t('Afterwards retire "{name}" (a default on it moves to the replacement)', { name: form.value })}
                </label>
              </Step>
            ) : null}

            {optionDone && op === 'rename' ? (
              <Step n={2} done={detailDone} label={t('New name')} htmlFor="b-rename">
                <input id="b-rename" type="text" value={form.newValue} onChange={(e) => patch({ newValue: e.target.value })} autoComplete="off" />
              </Step>
            ) : null}

            {optionDone && op === 'add' ? (
              <Step n={2} done={detailDone} label={t('Add it to every field that has')} htmlFor="b-like">
                <div className="row" style={{ alignItems: 'stretch' }}>
                  <div className="grow">
                    <Picker id="b-like" label={t('Existing option')} items={optionItems} value={form.like} onChange={(v) => patch({ like: v, fieldIds: [] })}
                      placeholder={t('Pick an existing option')} searchPlaceholder={tn(optionItems.length, 'Search {n} option', 'Search {n} options')} />
                  </div>
                  <select value={form.position} onChange={(e) => patch({ position: e.target.value })} aria-label={t('Position')} style={{ width: 180 }}>
                    <option value="after">{t('right after it')}</option><option value="end">{t('at the end')}</option><option value="a-z">{t('then sort A–Z')}</option>
                  </select>
                </div>
              </Step>
            ) : null}

            {optionDone && op === 'retire' && (hasDefaults || hasTrims) ? (
              <Step n={2} done label={t('Options')}>
                {hasDefaults ? (
                  <label className="check"><input type="checkbox" checked={!form.keepDefaults} onChange={(e) => patch({ keepDefaults: !e.target.checked })} />
                    {tn(src.def.length, 'It is the default in {n} field: remove the default there (otherwise that field is skipped)', 'It is the default in {n} fields: remove the default there (otherwise those fields are skipped)')}</label>
                ) : null}
                {hasTrims ? <label className="check"><input type="checkbox" checked={form.includeTrims} onChange={(e) => patch({ includeTrims: e.target.checked })} />{t('Also retire the sub-options under it (cascading fields)')}</label> : null}
              </Step>
            ) : null}

            {optionDone && detailDone && anchor ? (
              <Step n={op === 'retire' && !(hasDefaults || hasTrims) || op === 'restore' ? 2 : 3} done label={t('In which fields?')} htmlFor="b-fields">
                <Picker
                  id="b-fields" label={t('Fields')} multiple items={fieldItems} value={form.fieldIds} onChange={(v) => patch({ fieldIds: v })}
                  allLabel={tn(scopeCount, 'All {n} field that has "{name}"', 'All {n} fields that have "{name}"', { name: anchor })}
                  searchPlaceholder={t('Search fields')} emptyText={t('No field matches.')}
                />
              </Step>
            ) : null}

            {summary.lines.length ? (
              <div className="summary" aria-live="polite">
                <ul>{summary.lines.map((l) => <li key={l.text} className={l.tone}>{l.text}</li>)}</ul>
              </div>
            ) : null}

            <div className="row" style={{ marginTop: 12 }}>
              <button type="button" className="btn primary" disabled={!summary.ok || !detailDone || !!busy || scanning || running} onClick={scan}>
                {busy === 'scan' ? t('Checking every field…') : t('Preview the change')}
              </button>
              <span className="muted small">{t(opInfo.help)} {t('Nothing changes before you apply it.')}</span>
            </div>
          </>
        ) : null}
        {!cat && !catProgress && !catErr ? <Skeleton lines={3} /> : null}
      </div>

      {err ? <Msg tone="error">{err}</Msg> : null}

      {scanning ? <div className="card"><Progress done={job.progress?.done || 0} total={job.progress?.total || 0} label={job.progress?.note || t('Checking fields')} /></div> : null}

      {job && items && !scanning ? (
        <div className="card">
          <div className="row">
            <h3 className="grow">{job.description}</h3>
            <Loz tone={(STATUS[job.status] || [])[0]}>{word(STATUS, job.status)}</Loz>
            {job.issueKey ? <IssueLink k={job.issueKey} /> : null}
          </div>
          <div className="cards">
            <div className="card stat"><strong>{ready ? included.length : job.totals?.change ?? changeItems.length}</strong><span>{t('fields to change')}</span></div>
            <div className="card stat"><strong>{ready ? workItemsShown(job, included, exclude, sum) : job.totals?.workItems ?? 0}</strong><span title={job.totals?.distinctNote || undefined}>{isReplace ? t('work items to update') : t('work items affected')}{job.totals?.distinct === false ? ` ${t('(at most)')}` : ''}</span></div>
            {isReplace && job.progress?.moved ? <div className="card stat"><strong>{job.progress.moved}</strong><span>{t('work-item values updated')}{job.progress.itemsFailed ? ` · ${t('{n} failed', { n: job.progress.itemsFailed })}` : ''}</span></div> : null}
            <div className="card stat"><strong>{ready ? included.filter((i) => i.defaultCleared).length : job.totals?.defaultsCleared ?? 0}</strong><span>{isReplace ? t('defaults moved') : t('defaults cleared')}</span></div>
            <div className="card stat"><strong>{(items || []).filter((i) => i.action === 'skip').length}</strong><span>{t('skipped (not there / already done)')}</span></div>
            {changeItems.some((i) => i.editable === 'approval') ? <div className="card stat warn"><strong>{included.filter((i) => i.editable === 'approval').length}</strong><span>{t('shared: need approval')}</span></div> : null}
            {(items || []).some((i) => i.action === 'blocked') ? <div className="card stat bad"><strong>{(items || []).filter((i) => i.action === 'blocked').length}</strong><span>{t('not possible here')}</span></div> : null}
          </div>
          {running ? <Progress done={job.status === 'undoing' ? job.undo?.progress?.done || 0 : job.progress?.done || 0} total={job.status === 'undoing' ? job.undo?.progress?.total || 0 : job.progress?.total || 0} label={job.status === 'undoing' ? (job.undo?.progress?.restored ? t('Undoing ({n} values back)', { n: job.undo.progress.restored }) : t('Undoing')) : (job.progress?.moved ? t('Changing fields ({n} work-item values updated)', { n: job.progress.moved }) : t('Changing fields'))} /> : null}
          {job.status === 'failed' ? <Msg tone="error">{job.note}</Msg> : null}
          {job.status === 'pending-approval' ? <Msg tone="warning" title={t('Waiting for approval: {key}', { key: job.issueKey })}>{t('The whole batch runs as soon as it is approved, even if this page is closed.')}</Msg> : null}
          {['done', 'partial'].includes(job.status) ? (
            <Msg tone={job.status === 'done' ? 'success' : 'warning'} title={[
              tn(job.progress?.changed || 0, '{n} field changed', '{n} fields changed'),
              job.progress?.moved ? tn(job.progress.moved, '{n} work-item value updated', '{n} work-item values updated') : null,
              job.progress?.failed ? t('{n} failed', { n: job.progress.failed }) : null,
              job.progress?.itemsFailed ? tn(job.progress.itemsFailed, '{n} work item could not be changed', '{n} work items could not be changed') : null,
            ].filter(Boolean).join(', ')}>
              <div>{job.undoRequest ? <span className="small">{t('Undo waiting for approval:')} <IssueLink k={job.undoRequest} /></span> : (admin || job.mine !== false) ? <button type="button" className="btn small" disabled={!!busy} onClick={() => setConfirmUndo({ id: job.id, what: job.description, fields: job.progress?.changed || 0, moved: job.progress?.moved || 0 })}>{busy === `undo:${job.id}` ? t('Undoing…') : viaApproval ? t('Request undo of the whole bulk change') : t('Undo the whole bulk change')}</button> : null}</div>
            </Msg>
          ) : null}
          {job.status === 'undone' ? (
            <Msg tone="info" title={t('Undone')}>
              {t('Every field is back to how it was before this bulk change.')}
              {job.undo?.progress?.restored ? ` ${tn(job.undo.progress.restored, '{n} work-item value is back to its old value.', '{n} work-item values are back to their old value.')}` : ''}
              {job.undo?.progress?.changedSince ? ` ${tn(job.undo.progress.changedSince, '{n} work item was changed by someone since, so it was left as it is.', '{n} work items were changed by someone since, so they were left as they are.')}` : ''}
            </Msg>
          ) : null}

          <div className="row view-switch" role="tablist" aria-label={t('Show')}>
            {[['change', t('Will change')], ['skip', t('Skipped')], ['blocked', t('Not possible')], ['result', t('Results')], ['all', t('All')]].map(([k, l]) => (
              <button key={k} type="button" className={`btn small ${show === k ? 'primary' : ''}`} onClick={() => setShow(k)}>{l}</button>
            ))}
            {ready ? <span className="grow" /> : null}
            {ready ? <button type="button" className="btn small subtle" onClick={() => setExclude(exclude.length ? [] : changeItems.map((i) => i.fieldId))}>{exclude.length ? t('Select all') : t('Select none')}</button> : null}
          </div>
          <table className="t">
            <thead><tr>{ready ? <th aria-label={t('Include')} /> : null}<th>{t('Field')}</th><th>{t('Type')}</th><th>{t('What changes')}</th><th>{t('Work items')}</th><th>{t('Status')}</th></tr></thead>
            <tbody>
              {shown.map((i) => (
                <tr key={i.fieldId}>
                  {ready ? <td>{i.action === 'change' ? <input type="checkbox" aria-label={t('Include {name}', { name: i.fieldName })} checked={!exclude.includes(i.fieldId)} onChange={(e) => setExclude(e.target.checked ? exclude.filter((x) => x !== i.fieldId) : [...exclude, i.fieldId])} /> : null}</td> : null}
                  <td><strong>{i.fieldName}</strong><div className="muted small">{i.fieldId}{i.scope === 'shared' ? ` · ${t('shared')}` : ''}</div></td>
                  <td className="muted">{i.typeLabel}</td>
                  <td>{i.action === 'change' ? (i.rows || []).map((r, n) => <div key={n} className="small"><Loz tone="blue">{r.action}</Loz> {r.option}{r.new && r.new !== r.option ? ` → ${r.new}` : ''}</div>) : <span className="muted small">{i.reason}</span>}
                    {i.defaultCleared ? <div className="small"><Loz tone="yellow">{t('default cleared')}</Loz></div> : null}</td>
                  <td>{i.result && isReplace ? `${i.moved || 0}${i.failedItems ? ` (${t('{n} failed', { n: i.failedItems })})` : ''}` : i.affected ?? '–'}</td>
                  <td>{i.result ? <><Loz tone={RESULT[i.result][0]}>{t(RESULT[i.result][1])}</Loz>{i.undone ? <> <Loz>{t('undone')}</Loz></> : null}{i.resultNote ? <div className="muted small">{i.resultNote}</div> : null}</> : <Loz tone={ACTION[i.action]?.[0]}>{word(ACTION, i.action)}</Loz>}</td>
                </tr>
              ))}
              {!shown.length ? <tr><td colSpan={6} className="muted">{t('Nothing in this view.')}</td></tr> : null}
            </tbody>
          </table>
          {ready ? (
            <div className="row sticky-actions">
              <button type="button" className="btn primary" disabled={!included.length || !!busy} onClick={startJob}>
                {busy === 'start' ? t('Starting…') : viaApproval ? tn(included.length, 'Request approval for {n} field', 'Request approval for {n} fields') : tn(included.length, 'Apply to {n} field', 'Apply to {n} fields')}
              </button>
              <span className="muted small">{viaApproval ? t('One approval request for the whole batch. It runs as soon as a Jira administrator approves it, even if this page is closed.') : t('Runs as one batch: one entry in the audit log per field, one approval if needed, one-click undo afterwards.')}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <div className="row"><h3 className="grow">{t('History')}</h3><button type="button" className="btn small subtle" onClick={loadHistory}>{t('Refresh')}</button></div>
        {!hist ? <Skeleton lines={3} /> : !hist.length ? <p className="muted">{t('No bulk changes in this space yet.')}</p> : (
          <table className="t">
            <thead><tr><th>{t('When')}</th><th>{t('What')}</th><th>{t('By')}</th><th>{t('Fields')}</th><th>{t('Status')}</th><th /></tr></thead>
            <tbody>
              {hist.map((h) => (
                <tr key={h.id}>
                  <td className="muted small">{when(h.created)}</td>
                  <td>{h.description}{h.issueKey ? <div className="small"><IssueLink k={h.issueKey} /></div> : null}</td>
                  <td className="small">{h.by}</td>
                  <td>{h.progress?.changed ?? h.totals?.change ?? '–'}</td>
                  <td><Loz tone={(STATUS[h.status] || [])[0]}>{word(STATUS, h.status)}</Loz></td>
                  <td className="row">
                    <button type="button" className="btn small" onClick={() => openJob(h.id)}>{t('Details')}</button>
                    {undoButton(h)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
