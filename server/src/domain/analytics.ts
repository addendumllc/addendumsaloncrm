import { db } from '../db/index.js';
import { DAY } from '../lib/time.js';
import { getSettings } from '../repos/settings.js';
import { countOverdueClients } from './rebookingSchedule.js';

/** Simple, owner-friendly analytics for the last N days. */
export async function analytics(days: number, now = new Date()) {
  const from = new Date(now.getTime() - days * DAY);
  const s = await getSettings();
  const leads = await db().one<any>(
    `SELECT count(*)::int AS new_leads,
            count(*) FILTER (WHERE status IN ('booked','won') OR client_id IS NOT NULL)::int AS converted
       FROM leads WHERE created_at >= $1`,
    [from],
  );
  const appts = await db().one<any>(
    `SELECT count(*) FILTER (WHERE square_status = 'ACCEPTED' AND end_at < $2)::int AS completed,
            count(*) FILTER (WHERE square_status LIKE 'CANCELLED%')::int AS cancelled,
            count(*) FILTER (WHERE square_status = 'NO_SHOW')::int AS no_shows,
            count(*)::int AS total,
            COALESCE(sum(booked_value_cents) FILTER (WHERE square_status = 'ACCEPTED' AND end_at < $2), 0)::bigint AS value_cents,
            count(*) FILTER (WHERE square_status = 'ACCEPTED' AND end_at < $2 AND booked_value_cents IS NULL)::int AS unpriced
       FROM appointments WHERE start_at >= $1 AND start_at < $2`,
    [from, now],
  );
  // Rebooking rate: of clients with a completed visit in the period, how many have another booking after it.
  const rebook = await db().one<any>(
    `WITH visited AS (
       SELECT client_id, max(start_at) AS last_visit FROM appointments
        WHERE square_status = 'ACCEPTED' AND end_at < $2 AND start_at >= $1 AND client_id IS NOT NULL GROUP BY client_id)
     SELECT count(*)::int AS visited,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM appointments b WHERE b.client_id = v.client_id AND b.start_at > v.last_visit
                                            AND b.square_status IN ('ACCEPTED','PENDING')))::int AS rebooked
       FROM visited v`,
    [from, now],
  );
  const tasks = await db().one<any>(
    `SELECT count(*) FILTER (WHERE status = 'completed' AND completed_at >= $1)::int AS completed,
            count(*) FILTER (WHERE status = 'due' AND due_at < $2)::int AS overdue
       FROM tasks WHERE kind = 'follow_up'`,
    [from, now],
  );
  const popular = await db().query<any>(
    `SELECT x.service_name AS name, count(*)::int AS count FROM appointment_services x JOIN appointments a ON a.id = x.appointment_id
      WHERE a.start_at >= $1 AND a.start_at < $2 AND a.square_status = 'ACCEPTED' GROUP BY x.service_name ORDER BY count DESC LIMIT 8`,
    [from, now],
  );
  const newVsReturning = await db().one<any>(
    `WITH firsts AS (SELECT client_id, min(start_at) AS first_visit FROM appointments WHERE square_status = 'ACCEPTED' AND client_id IS NOT NULL GROUP BY client_id),
          visited AS (SELECT DISTINCT client_id FROM appointments WHERE square_status = 'ACCEPTED' AND start_at >= $1 AND start_at < $2 AND client_id IS NOT NULL)
     SELECT count(*) FILTER (WHERE f.first_visit >= $1)::int AS new_clients, count(*) FILTER (WHERE f.first_visit < $1)::int AS returning_clients
       FROM visited v JOIN firsts f USING (client_id)`,
    [from, now],
  );
  const weekly = await db().query<any>(
    `SELECT date_trunc('week', start_at) AS week,
            count(*) FILTER (WHERE square_status = 'ACCEPTED')::int AS completed,
            count(*) FILTER (WHERE square_status LIKE 'CANCELLED%')::int AS cancelled,
            count(*) FILTER (WHERE square_status = 'NO_SHOW')::int AS no_shows
       FROM appointments WHERE start_at >= $1 AND start_at < $2 GROUP BY 1 ORDER BY 1`,
    [from, now],
  );
  const weeklyLeads = await db().query<any>(
    `SELECT date_trunc('week', created_at) AS week, count(*)::int AS leads FROM leads WHERE created_at >= $1 GROUP BY 1 ORDER BY 1`, [from]);
  const leadMap = new Map(weeklyLeads.map((w) => [new Date(w.week).toISOString(), w.leads]));
  const overdue = await countOverdueClients(now);

  return {
    days,
    newLeads: leads.new_leads,
    leadsConverted: leads.converted,
    conversionRate: leads.new_leads ? leads.converted / leads.new_leads : null,
    appointments: appts.total,
    completed: appts.completed,
    cancellations: appts.cancelled,
    noShows: appts.no_shows,
    rebookingRate: rebook.visited ? rebook.rebooked / rebook.visited : null,
    overdueForRebooking: overdue,
    followUpsCompleted: tasks.completed,
    followUpsOverdue: tasks.overdue,
    // Booked service value from Square catalog prices — NOT payments collected (tips, discounts, retail excluded).
    bookedValueCents: Number(appts.value_cents),
    bookedValueIncomplete: appts.unpriced > 0,
    popularServices: popular,
    newClients: newVsReturning?.new_clients ?? 0,
    returningClients: newVsReturning?.returning_clients ?? 0,
    weekly: weekly.map((w) => ({
      week: new Date(w.week).toISOString(), completed: w.completed, cancelled: w.cancelled, noShows: w.no_shows,
      leads: leadMap.get(new Date(w.week).toISOString()) ?? 0,
    })),
  };
}
