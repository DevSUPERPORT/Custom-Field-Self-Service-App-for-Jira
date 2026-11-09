/**
 * "Requests for you": requests waiting for this person's decision (approve, or reject with a reason, one by one or
 * several at once) and new fields approved for this space that still need to go on its screens.
 *
 * @file        static/main/src/Inbox.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useEffect, useState } from 'react';
import { call, Msg, Skeleton, IssueLink, when, useToast, decideRequest, useAutoRefresh, Icon, Note, Empty, Status, Modal, useCanWrite, PAUSED_HINT } from './ui';
import { t, tn } from './i18n';
import ChangeDiff from './ChangeDiff';

const KIND = { field: 'New field', options: 'Option change', reuse: 'Reuse field', stage1: 'Request from a colleague', bundle: 'Field bundle', bulk: 'Bulk change', bulkundo: 'Undo of a bulk change' };
// One line under a request in the list: what kind of change, and what it touches.
const listLine = (p) => {
  const d = p.diff || {};
  const parts = [t(KIND[p.kind] || 'Change')];
  if (d.options) {
    const c = d.options.counts;
    if (c.added) parts.push(tn(c.added, '{n} added', '{n} added'));
    if (c.renamed) parts.push(tn(c.renamed, '{n} renamed', '{n} renamed'));
    if (c.retired) parts.push(tn(c.retired, '{n} retired', '{n} retired'));
  }
  if (d.spaces && d.spaces.length + (d.hiddenSpaces || 0) > 1) parts.push(tn(d.spaces.length + (d.hiddenSpaces || 0), '{n} space', '{n} spaces'));
  if (d.workItems) parts.push(tn(d.workItems, '{n} work item', '{n} work items'));
  return parts.join(' · ');
};

// A field approved for this space as well, not on its screens yet: one click puts it on the space's own screens.
function FollowUp({ todo, screens, onDone, i }) {
  const toast = useToast();
  const own = (screens || []).filter((s) => s.exclusive);
  const [ids, setIds] = useState(null);
  const [busy, setBusy] = useState(false);
  const chosen = ids === null ? own.map((s) => s.screenId) : ids;
  const act = async (kind) => {
    setBusy(true);
    try {
      if (kind === 'add') {
        const r = await call('todoAddScreens', { fieldId: todo.fieldId, screenIds: chosen });
        toast(r.added?.length ? t('Added to {screens}.', { screens: r.added.join(', ') }) : t('Nothing to add.'), 'ok');
      } else {
        await call('todoDismiss', { fieldId: todo.fieldId });
        toast(t('Noted: not added to your screens.'));
      }
      onDone();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  };
  return (
    <article className="card stack tight rise" style={{ '--i': i }}>
      <div className="spread">
        <div className="stack tight">
          <h3>{todo.fieldName}</h3>
          <small>{t('Approved for this space together with {origin}', { origin: todo.origin })}{todo.issueKey ? <> · <IssueLink k={todo.issueKey} /></> : null} · {when(todo.at)}</small>
        </div>
        <span className="loz orange">{t('Not on your screens yet')}</span>
      </div>
      {screens === null ? <Skeleton lines={2} /> : own.length ? (
        <div className="screens">{own.map((s) => (
          <label key={s.screenId} className="screen-row">
            <input type="checkbox" checked={chosen.includes(s.screenId)} onChange={(e) => setIds(e.target.checked ? [...chosen, s.screenId] : chosen.filter((x) => x !== s.screenId))} />
            <span className="grow"><span>{s.name}</span><small>{s.operations.join(', ')}</small></span>
          </label>
        ))}</div>
      ) : <small>{t('This space has no screens of its own; a Jira administrator adds the field to shared screens.')}</small>}
      <div className="row">
        <button type="button" className="btn primary small" disabled={busy || !chosen.length} onClick={() => act('add')}><Icon name="plus" />{t('Add to my screens')}</button>
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => act('dismiss')}>{t('Not needed here')}</button>
      </div>
      <small>{t('The field goes to the bottom of the first tab. Logged in the audit log.')}</small>
    </article>
  );
}

// Several requests decided at once: one comment for all (required to reject), then one decision after the other,
// each through Jira as the person, with progress. One failing request does not stop the others; those stay selected,
// so they can be retried or decided one by one.
function BulkDecide({ items, decision, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [run, setRun] = useState(null);
  const reject = decision !== 'approve';
  const running = run && !run.finished;
  const start = async () => {
    if (reject && reason.trim().length < 3) { setErr(t('Give a reason for the rejection: the requester sees it.')); return; }
    const results = [];
    setRun({ results, finished: false });
    for (const p of items) {
      try {
        const r = await decideRequest(p.issueKey, decision, reason.trim());
        results.push({ key: p.issueKey, summary: p.summary, ok: true, result: r.result });
      } catch (e) {
        results.push({ key: p.issueKey, summary: p.summary, ok: false, error: e.message });
      }
      setRun({ results: [...results], finished: false });
    }
    setRun({ results: [...results], finished: true });
    onDone(results.filter((r) => !r.ok).map((r) => r.key));
  };
  const ok = run ? run.results.filter((r) => r.ok).length : 0;
  const failed = run ? run.results.filter((r) => !r.ok) : [];
  const title = reject
    ? tn(items.length, 'Reject {n} request', 'Reject {n} requests')
    : tn(items.length, 'Approve {n} request', 'Approve {n} requests');
  const footer = !run ? <>
    <button type="button" className="btn ghost" onClick={onClose}>{t('Cancel')}</button>
    <button type="button" className={`btn ${reject ? 'danger' : 'primary'}`} onClick={start}>{reject ? null : <Icon name="check" />}{title}</button>
  </> : <button type="button" className="btn primary" disabled={running} autoFocus={!running} onClick={onClose}>{t('Close')}</button>;
  return (
    <Modal title={title} onClose={running ? () => null : onClose} footer={footer} wide>
      {!run ? (
        <div className="stack">
          <ol className="steps">{items.map((p, i) => (
            <li key={p.issueKey} style={{ '--i': i }}><span className="n">{i + 1}</span><span><strong>{p.summary}</strong><small> {p.requester} · {p.issueKey}</small></span></li>
          ))}</ol>
          {!reject ? <Note icon="warn" tone="accent">{t('Each approved request is carried out right away, exactly as shown in its details.')}</Note> : null}
          <div>
            <label className="field" htmlFor="bulk-reason">{t('Comment to the requesters')} {reject ? <span className="muted">{t('(required for a rejection)')}</span> : null}</label>
            <textarea id="bulk-reason" rows={3} value={reason} autoFocus onChange={(e) => { setReason(e.target.value); setErr(''); }} placeholder={t('e.g. please use the existing field "…"')} />
            {err ? <div className="hint" style={{ color: 'var(--bad)' }}>{err}</div> : null}
          </div>
        </div>
      ) : (
        <div className="stack" aria-live="polite">
          <small>{run.finished
            ? t('Finished: {done} of {total} request(s) decided.', { done: ok, total: items.length })
            : t('Deciding request {i} of {total}…', { i: Math.min(run.results.length + 1, items.length), total: items.length })}</small>
          <div className="progressline"><i style={{ width: `${Math.round((run.results.length / Math.max(1, items.length)) * 100)}%` }} /></div>
          <ul className="plain">{run.results.map((r) => (
            <li key={r.key}><Icon name={r.ok ? 'check' : 'x'} /> <strong>{r.key}</strong> {r.summary}{r.ok ? <small> · {r.result}</small> : <small className="bad"> · {r.error}</small>}</li>
          ))}</ul>
          {run.finished && failed.length ? <Msg tone="error" title={t('Not decided')}>{t('The requests that failed stay selected: try again, or open them one by one.')}</Msg> : null}
        </div>
      )}
    </Modal>
  );
}

export default function Inbox({ refreshKey, onCount }) {
  const canWrite = useCanWrite();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [sel, setSel] = useState(null);
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState('');
  const [screens, setScreens] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [bulk, setBulk] = useState(null);
  const load = () => call('inbox').then((r) => { setData(r); setError(''); onCount(r.items.length + (r.todos || []).length); }).catch((e) => setError(e.message));
  useAutoRefresh(load, { paused: !!busy || !!reason || !!bulk });
  useEffect(() => { if (refreshKey) load(); }, [refreshKey]);
  useEffect(() => { if (data?.todos?.length && screens === null) call('screens', {}).then((r) => setScreens(r.screens)).catch(() => setScreens([])); }, [data]);
  if (error) return <Msg tone="error">{error}</Msg>;
  if (!data) return <Skeleton lines={5} />;

  const items = data.items || [];
  const todos = data.todos || [];
  const shown = items.find((p) => p.issueKey === sel) || items[0];
  // Only requests still waiting count as selected (decided ones drop out of the list on reload).
  const chosen = items.filter((p) => picked.has(p.issueKey));
  const togglePick = (k, on) => setPicked((s) => { const n = new Set(s); if (on) n.add(k); else n.delete(k); return n; });
  const decide = async (decision) => {
    if (decision !== 'approve' && reason.trim().length < 3) { setReasonErr(t('Give a reason for the rejection: the requester sees it.')); return; }
    setBusy(shown.issueKey);
    setReasonErr('');
    try {
      const r = await decideRequest(shown.issueKey, decision, reason.trim());
      toast(`${shown.issueKey}: ${decision === 'approve' ? t('approved') : t('rejected')} (${r.result})`, 'ok');
      setReason('');
      setSel(null);
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(null);
  };

  if (!items.length && !todos.length && !bulk) return <Empty icon="inbox" title={t('Nothing waits for you')}>{t('Requests you can decide, and new fields to put on your screens, appear here.')}</Empty>;

  return (
    <div className="stack">
      {items.length ? (
        <div className="two-col">
          <section className="list qlist" aria-label={t('Requests')}>
            <div className="spread">
              <div className="eyebrow">{t('Waiting for your decision ({n})', { n: items.length })}</div>
              {items.length > 1 ? (
                <label className="check small"><input type="checkbox" checked={chosen.length === items.length} ref={(el) => { if (el) el.indeterminate = chosen.length > 0 && chosen.length < items.length; }}
                  onChange={(e) => setPicked(new Set(e.target.checked ? items.map((p) => p.issueKey) : []))} />{t('Select all')}</label>
              ) : null}
            </div>
            {/* A fixed slot, so ticking a request never moves the list under the pointer. */}
            {items.length > 1 ? (
              <div className={`selbar ${chosen.length ? 'on' : ''}`} role="region" aria-label={t('Selected requests')} aria-live="polite">
                {chosen.length ? <>
                  <strong>{tn(chosen.length, '{n} selected', '{n} selected')}</strong>
                  <span className="grow" />
                  <button type="button" className="btn small" onClick={() => setBulk({ decision: 'decline', items: chosen })}>{t('Reject')}</button>
                  <button type="button" className="btn primary small" onClick={() => setBulk({ decision: 'approve', items: chosen })}><Icon name="check" />{t('Approve')}</button>
                </> : <small className="muted">{t('Tick requests to decide several at once.')}</small>}
              </div>
            ) : null}
            {items.map((p, i) => (
              <div key={p.issueKey} className="qrow">
                {items.length > 1 ? <input type="checkbox" aria-label={t('Select {name}', { name: p.summary })} checked={picked.has(p.issueKey)} onChange={(e) => togglePick(p.issueKey, e.target.checked)} /> : null}
                <button type="button" className="qitem rise" style={{ '--i': i }} aria-current={shown?.issueKey === p.issueKey} onClick={() => { setSel(p.issueKey); setReasonErr(''); }}>
                  <span className="d" />
                  <span className="grow"><strong>{p.diff?.field || p.summary}</strong><small className="kind">{listLine(p)}</small><small>{p.requester} · {when(p.created)} · {p.stage === 'admin' ? t('Stage 1: project admins decide') : t('Final approval')}</small></span>
                </button>
              </div>
            ))}
          </section>
          {shown ? (
            <section className="detail card stack enter" key={shown.issueKey} aria-label={t('Request details')}>
              <div className="spread">
                <div className="stack tight"><span className="eyebrow">{t(KIND[shown.kind] || 'Change')}</span><h2>{shown.summary}</h2><small>{t('Requested by {name} on {date}', { name: shown.requester, date: when(shown.created) })} · <IssueLink k={shown.issueKey} /></small></div>
                <Status s="waiting" />
              </div>
              <div className="stack tight">
                <h3>{t('What changes once you approve')}</h3>
                {shown.diff ? <ChangeDiff d={shown.diff} /> : (
                  <ol className="steps">{shown.rows.filter((r) => r.action !== 'Justification').map((r, i) => (
                    <li key={i} style={{ '--i': i }}><span className="n">{i + 1}</span><span><strong>{r.action}</strong>{r.option ? ` · ${r.option}` : ''}{r.old || r.new ? <small> {r.old ? `${r.old} → ` : ''}{r.new}</small> : null}</span></li>
                  ))}</ol>
                )}
              </div>
              {shown.briefing?.length || shown.reason ? (
                <details className="brief" open={shown.risk === 'high' || shown.risk === 'medium'}>
                  <summary>{t('Why it needs approval, and the briefing')}</summary>
                  <Note icon="warn" tone="accent">{shown.reason ? <span><strong>{t('Why approval:')}</strong> {shown.reason}</span> : null}{(shown.briefing || []).map((b) => <span key={b}>{b}</span>)}</Note>
                </details>
              ) : null}
              <div>
                <label className="field" htmlFor="reason">{t('Comment to the requester')} <span className="muted">{t('(required for a rejection)')}</span></label>
                <textarea id="reason" rows={3} value={reason} onChange={(e) => { setReason(e.target.value); setReasonErr(''); }} placeholder={t('e.g. please use the existing field "…"')} />
                {reasonErr ? <div className="hint" style={{ color: 'var(--bad)' }}>{reasonErr}</div> : null}
              </div>
              <div className="decide">
                <button type="button" className="btn big" disabled={!!busy || !canWrite} onClick={() => decide('decline')}>{t('Reject')}</button>
                <button type="button" className="btn primary big" disabled={!!busy || !canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={() => decide('approve')}><Icon name="check" />{busy ? t('Working…') : t('Approve')}</button>
              </div>
              <small>{t('Your decision goes through Jira as you; the app then checks again who decided and carries the request out.')}</small>
            </section>
          ) : null}
        </div>
      ) : null}

      {todos.length ? (
        <div className="stack">
          <div className="eyebrow">{t('New fields for your screens ({n})', { n: todos.length })}</div>
          {todos.map((x, i) => <FollowUp key={x.fieldId} todo={x} screens={screens} i={i} onDone={load} />)}
        </div>
      ) : null}
      {bulk ? (
        // The requests are fixed when the dialog opens: live updates reload the list while it works.
        <BulkDecide items={bulk.items} decision={bulk.decision} onClose={() => { setBulk(null); load(); }}
          onDone={(failedKeys) => { setPicked(new Set(failedKeys)); setSel(null); toast(t('Decisions recorded.'), 'ok'); }} />
      ) : null}
    </div>
  );
}
