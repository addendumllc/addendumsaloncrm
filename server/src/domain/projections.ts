import { db } from '../db/index.js';
import { zonedToUtc } from '../lib/time.js';
import { getSettings } from '../repos/settings.js';
import { addDaysToDate, daysBetween, localDate } from './rebookingSchedule.js';

/**
 * Projected SERVICE revenue: what's expected from salon appointments already booked. Never mixed with product/retail
 * sales or commission, and never presented as collected money.
 *
 * Rules:
 *  - Counts confirmed (ACCEPTED) appointments. Cancelled, declined and no-shows are left out; unconfirmed booking
 *    requests (PENDING) are reported separately as "awaiting confirmation".
 *  - An appointment belongs to the day it starts, in the salon's time zone — so each one is counted once, in exactly
 *    one day/week/month, and a rescheduled appointment simply moves to its new day.
 *  - Its expected value is the booked value from the Square catalog prices of its services (added once each); it's
 *    only known when every service has a price. Otherwise it's "Unestimated": counted, flagged, never added as revenue.
 *  - Averages use priced appointments and the clients who have them, so unknown prices don't drag them down.
 */
export type Bucket = 'day' | 'week' | 'month';

interface Appt { id: string; day: string; clientKey: string; value: number | null }

export interface PeriodTotals {
  from: string; to: string; label: string;
  revenueCents: number;
  appointments: number;            // eligible (confirmed) appointments
  clients: number;                 // unique clients among them
  estimatedAppointments: number;
  unestimatedAppointments: number;
  pricedClients: number;           // unique clients with at least one priced appointment
  avgPerClientCents: number | null;
  avgPerAppointmentCents: number | null;
}

const bounds = (from: string, to: string, tz: string) => {
  const end = addDaysToDate(to, 1);
  return [zonedToUtc(+from.slice(0, 4), +from.slice(5, 7), +from.slice(8, 10), 0, 0, tz), zonedToUtc(+end.slice(0, 4), +end.slice(5, 7), +end.slice(8, 10), 0, 0, tz)] as const;
};
const mondayOf = (d: string) => addDaysToDate(d, -((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7));
const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...o }).format(new Date(`${d}T12:00:00Z`));

function totals(appts: Appt[], from: string, to: string, label: string): PeriodTotals {
  const priced = appts.filter((a) => a.value != null);
  const revenueCents = priced.reduce((n, a) => n + a.value!, 0);
  const clients = new Set(appts.map((a) => a.clientKey)).size;
  const pricedClients = new Set(priced.map((a) => a.clientKey)).size;
  return {
    from, to, label, revenueCents, appointments: appts.length, clients,
    estimatedAppointments: priced.length, unestimatedAppointments: appts.length - priced.length, pricedClients,
    avgPerClientCents: pricedClients ? Math.round(revenueCents / pricedClients) : null,
    avgPerAppointmentCents: priced.length ? Math.round(revenueCents / priced.length) : null,
  };
}

/** Buckets covering [from, to]: days, Monday–Sunday weeks, or months — clipped to the range, never overlapping. */
function buckets(from: string, to: string, by: Bucket) {
  const out: { from: string; to: string; label: string }[] = [];
  let start = from;
  while (start <= to) {
    let end: string;
    let label: string;
    if (by === 'day') { end = start; label = fmt(start, { weekday: 'short', month: 'short', day: 'numeric' }); }
    else if (by === 'week') { end = addDaysToDate(mondayOf(start), 6); label = `Week of ${fmt(mondayOf(start), { month: 'short', day: 'numeric' })}`; }
    else { const next = addDaysToDate(`${start.slice(0, 7)}-28`, 4); end = addDaysToDate(`${next.slice(0, 7)}-01`, -1); label = fmt(start, { month: 'long', year: 'numeric' }); }
    if (end > to) end = to;
    out.push({ from: start, to: end, label });
    start = addDaysToDate(end, 1);
  }
  return out;
}

async function load(from: string, to: string, tz: string) {
  const [start, end] = bounds(from, to, tz);
  const rows = await db().query<any>(
    `SELECT id, client_id, start_at, square_status, booked_value_cents FROM appointments
      WHERE start_at >= $1 AND start_at < $2 AND square_status IN ('ACCEPTED','PENDING')`, [start, end]);
  const toAppt = (r: any): Appt => ({ id: r.id, day: localDate(r.start_at, tz), clientKey: r.client_id ?? `appointment:${r.id}`, value: r.booked_value_cents == null ? null : Number(r.booked_value_cents) });
  return {
    eligible: rows.filter((r) => r.square_status === 'ACCEPTED').map(toAppt),
    pending: rows.filter((r) => r.square_status === 'PENDING').map(toAppt),
  };
}

export async function projections(f: { from: string; to: string; by: Bucket }) {
  const tz = (await getSettings()).business.timezone;
  const { eligible, pending } = await load(f.from, f.to, tz);
  const parts = buckets(f.from, f.to, f.by).map((b) => totals(eligible.filter((a) => a.day >= b.from && a.day <= b.to), b.from, b.to, b.label));
  const p = totals(pending, f.from, f.to, 'Awaiting confirmation');
  return {
    from: f.from, to: f.to, by: f.by, timezone: tz,
    total: totals(eligible, f.from, f.to, 'Total'),
    buckets: parts,
    awaitingConfirmation: { appointments: p.appointments, revenueCents: p.revenueCents, unestimated: p.unestimatedAppointments },
  };
}

/** Appointment-level detail behind the figures (confirmed and awaiting confirmation; cancelled/no-shows left out). */
export async function projectionAppointments(from: string, to: string) {
  const tz = (await getSettings()).business.timezone;
  const [start, end] = bounds(from, to, tz);
  const rows = await db().query<any>(
    `SELECT a.id, a.start_at, a.square_status, a.booked_value_cents, a.client_id, NULLIF(trim(c.first_name || ' ' || c.last_name), '') AS client_name,
            s.name AS staff_name,
            COALESCE((SELECT json_agg(json_build_object('name', x.service_name, 'priceCents', sv.price_cents) ORDER BY x.position)
                        FROM appointment_services x LEFT JOIN services sv ON sv.id = x.service_id WHERE x.appointment_id = a.id), '[]'::json) AS services
       FROM appointments a LEFT JOIN clients c ON c.id = a.client_id LEFT JOIN staff s ON s.id = a.staff_id
      WHERE a.start_at >= $1 AND a.start_at < $2 AND a.square_status IN ('ACCEPTED','PENDING')
      ORDER BY a.start_at LIMIT 2000`, [start, end]);
  return rows.map((r) => ({
    id: r.id, startAt: new Date(r.start_at).toISOString(), day: localDate(r.start_at, tz),
    clientId: r.client_id, clientName: r.client_name ?? 'Walk-in / no client', staffName: r.staff_name,
    services: (typeof r.services === 'string' ? JSON.parse(r.services) : r.services) as { name: string; priceCents: number | null }[],
    expectedCents: r.booked_value_cents == null ? null : Number(r.booked_value_cents),
    status: r.square_status === 'ACCEPTED' ? 'confirmed' : 'awaiting confirmation',
    counted: r.square_status === 'ACCEPTED' && r.booked_value_cents != null,
  }));
}

/** The Dashboard cards: this week, this month, and everything booked from today for 90 days. */
export async function projectionHighlights(now = new Date()) {
  const tz = (await getSettings()).business.timezone;
  const today = localDate(now, tz);
  const monday = mondayOf(today);
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = addDaysToDate(`${addDaysToDate(`${today.slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1);
  const [week, month, future] = await Promise.all([
    projections({ from: monday, to: addDaysToDate(monday, 6), by: 'day' }),
    projections({ from: monthStart, to: monthEnd, by: 'week' }),
    projections({ from: today, to: addDaysToDate(today, 89), by: 'month' }),
  ]);
  return { week: week.total, month: month.total, future: future.total };
}

export const rangeDays = (from: string, to: string) => daysBetween(from, to) + 1;
