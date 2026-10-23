import { db } from '../db/index.js';
import { addHours, DAY, HOUR, formatDateShort, formatTime } from '../lib/time.js';
import { getSettings } from '../repos/settings.js';
import { resolveLegacyRebookTasks, syncRebookingTasks } from './rebookingSchedule.js';
import { autoResolve, createTask } from './tasks.js';

/**
 * Follow-up rules engine. Turns raw Square / lead / message data into follow-up tasks.
 * Every rule uses a dedupe key, so running the engine repeatedly never duplicates work.
 * Rules also auto-resolve follow-ups that are no longer needed (e.g. the client rebooked).
 */
export interface RulesResult {
  created: Record<string, number>;
  resolved: number;
}

let running: Promise<RulesResult> | null = null;

export function runRules(now = new Date()): Promise<RulesResult> {
  if (running) return running;
  running = doRun(now).finally(() => (running = null));
  return running;
}

async function doRun(now: Date): Promise<RulesResult> {
  const s = await getSettings();
  const r = s.rules;
  const tz = s.business.timezone;
  const created: Record<string, number> = {};
  const bump = (k: string, id: string | null) => {
    if (id) created[k] = (created[k] ?? 0) + 1;
  };
  let resolved = 0;

  // ---------- Auto-resolve first ----------
  // Leads that booked (linked to a client with an appointment created after the lead) → mark booked.
  await db().query(
    `UPDATE leads l SET status = 'booked', updated_at = now()
      WHERE l.client_id IS NOT NULL AND l.status NOT IN ('booked','won','lost') AND l.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM appointments a WHERE a.client_id = l.client_id AND a.square_status IN ('ACCEPTED','PENDING')
                    AND COALESCE(a.square_created_at, a.created_at) >= l.created_at - interval '1 day')`,
  );
  resolved += (await autoResolve(
    `lead_id IN (SELECT id FROM leads WHERE status IN ('booked','won','lost') OR archived_at IS NOT NULL) AND type IN ('new_lead','follow_up')`,
    [], 'Auto-closed: client booked or closed.',
  )).length;
  // Cancellation / no-show follow-ups close themselves once the client has a new booking. Per-service rebooking
  // follow-ups are handled by the rebooking schedule below (they close when that service is booked or visited).
  resolved += (await resolveLegacyRebookTasks(now)).length;
  resolved += (await autoResolve(
    `type IN ('cancellation','no_show') AND client_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM appointments a WHERE a.client_id = tasks.client_id AND a.square_status IN ('ACCEPTED','PENDING')
         AND a.start_at >= $1 AND COALESCE(a.square_created_at, a.created_at) >= tasks.created_at - interval '1 hour')`,
    [now], 'Auto-closed: client rebooked in Square ✓',
  )).length;
  // Reminders for appointments that were cancelled or already started.
  resolved += (await autoResolve(
    `type = 'appointment_reminder' AND appointment_id IN (SELECT id FROM appointments WHERE square_status <> 'ACCEPTED' OR start_at <= $1)`,
    [now], 'Auto-closed: appointment changed or started.',
  )).length;

  // ---------- New leads ----------
  const newLeads = await db().query<any>(
    `SELECT id, name, service_interest, source, assigned_staff_id, created_at FROM leads
      WHERE status = 'new' AND archived_at IS NULL AND last_contact_at IS NULL`,
  );
  for (const l of newLeads) {
    bump('new_lead', await createTask({
      type: 'new_lead',
      title: `Contact new client ${l.name}`,
      reason: `New client${l.source ? ` from ${l.source}` : ''}${l.service_interest ? ` — interested in ${l.service_interest}` : ''}.`,
      priority: 'high',
      dueAt: addHours(new Date(l.created_at), r.newLeadHours),
      leadId: l.id,
      assignedStaffId: l.assigned_staff_id,
      sourceRule: 'new_lead',
      dedupeKey: `lead:new:${l.id}`,
      automation: 'new_lead',
    }));
  }

  // ---------- Leads that haven't responded ----------
  const quiet = await db().query<any>(
    `SELECT id, name, service_interest, assigned_staff_id, last_contact_at FROM leads
      WHERE status IN ('contacted','waiting','follow_up_needed','interested') AND archived_at IS NULL
        AND last_contact_at IS NOT NULL AND (last_inbound_at IS NULL OR last_inbound_at < last_contact_at)`,
  );
  for (const l of quiet) {
    const since = (now.getTime() - new Date(l.last_contact_at).getTime()) / HOUR;
    const stamp = new Date(l.last_contact_at).getTime();
    if (since >= r.leadSecondNoResponseHours) {
      // Escalate: if the first nudge is still open, raise it; otherwise create the second follow-up.
      const open = await db().one<any>(`SELECT id FROM tasks WHERE dedupe_key = $1 AND status IN ('due','snoozed')`, [`lead:nr1:${l.id}:${stamp}`]);
      if (open) {
        await db().query(`UPDATE tasks SET priority = 'high', reason = $2, updated_at = now() WHERE id = $1`, [open.id,
          `${l.name} still hasn't replied after ${Math.round(since)} hours.`]);
      } else {
        bump('lead_no_response', await createTask({
          type: 'follow_up', title: `Second follow-up with ${l.name}`,
          reason: `No reply ${Math.round(since / 24)} days after last message${l.service_interest ? ` about ${l.service_interest}` : ''}.`,
          priority: 'high', dueAt: addHours(new Date(l.last_contact_at), r.leadSecondNoResponseHours),
          leadId: l.id, assignedStaffId: l.assigned_staff_id, sourceRule: 'lead_no_response_2', dedupeKey: `lead:nr2:${l.id}:${stamp}`, automation: 'lead_no_response',
        }));
      }
      await db().query(`UPDATE leads SET status = 'follow_up_needed' WHERE id = $1 AND status IN ('contacted','waiting')`, [l.id]);
    } else if (since >= r.leadNoResponseHours) {
      bump('lead_no_response', await createTask({
        type: 'follow_up', title: `Follow up with ${l.name}`,
        reason: `Hasn't replied in ${Math.round(since)} hours${l.service_interest ? ` — asked about ${l.service_interest}` : ''}.`,
        priority: 'medium', dueAt: addHours(new Date(l.last_contact_at), r.leadNoResponseHours),
        leadId: l.id, assignedStaffId: l.assigned_staff_id, sourceRule: 'lead_no_response', dedupeKey: `lead:nr1:${l.id}:${stamp}`, automation: 'lead_no_response',
      }));
    }
  }

  // ---------- Cancellations not rebooked ----------
  if (r.cancellationEnabled) {
    const rows = await db().query<any>(
      `SELECT a.id, a.client_id, a.start_at, COALESCE(a.square_updated_at, a.updated_at) AS changed_at, c.first_name, c.last_name, c.preferred_staff_id,
              (SELECT string_agg(service_name, ', ') FROM appointment_services x WHERE x.appointment_id = a.id) AS services
         FROM appointments a JOIN clients c ON c.id = a.client_id
        WHERE a.square_status IN ('CANCELLED_BY_CUSTOMER','CANCELLED_BY_SELLER') AND c.archived_at IS NULL
          AND COALESCE(a.square_updated_at, a.updated_at) >= $1
          AND NOT EXISTS (SELECT 1 FROM appointments b WHERE b.client_id = a.client_id AND b.square_status IN ('ACCEPTED','PENDING') AND b.start_at >= $2)`,
      [new Date(now.getTime() - 30 * DAY), now],
    );
    for (const a of rows) {
      const name = `${a.first_name} ${a.last_name}`.trim();
      bump('cancellation', await createTask({
        type: 'cancellation', title: `Rebook ${name} after cancellation`,
        reason: `Cancelled ${a.services ?? 'appointment'} (${formatDateShort(a.start_at, tz)}) and hasn't rebooked.`,
        priority: 'medium', dueAt: addHours(new Date(a.changed_at), r.cancellationDelayHours),
        clientId: a.client_id, appointmentId: a.id, assignedStaffId: a.preferred_staff_id,
        sourceRule: 'cancellation', dedupeKey: `appt:cancel:${a.id}`, automation: 'cancelled',
      }));
    }
  }

  // ---------- No-shows ----------
  if (r.noShowEnabled) {
    const rows = await db().query<any>(
      `SELECT a.id, a.client_id, a.start_at, a.staff_id, c.first_name, c.last_name,
              (SELECT string_agg(service_name, ', ') FROM appointment_services x WHERE x.appointment_id = a.id) AS services
         FROM appointments a JOIN clients c ON c.id = a.client_id
        WHERE a.square_status = 'NO_SHOW' AND a.start_at >= $1 AND c.archived_at IS NULL`,
      [new Date(now.getTime() - 7 * DAY)],
    );
    for (const a of rows) {
      bump('no_show', await createTask({
        type: 'no_show', title: `Follow up with ${`${a.first_name} ${a.last_name}`.trim()} (no-show)`,
        reason: `Missed ${a.services ?? 'appointment'} on ${formatDateShort(a.start_at, tz)} at ${formatTime(a.start_at, tz)}.`,
        priority: 'high', dueAt: addHours(new Date(a.start_at), r.noShowDelayHours),
        clientId: a.client_id, appointmentId: a.id, assignedStaffId: a.staff_id,
        sourceRule: 'no_show', dedupeKey: `appt:noshow:${a.id}`, automation: 'no_show',
      }));
    }
  }

  // ---------- Completed appointments: review requests + consultation follow-ups ----------
  const completed = await db().query<any>(
    `SELECT a.id, a.client_id, a.end_at, a.staff_id, c.first_name, c.last_name, c.phone, c.sms_opted_out,
            (SELECT string_agg(service_name, ', ') FROM appointment_services x WHERE x.appointment_id = a.id) AS services
       FROM appointments a JOIN clients c ON c.id = a.client_id
      WHERE a.square_status = 'ACCEPTED' AND a.end_at < $1 AND a.end_at >= $2 AND c.archived_at IS NULL`,
    [now, new Date(now.getTime() - 3 * DAY)],
  );
  for (const a of completed) {
    const name = `${a.first_name} ${a.last_name}`.trim();
    if (/consult/i.test(a.services ?? '')) {
      bump('consultation', await createTask({
        type: 'consultation', title: `Book ${name} after consultation`,
        reason: `Had a consultation (${a.services}). Help them book the service.`, priority: 'high',
        dueAt: addHours(new Date(a.end_at), 2), clientId: a.client_id, appointmentId: a.id, assignedStaffId: a.staff_id,
        sourceRule: 'consultation_completed', dedupeKey: `appt:consult:${a.id}`, automation: 'consultation_completed',
      }));
    } else if (r.reviewRequestEnabled && a.phone && !a.sms_opted_out) {
      // Don't ask the same client for a review more than once every 90 days.
      const recent = await db().one(
        `SELECT 1 FROM tasks WHERE client_id = $1 AND type = 'review_request' AND created_at > $2 LIMIT 1`,
        [a.client_id, new Date(now.getTime() - 90 * DAY)],
      );
      if (!recent) {
        bump('review_request', await createTask({
          type: 'review_request', title: `Ask ${name} for a review`,
          reason: `Visited for ${a.services ?? 'an appointment'} on ${formatDateShort(a.end_at, tz)}.`, priority: 'low',
          dueAt: addHours(new Date(a.end_at), r.reviewDelayHours), clientId: a.client_id, appointmentId: a.id, assignedStaffId: a.staff_id,
          sourceRule: 'review_request', dedupeKey: `appt:review:${a.id}`,
        }));
      }
    }
  }

  // ---------- Rebooking (per service, with per-client custom schedules) ----------
  // Always runs so open follow-ups are adjusted or closed when settings change; each schedule decides whether
  // follow-ups are on (client setting → service default → the global "smart rebooking" switch).
  const rebook = await syncRebookingTasks({}, now);
  if (rebook.created) created.rebook = (created.rebook ?? 0) + rebook.created;
  resolved += rebook.closed;

  // ---------- Appointment reminders (configurable offsets; off by default) ----------
  if (s.reminders.enabled) {
    const maxOffset = Math.max(...s.reminders.offsetsHours, 0);
    const upcoming = await db().query<any>(
      `SELECT a.id, a.client_id, a.start_at, a.staff_id, c.first_name, c.last_name, c.phone, c.sms_opted_out
         FROM appointments a JOIN clients c ON c.id = a.client_id
        WHERE a.square_status = 'ACCEPTED' AND a.start_at > $1 AND a.start_at <= $2 AND a.client_confirmed_at IS NULL`,
      [now, addHours(now, maxOffset)],
    );
    for (const a of upcoming) {
      if (!a.phone || a.sms_opted_out) continue;
      // Only the closest offset that has been reached, so a newly imported appointment gets one reminder, not three.
      const hoursUntil = (new Date(a.start_at).getTime() - now.getTime()) / HOUR;
      const offset = [...s.reminders.offsetsHours].sort((x, y) => x - y).find((o) => hoursUntil <= o);
      if (offset === undefined) continue;
      bump('appointment_reminder', await createTask({
        type: 'appointment_reminder', title: `Send ${offset}h reminder to ${`${a.first_name} ${a.last_name}`.trim()}`,
        reason: `Appointment ${formatDateShort(a.start_at, tz)} at ${formatTime(a.start_at, tz)}.`, priority: 'low',
        dueAt: now, clientId: a.client_id, appointmentId: a.id, assignedStaffId: a.staff_id,
        sourceRule: 'appointment_reminder', dedupeKey: `appt:remind:${a.id}:${offset}`,
      }));
    }
  }

  // ---------- HighLevel: push overdue follow-ups if that automation is on ----------
  if (s.highlevel.automations.follow_up_overdue) {
    await db().query(
      `UPDATE tasks SET hl_status = 'pending', hl_next_retry_at = now(), updated_at = now()
        WHERE status = 'due' AND due_at < $1 AND hl_status = 'not_pushed' AND kind = 'follow_up'`,
      [now],
    );
  }

  const total = Object.values(created).reduce((a, b) => a + b, 0);
  if (total || resolved) {
    await db().query('INSERT INTO automation_runs(rule, created_count, detail) VALUES ($1,$2,$3::jsonb)', [
      'all', total, JSON.stringify({ created, resolved }),
    ]);
  }
  return { created, resolved };
}
