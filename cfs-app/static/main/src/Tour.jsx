/**
 * Spotlight tour over the real page: a highlight moves from area to area with a card that explains it, shown once per
 * user; the project page's chapters depend on the role and the site's settings.
 *
 * @file        static/main/src/Tour.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Every user sees the tour once (stored per user); the Tour button opens it again. Each step points at the real
// element (data-tour="..."), switches to its tab first when needed, and the card follows the highlight.
import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Icon, Mark } from './ui';
import { t } from './i18n';
import { FEATURES } from '../../../src/shared/features.js';

const PAD = 8;
const CARD_W = 400;

const rectOf = (selector) => {
  const el = selector ? document.querySelector(selector) : null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  return { el, top: r.top + window.scrollY - PAD, left: r.left + window.scrollX - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
};

// steps: [{ target?: CSS selector, title, body, list?: string[], tab?: string }]
export function SpotlightTour({ steps, onClose, onStep }) {
  const [i, setI] = useState(0);
  const [box, setBox] = useState(null);
  const [docH, setDocH] = useState(0);
  const step = steps[Math.min(i, steps.length - 1)];
  const last = i >= steps.length - 1;

  const place = useCallback(() => {
    setDocH(document.documentElement.scrollHeight);
    setBox(rectOf(step.target));
  }, [step]);

  useEffect(() => { if (onStep) onStep(step); }, [i]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    // The step's tab renders first, then the highlight finds its element.
    const timer = setTimeout(() => {
      place();
      const r = rectOf(step.target);
      if (r) r.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 90);
    return () => clearTimeout(timer);
  }, [i, place]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    window.addEventListener('resize', place);
    const k = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((x) => Math.min(x + 1, steps.length - 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(x - 1, 0));
    };
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('keydown', k); };
  }, [place, onClose, steps.length]);

  const vw = document.documentElement.clientWidth;
  const w = Math.min(CARD_W, vw - 32);
  let cardTop = 64 + window.scrollY;
  let cardLeft = Math.max(16, (vw - w) / 2);
  if (box) {
    cardTop = box.top + box.height + 14;
    cardLeft = Math.min(Math.max(16, box.left), vw - w - 16);
    if (box.top + box.height + 300 > docH && box.top > 320) cardTop = Math.max(16, box.top - 14 - 300);
  }

  return (
    <div className="tour-layer" style={{ height: docH || '100%', pointerEvents: 'auto' }} role="dialog" aria-modal="true" aria-label={step.title}>
      <div className={`tour-spot ${box ? '' : 'none'}`} style={box ? { top: box.top, left: box.left, width: box.width, height: box.height } : { top: cardTop, left: cardLeft, width: 0, height: 0 }} />
      <div className="tour-card" style={{ top: cardTop, left: cardLeft, width: w }}>
        <div className="tour-progress" aria-hidden="true">{steps.map((s, k) => <i key={k} className={k <= i ? 'on' : ''} />)}</div>
        <div className="tour-body" key={i}>
          {i === 0 ? <Mark /> : null}
          <span className="eyebrow">{t('Step {n} of {total}', { n: i + 1, total: steps.length })}</span>
          <h2>{step.title}</h2>
          {step.body ? <p>{step.body}</p> : null}
          {step.list?.length ? <ul>{step.list.map((l) => <li key={l}><Icon name="check" /><span>{l}</span></li>)}</ul> : null}
        </div>
        <footer>
          {!last ? <button type="button" className="btn ghost small" onClick={onClose}>{t('Skip tour')}</button> : null}
          <span className="grow" />
          {i > 0 ? <button type="button" className="btn line small" onClick={() => setI(i - 1)}><Icon name="left" />{t('Back')}</button> : null}
          {last
            ? <button type="button" className="btn primary small" onClick={onClose}>{t('Get started')}</button>
            : <button type="button" className="btn primary small" autoFocus onClick={() => setI(i + 1)}>{t('Next')}<Icon name="right" /></button>}
        </footer>
      </div>
    </div>
  );
}

// The project page's tour, as the person will actually use the page: role, the site's option policy, the limit.
const projectSteps = ({ role, approver, policy }) => {
  const admin = role === 'jira-admin';
  const direct = policy?.optionEdits === 'direct';
  const max = policy?.maxContextProjects || 10;
  return [
    {
      title: t('Welcome to Custom Field Self-Service for Jira'),
      body: admin
        ? t('You are a Jira administrator: you manage the custom fields of this space directly. Every change is logged and can be undone.')
        : t('Keep the fields of your space tidy without a ticket: see every field, maintain options, request new fields. A Jira administrator approves what affects others.'),
    },
    {
      target: '[data-tour="tab-fields"]', tab: 'fields',
      title: t('Your fields at a glance'),
      body: t('Every field this space uses: system fields, global fields and custom fields whose context includes this space.'),
      list: [
        t('Only this space: the context belongs to this space alone.'),
        t('Multiple: several spaces share the context and its options.'),
        t('Global and System: the same everywhere, read-only here.'),
        t('Search by name or ID, filter by scope or "Editable".'),
      ],
    },
    {
      target: '[data-tour="field-table"]', tab: 'fields',
      title: t('Open any field'),
      body: admin
        ? t('Rename it, change its spaces and screens, or take it out of use. For dropdown fields you edit the options right there.')
        : direct
          ? t('See where it is used. Options of fields only this space uses you change yourself; for shared fields you send a request.')
          : t('See where it is used and prepare option changes; a Jira administrator approves them and the app carries them out.'),
      list: [
        t('Drag to reorder, or sort A–Z / Z–A once.'),
        t('Add options one at a time or paste a whole list: duplicates are skipped.'),
        t('Exactly one default value. Options are never deleted, only disabled.'),
        t('Renaming warns you: filters and automations with the old name can break.'),
      ],
    },
    {
      target: '[data-tour="cta"]',
      title: admin ? t('Add a new field') : t('Request a new field'),
      body: admin ? t('Three steps, created at once when you confirm.') : t('Three steps; a Jira administrator approves, then the app creates everything.'),
      list: [
        t('Field: name, description, type, options and one default. Similar existing fields are flagged.'),
        t('Context: your space plus up to {n} spaces you can see in all, and the issue types.', { n: max }),
        t('Screens: only the ones this space uses alone. The admins of the other spaces are told to add it to theirs.'),
      ],
    },
    {
      target: '[data-tour="tab-requests"]', tab: 'requests',
      title: t('My requests'),
      body: t('Everything you asked for, with its status: Waiting for approval, Done, Fail, Rejected (with the reason) or Withdrawn. Withdraw an open request any time; to change it, send a new one.'),
    },
    {
      target: '[data-tour="tab-inbox"]', tab: 'inbox',
      title: t('Requests for you'),
      body: approver || admin
        ? t('Requests waiting for your decision. A rejection always needs a reason; nobody approves their own request.')
        : t('Requests waiting for your decision, and new fields approved for this space that still need to go on your screens: one click adds them.'),
    },
    {
      target: '[data-tour="tab-audit"]', tab: 'audit',
      title: t('Audit log'),
      body: admin
        ? t('Who changed what and when, with the old and new value and the approver. Entries can\'t be changed. Undo any change from here.')
        : t('Who changed what and when, with the old and new value and the approver. Entries can\'t be changed.'),
    },
    ...(admin && FEATURES.bulk ? [{
      target: '[data-tour="tab-bulk"]', tab: 'bulk',
      title: t('Bulk changes'),
      body: t('One option change across many fields at once: retire, replace in the work items, rename, add or restore. Preview first, one-click undo after.'),
    }] : []),
    {
      target: '[data-tour="assistant"]',
      title: t('Field Assistant'),
      body: t('Prefer to ask? Describe what you need in plain words; the assistant previews every change and runs it only after you confirm, with the same rights you have here.'),
    },
    {
      target: '[data-tour="live"]', tab: 'fields',
      title: t('Always up to date'),
      body: t('The page updates by itself when something changes, and refreshes every minute and whenever you open a tab. The Tour button brings this tour back.'),
    },
  ];
};

export default function Tour({ role, approver, policy, onClose, onGo }) {
  return <SpotlightTour steps={projectSteps({ role, approver, policy })} onClose={onClose} onStep={(s) => { if (s.tab && onGo) onGo(s.tab); }} />;
}
