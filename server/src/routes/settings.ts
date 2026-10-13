import { Router } from 'express';
import { z } from 'zod';
import { can } from '../auth/permissions.js';
import { requirePermission } from '../auth/session.js';
import { db } from '../db/index.js';
import { forbidden } from '../lib/errors.js';
import { listAudit } from '../repos/audit.js';
import { getSettings, updateSettings } from '../repos/settings.js';
import { listStaff } from '../repos/staff.js';
import { runRules } from '../domain/rulesEngine.js';
import { ah, logAction, parse } from './util.js';

export const settingsRouter = Router();

/** Everyone gets the business basics (salon name, booking link); full settings need settings:read. */
settingsRouter.get('/settings', ah(async (req, res) => {
  const s = await getSettings();
  if (!can(req.user, 'settings:read')) return res.json({ settings: { business: s.business, ai: { enabled: s.ai.enabled }, appearance: s.appearance, inventory: s.inventory }, limited: true });
  res.json({ settings: s });
}));

const RULES_SECTIONS = ['rules', 'reminders', 'reviews', 'notifications', 'ai', 'replies'];
const num = (min: number, max: number) => z.coerce.number().min(min).max(max);
const settingsPatch = z.object({
  business: z.object({
    name: z.string().max(100), address: z.string().max(300), phone: z.string().max(40), website: z.string().max(300),
    bookingUrl: z.string().max(300), reviewUrl: z.string().max(300), timezone: z.string().max(60), hours: z.string().max(300),
  }).partial().optional(),
  rules: z.object({
    newLeadHours: num(0, 168), leadNoResponseHours: num(1, 720), leadSecondNoResponseHours: num(1, 1440),
    cancellationEnabled: z.boolean(), cancellationDelayHours: num(0, 720), noShowEnabled: z.boolean(), noShowDelayHours: num(0, 720),
    reviewRequestEnabled: z.boolean(), reviewDelayHours: num(0, 720), rebookingEnabled: z.boolean(), rebookingGraceDays: num(0, 120),
    rebookingMinVisits: num(2, 20), unreadMessageMinutes: num(1, 1440),
  }).partial().optional(),
  reminders: z.object({ enabled: z.boolean(), offsetsHours: z.array(num(1, 336)).max(5), template: z.string().max(500) }).partial().optional(),
  reviews: z.object({ message: z.string().max(500) }).partial().optional(),
  ai: z.object({ enabled: z.boolean(), tone: z.string().max(300) }).partial().optional(),
  inventorySync: z.object({
    enabled: z.boolean(), intervalMinutes: num(5, 1440), firstSyncSource: z.enum(['square', 'shopify']), holdChangesOver: num(0, 100000),
  }).partial().optional(),
  replies: z.object({
    items: z.array(z.object({
      id: z.string().trim().min(1).max(64),
      title: z.string().trim().min(1, 'needs a name').max(80),
      body: z.string().trim().min(1, 'needs a message').max(1000),
      situations: z.array(z.enum(['new_lead', 'no_reply', 'booking', 'pricing', 'consultation', 'rebooking', 'cancellation', 'no_show', 'reschedule', 'reminder', 'confirmed', 'review', 'thanks', 'general'])).max(14),
    })).max(200),
  }).optional(),
  messaging: z.object({ autoCreateLeadFromUnknown: z.boolean(), quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/), quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/), signature: z.string().max(80) }).partial().optional(),
  notifications: z.object({ email: z.boolean(), sms: z.boolean(), browser: z.boolean(), notifyEmail: z.string().max(200) }).partial().optional(),
  highlevel: z.object({
    defaultAssigneeUserId: z.string().max(100).nullable(), autoCreateContacts: z.boolean(),
    automations: z.record(z.boolean()),
  }).partial().optional(),
  inventory: z.object({
    orderEmail: z.string().trim().email('must be an email address').max(200),
    ccRequester: z.boolean(),
    catalog: z.array(z.string().trim().min(1).max(120)).max(300),
  }).partial().optional(),
  appearance: z.object({ accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a colour like #6B3F55') }).partial().optional(),
  onboardingComplete: z.boolean().optional(),
});

/** Which permission opens each settings section (any one of them). */
function sectionPermissions(key: string): string[] {
  if (RULES_SECTIONS.includes(key)) return ['settings:rules'];
  if (key === 'highlevel') return ['integrations:manage'];
  if (key === 'inventorySync') return ['inventory:sync', 'settings:write'];
  return ['settings:write'];
}

settingsRouter.patch('/settings', ah(async (req, res) => {
  const patch = parse(settingsPatch, req.body);
  for (const key of Object.keys(patch)) if (!sectionPermissions(key).some((p) => can(req.user, p))) throw forbidden();
  const settings = await updateSettings(patch);
  await logAction(req, 'settings.update', 'settings', null, { sections: Object.keys(patch) });
  if (patch.rules || patch.reminders) await runRules();
  res.json({ settings });
}));

// ---------- Staff ----------
settingsRouter.get('/staff', requirePermission('staff:read'), ah(async (_req, res) => res.json({ staff: await listStaff() })));

/**
 * Team members and logins are managed manually (see docs/SETUP.md → "Team members & logins"),
 * so the API only allows the two display settings: calendar colour and HighLevel user mapping.
 */
const staffDisplayPatch = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a colour like #9A6B7F').optional(),
  highlevelUserId: z.string().max(100).optional().nullable(),
}).strict();

settingsRouter.patch('/staff/:id', requirePermission('users:manage'), ah(async (req, res) => {
  const b = parse(staffDisplayPatch, req.body);
  await db().query(
    `UPDATE staff SET color = COALESCE($2, color),
       highlevel_user_id = CASE WHEN $3::boolean THEN $4 ELSE highlevel_user_id END, updated_at = now() WHERE id = $1`,
    [req.params.id, b.color ?? null, b.highlevelUserId !== undefined, b.highlevelUserId ?? null],
  );
  await logAction(req, 'staff.update', 'staff', req.params.id, { fields: Object.keys(b) });
  res.json({ ok: true });
}));

// ---------- Tags ----------
settingsRouter.get('/tags', ah(async (_req, res) => {
  res.json({ tags: await db().query(`SELECT t.id, t.name, t.is_default AS "isDefault", count(ct.client_id)::int AS count FROM tags t LEFT JOIN client_tags ct ON ct.tag_id = t.id GROUP BY t.id ORDER BY t.is_default DESC, t.name`) });
}));
settingsRouter.post('/tags', requirePermission('clients:write'), ah(async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(40) }), req.body);
  await db().query('INSERT INTO tags(name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
  res.status(201).json({ ok: true });
}));
settingsRouter.delete('/tags/:id', requirePermission('settings:rules'), ah(async (req, res) => {
  await db().query('DELETE FROM tags WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Audit + privacy ----------
settingsRouter.get('/audit', requirePermission('audit:read'), ah(async (req, res) => {
  res.json({ entries: await listAudit(Math.min(Number(req.query.limit) || 100, 500), req.query.entityType as string, req.query.entityId as string) });
}));

/** Activity log as CSV (for people with audit:export). Details hold names and IDs only — never secrets. */
settingsRouter.get('/audit/export', requirePermission('audit:export'), ah(async (req, res) => {
  const rows = await listAudit(5000);
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['When,Who,Action,Record type,Record,Details',
    ...rows.map((r: any) => [r.createdAt, r.staffName, r.action, r.entityType, r.entityId, r.detail ? JSON.stringify(r.detail) : ''].map(esc).join(','))].join('\n');
  await logAction(req, 'audit.export', 'audit', null, { rows: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="activity-log.csv"');
  res.send(csv);
}));

/** Full data export (owner). Excludes secrets, password hashes and session data. */
settingsRouter.get('/privacy/export', requirePermission('privacy:export_all'), ah(async (req, res) => {
  const tables = ['clients', 'leads', 'appointments', 'appointment_services', 'tasks', 'notes', 'tags', 'client_tags', 'conversations', 'messages', 'services', 'locations'];
  const out: Record<string, unknown> = { exportedAt: new Date().toISOString() };
  for (const t of tables) out[t] = await db().query(`SELECT * FROM ${t}`);
  out.staff = await db().query('SELECT id, name, email, role, active, square_team_member_id, highlevel_user_id, created_at FROM staff');
  await logAction(req, 'privacy.export_all');
  res.setHeader('Content-Disposition', 'attachment; filename="addendum-salon-export.json"');
  res.json(out);
}));
