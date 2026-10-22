import type { HighLevelAutomationKey, Priority, TaskBusiness, TaskDTO, TaskKind, TaskType } from '@addendum/shared';
import { db } from '../db/index.js';
import { notFound } from '../lib/errors.js';
import { TASK_SELECT, toTaskDTO } from '../repos/mappers.js';
import { getKV, getSettings, setKV } from '../repos/settings.js';

export interface NewTask {
  kind?: TaskKind;
  /** Internal tasks: Addendum Salon (default) or Addendum Hair. */
  business?: TaskBusiness;
  type: TaskType;
  title: string;
  reason?: string | null;
  notes?: string | null;
  priority?: Priority;
  /** null: no due date (internal tasks only). */
  dueAt: Date | null;
  clientId?: string | null;
  leadId?: string | null;
  appointmentId?: string | null;
  assignedStaffId?: string | null;
  sourceRule?: string | null;
  dedupeKey?: string | null;
  createdBy?: string | null;
  /** Which HighLevel automation (if any) this task belongs to. */
  automation?: HighLevelAutomationKey | null;
}

/** Creates a task; returns null if a task with the same dedupe key already exists. */
export async function createTask(t: NewTask): Promise<string | null> {
  // An automatic follow-up someone deleted isn't created again.
  if (t.dedupeKey && (await db().one('SELECT 1 FROM deleted_task_keys WHERE dedupe_key = $1', [t.dedupeKey]))) return null;
  const settings = await getSettings();
  const autoPush = t.automation ? settings.highlevel.automations[t.automation] : false;
  const rows = await db().query<{ id: string }>(
    `INSERT INTO tasks(kind, type, title, reason, notes, priority, due_at, client_id, lead_id, appointment_id,
        assigned_staff_id, source_rule, dedupe_key, created_by_staff_id, hl_status, hl_next_retry_at, business)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [
      t.kind ?? 'follow_up', t.type, t.title, t.reason ?? null, t.notes ?? null, t.priority ?? 'medium', t.dueAt,
      t.clientId ?? null, t.leadId ?? null, t.appointmentId ?? null, t.assignedStaffId ?? null, t.sourceRule ?? null,
      t.dedupeKey ?? null, t.createdBy ?? null, autoPush ? 'pending' : 'not_pushed', autoPush ? new Date() : null,
      t.kind === 'task' ? t.business ?? 'salon' : 'salon',
    ],
  );
  return rows[0]?.id ?? null;
}

export async function getTask(id: string): Promise<TaskDTO> {
  const row = await db().one(`${TASK_SELECT} WHERE t.id = $1`, [id]);
  if (!row) throw notFound('That follow-up');
  return toTaskDTO(row);
}

export interface TaskFilters {
  status?: string;
  kind?: TaskKind;
  business?: TaskBusiness;
  type?: string;
  priority?: string;
  assignedStaffId?: string;
  clientId?: string;
  leadId?: string;
  due?: 'today' | 'overdue' | 'upcoming' | 'all';
  hlStatus?: string;
  q?: string;
  limit?: number;
  /** Finished on or after this date (e.g. Follow-ups → Done: the last 6 months). */
  completedSince?: string;
}

export async function listTasks(f: TaskFilters, tzEndOfToday?: Date): Promise<TaskDTO[]> {
  const where: string[] = [];
  const p: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    p.push(v);
    where.push(sql.replace('?', `$${p.length}`));
  };
  // Snoozed tasks whose snooze has ended count as due again.
  if (f.status === 'open' || !f.status) where.push(`(t.status = 'due' OR (t.status = 'snoozed' AND t.snoozed_until <= now()))`);
  else if (f.status !== 'any') add('t.status = ?', f.status);
  if (f.kind) add('t.kind = ?', f.kind);
  if (f.business) add('t.business = ?', f.business);
  if (f.type) add('t.type = ?', f.type);
  if (f.priority) add('t.priority = ?', f.priority);
  if (f.assignedStaffId) add('t.assigned_staff_id = ?', f.assignedStaffId);
  if (f.clientId) add('t.client_id = ?', f.clientId);
  if (f.leadId) add('t.lead_id = ?', f.leadId);
  if (f.hlStatus) add('t.hl_status = ?', f.hlStatus);
  if (f.completedSince) add('t.completed_at >= ?::date', f.completedSince);
  if (f.q) add(`(t.title ILIKE ? OR COALESCE(t.reason,'') ILIKE $${p.length + 1} OR COALESCE(c.first_name || ' ' || c.last_name, l.name, '') ILIKE $${p.length + 1})`, `%${f.q}%`);
  if (f.due === 'overdue') where.push('t.due_at < now()');
  if (f.due === 'today' && tzEndOfToday) add('t.due_at < ?', tzEndOfToday);
  if (f.due === 'upcoming' && tzEndOfToday) add('t.due_at >= ?', tzEndOfToday);
  const sql = `${TASK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.due_at ASC NULLS LAST LIMIT ${Math.min(f.limit ?? 300, 1000)}`;
  return (await db().query(sql, p)).map((r) => toTaskDTO(r));
}

export async function completeTask(id: string, staffId: string | null, note?: string) {
  await db().query(
    `UPDATE tasks SET status = 'completed', completed_at = now(), completed_by_staff_id = $2,
       notes = CASE WHEN $3::text IS NULL THEN notes ELSE trim(COALESCE(notes,'') || E'\n' || $3::text) END, updated_at = now()
     WHERE id = $1`,
    [id, staffId, note ?? null],
  );
}

/** Auto-resolve: completes open tasks matching a condition, e.g. when the client rebooks in Square. */
export async function autoResolve(whereSql: string, params: unknown[], note: string) {
  const rows = await db().query<{ id: string }>(
    `UPDATE tasks SET status = 'completed', completed_at = now(), notes = trim(COALESCE(notes,'') || E'\n' || $${params.length + 1}), updated_at = now()
      WHERE status IN ('due','snoozed') AND ${whereSql} RETURNING id`,
    [...params, note],
  );
  return rows.map((r) => r.id);
}

/** Tasks → Done: finished internal tasks are deleted once they're this many months old (6–12; null keeps them). */
export interface TaskRetention { months: 6 | 9 | 12 | null; lastRunAt: string | null; lastRemoved: number }
const RETENTION_KEY = 'tasks.retention';
export const getTaskRetention = async (): Promise<TaskRetention> => ({ months: 12, lastRunAt: null, lastRemoved: 0, ...((await getKV<Partial<TaskRetention>>(RETENTION_KEY)) ?? {}) });
export async function setTaskRetention(months: TaskRetention['months']) {
  const next = { ...(await getTaskRetention()), months };
  await setKV(RETENTION_KEY, next);
  return next;
}

/** Deletes internal tasks finished (completed or cancelled) more than the chosen months ago. Client follow-ups are kept. */
export async function purgeOldInternalTasks(now = new Date()) {
  const r = await getTaskRetention();
  if (!r.months) return 0;
  const removed = await db().query<{ id: string }>(
    `DELETE FROM tasks WHERE kind = 'task' AND status IN ('completed','cancelled')
       AND COALESCE(completed_at, updated_at) < $1::timestamptz - make_interval(months => $2) RETURNING id`, [now.toISOString(), r.months]);
  await setKV(RETENTION_KEY, { ...r, lastRunAt: now.toISOString(), lastRemoved: removed.length });
  return removed.length;
}

/** Scheduler: once a day. */
export async function maybePurgeOldInternalTasks() {
  const r = await getTaskRetention();
  if (r.lastRunAt && Date.now() - Date.parse(r.lastRunAt) < 24 * 3600_000) return;
  await purgeOldInternalTasks();
}
