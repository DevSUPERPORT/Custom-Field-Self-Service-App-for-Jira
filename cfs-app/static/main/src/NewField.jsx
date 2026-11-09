/**
 * Request (or, for Jira administrators, add) a new field in three steps: field, context and screens, with the live
 * guideline check, an auto-saved draft and a summary of the request.
 *
 * @file        static/main/src/NewField.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CREATABLE, typeByKey } from '../../../src/shared/fieldtypes.js';
import { splitLines, norm } from '../../../src/shared/status.js';
import { call, Msg, Skeleton, IssueLink, useToast, askAssistant, Icon, Note, Segmented, Tick, useCanWrite, PAUSED_HINT } from './ui';
import { t, tn } from './i18n';

const EMPTY = { name: '', description: '', typeKey: 'select', optionsText: '', defaultValue: '', global: false, justification: '', addToScreens: true };
const VERDICT = {
  green: { icon: 'check', text: 'Fits the guidelines' },
  yellow: { icon: 'warn', text: 'Fits, with notes for the approver' },
  red: { icon: 'x', text: 'Fix the points below' },
};
const lines = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

// Space picker (UC-04): searchable by key and name, only spaces the person may see; the own space is always in.
function SpaceSearch({ projects, selected, max, onAdd }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const full = selected.length >= max;
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits = projects.filter((p) => !selected.includes(p.key) && words.length && words.every((w) => `${p.key} ${p.name}`.toLowerCase().includes(w))).slice(0, 8);
  const pick = (p) => { if (!p) return; onAdd(p.key); setQ(''); setActive(0); };
  return (
    <div>
      <div className="search">
        <Icon name="search" />
        <label htmlFor="f-proj" className="sr">{t('Add a space')}</label>
        <input id="f-proj" type="search" value={q} disabled={full} placeholder={full ? t('Limit reached') : t('Add a space: key or name')}
          role="combobox" aria-expanded={hits.length > 0} aria-controls="proj-list"
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            if (e.key === 'Enter') { e.preventDefault(); pick(hits[active]); }
            if (e.key === 'Escape') setQ('');
          }} />
      </div>
      {hits.length ? (
        <ul id="proj-list" className="combo-list" role="listbox" aria-label={t('Spaces')}>
          {hits.map((p, i) => (
            <li key={p.key} role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)}>
              <span className="k">{p.key}</span><span>{p.name}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="hint">{full ? t('The limit of {max} spaces is reached (set by your Jira administrator). Remove one to add another.', { max }) : t('Search by key or name. You only see spaces you have access to.')}</div>
    </div>
  );
}

export default function NewField({ fields, onChanged, role, onBack, onMine, safe = false }) {
  const canWrite = useCanWrite();
  const admin = role === 'jira-admin';
  const toast = useToast();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  const [d, setD] = useState(EMPTY);
  const [projects, setProjects] = useState([]);
  const [itMode, setItMode] = useState('all');
  const [issueTypes, setIssueTypes] = useState([]);
  const [otherTypes, setOtherTypes] = useState({});
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [restored, setRestored] = useState(null);
  const [screens, setScreens] = useState(null);
  const [screenIds, setScreenIds] = useState(null); // null = every selectable screen ticked
  const [addMode, setAddMode] = useState('one');
  const [one, setOne] = useState('');
  const [many, setMany] = useState('');
  const oneRef = useRef(null);

  useEffect(() => {
    call('newFieldMeta').then((m) => { setMeta(m); setProjects([m.current]); }).catch((e) => setError(e.message));
    call('getDraft').then((r) => { if (r && r.draft && r.draft.name) setRestored(r); }).catch(() => null);
  }, []);
  // Drafts that wait: the form is saved per user and project, so it survives a reload or another device.
  // Emptying the name after typing one clears the saved draft too, so an abandoned form isn't offered again.
  const hadName = useRef(false);
  useEffect(() => {
    if (!meta) return undefined;
    if (!d.name && !hadName.current) return undefined;
    hadName.current = !!d.name;
    const timer = setTimeout(() => call('saveDraft', { draft: d.name ? d : {} }).catch(() => null), 1500);
    return () => clearTimeout(timer);
  }, [d, meta]);

  const typeIds = itMode === 'all' ? [] : issueTypes;
  // The own space's screens; shared ones come back locked.
  useEffect(() => {
    if (!meta) return undefined;
    setScreens(null);
    const timer = setTimeout(() => {
      call('screens', { issueTypeIds: typeIds }).then((r) => setScreens(r.screens)).catch(() => setScreens([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [meta, typeIds.join('|')]);
  // Issue types of the other spaces: a chosen type they don't have means the field stays invisible there.
  const others = projects.filter((k) => meta && k !== meta.current);
  useEffect(() => {
    const missing = others.filter((k) => !otherTypes[k]);
    if (!missing.length) return;
    call('projectIssueTypes', { keys: missing }).then((r) => setOtherTypes((x) => ({ ...x, ...r.issueTypes }))).catch(() => null);
  }, [others.join('|')]);

  const selectable = (screens || []).filter((x) => x.exclusive);
  const chosenScreens = screens ? (screenIds === null ? selectable.map((x) => x.screenId) : screenIds.filter((id) => selectable.some((x) => x.screenId === id))) : [];
  const draft = useMemo(() => ({ ...d, addToScreens: chosenScreens.length > 0, screenIds: chosenScreens, projectKeys: projects, issueTypeIds: typeIds }), [d, projects, typeIds.join('|'), chosenScreens.join('|')]);
  useEffect(() => {
    if (!meta) return undefined;
    setChecking(true);
    const timer = setTimeout(() => {
      call('checkField', { draft }).then(setCheck).catch((e) => setError(e.message)).finally(() => setChecking(false));
    }, 450);
    return () => clearTimeout(timer);
  }, [draft, meta]);

  if (error && !meta) return <Msg tone="error">{error}</Msg>;
  if (!meta) return <Skeleton lines={10} />;
  const allowed = CREATABLE.filter((x) => !meta.rules?.allowedTypes || meta.rules.allowedTypes.includes(x.key));
  const type = typeByKey(d.typeKey);
  const set = (k) => (e) => { setResult(null); setD({ ...d, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }); };
  const own = meta.projects.find((p) => p.key === meta.current) || { key: meta.current, name: meta.current, issueTypes: [] };
  const max = meta.maxContextProjects || 10;
  const opts = lines(d.optionsText);
  const reuseHit = check?.catalogueField ? { fieldId: check.catalogueField.id, code: 'catalogue' } : check?.findings.find((f) => (f.code === 'similar-field' || f.code === 'ai-similar') && f.fieldId && f.level === 'yellow');
  const reuseField = reuseHit ? fields.find((f) => f.id === reuseHit.fieldId) : null;
  const similar = check?.findings.find((f) => f.code === 'similar-field' || f.code === 'ai-similar' || f.code === 'name-taken');
  const typeName = (id) => own.issueTypes.find((x) => x.id === id)?.name || id;
  const missingTypes = typeIds.length ? others.flatMap((k) => (otherTypes[k] ? typeIds.filter((id) => !otherTypes[k].some((x) => x.id === id)).map((id) => ({ k, name: typeName(id) })) : [])) : [];

  const setOpts = (list) => { setResult(null); setD({ ...d, optionsText: list.join('\n'), defaultValue: list.includes(d.defaultValue) ? d.defaultValue : '' }); };
  const addOne = () => {
    const v = one.trim();
    if (!v) return;
    if (opts.some((o) => norm(o) === norm(v))) { toast(t('"{name}" is already in the list.', { name: v })); return; }
    setOpts([...opts, v]);
    setOne('');
    oneRef.current?.focus();
  };
  const parsedMany = splitLines(many, opts);
  const addMany = () => { setOpts([...opts, ...parsedMany.fresh]); setMany(''); };

  const submit = async (confirmWarnings = false) => {
    setBusy(true);
    try {
      const r = await call('requestField', { draft: { ...draft, confirmWarnings } });
      setResult(r);
      if (r.status === 'created') { toast(t('Created {id}.', { id: r.fieldId }), 'ok'); onChanged(); call('saveDraft', { draft: {} }).catch(() => null); }
      if (r.status === 'reused') { toast(t('Catalogue field {id} can now be used here.', { id: r.fieldId }), 'ok'); onChanged(); }
      if (r.status === 'pending') { toast(t('Sent for approval as {key}.', { key: r.issueKey }), 'ok'); onChanged(); call('saveDraft', { draft: {} }).catch(() => null); }
    } catch (e) {
      setResult({ status: 'error', error: e.message });
    }
    setBusy(false);
  };
  const reuse = async () => {
    setBusy(true);
    try {
      const r = await call('reuse', { fieldId: reuseHit.fieldId, addToScreens: chosenScreens.length > 0, issueTypeIds: typeIds });
      setResult({ ...r, status: `reuse-${r.status}` });
      if (r.status === 'done') { toast(t('"{name}" can now be used here.', { name: r.plan.field.name }), 'ok'); onChanged(); }
    } catch (e) {
      setResult({ status: 'error', error: e.message });
    }
    setBusy(false);
  };
  const reset = () => { setD(EMPTY); setResult(null); setIssueTypes([]); setItMode('all'); setScreenIds(null); setProjects([meta.current]); };

  const v = check ? VERDICT[check.result] : null;
  const started = !!(d.name.trim() || d.description.trim() || d.optionsText.trim() || d.justification.trim());
  const done = result && ['created', 'pending', 'reused', 'reuse-done', 'reuse-pending'].includes(result.status);
  const ok1 = d.name.trim().length >= 2 && d.description.trim() && (!type?.options || opts.length) && d.justification.trim();
  const ok2 = projects.length >= 1 && (itMode === 'all' || issueTypes.length);
  const ok3 = screens !== null;
  const steps = [ok1, ok2, ok3, check && check.result !== 'red'];

  if (done && ['created', 'pending', 'reused'].includes(result.status)) {
    return (
      <div className="card done-burst enter">
        <Tick />
        <h2>{result.status === 'pending' ? t('Request sent') : t('Field created')}</h2>
        <p className="muted">{result.status === 'pending'
          ? <>{t('Your request is waiting for approval by a Jira administrator.')} <IssueLink k={result.issueKey} /></>
          : <>{result.fieldId} · {(result.notes || []).join(' ')}</>}</p>
        <div className="row">
          {result.status === 'pending' ? <button type="button" className="btn primary" onClick={onMine}>{t('Open My requests')}</button> : <button type="button" className="btn primary" onClick={onBack}>{t('Back to the fields')}</button>}
          <button type="button" className="btn line" onClick={reset}>{t('Another field')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="spread">
        <div className="stack tight">
          <button type="button" className="linkish" onClick={onBack}><Icon name="left" />{t('All fields')}</button>
          <h2>{admin ? t('Add a new field') : t('Request a new field')}</h2>
        </div>
        <button type="button" className="btn ai small" onClick={() => askAssistant(`Project ${meta.current}: I need a new custom field. Ask me what it should hold, one question at a time, then preview it.`)}><Icon name="spark" />{t('Describe it to Field Assistant instead')}</button>
      </div>
      {restored ? (
        <Note icon="history" tone="accent">
          <strong>{t('Continue your draft "{name}"?', { name: restored.draft.name })}</strong>
          <span className="row"><button type="button" className="btn primary small" onClick={() => { setD({ ...EMPTY, ...restored.draft }); setRestored(null); }}>{t('Continue')}</button><button type="button" className="btn ghost small" onClick={() => setRestored(null)}>{t('Start fresh')}</button></span>
        </Note>
      ) : null}

      <div className="split">
        <div className="stack">
          <section className="card stack" aria-labelledby="s1">
            <h3 className="sec-title" id="s1"><span className={`sec-n ${ok1 ? 'ok' : ''}`}>{ok1 ? <Icon name="check" className="tick" /> : 1}</span>{t('Field')}</h3>
            <div>
              <label className="field req" htmlFor="f-name">{t('Name')}</label>
              <input id="f-name" type="text" value={d.name} onChange={set('name')} autoFocus aria-describedby="dup-hint" />
              {started && similar ? <div id="dup-hint" style={{ marginTop: 8 }}><Note icon="warn" tone="accent">{similar.message}{similar.suggestion ? <span><button type="button" className="btn line small" onClick={() => setD({ ...d, name: similar.suggestion })}>{t('Use "{name}"', { name: similar.suggestion })}</button></span> : null}</Note></div> : null}
            </div>
            <div><label className="field req" htmlFor="f-desc">{t('Description')}</label><textarea id="f-desc" rows={3} value={d.description} onChange={set('description')} /></div>
            <div>
              <label className="field req" htmlFor="f-type">{t('Field type')}</label>
              <select id="f-type" value={d.typeKey} onChange={set('typeKey')}>{allowed.map((x) => <option key={x.key} value={x.key}>{t(x.label)}</option>)}</select>
            </div>
            {type?.options ? (
              <fieldset className="stack tight" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="label req">{t('Options')}</legend>
                {opts.length ? (
                  <div className="chips">{opts.map((o) => (
                    <span key={o} className="chip">{o}<button type="button" aria-label={t('Remove {name}', { name: o })} onClick={() => setOpts(opts.filter((x) => x !== o))}><Icon name="x" /></button></span>
                  ))}</div>
                ) : <small>{type.cascading ? t('Cascading select: one line per option as "Parent > Child".') : t('No options yet.')}</small>}
                <Segmented label={t('How to add')} value={addMode} onChange={setAddMode} items={[{ key: 'one', label: t('One at a time') }, { key: 'many', label: t('Several at once') }]} />
                {addMode === 'one' ? (
                  <div className="row enter" key="one">
                    <label htmlFor="f-opt-one" className="sr">{t('Name of the option')}</label>
                    <input id="f-opt-one" ref={oneRef} type="text" style={{ flex: '1 1 220px', width: 'auto' }} value={one} onChange={(e) => setOne(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOne(); } }} placeholder={t('Name of the option')} />
                    <button type="button" className="btn dark" onClick={addOne} disabled={!one.trim()}><Icon name="plus" />{t('Add')}</button>
                  </div>
                ) : (
                  <div className="stack tight enter" key="many">
                    <label className="field" htmlFor="f-opt-bulk" style={{ marginBottom: 0 }}>{t('One option per line, e.g. copied from Excel')}</label>
                    <textarea id="f-opt-bulk" rows={4} value={many} onChange={(e) => setMany(e.target.value)} />
                    <div className="spread">
                      <small className="num">{many.trim() ? `${tn(parsedMany.fresh.length + parsedMany.dupes.length, '{n} line', '{n} lines')}${parsedMany.dupes.length ? ` · ${tn(parsedMany.dupes.length, '{n} duplicate is skipped', '{n} duplicates are skipped')} (${parsedMany.dupes.slice(0, 3).map((x) => `"${x}"`).join(', ')})` : ''}` : ''}</small>
                      <button type="button" className="btn dark small" onClick={addMany} disabled={!parsedMany.fresh.length}><Icon name="plus" />{tn(parsedMany.fresh.length, 'Add {n} option', 'Add {n} options')}</button>
                    </div>
                  </div>
                )}
              </fieldset>
            ) : null}
            <div>
              <label className="field" htmlFor="f-default">{t('Default value')} <span className="muted">{t('(optional, exactly one)')}</span></label>
              {type?.options ? (
                <select id="f-default" value={opts.includes(d.defaultValue) ? d.defaultValue : ''} onChange={set('defaultValue')} disabled={!opts.length}>
                  <option value="">{opts.length ? t('No default') : t('Add options first')}</option>
                  {opts.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : <input id="f-default" type="text" value={d.defaultValue} onChange={set('defaultValue')} />}
            </div>
            <div><label className="field req" htmlFor="f-why">{t('What is the field needed for?')}</label><textarea id="f-why" rows={2} value={d.justification} onChange={set('justification')} /></div>
          </section>

          <section className="card stack" aria-labelledby="s2">
            <h3 className="sec-title" id="s2"><span className={`sec-n ${ok2 ? 'ok' : ''}`}>{ok2 ? <Icon name="check" className="tick" /> : 2}</span>{t('Context')}</h3>
            <div className="stack tight">
              <div className="spread"><span className="label" style={{ margin: 0 }}>{t('Spaces')}</span><small className="num"><strong className="ink">{projects.length}</strong> {t('of max. {max} spaces, {key} included', { max, key: meta.current })}</small></div>
              <div className="chips">
                <span className="chip own"><Icon name="lock" />{meta.current} · {t('this space')}</span>
                {others.map((k) => {
                  const p = meta.projects.find((x) => x.key === k);
                  return <span key={k} className="chip">{k} · {p?.name || k}<button type="button" aria-label={t('Remove {name}', { name: k })} onClick={() => { setResult(null); setProjects(projects.filter((x) => x !== k)); }}><Icon name="x" /></button></span>;
                })}
              </div>
              {!d.global ? <SpaceSearch projects={meta.projects.filter((p) => p.key !== meta.current)} selected={projects} max={max} onAdd={(k) => { setResult(null); setProjects([...projects, k]); }} /> : null}
              {others.length ? <Note icon="info" tone="accent">{t('With several spaces the context no longer belongs to {key} alone: its options are then maintained by a Jira administrator.', { key: meta.current })}</Note> : null}
              {admin ? <label className="check"><input type="checkbox" checked={d.global} onChange={set('global')} />{t('Global context: the field and its options apply to every space')}</label> : null}
            </div>
            <fieldset className="stack tight" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="label">{t('Issue types')} <span className="muted">{t('from the issue type scheme of {key}', { key: meta.current })}</span></legend>
              <label className="check"><input type="radio" name="it" checked={itMode === 'all'} onChange={() => setItMode('all')} />{t('All issue types')}</label>
              <label className="check"><input type="radio" name="it" checked={itMode === 'some'} onChange={() => setItMode('some')} />{t('Only selected')}</label>
              {itMode === 'some' ? (
                <div className="typegrid enter" style={{ paddingLeft: 28 }}>
                  {own.issueTypes.map((x) => <label key={x.id} className="check"><input type="checkbox" checked={issueTypes.includes(x.id)} onChange={(e) => setIssueTypes(e.target.checked ? [...issueTypes, x.id] : issueTypes.filter((y) => y !== x.id))} />{x.name}</label>)}
                </div>
              ) : null}
              {missingTypes.map((m) => <small key={`${m.k}-${m.name}`}>{t('"{type}" doesn\'t exist in {key}: the field stays invisible there for this type.', { type: m.name, key: m.k })}</small>)}
            </fieldset>
          </section>

          <section className="card stack" aria-labelledby="s3">
            <h3 className="sec-title" id="s3"><span className={`sec-n ${ok3 ? 'ok' : ''}`}>{ok3 ? <Icon name="check" className="tick" /> : 3}</span>{t('Screens')}</h3>
            <p className="muted">{t('Only screens that {key} uses alone can be picked.', { key: meta.current })}</p>
            {screens === null ? <Skeleton lines={3} /> : !screens.length ? <small>{t('This space has no screens. A Jira administrator adds the field where it is needed.')}</small> : (
              <div className="screens">{screens.map((x, i) => (
                <label key={x.screenId} className={`screen-row rise ${x.exclusive ? '' : 'locked'}`} style={{ '--i': i }}>
                  <input type="checkbox" disabled={!x.exclusive} checked={x.exclusive && chosenScreens.includes(x.screenId)} onChange={(e) => { setResult(null); setScreenIds(e.target.checked ? [...chosenScreens, x.screenId] : chosenScreens.filter((id) => id !== x.screenId)); }} />
                  <span className="grow"><span>{x.name}</span><small>{x.operations.join(', ')}</small></span>
                  {x.exclusive ? <small>{t('only {key}', { key: meta.current })}</small> : <span className="lock"><Icon name="lock" />{t('shared with other spaces')}</span>}
                </label>
              ))}</div>
            )}
            <Note icon="info">{t('The field goes to the bottom of the first tab.')}{others.length ? ` ${t('The project admins of {keys} are told that the field is still missing on their screens and add it with one click.', { keys: others.join(', ') })}` : ''}</Note>
          </section>
        </div>

        <aside className="side">
          <div className="card summary-card">
            <h3>{admin ? t('Your new field') : t('Your request')}</h3>
            <div className="meter" aria-hidden="true">{steps.map((s, i) => <i key={i} className={s ? 'on' : ''} />)}</div>
            <div className="stack tight">
              <strong style={{ fontSize: 18 }}>{d.name.trim() || <span className="muted">{t('No name yet')}</span>}</strong>
              <small>{t(type?.label || '')}{type?.options ? ` · ${tn(opts.length, '{n} option', '{n} options')}` : ''}{d.defaultValue ? ` · ${t('default {v}', { v: d.defaultValue })}` : ''}</small>
            </div>
            <dl>
              <dt>{t('Spaces')}</dt><dd>{d.global ? t('all (global)') : projects.join(', ')}</dd>
              <dt>{t('Types')}</dt><dd>{itMode === 'all' ? t('all') : issueTypes.map(typeName).join(', ') || '–'}</dd>
              <dt>{t('Screens')}</dt><dd>{tn(chosenScreens.length, '{n} in {key}', '{n} in {key}', { key: meta.current })}</dd>
            </dl>
            {started && checking && !check ? <Skeleton lines={2} /> : null}
            {started && v ? <div className={`verdict ${check.result}`} aria-live="polite"><Icon name={v.icon} />{t(v.text)}{checking ? <small style={{ marginLeft: 'auto' }}>{t('checking…')}</small> : null}</div> : null}
            {started ? check?.findings.filter((f) => f !== similar).map((f, i) => (
              <div key={`${f.code}${i}`} className="finding"><span className={`dotl ${f.level}`} /><span className="grow">{f.message}{f.suggestion ? <> <button type="button" className="linkish" onClick={() => setD({ ...d, name: f.suggestion })}>{t('Use "{name}"', { name: f.suggestion })}</button></> : null}</span></div>
            )) : null}
            {check?.catalogue ? <small>{t('Matches the catalogue field "{name}": pre-approved.', { name: check.catalogue })}</small> : null}
            {reuseHit && !done ? (
              <Note icon="spark" tone="accent">
                <strong>{reuseHit.code === 'catalogue' ? t('"{name}" is a standard field that already exists', { name: check.catalogueField.name }) : t('Use "{name}" instead?', { name: reuseField?.name || reuseHit.fieldId })}</strong>
                <span>{t('Reusing keeps reports consistent and avoids a duplicate.')} {admin ? t('It is ready at once.') : t('A Jira administrator approves the reuse.')}</span>
                <span><button type="button" className="btn line small" disabled={busy} onClick={reuse}>{t('Use this field')}</button></span>
              </Note>
            ) : null}
            {result?.status === 'confirm' ? (
              <Note icon="warn" tone="accent">
                <strong>{t('Create it despite the notes?')}</strong>
                <span>{result.check.findings.filter((f) => f.level === 'yellow').map((f) => f.message).join(' ')}</span>
                <span className="row"><button type="button" className="btn primary small" disabled={busy || !canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={() => submit(true)}>{t('Create anyway')}</button><button type="button" className="btn ghost small" onClick={() => setResult(null)}>{t('Back to the form')}</button></span>
              </Note>
            ) : null}
            {result?.status === 'reuse-done' ? <Msg tone="success" title={t('Ready to use')}>{result.notes.join(' ')}</Msg> : null}
            {result?.status === 'reuse-pending' ? <Msg tone="info" title={t('Reuse sent for approval')}><IssueLink k={result.issueKey} /></Msg> : null}
            {result?.status === 'reuse-nochange' || result?.status === 'reuse-rejected' ? <Msg tone="warning">{result.notes.join(' ')}</Msg> : null}
            {result?.status === 'rejected' ? <Msg tone="error">{t('Not possible yet: fix the red points.')}</Msg> : null}
            {result?.status === 'error' ? <Msg tone="error">{result.error}</Msg> : null}
            <button type="button" className="btn primary big" disabled={busy || checking || !check || check.result === 'red' || !ok1 || !ok2 || !canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={() => submit(false)}>
              {busy ? t('Working…') : admin ? t('Create field') : t('Send request')}
            </button>
            <button type="button" className="btn ghost" onClick={onBack}>{t('Cancel')}</button>
          </div>
          <Note icon="info">{admin && safe ? t('Safe mode is on: your new field goes to a Jira administrator for approval first.') : admin ? t('As a Jira administrator you create the field directly; it is logged in the audit log.') : t('A Jira administrator approves new fields. Until then your request shows "Waiting for approval" under My requests, where you can also withdraw it.')}</Note>
        </aside>
      </div>
    </div>
  );
}
