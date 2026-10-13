import { Router } from 'express';
import { z } from 'zod';
import { can } from '../auth/permissions.js';
import { requireAnyPermission, requirePermission } from '../auth/session.js';
import { db } from '../db/index.js';
import {
  acceptEntry,
  addAdjustment,
  attributeEntry,
  commissionStatus,
  createRule,
  deleteRule,
  endRule,
  entriesCsv,
  entryHistory,
  finalizePeriod,
  listEntries,
  listPeriods,
  listRules,
  rebuildCommission,
  reviewQueue,
  summarize,
  syncCommission,
} from '../domain/commission.js';
import { newClientStats } from '../domain/newClients.js';
import { localDate } from '../domain/rebookingSchedule.js';
import { notFound } from '../lib/errors.js';
import { getSettings, updateSettings } from '../repos/settings.js';
import { ah, logAction, parse } from './util.js';

/**
 * Commission. Privacy is enforced here on the server:
 *  - /me only ever returns the signed-in person's own records (the id comes from the session, never the request).
 *  - Anyone else's numbers need commission:team; changes need commission:manage / commission:approve; CSV needs commission:export.
 */
export const commissionRouter = Router();

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)').refine((s) => !Number.isNaN(Date.parse(s)), 'must be a valid date');
const range = z.object({ from: ymd, to: ymd }).refine((r) => r.from <= r.to, 'the start date must be before the end date')
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86400_000 <= 400, 'choose a range of 400 days or less');

const seesTeam = (req: any) => can(req.user, 'commission:team');

commissionRouter.get('/status', ah(async (req, res) => {
  const st = await commissionStatus();
  // Team-level details (who isn't linked, sync messages) are for people who manage commission.
  if (!can(req.user, 'commission:manage') && !can(req.user, 'commission:approve') && !seesTeam(req)) {
    return res.json({ status: { enabled: st.enabled, squareConnected: st.squareConnected, lastSuccessfulSyncAt: st.lastSuccessfulSyncAt, lastRun: null, needsReview: 0, unlinkedTeamMembers: [], missing: [] } });
  }
  res.json({ status: st });
}));

// ---------- My Commission ----------
commissionRouter.get('/me', requirePermission('commission:own'), ah(async (req, res) => {
  const r = parse(range, req.query);
  const me = await db().one<any>('SELECT square_team_member_id FROM staff WHERE id = $1', [req.user!.id]);
  const entries = await listEntries({ staffId: req.user!.id, ...r });
  res.json({ summary: summarize(entries, r.from, r.to, req.user!.id), entries, squareLinked: !!me?.square_team_member_id });
}));

// New clients for My Commission: two counts, always for the signed-in person (no client names or details).
commissionRouter.get('/me/new-clients', requirePermission('commission:own'), ah(async (req, res) => {
  const r = parse(range, req.query);
  const { summary } = await newClientStats({ ...r, staffId: req.user!.id });
  res.json({ newClients: summary.newClients, rebookedFuture: summary.withFuture });
}));

// ---------- Team ----------
commissionRouter.get('/team', requirePermission('commission:team'), ah(async (req, res) => {
  const r = parse(range, req.query);
  const entries = await listEntries({ staffId: 'all', ...r });
  const staff = await db().query<any>('SELECT id, name, active, square_team_member_id FROM staff ORDER BY active DESC, name');
  const rows = staff.map((s) => ({
    ...summarize(entries.filter((e) => e.staffId === s.id), r.from, r.to, s.id), staffName: s.name, squareLinked: !!s.square_team_member_id, active: s.active,
  })).filter((x) => x.entries > 0 || (x.active && x.squareLinked));
  const unassigned = entries.filter((e) => !e.staffId);
  await logAction(req, 'commission.team_view', 'commission', null, r);
  res.json({ rows, total: summarize(entries.filter((e) => e.staffId), r.from, r.to, null), unassigned: unassigned.length });
}));

commissionRouter.get('/staff/:id', requireAnyPermission('commission:own', 'commission:team'), ah(async (req, res) => {
  const r = parse(range, req.query);
  // Your own page, or anyone's with team access. Otherwise it doesn't exist as far as you can tell.
  if (req.params.id !== req.user!.id && !seesTeam(req)) throw notFound('That page');
  const s = await db().one<any>('SELECT id, name, square_team_member_id FROM staff WHERE id = $1', [req.params.id]);
  if (!s) throw notFound('That team member');
  const entries = await listEntries({ staffId: s.id, ...r });
  if (req.params.id !== req.user!.id) await logAction(req, 'commission.staff_view', 'staff', s.id, r);
  res.json({ staff: { id: s.id, name: s.name, squareLinked: !!s.square_team_member_id }, summary: summarize(entries, r.from, r.to, s.id), entries });
}));

commissionRouter.get('/entries/:id/history', requireAnyPermission('commission:own', 'commission:team'), ah(async (req, res) => {
  const e = await db().one<any>('SELECT staff_id FROM commission_entries WHERE id = $1', [req.params.id]);
  if (!e || (e.staff_id !== req.user!.id && !seesTeam(req) && !can(req.user, 'commission:approve'))) throw notFound('That record');
  res.json({ history: await entryHistory(req.params.id) });
}));

commissionRouter.get('/export', requirePermission('commission:export'), ah(async (req, res) => {
  const r = parse(range.and(z.object({ staffId: z.string().uuid().optional() })), req.query);
  const entries = await listEntries({ staffId: r.staffId ?? 'all', from: r.from, to: r.to });
  await logAction(req, 'commission.export', 'commission', r.staffId ?? null, { from: r.from, to: r.to, rows: entries.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="commission-${r.from}-to-${r.to}.csv"`);
  res.send(entriesCsv(entries));
}));

// ---------- Settings & rules (administrators / designated managers) ----------
const manageOrTeam = requireAnyPermission('commission:manage', 'commission:team', 'commission:approve');

commissionRouter.get('/rules', manageOrTeam, ah(async (_req, res) => {
  res.json({ rules: await listRules(), settings: (await getSettings()).commission });
}));

commissionRouter.get('/options', manageOrTeam, ah(async (_req, res) => {
  res.json({
    staff: await db().query('SELECT id, name, role, active, square_team_member_id IS NOT NULL AS "squareLinked" FROM staff ORDER BY active DESC, name'),
    services: await db().query('SELECT id, name, price_cents AS "priceCents" FROM services ORDER BY name'),
    products: await db().query(`SELECT variation_id AS id, item_name || COALESCE(' — ' || variation_name, '') AS name, price_cents AS "priceCents"
      FROM square_inventory ORDER BY item_name, variation_name LIMIT 2000`),
  });
}));

const tier = z.object({ upToCents: z.number().int().positive().nullable(), rateBps: z.number().int().min(0).max(10000) });
const ruleInput = z.object({
  staffId: z.string().uuid().nullable().default(null),
  category: z.enum(['service', 'retail']),
  targetType: z.enum(['all', 'service', 'product']).default('all'),
  targetId: z.string().max(100).nullable().default(null),
  method: z.enum(['percent', 'flat', 'tiered']),
  rateBps: z.number().int().min(0).max(10000).nullable().default(null),
  flatCents: z.number().int().min(0).max(10_000_00).nullable().default(null),
  tiers: z.array(tier).max(10).nullable().default(null),
  tierPeriod: z.enum(['month', 'week']).default('month'),
  effectiveFrom: ymd,
  effectiveTo: ymd.nullable().default(null),
  note: z.string().trim().max(300).nullable().default(null),
});

commissionRouter.post('/rules', requirePermission('commission:manage'), ah(async (req, res) => {
  const b = parse(ruleInput, req.body);
  const id = await createRule(b, req.user!.id);
  await logAction(req, 'commission.rule_create', 'commission_rule', id, { ...b, tiers: b.tiers?.length ?? null });
  await rebuildCommission();
  res.status(201).json({ id, rules: await listRules() });
}));

commissionRouter.post('/rules/:id/end', requirePermission('commission:manage'), ah(async (req, res) => {
  const { endDate } = parse(z.object({ endDate: ymd }), req.body);
  await endRule(req.params.id, endDate, req.user!.id);
  await logAction(req, 'commission.rule_end', 'commission_rule', req.params.id, { endDate });
  await rebuildCommission();
  res.json({ rules: await listRules() });
}));

commissionRouter.delete('/rules/:id', requirePermission('commission:manage'), ah(async (req, res) => {
  await deleteRule(req.params.id);
  await logAction(req, 'commission.rule_delete', 'commission_rule', req.params.id);
  await rebuildCommission();
  res.json({ rules: await listRules() });
}));

const settingsInput = z.object({
  enabled: z.boolean(),
  autoSync: z.boolean(),
  syncIntervalMinutes: z.number().int().min(15).max(1440),
  syncStartDate: ymd.nullable(),
  basis: z.enum(['after_discounts', 'before_discounts']),
  refunds: z.enum(['reverse', 'ignore']),
  zeroPriced: z.enum(['no_commission', 'regular_price', 'review']),
  multiProvider: z.enum(['split_evenly', 'review']),
  productAttribution: z.enum(['appointment_provider', 'payment_team_member']),
  tips: z.enum(['separate', 'exclude']),
  tipAttribution: z.enum(['service_share', 'payment_team_member']),
}).partial();

commissionRouter.put('/settings', requirePermission('commission:manage'), ah(async (req, res) => {
  const b = parse(settingsInput, req.body);
  const s = await updateSettings({ commission: b });
  await logAction(req, 'commission.settings', 'settings', null, b);
  await rebuildCommission();
  res.json({ settings: s.commission });
}));

commissionRouter.post('/sync', requireAnyPermission('commission:manage', 'commission:approve'), ah(async (req, res) => {
  const runId = await syncCommission({ trigger: 'manual', staffId: req.user!.id });
  await logAction(req, 'commission.sync', 'commission', runId);
  res.json({ runId, status: await commissionStatus() });
}));

// ---------- Review, adjustments, finalizing ----------
commissionRouter.get('/review', requireAnyPermission('commission:approve', 'commission:manage'), ah(async (_req, res) => {
  res.json({ entries: await reviewQueue() });
}));

commissionRouter.post('/entries/:id/attribute', requirePermission('commission:approve'), ah(async (req, res) => {
  const b = parse(z.object({ staffIds: z.array(z.string().uuid()).max(5), note: z.string().trim().max(300).nullable().default(null) }), req.body);
  await attributeEntry(req.params.id, b.staffIds, b.note, req.user!.id);
  await logAction(req, 'commission.attribute', 'commission_entry', req.params.id, { staffIds: b.staffIds });
  res.json({ entries: await reviewQueue() });
}));

commissionRouter.post('/entries/:id/accept', requirePermission('commission:approve'), ah(async (req, res) => {
  const b = parse(z.object({ note: z.string().trim().max(300).nullable().default(null) }), req.body ?? {});
  await acceptEntry(req.params.id, b.note, req.user!.id);
  await logAction(req, 'commission.accept', 'commission_entry', req.params.id);
  res.json({ entries: await reviewQueue() });
}));

commissionRouter.post('/adjustments', requirePermission('commission:approve'), ah(async (req, res) => {
  const b = parse(z.object({
    staffId: z.string().uuid(),
    amountCents: z.number().int().min(-10_000_00).max(10_000_00).refine((v) => v !== 0, 'can’t be zero'),
    date: ymd,
    note: z.string().trim().min(3, 'explain the adjustment').max(300),
  }), req.body);
  const id = await addAdjustment(b, req.user!.id);
  await logAction(req, 'commission.adjustment', 'commission_entry', id, { staffId: b.staffId, amountCents: b.amountCents, date: b.date });
  res.status(201).json({ id });
}));

commissionRouter.get('/periods', requireAnyPermission('commission:approve', 'commission:team'), ah(async (_req, res) => {
  res.json({ periods: await listPeriods() });
}));

commissionRouter.post('/periods/finalize', requirePermission('commission:approve'), ah(async (req, res) => {
  const b = parse(z.object({ startDate: ymd, endDate: ymd, note: z.string().trim().max(300).nullable().default(null), confirm: z.literal(true, { errorMap: () => ({ message: 'please confirm — finalized commission can’t be changed' }) }), force: z.boolean().default(false) }), req.body);
  const out = await finalizePeriod(b, req.user!.id);
  await logAction(req, 'commission.finalize', 'commission_period', out.periodId, { startDate: b.startDate, endDate: b.endDate, records: out.finalized });
  res.json({ ...out, periods: await listPeriods() });
}));

/** Helper for the UI's date filters (salon time zone). */
commissionRouter.get('/today', ah(async (_req, res) => {
  res.json({ today: localDate(new Date(), (await getSettings()).business.timezone) });
}));

