/**
 * Audit log tab of the admin control centre: every change and every waiting request of all spaces, with filters for
 * period, field, status and person, 25 per page.
 *
 * @file        static/main/src/admin/AuditLog.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useMemo, useState } from 'react';
import { call, Msg, Skeleton, Empty, Icon, IssueLink, Loz, Status, statusText, when, useAutoRefresh } from '../ui';
import { t } from '../i18n';
import { logStatus, STATUSES, isRequestEntry, keyOfEntry } from '../../../../src/shared/status.js';

const PAGE = 25;
const PERIODS = [
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
  { key: '365', label: 'Last 12 months' },
  { key: 'all', label: 'All time' },
];
const keyIn = (via) => (String(via || '').match(/\b([A-Z][A-Z0-9_]+-\d+)\b/) || [])[1] || '';
const fold = (s) => String(s || '').toLowerCase();

// The site-wide audit log (UC-07): Jira administrators see every space. Entries come from the change log; requests
// still waiting for approval (not in the log yet) are added, so nothing open is missing.
export default function AuditLog() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState('30');
  const [field, setField] = useState('');
  const [status, setStatus] = useState('all');
  const [person, setPerson] = useState('');
  const [page, setPage] = useState(0);
  const load = () => call('auditAll').then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message));
  useAutoRefresh(load);

  const rows = useMemo(() => {
    if (!data) return [];
    const name = (id) => (id ? data.names[id] || id : '');
    const reqByKey = Object.fromEntries(data.requests.map((r) => [r.issueKey, r]));
    const inLog = new Set();
    // A request's own "requested" entry only while it waits; afterwards its decision entry tells the story.
    const fromLog = data.log.filter((l) => !isRequestEntry(l) || reqByKey[keyOfEntry(l)]?.status === 'waiting').map((l, i) => {
      const k = keyIn(l.via);
      if (k) inLog.add(k);
      const st = logStatus(l);
      return {
        id: `l${i}`, ts: l.ts, requester: name(l.actor), approver: name(l.approver), space: l.projectKey || '', field: l.fieldName || '',
        action: l.action, option: l.option, old: l.old, new: l.new, status: st, issueKey: k,
        reason: st === 'rejected' ? (l.reason || reqByKey[k]?.reason || '') : (l.reason || ''),
      };
    });
    const waiting = data.requests.filter((r) => r.status === 'waiting' && !inLog.has(r.issueKey)).map((r) => ({
      id: `r${r.issueKey}`, ts: r.created, requester: name(r.requester), approver: name(r.approver), space: r.projectKey || '', field: r.fieldName || '',
      action: r.rows[0]?.action || t('Requested'), option: r.rows[0]?.option || r.summary, old: r.rows[0]?.old || '', new: r.rows[0]?.new || '',
      more: Math.max(0, r.rows.length - 1), status: 'waiting', issueKey: r.issueKey, reason: '',
    }));
    return [...fromLog, ...waiting].sort((a, b) => b.ts - a.ts);
  }, [data]);

  const fieldItems = useMemo(() => [
    { value: '', label: t('All fields') },
    ...[...new Set(rows.map((r) => r.field).filter(Boolean))].sort((a, b) => a.localeCompare(b)).map((f) => ({ value: f, label: f })),
  ], [rows]);

  const filtered = useMemo(() => {
    const since = period === 'all' ? 0 : Date.now() - Number(period) * 24 * 3600 * 1000;
    const who = fold(person.trim());
    return rows.filter((r) => r.ts >= since
      && (!field || r.field === field)
      && (status === 'all' || r.status === status)
      && (!who || fold(r.requester).includes(who) || fold(r.approver).includes(who)));
  }, [rows, period, field, status, person]);

  if (error && !data) return <Msg tone="error">{error}</Msg>;
  if (!data) return <Skeleton lines={10} />;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const p = Math.min(page, pages - 1);
  const slice = filtered.slice(p * PAGE, p * PAGE + PAGE);
  const set = (fn) => (v) => { fn(v); setPage(0); };

  return (
    <div className="stack" data-tour="audit">
      {error ? <Msg tone="error">{error}</Msg> : null}
      <div className="filters" data-tour="audit-filters">
        <div>
          <label htmlFor="f-time">{t('Period')}</label>
          <select id="f-time" value={period} onChange={(e) => set(setPeriod)(e.target.value)}>
            {PERIODS.map((x) => <option key={x.key} value={x.key}>{t(x.label)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="f-field">{t('Field')}</label>
          <select id="f-field" value={field} onChange={(e) => set(setField)(e.target.value)}>
            {fieldItems.map((x) => <option key={x.value || 'all'} value={x.value}>{x.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="f-status">{t('Status')}</label>
          <select id="f-status" value={status} onChange={(e) => set(setStatus)(e.target.value)}>
            <option value="all">{t('All statuses')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{statusText(s)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="f-person">{t('Person')}</label>
          <input id="f-person" type="search" value={person} placeholder={t('Search a name')} onChange={(e) => set(setPerson)(e.target.value)} />
        </div>
      </div>

      <div className="panel">
        {slice.length ? (
          <div className="t-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th scope="col">{t('Date')}</th><th scope="col">{t('Requested by')}</th><th scope="col">{t('Approved by')}</th>
                  <th scope="col">{t('Space')}</th><th scope="col">{t('Field')}</th><th scope="col">{t('Change')}</th><th scope="col">{t('Status')}</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((r, i) => (
                  <tr key={r.id} className="rise" style={{ '--i': i }}>
                    <td className="top" style={{ whiteSpace: 'nowrap' }}>{when(r.ts)}</td>
                    <td className="top">{r.requester || '–'}</td>
                    <td className="top">{r.approver || '–'}</td>
                    <td className="top">{r.space || '–'}</td>
                    <td className="top fname">{r.field || '–'}</td>
                    <td className="top">
                      <Loz>{r.action}</Loz> {r.option}
                      {r.old || r.new ? <div><small className="clamp" title={`${r.old || ""} → ${r.new || ""}`}>{r.old ? `${r.old} → ${r.new || "–"}` : r.new}</small></div> : null}
                      {r.more ? <div><small>{t('and {n} more', { n: r.more })}</small></div> : null}
                      {r.reason ? <div><small>{t('Reason: {text}', { text: r.reason })}</small></div> : null}
                      {r.issueKey ? <div><small><IssueLink k={r.issueKey} /></small></div> : null}
                    </td>
                    <td className="top"><Status s={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="history" title={rows.length ? t('No entries match these filters') : t('Nothing logged yet')}>
            {rows.length ? t('Widen the period or clear a filter.') : t('Every change and every request appears here.')}
          </Empty>
        )}
        <div className="pager">
          <span>{filtered.length ? t('{from}–{to} of {n} entries', { from: p * PAGE + 1, to: p * PAGE + slice.length, n: filtered.length }) : t('0 entries')}</span>
          <div className="row">
            <button type="button" className="btn small icon line" aria-label={t('Previous page')} disabled={p === 0} onClick={() => setPage(p - 1)}><Icon name="left" /></button>
            <button type="button" className="btn small icon line" aria-label={t('Next page')} disabled={p >= pages - 1} onClick={() => setPage(p + 1)}><Icon name="right" /></button>
          </div>
        </div>
      </div>

      <div className="audit-foot">
        <span><Icon name="lock" />{t('Entries can\'t be changed')}</span>
        <span>{t('You see every space')}</span>
        <span>{data.retentionMonths ? t('Deleted after {n} months · set under Configuration', { n: data.retentionMonths }) : t('Kept forever')}</span>
      </div>
    </div>
  );
}
