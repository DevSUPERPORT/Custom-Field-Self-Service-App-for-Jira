/**
 * Small pieces shared by the tabs of the admin control centre: project type names, check levels, a check line,
 * configuration sections and number inputs.
 *
 * @file        static/main/src/admin/common.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import React from 'react';
import { Loz } from '../ui';
import { t } from '../i18n';

export const PTYPE = { service_desk: 'Service management', business: 'Business', software: 'Software', product_discovery: 'Product Discovery' };
export const ptype = (k) => (PTYPE[k] ? t(PTYPE[k]) : k || '');

// The three levels of the approval space check and the site check.
export const LEVEL_TONE = { ok: 'green', warn: 'yellow', fail: 'red' };
const LEVEL_TEXT = { ok: 'OK', warn: 'CHECK', fail: 'FIX' };
export const RISK_TONE = { low: 'green', medium: 'yellow', high: 'red' };

// One line of a check: level, what was checked, what was found, and an optional action on the right.
export const CheckLine = ({ c, action, i = 0 }) => (
  <div className="check-line rise" style={{ '--i': i }}>
    <span><Loz tone={LEVEL_TONE[c.level]}>{t(LEVEL_TEXT[c.level] || c.level)}</Loz></span>
    <strong>{c.label}</strong>
    <span>{c.detail}</span>
    <span>{action || null}</span>
  </div>
);

// A configuration section: heading and explanation on the left, the controls on the right. "wide" puts the
// controls under the heading, for content that needs the whole width (selects side by side, check results).
export const Section = ({ title, text, children, wide = false, tour, i = 0 }) => (wide ? (
  <section className="card stack rise" style={{ '--i': i }} data-tour={tour}>
    <div className="stack tight"><h3>{title}</h3>{text ? <p className="muted">{text}</p> : null}</div>
    {children}
  </section>
) : (
  <section className="card cfg rise" style={{ '--i': i }} data-tour={tour}>
    <div><h3>{title}</h3>{text ? <p>{text}</p> : null}</div>
    <div className="stack">{children}</div>
  </section>
));

// A labelled number input; the value stays text while typing (the server clamps it on save).
export const Num = ({ id, label, value, onChange, help, step }) => (
  <div>
    <label className="field" htmlFor={id}>{label}</label>
    <input id={id} type="number" step={step} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    {help ? <div className="hint">{help}</div> : null}
  </div>
);

// A labelled checkbox with an optional hint under it.
export const Check = ({ checked, onChange, children, hint }) => (
  <label className="check top">
    <input type="checkbox" checked={!!checked} onChange={onChange} />
    <span>{children}{hint ? <div className="hint">{hint}</div> : null}</span>
  </label>
);
