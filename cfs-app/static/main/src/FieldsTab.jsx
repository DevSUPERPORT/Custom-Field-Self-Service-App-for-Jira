/**
 * Field overview of the space: system, global and custom fields with type, context scope, issue types and options,
 * search and filters, and what the person may change.
 *
 * @file        static/main/src/FieldsTab.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useMemo, useState } from 'react';
import { Msg, Skeleton, Icon, Ctx, Note, Empty, time } from './ui';
import { t, fmtNum } from './i18n';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'editable', label: 'Editable' },
  { key: 'project', label: 'Only this space' },
  { key: 'shared', label: 'Multiple' },
  { key: 'global', label: 'Global' },
  { key: 'system', label: 'System' },
];
const editable = (f) => f.hasOptions && (f.access === 'direct' || f.access === 'approval');
const match = (key) => (f) => key === 'all' || (key === 'editable' ? editable(f) : f.scope === key);

// Clears the shared-element name from every row, then gives it to the clicked one: its title morphs into the
// field view's title (view transitions).
const nameRow = (row) => {
  document.querySelectorAll('[data-vt]').forEach((el) => { el.style.viewTransitionName = ''; });
  const el = row?.querySelector('[data-vt]');
  if (el) el.style.viewTransitionName = 'field-title';
};

export default function FieldsTab({ data, error, loading, role, onOpen, onReload, lastOpened }) {
  const admin = role === 'jira-admin';
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const all = useMemo(() => [...(data?.fields || []).filter((f) => !f.error), ...(data?.systemFields || [])], [data]);
  const rows = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter(match(filter)).filter((f) => words.every((w) => `${f.name} ${f.id} ${f.type}`.toLowerCase().includes(w)))
      .sort((a, b) => (a.system - b.system) || a.name.localeCompare(b.name));
  }, [all, filter, q]);
  if (error) return <Msg tone="error" title={t('Could not load the fields')}>{error}</Msg>;
  if (loading && !data) return <Skeleton lines={10} />;
  if (!data) return null;
  const counts = Object.fromEntries(FILTERS.map((x) => [x.key, all.filter(match(x.key)).length]));
  const open = (f, row) => { if (f.system) return; nameRow(row); onOpen(f); };

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="search" data-tour="search">
          <Icon name="search" />
          <label htmlFor="field-search" className="sr">{t('Search fields')}</label>
          <input id="field-search" type="search" placeholder={t('Search name or ID')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="pills" role="group" aria-label={t('Filter by context')}>
          {FILTERS.map((x) => (
            <button key={x.key} type="button" className="pill" aria-pressed={filter === x.key} onClick={() => setFilter(x.key)}>
              {t(x.label)} <span className="n">({counts[x.key]})</span>
            </button>
          ))}
        </div>
      </div>
      {data.incomplete && data.progress ? (
        <div className="stack tight">
          <small>{t('Reading the fields of this space: {done} of {total}…', { done: data.progress.done, total: data.progress.total })}</small>
          <div className="progressline"><i style={{ width: `${Math.round((data.progress.done / Math.max(1, data.progress.total)) * 100)}%` }} /></div>
        </div>
      ) : null}

      <div className="panel" data-tour="field-table">
        <div className="t-wrap">
          <table className="t" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th scope="col">{t('Field')}</th>
                <th scope="col">{t('Type')}</th>
                <th scope="col">{t('Context')}</th>
                <th scope="col">{t('Issue types')}</th>
                <th scope="col" className="r">{t('Options')}</th>
                <th scope="col"><span className="sr">{t('Action')}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f, i) => (
                <tr key={f.id} className={`rise ${f.system ? '' : 'click'}`} style={{ '--i': i }}
                  onClick={(e) => open(f, e.currentTarget)} tabIndex={f.system ? undefined : 0}
                  onKeyDown={(e) => { if (e.key === 'Enter') open(f, e.currentTarget); }} aria-label={f.system ? undefined : t('Open {name}', { name: f.name })}>
                  <td>
                    <div className="fname"><span data-vt="1" style={lastOpened === f.id ? { viewTransitionName: 'field-title' } : undefined}>{f.name}</span></div>
                    <div className="fid">{f.id}</div>
                  </td>
                  <td>{f.system ? t('System field') : f.type}</td>
                  <td><Ctx f={f} /></td>
                  <td>{(f.issueTypes || []).map((x) => (x === 'All' ? t('All') : x)).join(', ')}</td>
                  <td className="r num">{f.optionCount ? <>{fmtNum(f.optionCount.active)}{f.optionCount.disabled ? <small> +{f.optionCount.disabled} {t('off')}</small> : null}</> : <span className="muted">–</span>}</td>
                  <td className="r">
                    {f.system || (!f.hasOptions && !admin) ? <span className="lock"><Icon name="lock" />{t('Read only')}</span>
                      : f.hasOptions && f.access === 'direct' ? <span className="rowbtn">{t('Edit options')}</span>
                        : f.hasOptions && f.access === 'approval' ? <span className="rowbtn soft">{t('Request change')}</span>
                          : <span className="rowbtn soft">{t('Details')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length ? <Empty icon="search" title={t('No field matches')}>{t('Try another search or filter.')}</Empty> : null}
        </div>
      </div>

      <div className="spread">
        <Note>
          {admin
            ? t('As a Jira administrator you change any field directly; every change is logged and can be undone in the audit log. System fields are managed in Jira itself.')
            : t('You can open every field. Options of fields whose context belongs to this space only are maintained here; shared, global and system fields are managed by a Jira administrator.')}
          {data.fieldSchemes ? ` ${t('Only fields of this space\'s field scheme are listed.')}` : ''}
        </Note>
        <div className="row">
          {data.cachedAt ? <small>{t('as of {time}', { time: time(data.cachedAt) })}</small> : null}
          <button type="button" className="btn line small" onClick={onReload} disabled={loading}><Icon name="refresh" />{loading ? t('Refreshing…') : t('Refresh')}</button>
        </div>
      </div>
    </div>
  );
}
