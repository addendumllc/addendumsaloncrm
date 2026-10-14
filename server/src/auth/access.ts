import net from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { approvedNetworks, type AccessStatusDTO, type CurrentUser } from '@addendum/shared';
import { config } from '../config.js';
import { getSettings } from '../repos/settings.js';
import { can } from './permissions.js';

/**
 * Location & Access: desktop browsers may only use the CRM from the salon's internet connection, unless
 * "Allow Access Anywhere" is on. This is an extra condition on top of signing in — it never grants or removes
 * permissions, and nobody gets more access for being at the salon.
 *
 * The IP is the one the server sees (Express `req.ip`, honouring only the proxies trusted by TRUST_PROXY), never a
 * value the browser sends. Whether a device is a phone/tablet comes from what the browser reports, which a determined
 * user can fake; turn on "restrict phones and tablets too" for IP-only control.
 */
export const normalizeIp = (ip: string | null | undefined) => {
  let s = (ip ?? '').trim().toLowerCase();
  if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
  return s;
};

export function isMobileRequest(req: Request) {
  if (req.get('sec-ch-ua-mobile') === '?1') return true;
  if (/Mobi|Android|iPhone|iPod|iPad/i.test(req.get('user-agent') ?? '')) return true;
  // iPads report a desktop browser; the app marks touch-first devices.
  return req.get('x-addendum-device') === 'touch';
}

/** Owners/Admins only (role-based, so an individual grant can't hand it to someone else). */
export const canManageAccess = (user: Pick<CurrentUser, 'role' | 'permissions'> | null | undefined) =>
  !!user && user.role === 'admin' && can(user, 'settings:write');

export async function accessStatus(req: Request): Promise<AccessStatusDTO> {
  const s = (await getSettings()).access;
  const ip = normalizeIp(req.ip);
  const mobile = isMobileRequest(req);
  const networks = approvedNetworks(s);
  const configured = networks.length > 0;
  const overridden = config().ACCESS_ALLOW_ANYWHERE;
  const here = networks.find((n) => normalizeIp(n.ip) === ip) ?? null;
  const onSalonNetwork = !!here;
  const restricted = !overridden && !s.allowAnywhere && configured && !onSalonNetwork && (!mobile || s.restrictMobile);
  const canManage = canManageAccess(req.user);
  return {
    ip, mobile, onSalonNetwork, networkName: here?.name ?? null, allowAnywhere: s.allowAnywhere, configured, overridden, restricted, canManage,
    ...(canManage ? { networks, restrictMobile: s.restrictMobile } : {}),
  };
}

// Reachable when blocked: signing in/out and who you are, the status itself, and the look of the app.
const OPEN: { method: string; path: RegExp }[] = [
  { method: '*', path: /^\/auth\// },
  { method: 'GET', path: /^\/access\/status$/ },
  { method: 'GET', path: /^\/settings$/ },
];

/** Runs on every API request after the session is read. Signed-out requests are handled by the normal sign-in rules. */
export async function networkGate(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user || OPEN.some((o) => (o.method === '*' || o.method === req.method) && o.path.test(req.path))) return next();
    if (!(await accessStatus(req)).restricted) return next();
    res.status(403).json({ error: { code: 'network_restricted', message: 'The CRM on a computer only works on an approved network (the salon or office). Connect to one, or ask an Admin to turn on “Allow Access Anywhere”.' } });
  } catch (e) {
    next(e);
  }
}
