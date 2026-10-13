import { Router } from 'express';
import { z } from 'zod';
import { can } from '../auth/permissions.js';
import { assertClientVisible, clientScope, maskContact } from '../auth/scope.js';
import { requireAnyPermission, requirePermission } from '../auth/session.js';
import { db } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { toE164 } from '../lib/phone.js';
import { iso } from '../lib/time.js';
import { clientRebooking } from '../domain/rebooking.js';
import { clientSchedules } from '../domain/rebookingSchedule.js';
import { listTasks } from '../domain/tasks.js';
import { toMessageDTO } from '../domain/messaging.js';
import { getClientRow, listClients, setClientTags, toClientSummary } from '../repos/clients.js';
import { APPOINTMENT_SELECT, toAppointmentDTO } from '../repos/mappers.js';
import { getSettings } from '../repos/settings.js';
import { ah, logAction, optionalText, parse } from './util.js';

export const clientsRouter = Router();

clientsRouter.get('/', requireAnyPermission('clients:read', 'clients:read_assigned'), ah(async (req, res) => {
  const q = req.query as Record<string, string>;
  const out = await listClients({
    assignedTo: clientScope(req.user),
    q: q.q, tag: q.tag, staffId: q.staffId, service: q.service, lastBefore: q.lastBefore, lastAfter: q.lastAfter,
    nextBefore: q.nextBefore, nextAfter: q.nextAfter, hasNext: q.hasNext as any, archived: q.archived === 'true',
    limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined,
  });
  res.json({ ...out, clients: out.clients.map((c) => maskContact(req.user, c)) });
}));

const clientInput = z.object({
  firstName: z.string().trim().min(1, 'is required').max(80),
  lastName: z.string().trim().max(80).default(''),
  phone: optionalText(40),
  email: z.string().trim().email().max(200).optional().nullable().or(z.literal('').transform(() => null)),
  birthday: optionalText(10),
  preferredStaffId: z.string().uuid().optional().nullable(),
  leadSource: optionalText(60),
  tags: z.array(z.string().max(40)).max(30).optional(),
});

clientsRouter.post('/', requirePermission('clients:write'), ah(async (req, res) => {
  const b = parse(clientInput, req.body);
  const phone = b.phone ? toE164(b.phone) : null;
  if (b.phone && !phone) throw badRequest("That phone number doesn't look right.");
  if (phone) {
    const dupe = await db().one<any>('SELECT id FROM clients WHERE phone = $1 AND archived_at IS NULL', [phone]);
    if (dupe) throw badRequest('A client with that phone number already exists.', { existingId: dupe.id });
  }
  const row = await db().one<{ id: string }>(
    `INSERT INTO clients(first_name, last_name, phone, email, birthday, preferred_staff_id, lead_source) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [b.firstName, b.lastName, phone, b.email?.toLowerCase() ?? null, b.birthday, b.preferredStaffId ?? null, b.leadSource],
  );
  if (b.tags?.length) await setClientTags(row!.id, b.tags);
  await db().query('UPDATE conversations SET client_id = $1 WHERE phone = $2 AND client_id IS NULL', [row!.id, phone]);
  await logAction(req, 'client.create', 'client', row!.id);
  res.status(201).json({ id: row!.id });
}));

clientsRouter.get('/:id', requireAnyPermission('clients:read', 'clients:read_assigned'), ah(async (req, res) => {
  await assertClientVisible(req.user, req.params.id);
  const row = await getClientRow(req.params.id);
  if (!row) throw notFound('That client');
  const settings = await getSettings();
  // Each part of the profile is only included for people allowed to see it.
  const u = req.user;
  const history = can(u, 'clients:history');
  const seesTasks = can(u, 'tasks:read_all') || can(u, 'tasks:read_own');
  const [appointments, tasks, notes, convo, staffAssignments, rebooking, rebookingSchedules] = await Promise.all([
    history ? db().query(`${APPOINTMENT_SELECT} WHERE a.client_id = $1 ORDER BY a.start_at DESC LIMIT 200`, [row.id]) : Promise.resolve([]),
    seesTasks
      ? listTasks({ clientId: row.id, status: 'any', limit: 100 }).then((ts) =>
        can(u, 'tasks:read_all') ? ts : ts.filter((t) => !t.assignedStaffId || t.assignedStaffId === u!.id))
      : Promise.resolve([]),
    history ? db().query(
      `SELECT n.id, n.body, n.pinned, n.created_at, s.name AS author FROM notes n LEFT JOIN staff s ON s.id = n.author_staff_id
        WHERE n.client_id = $1 ORDER BY n.pinned DESC, n.created_at DESC`, [row.id]) : Promise.resolve([]),
    db().one<any>('SELECT id, unread_count FROM conversations WHERE client_id = $1 OR (phone = $2 AND $2 IS NOT NULL) ORDER BY last_message_at DESC NULLS LAST LIMIT 1', [row.id, row.phone]),
    db().query('SELECT s.id, s.name, s.color FROM client_staff cs JOIN staff s ON s.id = cs.staff_id WHERE cs.client_id = $1', [row.id]),
    clientRebooking(row.id, { minVisits: settings.rules.rebookingMinVisits, graceDays: settings.rules.rebookingGraceDays }),
    clientSchedules(row.id),
  ]);
  const messages = convo && can(u, 'messages:read')
    ? (await db().query(`SELECT m.*, s.name AS sent_by_name FROM messages m LEFT JOIN staff s ON s.id = m.sent_by_staff_id WHERE m.conversation_id = $1 ORDER BY m.created_at DESC LIMIT 30`, [convo.id])).reverse().map(toMessageDTO)
    : [];
  const appts = appointments.map(toAppointmentDTO);
  const services = [...new Set(appts.filter((a) => a.displayStatus === 'completed').flatMap((a) => a.serviceNames))];
  res.json({
    client: maskContact(u, {
      ...toClientSummary(row),
      firstName: row.first_name,
      lastName: row.last_name,
      birthday: row.birthday,
      preferredStaffId: row.preferred_staff_id,
      leadSource: row.lead_source,
      highlevelContactId: row.highlevel_contact_id,
      smsOptedOut: row.sms_opted_out,
      createdAt: iso(row.created_at),
    }),
    access: { history, contact: can(u, 'clients:contact'), messages: can(u, 'messages:read'), tasks: seesTasks },
    services,
    appointments: appts,
    tasks,
    notes: notes.map((n: any) => ({ id: n.id, body: n.body, pinned: n.pinned, author: n.author, createdAt: iso(n.created_at) })),
    conversationId: can(u, 'messages:read') ? convo?.id ?? null : null,
    messages,
    staffAssignments,
    rebooking,
    rebookingSchedules,
  });
}));

clientsRouter.patch('/:id', requirePermission('clients:write'), ah(async (req, res) => {
  await assertClientVisible(req.user, req.params.id);
  const b = parse(clientInput.partial().extend({ staffIds: z.array(z.string().uuid()).optional() }), req.body);
  const sets: string[] = [];
  const p: unknown[] = [req.params.id];
  const set = (col: string, v: unknown) => {
    p.push(v);
    sets.push(`${col} = $${p.length}`);
  };
  if (b.firstName !== undefined) set('first_name', b.firstName);
  if (b.lastName !== undefined) set('last_name', b.lastName);
  if (b.phone !== undefined) {
    const phone = b.phone ? toE164(b.phone) : null;
    if (b.phone && !phone) throw badRequest("That phone number doesn't look right.");
    set('phone', phone);
  }
  if (b.email !== undefined) set('email', b.email?.toLowerCase() ?? null);
  if (b.birthday !== undefined) set('birthday', b.birthday);
  if (b.preferredStaffId !== undefined) set('preferred_staff_id', b.preferredStaffId);
  if (b.leadSource !== undefined) set('lead_source', b.leadSource);
  if (sets.length) await db().query(`UPDATE clients SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, p);
  if (b.tags) await setClientTags(req.params.id, b.tags);
  if (b.staffIds) {
    await db().query('DELETE FROM client_staff WHERE client_id = $1', [req.params.id]);
    for (const s of b.staffIds) await db().query('INSERT INTO client_staff(client_id, staff_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, s]);
  }
  await logAction(req, 'client.update', 'client', req.params.id, { fields: Object.keys(b) });
  res.json({ ok: true });
}));

clientsRouter.post('/:id/notes', requireAnyPermission('clients:notes', 'clients:write'), ah(async (req, res) => {
  await assertClientVisible(req.user, req.params.id);
  const { body, pinned } = parse(z.object({ body: z.string().trim().min(1).max(4000), pinned: z.boolean().optional() }), req.body);
  const row = await db().one<{ id: string }>('INSERT INTO notes(client_id, author_staff_id, body, pinned) VALUES ($1,$2,$3,$4) RETURNING id', [
    req.params.id, req.user!.id, body, !!pinned,
  ]);
  await logAction(req, 'note.create', 'client', req.params.id);
  res.status(201).json({ id: row!.id });
}));

clientsRouter.post('/:id/archive', requirePermission('clients:archive'), ah(async (req, res) => {
  await db().query('UPDATE clients SET archived_at = now(), updated_at = now() WHERE id = $1', [req.params.id]);
  await db().query(`UPDATE tasks SET status = 'cancelled', updated_at = now() WHERE client_id = $1 AND status IN ('due','snoozed')`, [req.params.id]);
  await logAction(req, 'client.archive', 'client', req.params.id);
  res.json({ ok: true });
}));

clientsRouter.post('/:id/restore', requirePermission('clients:archive'), ah(async (req, res) => {
  await db().query('UPDATE clients SET archived_at = NULL, updated_at = now() WHERE id = $1', [req.params.id]);
  await logAction(req, 'client.restore', 'client', req.params.id);
  res.json({ ok: true });
}));

/** Permanent deletion of local data (owner only). Square's own records are not touched. */
clientsRouter.delete('/:id', requirePermission('clients:delete'), ah(async (req, res) => {
  const row = await db().one<any>('SELECT phone FROM clients WHERE id = $1', [req.params.id]);
  if (!row) throw notFound('That client');
  await db().tx(async (q) => {
    if (row.phone) await q.query('DELETE FROM conversations WHERE phone = $1', [row.phone]);
    await q.query('UPDATE appointments SET client_id = NULL, raw = NULL WHERE client_id = $1', [req.params.id]);
    await q.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
  });
  await logAction(req, 'client.delete', 'client', req.params.id);
  res.json({ ok: true });
}));

/** Data export for one client (privacy / data-subject requests). */
clientsRouter.get('/:id/export', requirePermission('clients:export'), ah(async (req, res) => {
  const id = req.params.id;
  const client = await db().one('SELECT * FROM clients WHERE id = $1', [id]);
  if (!client) throw notFound('That client');
  const data = {
    exportedAt: new Date().toISOString(),
    client,
    tags: await db().query('SELECT t.name FROM client_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.client_id = $1', [id]),
    appointments: await db().query(`${APPOINTMENT_SELECT} WHERE a.client_id = $1 ORDER BY a.start_at`, [id]),
    notes: await db().query('SELECT body, created_at FROM notes WHERE client_id = $1 ORDER BY created_at', [id]),
    tasks: await db().query('SELECT type, title, reason, status, due_at, completed_at FROM tasks WHERE client_id = $1 ORDER BY created_at', [id]),
    messages: client.phone
      ? await db().query('SELECT m.direction, m.body, m.status, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.phone = $1 ORDER BY m.created_at', [client.phone])
      : [],
  };
  await logAction(req, 'client.export', 'client', id);
  res.setHeader('Content-Disposition', `attachment; filename="client-${id}.json"`);
  res.json(data);
}));

export const notesRouter = Router();

/** Notes can be changed by people who can add notes and can see that client. */
async function assertNoteAccess(req: any, noteId: string) {
  const n = await db().one<any>('SELECT client_id FROM notes WHERE id = $1', [noteId]);
  if (!n) throw notFound('That note');
  if (n.client_id) await assertClientVisible(req.user, n.client_id);
  else if (!can(req.user, 'leads:write')) throw notFound('That note');
}

notesRouter.delete('/:id', requireAnyPermission('clients:notes', 'clients:write'), ah(async (req, res) => {
  await assertNoteAccess(req, req.params.id);
  await db().query('DELETE FROM notes WHERE id = $1', [req.params.id]);
  await logAction(req, 'note.delete', 'note', req.params.id);
  res.json({ ok: true });
}));
notesRouter.patch('/:id', requireAnyPermission('clients:notes', 'clients:write'), ah(async (req, res) => {
  await assertNoteAccess(req, req.params.id);
  const b = parse(z.object({ pinned: z.boolean().optional(), body: z.string().trim().min(1).max(4000).optional() }), req.body);
  await db().query('UPDATE notes SET pinned = COALESCE($2, pinned), body = COALESCE($3, body), updated_at = now() WHERE id = $1', [req.params.id, b.pinned ?? null, b.body ?? null]);
  res.json({ ok: true });
}));
