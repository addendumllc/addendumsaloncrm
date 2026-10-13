import { Router } from 'express';
import { z } from 'zod';
import { can } from '../auth/permissions.js';
import { requirePermission } from '../auth/session.js';
import { db } from '../db/index.js';
import { analytics } from '../domain/analytics.js';
import { dashboard } from '../domain/dashboard.js';
import { newClientStats } from '../domain/newClients.js';
import { globalSearch } from '../domain/search.js';
import { integrationStatus } from '../integrations/registry.js';
import { iso } from '../lib/time.js';
import { calendarScope } from '../auth/scope.js';
import { ah, parse } from './util.js';

export const miscRouter = Router();

/** Which page each dashboard link opens, so nobody is shown numbers or shortcuts for sections they can't open. */
const LINK_PERMS: [RegExp, string[]][] = [
  [/^\/messages/, ['messages:read']], [/^\/leads/, ['leads:read']], [/^\/(follow-ups|tasks)/, ['tasks:read_all', 'tasks:read_own']],
  [/^\/appointments/, ['appointments:read']], [/^\/clients/, ['clients:read', 'clients:read_assigned']],
];
const linkAllowed = (user: any, link: string) => LINK_PERMS.every(([re, perms]) => !re.test(link) || perms.some((p) => can(user, p)));

miscRouter.get('/dashboard', ah(async (req, res) => {
  const staffScope = can(req.user, 'tasks:read_all') ? null : req.user!.id;
  const d = await dashboard(staffScope);
  const summary: Record<string, number | null> = { ...d.summary };
  if (!can(req.user, 'messages:read')) summary.unreadMessages = null;
  if (!can(req.user, 'leads:read')) summary.newLeads = null;
  // Salon-wide appointment counts only for people who see every team calendar.
  const cal = calendarScope(req.user);
  if (!cal || !('all' in cal)) summary.appointmentsToday = summary.cancellations = summary.noShows = summary.pendingConfirmations = null;
  res.json({ summary, actions: d.actions.filter((a: any) => linkAllowed(req.user, a.link)), integrations: await integrationStatus() });
}));

miscRouter.get('/analytics', requirePermission('analytics:read'), ah(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 365);
  res.json(await analytics(days));
}));

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)').refine((x) => !Number.isNaN(Date.parse(x)), 'must be a valid date');
const newClientQuery = z.object({ from: ymd, to: ymd, staffId: z.string().uuid().optional() })
  .refine((r) => r.from <= r.to, 'the start date must be before the end date')
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86400_000 <= 800, 'choose a range of 800 days or less');

/** New clients & rebooking for owners/admins: business-wide, with client-level detail. */
miscRouter.get('/analytics/new-clients', requirePermission('analytics:read'), ah(async (req, res) => {
  const q = parse(newClientQuery, req.query);
  res.json(await newClientStats({ from: q.from, to: q.to, staffId: q.staffId ?? null }));
}));

miscRouter.get('/search', ah(async (req, res) => {
  res.json(await globalSearch(String(req.query.q ?? '').slice(0, 100), req.user!));
}));

/** Lightweight polling endpoint for badges + browser notifications. */
miscRouter.get('/updates', ah(async (req, res) => {
  const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - 60_000);
  const unread = can(req.user, 'messages:read')
    ? await db().one<any>('SELECT COALESCE(sum(unread_count),0)::int AS n FROM conversations WHERE archived_at IS NULL')
    : { n: 0 };
  const notes = await db().query<any>(
    `SELECT id, kind, title, body, link, created_at FROM notifications
      WHERE (staff_id IS NULL OR staff_id = $1) AND created_at > $2 ORDER BY created_at DESC LIMIT 10`,
    [req.user!.id, since],
  );
  const unreadNotifications = await db().one<any>(
    'SELECT count(*)::int AS n FROM notifications WHERE (staff_id IS NULL OR staff_id = $1) AND read_at IS NULL', [req.user!.id]);
  res.json({
    now: new Date().toISOString(),
    unreadMessages: unread.n,
    unreadNotifications: unreadNotifications.n,
    newNotifications: notes.map((n) => ({ ...n, createdAt: iso(n.created_at) })),
  });
}));

miscRouter.get('/notifications', ah(async (req, res) => {
  const rows = await db().query<any>(
    `SELECT id, kind, title, body, link, read_at, created_at FROM notifications WHERE staff_id IS NULL OR staff_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user!.id],
  );
  res.json({ notifications: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, read: !!n.read_at, createdAt: iso(n.created_at) })) });
}));

miscRouter.post('/notifications/read-all', ah(async (req, res) => {
  await db().query('UPDATE notifications SET read_at = now() WHERE read_at IS NULL AND (staff_id IS NULL OR staff_id = $1)', [req.user!.id]);
  res.json({ ok: true });
}));

miscRouter.get('/services', ah(async (_req, res) => {
  res.json({ services: await db().query('SELECT id, name, duration_minutes AS "durationMinutes", price_cents AS "priceCents" FROM services ORDER BY name') });
}));
