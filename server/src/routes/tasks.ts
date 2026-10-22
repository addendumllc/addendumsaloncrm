import { Router } from 'express';
import { notifications } from '../integrations/notifications/NotificationService.js';
import { z } from 'zod';
import { can } from '../auth/permissions.js';
import { requirePermission } from '../auth/session.js';
import { db } from '../db/index.js';
import type { TaskDTO } from '@addendum/shared';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { dayBounds, zonedToUtc } from '../lib/time.js';
import { localDate } from '../domain/rebookingSchedule.js';
import { pushTaskToHighLevel, syncCompletionToHighLevel } from '../domain/highlevelPush.js';
import { completeTask, createTask, getTask, getTaskRetention, listTasks, purgeOldInternalTasks, setTaskRetention } from '../domain/tasks.js';
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
    status: q.status, kind: q.kind as any, business: q.business === 'salon' || q.business === 'hair' ? q.business : undefined, type: q.type, priority: q.priority, due: q.due as any, q: q.q,
    // "My tasks": only the ones assigned to them.
    assignedStaffId: q.mine === '1' ? req.user!.id : allowAll ? q.staffId : undefined, clientId: q.clientId, leadId: q.leadId,
    hlStatus: q.hl === 'failed' ? undefined : q.hl,
    completedSince: /^\d{4}-\d{2}-\d{2}$/.test(q.since ?? '') ? q.since : undefined,
  }, end);
  if (q.hl === 'failed') tasks = tasks.filter((t) => t.highlevel.status === 'failed' || t.highlevel.status === 'needs_contact');
  if (!allowAll) tasks = tasks.filter((t) => !t.assignedStaffId || t.assignedStaffId === req.user!.id);
  // Away from the salon: internal tasks only — client follow-ups (names, numbers) stay at the salon.
  if (req.away) tasks = tasks.filter((t) => t.kind === 'task');
  res.json({ tasks: tasks.map((t) => hideContact(req, t)) });
}));

/** Phone numbers only for people who may see contact details. */
const hideContact = (req: any, t: TaskDTO): TaskDTO => (can(req.user, 'clients:contact') ? t : { ...t, contactPhone: null });

/** Tasks → Done: how long finished internal tasks are kept (6–12 months). */
tasksRouter.get('/retention', ah(async (_req, res) => res.json(await getTaskRetention())));
tasksRouter.put('/retention', requirePermission('tasks:delete'), ah(async (req, res) => {
  const { months } = parse(z.object({ months: z.union([z.literal(6), z.literal(9), z.literal(12)]).nullable() }), req.body);
  await setTaskRetention(months);
  const removed = await purgeOldInternalTasks();
  await logAction(req, 'task.retention', 'settings', null, { months, removed });
  res.json({ ...(await getTaskRetention()), removed });
}));

tasksRouter.get('/:id', ah(async (req, res) => {
  const task = await getTask(req.params.id);
  if (req.away && task.kind !== 'task') throw notFound('That follow-up');
  if (!can(req.user, 'tasks:read_all') && task.assignedStaffId && task.assignedStaffId !== req.user!.id) throw notFound('That follow-up');
  res.json({ task: hideContact(req, task) });
}));

const taskInput = z.object({
  kind: z.enum(['follow_up', 'task']).default('follow_up'),
  // Internal tasks: for Addendum Salon or Addendum Hair.
  business: z.enum(['salon', 'hair']).default('salon'),
  type: z.enum(TYPES).default('follow_up'),
  title: z.string().trim().min(1, 'is required').max(200),
  reason: optionalText(1000),
  notes: optionalText(4000),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  dueAt: isoDate.nullable().optional(),
  clientId: z.string().uuid().optional().nullable(),
  leadId: z.string().uuid().optional().nullable(),
  assignedStaffId: z.string().uuid().optional().nullable(),
  pushToHighLevel: z.boolean().optional(),
});

tasksRouter.post('/', requirePermission('tasks:write'), ah(async (req, res) => {
  const b = parse(taskInput, req.body);
  if (b.kind === 'follow_up' && !b.clientId && !b.leadId) throw badRequest('Choose the client or lead this follow-up is for.');
  // Internal tasks may have no due date (just a priority); client follow-ups need one.
  if (!b.dueAt && b.kind !== 'task') throw badRequest('Choose when this follow-up is due.');
  if (req.away && (b.kind !== 'task' || b.clientId || b.leadId)) throw forbidden('Away from the salon you can add internal tasks only. Client follow-ups are added at the salon.');
  const id = await createTask({ ...b, dueAt: b.dueAt ? new Date(b.dueAt) : null, createdBy: req.user!.id });
  await logAction(req, 'task.create', 'task', id);
  if (id && b.assignedStaffId) await tellAssignee(b.assignedStaffId, req.user!, id);
  let highlevel = null;
  // Always makes the HighLevel to-do: the contact is matched by phone/email first and only created when there's none.
  if (b.pushToHighLevel && id) highlevel = await pushTaskToHighLevel(id, { createContactIfMissing: true });
  res.status(201).json({ id, highlevel });
}));

/** In-app notification (bell) for the person a task was sent to — never for sending one to yourself. */
async function tellAssignee(staffId: string, from: { id: string; name: string }, taskId: string) {
  if (staffId === from.id) return;
  const t = await db().one<any>('SELECT title, kind FROM tasks WHERE id = $1', [taskId]);
  if (!t) return;
  await notifications.notify({
    staffId, kind: 'task', external: false, title: `${t.kind === 'task' ? 'New task' : 'New follow-up'} from ${from.name}`, body: t.title,
    link: t.kind === 'task' ? '/tasks?kind=task' : '/follow-ups',
  });
}

/** Away from the salon only internal tasks can be changed; client follow-ups are done at the salon. */
async function assertInternalWhenAway(id: string) {
  const k = await db().one<any>('SELECT kind FROM tasks WHERE id = $1', [id]);
  if (k && k.kind !== 'task') throw forbidden('Away from the salon you can only update internal tasks. Client follow-ups are done at the salon.');
}

async function assertCanEdit(req: any, id: string) {
  if (req.away) await assertInternalWhenAway(id);
  if (can(req.user, 'tasks:read_all')) return;
  const t = await db().one<any>('SELECT assigned_staff_id FROM tasks WHERE id = $1', [id]);
  if (t?.assigned_staff_id && t.assigned_staff_id !== req.user.id) throw forbidden();
}

/**
 * Delete finished follow-ups and tasks to clear them out (completed or cancelled), optionally only those
 * finished before a date. Open ones are never removed in bulk. Before /:id so "finished" isn't read as an id.
 */
tasksRouter.delete('/finished', requirePermission('tasks:delete'), ah(async (req, res) => {
  const { before, kind } = parse(z.object({ before: isoDate.optional(), kind: z.enum(['follow_up', 'task']).optional() }), req.query);
  const p: unknown[] = [];
  const where = [`status IN ('completed','cancelled')`];
  if (before) where.push(`COALESCE(completed_at, updated_at) < $${p.push(before)}::date`);
  if (kind) where.push(`kind = $${p.push(kind)}`);
  const removed = await db().query<{ dedupe_key: string | null }>(`DELETE FROM tasks WHERE ${where.join(' AND ')} RETURNING dedupe_key`, p);
  for (const r of removed) if (r.dedupe_key) await db().query('INSERT INTO deleted_task_keys(dedupe_key) VALUES ($1) ON CONFLICT DO NOTHING', [r.dedupe_key]);
  await logAction(req, 'task.delete_finished', 'task', null, { removed: removed.length, before: before ?? null, kind: kind ?? 'all' });
  res.json({ removed: removed.length });
}));

/** Deletes one follow-up or task. An automatic one isn't created again for the same reason. */
tasksRouter.delete('/:id', requirePermission('tasks:delete'), ah(async (req, res) => {
  if (req.away) await assertInternalWhenAway(req.params.id);
  const t = await db().one<{ title: string; dedupe_key: string | null; assigned_staff_id: string | null }>('SELECT title, dedupe_key, assigned_staff_id FROM tasks WHERE id = $1', [req.params.id]);
  if (!t) throw notFound('That follow-up');
  if (!can(req.user, 'tasks:read_all') && t.assigned_staff_id && t.assigned_staff_id !== req.user!.id) throw notFound('That follow-up');
  if (t.dedupe_key) await db().query('INSERT INTO deleted_task_keys(dedupe_key) VALUES ($1) ON CONFLICT DO NOTHING', [t.dedupe_key]);
  await db().query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  await logAction(req, 'task.delete', 'task', req.params.id, { title: t.title });
  res.json({ ok: true });
}));

tasksRouter.patch('/:id', requirePermission('tasks:write'), ah(async (req, res) => {
  await assertCanEdit(req, req.params.id);
  const was = await db().one<any>('SELECT assigned_staff_id FROM tasks WHERE id = $1', [req.params.id]);
  const b = parse(z.object({
    title: z.string().trim().min(1).max(200).optional(),
    notes: optionalText(4000),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    /** null clears the due date (internal tasks only). */
    dueAt: isoDate.nullable().optional(),
    assignedStaffId: z.string().uuid().nullable().optional(),
    type: z.enum(TYPES).optional(),
    business: z.enum(['salon', 'hair']).optional(),
  }), req.body);
  if (b.assignedStaffId !== undefined && !can(req.user, 'tasks:assign') && b.assignedStaffId !== req.user!.id) throw forbidden();
  if (b.dueAt === null && (await db().one<any>('SELECT kind FROM tasks WHERE id = $1', [req.params.id]))?.kind !== 'task') throw badRequest('Client follow-ups need a due date.');
  await db().query(
    `UPDATE tasks SET title = COALESCE($2, title), notes = CASE WHEN $3::boolean THEN $4 ELSE notes END, priority = COALESCE($5, priority),
       due_at = CASE WHEN $10::boolean THEN NULL ELSE COALESCE($6, due_at) END, assigned_staff_id = CASE WHEN $7::boolean THEN $8::uuid ELSE assigned_staff_id END, type = COALESCE($9, type),
       status = CASE WHEN $6::timestamptz IS NOT NULL AND status = 'snoozed' THEN 'due' ELSE status END,
       hl_status = CASE WHEN hl_status = 'synced' THEN 'pending' ELSE hl_status END,
       hl_next_retry_at = CASE WHEN hl_status = 'synced' THEN now() ELSE hl_next_retry_at END,
       updated_at = now()
     WHERE id = $1`,
    [req.params.id, b.title ?? null, b.notes !== undefined, b.notes ?? null, b.priority ?? null, b.dueAt ? new Date(b.dueAt) : null,
      b.assignedStaffId !== undefined, b.assignedStaffId ?? null, b.type ?? null, b.dueAt === null],
  );
  // Only internal tasks belong to Addendum Hair; client follow-ups stay the salon's.
  if (b.business) await db().query(`UPDATE tasks SET business = $2 WHERE id = $1 AND kind = 'task'`, [req.params.id, b.business]);
  await logAction(req, 'task.update', 'task', req.params.id, { fields: Object.keys(b) });
  if (b.assignedStaffId && b.assignedStaffId !== was?.assigned_staff_id) await tellAssignee(b.assignedStaffId, req.user!, req.params.id);
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

/**
 * "Reached out": contacted the client or lead, now waiting for their reply. The task stays open and comes back on the
 * check-back date (or straight away if they text back). Each attempt is noted on the task.
 */
tasksRouter.post('/:id/reached-out', requirePermission('tasks:write'), ah(async (req, res) => {
  await assertCanEdit(req, req.params.id);
  // `on`: the day they were contacted (today unless they reached out earlier); check-back counts from that day.
  const b = parse(z.object({ via: z.enum(['text', 'call', 'email', 'other']).default('other'), checkBackDays: z.number().int().min(1).max(30).default(2), on: isoDate.optional() }), req.body ?? {});
  const t = await db().one<any>('SELECT status, client_id, lead_id FROM tasks WHERE id = $1', [req.params.id]);
  if (!t) throw notFound('That follow-up');
  if (!t.client_id && !t.lead_id) throw badRequest('Reached out is for follow-ups with a client or lead.');
  if (t.status === 'completed' || t.status === 'cancelled') throw badRequest('This follow-up is already finished.');
  const tz = (await getSettings()).business.timezone;
  const today = localDate(new Date(), tz);
  const onDay = b.on ? b.on.slice(0, 10) : today;
  if (onDay > today) throw badRequest('The day you reached out can’t be in the future.');
  const at = onDay === today ? new Date() : zonedToUtc(+onDay.slice(0, 4), +onDay.slice(5, 7), +onDay.slice(8, 10), 12, 0, tz);
  // Check back in the morning, the chosen number of days after they were contacted (today at the earliest).
  let day = localDate(new Date(at.getTime() + b.checkBackDays * 86400_000), tz);
  if (day < today) day = today;
  const until = zonedToUtc(+day.slice(0, 4), +day.slice(5, 7), +day.slice(8, 10), 9, 30, tz);
  const via = { text: 'by text', call: 'by phone', email: 'by email', other: '' }[b.via];
  const note = `Reached out${via ? ` ${via}` : ''} on ${onDay} (${req.user!.name}) — waiting for a reply, check back ${day}.`;
  await db().query(
    `UPDATE tasks SET reached_out_at = $4, reach_out_count = reach_out_count + 1, status = 'snoozed', snoozed_until = $2, due_at = $2,
       notes = trim(both E'\\n' FROM COALESCE(notes, '') || E'\\n' || $3), updated_at = now() WHERE id = $1`,
    [req.params.id, until, note, at]);
  await logAction(req, 'task.reached_out', 'task', req.params.id, { via: b.via, checkBackDays: b.checkBackDays });
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
  if (req.away) throw forbidden('Pushing client follow-ups to HighLevel is done at the salon.');
  const { createContact } = parse(z.object({ createContact: z.boolean().optional() }), req.body ?? {});
  // One click: the follow-up becomes a to-do in HighLevel. The contact is matched by phone/email first (no duplicates)
  // and created only when there's no match; send createContact: false to only use an existing contact.
  const result = await pushTaskToHighLevel(req.params.id, { createContactIfMissing: createContact !== false });
  await logAction(req, 'task.highlevel_push', 'task', req.params.id, { status: result.status });
  res.json({ result, task: await getTask(req.params.id) });
}));
