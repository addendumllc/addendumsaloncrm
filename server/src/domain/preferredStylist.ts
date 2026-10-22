import { db } from '../db/index.js';

/** Visits with the same stylist for the same service that make them the client's preferred stylist. */
export const PREFERRED_MIN_VISITS = 3;

/**
 * Keeps clients' preferred stylists in step with their visits (completed appointments):
 * - the stylist they've seen PREFERRED_MIN_VISITS+ times for the same service (most visits, then most recent);
 * - otherwise the stylist of their last visit;
 * - blank when that stylist no longer works at the salon.
 * A stylist someone chose by hand ('manual') is never changed. One set before this existed is only replaced by a clear
 * pattern (3+ visits), or cleared when that stylist has left. Returns how many clients changed.
 */
export async function updatePreferredStylists(opts: { clientId?: string } = {}, now = new Date()): Promise<number> {
  const p: unknown[] = [now, PREFERRED_MIN_VISITS];
  const only = opts.clientId ? (p.push(opts.clientId), `AND a.client_id = $${p.length}`) : '';
  const rows = await db().query<{ id: string; current: string | null; source: string | null; current_active: boolean | null; regular: string | null; last: string | null; last_active: boolean | null; regular_active: boolean | null }>(
    `WITH visits AS (
       SELECT a.id, a.client_id, a.staff_id, a.start_at FROM appointments a
        WHERE a.square_status = 'ACCEPTED' AND a.end_at < $1 AND a.client_id IS NOT NULL AND a.staff_id IS NOT NULL ${only}
     ),
     pairs AS (
       SELECT v.client_id, v.staff_id, count(DISTINCT v.id) AS n, max(v.start_at) AS latest
         FROM visits v JOIN appointment_services x ON x.appointment_id = v.id
        GROUP BY v.client_id, v.staff_id, coalesce(x.service_id::text, lower(x.service_name))
     ),
     regular AS (
       SELECT DISTINCT ON (client_id) client_id, staff_id FROM pairs WHERE n >= $2 ORDER BY client_id, n DESC, latest DESC
     ),
     last AS (
       SELECT DISTINCT ON (client_id) client_id, staff_id FROM visits ORDER BY client_id, start_at DESC
     )
     SELECT c.id, c.preferred_staff_id AS current, c.preferred_staff_source AS source, cs.active AS current_active,
            r.staff_id AS regular, rs.active AS regular_active, l.staff_id AS last, ls.active AS last_active
       FROM clients c
       JOIN last l ON l.client_id = c.id
       LEFT JOIN regular r ON r.client_id = c.id
       LEFT JOIN staff cs ON cs.id = c.preferred_staff_id
       LEFT JOIN staff rs ON rs.id = r.staff_id
       LEFT JOIN staff ls ON ls.id = l.staff_id
      WHERE c.archived_at IS NULL AND c.preferred_staff_source IS DISTINCT FROM 'manual'`,
    p,
  );
  let changed = 0;
  for (const r of rows) {
    // Their regular stylist for a service, else whoever they saw last — blank if that person has left.
    const pick = r.regular ? (r.regular_active ? r.regular : null) : r.last_active ? r.last : null;
    // Set before this existed: only a clear pattern replaces it (or it's cleared because that stylist has left).
    if (r.source == null && r.current != null && !r.regular && r.current_active !== false) continue;
    if (pick === r.current && r.source === 'auto') continue;
    await db().query(`UPDATE clients SET preferred_staff_id = $2, preferred_staff_source = 'auto', updated_at = now() WHERE id = $1`, [r.id, pick]);
    if (pick !== r.current) changed++;
  }
  return changed;
}
