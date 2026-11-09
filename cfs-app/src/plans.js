/**
 * Plan store for preview-then-execute: single-use, user-bound plans that expire after 15 minutes, the user's last
 * preview kept as a draft, and the project page's saved form drafts.
 *
 * @file        src/plans.js
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

// Preview-then-execute for Field Assistant. A preview action computes everything and stores the result as a plan;
// the only write action takes nothing but the plan ID. So the model can't change what the user saw and agreed to:
//   plan:<ID>     { kind, projectKey, accountId, input, fingerprint, summary, created, used }   15 minutes, single use
//   draft:<user>  the user's last preview, kept 7 days so a conversation can resume it
import { kvs } from '@forge/kvs';

export const PLAN_TTL = 15 * 60 * 1000;
const DRAFT_TTL = 7 * 24 * 3600 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const safeKey = (id) => String(id).replace(/[^a-zA-Z0-9:._#-]/g, '_');

const newId = () => `P-${Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('')}`;

export const savePlan = async ({ kind, projectKey, accountId, input, fingerprint = '', summary, expect = {} }) => {
  const id = newId();
  const plan = { id, kind, projectKey, accountId, input, fingerprint, summary, expect, created: Date.now(), used: false };
  await kvs.set(`plan:${id}`, plan);
  await kvs.set(`draft:${safeKey(accountId)}`, { planId: id, kind, projectKey, input, summary, at: plan.created });
  return plan;
};

export class PlanError extends Error {}

// Validates owner, expiry and single use, then marks the plan used. The caller re-checks the fingerprint.
export const takePlan = async (id, accountId) => {
  const ref = String(id || '').trim().toUpperCase();
  if (!/^P-[A-Z0-9]{6}$/.test(ref)) throw new PlanError(`"${id}" is not a plan ID. Run a preview first; it returns the plan ID.`);
  const plan = await kvs.get(`plan:${ref}`);
  if (!plan) throw new PlanError(`Plan ${ref} does not exist. Run the preview again.`);
  if (plan.accountId !== accountId) throw new PlanError(`Plan ${ref} belongs to another user. Nothing was changed.`);
  if (plan.used) throw new PlanError(`Plan ${ref} was already submitted (${new Date(plan.usedAt).toISOString().slice(11, 16)} UTC). Nothing was changed again.`);
  if (Date.now() - plan.created > PLAN_TTL) throw new PlanError(`Plan ${ref} expired after 15 minutes. Run the preview again.`);
  await kvs.set(`plan:${ref}`, { ...plan, used: true, usedAt: Date.now() });
  return plan;
};

export const getDraft = async (accountId) => {
  const d = await kvs.get(`draft:${safeKey(accountId)}`);
  if (!d || Date.now() - d.at > DRAFT_TTL) return null;
  return d;
};

export const clearDraft = (accountId) => kvs.delete(`draft:${safeKey(accountId)}`).catch(() => null);

// Form drafts of the settings page ("Request new field"), per user and project.
export const saveFormDraft = (accountId, projectKey, draft) => kvs.set(`uidraft:${safeKey(accountId)}:${projectKey}`, { draft, at: Date.now() });
export const getFormDraft = async (accountId, projectKey) => {
  const d = await kvs.get(`uidraft:${safeKey(accountId)}:${projectKey}`);
  return d && Date.now() - d.at < DRAFT_TTL ? d : null;
};
