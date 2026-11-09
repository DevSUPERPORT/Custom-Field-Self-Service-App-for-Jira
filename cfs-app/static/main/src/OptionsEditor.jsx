/**
 * Options editor: every option with name, status and the one default, drag and drop or A–Z / Z–A sorting, adding many
 * at once with duplicates skipped, the impact preview, and saving directly or as a request.
 *
 * @file        static/main/src/OptionsEditor.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Picker from './Picker';
import { computePlan, describePlan, validateTree, planIsEmpty, sortAlphabetically } from '../../../src/shared/options.js';
import { splitLines, norm } from '../../../src/shared/status.js';
import { call, Msg, Skeleton, Modal, IssueLink, useToast, askAssistant, Icon, Note, Segmented, Tick, useFlip, performUndo, useCanWrite, PAUSED_HINT } from './ui';
import { t, tn, fmtNum } from './i18n';

const clone = (tree) => tree.map((p) => ({ ...p, children: (p.children || []).map((c) => ({ ...c })) }));
let seq = 1;
const newKey = () => `new:${Date.now()}-${seq++}`;
const SHOWN = 12;

// One-time sort, ascending or descending; disabled options can stay at the end.
const sortDir = (items, dir, disabledLast) => {
  const asc = sortAlphabetically(items, disabledLast);
  if (dir === 'asc') return asc;
  const on = asc.filter((i) => !disabledLast || !i.disabled).reverse();
  return disabledLast ? [...on, ...asc.filter((i) => i.disabled).reverse()] : on;
};

const impactLines = (plan, usage) => {
  if (!usage) return [];
  const n = (id) => usage.perOption?.[id] || 0;
  return [
    ...plan.edits.filter((e) => n(e.id)).map((e) => t('Renaming "{old}" changes the value in {n} work item(s).', { old: e.old, n: n(e.id) })),
    ...plan.disables.filter((d) => n(d.id)).map((d) => t('"{value}" stays in {n} work item(s) but can no longer be chosen.', { value: d.value, n: n(d.id) })),
  ];
};

function OptionRows({ items, original, usage, onChange, onDefault, parentKey, cascading, expanded, setExpanded, renderChildren, limit }) {
  // Pointer-based drag (mouse, pen, touch): grab the handle, move, release. drag = { from, to } with "to" as insertion index.
  const [drag, setDrag] = useState(null);
  const listRef = useRef(null);
  useFlip(listRef, [items.map((o) => o.key).join('|')]);
  const insertionAt = (clientY) => {
    const rows = [...listRef.current.children].filter((el) => el.dataset.flip);
    for (let k = 0; k < rows.length; k += 1) {
      const r = rows[k].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return k;
    }
    return rows.length;
  };
  const orig = useMemo(() => {
    const m = new Map();
    original.forEach((p) => { m.set(p.key, p); (p.children || []).forEach((c) => m.set(c.key, c)); });
    return m;
  }, [original]);
  const move = (from, to) => {
    if (from === to || to < 0 || to >= items.length) return;
    const copy = [...items];
    const [x] = copy.splice(from, 1);
    copy.splice(to, 0, x);
    onChange(copy);
  };
  const patch = (key, changes) => onChange(items.map((o) => (o.key === key ? { ...o, ...changes } : o)));
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <ul ref={listRef} className="opt-list" aria-label={parentKey ? t('Child options') : t('Options')}>
      {shown.map((o, i) => {
        const before = orig.get(o.key);
        const isNew = !before;
        const renamed = before && before.value !== o.value;
        const changed = before && (renamed || !!before.disabled !== !!o.disabled || !!before.isDefault !== !!o.isDefault);
        const dropBefore = drag && drag.to === i && drag.to !== drag.from && drag.to !== drag.from + 1;
        const dropAfter = drag && i === shown.length - 1 && drag.to === shown.length && drag.from !== shown.length - 1;
        const cls = ['opt', o.disabled ? 'disabled' : '', isNew ? 'new' : '', changed ? 'changed' : '', drag && drag.from === i ? 'dragging' : '',
          dropBefore ? 'drop-before' : '', dropAfter ? 'drop-after' : ''].join(' ');
        return (
          <li key={o.key} className={cls} data-flip={o.key}>
            <button type="button" className="handle" aria-label={t('Move {name} (or Alt+↑/↓ in the name)', { name: o.value })}
              onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); setDrag({ from: i, to: i }); }}
              onPointerMove={(e) => { if (drag) { const to = insertionAt(e.clientY); if (to !== drag.to) setDrag({ ...drag, to }); } }}
              onPointerUp={() => { if (!drag) return; let to = drag.to; if (drag.from < to) to -= 1; move(drag.from, to); setDrag(null); }}
              onPointerCancel={() => setDrag(null)}><Icon name="grip" /></button>
            <div className="opt-name">
              <label className="sr" htmlFor={`o-${o.key}`}>{t('Name')}</label>
              <input id={`o-${o.key}`} type="text" value={o.value}
                onChange={(e) => patch(o.key, { value: e.target.value })}
                onKeyDown={(e) => { if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); move(i, i - 1); } if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); move(i, i + 1); } }} />
              <div className="tags">
                {o.isDefault ? <span className="loz dark">{t('Default')}</span> : null}
                {isNew ? <span className="loz orange">{t('new')}</span> : null}
                {o.disabled ? <small>{t('can\'t be chosen in new work items')}</small> : null}
                {cascading && !parentKey ? (
                  <button type="button" className="linkish" style={{ minHeight: 0 }} onClick={() => setExpanded((x) => ({ ...x, [o.key]: !x[o.key] }))} aria-expanded={!!expanded[o.key]}>
                    <Icon name={expanded[o.key] ? 'down' : 'right'} className="tick" />{tn((o.children || []).length, '{n} child option', '{n} child options')}
                  </button>
                ) : null}
                {isNew ? <button type="button" className="linkish" style={{ minHeight: 0 }} onClick={() => onChange(items.filter((x) => x.key !== o.key))}>{t('Remove')}</button> : null}
              </div>
            </div>
            <label className="check"><input type="checkbox" checked={!o.disabled} onChange={() => patch(o.key, { disabled: !o.disabled, ...(o.disabled ? {} : { isDefault: false }) })} />{o.disabled ? t('Disabled') : t('Enabled')}</label>
            <label className="defradio defcell">
              <span className="sr">{o.disabled ? t('Set as default (not possible, disabled)') : t('Set as default')}</span>
              <input type="radio" name={`default-${parentKey || 'top'}`} checked={!!o.isDefault} disabled={o.disabled} onChange={() => onDefault(o.key)} />
            </label>
            <span className="uses" title={t('Work items with this value')}>{isNew ? '' : usage ? fmtNum(usage.perOption?.[o.id] ?? 0) : '…'}</span>
            {renamed ? (
              <div className="opt-warn"><Icon name="warn" /><span>{t('Renamed from "{old}". Existing work items take the new name. JQL filters, automations and dashboards that use the old name may stop working.', { old: before.value })}</span></div>
            ) : null}
            {cascading && !parentKey && expanded[o.key] ? <div className="children">{renderChildren(o)}</div> : null}
          </li>
        );
      })}
      {!items.length ? <li className="opt"><span /><span className="muted">{t('No options yet.')}</span></li> : null}
    </ul>
  );
}

export default function OptionsEditor({ field, fields, rules, projectKey }) {
  const canWrite = useCanWrite();
  const toast = useToast();
  const [state, setState] = useState({ loading: true });
  const [tree, setTree] = useState([]);
  const [usage, setUsage] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [mode, setMode] = useState('one');
  const [newValue, setNewValue] = useState('');
  const [bulk, setBulk] = useState('');
  const [lastAdded, setLastAdded] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [disabledLast, setDisabledLast] = useState(true);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyFrom, setCopyFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [radar, setRadar] = useState(null);
  const addRef = useRef(null);

  const load = async () => {
    setState((s) => ({ ...s, loading: !s.original }));
    try {
      const r = await call('options', { fieldId: field.id });
      setState({ loading: false, original: r.tree, open: r.openRequests || [], access: r.field?.access || field.access });
      setTree(clone(r.tree));
      setUsage(null);
      call('usage', { fieldId: field.id }).then(setUsage).catch(() => setUsage({ perOption: {}, total: null }));
    } catch (e) {
      setState({ loading: false, error: e.message });
    }
  };
  useEffect(() => { load(); }, [field.id]);

  const original = state.original || [];
  const plan = useMemo(() => computePlan(original, tree), [original, tree]);
  const rows = useMemo(() => describePlan(plan), [plan]);
  const errors = useMemo(() => validateTree(tree, rules), [tree, rules]);
  const impact = useMemo(() => impactLines(plan, usage), [plan, usage]);
  const direct = state.access === 'direct';
  const readonly = state.access === 'readonly';
  const blocked = (state.open || []).length > 0;
  const touched = useMemo(() => [...plan.edits.map((e) => e.old), ...plan.disables.map((d) => d.value)], [plan]);
  const affectedItems = useMemo(() => (usage ? [...plan.edits, ...plan.disables].reduce((n, x) => n + (usage.perOption?.[x.id] || 0), 0) : 0), [plan, usage]);

  // Impact radar: saved filters and automation rules that use this field, refreshed when renames/disables change.
  useEffect(() => {
    if (!state.original) return undefined;
    const timer = setTimeout(() => { call('radar', { fieldId: field.id, values: touched }).then(setRadar).catch(() => setRadar(null)); }, 600);
    return () => clearTimeout(timer);
  }, [touched.join('|'), state.original]);

  const setTop = (items) => { setResult(null); setTree(items); };
  // Exactly one default: picking one replaces the other; "No default" clears it.
  const setDefault = (key) => {
    setResult(null);
    setTree((tr) => tr.map((p) => ({ ...p, isDefault: p.key === key, children: (p.children || []).map((c) => ({ ...c, isDefault: c.key === key })) })));
  };
  const setChildren = (parentKey) => (items) => { setResult(null); setTree((tr) => tr.map((p) => (p.key === parentKey ? { ...p, children: items } : p))); };

  const existing = tree.map((o) => o.value);
  const addOne = () => {
    const v = newValue.trim();
    if (!v) return;
    if (existing.some((x) => norm(x) === norm(v))) { toast(t('"{name}" already exists.', { name: v })); return; }
    setResult(null);
    setTree((tr) => [...tr, { key: newKey(), value: v, disabled: false, children: [] }]);
    setNewValue('');
    setLastAdded(v);
    setShowAll(true);
    addRef.current?.focus();
  };
  // Several at once: one per line (Excel columns paste as lines); cascading: "Parent > Child".
  const parsed = useMemo(() => {
    if (!field.cascading) return splitLines(bulk, existing);
    const fresh = [];
    const dupes = [];
    String(bulk).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((l) => {
      const [parent, child] = (l.includes('\t') ? l.split('\t') : l.split('>')).map((x) => (x || '').trim());
      const p = tree.find((x) => norm(x.value) === norm(parent));
      const dup = child ? p && (p.children || []).some((c) => norm(c.value) === norm(child)) : !!p;
      (dup || fresh.some((f) => norm(f) === norm(l)) ? dupes : fresh).push(l);
    });
    return { fresh, dupes };
  }, [bulk, tree, field.cascading]);
  const lines = parsed.fresh.length + parsed.dupes.length;
  const addBulk = () => {
    setResult(null);
    setTree((tr) => {
      const next = clone(tr);
      parsed.fresh.forEach((l) => {
        if (!field.cascading) { next.push({ key: newKey(), value: l, disabled: false, children: [] }); return; }
        const [parent, child] = (l.includes('\t') ? l.split('\t') : l.split('>')).map((x) => (x || '').trim());
        let p = next.find((x) => norm(x.value) === norm(parent));
        if (!p) { p = { key: newKey(), value: parent, disabled: false, children: [] }; next.push(p); }
        if (child) p.children.push({ key: newKey(), value: child, disabled: false });
      });
      return next;
    });
    toast(tn(parsed.fresh.length, '{n} option added to the draft.', '{n} options added to the draft.'), 'ok');
    setBulk('');
    setShowAll(true);
  };

  const sortAll = (dir) => {
    setResult(null);
    setTree((tr) => sortDir(tr, dir, disabledLast).map((p) => ({ ...p, children: sortDir(p.children || [], dir, disabledLast) })));
  };
  const sortByUsage = () => {
    if (!usage) return;
    const uses = (o) => (o.id ? usage.perOption?.[o.id] || 0 : 0);
    const sort = (items) => [...items.filter((i) => !i.disabled).sort((a, b) => uses(b) - uses(a)), ...items.filter((i) => i.disabled)];
    setResult(null);
    setTree((tr) => sort(tr).map((p) => ({ ...p, children: sort(p.children || []) })));
  };
  const disableUnused = () => {
    if (!usage) return;
    let n = 0;
    const off = (o) => { if (o.id && !o.disabled && usage.perOption?.[o.id] === 0) { n += 1; return { ...o, disabled: true, isDefault: false }; } return o; };
    setResult(null);
    setTree(tree.map((p) => ({ ...off(p), children: (p.children || []).map(off) })));
    toast(n ? tn(n, '{n} unused option disabled in the draft.', '{n} unused options disabled in the draft.') : t('Every active option is used at least once.'));
  };
  const doCopy = async () => {
    try {
      const r = await call('optionsOf', { fieldId: copyFrom });
      const lines2 = r.values.flatMap((v) => (field.cascading && v.children.length ? v.children.map((c) => `${v.value} > ${c}`) : [v.value]));
      setBulk(lines2.join('\n'));
      setMode('many');
      setCopyOpen(false);
      toast(t('Options of "{name}" are ready to add: check them and click Add.', { name: r.field.name }));
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const r = await call('applyOptions', { fieldId: field.id, contextId: field.contextId, tree });
      setResult(r);
      // The notification carries an Undo: one click puts the options back as they were (see performUndo).
      if (r.status === 'done') {
        toast(tn(r.rows.length, 'Saved {n} change.', 'Saved {n} changes.'), 'ok', r.batchId ? {
          detail: field.name,
          action: { label: t('Undo'), icon: 'undo', run: async () => { const x = await performUndo({ batchId: r.batchId }); setResult(null); await load(); return x; } },
        } : {});
        await load();
      }
      if (r.status === 'pending') { toast(t('Sent for approval as {key}.', { key: r.issueKey }), 'ok'); await load(); }
    } catch (e) {
      setResult({ status: 'error', error: e.message });
    }
    setBusy(false);
  };

  if (state.loading) return <Skeleton lines={8} />;
  if (state.error) return <Msg tone="error">{state.error}</Msg>;

  const candidates = fields.filter((f) => f.hasOptions && f.id !== field.id && !f.error);
  const counts = [
    plan.edits.length ? tn(plan.edits.length, '{n} renamed', '{n} renamed') : null,
    plan.disables.length ? tn(plan.disables.length, '{n} disabled', '{n} disabled') : null,
    plan.enables.length ? tn(plan.enables.length, '{n} enabled', '{n} enabled') : null,
    plan.adds.length ? tn(plan.adds.length, '{n} new', '{n} new') : null,
    plan.orders.length ? t('new order') : null,
    plan.defaultChange ? t('default') : null,
  ].filter(Boolean);
  const nChanges = rows.length;
  const hasDefault = tree.some((p) => p.isDefault || (p.children || []).some((c) => c.isDefault));

  return (
    <div className="stack">
      <div className="split">
        <section className="stack" aria-label={t('Options')}>
          <div className="spread">
            <h3>{t('Options')} <small>{t('in display order')}</small>{usage && usage.total !== null ? <small> · {tn(usage.total, '{n} work item has a value', '{n} work items have a value')}</small> : null}</h3>
            <div className="row" role="group" aria-label={t('Sort')}>
              <button type="button" className="btn line small" onClick={() => sortAll('asc')}><Icon name="az" />{t('Sort A–Z')}</button>
              <button type="button" className="btn line small" onClick={() => sortAll('desc')}><Icon name="za" />{t('Sort Z–A')}</button>
            </div>
          </div>
          {usage?.note ? <small>{usage.note}</small> : null}
          {blocked ? <Note icon="clock" tone="accent">{state.open.map((k) => <IssueLink key={k} k={k} />)} {t('changes this field and is waiting for approval. New changes can be made once it has been decided.')}</Note> : null}
          {field.scope !== 'project' && direct && !blocked ? <Note icon="warn" tone="accent">{field.scope === 'global' ? t('Global context: your change applies to every space that uses this field.') : t('Shared context: your change applies to every space that shares it.')}</Note> : null}
          <div className="row">
            <label className="check"><input type="checkbox" checked={disabledLast} onChange={(e) => setDisabledLast(e.target.checked)} />{t('Disabled options last when sorting')}</label>
            <span className="grow" />
            <button type="button" className="btn ghost small" onClick={sortByUsage} disabled={!usage}>{t('Most used first')}</button>
            <button type="button" className="btn ghost small" onClick={disableUnused} disabled={!usage}>{t('Disable unused')}</button>
            <button type="button" className="btn ghost small" onClick={() => setCopyOpen(true)} disabled={!candidates.length}>{t('Copy from field…')}</button>
            {hasDefault ? <button type="button" className="btn ghost small" onClick={() => setDefault(null)}>{t('No default')}</button> : null}
          </div>
          <div className="opt-head" aria-hidden="true"><span /><span>{t('Name')}</span><span>{t('Status')}</span><span>{t('Default')}</span><span style={{ textAlign: 'right' }}>{t('Uses')}</span></div>
          <OptionRows items={tree} original={original} usage={usage} onChange={setTop} onDefault={setDefault} cascading={field.cascading} expanded={expanded} setExpanded={setExpanded}
            limit={showAll ? 0 : SHOWN}
            renderChildren={(p) => <OptionRows items={p.children || []} original={original} usage={usage} onChange={setChildren(p.key)} onDefault={setDefault} parentKey={p.key} cascading={field.cascading} expanded={{}} setExpanded={() => null} renderChildren={() => null} />} />
          {!showAll && tree.length > SHOWN ? <button type="button" className="more" onClick={() => setShowAll(true)}>{tn(tree.length - SHOWN, 'Show {n} more option', 'Show {n} more options')}</button> : null}
        </section>

        <aside className="side">
          <div className="card stack">
            <h3>{t('Add new options')}</h3>
            <Segmented label={t('How to add')} value={mode} onChange={setMode} items={[{ key: 'one', label: t('One at a time') }, { key: 'many', label: t('Several at once') }]} />
            {mode === 'one' ? (
              <div className="stack tight enter" key="one">
                <div>
                  <label className="field" htmlFor="new-option">{t('Name of the option')}</label>
                  <input id="new-option" ref={addRef} type="text" value={newValue} onChange={(e) => setNewValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addOne(); }} />
                  <div className="hint">{t('Enter adds the option, the box stays open for the next one.')}</div>
                </div>
                <button type="button" className="btn dark" onClick={addOne} disabled={!newValue.trim()}><Icon name="plus" />{t('Add')}</button>
                {lastAdded ? <div className="row" key={lastAdded}><Tick /><small className="ink">{t('"{name}" added', { name: lastAdded })}</small></div> : null}
              </div>
            ) : (
              <div className="stack tight enter" key="many">
                <label className="field" htmlFor="new-options" style={{ marginBottom: 0 }}>{field.cascading ? t('One per line as "Parent > Child", e.g. copied from Excel') : t('One option per line, e.g. copied from Excel')}</label>
                <textarea id="new-options" rows={5} value={bulk} onChange={(e) => setBulk(e.target.value)} />
                {lines ? <small className="num">{tn(lines, '{n} line', '{n} lines')}{parsed.dupes.length ? ` · ${tn(parsed.dupes.length, '{n} duplicate is skipped', '{n} duplicates are skipped')} (${parsed.dupes.slice(0, 3).map((d) => `"${d}"`).join(', ')}${parsed.dupes.length > 3 ? ' …' : ''})` : ''}</small> : null}
                <button type="button" className="btn dark" onClick={addBulk} disabled={!parsed.fresh.length}><Icon name="plus" />{tn(parsed.fresh.length, 'Add {n} option', 'Add {n} options')}</button>
                <small>{t('New options go to the end in the pasted order. Then drag them or sort alphabetically.')}</small>
              </div>
            )}
          </div>
          <Note icon="info">{t('Options can\'t be deleted. Disable them instead: existing work items keep the value, new ones can\'t choose it.')}</Note>
          <Note icon={direct ? 'check' : 'shield'}>{readonly ? t('You can look, but changes to this field are made by a Jira administrator.') : direct ? t('No approval needed · every change lands in the audit log.') : t('Your changes go to a Jira administrator for approval; the app carries them out once approved. Every change lands in the audit log.')}</Note>
          {!planIsEmpty(plan) && impact.length ? <Note icon="warn" tone="accent"><strong>{t('Impact on existing work items')}</strong>{impact.map((l) => <span key={l}>{l}</span>)}</Note> : null}
          {direct && !planIsEmpty(plan) && rules.twoPersonThreshold && affectedItems >= rules.twoPersonThreshold ? <Note icon="shield" tone="accent"><strong>{t('Two-person rule')}</strong>{t('This change touches {n} work items (threshold {max}): a second person approves it.', { n: affectedItems, max: rules.twoPersonThreshold })}</Note> : null}
          {radar ? (
            <Note icon="eye" tone={radar.filters?.filters?.some((f) => f.mentionsValue.length) ? 'accent' : ''}>
              <strong>{t('Impact radar')}</strong>
              {radar.filters?.checked ? (
                radar.filters.filters.length ? radar.filters.filters.slice(0, 6).map((f) => <span key={f.id}>{t('Filter "{name}" ({owner})', { name: f.name, owner: f.owner })}{f.mentionsValue.length ? ` ${t('mentions {values}', { values: f.mentionsValue.join(', ') })}` : ` ${t('uses this field')}`}</span>)
                  : <span>{t('None of the {n} saved filters you can see uses this field.', { n: radar.filters.scanned })}</span>
              ) : <span>{radar.filters?.note}</span>}
              <span>{radar.rules?.indexed ? (radar.rules.hiddenCount ? t('{n} automation rule(s) use this field (a Jira administrator sees which).', { n: radar.rules.hiddenCount }) : radar.rules.rules.length ? t('Automation rules: {names}', { names: radar.rules.rules.map((r) => r.name).join(', ') }) : t('No automation rule uses this field.')) : radar.rules?.note}</span>
            </Note>
          ) : null}
          <button type="button" className="btn ai small" onClick={() => askAssistant(`Project ${projectKey}: help me clean up the options of "${field.name}" (${field.id}). Which ones look like duplicates or are unused?`)}><Icon name="spark" />{t('Ask Field Assistant to tidy up')}</button>
        </aside>
      </div>

      {errors.length ? <Msg tone="error" title={t('Fix before saving')}>{errors.map((e) => <div key={e}>{e}</div>)}</Msg> : null}
      {result?.status === 'done' ? <div className="card done-burst enter"><Tick /><h3>{t('Saved')}</h3><small>{tn(result.rows.length, '{n} change is live.', '{n} changes are live.')}{result.policy ? ` ${t('Approved by policy: {p}', { p: result.policy })}` : ''} {t('Every change is in the audit log.')}</small></div> : null}
      {result?.status === 'pending' ? <div className="card done-burst enter"><Tick /><h3>{t('Sent for approval')}</h3><small><IssueLink k={result.issueKey} /> · {(result.reasons || []).join(' ')} {t('You\'ll get an e-mail when it has been decided; this page updates by itself.')}</small></div> : null}
      {result?.status === 'invalid' ? <Msg tone="error">{result.errors.join(' ')}</Msg> : null}
      {result?.status === 'error' ? <Msg tone="error">{result.error}</Msg> : null}
      {!planIsEmpty(plan) && !readonly ? (
        <div className="savebar" role="region" aria-label={t('Unsaved changes')}>
          <span>{tn(nChanges, '{n} unsaved change', '{n} unsaved changes')}: {counts.join(', ')}</span>
          <div className="row">
            <button type="button" className="btn small" disabled={busy} onClick={() => { setTree(clone(original)); setResult(null); }}>{t('Discard')}</button>
            <button type="button" className="btn primary small" disabled={errors.length > 0 || busy || blocked || !canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={save}>{busy ? t('Working…') : direct ? t('Save changes') : t('Send for approval')}</button>
          </div>
        </div>
      ) : null}

      {copyOpen ? (
        <Modal title={t('Copy options from another field')} onClose={() => setCopyOpen(false)} footer={<><button type="button" className="btn ghost" onClick={() => setCopyOpen(false)}>{t('Cancel')}</button><button type="button" className="btn primary" disabled={!copyFrom} onClick={doCopy}>{t('Use these options')}</button></>}>
          <p className="muted">{t('The active options of the chosen field are put into "Several at once"; existing ones are skipped. Nothing changes in the other field.')}</p>
          <Picker
            id="copy-from" label={t('Field to copy from')} value={copyFrom} onChange={(v) => setCopyFrom(v)}
            placeholder={t('Choose a field of this space')} searchPlaceholder={t('Search {n} fields', { n: candidates.length })} emptyText={t('No field matches.')}
            items={candidates.map((f) => ({ value: f.id, label: f.name, meta: [f.type, f.optionCount ? tn(f.optionCount.active, '{n} active option', '{n} active options') : null].filter(Boolean).join(' · ') }))}
          />
        </Modal>
      ) : null}
    </div>
  );
}
