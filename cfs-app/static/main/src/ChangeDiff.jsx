/**
 * Shows what a request changes at a glance: the impact on top, then every option before and after, the new field as a
 * card, the spaces of a reuse or the fields of a bulk change. Used by "Requests for you" and the admin page's
 * approvals.
 *
 * @file        static/main/src/ChangeDiff.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useState } from 'react';
import { Icon, Loz } from './ui';
import { t, tn, fmtNum } from './i18n';

const RISK = { low: ['green', 'Low risk'], medium: ['yellow', 'Medium risk'], high: ['red', 'High risk'] };
const STATE = {
  added: ['add', 'Added'], renamed: ['ren', 'Renamed'], retired: ['ret', 'Retired'], restored: ['res', 'Restored'], same: ['', ''], inactive: ['off', 'Already retired'],
};

// The impact strip: who and what is touched, before any detail.
function Impact({ d }) {
  const chips = [];
  if (d.spaces?.length || d.hiddenSpaces) {
    const names = d.spaces.join(', ');
    chips.push(
      <span key="sp" className="ichip" title={names}>
        <Icon name="layers" />
        <span>{tn(d.spaces.length + (d.hiddenSpaces || 0), '{n} space', '{n} spaces')}</span>
        <small>{names}{d.hiddenSpaces ? ` ${t('+ {n} you can’t see', { n: d.hiddenSpaces })}` : ''}</small>
      </span>,
    );
  }
  if (d.workItems === 0) chips.push(<span key="wi" className="ichip calm"><Icon name="check" /><span>{t('No work item changes')}</span></span>);
  else if (d.workItems != null) chips.push(<span key="wi" className="ichip warn"><Icon name="warn" /><span>{tn(d.workItems, '{n} work item affected', '{n} work items affected')}</span><small>{d.bulk ? t('have the option') : t('carry a renamed or retired option')}</small></span>);
  else if (d.options) chips.push(<span key="wi" className="ichip"><Icon name="info" /><span>{t('Work items not counted')}</span><small>{t('requested before counts were kept')}</small></span>);
  if (d.valuesInField != null) chips.push(<span key="vf" className="ichip"><Icon name="list" /><span>{tn(d.valuesInField, '{n} work item uses this field', '{n} work items use this field')}</span></span>);
  const c = d.options?.counts;
  return (
    <div className="impact" aria-label={t('Impact')}>
      {chips}
      {c ? (
        <span className="tally-chips">
          {c.added ? <span className="dchip add">+{c.added} {t('added')}</span> : null}
          {c.renamed ? <span className="dchip ren">{c.renamed} {t('renamed')}</span> : null}
          {c.retired ? <span className="dchip ret">{c.retired} {t('retired')}</span> : null}
          {c.restored ? <span className="dchip res">{c.restored} {t('restored')}</span> : null}
          {d.options.reordered ? <span className="dchip">{t('new order')}</span> : null}
          {d.options.defaultChange ? <span className="dchip">{t('default changes')}</span> : null}
        </span>
      ) : null}
      {d.risk && RISK[d.risk] ? <Loz tone={RISK[d.risk][0]}>{t(RISK[d.risk][1])}</Loz> : null}
    </div>
  );
}

// Options: changed ones first in their place, the unchanged ones folded away.
function OptionsTable({ o, field }) {
  const [all, setAll] = useState(false);
  // A row counts as changed when its state changes, or it gains or loses the default (only if the default moves).
  const defaultMoves = !!o.defaultChange;
  const changed = (r) => (r.state !== 'same' && r.state !== 'inactive') || (defaultMoves && (r.isDefault || r.wasDefault));
  const rows = all ? o.rows : o.rows.filter(changed);
  const hidden = o.rows.length - o.rows.filter(changed).length;
  return (
    <div className="dtable" role="table" aria-label={t('Options of {name}, before and after', { name: field })}>
      <div className="drow head" role="row"><span role="columnheader">{t('Option')}</span><span role="columnheader">{t('Change')}</span><span role="columnheader" className="num">{t('Work items')}</span></div>
      {rows.map((r) => {
        const [cls, label] = STATE[r.state] || ['', ''];
        return (
          <div key={`${r.parent || ''}>${r.key}`} className={`drow ${cls} ${r.parent ? 'child' : ''}`} role="row">
            <span role="cell" className="dval">
              {r.parent ? <small className="muted">{r.parent} ›</small> : null}
              {r.state === 'renamed' ? <><del>{r.old}</del><Icon name="right" className="arrow" /><ins>{r.value}</ins></>
                : r.state === 'retired' ? <del>{r.value}</del>
                  : r.state === 'added' ? <ins>{r.value}</ins>
                    : <span className={r.state === 'inactive' ? 'muted' : ''}>{r.value}</span>}
              {r.isDefault ? <span className="dchip def" title={t('Default value after the change')}>{t('default')}</span> : null}
              {r.wasDefault && !r.isDefault ? <span className="dchip off" title={t('Default value before the change')}><del>{t('default')}</del></span> : null}
            </span>
            <span role="cell">{label ? <span className={`dchip ${cls}`}>{t(label)}</span> : defaultMoves && (r.isDefault || r.wasDefault) ? <span className="dchip">{t('default changes')}</span> : <span className="muted">–</span>}</span>
            <span role="cell" className="num">{r.uses != null ? fmtNum(r.uses) : <span className="muted">–</span>}</span>
          </div>
        );
      })}
      {!rows.length ? <div className="drow"><span className="muted">{t('Only the order of the options changes.')}</span></div> : null}
      {hidden ? <button type="button" className="btn subtle small dmore" onClick={() => setAll(!all)}>{all ? t('Show only changes') : tn(hidden, 'Show {n} unchanged option', 'Show {n} unchanged options')}</button> : null}
      {o.reordered ? <small className="muted">{t('The options get a new order (shown as it will be).')}</small> : null}
    </div>
  );
}

function NewFieldCard({ f }) {
  return (
    <div className="nfcard">
      <div className="nfhead"><span className="dchip add">{t('New field')}</span><strong>{f.name}</strong><span className="muted">{f.type}</span></div>
      {f.description ? <p className="muted">{f.description}</p> : null}
      <dl className="nfgrid">
        <dt>{t('Where')}</dt><dd>{f.global ? <><Icon name="globe" /> {t('Global: every space')}</> : f.spaces.join(', ') || '–'}</dd>
        <dt>{t('Screens')}</dt><dd>{f.addToScreens ? (f.screens != null ? tn(f.screens, '{n} screen of this space', '{n} screens of this space') : t('This space’s own screens')) : t('Not added to screens')}</dd>
        {f.issueTypes ? <><dt>{t('Work types')}</dt><dd>{tn(f.issueTypes, '{n} work type', '{n} work types')}</dd></> : null}
        {f.defaultValue ? <><dt>{t('Default')}</dt><dd>{f.defaultValue}</dd></> : null}
        {f.copyFrom ? <><dt>{t('Values')}</dt><dd>{t('Copied from {field}', { field: f.copyFrom })}</dd></> : null}
      </dl>
      {f.options.length ? (
        <div className="stack tight">
          <small className="muted">{tn(f.options.length, '{n} option', '{n} options')}</small>
          <div className="optchips">{f.options.slice(0, 40).map((o) => <span key={o} className={`dchip add ${o === f.defaultValue ? 'def' : ''}`}>{o}</span>)}{f.options.length > 40 ? <span className="dchip">{t('and {n} more', { n: f.options.length - 40 })}</span> : null}</div>
        </div>
      ) : null}
    </div>
  );
}

export default function ChangeDiff({ d }) {
  if (!d) return null;
  return (
    <div className="cdiff stack tight">
      <Impact d={d} />
      {d.undoOf ? <small className="muted"><Icon name="undo" className="inline-ic" /> {t('This puts back an earlier change.')}</small> : null}
      {d.options ? <OptionsTable o={d.options} field={d.field} /> : null}
      {d.options?.defaultChange ? <small>{t('Default value: {from} → {to}', { from: d.options.defaultChange.from || t('none'), to: d.options.defaultChange.to || t('none') })}</small> : null}
      {d.newField ? <NewFieldCard f={d.newField} /> : null}
      {d.reuse ? (
        <div className="reuse-diff">
          <span className="eyebrow">{t('Spaces using "{name}"', { name: d.reuse.field })}</span>
          <div className="row wrap">
            <span className="muted">{d.reuse.before.length ? d.reuse.before.join(', ') : t('No other space yet')}{d.reuse.hiddenBefore ? ` ${t('+ {n} you can’t see', { n: d.reuse.hiddenBefore })}` : ''}</span>
            <Icon name="right" className="arrow" />
            {d.reuse.after.map((k) => <span key={k} className={`dchip ${d.reuse.added.includes(k) ? 'add' : ''}`}>{d.reuse.added.includes(k) ? `+ ${k}` : k}</span>)}
          </div>
          <dl className="nfgrid">
            {d.reuse.via ? <><dt>{t('How')}</dt><dd>{t('through its {via}', { via: d.reuse.via })}</dd></> : null}
            <dt>{t('Screens')}</dt><dd>{d.reuse.addToScreens ? t('This space’s own screens') : t('Not added to screens')}</dd>
          </dl>
          {d.reuse.before.length ? <small className="muted">{t('Options stay shared: later option changes apply to every space above.')}</small> : null}
        </div>
      ) : null}
      {d.bulk && d.bulk.undo ? (
        <div className="reuse-diff">
          <strong>{d.bulk.what}</strong>
          <span><Icon name="undo" className="inline-ic" /> {d.bulk.back || t('Every field goes back to how it was before the bulk change.')}</span>
          <small className="muted">{t('Work items get their old value back unless someone changed them since. Options are never deleted.')}</small>
        </div>
      ) : null}
      {d.bulk && !d.bulk.undo ? (
        <div className="dtable">
          {d.bulk.what ? <strong>{d.bulk.what}</strong> : null}
          <div className="drow head"><span>{t('Field')}</span><span>{t('Change')}</span><span /></div>
          {d.bulk.fields.map((f, i) => <div key={i} className="drow"><span>{f.field}</span><span>{f.more ? '' : <>{f.from ? <del>{f.from}</del> : null}{f.from && f.to ? <Icon name="right" className="arrow" /> : null}{f.to}</>}</span><span /></div>)}
        </div>
      ) : null}
      {d.bundle ? <ul className="plain">{d.bundle.map((b) => <li key={b.name}><span className={`dchip ${b.kind === 'reuse' ? '' : 'add'}`}>{b.kind === 'reuse' ? t('Reuse') : t('New field')}</span> {b.name}</li>)}</ul> : null}
      {d.steps?.length ? (
        <ol className="steps">{d.steps.map((s, i) => (
          <li key={i} style={{ '--i': i }}><span className="n">{i + 1}</span><span><strong>{s.action}</strong>{s.item ? ` · ${s.item}` : ''}{s.from || s.to ? <small> {s.from ? <><del>{s.from}</del> → </> : null}{s.to}</small> : null}</span></li>
        ))}</ol>
      ) : null}
      {d.justification ? <p className="why"><span className="muted">{t('Why:')}</span> {d.justification}</p> : null}
    </div>
  );
}
