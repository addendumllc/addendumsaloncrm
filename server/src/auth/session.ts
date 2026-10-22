import type { NextFunction, Request, Response } from 'express';
import type { CurrentUser, Role } from '@addendum/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { forbidden } from '../lib/errors.js';
import { apiAllowed, can, computeEffective } from './permissions.js';

export const SESSION_COOKIE = 'addendum_session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: CurrentUser;
      /** Set when this request comes from away from the salon with only some sections allowed (Location & Access). */
      away?: boolean;
    }
  }
}

export async function createSession(res: Response, staffId: string, userAgent?: string, method: 'password' | 'code' = 'password') {
  const token = randomToken(32);
  await db().query('DELETE FROM sessions WHERE staff_id = $1 AND expires_at < now()', [staffId]);
  const days = config().SESSION_DAYS;
  await db().query('INSERT INTO sessions(id, staff_id, expires_at, user_agent, auth_method) VALUES ($1,$2,$3,$4,$5)', [
    sha256(token), staffId, new Date(Date.now() + days * 86400_000), userAgent?.slice(0, 200) ?? null, method,
  ]);
  res.cookie(SESSION_COOKIE, token, cookieOptions(days * 86400_000));
}

/** Cookies are HttpOnly; when embedded in an iframe on HTTPS they must be SameSite=None + Secure. */
export function cookieOptions(maxAge?: number) {
  const secure = config().COOKIE_SECURE;
  return {
    httpOnly: true,
    secure,
    sameSite: (secure ? 'none' : 'lax') as 'none' | 'lax',
    path: '/',
    ...(maxAge ? { maxAge } : {}),
  };
}

export async function destroySession(req: Request, res: Response) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await db().query('DELETE FROM sessions WHERE id = $1', [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

export async function loadUser(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      // Permissions are read fresh on every request, so role or permission changes apply immediately.
      const row = await db().one<any>(
        `SELECT s.id, s.name, s.email, s.role, s.calendar_staff_ids, x.expires_at,
                ARRAY(SELECT permission FROM role_permissions rp WHERE rp.role = s.role) AS role_perms,
                COALESCE((SELECT json_agg(json_build_object('permission', o.permission, 'granted', o.granted))
                            FROM staff_permission_overrides o WHERE o.staff_id = s.id), '[]'::json) AS overrides
           FROM sessions x JOIN staff s ON s.id = x.staff_id
          WHERE x.id = $1 AND x.expires_at > now() AND s.active AND s.approval_status = 'approved'`,
        [sha256(token)],
      );
      if (row) {
        const overrides = typeof row.overrides === 'string' ? JSON.parse(row.overrides) : row.overrides;
        // Sliding sessions: someone who keeps using the app stays signed in (renewed at most once a day).
        const days = config().SESSION_DAYS;
        if (new Date(row.expires_at).getTime() - Date.now() < (days - 1) * 86400_000) {
          await db().query('UPDATE sessions SET expires_at = $2 WHERE id = $1', [sha256(token), new Date(Date.now() + days * 86400_000)]);
          res.cookie(SESSION_COOKIE, token, cookieOptions(days * 86400_000));
        }
        req.user = {
          id: row.id, name: row.name, email: row.email, role: row.role as Role, permissions: computeEffective(row.role_perms ?? [], overrides),
          calendarStaffIds: row.calendar_staff_ids ?? null,
        };
      }
    }
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: { code: 'unauthenticated', message: 'Please sign in to continue.' } });
  next();
}

/**
 * Deny-by-default gate in front of every API route: the path must be listed in API_RULES and the person must hold
 * one of its permissions. Routes then apply their own finer checks.
 */
export function apiGate(req: Request, _res: Response, next: NextFunction) {
  if (!apiAllowed(req.user, req.method, req.path)) return next(forbidden());
  next();
}

export const requirePermission = (permission: string) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user || !can(req.user, permission)) return next(forbidden());
  next();
};

export const requireAnyPermission = (...permissions: string[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user || !permissions.some((p) => can(req.user, p))) return next(forbidden());
  next();
};
