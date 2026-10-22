import { Router } from 'express';
import { z } from 'zod';
import type { HairClientDTO, HairTaskDTO } from '@addendum/shared';
import { db } from '../db/index.js';
import { getHairHighLevel, pullHairClients, setHairHighLevel } from '../domain/hairHighLevel.js';
import { hairHighLevelService } from '../integrations/registry.js';
import { badRequest, notFound } from '../lib/errors.js';
import { ah, logAction, optionalText, parse } from './util.js';

/** Addendum Hair's own CRM: its clients and their tasks, kept apart from the salon's clients and follow-ups. */
export const hairRouter = Router();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)');

const toClient = (r: any): HairClientDTO => ({
  id: r.id, name: r.name, email: r.email, phone: r.phone, company: r.company, notes: r.notes,
  openTasks: Number(r.open_tasks ?? 0), fromHighLevel: !!r.highlevel_contact_id, createdAt: new Date(r.created_at).toISOString(),
});

const toTask = (r: any): HairTaskDTO => ({
  id: r.id, clientId: r.client_id, clientName: r.client_name ?? null, title: r.title, description: r.description,
  type: r.type, source: r.source, sourceSubject: r.source_subject, sourceFrom: r.source_from, sourceExcerpt: r.source_excerpt,
  status: r.status, nextStep: r.next_step, dueOn: r.due_on, assignedName: r.assigned_name ?? null,
  completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null, createdAt: new Date(r.created_at).toISOString(),
});

const CLIENT_SELECT = `SELECT c.*, (SELECT count(*) FROM hair_tasks t WHERE t.client_id = c.id AND t.status <> 'done') AS open_tasks FROM hair_clients c`;
// Dates as written (no time zone shift).
const TASK_SELECT = `SELECT t.id, t.client_id, t.title, t.description, t.type, t.source, t.source_subject, t.source_from, t.source_excerpt,
  t.status, t.next_step, to_char(t.due_on, 'YYYY-MM-DD') AS due_on, t.completed_at, t.created_at, c.name AS client_name, s.name AS assigned_name
  FROM hair_tasks t LEFT JOIN hair_clients c ON c.id = t.client_id LEFT JOIN staff s ON s.id = t.assigned_staff_id`;

async function getTask(id: string) {
  const r = await db().one<any>(`${TASK_SELECT} WHERE t.id = $1`, [id]);
  if (!r) throw notFound('That task');
  return toTask(r);
}

// ---------------- Clients ----------------

hairRouter.get('/clients', ah(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const rows = q
    ? await db().query<any>(`${CLIENT_SELECT} WHERE c.name ILIKE $1 OR c.email ILIKE $1 OR c.phone ILIKE $1 OR c.company ILIKE $1 ORDER BY lower(c.name)`, [`%${q}%`])
    : await db().query<any>(`${CLIENT_SELECT} ORDER BY lower(c.name)`);
  res.json({ clients: rows.map(toClient) });
}));

hairRouter.get('/clients/:id', ah(async (req, res) => {
  const r = await db().one<any>(`${CLIENT_SELECT} WHERE c.id = $1`, [req.params.id]);
  if (!r) throw notFound('That client');
  const tasks = await db().query<any>(`${TASK_SELECT} WHERE t.client_id = $1 ORDER BY (t.status = 'done'), t.due_on NULLS LAST, t.created_at DESC`, [req.params.id]);
  res.json({ client: toClient(r), tasks: tasks.map(toTask) });
}));

const clientInput = z.object({
  name: z.string().trim().min(1, 'is required').max(200),
  email: z.string().trim().email().max(200).optional().nullable().or(z.literal('')).transform((v) => (v ? v : null)),
  phone: optionalText(40),
  company: optionalText(200),
  notes: optionalText(4000),
});

async function emailTaken(email: string | null, exceptId?: string) {
  if (!email) return false;
  return !!(await db().one('SELECT 1 FROM hair_clients WHERE lower(email) = lower($1) AND id IS DISTINCT FROM $2', [email, exceptId ?? null]));
}

hairRouter.post('/clients', ah(async (req, res) => {
  const b = parse(clientInput, req.body);
  if (await emailTaken(b.email)) throw badRequest('A client with that email is already on the list.');
  const r = await db().one<any>('INSERT INTO hair_clients (name, email, phone, company, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id', [b.name, b.email, b.phone, b.company, b.notes]);
  await logAction(req, 'hair_client.create', 'hair_client', r.id);
  res.status(201).json({ id: r.id });
}));

hairRouter.patch('/clients/:id', ah(async (req, res) => {
  const b = parse(clientInput.partial(), req.body);
  if (b.email !== undefined && (await emailTaken(b.email, req.params.id))) throw badRequest('A client with that email is already on the list.');
  const cols = { name: b.name, email: b.email, phone: b.phone, company: b.company, notes: b.notes };
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(cols)) if (v !== undefined) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  const r = await db().one(`UPDATE hair_clients SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING id`, vals);
  if (!r) throw notFound('That client');
  await logAction(req, 'hair_client.update', 'hair_client', req.params.id);
  res.json({ ok: true });
}));

hairRouter.delete('/clients/:id', ah(async (req, res) => {
  const r = await db().one('DELETE FROM hair_clients WHERE id = $1 RETURNING id', [req.params.id]);
  if (!r) throw notFound('That client');
  await logAction(req, 'hair_client.delete', 'hair_client', req.params.id);
  res.json({ ok: true });
}));

// ---------------- HighLevel (pull clients) ----------------

hairRouter.get('/highlevel', ah(async (_req, res) => {
  const conn = hairHighLevelService();
  res.json({ connected: !!conn, source: conn?.source ?? null, ...(await getHairHighLevel()) });
}));

hairRouter.put('/highlevel', ah(async (req, res) => {
  const b = parse(z.object({ tag: optionalText(100), auto: z.boolean().optional() }), req.body);
  const s = await setHairHighLevel({ ...(b.tag !== undefined ? { tag: b.tag } : {}), ...(b.auto !== undefined ? { auto: b.auto } : {}) });
  await logAction(req, 'hair_highlevel.settings', 'settings', null, { tag: s.tag, auto: s.auto });
  res.json(s);
}));

hairRouter.post('/highlevel/pull', ah(async (req, res) => {
  if (!hairHighLevelService()) throw badRequest('Connect HighLevel first (Settings → API & Integrations).');
  const r = await pullHairClients();
  await logAction(req, 'hair_highlevel.pull', 'hair_client', null, r);
  res.json(r);
}));

// ---------------- Tasks ----------------

hairRouter.get('/tasks', ah(async (req, res) => {
  const q = req.query as Record<string, string>;
  const where: string[] = []; const vals: unknown[] = [];
  if (q.status === 'active' || !q.status) where.push(`t.status <> 'done'`);
  else if (['open', 'waiting', 'done'].includes(q.status)) { vals.push(q.status); where.push(`t.status = $${vals.length}`); }
  if (q.clientId) { vals.push(q.clientId); where.push(`t.client_id = $${vals.length}`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.since ?? '')) { vals.push(q.since); where.push(`t.completed_at >= $${vals.length}::date`); }
  if (q.mine === '1') { vals.push(req.user!.id); where.push(`t.assigned_staff_id = $${vals.length}`); }
  if (q.q?.trim()) { vals.push(`%${q.q.trim()}%`); where.push(`(t.title ILIKE $${vals.length} OR t.description ILIKE $${vals.length} OR c.name ILIKE $${vals.length} OR t.source_subject ILIKE $${vals.length})`); }
  const order = q.status === 'done' ? 't.completed_at DESC NULLS LAST' : 't.due_on NULLS LAST, t.created_at';
  const rows = await db().query<any>(`${TASK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT 500`, vals);
  res.json({ tasks: rows.map(toTask) });
}));

const taskInput = z.object({
  // An existing client, or a new one (found by email first, so the same person isn't added twice).
  clientId: z.string().uuid().optional().nullable(),
  client: z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().email().max(200).optional().nullable().or(z.literal('')) }).optional().nullable(),
  title: z.string().trim().min(1, 'is required').max(200),
  description: optionalText(4000),
  type: z.enum(['reply', 'order', 'check_in', 'other']).default('other'),
  source: z.enum(['email', 'follow_up', 'manual']).default('manual'),
  sourceSubject: optionalText(300),
  sourceFrom: optionalText(300),
  sourceExcerpt: optionalText(4000),
  status: z.enum(['open', 'waiting', 'done']).default('open'),
  nextStep: optionalText(500),
  dueOn: day.optional().nullable(),
  assignedStaffId: z.string().uuid().optional().nullable(),
});

async function clientFor(b: z.infer<typeof taskInput>) {
  if (b.clientId) {
    if (!(await db().one('SELECT 1 FROM hair_clients WHERE id = $1', [b.clientId]))) throw notFound('That client');
    return b.clientId;
  }
  if (!b.client) return null;
  const email = b.client.email || null;
  if (email) {
    const found = await db().one<any>('SELECT id FROM hair_clients WHERE lower(email) = lower($1)', [email]);
    if (found) return found.id as string;
  }
  return (await db().one<any>('INSERT INTO hair_clients (name, email) VALUES ($1, $2) RETURNING id', [b.client.name, email]))!.id as string;
}

hairRouter.post('/tasks', ah(async (req, res) => {
  const b = parse(taskInput, req.body);
  const clientId = await clientFor(b);
  const r = await db().one<any>(
    `INSERT INTO hair_tasks (client_id, title, description, type, source, source_subject, source_from, source_excerpt, status, next_step, due_on,
       assigned_staff_id, created_by_staff_id, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $9 = 'done' THEN now() END) RETURNING id`,
    [clientId, b.title, b.description, b.type, b.source, b.sourceSubject, b.sourceFrom, b.sourceExcerpt, b.status, b.nextStep, b.dueOn ?? null,
      b.assignedStaffId ?? null, req.user!.id],
  );
  await logAction(req, 'hair_task.create', 'hair_task', r.id);
  res.status(201).json({ task: await getTask(r.id) });
}));

const taskPatch = taskInput.omit({ client: true, source: true, sourceSubject: true, sourceFrom: true, sourceExcerpt: true }).partial().extend({
  // Marking it done can schedule the next check-in straight away (a new follow-up task).
  followUp: z.object({ title: z.string().trim().min(1).max(200), dueOn: day, nextStep: optionalText(500) }).optional().nullable(),
});

hairRouter.patch('/tasks/:id', ah(async (req, res) => {
  const b = parse(taskPatch, req.body);
  const before = await getTask(req.params.id);
  if (b.clientId && !(await db().one('SELECT 1 FROM hair_clients WHERE id = $1', [b.clientId]))) throw notFound('That client');
  const cols: Record<string, unknown> = {
    client_id: b.clientId, title: b.title, description: b.description, type: b.type, status: b.status,
    next_step: b.nextStep, due_on: b.dueOn, assigned_staff_id: b.assignedStaffId,
  };
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(cols)) if (v !== undefined) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
  if (b.status && b.status !== before.status) sets.push(b.status === 'done' ? 'completed_at = now()' : 'completed_at = NULL');
  if (sets.length) {
    vals.push(req.params.id);
    await db().query(`UPDATE hair_tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
  }
  let followUp: HairTaskDTO | null = null;
  if (b.followUp) {
    const r = await db().one<any>(
      `INSERT INTO hair_tasks (client_id, title, type, source, source_subject, next_step, due_on, assigned_staff_id, created_by_staff_id)
       SELECT client_id, $2, 'check_in', 'follow_up', title, $3, $4, assigned_staff_id, $5 FROM hair_tasks WHERE id = $1 RETURNING id`,
      [req.params.id, b.followUp.title, b.followUp.nextStep, b.followUp.dueOn, req.user!.id],
    );
    followUp = await getTask(r.id);
  }
  await logAction(req, 'hair_task.update', 'hair_task', req.params.id, b.status ? { status: b.status } : undefined);
  res.json({ task: await getTask(req.params.id), followUp });
}));

hairRouter.delete('/tasks/:id', ah(async (req, res) => {
  const r = await db().one('DELETE FROM hair_tasks WHERE id = $1 RETURNING id', [req.params.id]);
  if (!r) throw notFound('That task');
  await logAction(req, 'hair_task.delete', 'hair_task', req.params.id);
  res.json({ ok: true });
}));
