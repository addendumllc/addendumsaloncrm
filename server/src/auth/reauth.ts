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

export async function recentlyConfirmed(req: Request) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return false;
  const r = await db().one<{ ok: boolean }>(
    `SELECT reauthenticated_at > now() - make_interval(mins => ${REAUTH_MINUTES}) AS ok FROM sessions WHERE id = $1`, [sha256(token)]);
  return !!r?.ok;
}

/** How long an Admin can keep pay unlocked on a device ("Keep pay unlocked for this session"). */
export const PAY_SESSION_HOURS = 4;

/** Keeps pay unlocked on this device for a working session (Admins only; checked by the caller). */
export async function extendPayUnlock(req: Request) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await db().query(`UPDATE sessions SET pay_unlocked_until = now() + make_interval(hours => ${PAY_SESSION_HOURS}) WHERE id = $1`, [sha256(token)]);
}

/** Locks pay again now (and the short password confirmation). */
export async function lockPay(req: Request) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await db().query('UPDATE sessions SET pay_unlocked_until = NULL, reauthenticated_at = NULL WHERE id = $1', [sha256(token)]);
}

/** Pay is open: password confirmed in the last few minutes, or an Admin kept it unlocked for the session. */
export async function payUnlockState(req: Request): Promise<{ unlocked: boolean; until: string | null }> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return { unlocked: false, until: null };
  const r = await db().one<{ recent: boolean; until: Date | null }>(
    `SELECT reauthenticated_at > now() - make_interval(mins => ${REAUTH_MINUTES}) AS recent,
            CASE WHEN pay_unlocked_until > now() THEN pay_unlocked_until END AS until FROM sessions WHERE id = $1`, [sha256(token)]);
  return { unlocked: !!r?.recent || !!r?.until, until: r?.until ? new Date(r.until).toISOString() : null };
}

/**
 * Pay (My Commission: commission, wages, taxes): the person re-entered their password (or sign-in code) in the last
 * few minutes on this device — or, for Admins, kept it unlocked for the session — so pay isn't on show on a shared screen.
 */
export const requirePayUnlock = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    if (!(await payUnlockState(req)).unlocked) return next(new AppError(403, 'Enter your password to see your pay.', 'reauth_required'));
    next();
  } catch (e) {
    next(e);
  }
};

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
