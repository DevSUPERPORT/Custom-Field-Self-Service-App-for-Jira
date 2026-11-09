/**
 * Approvals tab of the admin control centre: open requests on the left, the chosen request on the right with what the
 * app will create, and approve, reject or cancel.
 *
 * @file        static/main/src/admin/Approvals.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useRef, useState } from 'react';
import { call, decideRequest, IssueLink, Icon, Loz, Msg, Note, Empty, Status, Spinner, when, day, useToast, useFlip, useCanWrite, PAUSED_HINT } from '../ui';
import { t, tn } from '../i18n';
import { requestStatus } from '../../../../src/shared/status.js';
import { RISK_TONE } from './common';
import ChangeDiff from '../ChangeDiff';

const KIND = {
  field: 'New field', options: 'Option change', reuse: 'Reuse field', stage1: 'Request from a colleague', bundle: 'Field bundle',
  bulk: 'Bulk change', bulkundo: 'Undo of a bulk change', projects: 'Spaces of a field', screens: 'Screens', update: 'Field change', text: 'Field change', pattern: 'Field change',
};
const kindText = (k) => t(KIND[k] || 'Change');
const RISK_TEXT = { low: 'low risk', medium: 'medium risk', high: 'high risk' };

// "PROJ" or "PROJ + 2 spaces".
const spaces = (keys) => (keys.length > 1 ? `${keys[0]} + ${tn(keys.length - 1, '{n} space', '{n} spaces')}` : keys[0] || '');
const rowOf = (p, action) => p.rows.find((r) => r.action === action);

// One step of "what the app creates after approval", from a row of the request.
const stepText = (r) => {
  if (r.action === 'New field') return t('Custom field "{name}": {detail}', { name: r.option, detail: r.new });
  if (r.action === 'Options') return t('Options: {list}', { list: r.new });
  if (r.action === 'Default') return t('Default value "{value}"', { value: r.new });
  if (r.action === 'Copy values') return t('Copy the values of {from} into the new field', { from: r.old });
  if (r.action === 'Other spaces') return r.new;
  const change = r.old ? `${r.old} → ${r.new}` : r.new;
  return `${r.action}${r.option ? `: ${r.option}` : ''}${change ? ` · ${change}` : ''}`;
};

// The three tiles: the field, its context and the rest (screens for a new field, else the changes).
function Tiles({ p, types }) {
  const isField = p.kind === 'field';
  const newRow = rowOf(p, 'New field');
  const opts = rowOf(p, 'Options');
  const def = rowOf(p, 'Default');
  const other = rowOf(p, 'Other spaces');
  const typeLabel = types.find((x) => x.key === p.typeKey)?.label;
  const extras = newRow ? String(newRow.new).split(';').slice(1).map((x) => x.trim()).filter(Boolean) : [];
  const screens = extras.filter((x) => /screen/i.test(x));
  const changes = p.rows.filter((r) => r.action !== 'Justification');
  return (
    <div className="grid-3">
      <div className="tile rise" style={{ '--i': 0 }}>
        <span className="eyebrow">{t('Field')}</span>
        <strong>{isField ? (typeLabel || p.typeKey || t('New field')) : (p.fieldName || kindText(p.kind))}</strong>
        {opts ? <span>{opts.new}</span> : null}
        {!isField && p.fieldName ? <span>{kindText(p.kind)}</span> : null}
        {def ? <small>{t('Default: {value}', { value: def.new })}</small> : null}
      </div>
      <div className="tile rise" style={{ '--i': 1 }}>
        <span className="eyebrow">{t('Context')}</span>
        <strong>{tn(p.projects.length, '{n} space', '{n} spaces')}</strong>
        <span>{p.projects.join(', ')}</span>
        {p.projects.length === 1 ? <small>{t('only this space')}</small> : null}
      </div>
      {isField ? (
        <div className="tile rise" style={{ '--i': 2 }}>
          <span className="eyebrow">{t('Screens')}</span>
          <strong>{screens.length ? screens.join(', ') : t('No screens')}</strong>
          {extras.filter((x) => !screens.includes(x)).map((x) => <span key={x}>{x}</span>)}
          {other ? <small>{other.new}</small> : null}
        </div>
      ) : (
        <div className="tile rise" style={{ '--i': 2 }}>
          <span className="eyebrow">{t('Changes')}</span>
          <strong>{tn(changes.length, '{n} change', '{n} changes')}</strong>
          {changes.slice(0, 3).map((r, i) => <span key={i}>{r.action}{r.option ? `: ${r.option}` : ''}</span>)}
          {changes.length > 3 ? <small>{t('and {n} more', { n: changes.length - 3 })}</small> : null}
        </div>
      )}
    </div>
  );
}

// The chosen request: who asked and why, the briefing, what the app will do, and the decision.
function Detail({ p, types, busy, onDecide, onCancel }) {
  const canWrite = useCanWrite();
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState('');
  const isField = p.kind === 'field';
  const pending = p.status === 'pending';
  const justification = rowOf(p, 'Justification');
  const steps = p.rows.filter((r) => r.action !== 'Justification');
  const reject = () => {
    if (reason.trim().length < 3) {
      setReasonErr(t('Give a reason of at least 3 characters: the requester sees it.'));
      return;
    }
    setReasonErr('');
    onDecide(p.issueKey, 'decline', reason.trim());
  };
  return (
    <section className="card admin-detail enter" aria-label={t('Request details')}>
      <div className="detail-head">
        <div className="stack tight grow">
          <h2>{p.fieldName || p.summary}</h2>
          {p.description ? <p>{p.description}</p> : p.fieldName ? <p>{p.summary}</p> : null}
          {justification ? <p><span className="muted">{t('Justification:')}</span> {justification.new}</p> : null}
          <small>{t('Requested on {date} by {name} · approval request', { date: when(p.created), name: p.requester })} <IssueLink k={p.issueKey} /></small>
        </div>
        <div className="stack tight" style={{ alignItems: 'flex-end' }}>
          <Status s={requestStatus(p)} />
          <Loz tone={RISK_TONE[p.risk]}>{t(RISK_TEXT[p.risk] || p.risk)}</Loz>
        </div>
      </div>

      <Note icon="warn" tone="accent">
        <span><strong>{t('Why approval:')}</strong> {p.reason || t('every change by a project admin is approved by a Jira administrator')}</span>
        {p.briefing.map((b, i) => <span key={i}>{b}</span>)}
        <span className="muted">
          {p.stage === 'admin' ? t('Stage 1: the project admins decide.') : t('Decided by a Jira administrator.')}{' '}
          {t('Approvers: {list}', { list: p.approvers.join(', ') || t('the approvers set under Configuration') })}
        </span>
      </Note>

      {p.error ? (
        <Note icon="warn" tone="bad">
          <strong>{tn(p.attempts, 'Problem after {n} attempt', 'Problem after {n} attempts')}</strong>
          <span>{p.error}</span>
        </Note>
      ) : null}

      {p.diff ? (
        <div className="stack tight">
          <h3>{isField ? t('What the app creates after approval') : t('What changes after approval')}</h3>
          <ChangeDiff d={p.diff} />
        </div>
      ) : <Tiles p={p} types={types} />}

      {!p.diff && steps.length ? (
        <div className="stack tight">
          <h3>{isField ? t('What the app creates after approval') : t('What the app does after approval')}</h3>
          <ol className="steps">
            {steps.map((r, i) => <li key={i} style={{ '--i': i }}><span className="n">{i + 1}</span><span>{stepText(r)}</span></li>)}
          </ol>
        </div>
      ) : null}

      {pending ? (
        <div>
          <label className="field" htmlFor="reason">{t('Comment to the requester')} <span className="muted">{t('(required for a rejection)')}</span></label>
          <textarea
            id="reason" rows={3} value={reason} aria-invalid={!!reasonErr} aria-describedby={reasonErr ? 'reason-err' : undefined}
            placeholder={t('For example: please use the existing field "Supplier"')}
            onChange={(e) => { setReason(e.target.value); if (reasonErr && e.target.value.trim().length >= 3) setReasonErr(''); }}
          />
          {reasonErr ? <div id="reason-err" className="field-err" role="alert">{reasonErr}</div> : null}
        </div>
      ) : null}

      <div className="decide">
        <button type="button" className="btn ghost" disabled={!!busy || !canWrite} onClick={() => onCancel(p.issueKey)}>
          {busy === `cancel:${p.issueKey}` ? <Spinner /> : <Icon name="undo" />}{t('Cancel request')}
        </button>
        {pending ? (
          <>
            <button type="button" className="btn big" disabled={!!busy || !canWrite} onClick={reject}>
              {busy === `decline:${p.issueKey}` ? <Spinner /> : <Icon name="x" />}{t('Reject')}
            </button>
            <button type="button" className="btn primary big" disabled={!!busy || !canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={() => onDecide(p.issueKey, 'approve', reason.trim())}>
              {busy === `approve:${p.issueKey}` ? <Spinner /> : <Icon name="check" />}{isField ? t('Approve and create') : t('Approve')}
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}

// Approvals: everything waiting, the chosen request in detail. Decisions go through Jira's approval as the viewer,
// then the app executes and checks again who approved.
export default function Approvals({ state, reload, onBusy }) {
  const canWrite = useCanWrite();
  const toast = useToast();
  const [busy, setBusyRaw] = useState(null);
  const [msg, setMsg] = useState(null);
  const [sel, setSel] = useState(null);
  // Storage listings can lag a moment behind a decision: hide what was just decided until the list catches up.
  const [decided, setDecided] = useState([]);
  const list = useRef(null);
  const setBusy = (b) => { setBusyRaw(b); onBusy(!!b); };

  const rows = state.open.filter((p) => !decided.includes(p.issueKey));
  const waiting = rows.filter((p) => p.status === 'pending');
  const low = waiting.filter((p) => (p.stage || 'superport') === 'superport' && p.risk === 'low');
  const shown = rows.find((p) => p.issueKey === sel) || rows[0] || null;
  useFlip(list, [rows.map((p) => p.issueKey).join('|')]);

  const after = () => { reload(); setTimeout(reload, 2500); };
  const decide = async (issueKey, decision, reason) => {
    setBusy(`${decision}:${issueKey}`);
    setMsg(null);
    try {
      const r = await decideRequest(issueKey, decision, reason);
      toast(t('{key}: {result}', { key: issueKey, result: r.result }), 'ok');
      if (r.result !== 'pending') setDecided((d) => [...d, issueKey]);
      after();
    } catch (e) {
      setMsg({ tone: 'error', text: e.message });
      toast(e.message, 'error');
    }
    setBusy(null);
  };
  const lowRisk = async () => {
    setBusy('all');
    setMsg(null);
    const results = [];
    for (const p of low) {
      try {
        results.push({ issueKey: p.issueKey, result: (await decideRequest(p.issueKey, 'approve')).result });
      } catch (e) {
        results.push({ issueKey: p.issueKey, error: e.message });
      }
    }
    const done = results.filter((x) => !x.error && x.result !== 'pending').map((x) => x.issueKey);
    setDecided((d) => [...d, ...done]);
    const failed = results.filter((x) => x.error);
    if (failed.length) setMsg({ tone: 'warning', text: results.map((x) => `${x.issueKey}: ${x.error || x.result}`).join(' · ') });
    else toast(tn(results.length, '{n} low-risk request approved', '{n} low-risk requests approved'), 'ok');
    after();
    setBusy(null);
  };
  const cancel = async (issueKey) => {
    setBusy(`cancel:${issueKey}`);
    setMsg(null);
    try {
      await call('cancel', { issueKey, why: 'withdrawn on the admin page' });
      toast(t('{key} withdrawn.', { key: issueKey }), 'ok');
      setDecided((d) => [...d, issueKey]);
      after();
    } catch (e) {
      setMsg({ tone: 'error', text: e.message });
    }
    setBusy(null);
  };

  if (!rows.length) {
    return (
      <div className="card" data-tour="approvals">
        <Empty icon="inbox" title={t('Nothing waits for a decision')}>{t('New requests appear here. You also get an e-mail for each one, and a daily digest.')}</Empty>
      </div>
    );
  }
  return (
    <div className="stack" data-tour="approvals">
      <div className="spread">
        <p className="muted">{t('{n} waiting, {low} of them low risk.', { n: waiting.length, low: low.length })} {t('Decisions go through Jira\'s approval as you, so Jira checks you are an approver; the app then executes and checks again who approved.')}</p>
        <button type="button" className="btn primary small" disabled={!!busy || !low.length || !canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={lowRisk}>
          {busy === 'all' ? <Spinner /> : <Icon name="check" />}{busy === 'all' ? t('Approving…') : t('Approve all low-risk ({n})', { n: low.length })}
        </button>
      </div>
      {msg ? <Msg tone={msg.tone}>{msg.text}</Msg> : null}
      <div className="two-col">
        <section className="list qlist" aria-label={t('Requests')} ref={list}>
          <span className="eyebrow">{t('Open requests ({n})', { n: rows.length })}</span>
          {rows.map((p, i) => {
            const st = requestStatus(p);
            return (
              <button key={p.issueKey} type="button" data-flip={p.issueKey} className="qitem rise" style={{ '--i': i }} aria-current={shown?.issueKey === p.issueKey} onClick={() => setSel(p.issueKey)}>
                <span className={`d ${p.status === 'pending' ? '' : 'off'}`} />
                <span className="grow">
                  <strong>{p.fieldName || p.summary}</strong>
                  <small>{kindText(p.kind)}{p.projects.length ? ` · ${spaces(p.projects)}` : ''}</small>
                  <small>{p.requester} · {day(p.created)}</small>
                  {st === 'fail' ? <span><Status s="fail" /></span> : null}
                </span>
              </button>
            );
          })}
        </section>
        <div className="detail">
          {shown ? <Detail key={shown.issueKey} p={shown} types={state.types} busy={busy} onDecide={decide} onCancel={cancel} /> : null}
        </div>
      </div>
    </div>
  );
}
