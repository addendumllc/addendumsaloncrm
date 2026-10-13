import type { RebookingInsight } from '@addendum/shared';
import { db } from '../db/index.js';
import { DAY } from '../lib/time.js';

/**
 * Smart rebooking from Square history. A client's typical cadence is the median gap between
 * their recent completed visits (gaps under 7 days — e.g. same-week touch-ups — are ignored).
 * Without enough history we make no assumption and say so.
 */
export function computeRebooking(
  visitStarts: Date[],
  hasFutureAppointment: boolean,
  opts: { minVisits: number; graceDays: number },
  now = new Date(),
): RebookingInsight {
  const visits = [...visitStarts].sort((a, b) => a.getTime() - b.getTime());
  const last = visits.at(-1) ?? null;
  const daysSinceLast = last ? Math.floor((now.getTime() - last.getTime()) / DAY) : null;
  const base = { visits: visits.length, daysSinceLast, hasFutureAppointment };

  if (visits.length < Math.max(2, opts.minVisits)) {
    return {
      ...base,
      enough: false,
      typicalIntervalDays: null,
      overdueByDays: null,
      isOverdue: false,
      message: visits.length === 0 ? 'No completed Square visits yet.' : `Not enough history to predict (${visits.length} visit${visits.length === 1 ? '' : 's'}).`,
    };
  }
  const gaps: number[] = [];
  for (let i = 1; i < visits.length; i++) {
    const g = (visits[i].getTime() - visits[i - 1].getTime()) / DAY;
    if (g >= 7) gaps.push(g);
  }
  const recent = gaps.slice(-5).sort((a, b) => a - b);
  if (recent.length === 0) {
    return { ...base, enough: false, typicalIntervalDays: null, overdueByDays: null, isOverdue: false, message: 'Not enough spacing between visits to predict.' };
  }
  const mid = Math.floor(recent.length / 2);
  const typical = Math.round(recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2);
  const overdueBy = daysSinceLast! - typical;
  const isOverdue = !hasFutureAppointment && overdueBy >= opts.graceDays;
  const weeks = (d: number) => (d % 7 === 0 || d >= 21 ? `${Math.round(d / 7)} weeks` : `${d} days`);
  return {
    ...base,
    enough: true,
    typicalIntervalDays: typical,
    overdueByDays: overdueBy,
    isOverdue,
    message: hasFutureAppointment
      ? `Usually books every ${weeks(typical)} · next visit already booked.`
      : `Usually books every ${weeks(typical)} · last visit ${weeks(daysSinceLast!)} ago.`,
  };
}

/** Rebooking insight for every non-archived client that has Square history. */
export async function allRebookingInsights(opts: { minVisits: number; graceDays: number }, now = new Date()) {
  const rows = await db().query<{ client_id: string; starts: Date[]; has_future: boolean; last_appointment_id: string }>(
    `SELECT a.client_id,
            array_agg(a.start_at ORDER BY a.start_at) FILTER (WHERE a.square_status = 'ACCEPTED' AND a.end_at < $1) AS starts,
            bool_or(a.square_status IN ('ACCEPTED','PENDING') AND a.start_at >= $1) AS has_future,
            (array_agg(a.id ORDER BY a.start_at DESC) FILTER (WHERE a.square_status = 'ACCEPTED' AND a.end_at < $1))[1] AS last_appointment_id
       FROM appointments a JOIN clients c ON c.id = a.client_id
      WHERE c.archived_at IS NULL
      GROUP BY a.client_id`,
    [now],
  );
  return rows.map((r) => ({
    clientId: r.client_id,
    lastAppointmentId: r.last_appointment_id,
    insight: computeRebooking((r.starts ?? []).map((d) => new Date(d)), !!r.has_future, opts, now),
  }));
}

export async function clientRebooking(clientId: string, opts: { minVisits: number; graceDays: number }, now = new Date()) {
  const rows = await db().query<{ start_at: Date; square_status: string; end_at: Date }>(
    'SELECT start_at, end_at, square_status FROM appointments WHERE client_id = $1',
    [clientId],
  );
  const visits = rows.filter((r) => r.square_status === 'ACCEPTED' && new Date(r.end_at) < now).map((r) => new Date(r.start_at));
  const hasFuture = rows.some((r) => ['ACCEPTED', 'PENDING'].includes(r.square_status) && new Date(r.start_at) >= now);
  return computeRebooking(visits, hasFuture, opts, now);
}
