/**
 * Language of the Custom UI: English or German from the person's Jira language or their own choice in the page
 * header, with t() and tn() for texts and plurals. Dates and numbers follow the same locale.
 *
 * @file        static/main/src/i18n.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// The English text is the key: t('Fields') shows "Felder" for German users and "Fields" for everyone else. A text
// with {placeholders} gets its values filled in. Messages from the server stay as they are (English).
import DE from './i18n.de';

let lang = 'en';
let locale = undefined;

// Called once at start with Jira's locale (e.g. "de_DE", "de-AT", "en_US").
// The switch in the page header overrides Jira's language for this person in this browser (no setting to change in
// the Atlassian account). Storage can be blocked: then the switch still works until the page is reloaded.
const CHOICE_KEY = 'cfs:lang';
const readChoice = () => {
  try { return window.localStorage.getItem(CHOICE_KEY); } catch (e) { return null; }
};
const apply = (l) => {
  lang = l;
  // Dates and numbers follow the chosen language too, unless it is the one Jira already gave.
  if (!new RegExp(`^${l}\\b`, 'i').test(locale || '')) locale = l === 'de' ? 'de-DE' : 'en-GB';
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
};

export const setLocale = (jiraLocale) => {
  const l = String(jiraLocale || (typeof navigator !== 'undefined' ? navigator.language : '') || 'en').replace('_', '-');
  locale = l;
  lang = /^de\b/i.test(l) ? 'de' : 'en';
  const chosen = readChoice();
  if (chosen === 'de' || chosen === 'en') apply(chosen);
  else if (typeof document !== 'undefined') document.documentElement.lang = lang;
};
export const getLang = () => lang;

// Switching: remembered, applied, and every listener (the page root) renders again.
const listeners = new Set();
export const onLangChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const chooseLang = (l) => {
  if (l !== 'de' && l !== 'en') return;
  try { window.localStorage.setItem(CHOICE_KEY, l); } catch (e) { /* not remembered, still switched */ }
  apply(l);
  listeners.forEach((fn) => fn(l));
};
export const getLocale = () => locale;

const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k]))) : s);

export const t = (s, vars) => fill(lang === 'de' && DE[s] !== undefined ? DE[s] : s, vars);

// Plurals: tn(3, '{n} option', '{n} options') -> "3 options" / "3 Optionen".
export const tn = (n, one, other, vars = {}) => t(n === 1 ? one : other, { n, ...vars });

export const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString(locale) : n);
