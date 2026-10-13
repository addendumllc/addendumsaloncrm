import { Router } from 'express';
import { z } from 'zod';
import { can } from '../auth/permissions.js';
import { requirePermission } from '../auth/session.js';
import { db } from '../db/index.js';
import type { TaskDTO } from '@addendum/shared';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { dayBounds } from '../lib/time.js';
import { pushTaskToHighLevel, syncCompletionToHighLevel } from '../domain/highlevelPush.js';
import { completeTask, createTask, getTask, listTasks } from '../domain/tasks.js';
import { getSettings } from '../repos/settings.js';
import { ah, isoDate, logAction, optionalText, parse } from './util.js';

export const tasksRouter = Router();

const TYPES = ['follow_up', 'call', 'text', 'rebook', 'appointment_reminder', 'consultation', 'no_show', 'cancellation', 'review_request', 'new_lead', 'reply', 'internal'] as const;

tasksRouter.get('/', ah(async (req, res) => {
  const q = req.query as Record<string, string>;
  const s = await getSettings();
  const { end } = dayBounds(new Date(), s.business.timezone);
  // Staff see their own follow-ups plus unassigned ones; managers/owners see everything.
  const allowAll = can(req.user, 'tasks:read_all');
  let tasks = await listTasks({
    status: q.status, kind: q.kind as any, type: q.type, priority: q.priority, due: q.due as any, q: q.q,
    assignedStaffId: allowAll ? q.staffId : undefined, clientId: q.clientId, leadId: q.leadId,
    hlStatus: q.hl === 'failed' ? undefined : q.hl,
  }, end);
  if (q.hl === 'failed') tasks = tasks.filter((t) => t.highlevel.status === 'failed' || t.highlevel.status === 'needs_contact');
  if (!allowAll) tasks = tasks.filter((t) => !t.assignedStaffId || t.assignedStaffId === req.user!.id);
  res.json({ tasks: tasks.map((t) => hideContact(req, t)) });
}));

/** Phone numbers only for people who may see contact details. */
const hideContact = (req: any, t: TaskDTO): TaskDTO => (can(req.user, 'clients:contact') ? t : { ...t, contactPhone: null });

tasksRouter.get('/:id', ah(async (req, res) => {
  const task = await getTask(req.params.id);
  if (!can(req.user, 'tasks:read_all') && task.assignedStaffId && task.assignedStaffId !== req.user!.id) throw notFound('That follow-up');
  res.json({ task: hideContact(req, task) });
}));

const taskInput = z.object({
  kind: z.enum(['follow_up', 'task']).default('follow_up'),
  type: z.enum(TYPES).default('follow_up'),
  title: z.string().trim().min(1, 'is required').max(200),
  reason: optionalText(1000),
  notes: optionalText(4000),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  dueAt: isoDate,
  clientId: z.string().uuid().optional().nullable(),
  leadId: z.string().uuid().optional().nullable(),
  assignedStaffId: z.string().uuid().optional().nullable(),
  pushToHighLevel: z.boolean().optional(),
});

tasksRouter.post('/', requirePermission('tasks:write'), ah(async (req, res) => {
  const b = parse(taskInput, req.body);
  if (b.kind === 'follow_up' && !b.clientId && !b.leadId) throw badRequest('Choose the client or lead this follow-up is for.');
  const id = await createTask({ ...b, dueAt: new Date(b.dueAt), createdBy: req.user!.id });
  await logAction(req, 'task.create', 'task', id);
  let highlevel = null;
  if (b.pushToHighLevel && id) highlevel = await pushTaskToHighLevel(id, { createContactIfMissing: false });
  res.status(201).json({ id, highlevel });
}));

async function assertCanEdit(req: any, id: string) {
  if (can(req.user, 'tasks:read_all')) return;
  const t = await db().one<any>('SELECT assigned_staff_id FROM tasks WHERE id = $1', [id]);
  if (t?.assigned_staff_id && t.assigned_staff_id !== req.user.id) throw forbidden();
}

tasksRouter.patch('/:id', requirePermission('tasks:write'), ah(async (req, res) => {
  await assertCanEdit(req, req.params.id);
  const b = parse(z.object({
    title: z.string().trim().min(1).max(200).optional(),
    notes: optionalText(4000),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    dueAt: isoDate.optional(),
    assignedStaffId: z.string().uuid().nullable().optional(),
    type: z.enum(TYPES).optional(),
  }), req.body);
  if (b.assignedStaffId !== undefined && !can(req.user, 'tasks:assign') && b.assignedStaffId !== req.user!.id) throw forbidden();
  await db().query(
    `UPDATE tasks SET title = COALESCE($2, title), notes = CASE WHEN $3::boolean THEN $4 ELSE notes END, priority = COALESCE($5, priority),
       due_at = COALESCE($6, due_at), assigned_staff_id = CASE WHEN $7::boolean THEN $8::uuid ELSE assigned_staff_id END, type = COALESCE($9, type),
       status = CASE WHEN $6::timestamptz IS NOT NULL AND status = 'snoozed' THEN 'due' ELSE status END,
       hl_status = CASE WHEN hl_status = 'synced' THEN 'pending' ELSE hl_status END,
       hl_next_retry_at = CASE WHEN hl_status = 'synced' THEN now() ELSE hl_next_retry_at END,
       updated_at = now()
     WHERE id = $1`,
    [req.params.id, b.title ?? null, b.notes !== undefined, b.notes ?? null, b.priority ?? null, b.dueAt ? new Date(b.dueAt) : null,
      b.assignedStaffId !== undefined, b.assignedStaffId ?? null, b.type ?? null],
  );
  await logAction(req, 'task.update', 'task', req.params.id, { fields: Object.keys(b) });
  res.json({ task: await getTask(req.params.id) });
}));

tasksRouter.post('/:id/complete', requirePermission('tasks:write'), ah(async (req, res) => {
  await assertCanEdit(req, req.params.id);
  const { note } = parse(z.object({ note: optionalText(1000) }), req.body ?? {});
  await completeTask(req.params.id, req.user!.id, note ?? undefined);
  await syncCompletionToHighLevel(req.params.id, true);
  await logAction(req, 'task.complete', 'task', req.params.id);
  res.json({ task: await getTask(req.params.id) });
}));

tasksRouter.post('/:id/snooze', requirePermission('tasks:write'), ah(async (req, res) => {
  await assertCanEdit(req, req.params.id);
  const { until } = parse(z.object({ until: isoDate }), req.body);
  await db().query(`UPDATE tasks SET status = 'snoozed', snoozed_until = $2, due_at = $2, updated_at = now() WHERE id = $1`, [req.params.id, new Date(until)]);
  await logAction(req, 'task.snooze', 'task', req.params.id);
  res.json({ task: await getTask(req.params.id) });
}));

tasksRouter.post('/:id/cancel', requirePermission('tasks:write'), ah(async (req, res) => {
  await assertCanEdit(req, req.params.id);
  await db().query(`UPDATE tasks SET status = 'cancelled', updated_at = now() WHERE id = $1`, [req.params.id]);
  await syncCompletionToHighLevel(req.params.id, true);
  await logAction(req, 'task.cancel', 'task', req.params.id);
  res.json({ task: await getTask(req.params.id) });
}));

// "Not needed": closes this follow-up for the current cycle (it won't come back until the next visit). Optionally
// turns rebooking follow-ups off for this client and service only.
tasksRouter.post('/:id/not-needed', requirePermission('tasks:write'), ah(async (req, res) => {
  await assertCanEdit(req, req.params.id);
  const b = parse(z.object({ note: optionalText(1000), stopForService: z.boolean().default(false) }), req.body ?? {});
  const t = await db().one<any>('SELECT id, type, client_id, service_id FROM tasks WHERE id = $1', [req.params.id]);
  if (!t) throw badRequest('That follow-up no longer exists.');
  await db().query(
    `UPDATE tasks SET status = 'cancelled', notes = trim(both E'\\n' FROM COALESCE(notes, '') || E'\\n' || $2), updated_at = now() WHERE id = $1`,
    [t.id, `Not needed${b.note ? `: ${b.note}` : '.'}`]);
  if (b.stopForService) {
    if (t.type !== 'rebook' || !t.service_id || !t.client_id) throw badRequest('Only service rebooking follow-ups can be turned off per service.');
    await db().query(
      `INSERT INTO client_service_rebooking(client_id, service_id, follow_ups_enabled, updated_by_staff_id) VALUES ($1,$2,false,$3)
       ON CONFLICT (client_id, service_id) DO UPDATE SET follow_ups_enabled = false, updated_by_staff_id = EXCLUDED.updated_by_staff_id, updated_at = now()`,
      [t.client_id, t.service_id, req.user!.id]);
  }
  await syncCompletionToHighLevel(t.id, true);
  await logAction(req, 'task.not_needed', 'task', t.id, { stopForService: b.stopForService });
  res.json({ task: await getTask(t.id) });
}));

tasksRouter.post('/:id/reopen', requirePermission('tasks:write'), ah(async (req, res) => {
  await assertCanEdit(req, req.params.id);
  await db().query(`UPDATE tasks SET status = 'due', completed_at = NULL, snoozed_until = NULL, updated_at = now() WHERE id = $1`, [req.params.id]);
  await syncCompletionToHighLevel(req.params.id, false);
  res.json({ task: await getTask(req.params.id) });
}));

/** Push to HighLevel. `createContact: true` is sent after staff confirm "Create Contact in HighLevel". */
tasksRouter.post('/:id/highlevel', requirePermission('highlevel:push'), ah(async (req, res) => {
  const { createContact } = parse(z.object({ createContact: z.boolean().optional() }), req.body ?? {});
  const result = await pushTaskToHighLevel(req.params.id, { createContactIfMissing: !!createContact });
  await logAction(req, 'task.highlevel_push', 'task', req.params.id, { status: result.status });
  res.json({ result, task: await getTask(req.params.id) });
}));
