import type { HighLevelSyncStatus } from '@addendum/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { badRequest, IntegrationError } from '../lib/errors.js';
import { formatDateShort, formatTime } from '../lib/time.js';
import { formatPhone } from '../lib/phone.js';
import { highLevelService } from '../integrations/registry.js';
import { getSettings } from '../repos/settings.js';

/**
 * Pushes an internal follow-up to HighLevel as a contact task.
 * - Contact matching order: stored HighLevel contact ID → phone → email → (optionally) create.
 * - Stores HighLevel contact ID + task ID, so pushing again updates the same task (no duplicates).
 * - Failures never lose the follow-up: it stays saved internally and is retried with backoff.
 */
export interface PushResult {
  status: HighLevelSyncStatus;
  message: string;
  needsContact?: boolean;
  taskId?: string;
  contactId?: string;
}

const MAX_AUTO_ATTEMPTS = 8;

export async function pushTaskToHighLevel(taskId: string, opts: { createContactIfMissing?: boolean } = {}): Promise<PushResult> {
  const hl = highLevelService();
  if (!hl) throw badRequest("HighLevel isn't connected yet. Add it in Settings → GoHighLevel.");
  const settings = await getSettings();
  const t = await db().one<any>(
    `SELECT t.*, s.highlevel_user_id,
            c.first_name, c.last_name, c.phone AS c_phone, c.email AS c_email, c.highlevel_contact_id AS c_hl,
            l.name AS lead_name, l.phone AS l_phone, l.email AS l_email, l.highlevel_contact_id AS l_hl, l.service_interest
       FROM tasks t LEFT JOIN staff s ON s.id = t.assigned_staff_id
       LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN leads l ON l.id = t.lead_id
      WHERE t.id = $1`,
    [taskId],
  );
  if (!t) throw badRequest('That follow-up no longer exists.');
  if (!t.client_id && !t.lead_id) throw badRequest('Only follow-ups linked to a client or lead can be pushed to HighLevel.');

  const phone: string | null = t.c_phone ?? t.l_phone ?? null;
  const email: string | null = t.c_email ?? t.l_email ?? null;
  const name: string = t.client_id ? `${t.first_name} ${t.last_name}`.trim() : t.lead_name;

  await db().query(`UPDATE tasks SET hl_status = 'pending', hl_last_attempt_at = now(), hl_attempts = hl_attempts + 1 WHERE id = $1`, [taskId]);
  try {
    // 1) Resolve the HighLevel contact.
    let contactId: string | null = t.hl_contact_id ?? t.c_hl ?? t.l_hl ?? null;
    if (contactId && !(await hl.contactExists(contactId))) contactId = null;
    if (!contactId) contactId = await hl.findContact({ phone, email });
    if (!contactId) {
      if (!opts.createContactIfMissing) {
        await setStatus(taskId, 'needs_contact', `No matching HighLevel contact for ${name}.`, null);
        return { status: 'needs_contact', needsContact: true, message: `No HighLevel contact matches ${name}. Create one?` };
      }
      const [firstName, ...rest] = name.split(' ');
      contactId = await hl.createContact({ firstName, lastName: rest.join(' '), phone, email, tags: ['addendum-crm'] });
    }
    if (t.client_id) await db().query('UPDATE clients SET highlevel_contact_id = $2 WHERE id = $1', [t.client_id, contactId]);
    if (t.lead_id) await db().query('UPDATE leads SET highlevel_contact_id = $2 WHERE id = $1', [t.lead_id, contactId]);

    // 2) Create or update the task.
    const payload = {
      title: `[${t.priority[0].toUpperCase()}${t.priority.slice(1)}] ${t.title}`,
      body: await buildDescription(t, phone, email, settings.business.timezone),
      dueDate: new Date(t.due_at).toISOString(),
      assignedTo: t.highlevel_user_id ?? settings.highlevel.defaultAssigneeUserId ?? null,
    };
    let hlTaskId: string = t.hl_task_id;
    if (hlTaskId && t.hl_contact_id === contactId) {
      await hl.updateTask(contactId, hlTaskId, { ...payload, assignedTo: payload.assignedTo ?? undefined, completed: t.status === 'completed' });
    } else {
      hlTaskId = await hl.createTask(contactId, payload);
    }
    await db().query(
      `UPDATE tasks SET hl_status = 'synced', hl_task_id = $2, hl_contact_id = $3, hl_last_synced_at = now(), hl_error = NULL,
         hl_next_retry_at = NULL, updated_at = now() WHERE id = $1`,
      [taskId, hlTaskId, contactId],
    );
    return { status: 'synced', message: 'Added to HighLevel', taskId: hlTaskId, contactId };
  } catch (e) {
    const ie = e instanceof IntegrationError ? e : new IntegrationError('highlevel', 'HighLevel task could not be created. It will be retried.', true, false, String(e));
    console.error('[highlevel] push failed:', ie.technical ?? ie.message);
    const attempts = (t.hl_attempts ?? 0) + 1;
    const retryAt = ie.retryable && attempts < MAX_AUTO_ATTEMPTS ? new Date(Date.now() + Math.min(2 ** attempts, 360) * 60_000) : null;
    await setStatus(taskId, 'failed', ie.userMessage, retryAt);
    return { status: 'failed', message: ie.retryable ? 'HighLevel task could not be created. It will be retried.' : ie.userMessage };
  }
}

async function setStatus(taskId: string, status: HighLevelSyncStatus, error: string | null, retryAt: Date | null) {
  await db().query('UPDATE tasks SET hl_status = $2, hl_error = $3, hl_next_retry_at = $4, updated_at = now() WHERE id = $1', [taskId, status, error, retryAt]);
}

async function buildDescription(t: any, phone: string | null, email: string | null, tz: string) {
  const lines: string[] = [];
  if (t.reason) lines.push(t.reason);
  if (t.notes) lines.push(`Notes: ${t.notes}`);
  if (t.service_interest) lines.push(`Interested in: ${t.service_interest}`);
  if (t.client_id) {
    const last = await db().one<any>(
      `SELECT a.start_at, (SELECT string_agg(service_name, ', ') FROM appointment_services x WHERE x.appointment_id = a.id) AS s
         FROM appointments a WHERE a.client_id = $1 AND a.square_status = 'ACCEPTED' AND a.end_at < now() ORDER BY a.start_at DESC LIMIT 1`,
      [t.client_id],
    );
    const next = await db().one<any>(
      `SELECT a.start_at, (SELECT string_agg(service_name, ', ') FROM appointment_services x WHERE x.appointment_id = a.id) AS s
         FROM appointments a WHERE a.client_id = $1 AND a.square_status IN ('ACCEPTED','PENDING') AND a.start_at >= now() ORDER BY a.start_at LIMIT 1`,
      [t.client_id],
    );
    if (last) lines.push(`Last Square appointment: ${formatDateShort(last.start_at, tz)} — ${last.s ?? 'service'}`);
    if (next) lines.push(`Next Square appointment: ${formatDateShort(next.start_at, tz)} at ${formatTime(next.start_at, tz)} — ${next.s ?? 'service'}`);
  }
  if (phone) lines.push(`Phone: ${formatPhone(phone)}`);
  if (email) lines.push(`Email: ${email}`);
  lines.push(`Priority: ${t.priority}`);
  lines.push(`Open in Addendum Salon: ${config().APP_URL.replace(/\/$/, '')}/follow-ups?task=${t.id}`);
  return lines.join('\n');
}

/** Mirror completion to HighLevel (best effort; failure is shown on the task, never blocks completing it). */
export async function syncCompletionToHighLevel(taskId: string, completed: boolean) {
  const t = await db().one<any>('SELECT hl_task_id, hl_contact_id FROM tasks WHERE id = $1', [taskId]);
  if (!t?.hl_task_id || !t.hl_contact_id) return;
  const hl = highLevelService();
  if (!hl) return;
  try {
    await hl.setTaskCompleted(t.hl_contact_id, t.hl_task_id, completed);
    await db().query('UPDATE tasks SET hl_last_synced_at = now(), hl_error = NULL WHERE id = $1', [taskId]);
  } catch (e) {
    await db().query(`UPDATE tasks SET hl_error = $2 WHERE id = $1`, [taskId, 'Completed here, but HighLevel could not be updated. Use Retry.']);
  }
}

/** Background worker: retries pending/failed pushes whose retry time has come. */
export async function processHighLevelQueue(limit = 20) {
  if (!highLevelService()) return 0;
  const settings = await getSettings();
  const due = await db().query<{ id: string }>(
    `SELECT id FROM tasks WHERE hl_status IN ('pending','failed') AND hl_next_retry_at IS NOT NULL AND hl_next_retry_at <= now()
       AND status <> 'cancelled' ORDER BY hl_next_retry_at LIMIT $1`,
    [limit],
  );
  for (const { id } of due) await pushTaskToHighLevel(id, { createContactIfMissing: settings.highlevel.autoCreateContacts });
  return due.length;
}
