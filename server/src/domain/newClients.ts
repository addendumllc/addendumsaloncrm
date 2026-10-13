import type { NewClientApptDTO, NewClientRowDTO, NewClientStatsDTO, RebookStatus } from '@addendum/shared';
import { db } from '../db/index.js';
import { iso, zonedToUtc } from '../lib/time.js';
import { getSettings } from '../repos/settings.js';
import { addDaysToDate } from './rebookingSchedule.js';

/**
 * New-client acquisition and rebooking, worked out from the Square appointment mirror on every request
 * (so counts follow bookings, cancellations and no-shows as soon as they sync).
 *
 * Counting rules:
 *  - A client's first visit is their earliest appointment that wasn't cancelled or declined (ACCEPTED or NO_SHOW).
 *    They are a new client in the period that first visit falls in, credited to that appointment's stylist.
 *  - Square history only goes back so far. A client whose Square profile is older than the CRM's history
 *    (minus PRE_HISTORY_GRACE) had visits we can't see, so they count as existing, never as new.
 *  - A rebooking is a later ACCEPTED appointment. Cancelled, declined, no-show and unconfirmed (PENDING) ones never count.
 *  - "Future" means a rebooking that hasn't started yet. Totals count each client once; appointment totals are separate.
 */
const PRE_HISTORY_GRACE_DAYS = 60;

interface Row {
  client_id: string; name: string;
  first_id: string; first_at: Date; first_status: string; first_staff_id: string | null; first_staff_name: string | null;
  later_count: number; done_count: number; future_count: number; first_rebook_at: Date | null;
  next_id: string | null; next_at: Date | null; next_staff_id: string | null; next_staff_name: string | null;
}

export async function newClientStats(f: { from: string; to: string; staffId: string | null }, now = new Date()): Promise<NewClientStatsDTO> {
  const tz = (await getSettings()).business.timezone;
  const start = zonedToUtc(+f.from.slice(0, 4), +f.from.slice(5, 7), +f.from.slice(8, 10), 0, 0, tz);
  const endKey = addDaysToDate(f.to, 1);
  const end = zonedToUtc(+endKey.slice(0, 4), +endKey.slice(5, 7), +endKey.slice(8, 10), 0, 0, tz);

  const firsts = `
    hist AS (SELECT min(start_at) AS start FROM appointments),
    firsts AS (
      SELECT DISTINCT ON (a.client_id) a.client_id, a.id, a.start_at, a.staff_id, a.square_status
        FROM appointments a
       WHERE a.client_id IS NOT NULL AND a.square_status IN ('ACCEPTED','NO_SHOW')
       ORDER BY a.client_id, a.start_at, a.id),
    newc AS (
      SELECT f.* FROM firsts f JOIN clients c ON c.id = f.client_id CROSS JOIN hist
       WHERE c.created_at >= hist.start - make_interval(days => ${PRE_HISTORY_GRACE_DAYS}))`;

  const rows = await db().query<Row>(
    `WITH ${firsts}
     SELECT n.client_id, NULLIF(trim(c.first_name || ' ' || c.last_name), '') AS name,
            n.id AS first_id, n.start_at AS first_at, n.square_status AS first_status, n.staff_id AS first_staff_id, s.name AS first_staff_name,
            r.later_count, r.done_count, r.future_count, r.first_rebook_at,
            nx.id AS next_id, nx.start_at AS next_at, nx.staff_id AS next_staff_id, ns.name AS next_staff_name
       FROM newc n
       JOIN clients c ON c.id = n.client_id
       LEFT JOIN staff s ON s.id = n.staff_id
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS later_count,
                count(*) FILTER (WHERE b.start_at <= $3)::int AS done_count,
                count(*) FILTER (WHERE b.start_at > $3)::int AS future_count,
                min(b.start_at) AS first_rebook_at
           FROM appointments b
          WHERE b.client_id = n.client_id AND b.start_at > n.start_at AND b.square_status = 'ACCEPTED') r
       LEFT JOIN LATERAL (
         SELECT b.id, b.start_at, b.staff_id FROM appointments b
          WHERE b.client_id = n.client_id AND b.start_at > n.start_at AND b.start_at > $3 AND b.square_status = 'ACCEPTED'
          ORDER BY b.start_at, b.id LIMIT 1) nx ON true
       LEFT JOIN staff ns ON ns.id = nx.staff_id
      WHERE n.start_at >= $1 AND n.start_at < $2
      ORDER BY n.start_at DESC, n.client_id`,
    [start, end, now],
  );

  const apptIds = [...new Set(rows.flatMap((r) => [r.first_id, r.next_id]).filter(Boolean))] as string[];
  const services = new Map<string, string[]>();
  if (apptIds.length) {
    const svc = await db().query<{ appointment_id: string; service_name: string }>(
      'SELECT appointment_id, service_name FROM appointment_services WHERE appointment_id = ANY($1::uuid[]) ORDER BY appointment_id, position', [apptIds]);
    for (const x of svc) services.set(x.appointment_id, [...(services.get(x.appointment_id) ?? []), x.service_name]);
  }
  const appt = (id: string, at: Date, staffId: string | null, staffName: string | null): NewClientApptDTO =>
    ({ id, startAt: iso(at)!, staffId, staffName, serviceNames: services.get(id) ?? [] });

  const all: NewClientRowDTO[] = rows.map((r) => {
    const rebookStatus: RebookStatus = r.future_count > 0 ? 'future' : r.later_count > 0 ? 'returned' : 'not_rebooked';
    const state = r.first_status === 'NO_SHOW' ? 'no_show' : new Date(r.first_at) > now ? 'upcoming' : 'completed';
    return {
      clientId: r.client_id,
      clientName: r.name ?? 'Client',
      first: { ...appt(r.first_id, r.first_at, r.first_staff_id, r.first_staff_name), state },
      rebookStatus,
      laterVisits: r.done_count,
      futureAppointments: r.future_count,
      firstRebookAt: iso(r.first_rebook_at),
      next: r.next_id ? appt(r.next_id, r.next_at!, r.next_staff_id, r.next_staff_name) : null,
    };
  });

  // Per stylist, always across the whole team so the comparison stays visible while a stylist filter is on.
  const byStaff = new Map<string, NewClientStatsDTO['byStylist'][number]>();
  for (const c of all) {
    const k = c.first.staffId ?? '';
    const b = byStaff.get(k) ?? { staffId: c.first.staffId, staffName: c.first.staffName ?? 'No stylist', newClients: 0, rebooked: 0, withFuture: 0 };
    b.newClients++;
    if (c.rebookStatus !== 'not_rebooked') b.rebooked++;
    if (c.rebookStatus === 'future') b.withFuture++;
    byStaff.set(k, b);
  }

  const clients = f.staffId ? all.filter((c) => c.first.staffId === f.staffId) : all;

  // Existing clients seen in these dates: an appointment here, but their first visit was earlier (or before our history).
  const returning = await db().one<{ clients: number; appointments: number }>(
    `WITH ${firsts}
     SELECT count(DISTINCT a.client_id)::int AS clients, count(*)::int AS appointments
       FROM appointments a LEFT JOIN newc n ON n.client_id = a.client_id
      WHERE a.client_id IS NOT NULL AND a.square_status IN ('ACCEPTED','NO_SHOW')
        AND a.start_at >= $1 AND a.start_at < $2 AND ($3::uuid IS NULL OR a.staff_id = $3)
        AND (n.client_id IS NULL OR n.start_at < $1)`,
    [start, end, f.staffId],
  );
  const hist = await db().one<{ start: Date | null }>('SELECT min(start_at) AS start FROM appointments');

  return {
    from: f.from,
    to: f.to,
    staffId: f.staffId,
    summary: {
      newClients: clients.length,
      rebooked: clients.filter((c) => c.rebookStatus !== 'not_rebooked').length,
      rebookedAppointments: clients.reduce((n, c) => n + c.laterVisits + c.futureAppointments, 0),
      withFuture: clients.filter((c) => c.rebookStatus === 'future').length,
      futureAppointments: clients.reduce((n, c) => n + c.futureAppointments, 0),
      returningClients: returning?.clients ?? 0,
      returningAppointments: returning?.appointments ?? 0,
    },
    byStylist: [...byStaff.values()].sort((a, b) => b.newClients - a.newClients || a.staffName.localeCompare(b.staffName)),
    clients,
    historyStart: iso(hist?.start),
  };
}
