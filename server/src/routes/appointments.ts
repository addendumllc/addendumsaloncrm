import { Router } from 'express';
import type { Request } from 'express';
import { can } from '../auth/permissions.js';
import { forbidden, notFound } from '../lib/errors.js';
import { db } from '../db/index.js';
import { addDays, dayBounds } from '../lib/time.js';
import { APPOINTMENT_SELECT, toAppointmentDTO } from '../repos/mappers.js';
import { getSettings } from '../repos/settings.js';
import { ah } from './util.js';

export const appointmentsRouter = Router();

/** Everyone with "appointments:read" sees the whole salon; stylists ("appointments:read_own") only see their own. */
function calendarScope(req: Request): { ownOnly: boolean } {
  if (can(req.user, 'appointments:read')) return { ownOnly: false };
  if (can(req.user, 'appointments:read_own')) return { ownOnly: true };
  throw forbidden();
}

/** Square appointments (read-only mirror). Filters: from/to or range, staffId, status, service, q. */
appointmentsRouter.get('/', ah(async (req, res) => {
  const { ownOnly } = calendarScope(req);
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
  // A stylist's staffId filter is ignored: it is always their own.
  const staffId = ownOnly ? req.user!.id : q.staffId;
  if (staffId) { p.push(staffId); where.push(`a.staff_id = $${p.length}`); }
  if (q.service) { p.push(`%${q.service}%`); where.push(`EXISTS (SELECT 1 FROM appointment_services x WHERE x.appointment_id = a.id AND x.service_name ILIKE $${p.length})`); }
  if (q.q) { p.push(`%${q.q}%`); where.push(`(c.first_name || ' ' || c.last_name) ILIKE $${p.length}`); }
  const rows = await db().query(`${APPOINTMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.start_at ${q.range === 'past' ? 'DESC' : 'ASC'} LIMIT 1000`, p);
  // Stylists don't see prices (no financial information outside the admin role).
  let appts = rows.map((r) => toAppointmentDTO(r)).map((a) => (ownOnly ? { ...a, bookedValueCents: null } : a));
  if (q.status) appts = appts.filter((a) => q.status.split(',').includes(a.displayStatus));
  if (q.rescheduled === 'true') appts = appts.filter((a) => a.rescheduledFrom);
  res.json({ appointments: appts, from: from.toISOString(), to: to.toISOString() });
}));

appointmentsRouter.get('/:id', ah(async (req, res) => {
  const { ownOnly } = calendarScope(req);
  const row = await db().one<any>(`${APPOINTMENT_SELECT} WHERE a.id = $1`, [req.params.id]);
  // Someone else's appointment looks the same as a missing one to a stylist.
  if (!row || (ownOnly && row.staff_id !== req.user!.id)) throw notFound('That appointment');
  const events = await db().query('SELECT event, detail, created_at AS "createdAt" FROM appointment_events WHERE appointment_id = $1 ORDER BY created_at', [req.params.id]);
  const appointment = toAppointmentDTO(row);
  res.json({ appointment: ownOnly ? { ...appointment, bookedValueCents: null } : appointment, events });
}));
