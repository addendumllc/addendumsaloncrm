import type { LeadDTO } from '@addendum/shared';
import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../auth/session.js';
import { db } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { toE164 } from '../lib/phone.js';
import { iso } from '../lib/time.js';
import { runRules } from '../domain/rulesEngine.js';
import { listTasks } from '../domain/tasks.js';
import { toMessageDTO } from '../domain/messaging.js';
import { resolveShowit, showitOverview } from '../domain/showit.js';
import { ah, logAction, optionalText, parse } from './util.js';

export const leadsRouter = Router();

const STATUSES = ['new', 'contacted', 'waiting', 'interested', 'consultation_scheduled', 'booked', 'follow_up_needed', 'won', 'lost'] as const;

const SELECT = `
  SELECT l.*, s.name AS staff_name,
    (SELECT min(t.due_at) FROM tasks t WHERE t.lead_id = l.id AND t.status = 'due') AS next_task_at,
    (SELECT COALESCE(sum(cv.unread_count),0)::int FROM conversations cv WHERE cv.lead_id = l.id) AS unread
  FROM leads l LEFT JOIN staff s ON s.id = l.assigned_staff_id`;

export function toLeadDTO(r: any): LeadDTO {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    source: r.source,
    serviceInterest: r.service_interest,
    status: r.status,
    assignedStaffId: r.assigned_staff_id,
    assignedStaffName: r.staff_name ?? null,
    lastContactAt: iso(r.last_contact_at),
    nextFollowUpAt: iso(r.next_follow_up_at ?? r.next_task_at),
    notes: r.notes,
    clientId: r.client_id,
    createdAt: iso(r.created_at)!,
    unreadCount: r.unread ?? 0,
  };
}

leadsRouter.get('/', requirePermission('leads:read'), ah(async (req, res) => {
  const q = req.query as Record<string, string>;
  const where = [q.archived === 'true' ? 'l.archived_at IS NOT NULL' : 'l.archived_at IS NULL'];
  const p: unknown[] = [];
  if (q.status) { p.push(q.status); where.push(`l.status = $${p.length}`); }
  if (q.staffId) { p.push(q.staffId); where.push(`l.assigned_staff_id = $${p.length}`); }
  if (q.source) { p.push(q.source); where.push(`l.source = $${p.length}`); }
  if (q.service) { p.push(`%${q.service}%`); where.push(`l.service_interest ILIKE $${p.length}`); }
  if (q.q) { p.push(`%${q.q}%`); where.push(`(l.name ILIKE $${p.length} OR l.email ILIKE $${p.length} OR l.phone ILIKE $${p.length})`); }
  const rows = await db().query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC LIMIT 500`, p);
  res.json({ leads: rows.map(toLeadDTO) });
}));

const leadInput = z.object({
  name: z.string().trim().min(1, 'is required').max(120),
  phone: optionalText(40),
  email: z.string().trim().email().max(200).optional().nullable().or(z.literal('').transform(() => null)),
  source: optionalText(60),
  serviceInterest: optionalText(120),
  status: z.enum(STATUSES).optional(),
  assignedStaffId: z.string().uuid().optional().nullable(),
  nextFollowUpAt: z.string().optional().nullable(),
  notes: optionalText(4000),
});

leadsRouter.post('/', requirePermission('leads:write'), ah(async (req, res) => {
  const b = parse(leadInput, req.body);
  const phone = b.phone ? toE164(b.phone) : null;
  if (b.phone && !phone) throw badRequest("That phone number doesn't look right.");
  if (!phone && !b.email) throw badRequest('Add a phone number or email so the salon can reach this lead.');
  const row = await db().one<{ id: string }>(
    `INSERT INTO leads(name, phone, email, source, service_interest, status, assigned_staff_id, notes, next_follow_up_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [b.name, phone, b.email?.toLowerCase() ?? null, b.source, b.serviceInterest, b.status ?? 'new', b.assignedStaffId ?? null, b.notes,
      b.nextFollowUpAt ? new Date(b.nextFollowUpAt) : null],
  );
  if (phone) await db().query('UPDATE conversations SET lead_id = $1 WHERE phone = $2 AND lead_id IS NULL', [row!.id, phone]);
  await logAction(req, 'lead.create', 'lead', row!.id);
  await runRules(); // creates the "contact new lead" follow-up right away
  res.status(201).json({ id: row!.id });
}));

// Website inquiries (Showit form submissions) for Follow-Ups: what came in, and what needs review — without the
// mailbox settings (Settings → Website Inquiries, administrators).
leadsRouter.get('/website-inquiries', requirePermission('leads:read'), ah(async (_req, res) => {
  const o = await showitOverview();
  res.json({ connected: o.connection.connected, needsReconnect: !!o.connection.needsReconnect, lastRun: o.lastRun, history: o.history.filter((h) => h.status !== 'ignored' && h.status !== 'duplicate') });
}));
leadsRouter.post('/website-inquiries/:id/resolve', requirePermission('leads:write'), ah(async (req, res) => {
  const b = parse(z.object({ action: z.enum(['extension', 'general', 'ignore']), name: z.string().trim().max(120).optional(), email: z.string().trim().max(200).optional(), phone: z.string().trim().max(40).optional() }), req.body);
  const leadId = await resolveShowit(req.params.id, b.action, req.user!.id, { name: b.name, email: b.email, phone: b.phone });
  await logAction(req, 'integration.showit_resolve', 'lead', leadId, { action: b.action });
  res.json({ leadId });
}));
leadsRouter.get('/:id', requirePermission('leads:read'), ah(async (req, res) => {
  const row = await db().one(`${SELECT} WHERE l.id = $1`, [req.params.id]);
  if (!row) throw notFound('That lead');
  const convo = await db().one<any>('SELECT id FROM conversations WHERE lead_id = $1 OR (phone = $2 AND $2 IS NOT NULL) LIMIT 1', [row.id, row.phone]);
  const messages = convo
    ? (await db().query('SELECT m.*, s.name AS sent_by_name FROM messages m LEFT JOIN staff s ON s.id = m.sent_by_staff_id WHERE m.conversation_id = $1 ORDER BY m.created_at', [convo.id])).map(toMessageDTO)
    : [];
  const notes = await db().query(
    'SELECT n.id, n.body, n.created_at, s.name AS author FROM notes n LEFT JOIN staff s ON s.id = n.author_staff_id WHERE n.lead_id = $1 ORDER BY n.created_at DESC', [row.id]);
  res.json({
    lead: toLeadDTO(row),
    tasks: await listTasks({ leadId: row.id, status: 'any', limit: 50 }),
    conversationId: convo?.id ?? null,
    messages,
    notes: notes.map((n: any) => ({ id: n.id, body: n.body, author: n.author, createdAt: iso(n.created_at) })),
  });
}));

leadsRouter.patch('/:id', requirePermission('leads:write'), ah(async (req, res) => {
  const b = parse(leadInput.partial(), req.body);
  const sets: string[] = [];
  const p: unknown[] = [req.params.id];
  const set = (col: string, v: unknown) => { p.push(v); sets.push(`${col} = $${p.length}`); };
  if (b.name !== undefined) set('name', b.name);
  if (b.phone !== undefined) set('phone', b.phone ? toE164(b.phone) : null);
  if (b.email !== undefined) set('email', b.email?.toLowerCase() ?? null);
  if (b.source !== undefined) set('source', b.source);
  if (b.serviceInterest !== undefined) set('service_interest', b.serviceInterest);
  if (b.status !== undefined) set('status', b.status);
  if (b.assignedStaffId !== undefined) set('assigned_staff_id', b.assignedStaffId);
  if (b.notes !== undefined) set('notes', b.notes);
  if (b.nextFollowUpAt !== undefined) set('next_follow_up_at', b.nextFollowUpAt ? new Date(b.nextFollowUpAt) : null);
  if (!sets.length) return res.json({ ok: true });
  await db().query(`UPDATE leads SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, p);
  // Mark "contacted" when staff move a lead out of New manually (e.g. after a phone call).
  if (b.status && b.status !== 'new') await db().query('UPDATE leads SET last_contact_at = COALESCE(last_contact_at, now()) WHERE id = $1', [req.params.id]);
  if (b.assignedStaffId !== undefined) {
    await db().query(`UPDATE tasks SET assigned_staff_id = $2 WHERE lead_id = $1 AND status IN ('due','snoozed')`, [req.params.id, b.assignedStaffId]);
  }
  await logAction(req, 'lead.update', 'lead', req.params.id, { fields: Object.keys(b), status: b.status });
  await runRules();
  res.json({ ok: true });
}));

leadsRouter.post('/:id/notes', requirePermission('leads:write'), ah(async (req, res) => {
  const { body } = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
  await db().query('INSERT INTO notes(lead_id, author_staff_id, body) VALUES ($1,$2,$3)', [req.params.id, req.user!.id, body]);
  res.status(201).json({ ok: true });
}));

/** Convert a lead into a client record (Square remains the source of truth for bookings). */
leadsRouter.post('/:id/convert', requirePermission('leads:write'), ah(async (req, res) => {
  const lead = await db().one<any>('SELECT * FROM leads WHERE id = $1', [req.params.id]);
  if (!lead) throw notFound('That lead');
  if (lead.client_id) return res.json({ clientId: lead.client_id });
  const existing = await db().one<any>(
    `SELECT id FROM clients WHERE (phone IS NOT NULL AND phone = $1) OR (email IS NOT NULL AND lower(email) = lower($2)) LIMIT 1`, [lead.phone, lead.email]);
  let clientId = existing?.id;
  if (!clientId) {
    const [first, ...rest] = String(lead.name).split(' ');
    const row = await db().one<{ id: string }>(
      `INSERT INTO clients(first_name, last_name, phone, email, lead_source, preferred_staff_id, highlevel_contact_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [first, rest.join(' '), lead.phone, lead.email, lead.source, lead.assigned_staff_id, lead.highlevel_contact_id],
    );
    clientId = row!.id;
  }
  await db().query(`UPDATE leads SET client_id = $2, status = CASE WHEN status IN ('booked','won') THEN status ELSE 'won' END, updated_at = now() WHERE id = $1`, [lead.id, clientId]);
  await db().query('UPDATE notes SET client_id = $2 WHERE lead_id = $1', [lead.id, clientId]);
  if (lead.phone) await db().query('UPDATE conversations SET client_id = $2 WHERE phone = $1', [lead.phone, clientId]);
  await logAction(req, 'lead.convert', 'lead', lead.id, { clientId });
  await runRules();
  res.json({ clientId });
}));

leadsRouter.post('/:id/archive', requirePermission('leads:write'), ah(async (req, res) => {
  await db().query('UPDATE leads SET archived_at = now(), updated_at = now() WHERE id = $1', [req.params.id]);
  await db().query(`UPDATE tasks SET status = 'cancelled', updated_at = now() WHERE lead_id = $1 AND status IN ('due','snoozed')`, [req.params.id]);
  await logAction(req, 'lead.archive', 'lead', req.params.id);
  res.json({ ok: true });
}));
