import { Router } from 'express';
import type { Request } from 'express';
import { calendarScope as scopeOf } from '../auth/scope.js';
import { forbidden, notFound } from '../lib/errors.js';
import { db } from '../db/index.js';
import { addDays, dayBounds } from '../lib/time.js';
import { APPOINTMENT_SELECT, toAppointmentDTO } from '../repos/mappers.js';
import { getSettings } from '../repos/settings.js';
import { ah } from './util.js';

export const appointmentsRouter = Router();

/**
 * "Can view team calendars": the whole salon, or only the team members chosen on the person's account (plus their own).
 * "Their own calendar": only their own. `ids` = whose appointments they may see; limited views hide booked prices.
 */
function calendarScope(req: Request): { ids: string[] | null; limited: boolean } {
  const s = scopeOf(req.user);
  if (!s) throw forbidden();
  return 'all' in s ? { ids: null, limited: false } : { ids: s.ids, limited: true };
}

/** Square appointments (read-only mirror). Filters: from/to or range, staffId, status, service, q. */
appointmentsRouter.get('/', ah(async (req, res) => {
  const { ids, limited } = calendarScope(req);
  const q = req.query as Record<string, string>;
  const s = await getSettings();
  const now = new Date();
  const today = dayBounds(now, s.business.timezone);
  let from = q.from ? new Date(q.from) : today.start;
  let to = q.to ? new Date(q.to) : addDays(today.start, 7);
  switch (q.range) {
    case 'today': from = today.start; to = today.end; break;
    case 'tomorrow': from = today.end; to = addDays(today.end, 1); break;
    case 'upcoming': from = now; to = addDays(now, 90); break;
    case 'past': from = addDays(now, -90); to = now; break;
  }
  const where = ['a.start_at >= $1', 'a.start_at < $2'];
  const p: unknown[] = [from, to];
  // Asking for a team member outside someone's calendars returns nothing from them, whatever the URL says.
  if (ids) { p.push(ids); where.push(`a.staff_id = ANY($${p.length}::uuid[])`); }
  if (q.staffId && /^[0-9a-f-]{36}$/i.test(q.staffId)) { p.push(q.staffId); where.push(`a.staff_id = $${p.length}`); }
  if (q.service) { p.push(`%${q.service}%`); where.push(`EXISTS (SELECT 1 FROM appointment_services x WHERE x.appointment_id = a.id AND x.service_name ILIKE $${p.length})`); }
  if (q.q) { p.push(`%${q.q}%`); where.push(`(c.first_name || ' ' || c.last_name) ILIKE $${p.length}`); }
  const rows = await db().query(`${APPOINTMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.start_at ${q.range === 'past' ? 'DESC' : 'ASC'} LIMIT 1000`, p);
  // Stylists don't see prices (no financial information outside the admin role).
  let appts = rows.map((r) => toAppointmentDTO(r)).map((a) => (limited ? { ...a, bookedValueCents: null } : a));
  if (q.status) appts = appts.filter((a) => q.status.split(',').includes(a.displayStatus));
  if (q.rescheduled === 'true') appts = appts.filter((a) => a.rescheduledFrom);
  res.json({ appointments: appts, from: from.toISOString(), to: to.toISOString() });
}));

/** How close to the appointment a change counts as last minute. */
const LAST_MINUTE_HOURS = 48;
/**
 * Schedule changes (admins): appointment changes from Square, newest first — cancelled (by the salon or the client),
 * rescheduled, given to another stylist, booked, no-show. Filters: from/to (when the change happened), staffId, kind,
 * lastMinute (within 48 hours of the appointment).
 */
appointmentsRouter.get('/changes', ah(async (req, res) => {
  const q = req.query as Record<string, string>;
  const now = new Date();
  const from = /^\d{4}-\d{2}-\d{2}/.test(q.from ?? '') ? new Date(q.from) : addDays(now, -30);
  const to = /^\d{4}-\d{2}-\d{2}/.test(q.to ?? '') ? addDays(new Date(q.to), 1) : addDays(now, 1);
  const kinds = ['cancelled', 'rescheduled', 'staff_changed', 'created', 'no_show'];
  const p: unknown[] = [from, to, kinds];
  const where = ['e.created_at >= $1', 'e.created_at < $2', 'e.event = ANY($3::text[])'];
  if (q.kind && kinds.includes(q.kind)) { p.push(q.kind); where.push(`e.event = $${p.length}`); }
  if (q.staffId && /^[0-9a-f-]{36}$/i.test(q.staffId)) { p.push(q.staffId); where.push(`(a.staff_id = $${p.length} OR e.detail->>'fromStaffId' = $${p.length}::text)`); }
  const rows = await db().query<any>(
    `SELECT e.id, e.event, e.detail, e.created_at, a.id AS appointment_id, a.start_at, a.square_status, a.client_id, a.staff_id,
            trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) AS client_name, s.name AS staff_name, fs.name AS from_staff_name,
            (SELECT string_agg(x.service_name, ', ' ORDER BY x.position) FROM appointment_services x WHERE x.appointment_id = a.id) AS services
       FROM appointment_events e JOIN appointments a ON a.id = e.appointment_id
       LEFT JOIN clients c ON c.id = a.client_id LEFT JOIN staff s ON s.id = a.staff_id
       LEFT JOIN staff fs ON fs.id::text = e.detail->>'fromStaffId'
      WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC LIMIT 1000`, p);
  const changes = rows.map((r) => {
    const d = r.detail ?? {};
    // The appointment time the change was about: the original time for a reschedule.
    const apptAt = new Date(d.fromStartAt ?? d.startAt ?? r.start_at);
    const hoursBefore = (apptAt.getTime() - new Date(r.created_at).getTime()) / 3600_000;
    const status: string = d.status ?? r.square_status;
    return {
      id: r.id, kind: r.event, at: new Date(r.created_at).toISOString(), appointmentId: r.appointment_id,
      clientId: r.client_id, clientName: r.client_name || null, staffName: r.staff_name ?? null, fromStaffName: r.from_staff_name ?? null,
      services: r.services ?? null, startAt: d.startAt ?? new Date(r.start_at).toISOString(), fromStartAt: d.fromStartAt ?? null,
      // Square says who cancelled: the salon (a team member) or the client.
      by: r.event === 'cancelled' ? (status === 'CANCELLED_BY_SELLER' ? 'salon' : status === 'CANCELLED_BY_CUSTOMER' ? 'client' : null) : null,
      hoursBefore: Math.round(hoursBefore * 10) / 10, lastMinute: r.event !== 'created' && hoursBefore >= 0 && hoursBefore <= LAST_MINUTE_HOURS,
    };
  }).filter((c) => q.lastMinute !== 'true' || c.lastMinute);
  res.json({ changes, lastMinuteHours: LAST_MINUTE_HOURS });
}));

appointmentsRouter.get('/:id', ah(async (req, res) => {
  const { ids, limited } = calendarScope(req);
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw notFound('That appointment');
  const row = await db().one<any>(`${APPOINTMENT_SELECT} WHERE a.id = $1`, [req.params.id]);
  // An appointment outside someone's calendars looks the same as a missing one.
  if (!row || (ids && !ids.includes(row.staff_id))) throw notFound('That appointment');
  const events = await db().query('SELECT event, detail, created_at AS "createdAt" FROM appointment_events WHERE appointment_id = $1 ORDER BY created_at', [req.params.id]);
  const appointment = toAppointmentDTO(row);
  res.json({ appointment: limited ? { ...appointment, bookedValueCents: null } : appointment, events });
}));
