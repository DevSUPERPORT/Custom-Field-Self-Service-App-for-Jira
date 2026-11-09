/**
 * People picker of the admin control centre: the chosen people as chips and a search over Jira's users, asked as the
 * viewer.
 *
 * @file        static/main/src/admin/UserPicker.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useEffect, useRef, useState } from 'react';
import { requestJira } from '@forge/bridge';
import { Icon, Spinner } from '../ui';
import { t } from '../i18n';

// Approvers, backups and the test lists: chips with the names the page already knows (state.people), plus a search
// that asks Jira's user search as the viewer. Only real Atlassian accounts are offered (no apps, no customers).
// onName tells the page the name of someone just added, so the chip shows a name before the next save.
export default function UserPicker({ id, label, hint, value, onChange, names = {}, onName }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const ids = value || [];

  // Debounced search: only the answer to the latest query is shown.
  useEffect(() => {
    const term = q.trim();
    seq.current += 1;
    const n = seq.current;
    if (term.length < 2) {
      setHits([]);
      setErr('');
      setBusy(false);
      return undefined;
    }
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const res = await requestJira(`/rest/api/3/user/search?query=${encodeURIComponent(term)}&maxResults=10`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = await res.json();
        if (n !== seq.current) return;
        setHits((Array.isArray(list) ? list : []).filter((u) => u.accountType === 'atlassian'));
        setErr('');
        setActive(0);
      } catch (e) {
        if (n !== seq.current) return;
        setHits([]);
        setErr(t('Jira did not answer the search ({msg}).', { msg: e.message }));
      }
      setBusy(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  const add = (u) => {
    if (!u || ids.includes(u.accountId)) return;
    if (onName) onName(u.accountId, u.displayName);
    onChange([...ids, u.accountId]);
    setQ('');
  };
  const remove = (accountId) => onChange(ids.filter((x) => x !== accountId));
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); add(hits[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setQ(''); }
  };
  const open = q.trim().length >= 2;

  return (
    <div className="user-picker">
      <label className="field" htmlFor={id}>{label}</label>
      {ids.length ? (
        <div className="users">
          {ids.map((a) => (
            <span key={a} className="chip">
              <Icon name="user" />{names[a] || a}
              <button type="button" aria-label={t('Remove {name}', { name: names[a] || a })} onClick={() => remove(a)}><Icon name="x" /></button>
            </span>
          ))}
        </div>
      ) : <div className="hint" style={{ marginTop: 0 }}>{t('Nobody yet.')}</div>}
      <div className="search user-search">
        <Icon name="search" />
        <input
          id={id} type="search" value={q} placeholder={t('Add a person: type at least two letters')} autoComplete="off"
          onChange={(e) => setQ(e.target.value)} onKeyDown={key}
          role="combobox" aria-expanded={open} aria-controls={`${id}-list`}
        />
      </div>
      {open ? (
        <ul className="combo-list" id={`${id}-list`} role="listbox">
          {busy && !hits.length ? <li aria-disabled="true"><Spinner />{t('Searching…')}</li> : null}
          {hits.map((u, i) => {
            const on = ids.includes(u.accountId);
            return (
              <li
                key={u.accountId} role="option" aria-selected={on} aria-disabled={on || undefined}
                className={i === active ? 'active' : ''}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => add(u)}
              >
                <Icon name="user" />
                <span className="grow">{u.displayName}{u.emailAddress ? <small> · {u.emailAddress}</small> : null}</span>
                {on ? <small>{t('already added')}</small> : null}
              </li>
            );
          })}
          {!busy && !hits.length && !err ? <li aria-disabled="true">{t('Nobody found.')}</li> : null}
          {err ? <li aria-disabled="true">{err}</li> : null}
        </ul>
      ) : null}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}
