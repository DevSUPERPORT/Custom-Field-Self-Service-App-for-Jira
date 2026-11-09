/**
 * Details view of one field of any type: what it is, where it is used and which spaces and screens have it, with the
 * Jira administrator tools (name, description, spaces, screens, take out of use) and the options editor.
 *
 * @file        static/main/src/FieldView.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// One field, whatever its type: what it is, where it is used, which spaces and screens have it. Jira administrators
// manage it right here (name, description, spaces, screens, take out of use; options below); everything they do is
// logged and can be undone from the audit log. Project admins see the same facts; option changes follow the site's
// policy (directly for fields only their space uses, or by request).
import React, { useCallback, useEffect, useState } from 'react';
import { call, Msg, Skeleton, Modal, when, useToast, useAutoRefresh, Icon, Ctx, CountUp, Note, performUndo, useCanWrite, PAUSED_HINT, Loz } from './ui';
import { t } from './i18n';
import Picker from './Picker';
import OptionsEditor from './OptionsEditor';

function EditNameDescription({ field, details, onDone }) {
  const canWrite = useCanWrite();
  const toast = useToast();
  const [name, setName] = useState(field.name);
  const [description, setDescription] = useState(details.description || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const changed = name.trim() !== field.name || description.trim() !== (details.description || '').trim();
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await call('adminFieldUpdate', { fieldId: field.id, name, description });
      toast(r.status === 'done' ? t('Saved.') : t('Nothing changed.'), r.status === 'done' ? 'ok' : 'info', r.status === 'done' ? undoAction(r.op) : {});
      onDone(true);
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };
  return (
    <div className="stack tight enter">
      <div><label className="field" htmlFor="fv-name">{t('Name')}</label><input id="fv-name" type="text" value={name} onChange={(e) => setName(e.target.value)} /></div>
      {name.trim() !== field.name ? <Note icon="warn" tone="accent">{t('JQL filters, dashboards and automations that use the old name "{name}" may stop working.', { name: field.name })}</Note> : null}
      <div><label className="field" htmlFor="fv-desc">{t('Description')}</label><textarea id="fv-desc" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      {err ? <Msg tone="error">{err}</Msg> : null}
      <div className="row">
        <button type="button" className="btn primary small" disabled={!changed || busy || name.trim().length < 2 || !canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={save}>{busy ? t('Saving…') : t('Save')}</button>
        <button type="button" className="btn ghost small" onClick={() => onDone(false)}>{t('Cancel')}</button>
      </div>
    </div>
  );
}

// A field administration step done: the notification offers its undo (the server checks it again).
const undoAction = (op) => (op ? { action: { label: t('Undo'), icon: 'undo', run: () => performUndo({ adminOpId: op }) } } : {});

function ContextSpaces({ field, context, spaces, onDone }) {
  const canWrite = useCanWrite();
  const toast = useToast();
  const [ids, setIds] = useState(context.projects.map((p) => p.id));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const before = context.projects.map((p) => p.id);
  const add = ids.filter((id) => !before.includes(id));
  const remove = before.filter((id) => !ids.includes(id));
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await call('adminFieldProjects', { fieldId: field.id, contextId: context.id, add, remove });
      toast(t('Spaces updated.'), 'ok', undoAction(r.op));
      onDone(true);
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };
  return (
    <div className="stack tight enter">
      <Picker
        id={`ctx-${context.id}`} label={t('Spaces')} multiple items={(spaces || []).map((s) => ({ value: s.id, label: `${s.name} (${s.key})`, meta: s.type }))}
        value={ids} onChange={setIds} loading={!spaces} searchPlaceholder={t('Search {n} spaces', { n: spaces ? spaces.length : '' })} allLabel={t('No space (pick at least one)')}
      />
      <small>{add.length ? `${t('Adds {n} space(s).', { n: add.length })} ` : ''}{remove.length ? `${t('Removes {n} space(s): the field disappears there (its values stay in the work items).', { n: remove.length })} ` : ''}{t('The options of this context then apply to every space listed.')}</small>
      {err ? <Msg tone="error">{err}</Msg> : null}
      <div className="row">
        <button type="button" className="btn primary small" disabled={busy || !ids.length || (!add.length && !remove.length) || !canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={save}>{busy ? t('Saving…') : t('Save spaces')}</button>
        <button type="button" className="btn ghost small" onClick={() => onDone(false)}>{t('Cancel')}</button>
      </div>
    </div>
  );
}

function SpaceScreens({ field, details, onDone }) {
  const canWrite = useCanWrite();
  const toast = useToast();
  const own = details.projectScreens || [];
  const [on, setOn] = useState(own.filter((s) => s.onScreen).map((s) => s.screenId));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmOut, setConfirmOut] = useState(false);
  const before = own.filter((s) => s.onScreen).map((s) => s.screenId);
  const add = on.filter((id) => !before.includes(id));
  const remove = before.filter((id) => !on.includes(id));
  const tabOf = (screenId) => (details.screens || []).find((s) => s.id === screenId)?.tabId;
  const run = async (payload, text) => {
    setBusy(true);
    setErr('');
    try {
      const r = await call('adminFieldScreens', { fieldId: field.id, ...payload });
      toast(r.status === 'done' ? text : t('Nothing changed.'), r.status === 'done' ? 'ok' : 'info', r.status === 'done' ? undoAction(r.op) : {});
      onDone(true);
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
    setConfirmOut(false);
  };
  return (
    <div className="stack tight enter">
      {confirmOut ? (
        <Modal title={t('Take "{name}" out of use?', { name: field.name })} onClose={() => setConfirmOut(false)}
          footer={<><button type="button" className="btn ghost" onClick={() => setConfirmOut(false)}>{t('Cancel')}</button><button type="button" className="btn primary" disabled={busy || !canWrite} onClick={() => run({ removeAll: true }, t('Taken off every screen.'))}>{t('Take out of use')}</button></>}>
          <p>{t('The field is removed from all {n} screen(s) that show it, in every space. Nobody can fill it in any more; existing values stay in the work items and in searches.', { n: (details.screens || []).length })}</p>
          <Note>{t('Nothing is deleted. Undo puts it back on the same screens.')}</Note>
        </Modal>
      ) : null}
      {own.length ? (
        <div className="screens">{own.map((s) => (
          <label key={s.screenId} className="screen-row">
            <input type="checkbox" checked={on.includes(s.screenId)} onChange={(e) => setOn(e.target.checked ? [...on, s.screenId] : on.filter((x) => x !== s.screenId))} />
            <span className="grow"><span>{s.name}</span><small>{s.operations.join(', ')}{s.shared ? ` · ${t('shared with other spaces')}` : ''}</small></span>
          </label>
        ))}</div>
      ) : <small>{t('This space has no screens of its own.')}</small>}
      {err ? <Msg tone="error">{err}</Msg> : null}
      <div className="row">
        <button type="button" className="btn primary small" disabled={busy || (!add.length && !remove.length) || !canWrite} title={canWrite ? undefined : PAUSED_HINT()}
          onClick={() => run({ add: add.map((screenId) => ({ screenId, name: own.find((s) => s.screenId === screenId)?.name })), remove: remove.map((screenId) => ({ screenId, tabId: tabOf(screenId) })).filter((x) => x.tabId) }, t('Screens updated.'))}>
          {busy ? t('Saving…') : t('Save screens')}
        </button>
        <span className="grow" />
        <button type="button" className="btn line small" disabled={busy || !(details.screens || []).length} onClick={() => setConfirmOut(true)}>{t('Take out of use…')}</button>
      </div>
    </div>
  );
}

export default function FieldView({ field, fields, rules, projectKey, role, onBack, backLabel }) {
  const canWrite = useCanWrite();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(null); // 'about' | context id | 'screens'
  const [spaces, setSpaces] = useState(null);
  const admin = role === 'jira-admin';
  const load = useCallback(async () => {
    try {
      setD(await call('fieldDetails', { fieldId: field.id }));
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  }, [field.id]);
  useAutoRefresh(load, { paused: !!editing });
  useEffect(() => {
    if (admin && editing && editing !== 'about' && editing !== 'screens' && !spaces) call('adminProjects').then(setSpaces).catch(() => setSpaces([]));
  }, [admin, editing, spaces]);
  const done = (changed) => { setEditing(null); if (changed) load(); };

  return (
    <div className="stack">
      <div><button type="button" className="linkish" onClick={onBack}><Icon name="left" />{backLabel || t('All fields')}</button></div>
      <div className="fhead">
        <div className="stack tight">
          <h2>{d?.field?.name || field.name}</h2>
          <div className="row"><span className="loz">{field.type}</span><Ctx f={field} /><small>{field.id}{d?.locked ? ` · ${t('locked by Jira')}` : ''}</small></div>
        </div>
        <button type="button" className="btn line small" onClick={load}><Icon name="refresh" />{t('Refresh')}</button>
      </div>
      {err ? <Msg tone="error">{err}</Msg> : null}
      {!d && !err ? <Skeleton lines={5} /> : null}
      {d ? (
        <div className="cards fv">
          <div className="card stack tight rise" style={{ '--i': 0 }}>
            <div className="spread"><h3>{t('About')}</h3>{admin && editing !== 'about' ? <button type="button" className="btn line small" disabled={!canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={() => setEditing('about')}><Icon name="edit" />{t('Edit')}</button> : null}</div>
            {editing === 'about' ? <EditNameDescription field={{ ...field, name: d.field?.name || field.name }} details={d} onDone={done} /> : (
              <p>{d.description || <span className="muted">{t('No description.')}</span>}</p>
            )}
            <div className="facts">
              <div className="fact"><div className="big">{d.usage.project === null || d.usage.project === undefined ? '–' : <CountUp value={d.usage.project} />}</div><small>{t('work items here have a value')}</small></div>
              {d.usage.site !== null && d.usage.site !== undefined ? <div className="fact"><div className="big"><CountUp value={d.usage.site} /></div><small>{t('on the whole site')}</small></div> : null}
              <div className="fact" title={t('When a work item with a value in this field was last updated. Jira does not record when a field value itself changed.')}><div className="big" style={{ fontSize: 16 }}>{d.lastUsed ? when(new Date(d.lastUsed).getTime()) : '–'}</div><small>{t('last used')}</small></div>
            </div>
          </div>

          <div className="card stack tight rise" style={{ '--i': 1 }}>
            <h3>{t('Where it is used')}</h3>
            {d.contexts.map((c) => (
              <div key={c.id} className="stack tight">
                <div className="spread">
                  <span className="row" style={{ gap: 6 }}><strong>{c.name}</strong>{String(c.id) === String(field.contextId) ? <Loz tone="green">{t('Used here')}</Loz> : null}</span>
                  {admin && !c.global && editing !== c.id ? <button type="button" className="btn line small" disabled={!canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={() => setEditing(c.id)}>{t('Change spaces')}</button> : null}
                </div>
                {editing === c.id ? <ContextSpaces field={field} context={c} spaces={spaces} onDone={done} /> : (
                  <small>{c.global ? (d.contexts.some((o) => !o.global) ? t('Global: every other space that has no context of its own.') : t('Global: every space whose field configuration includes it.')) : [...c.projects.map((p) => `${p.name} (${p.key})`), ...(c.hiddenProjects ? [t('{n} other space(s)', { n: c.hiddenProjects })] : [])].join(', ') || t('no space')}</small>
                )}
              </div>
            ))}
          </div>

          {admin ? (
            <div className="card stack tight rise" style={{ '--i': 2 }}>
              <div className="spread"><h3>{t('Screens')}</h3>{editing !== 'screens' ? <button type="button" className="btn line small" disabled={!canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={() => setEditing('screens')}>{t('Manage')}</button> : null}</div>
              {editing === 'screens' ? <SpaceScreens field={field} details={d} onDone={done} /> : (
                <small>{(d.screens || []).length ? (d.screens || []).map((s) => s.name).join(', ') : t('On no screen: nobody can fill it in.')}</small>
              )}
            </div>
          ) : (
            <div className="card stack tight rise" style={{ '--i': 2 }}>
              <h3>{t('Changes')}</h3>
              <small>{field.hasOptions ? `${field.access === 'direct' ? t('You change the options below directly; every change is logged.') : t('Option changes below are sent to a Jira administrator for approval; the app carries them out once approved.')} ` : ''}{t('Name, description, spaces and screens are managed by a Jira administrator.')}</small>
            </div>
          )}
        </div>
      ) : null}

      {field.hasOptions ? <OptionsEditor field={field} fields={fields} rules={rules} projectKey={projectKey} role={role} /> : null}
    </div>
  );
}
