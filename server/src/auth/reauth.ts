import type { NextFunction, Request, Response } from 'express';
import { db } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, forbidden } from '../lib/errors.js';
import { can } from './permissions.js';
import { SESSION_COOKIE } from './session.js';

/** How long a password confirmation covers sensitive actions (changing integration credentials). */
export const REAUTH_MINUTES = 10;

export async function markReauthenticated(req: Request) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await db().query('UPDATE sessions SET reauthenticated_at = now() WHERE id = $1', [sha256(token)]);
}

async function recentlyConfirmed(req: Request) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return false;
  const r = await db().one<{ ok: boolean }>(
    `SELECT reauthenticated_at > now() - make_interval(mins => ${REAUTH_MINUTES}) AS ok FROM sessions WHERE id = $1`, [sha256(token)]);
  return !!r?.ok;
}

/**
 * Owner/Admin only (by role, so an individual grant can't hand it to someone else), holding `permission`, who confirmed
 * their password in the last few minutes. Checked on the server for every sensitive request.
 */
export const requireOwnerReauth = (permission: string) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    if (!req.user || req.user.role !== 'admin' || !can(req.user, permission)) return next(forbidden('Only an Owner or Admin can change integration credentials.'));
    if (!(await recentlyConfirmed(req))) return next(new AppError(403, 'Confirm your password to continue.', 'reauth_required'));
    next();
  } catch (e) {
    next(e);
  }
};
