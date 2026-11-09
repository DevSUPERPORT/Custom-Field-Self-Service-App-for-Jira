/**
 * "My requests": the person's own requests with their status; open ones can be withdrawn and rejected ones show the
 * approver's reason.
 *
 * @file        static/main/src/MyRequests.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useEffect, useState } from 'react';
import { call, Msg, Skeleton, IssueLink, when, day, useToast, useAutoRefresh, Status, Icon, Note, Empty, Modal, useCanWrite, PAUSED_HINT } from './ui';
import { t } from './i18n';

const KIND = { field: 'New field', options: 'Option changes', reuse: 'Reuse a field', bundle: 'Standard fields', bulk: 'Bulk change', stage1: 'Request' };
const what = (r) => {
  const rows = (r.rows || []).filter((x) => x.action !== 'Justification');
  if (r.kind === 'field') return rows[0]?.new || '';
  return rows.slice(0, 2).map((x) => `${x.action}${x.option && x.option !== r.fieldName ? `: ${x.option}` : ''}${x.new && x.action !== 'Add' ? ` → ${x.new}` : ''}`).join(' · ');
};

export default function MyRequests({ refreshKey, onCount, onNew }) {
  const canWrite = useCanWrite();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => call('myRequests').then((r) => { setData(r); setError(''); onCount(r.items.filter((x) => x.status === 'waiting').length); }).catch((e) => setError(e.message));
  useAutoRefresh(load, { paused: !!confirm });
  useEffect(() => { if (refreshKey) load(); }, [refreshKey]);
  if (error) return <Msg tone="error">{error}</Msg>;
  if (!data) return <Skeleton lines={6} />;

  const withdraw = async () => {
    setBusy(true);
    try {
      await call('withdraw', { issueKey: confirm.issueKey });
      toast(t('{key} withdrawn. Nothing was changed.', { key: confirm.issueKey }), 'ok');
      setConfirm(null);
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  };

  const open = data.items.filter((r) => r.status === 'waiting');
  const closed = data.items.filter((r) => r.status !== 'waiting');
  if (!data.items.length) {
    return <Empty icon="send" title={t('No requests yet')}><span>{t('New fields and option changes you request show up here with their status.')}</span> <button type="button" className="btn primary small" onClick={onNew}><Icon name="plus" />{t('Request field')}</button></Empty>;
  }

  return (
    <div className="stack">
      {open.map((r, i) => (
        <article key={r.issueKey} className="card focus req-card rise" style={{ '--i': i }}>
          <div className="grow">
            <div className="row"><h2 style={{ fontSize: 20 }}>{r.fieldName || r.summary}</h2><Status s={r.status} /></div>
            <span>{t(KIND[r.kind] || 'Request')}{what(r) ? ` · ${what(r)}` : ''}</span>
            <small>{t('Requested on {date}', { date: when(r.created) })} · {r.projectKey} · {t('approval request')} <IssueLink k={r.issueKey} /></small>
          </div>
          <button type="button" className="btn" disabled={!canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={() => setConfirm(r)}><Icon name="undo" />{t('Withdraw request')}</button>
        </article>
      ))}
      {open.length ? <Note>{t('Open requests can\'t be edited. To change one, withdraw it and send a new request.')}</Note> : null}

      {closed.length ? <h2 className="eyebrow" style={{ marginTop: 12 }}>{t('Closed')}</h2> : null}
      {closed.map((r, i) => (
        <article key={r.issueKey} className="card req-card rise" style={{ '--i': i + open.length }}>
          <div className="grow">
            <div className="row"><h3>{r.fieldName || r.summary}</h3><Status s={r.status} /></div>
            {r.status === 'rejected' ? <span>{r.reason ? t('Reason: {reason}', { reason: r.reason }) : t('Rejected without a reason in the app; see the request.')}</span> : null}
            {r.status === 'fail' ? <span>{r.error || t('The change could not be carried out.')}</span> : null}
            {r.status === 'done' ? <span>{t(KIND[r.kind] || 'Request')}{what(r) ? ` · ${what(r)}` : ''}</span> : null}
            {r.status === 'withdrawn' ? <span>{t(KIND[r.kind] || 'Request')}{what(r) ? ` · ${what(r)}` : ''}</span> : null}
            <small>
              {t('Requested on {date}', { date: day(r.created) })}
              {r.decided ? ` · ${r.status === 'withdrawn' ? t('withdrawn on {date}', { date: day(r.decided) }) : r.status === 'rejected' ? t('rejected on {date}', { date: day(r.decided) }) : t('decided on {date}', { date: day(r.decided) })}` : ''}
              {r.approver ? ` · ${t('by {name}', { name: r.approver })}` : ''} · <IssueLink k={r.issueKey} />
            </small>
          </div>
          {r.status === 'rejected' || r.status === 'withdrawn' ? <button type="button" className="linkish" onClick={() => onNew(['bulk', 'bulkundo'].includes(r.kind) ? 'bulk' : 'new')}>{t('New request')}</button> : null}
        </article>
      ))}

      {confirm ? (
        <Modal title={t('Withdraw "{name}"?', { name: confirm.fieldName || confirm.summary })} onClose={() => setConfirm(null)}
          footer={<><button type="button" className="btn ghost" onClick={() => setConfirm(null)}>{t('Keep it')}</button><button type="button" className="btn primary" disabled={busy} onClick={withdraw}>{busy ? t('Working…') : t('Withdraw request')}</button></>}>
          <p>{t('The request gets the status Withdrawn and nothing is changed. The approvers see it in {key}.', { key: confirm.issueKey })}</p>
        </Modal>
      ) : null}
    </div>
  );
}
