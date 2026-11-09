/**
 * Configuration tab of the admin control centre: option-change policy, spaces per context, approval requests, field
 * types, retention, screen placement, pilot spaces, guard rails and the guidelines, with one save bar for all of it.
 *
 * @file        static/main/src/admin/Config.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React, { useEffect, useRef, useState } from 'react';
import { call, Msg, Icon, Loz, Modal, Skeleton, Spinner, when, useCanWrite, PAUSED_HINT } from '../ui';
import { t } from '../i18n';
import Picker from '../Picker';
import UserPicker from './UserPicker';
import { CheckLine, LEVEL_TONE, RISK_TONE, Section, Num, Check, ptype } from './common';
import { FEATURES } from '../../../../src/shared/features.js';

const ENGINE_TITLE = {
  'jsm-request': 'Jira Service Management approval with request type',
  'jsm-workitem': 'Jira Service Management approval on the work item',
  app: 'App approval (decided in Custom Field Self-Service for Jira)',
};
const RETENTION = [0, 12, 24, 36];
const DEFAULT_RT = 'Custom field change';

// Approval space: the project, its work type and (JSM only) the request type, read live from Jira, with a check of the
// whole chain under it. Picking a request type sets the work type, because JSM binds each request type to one.
function ApprovalSpace({ s, setMany, projectItems }) {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const last = useRef('');
  const sig = `${s.approvalProjectKey}|${s.approvalIssueTypeId || ''}|${s.approvalRequestTypeId || ''}`;
  const load = async (force) => {
    if (!force && last.current === sig) return;
    last.current = sig;
    if (!s.approvalProjectKey) {
      // Fresh installation: nothing to check until a space is picked.
      setInfo(null);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const r = await call('approvalSpace', {
        projectKey: s.approvalProjectKey, issueTypeId: s.approvalIssueTypeId || '', requestTypeId: s.approvalRequestTypeId || '',
        draft: { approverAccountIds: s.approverAccountIds, backupApproverAccountIds: s.backupApproverAccountIds, requesterAsReporter: s.requesterAsReporter },
      });
      setInfo(r);
      const next = { approvalIssueTypeId: r.selection.issueTypeId || '', approvalRequestTypeId: r.selection.requestTypeId || '' };
      if (next.approvalIssueTypeId !== (s.approvalIssueTypeId || '') || next.approvalRequestTypeId !== (s.approvalRequestTypeId || '')) {
        last.current = `${s.approvalProjectKey}|${next.approvalIssueTypeId}|${next.approvalRequestTypeId}`;
        setMany(next);
      }
    } catch (e) {
      setErr(e.message);
    }
    setLoading(false);
  };
  useEffect(() => { load(false); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const opts = info?.options;
  const workTypes = opts?.workTypes || [];
  const rts = opts?.requestTypes || [];
  const groupNames = [...new Set(rts.filter((r) => !r.hidden).map((r) => r.groups[0]))];
  const wt = workTypes.find((x) => x.id === (s.approvalIssueTypeId || ''));
  const rt = rts.find((r) => r.id === (s.approvalRequestTypeId || ''));
  const rtName = s.requestTypeName || DEFAULT_RT;
  const createRt = async () => {
    setCreating(true);
    setErr(null);
    try {
      const r = await call('createRequestType', { projectKey: s.approvalProjectKey, issueTypeId: s.approvalIssueTypeId, name: rtName });
      setCreated(r);
      last.current = '';
      setMany({ approvalRequestTypeId: r.requestType.id, approvalIssueTypeId: r.requestType.issueTypeId, requestTypeName: r.requestType.name });
    } catch (e) {
      setErr(e.message);
    }
    setCreating(false);
  };
  const rtOption = (r) => <option key={r.id} value={r.id}>{`${r.name} · ${r.workTypeName}`}</option>;

  return (
    <div className="stack">
      <div className="grid-3">
        <div>
          <label className="field" htmlFor="ap">{t('Approval space')}</label>
          <Picker id="ap" label={t('Approval space')} items={projectItems} value={s.approvalProjectKey}
            onChange={(v) => setMany({ approvalProjectKey: v || s.approvalProjectKey, approvalIssueTypeId: '', approvalRequestTypeId: '' })}
            placeholder={t('Pick a space')} searchPlaceholder={t('Search by key or name…')} emptyText={t('No space found')} />
          <div className="hint">{t('The project the approval requests are raised in.')}</div>
        </div>
        <div>
          <label className="field" htmlFor="wt">{t('Work type')}</label>
          <select id="wt" value={s.approvalIssueTypeId || ''} disabled={loading || !workTypes.length}
            onChange={(e) => { const v = e.target.value; setMany({ approvalIssueTypeId: v, approvalRequestTypeId: rt && rt.issueTypeId === v ? rt.id : '' }); }}>
            <option value="">{loading ? t('Loading…') : t('Pick a work type')}</option>
            {workTypes.map((x) => (
              <option key={x.id} value={x.id}>{`${x.name} · ${x.approval ? t('approval step at "{status}"', { status: x.approval.statusName }) : t('no approval step')}`}</option>
            ))}
          </select>
          <div className="hint">{rt ? t('Set by the request type "{name}".', { name: rt.name }) : t('From the space\'s issue type scheme.')}</div>
        </div>
        {opts?.project?.isJsm ? (
          <div>
            <label className="field" htmlFor="rqt">{t('Request type')}</label>
            <select id="rqt" value={s.approvalRequestTypeId || ''} disabled={loading}
              onChange={(e) => { const r = rts.find((x) => x.id === e.target.value); setMany({ approvalRequestTypeId: r ? r.id : '', ...(r ? { approvalIssueTypeId: r.issueTypeId, requestTypeName: r.name } : {}) }); }}>
              <option value="">{t('No request type (plain work item)')}</option>
              {groupNames.map((g) => <optgroup key={g} label={t('Portal group: {name}', { name: g })}>{rts.filter((r) => !r.hidden && r.groups[0] === g).map(rtOption)}</optgroup>)}
              {rts.some((r) => r.hidden) ? <optgroup label={t('Hidden from the portal')}>{rts.filter((r) => r.hidden).map(rtOption)}</optgroup> : null}
            </select>
            <div className="hint">{t('All {n} request types of {key}, hidden ones included.', { n: rts.length, key: opts.project.key })}</div>
          </div>
        ) : null}
      </div>
      {opts?.project && !opts.project.isJsm ? (
        <Msg tone="info">{t('{key} is a {type} project: request types exist only in Jira Service Management, so the app runs the approval itself.', { key: opts.project.key, type: ptype(opts.project.type) })}</Msg>
      ) : null}
      {opts?.project?.isJsm && !rt && wt ? (
        <div className="row">
          <button type="button" className="btn small line" disabled={creating} onClick={createRt}>{creating ? <Spinner /> : <Icon name="plus" />}{creating ? t('Creating…') : t('Create hidden request type "{name}"', { name: rtName })}</button>
          <small>{t('On "{wt}", hidden from the portal: only the app raises it. Then approvers can decide here too.', { wt: wt.name })}</small>
        </div>
      ) : null}
      {created ? (
        <Msg tone="success">{created.created
          ? t('Request type "{name}" created and selected. Save the settings to keep the rest of your changes.', { name: created.requestType.name })
          : t('Request type "{name}" already existed and is now selected.', { name: created.requestType.name })}</Msg>
      ) : null}
      {err ? <Msg tone="error">{err}</Msg> : null}
      {info ? (
        <div className="tile">
          <div className="spread">
            <div className="row">
              <Loz tone={LEVEL_TONE[info.level]}>{info.level === 'ok' ? t('Ready') : info.level === 'warn' ? t('Works, with notes') : t('Needs a fix')}</Loz>
              <strong>{t(ENGINE_TITLE[info.engine] || info.engine)}</strong>
            </div>
            <button type="button" className="btn ghost small" disabled={loading} onClick={() => load(true)}>{loading ? <Spinner /> : <Icon name="refresh" />}{loading ? t('Checking…') : t('Check again')}</button>
          </div>
          <p>{info.summary}</p>
          <div className="check-list">{info.checks.map((c, i) => <CheckLine key={i} c={c} i={i} />)}</div>
          {(info.errors || []).map((e, i) => <small key={i}>{e}</small>)}
        </div>
      ) : loading ? <Skeleton lines={3} /> : null}
    </div>
  );
}

// The alert work item's description as plain paragraphs: the text of each block of the ADF document.
const adfBlocks = (node, out = []) => {
  if (!node) return out;
  const text = (n) => (n.type === 'text' ? n.text || '' : n.type === 'hardBreak' ? '\n' : (n.content || []).map(text).join(''));
  if (['paragraph', 'heading', 'codeBlock', 'blockquote'].includes(node.type)) out.push({ code: node.type === 'codeBlock', text: text(node) });
  else if (node.type === 'listItem') out.push({ text: `• ${text(node)}` });
  else if (node.type === 'tableRow') out.push({ text: (node.content || []).map(text).join(' | ') });
  else (node.content || []).forEach((c) => adfBlocks(c, out));
  return out;
};

// "How it looks": the alert work item and the digest e-mail, built by the same code that raises / sends them.
function Preview({ kind, projectKey, onClose }) {
  const [p, setP] = useState(null);
  const [err, setErr] = useState(null);
  const [sent, setSent] = useState(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    call(kind === 'alert' ? 'previewAlert' : 'previewDigest', { projectKey }).then(setP).catch((e) => setErr(e.message));
  }, [kind, projectKey]);
  const sendMe = async () => {
    setSending(true);
    try {
      await call('previewDigest', { send: true });
      setSent({ tone: 'success', text: t('Sent. Look for "[Preview] Custom fields: …" in your inbox in a minute.') });
    } catch (e) {
      setSent({ tone: 'warning', text: e.message });
    }
    setSending(false);
  };
  const footer = (
    <>
      {kind === 'digest' && p?.anchor ? <button type="button" className="btn line" disabled={sending} onClick={sendMe}>{sending ? <Spinner /> : <Icon name="send" />}{t('Send this e-mail to me')}</button> : null}
      <button type="button" className="btn primary" onClick={onClose}>{t('Close')}</button>
    </>
  );
  return (
    <Modal wide title={kind === 'alert' ? t('How an alert looks') : t('How the daily digest looks')} onClose={onClose} footer={footer}>
      {err ? <Msg tone="error">{err}</Msg> : null}
      {!p && !err ? <Skeleton lines={6} /> : null}
      {p && kind === 'alert' ? (
        <div className="stack">
          <p>{t('When something fails, the app raises this work item in {project} and e-mails the approvers.', { project: p.project })} {p.dedupe} {t('Example: an approved change that failed three times.')}</p>
          <div className="tile">
            <div className="row"><Loz>{p.workType}</Loz><small>{p.project}</small></div>
            <h3>{p.summary}</h3>
            <div className="row">{p.labels.map((l) => <Loz key={l} tone="blue">{l}</Loz>)}</div>
            {adfBlocks(p.adf).map((b, i) => (b.code ? <pre key={i} className="adf-code">{b.text}</pre> : <p key={i}>{b.text}</p>))}
          </div>
          <div className="mail">
            <div className="mail-head stack tight">
              <small>{t('To: {list}', { list: p.recipients.join(', ') || t('no approvers set') })}</small>
              <strong>{p.emailSubject}</strong>
            </div>
            <span>{p.emailBody}</span>
          </div>
          <small>{p.lastReal ? t('Latest real alert: {key} · {summary}', { key: p.lastReal.key, summary: p.lastReal.summary }) : t('No real alert so far.')}</small>
        </div>
      ) : null}
      {p && kind === 'digest' ? (
        <div className="stack">
          <p>{p.when} {p.forYou ? t('This is your digest as it would go out tonight.') : t('Nothing waits for you, so this shows all open requests.')}</p>
          <div className="mail">
            <div className="mail-head stack tight">
              <small>{t('To: {list}', { list: p.recipients.join(', ') || t('nobody: nothing is waiting') })}</small>
              <strong>{p.subject}</strong>
            </div>
            {p.items.length ? (
              <div className="t-wrap">
                <table className="t compact">
                  <thead><tr><th>{t('Request')}</th><th>{t('Risk')}</th><th className="r">{t('Waiting')}</th><th>{t('Summary')}</th></tr></thead>
                  <tbody>
                    {p.items.map((it) => (
                      <tr key={it.issueKey}><td>{it.issueKey}</td><td><Loz tone={RISK_TONE[it.risk]}>{it.risk}</Loz></td><td className="r num">{it.hours} h</td><td>{it.summary}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <span>{t('Nothing is waiting: no digest goes out tonight.')}</span>}
            <span>{p.text.split('\n\n').slice(1).join('\n')}</span>
          </div>
          {sent ? <Msg tone={sent.tone}>{sent.text}</Msg> : null}
        </div>
      ) : null}
    </Modal>
  );
}

// A radio card: one of two choices with its explanation.
const Radio = ({ name, on, onPick, title, children }) => (
  <label className={`radio-card ${on ? 'on' : ''}`}>
    <input type="radio" name={name} checked={on} onChange={onPick} />
    <span className="grow"><strong>{title}</strong><small>{children}</small></span>
  </label>
);

// The save bar: shown while the configuration differs from what is saved.
const SaveBar = ({ saving, canWrite, onDiscard, onSave }) => (
  <div className="savebar">
    <span>{t('You have unsaved changes.')}</span>
    <div className="row">
      <button type="button" className="btn small" disabled={saving} onClick={onDiscard}>{t('Discard')}</button>
      <button type="button" className="btn primary small" disabled={saving || !canWrite} title={canWrite ? undefined : PAUSED_HINT()} onClick={onSave}>{saving ? <Spinner /> : <Icon name="check" />}{saving ? t('Saving…') : t('Save settings')}</button>
    </div>
  </div>
);

// Configuration: an editable copy of the saved settings (kept by the page, so it survives switching tabs). Nothing
// applies until Save; the app, the agent and the guideline check then use the new settings within 30 seconds.
export default function Config({ state, s, update, dirty, saving, saveError, onDiscard, onSave, names, onName }) {
  const canWrite = useCanWrite();
  const [preview, setPreview] = useState(null);
  const set = (k, v) => update((cur) => ({ ...cur, [k]: v }));
  const setMany = (o) => update((cur) => ({ ...cur, ...o }));
  const setRule = (k, v) => update((cur) => ({ ...cur, rules: { ...cur.rules, [k]: v } }));
  const projectItems = (state.projects || []).map((p) => ({ value: p.key, label: `${p.key} · ${p.name}`, meta: ptype(p.type) }));
  const maxCtx = Math.min(100, Math.max(1, Math.round(Number(s.maxContextProjects)) || 10));
  const retention = Number(s.auditRetentionMonths) || 0;
  const types = s.rules.allowedTypes || [];
  const reserved = Array.isArray(s.rules.extraForbiddenNames) ? s.rules.extraForbiddenNames.join('\n') : s.rules.extraForbiddenNames;
  const bar = dirty ? <SaveBar saving={saving} canWrite={canWrite} onDiscard={onDiscard} onSave={onSave} /> : null;

  return (
    <div className="stack">
      {bar}
      {saveError ? <Msg tone="error" title={t('Not saved')}>{saveError}</Msg> : null}

      <Section i={0} tour="cfg-policy" title={t('Option changes by project admins')}
        text={t('How project admins change the options of fields that only their own space uses. Shared and global fields always need a Jira administrator.')}>
        <Radio name="opt-policy" on={s.projectAdminOptionEdits !== 'direct'} onPick={() => set('projectAdminOptionEdits', 'approval')} title={t('Approval by a Jira administrator')}>
          {t('Every change a project admin makes becomes a request that a Jira administrator approves.')}
        </Radio>
        <Radio name="opt-policy" on={s.projectAdminOptionEdits === 'direct'} onPick={() => set('projectAdminOptionEdits', 'direct')} title={t('Directly, for fields only their space uses')}>
          {t('Project admins change these options right away. Every change is logged, and the guard rails still apply.')}
        </Radio>
      </Section>

      <Section i={1} title={t('Spaces per context')} text={t('How many spaces a project admin may pick when requesting a new field. At the limit they see a note.')}>
        <div>
          <label className="field" htmlFor="max-ctx">{t('Maximum')}</label>
          <div className="stepper">
            <button type="button" aria-label={t('Fewer')} onClick={() => set('maxContextProjects', Math.max(1, maxCtx - 1))}>−</button>
            <input id="max-ctx" type="number" min={1} max={100} value={s.maxContextProjects ?? ''} onChange={(e) => set('maxContextProjects', e.target.value)} />
            <button type="button" aria-label={t('More')} onClick={() => set('maxContextProjects', Math.min(100, maxCtx + 1))}>+</button>
          </div>
          <div className="hint">{t('Default: 10, the own space included.')}</div>
        </div>
      </Section>

      <Section i={2} wide tour="cfg-approvals" title={t('Approval requests')}
        text={t('For every request the app raises a work item here, so approvals land in your usual queue.')}>
        <ApprovalSpace s={s} setMany={setMany} projectItems={projectItems} />
        <div className="cfg">
          <UserPicker id="approvers" label={t('Approvers')} value={s.approverAccountIds} onChange={(v) => set('approverAccountIds', v)} names={names} onName={onName}
            hint={t('Jira administrators who decide requests. Nobody approves their own request.')} />
          <UserPicker id="backups" label={t('Backup approvers (added on escalation)')} value={s.backupApproverAccountIds} onChange={(v) => set('backupApproverAccountIds', v)} names={names} onName={onName} />
        </div>
        <div className="grid-3">
          <Num id="reminderHours" label={t('Remind approvers after (hours)')} value={s.reminderHours} onChange={(v) => set('reminderHours', v)} />
          <Num id="escalateHours" label={t('Escalate after (hours)')} value={s.escalateHours} onChange={(v) => set('escalateHours', v)} help={t('Stage 1 escalates to the approvers, stage 2 to the backups.')} />
        </div>
        <div className="stack tight">
          <div className="row">
            <Check checked={!s.requesterAsReporter} onChange={() => set('requesterAsReporter', !s.requesterAsReporter)}>{t('Allow self-approvals')}</Check>
            <Loz tone={s.requesterAsReporter ? 'green' : 'yellow'}>{s.requesterAsReporter ? t('No · production') : t('Yes · test mode')}</Loz>
          </div>
          <div className="hint" style={{ marginTop: 0 }}>{s.requesterAsReporter
            ? t('Nobody can approve their own request: the requester is the reporter, Jira excludes them as approver, and the app refuses it as well.')
            : t('One person can request and approve (the app is the reporter). Only for testing: switch off before real use.')}</div>
          <Check checked={s.notifyRequester} onChange={() => set('notifyRequester', !s.notifyRequester)}>{t('E-mail the requester when a request is approved, rejected or executed')}</Check>
          <div className="row">
            <Check checked={s.alertsEnabled} onChange={() => set('alertsEnabled', !s.alertsEnabled)}>{t('Raise an alert work item when something fails')}</Check>
            <button type="button" className="linkish" onClick={() => setPreview('alert')}><Icon name="eye" />{t('How it looks')}</button>
          </div>
          <div className="row">
            <Check checked={s.digestEnabled} onChange={() => set('digestEnabled', !s.digestEnabled)}>{t('Daily digest e-mail to approvers with what is waiting')}</Check>
            <button type="button" className="linkish" onClick={() => setPreview('digest')}><Icon name="eye" />{t('How it looks')}</button>
          </div>
        </div>
      </Section>
      {preview ? <Preview kind={preview} projectKey={s.approvalProjectKey} onClose={() => setPreview(null)} /> : null}

      <Section i={3} wide title={t('Allowed field types')} text={t('The types project admins can request for a new field.')}>
        <div className="typegrid">
          {state.types.map((x) => (
            <label key={x.key} className="check">
              <input type="checkbox" checked={types.includes(x.key)} onChange={() => setRule('allowedTypes', types.includes(x.key) ? types.filter((k) => k !== x.key) : [...types, x.key])} />
              {x.label}
            </label>
          ))}
        </div>
      </Section>

      <Section i={4} title={t('Audit log retention')} text={t('Older entries are deleted every night. Default: keep forever.')}>
        <div>
          <label className="field" htmlFor="ret">{t('Delete entries after')}</label>
          <select id="ret" value={retention} onChange={(e) => set('auditRetentionMonths', Number(e.target.value))}>
            {(RETENTION.includes(retention) ? RETENTION : [...RETENTION, retention].sort((a, b) => a - b)).map((m) => (
              <option key={m} value={m}>{m ? t('{n} months', { n: m }) : t('Keep forever')}</option>
            ))}
          </select>
        </div>
      </Section>

      <Section i={5} title={t('New fields on screens')} text={t('Where the app puts a new field on the screens the requester ticked.')}>
        <Radio name="placement" on={s.screenPlacement !== 'smart'} onPick={() => set('screenPlacement', 'bottom')} title={t('At the bottom of the first tab')}>
          {t('Default. Predictable: the field is always in the same place.')}
        </Radio>
        <Radio name="placement" on={s.screenPlacement === 'smart'} onPick={() => set('screenPlacement', 'smart')} title={t('Next to the most similar field')}>
          {t('The app looks for the field on the screen that is most alike and puts the new one right after it.')}
        </Radio>
      </Section>

      <Section i={6} title={t('Spaces where it runs')} text={t('Everywhere else the page, the agent and the work item action only say "not enabled". None picked = all spaces.')}>
        <div>
          <label className="field" htmlFor="ep">{t('Spaces')}</label>
          <Picker id="ep" multiple label={t('Spaces where it runs')} items={projectItems} value={s.enabledProjects || []} onChange={(v) => set('enabledProjects', v)}
            allLabel={t('All spaces')} searchPlaceholder={t('Search by key or name…')} emptyText={t('No space found')} />
        </div>
      </Section>

      <Section i={7} tour="cfg-guard" title={t('Guard rails')}
        text={t('Jira administrators change fields directly (the guard rails still apply); every change by a project admin is a request a Jira administrator approves, unless the option-change policy above lets them.')}>
        <div className="stack tight">
          <div className="row">
            <Check checked={s.safeMode} onChange={() => set('safeMode', !s.safeMode)}>{t('Safe mode')}</Check>
            {s.safeMode ? <Loz tone="red">{t('on')}</Loz> : null}
          </div>
          <div className="hint" style={{ marginTop: 0 }}>{s.safeMode
            ? t('Safe mode is on: every change becomes an approval request, nothing executes directly.')
            : t('Safe mode switches on by itself when the self-test fails or when changes come in unusually fast.')}</div>
        </div>
        <Num id="twoPersonThreshold" label={t('Two-person rule from (work items)')} value={s.twoPersonThreshold} onChange={(v) => set('twoPersonThreshold', v)} help={t('A change touching this many work items needs approval.')} />
        <Num id="autoSafeModeRate" label={t('Automatic safe mode above (changes per hour)')} value={s.autoSafeModeRate} onChange={(v) => set('autoSafeModeRate', v)} />
        <Num id="stage1MaxApprovers" label={t('Project admins asked per request (max.)')} value={s.stage1MaxApprovers} onChange={(v) => set('stage1MaxApprovers', v)} />
        {FEATURES.bulk ? <Check checked={s.policyAddsOnly} onChange={() => set('policyAddsOnly', !s.policyAddsOnly)}>{t('Bulk changes: adding an option to shared contexts needs no extra approval (no rename, no retire)')}</Check> : null}
        <div className="tile test-only">
          <span className="eyebrow">{t('TEST ONLY — leave empty in production')}</span>
          <UserPicker id="simulate" label={t('TEST ONLY: treat these users as non-admins')} value={s.simulateNonAdminIds} onChange={(v) => set('simulateNonAdminIds', v)} names={names} onName={onName}
            hint={t('Lets you try the non-admin flow (requests to the project admins) with your own account. Leave empty in production.')} />
          <UserPicker id="simulatepa" label={t('TEST ONLY: treat these Jira administrators as project admins only')} value={s.simulateProjectAdminIds || []} onChange={(v) => set('simulateProjectAdminIds', v)} names={names} onName={onName}
            hint={t('Lets a Jira administrator see the project admin view (every change becomes a request). Leave empty in production.')} />
        </div>
      </Section>

      <Section i={8} wide title={t('Guidelines for new fields')} text={t('What the guideline check holds every new field request to.')}>
        <div className="grid-auto">
          <Num id="nameMin" label={t('Name: min. characters')} value={s.rules.nameMin} onChange={(v) => setRule('nameMin', v)} />
          <Num id="nameMax" label={t('Name: max. characters')} value={s.rules.nameMax} onChange={(v) => setRule('nameMax', v)} />
          <Num id="maxOptions" label={t('Max. options')} value={s.rules.maxOptions} onChange={(v) => setRule('maxOptions', v)} />
          <Num id="maxOptionLength" label={t('Max. option length')} value={s.rules.maxOptionLength} onChange={(v) => setRule('maxOptionLength', v)} />
          <Num id="similarity" step="0.05" label={t('Similar names from')} value={s.rules.similarity} onChange={(v) => setRule('similarity', v)} help={t('Ratio 0.5–1, default 0.8')} />
        </div>
        <div>
          <label className="field" htmlFor="rn">{t('Reserved names')} <span className="muted">{t('(in addition to Jira\'s system fields)')}</span></label>
          <textarea id="rn" value={reserved} onChange={(e) => setRule('extraForbiddenNames', e.target.value)} />
          <div className="hint">{t('One per line.')}</div>
        </div>
        <div>
          <label className="field" htmlFor="cat">{t('Field catalogue')} <span className="muted">{t('(pre-approved standard fields)')}</span></label>
          <textarea id="cat" rows={6} value={s.catalogue || ''} onChange={(e) => set('catalogue', e.target.value)} placeholder="Name | type | option; option | description | field ID" />
          <div className="hint">{t('One entry per line: Name | type | option; option | description | field ID (optional). Type keys: select, multiselect, multicheckboxes, radiobuttons, textfield, textarea, float, datepicker, datetime, userpicker, labels. A request matching an entry is green; with a field ID the existing field is reused. The first space that creates a template entry fills in its field ID.')}</div>
        </div>
        <div className="stack tight">
          <h3>{t('Time saved')}</h3>
          <div className="grid-3">
            <Num id="minutesPerTicket" label={t('Minutes per manual ticket')} value={s.minutesPerTicket} onChange={(v) => set('minutesPerTicket', v)} />
            <Num id="minutesPerApproval" label={t('Minutes per approval')} value={s.minutesPerApproval} onChange={(v) => set('minutesPerApproval', v)} />
          </div>
        </div>
      </Section>

      {bar}
      <small>{t('Last saved {when}.', { when: when(state.settings.updatedAt) })}</small>
    </div>
  );
}
