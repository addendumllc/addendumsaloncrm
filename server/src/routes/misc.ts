import { Router } from 'express';
import { z } from 'zod';
import { can } from '../auth/permissions.js';
import { requirePermission } from '../auth/session.js';
import { db } from '../db/index.js';
import { analytics } from '../domain/analytics.js';
import { productAnalytics } from '../domain/stock.js';
import { dashboard } from '../domain/dashboard.js';
import { newClientStats } from '../domain/newClients.js';
import { globalSearch } from '../domain/search.js';
import { integrationStatus } from '../integrations/registry.js';
import { iso } from '../lib/time.js';
import { calendarScope } from '../auth/scope.js';
import { dashboardWidgets } from '../domain/dashboardWidgets.js';
import { payUnlockState } from '../auth/reauth.js';
import { getKV, getSettings, setKV } from '../repos/settings.js';
import { toE164 } from '../lib/phone.js';
import { roleTemplates } from '../domain/users.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { DEFAULT_THEME_SETTINGS, themesFor, workspacesFor } from '@addendum/shared';
import { ah, logAction, parse } from './util.js';

export const miscRouter = Router();

/** Which page each dashboard link opens, so nobody is shown numbers or shortcuts for sections they can't open. */
const LINK_PERMS: [RegExp, string[]][] = [
  [/^\/messages/, ['messages:read']], [/^\/leads/, ['leads:read']], [/^\/(follow-ups|tasks)/, ['tasks:read_all', 'tasks:read_own']],
  [/^\/appointments/, ['appointments:read']], [/^\/clients/, ['clients:read', 'clients:read_assigned']],
];
const linkAllowed = (user: any, link: string) => LINK_PERMS.every(([re, perms]) => !re.test(link) || perms.some((p) => can(user, p)));

// My settings → Profile: each person's own mobile number (so the team can text them tasks). Name, email and role are
// changed by an administrator in Users & Permissions.
miscRouter.get('/my-profile', ah(async (req, res) => {
  const r = await db().one<any>('SELECT name, email, role, mobile_phone, color FROM staff WHERE id = $1', [req.user!.id]);
  const roleLabel = (await roleTemplates()).find((t) => t.role === r?.role)?.label ?? r?.role ?? '';
  res.json({ profile: { name: r?.name ?? '', email: r?.email ?? null, roleLabel, mobilePhone: r?.mobile_phone ?? null, color: r?.color ?? null } });
}));
miscRouter.patch('/my-profile', ah(async (req, res) => {
  // Their own mobile and/or their own colour (calendar and next to their name).
  const b = parse(z.object({ mobilePhone: z.string().trim().max(40).nullable().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }), req.body);
  if (b.mobilePhone !== undefined) {
    const mobile = b.mobilePhone ? toE164(b.mobilePhone) : null;
    if (b.mobilePhone && !mobile) throw badRequest("That mobile number doesn't look right.");
    await db().query('UPDATE staff SET mobile_phone = $2, updated_at = now() WHERE id = $1', [req.user!.id, mobile]);
  }
  if (b.color) await db().query('UPDATE staff SET color = $2, updated_at = now() WHERE id = $1', [req.user!.id, b.color.toUpperCase()]);
  await logAction(req, 'user.own_profile', 'staff', req.user!.id, { fields: Object.keys(b) });
  const r = await db().one<any>('SELECT mobile_phone, color FROM staff WHERE id = $1', [req.user!.id]);
  res.json({ profile: { mobilePhone: r?.mobile_phone ?? null, color: r?.color ?? null } });
}));

// Each person's own look (accent and light/dark) over the salon's. Saved to their account so it follows them.
const lookKey = (id: string) => `look:${id}`;
miscRouter.get('/look', ah(async (req, res) => {
  res.json({ look: { accent: null, mode: null, theme: null, workspace: null, ...((await getKV<object>(lookKey(req.user!.id))) ?? {}) } });
}));
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const scale = z.enum(['small', 'default', 'large', 'xlarge']);
const choice = z.object({ theme: z.string().regex(/^[a-z]{1,20}$/).nullable(), accent: hex.nullable(), accent2: hex.nullable(), highlight: hex.nullable() });
miscRouter.put('/look', ah(async (req, res) => {
  const b = parse(z.object({
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(), mode: z.enum(['light', 'dark', 'auto']).nullable().optional(),
    theme: z.string().regex(/^[a-z]{1,20}$/).nullable().optional(),
    // The business workspace they're in (remembered for next time): only one they're allowed to use.
    workspace: z.enum(['salon', 'hair']).nullable().optional(),
    // Their own colours: secondary accent and highlight, and (optionally) different colours in each business.
    accent2: hex.nullable().optional(), highlight: hex.nullable().optional(), perWorkspace: z.boolean().optional(),
    byWorkspace: z.object({ salon: choice, hair: choice }).partial().optional(),
    // Their theme and their own adjustments over it.
    themeId: z.string().regex(/^[a-z0-9-]{1,40}$/).nullable().optional(),
    custom: z.object({
      colors: z.object({ accent: hex, accent2: hex, background: hex, sidebar: hex, surface: hex, text: hex, line: hex }).partial(),
      type: z.object({ font: z.string().regex(/^[a-z0-9-]{1,40}$/), headingFont: z.string().regex(/^[a-z0-9-]{1,40}$/), base: scale, heading: scale, small: scale, weight: z.union([z.literal(400), z.literal(500)]) }).partial(),
      buttons: z.object({ size: z.enum(['small', 'default', 'large']), radius: z.enum(['square', 'soft', 'rounded']) }).partial(),
      sidebarOpacity: z.number().int().min(0).max(100),
    }).partial().optional(),
  }), req.body);
  if (b.workspace && !workspacesFor(req.user!.permissions).some((w) => w.id === b.workspace)) throw forbidden('You don’t have access to that business.');
  // Only a theme that's published for them (Settings → Theme Management).
  if (b.themeId) {
    const t = { ...DEFAULT_THEME_SETTINGS, ...((await getSettings()).appearance.themeSettings ?? {}) };
    if (!themesFor(t, req.user!.role).some((x) => x.id === b.themeId)) throw badRequest('That theme isn’t available to you.');
  }
  // Only the parts sent change (switching business keeps their accent and theme, and the other way round).
  const look = { accent: null, mode: null, theme: null, workspace: null, ...((await getKV<object>(lookKey(req.user!.id))) ?? {}), ...b };
  await setKV(lookKey(req.user!.id), look);
  res.json({ look });
}));

// Each person's own Dashboard and Analytics arrangement (drag to reorder, S/M/L/Full widths, hidden widgets).
// Only layout — never what they may see.
const widget = z.string().regex(/^[a-z_]{1,40}$/);
const layoutInput = z.object({ order: z.array(widget).max(40), sizes: z.record(widget, z.enum(['s', 'm', 'l', 'full'])), hidden: z.array(widget).max(40).optional() }).nullable();
for (const page of ['dashboard', 'analytics'] as const) {
  const key = (id: string) => `${page}-layout:${id}`;
  miscRouter.get(`/${page}/layout`, ah(async (req, res) => {
    res.json({ layout: (await getKV(key(req.user!.id))) ?? null });
  }));
  miscRouter.put(`/${page}/layout`, ah(async (req, res) => {
    const b = parse(layoutInput, req.body?.layout ?? null);
    await setKV(key(req.user!.id), b);
    res.json({ layout: b });
  }));
}

// Each person's own sidebar, for each business workspace (?workspace=salon|hair): the order of its items and the ones
// they've hidden. Only the layout — what they may open is still decided by their permissions. The salon's keeps the
// older key, so menus customized before workspaces existed carry over.
const sidebarKey = (id: string, ws: 'salon' | 'hair') => (ws === 'salon' ? `sidebar-layout:${id}` : `sidebar-layout:${id}:${ws}`);
const sidebarWs = (q: unknown) => parse(z.object({ workspace: z.enum(['salon', 'hair']).default('salon') }), q ?? {}).workspace;
miscRouter.get('/sidebar/layout', ah(async (req, res) => {
  res.json({ layout: (await getKV(sidebarKey(req.user!.id, sidebarWs(req.query)))) ?? null });
}));
miscRouter.put('/sidebar/layout', ah(async (req, res) => {
  const item = z.string().regex(/^\/[a-z-]*$/);
  const key = z.string().regex(/^[a-z0-9-]{1,30}$/);
  const b = parse(z.object({
    order: z.array(item).max(40), hidden: z.array(item).max(40), sections: z.record(item, key).optional(),
    // Their own section headings (renamed or new) and tab names.
    sectionList: z.array(z.object({ key, label: z.string().trim().min(1).max(30) })).max(15).optional(),
    labels: z.record(item, z.string().trim().min(1).max(30)).optional(),
  }).nullable(), req.body?.layout ?? null);
  await setKV(sidebarKey(req.user!.id, sidebarWs(req.query)), b);
  res.json({ layout: b });
}));

miscRouter.get('/dashboard', ah(async (req, res) => {
  const staffScope = can(req.user, 'tasks:read_all') ? null : req.user!.id;
  const d = await dashboard(staffScope);
  const summary: Record<string, number | null> = { ...d.summary };
  if (!can(req.user, 'messages:read')) summary.unreadMessages = null;
  if (!can(req.user, 'leads:read')) summary.newLeads = null;
  // Salon-wide appointment counts only for people who see every team calendar.
  const cal = calendarScope(req.user);
  if (!cal || !('all' in cal)) summary.appointmentsToday = summary.cancellations = summary.noShows = summary.pendingConfirmations = null;
  // Dashboard widgets (Settings → Role templates / a person's permissions): each needs its widget permission *and* the
  // permission for its data. What isn't allowed is left out here, on the server.
  const w = (k: string) => can(req.user, `dashboard:${k}`);
  if (!w('schedule')) summary.appointmentsToday = summary.cancellations = summary.noShows = summary.pendingConfirmations = null;
  if (!w('followups') || !w('priorities')) summary.followUpsDue = summary.overdueFollowUps = summary.readyToRebook = null;
  if (!w('clients')) summary.newLeads = summary.unreadMessages = null;
  // Recommended actions about messages and inquiries belong to "Clients and activity"; the rest to "Follow-ups and tasks".
  const widgetOf = (link: string) => (/^\/(messages|leads)/.test(link) ? 'clients' : 'followups');
  const actions = d.actions.filter((a: any) => linkAllowed(req.user, a.link) && w(widgetOf(a.link)));
  res.json({ summary, actions, integrations: await integrationStatus(), widgets: await dashboardWidgets(req.user!, (await payUnlockState(req)).unlocked) });
}));

miscRouter.get('/analytics', requirePermission('analytics:read'), ah(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 365);
  res.json(await analytics(days));
}));

/** Product sales (Square retail + Shopify), top sellers, monthly usage and stock value. */
miscRouter.get('/analytics/products', requirePermission('analytics:read'), ah(async (req, res) => {
  const p = String(req.query.period ?? '30');
  const store = (['square', 'shopify', 'shopify2', 'online'] as const).find((s) => s === req.query.store) ?? 'all';
  res.json(await productAnalytics(p === 'year' ? 'year' : Math.min(Math.max(Number(p) || 30, 7), 365), store));
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

/** Salon-wide alerts (staff_id NULL: new texts, Square, orders…) are for Dashboard users; everyone gets their own. */
const mineOrSalon = (req: any) => (can(req.user, 'dashboard:view') ? '(staff_id IS NULL OR staff_id = $1)' : 'staff_id = $1');

/** Lightweight polling endpoint for badges + browser notifications. */
miscRouter.get('/updates', ah(async (req, res) => {
  const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - 60_000);
  const unread = can(req.user, 'messages:read')
    ? await db().one<any>('SELECT COALESCE(sum(unread_count),0)::int AS n FROM conversations WHERE archived_at IS NULL')
    : { n: 0 };
  const notes = await db().query<any>(
    `SELECT id, kind, title, body, link, created_at FROM notifications
      WHERE ${mineOrSalon(req)} AND created_at > $2 ORDER BY created_at DESC LIMIT 10`,
    [req.user!.id, since],
  );
  const unreadNotifications = await db().one<any>(
    `SELECT count(*)::int AS n FROM notifications WHERE ${mineOrSalon(req)} AND read_at IS NULL`, [req.user!.id]);
  res.json({
    now: new Date().toISOString(),
    unreadMessages: unread.n,
    unreadNotifications: unreadNotifications.n,
    newNotifications: notes.map((n) => ({ ...n, createdAt: iso(n.created_at) })),
  });
}));

miscRouter.get('/notifications', ah(async (req, res) => {
  const rows = await db().query<any>(
    `SELECT id, kind, title, body, link, read_at, created_at FROM notifications WHERE ${mineOrSalon(req)} ORDER BY created_at DESC LIMIT 50`,
    [req.user!.id],
  );
  res.json({ notifications: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, read: !!n.read_at, createdAt: iso(n.created_at) })) });
}));

miscRouter.post('/notifications/read-all', ah(async (req, res) => {
  await db().query(`UPDATE notifications SET read_at = now() WHERE read_at IS NULL AND ${mineOrSalon(req)}`, [req.user!.id]);
  res.json({ ok: true });
}));

miscRouter.get('/services', ah(async (_req, res) => {
  res.json({ services: await db().query('SELECT id, name, duration_minutes AS "durationMinutes", price_cents AS "priceCents" FROM services ORDER BY name') });
}));
