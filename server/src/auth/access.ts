import net from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { AWAY_SECTIONS, approvedNetworks, type AccessStatusDTO, type AwaySection, type CurrentUser } from '@addendum/shared';
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
  const away = !overridden && !s.allowAnywhere && configured && !onSalonNetwork && (!mobile || s.restrictMobile);
  // Per-person exceptions (permissions): the whole app anywhere, or chosen sections while away.
  const personalAnywhere = !!req.user && can(req.user, 'location:anywhere');
  const sections = away && !personalAnywhere && req.user ? awaySections(req.user) : [];
  const limited = sections.length ? sections : null;
  const restricted = away && !personalAnywhere && !limited;
  const canManage = canManageAccess(req.user);
  return {
    ip, mobile, onSalonNetwork, networkName: here?.name ?? null, allowAnywhere: s.allowAnywhere, configured, overridden, restricted, limited, personalAnywhere, canManage,
    ...(canManage ? { networks, restrictMobile: s.restrictMobile } : {}),
  };
}

// Reachable when blocked: signing in/out and who you are, the status itself, and the look of the app.
const OPEN: { method: string; path: RegExp }[] = [
  { method: '*', path: /^\/auth\// },
  { method: 'GET', path: /^\/access\/status$/ },
  { method: 'GET', path: /^\/settings$/ },
];

/** The away sections this person has, and can open at all with their other permissions. */
function awaySections(user: CurrentUser): AwaySection[] {
  return AWAY_SECTIONS.filter((s) => can(user, s.permission) && s.needsAnyOf.some((p) => can(user, p))).map((s) => s.key);
}

type Rule = { method: string; path: RegExp };
/** Any method on these API areas (and anything under them). Each route still checks the person's permissions. */
const under = (method: string, ...areas: string[]): Rule => ({ method, path: new RegExp(`^/(${areas.join('|')})(/.*)?$`) });

// Away from the salon: what each section needs. The app shell (notifications, team list…) works with any of them.
const AWAY_COMMON: Rule[] = [
  under('GET', 'me', 'notifications', 'updates', 'integrations', 'staff', 'services', 'look'),
  { method: 'PUT', path: /^\/look$/ },
  under('*', 'sidebar'),
  under('*', 'my-profile'),
  { method: 'POST', path: /^\/notifications\/read-all$/ },
];
const AWAY_API: Record<AwaySection, Rule[]> = {
  dashboard: [
    under('GET', 'dashboard', 'appointments', 'tasks', 'announcements', 'projections'),
    { method: 'POST', path: /^\/announcements\/([^/]+\/read|read-all)$/ },
    { method: 'POST', path: /^\/tasks\/[^/]+\/(complete|snooze|reopen|cancel|not-needed)$/ },
    { method: 'PATCH', path: /^\/tasks\/[^/]+$/ },
    { method: 'PUT', path: /^\/dashboard\/layout$/ },
  ],
  calendar: [under('*', 'appointments'), under('GET', 'rebooking'), { method: 'POST', path: /^\/integrations\/square\/sync$/ }],
  // Internal tasks and announcements only — client follow-ups stay at the salon (the tasks routes filter them out).
  // Addendum Hair's tasks are internal too.
  tasks: [under('*', 'tasks', 'announcements', 'hair')],
  clients: [under('*', 'clients', 'notes', 'leads', 'rebooking'), under('GET', 'tags', 'appointments', 'search', 'analytics/new-clients')],
  messages: [under('*', 'messages'), under('GET', 'clients', 'leads', 'tags')],
  orders: [under('*', 'inventory')],
  commission: [under('GET', 'commission/me', 'commission/status', 'commission/entries')],
};
// "Clock in from anywhere": the time clock itself works away from the approved networks, even where the rest of the
// app doesn't (the app shell's own reads come with it). Everyone else can only clock in or out on an approved network.
const CLOCK: Rule[] = [{ method: 'GET', path: /^\/timeclock\/me$/ }, { method: 'POST', path: /^\/timeclock\/(in|out|break|break\/end)$/ }];
const clockAnywhere = (req: Request) => !!req.user && can(req.user, 'timeclock:use') && can(req.user, 'timeclock:anywhere')
  && [...AWAY_COMMON, ...CLOCK].some((o) => (o.method === '*' || o.method === req.method) && o.path.test(req.path));

const allowedAway = (req: Request, sections: AwaySection[]) =>
  [...AWAY_COMMON, ...sections.flatMap((s) => AWAY_API[s])].some((o) => (o.method === '*' || o.method === req.method) && o.path.test(req.path));

/** Runs on every API request after the session is read. Signed-out requests are handled by the normal sign-in rules. */
export async function networkGate(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user || OPEN.some((o) => (o.method === '*' || o.method === req.method) && o.path.test(req.path))) return next();
    const st = await accessStatus(req);
    if (st.limited) {
      // Routes use this, e.g. away from the salon tasks are internal tasks only (no client follow-ups).
      req.away = true;
      if (allowedAway(req, st.limited) || clockAnywhere(req)) return next();
      const names = AWAY_SECTIONS.filter((s) => st.limited!.includes(s.key)).map((s) => s.label).join(', ');
      res.status(403).json({ error: { code: 'network_restricted', message: `Away from the salon you can only use: ${names}. Connect to an approved network (the salon or office) for the rest of the CRM.` } });
      return;
    }
    if (!st.restricted || clockAnywhere(req)) return next();
    res.status(403).json({ error: { code: 'network_restricted', message: 'The CRM on a computer only works on an approved network (the salon or office). Connect to one, or ask an Admin to turn on “Allow Access Anywhere”.' } });
  } catch (e) {
    next(e);
  }
}
