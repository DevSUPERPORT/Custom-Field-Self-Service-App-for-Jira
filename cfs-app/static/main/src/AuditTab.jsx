/**
 * Audit log tab of the space: who changed what and when, approver, old and new value and status, with filters, paging
 * and undo where the person may use it.
 *
 * @file        static/main/src/AuditTab.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useEffect, useMemo, useState } from 'react';
import { logStatus, isRequestEntry, keyOfEntry } from '../../../src/shared/status.js';
import { call, Msg, Skeleton, IssueLink, when, useToast, useAutoRefresh, Status, Icon, CountUp, Empty, statusText, Modal, Spinner, performUndo, useCanWrite, PAUSED_HINT } from './ui';
import { undoPayload } from '../../../src/shared/undo.js';
import { t, tn } from './i18n';

const PAGE = 25;
const PERIODS = [
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '365', label: 'Last 12 months', days: 365 },
  { key: 'all', label: 'All time', days: 0 },
];

// Why an entry offers no Undo button, in words.
const UNDO_NOTE = {
  undone: 'Undone',
  pending: 'Undo waiting for approval',
  superseded: 'Undo the later change on this field first',
};

// Rows that undid an earlier change are marked as such (their own action reads like a normal change).
const isUndoRow = (l) => /^undo/i.test(String(l.via || '')) && l.action !== 'Undo';

export default function AuditTab({ refreshKey, role }) {
  const canWrite = useCanWrite();
  const admin = role === 'jira-admin';
  const [confirm, setConfirm] = useState(null);
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [undoing, setUndoing] = useState(null);
  const [period, setPeriod] = useState('30');
  const [fieldF, setFieldF] = useState('');
  const [statusF, setStatusF] = useState('');
  const [person, setPerson] = useState('');
  const [page, setPage] = useState(0);
  const load = () => call('audit').then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message));
  useAutoRefresh(load, { paused: !!undoing });
  useEffect(() => { if (refreshKey) load(); }, [refreshKey]);
  useEffect(() => setPage(0), [period, fieldF, statusF, person]);

  // One list: the log entries plus requests still waiting for approval (they are not in the log yet).
  const entries = useMemo(() => {
    if (!data) return [];
    const logged = new Set(data.log.map((l) => String(l.via || '').split(': ')[1]).filter(Boolean));
    const waiting = data.requests.filter((r) => r.status === 'waiting' && !logged.has(r.issueKey)).map((r) => ({
      ts: r.created, actor: r.requester, approver: null, fieldName: r.payload?.fieldName || r.payload?.draft?.name || r.summary, fieldId: r.payload?.fieldId || '',
      action: (r.rows || [])[0]?.action || t('Request'), option: (r.rows || [])[0]?.option || '', old: (r.rows || [])[0]?.old || '', new: (r.rows || [])[0]?.new || '', via: `requested: ${r.issueKey}`, issueKey: r.issueKey, status: 'waiting',
    }));
    const open = new Set(data.requests.filter((r) => r.status === 'waiting').map((r) => r.issueKey));
    const shown = data.log.filter((l) => !isRequestEntry(l) || open.has(keyOfEntry(l)));
    return [...waiting, ...shown.map((l) => ({ ...l, status: logStatus(l) }))].sort((a, b) => b.ts - a.ts);
  }, [data]);
  if (error) return <Msg tone="error">{error}</Msg>;
  if (!data) return <Skeleton lines={8} />;

  const name = (id) => (id ? data.names[id] || id : '');
  const days = PERIODS.find((p) => p.key === period)?.days || 0;
  const words = person.trim().toLowerCase();
  const rows = entries.filter((l) => (!days || l.ts >= Date.now() - days * 86400000)
    && (!fieldF || l.fieldName === fieldF) && (!statusF || l.status === statusF)
    && (!words || `${name(l.actor)} ${name(l.approver)}`.toLowerCase().includes(words)));
  const fieldNames = [...new Set(entries.map((l) => l.fieldName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);

  // The undo of a change sits on its newest row only (a bulk change or an option change has one row per step).
  const first = new Set();
  const seen = new Set();
  entries.forEach((l) => { const k = l.undo?.key; if (k && !seen.has(k)) { seen.add(k); first.add(l); } });
  const stepsOf = (key) => entries.filter((l) => l.undo?.key === key);
  const undo = async (key) => {
    setConfirm(null);
    setUndoing(key);
    try {
      const r = await performUndo(undoPayload(key));
      toast(r.text, r.tone);
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
    setUndoing(null);
  };
  const undoCell = (l) => {
    if (!first.has(l) || !l.undo) return null;
    const u = l.undo;
    if (u.state === 'available' && u.can) {
      return (
        <div className="undo-cell">
          <button type="button" className="btn line small" disabled={!!undoing || !canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={() => setConfirm({ key: u.key, approval: u.approval, steps: stepsOf(u.key), bulk: u.key.startsWith('bulk:') })}>
            {undoing === u.key ? <Spinner /> : <Icon name="undo" />}{undoing === u.key ? t('Undoing…') : u.approval ? t('Request undo') : t('Undo')}
          </button>
          {u.approval ? <span className="undo-note">{t('A Jira administrator approves it')}</span> : null}
        </div>
      );
    }
    if (UNDO_NOTE[u.state]) return <span className="undo-note">{t(UNDO_NOTE[u.state])}</span>;
    return null;
  };
  const st = data.stats;
  const keyOf = (l) => l.issueKey || String(l.via || '').match(/[A-Z][A-Z0-9_]+-\d+/)?.[0];

  return (
    <div className="stack">
      <div className="stats">
        <div className="stat-card hero rise" style={{ '--i': 0 }}><div className="big"><CountUp value={st.minutes / 60} decimals={1} /> h</div><small>{t('time saved for the Jira administrators')}</small></div>
        <div className="stat-card rise" style={{ '--i': 1 }}><div className="big"><CountUp value={st.selfService} /></div><small>{t('changes made directly')}</small></div>
        <div className="stat-card rise" style={{ '--i': 2 }}><div className="big"><CountUp value={st.approved} /></div><small>{t('approved in one click')}</small></div>
        <div className="stat-card rise" style={{ '--i': 3 }}><div className="big"><CountUp value={data.requests.filter((r) => r.status === 'waiting').length} /></div><small>{t('waiting for approval')}</small></div>
      </div>

      <div className="filters">
        <div><label htmlFor="f-time">{t('Period')}</label><select id="f-time" value={period} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map((p) => <option key={p.key} value={p.key}>{t(p.label)}</option>)}</select></div>
        <div><label htmlFor="f-field">{t('Field')}</label><select id="f-field" value={fieldF} onChange={(e) => setFieldF(e.target.value)}><option value="">{t('All fields')}</option>{fieldNames.map((f) => <option key={f} value={f}>{f}</option>)}</select></div>
        <div><label htmlFor="f-status">{t('Status')}</label><select id="f-status" value={statusF} onChange={(e) => setStatusF(e.target.value)}><option value="">{t('All statuses')}</option>{['done', 'fail', 'waiting', 'rejected', 'withdrawn'].map((s) => <option key={s} value={s}>{statusText(s)}</option>)}</select></div>
        <div><label htmlFor="f-person">{t('Person')}</label><input id="f-person" type="search" placeholder={t('Search a name')} value={person} onChange={(e) => setPerson(e.target.value)} /></div>
      </div>

      <div className="panel">
        <div className="t-wrap">
          <table className="t" style={{ minWidth: 980 }}>
            <thead>
              <tr>
                <th scope="col"><span className="sr">{t('Undo')}</span></th>
                <th scope="col">{t('Date')}</th>
                <th scope="col">{t('Requested by')}</th>
                <th scope="col">{t('Approved by')}</th>
                <th scope="col">{t('Field')}</th>
                <th scope="col">{t('Change')}</th>
                <th scope="col">{t('Status')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l, i) => (
                <tr key={`${l.ts}-${i}`} className="rise" style={{ '--i': i }}>
                  <td className="top">{undoCell(l)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{when(l.ts)}</td>
                  <td>{name(l.actor) || '–'}</td>
                  <td>{name(l.approver) || '–'}</td>
                  <td><div className="fname">{l.fieldName || '–'}</div>{l.fieldId ? <div className="fid">{l.fieldId}</div> : null}</td>
                  <td className="top">
                    <div>{isUndoRow(l) ? <span className="dchip undo-tag">{t('Undo')}</span> : null}<strong>{l.action}</strong>{l.option ? `: ${l.option}` : ''}</div>
                    {l.action === 'Undo' ? <small>{t('puts back the earlier change')}</small> : l.old || l.new ? <small className="clamp" title={`${l.old || ''} → ${l.new || ''}`}>{l.old ? `"${l.old}" → ` : ''}{l.new ? `"${l.new}"` : ''}</small> : null}
                    {l.reason ? <div><small>{t('Reason: {reason}', { reason: l.reason })}</small></div> : null}
                    {keyOf(l) ? <div><small><IssueLink k={keyOf(l)} /></small></div> : null}
                  </td>
                  <td><Status s={l.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!shown.length ? <Empty icon="history" title={t('No entries')}>{t('Nothing matches these filters yet.')}</Empty> : null}
        </div>
        <div className="pager">
          <span className="num">{rows.length ? t('{from}–{to} of {n} entries', { from: page * PAGE + 1, to: Math.min(rows.length, page * PAGE + PAGE), n: rows.length }) : ''}</span>
          <div className="row">
            <button type="button" className="btn line small icon" aria-label={t('Previous page')} disabled={page === 0} onClick={() => setPage(page - 1)}><Icon name="left" /></button>
            <button type="button" className="btn line small icon" aria-label={t('Next page')} disabled={page >= pages - 1} onClick={() => setPage(page + 1)}><Icon name="right" /></button>
          </div>
        </div>
      </div>

      {confirm ? (
        <Modal title={confirm.bulk ? t('Undo the whole bulk change?') : t('Undo this change?')} onClose={() => setConfirm(null)} footer={<>
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>{t('Cancel')}</button>
          <button type="button" className="btn primary" autoFocus onClick={() => undo(confirm.key)}><Icon name="undo" />{confirm.approval ? t('Send undo for approval') : t('Undo')}</button>
        </>}>
          <p>{t('This puts back what was there before:')}</p>
          <ul className="plain undo-steps">{confirm.steps.slice(0, 12).map((s, i) => (
            <li key={i}><strong>{s.fieldName}</strong> · {s.action}{s.option ? `: ${s.option}` : ''}{s.old || s.new ? <small> {s.new ? `"${s.new}"` : '–'} → {s.old ? `"${s.old}"` : '–'}</small> : null}</li>
          ))}{confirm.steps.length > 12 ? <li className="muted">{t('and {n} more', { n: confirm.steps.length - 12 })}</li> : null}</ul>
          <p className="muted">{confirm.bulk
            ? t('Every field of the bulk change goes back as it was; work items get their old value unless someone changed them since. Options are never deleted: added ones are retired.')
            : t('Options are never deleted: options the change added are retired. The undo gets its own entry in the audit log.')}</p>
          {confirm.approval ? <p className="muted">{t('Your undo goes to a Jira administrator for approval, like any change by a project admin.')}</p> : null}
        </Modal>
      ) : null}

      <div className="audit-foot">
        <span><Icon name="lock" />{t('Entries can\'t be changed')}</span>
        <span>{admin ? t('You see this space; the control centre shows every space') : t('You see the entries of this space · Jira administrators see every space')}</span>
        <span>{data.retentionMonths ? t('Kept for {n} months · set by a Jira administrator', { n: data.retentionMonths }) : t('Kept forever · set by a Jira administrator')}</span>
      </div>
    </div>
  );
}
