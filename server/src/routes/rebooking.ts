import { Router } from 'express';
import { z } from 'zod';
import { can } from '../auth/permissions.js';
import { assertClientVisible, clientScope } from '../auth/scope.js';
import { requireAnyPermission, requirePermission } from '../auth/session.js';
import { db } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { setServiceNotNeeded,
  clientSchedules,
  computeSchedules,
  deleteClientOverride,
  deleteServiceRule,
  listServiceRules,
  saveClientOverride,
  saveServiceRule,
  syncRebookingTasks,
  validateRule,
} from '../domain/rebookingSchedule.js';
import { ah, logAction, parse } from './util.js';

/**
 * Rebooking schedules. Service defaults are admin-only; per-client custom schedules can be changed by anyone who
 * can edit clients. Every change re-checks the affected follow-ups straight away.
 */
export const rebookingRouter = Router();

const days = (max: number) => z.number().int().min(1).max(max);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)').refine((s) => !Number.isNaN(Date.parse(s)), 'must be a valid date');

async function assertService(id: string) {
  if (!z.string().uuid().safeParse(id).success || !(await db().one('SELECT 1 FROM services WHERE id = $1', [id]))) throw notFound('That service');
}
async function assertClient(id: string) {
  if (!z.string().uuid().safeParse(id).success || !(await db().one('SELECT 1 FROM clients WHERE id = $1', [id]))) throw notFound('That client');
}

// ---------- Service defaults ----------
rebookingRouter.get('/services', requireAnyPermission('clients:read', 'clients:read_assigned', 'rebooking:defaults'), ah(async (_req, res) => {
  res.json({ services: await listServiceRules() });
}));

const ruleInput = z.object({
  minDays: days(730).nullable().default(null),
  maxDays: days(730).nullable().default(null),
  targetDays: days(730),
  remindBeforeDays: z.number().int().min(0).max(120).default(7),
  autoFollowUp: z.boolean().default(true),
});

rebookingRouter.put('/services/:serviceId', requirePermission('rebooking:defaults'), ah(async (req, res) => {
  await assertService(req.params.serviceId);
  const b = parse(ruleInput, req.body);
  const problem = validateRule(b);
  if (problem) throw badRequest(problem);
  await saveServiceRule(req.params.serviceId, b, req.user!.id);
  await logAction(req, 'rebooking.service_default', 'service', req.params.serviceId, b);
  const followUps = await syncRebookingTasks();
  res.json({ services: await listServiceRules(), followUps });
}));

/** "No follow-up needed" for a service (add-ons): it still shows on clients, but never creates follow-ups. */
rebookingRouter.put('/services/:serviceId/not-needed', requirePermission('rebooking:defaults'), ah(async (req, res) => {
  await assertService(req.params.serviceId);
  const { notNeeded } = parse(z.object({ notNeeded: z.boolean() }), req.body);
  await setServiceNotNeeded(req.params.serviceId, notNeeded);
  await logAction(req, 'rebooking.service_not_needed', 'service', req.params.serviceId, { notNeeded });
  const followUps = await syncRebookingTasks();
  res.json({ services: await listServiceRules(), followUps });
}));

rebookingRouter.delete('/services/:serviceId', requirePermission('rebooking:defaults'), ah(async (req, res) => {
  await assertService(req.params.serviceId);
  await deleteServiceRule(req.params.serviceId);
  await logAction(req, 'rebooking.service_default_removed', 'service', req.params.serviceId);
  const followUps = await syncRebookingTasks();
  res.json({ services: await listServiceRules(), followUps });
}));

// ---------- One client's schedules ----------
rebookingRouter.get('/clients/:clientId', requireAnyPermission('clients:read', 'clients:read_assigned'), ah(async (req, res) => {
  await assertClientVisible(req.user, req.params.clientId);
  const services = await db().query('SELECT id, name FROM services ORDER BY lower(name)');
  res.json({ schedules: await clientSchedules(req.params.clientId), services });
}));

const overrideInput = z.object({
  intervalDays: days(730).nullable().default(null),
  preferredNextDate: ymd.nullable().default(null),
  lastVisitDate: ymd.nullable().default(null),
  remindBeforeDays: z.number().int().min(0).max(120).nullable().default(null),
  followUpsEnabled: z.boolean().nullable().default(null),
  note: z.string().trim().max(500).nullable().default(null).transform((v) => v || null),
});

rebookingRouter.put('/clients/:clientId/services/:serviceId', requirePermission('rebooking:client'), ah(async (req, res) => {
  const { clientId, serviceId } = req.params;
  await assertClientVisible(req.user, clientId);
  await assertService(serviceId);
  const b = parse(overrideInput, req.body);
  if (b.lastVisitDate && b.lastVisitDate > new Date().toISOString().slice(0, 10)) throw badRequest('The last visit date can’t be in the future.');
  if (b.intervalDays && b.remindBeforeDays != null && b.remindBeforeDays >= b.intervalDays) {
    throw badRequest('The reminder must come before the recommended date (fewer days than the interval).');
  }
  await saveClientOverride(clientId, serviceId, b, req.user!.id);
  await logAction(req, 'rebooking.client_schedule', 'client', clientId, { serviceId, ...b });
  const followUps = await syncRebookingTasks({ clientId });
  res.json({ schedules: await clientSchedules(clientId), followUps });
}));

rebookingRouter.delete('/clients/:clientId/services/:serviceId', requirePermission('rebooking:client'), ah(async (req, res) => {
  const { clientId, serviceId } = req.params;
  await assertClientVisible(req.user, clientId);
  await assertService(serviceId);
  await deleteClientOverride(clientId, serviceId);
  await logAction(req, 'rebooking.client_schedule_reset', 'client', clientId, { serviceId });
  const followUps = await syncRebookingTasks({ clientId });
  res.json({ schedules: await clientSchedules(clientId), followUps });
}));

// ---------- Everyone's upcoming recommended dates (Follow-Ups → Rebooking schedule) ----------
rebookingRouter.get('/schedule', requireAnyPermission('clients:read', 'clients:read_assigned'), ah(async (req, res) => {
  const q = parse(z.object({
    status: z.enum(['overdue', 'due_soon', 'upcoming', 'booked', 'off', 'not_needed', 'attention', 'all']).default('attention'),
    days: z.coerce.number().int().min(1).max(365).default(30),
    serviceId: z.string().uuid().optional(),
  }), req.query);
  let rows = await computeSchedules();
  const scope = clientScope(req.user);
  if (scope) {
    const mine = new Set((await db().query<{ id: string }>(
      `SELECT c.id FROM clients c WHERE c.preferred_staff_id = $1 OR EXISTS (SELECT 1 FROM client_staff cs WHERE cs.client_id = c.id AND cs.staff_id = $1)
          OR EXISTS (SELECT 1 FROM appointments a WHERE a.client_id = c.id AND a.staff_id = $1)`, [scope])).map((r) => r.id));
    rows = rows.filter((r) => mine.has(r.clientId));
  }
  if (q.serviceId) rows = rows.filter((r) => r.serviceId === q.serviceId);
  if (q.status === 'attention') rows = rows.filter((r) => r.status === 'overdue' || r.status === 'due_soon' || (r.status === 'upcoming' && (r.daysUntilNext ?? 999) <= q.days));
  else if (q.status !== 'all') rows = rows.filter((r) => r.status === q.status);
  rows = rows.slice(0, 500);
  const ids = [...new Set(rows.map((r) => r.clientId))];
  const clients = new Map((ids.length
    ? await db().query<any>("SELECT id, trim(first_name || ' ' || last_name) AS name, phone FROM clients WHERE id = ANY($1::uuid[])", [ids])
    : []).map((c) => [c.id, c]));
  const contact = can(req.user, 'clients:contact');
  res.json({ rows: rows.map((r) => ({ ...r, clientName: clients.get(r.clientId)?.name || 'Client', clientPhone: contact ? clients.get(r.clientId)?.phone ?? null : null })) });
}));
