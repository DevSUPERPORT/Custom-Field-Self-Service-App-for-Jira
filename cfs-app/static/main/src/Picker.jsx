/**
 * Searchable single or multiple choice picker that opens in the page flow, with a context line and a reason per item
 * and keyboard support; only the first matches are drawn so it stays fast on large sites.
 *
 * @file        static/main/src/Picker.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Searchable picker: a select with a search bar on top, for single or multiple choice. The list opens in the page
// flow (not floating): the app's frame sizes itself to its content, so a floating list could end up out of view. Every item can carry a context
// line ("in 12 fields · default in 2") and a reason when it can't be picked. Keyboard: arrows, Enter, Escape. Stays
// fast on large sites: only the first matches are drawn, the rest are reached by typing.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { t } from './i18n';

const MAX_SHOWN = 150;
const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

const Mark = ({ text, q }) => {
  const i = q ? fold(text).indexOf(fold(q)) : -1;
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
};

export default function Picker({
  id, items, value, onChange, multiple = false, placeholder = t('Select…'), allLabel, searchPlaceholder = t('Search…'),
  emptyText = t('Nothing found'), loading = false, disabled = false, create, label,
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const wrap = useRef(null);
  const pop = useRef(null);
  const search = useRef(null);
  const list = useRef(null);
  const selected = multiple ? (value || []) : value;

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setQ('');
    setActive(0);
    setTimeout(() => { search.current?.focus(); pop.current?.scrollIntoView({ block: 'nearest' }); }, 0);
  }, [open]);

  const matches = useMemo(() => {
    const words = fold(q).split(/\s+/).filter(Boolean);
    return (items || []).filter((it) => words.every((w) => fold(it.label).includes(w) || fold(it.value).includes(w)));
  }, [items, q]);
  const exact = (items || []).some((it) => fold(it.label).trim() === fold(q).trim());
  const offerCreate = create && q.trim() && !exact;
  const shown = matches.slice(0, MAX_SHOWN);
  // A new option is offered last: Enter picks the first existing match, so a short search never creates a near-duplicate.
  const rows = offerCreate ? [...shown, { value: q.trim(), label: q.trim(), meta: matches.length ? t('new option · similar existing: {names}', { names: matches.slice(0, 2).map((m) => m.label).join(', ') }) : (create.meta || t('new')), created: true }] : shown;

  useEffect(() => {
    const el = list.current?.querySelector(`[data-i="${active}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const isOn = (v) => (multiple ? selected.includes(v) : selected === v);
  const pick = (it) => {
    if (!it || it.disabled) return;
    if (multiple) onChange(isOn(it.value) ? selected.filter((x) => x !== it.value) : [...selected, it.value]);
    else { onChange(it.value, it); setOpen(false); }
  };
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(rows[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    else if (e.key === 'Tab') setOpen(false);
  };

  const byValue = (v) => (items || []).find((it) => it.value === v);
  let shownValue;
  if (multiple) {
    shownValue = !selected.length ? (allLabel || placeholder) : selected.length <= 2 ? selected.map((v) => byValue(v)?.label || v).join(', ') : t('{n} selected', { n: selected.length });
  } else {
    shownValue = selected ? (byValue(selected)?.label || selected) : placeholder;
  }
  const meta = !multiple && selected ? byValue(selected)?.meta : null;
  const empty = multiple ? !selected.length && !allLabel : !selected;

  return (
    <div className={`picker ${open ? 'open' : ''}`} ref={wrap}>
      <button
        id={id} type="button" className={`picker-trigger ${empty ? 'is-placeholder' : ''}`} disabled={disabled || loading}
        aria-haspopup="listbox" aria-expanded={open} aria-label={label}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
      >
        <span className="picker-value">{loading ? t('Loading this space’s data…') : shownValue}{meta ? <small> · {meta}</small> : null}</span>
        <span className="picker-chevron" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="picker-pop" role="dialog" aria-label={label} ref={pop}>
          <input
            ref={search} type="search" className="picker-search" value={q} placeholder={searchPlaceholder}
            onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={key}
            role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={rows.length ? `${id}-opt-${active}` : undefined}
          />
          <ul className="picker-list" id={`${id}-list`} role="listbox" aria-multiselectable={multiple || undefined} ref={list}>
            {rows.map((it, i) => (
              <li
                key={`${it.created ? 'new:' : ''}${it.value}`} id={`${id}-opt-${i}`} data-i={i} role="option"
                aria-selected={isOn(it.value)} aria-disabled={it.disabled || undefined}
                className={`${i === active ? 'active' : ''} ${isOn(it.value) ? 'on' : ''} ${it.disabled ? 'off' : ''}`}
                title={it.disabled ? it.disabledNote : undefined}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(it)}
              >
                {multiple ? <input type="checkbox" tabIndex={-1} readOnly checked={isOn(it.value)} disabled={it.disabled} /> : <span className="picker-tick" aria-hidden="true">{isOn(it.value) ? '✓' : ''}</span>}
                <span className="grow">
                  <span className="picker-label">{it.created ? <>{create.label || t('Use')} “{it.label}”</> : <Mark text={it.label} q={q.trim()} />}</span>
                  {it.meta || it.disabled ? <small className="picker-meta">{it.disabled ? it.disabledNote : it.meta}</small> : null}
                </span>
              </li>
            ))}
            {!rows.length ? <li className="picker-empty" aria-disabled="true">{emptyText}</li> : null}
          </ul>
          {matches.length > MAX_SHOWN ? <div className="picker-more small">{t('{n} more: keep typing to narrow down', { n: matches.length - MAX_SHOWN })}</div> : null}
          {multiple ? (
            <div className="picker-foot">
              <button type="button" className="btn small subtle" onClick={() => onChange([...new Set([...selected, ...matches.filter((x) => !x.disabled).map((x) => x.value)])])}>{q ? t('Select all shown') : t('Select all')}</button>
              <button type="button" className="btn small subtle" onClick={() => onChange([])} disabled={!selected.length}>{allLabel ? t('Back to all') : t('Clear')}</button>
              <span className="grow" />
              <button type="button" className="btn small primary" onClick={() => setOpen(false)}>{t('Done')}</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
