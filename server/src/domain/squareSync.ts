import { updatePreferredStylists } from './preferredStylist.js';
import { DEFAULT_ROLE } from '@addendum/shared';
import { config } from '../config.js';
import { db, type Queryable } from '../db/index.js';
import { IntegrationError } from '../lib/errors.js';
import { toE164 } from '../lib/phone.js';
import { addDays } from '../lib/time.js';
import { squareService } from '../integrations/registry.js';
import type { SquareBooking, SquareCustomer, SquareService } from '../integrations/square/types.js';
import { notifications } from '../integrations/notifications/NotificationService.js';
import { getIntegration, recordSync, upsertIntegration } from '../repos/integrations.js';
import { runRules } from './rulesEngine.js';
import { applySuggestedRebookingDefaults } from './rebookingSchedule.js';

/**
 * Square → local sync. Square is the source of truth for appointments: these rows are only
 * written here, keyed by the Square booking ID, so there are never conflicting copies.
 * Change detection: new, cancelled, rescheduled (start time moved), no-show, accepted.
 */
export interface SyncResult {
  ok: boolean;
  message: string;
  created: number;
  updated: number;
  cancelled: number;
  rescheduled: number;
  noShows: number;
  customers: number;
}

const STAFF_COLORS = ['#B08968', '#7F8C8D', '#A26769', '#6D7A6A', '#8E7DBE', '#C4A484', '#5E6472', '#B5838D', '#7A9E9F'];

let running: Promise<SyncResult> | null = null;

export function runSquareSync(opts: { full?: boolean } = {}): Promise<SyncResult> {
  if (running) return running; // never run two syncs at once
  running = doSync(opts).finally(() => {
    running = null;
  });
  return running;
}

async function doSync(opts: { full?: boolean }): Promise<SyncResult> {
  const result: SyncResult = { ok: true, message: '', created: 0, updated: 0, cancelled: 0, rescheduled: 0, noShows: 0, customers: 0 };
  const svc = await squareService();
  if (!svc) {
    return { ...result, ok: false, message: 'Square is not connected.' };
  }
  const cfg = config();
  try {
    const integ = await getIntegration('square');
    const firstSync = !integ?.last_sync_at || opts.full;
    const now = new Date();
    // First sync imports history for rebooking predictions; later syncs re-check the recent past
    // (to catch no-shows/cancellations marked after the fact) plus the upcoming calendar.
    const from = addDays(now, firstSync ? -cfg.SQUARE_BACKFILL_DAYS : -35);
    const to = addDays(now, cfg.SQUARE_LOOKAHEAD_DAYS);

    const merchantName = await svc.merchantName().catch(() => null);
    await syncReferenceData(svc);
    const bookings = await svc.listBookings(from, to);
    result.customers = await syncCustomers(svc, bookings);
    for (const b of bookings) {
      const change = await upsertBooking(b, { notify: !firstSync });
      tally(result, change);
    }
    // Preferred stylists follow clients' visits (before the rules, so new follow-ups go to the right person).
    await updatePreferredStylists().catch((e) => console.warn('[square-sync] preferred stylists:', (e as Error).message));
    result.message = firstSync
      ? `Imported ${bookings.length} Square appointments.`
      : `Checked ${bookings.length} appointments: ${result.created} new, ${result.cancelled} cancelled, ${result.rescheduled} rescheduled.`;
    await upsertIntegration('square', { status: 'connected', meta: { merchantName } });
    await recordSync('square', true, result.message);
    await runRules();
    return result;
  } catch (e) {
    const friendly = e instanceof IntegrationError ? e.userMessage : 'Sync failed. Your existing data is safe.';
    if (e instanceof IntegrationError && e.authProblem) await upsertIntegration('square', { status: 'needs_reconnect' });
    console.error('[square-sync] failed:', e instanceof IntegrationError ? e.technical ?? e.message : e);
    await recordSync('square', false, friendly);
    return { ...result, ok: false, message: friendly };
  }
}

function tally(r: SyncResult, change: BookingChange) {
  if (change.created) r.created++;
  else if (change.changed) r.updated++;
  if (change.events.includes('cancelled')) r.cancelled++;
  if (change.events.includes('rescheduled')) r.rescheduled++;
  if (change.events.includes('no_show')) r.noShows++;
}

/** Webhook path: refresh a single booking from Square (never trust the webhook payload alone). */
export async function syncSingleBooking(bookingId: string) {
  const svc = await squareService();
  if (!svc) return null;
  const booking = await svc.retrieveBooking(bookingId);
  if (!booking) return null;
  await syncCustomers(svc, [booking]);
  const change = await upsertBooking(booking, { notify: true });
  const appt = await db().one<{ client_id: string | null }>('SELECT client_id FROM appointments WHERE id = $1', [change.appointmentId]);
  if (appt?.client_id) await updatePreferredStylists({ clientId: appt.client_id }).catch(() => undefined);
  await runRules();
  return change;
}

async function syncReferenceData(svc: SquareService) {
  const [locations, team, services] = await Promise.all([svc.listLocations(), svc.listTeamMembers(), svc.listServices()]);
  for (const l of locations) {
    await db().query(
      `INSERT INTO locations(square_location_id, name, address, timezone) VALUES ($1,$2,$3,$4)
       ON CONFLICT (square_location_id) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address, timezone = EXCLUDED.timezone, updated_at = now()`,
      [l.id, l.name, l.address ?? null, l.timezone ?? null],
    );
  }
  const existingCount = (await db().one<{ n: number }>('SELECT count(*)::int AS n FROM staff'))!.n;
  let i = existingCount;
  for (const m of team) {
    const name = `${m.given_name ?? ''} ${m.family_name ?? ''}`.trim() || 'Team member';
    // Their phone from Square fills the CRM mobile only when that's blank — a number typed in the CRM is never replaced.
    const phone = m.phone_number ? toE164(m.phone_number) : null;
    const linked = await db().one('SELECT id FROM staff WHERE square_team_member_id = $1', [m.id]);
    if (linked) {
      await db().query('UPDATE staff SET name = $2, mobile_phone = COALESCE(mobile_phone, $3), updated_at = now() WHERE id = $1', [linked.id, name, phone]);
      continue;
    }
    // Link to an existing staff record by email or exact name before creating a new one.
    const match = await db().one(
      `SELECT id FROM staff WHERE square_team_member_id IS NULL AND ((email IS NOT NULL AND lower(email) = lower($1)) OR lower(name) = lower($2)) LIMIT 1`,
      [m.email_address ?? '', name],
    );
    if (match) {
      await db().query('UPDATE staff SET square_team_member_id = $2, mobile_phone = COALESCE(mobile_phone, $3), updated_at = now() WHERE id = $1', [match.id, m.id, phone]);
    } else {
      await db().query('INSERT INTO staff(name, email, role, square_team_member_id, color, mobile_phone) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (email) DO NOTHING', [
        name, m.email_address ?? null, DEFAULT_ROLE, m.id, STAFF_COLORS[i++ % STAFF_COLORS.length], phone,
      ]);
    }
  }
  for (const s of services) {
    await db().query(
      `INSERT INTO services(square_variation_id, square_item_id, name, duration_minutes, price_cents) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (square_variation_id) DO UPDATE SET name = EXCLUDED.name, duration_minutes = EXCLUDED.duration_minutes,
         price_cents = EXCLUDED.price_cents, updated_at = now()`,
      [s.variationId, s.itemId, s.name, s.durationMinutes, s.priceCents],
    );
  }
  await applySuggestedRebookingDefaults();
}

async function syncCustomers(svc: SquareService, bookings: SquareBooking[]) {
  const ids = [...new Set(bookings.map((b) => b.customer_id).filter(Boolean) as string[])];
  if (!ids.length) return 0;
  const customers = await svc.bulkRetrieveCustomers(ids);
  for (const c of customers) await upsertCustomer(c);
  return customers.length;
}

export async function upsertCustomer(c: SquareCustomer): Promise<string> {
  const phone = toE164(c.phone_number);
  const email = c.email_address?.trim().toLowerCase() || null;
  const first = c.given_name?.trim() || c.nickname?.trim() || '';
  const last = c.family_name?.trim() || '';
  return db().tx(async (q) => {
    const existing = await q.query<{ id: string }>('SELECT id FROM clients WHERE square_customer_id = $1', [c.id]);
    if (existing[0]) {
      await q.query(
        `UPDATE clients SET first_name = $2, last_name = $3, phone = COALESCE($4, phone), email = COALESCE($5, email),
           birthday = COALESCE($6, birthday), updated_at = now() WHERE id = $1`,
        [existing[0].id, first, last, phone, email, c.birthday ?? null],
      );
      return existing[0].id;
    }
    // Link to a client created in-app (e.g. a converted lead) instead of creating a duplicate.
    const match = await q.query<{ id: string }>(
      `SELECT id FROM clients WHERE square_customer_id IS NULL AND ((phone IS NOT NULL AND phone = $1) OR (email IS NOT NULL AND lower(email) = $2)) LIMIT 1`,
      [phone, email],
    );
    let id: string;
    if (match[0]) {
      id = match[0].id;
      await q.query('UPDATE clients SET square_customer_id = $2, birthday = COALESCE(birthday, $3), updated_at = now() WHERE id = $1', [id, c.id, c.birthday ?? null]);
    } else {
      const ins = await q.query<{ id: string }>(
        `INSERT INTO clients(first_name, last_name, phone, email, birthday, square_customer_id, lead_source, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now())) RETURNING id`,
        [first, last, phone, email, c.birthday ?? null, c.id, c.creation_source === 'APPOINTMENTS' ? 'Square booking' : null, c.created_at ?? null],
      );
      id = ins[0].id;
    }
    await linkLeadToClient(q, id, phone, email);
    await q.query('UPDATE conversations SET client_id = $1 WHERE phone = $2 AND client_id IS NULL', [id, phone]);
    return id;
  });
}

async function linkLeadToClient(q: Queryable, clientId: string, phone: string | null, email: string | null) {
  await q.query(
    `UPDATE leads SET client_id = $1, updated_at = now()
      WHERE client_id IS NULL AND archived_at IS NULL AND ((phone IS NOT NULL AND phone = $2) OR (email IS NOT NULL AND lower(email) = $3))`,
    [clientId, phone, email],
  );
}

interface BookingChange {
  appointmentId: string;
  created: boolean;
  changed: boolean;
  events: string[];
}

export async function upsertBooking(b: SquareBooking, opts: { notify: boolean }): Promise<BookingChange> {
  const segs = b.appointment_segments ?? [];
  const totalMin = segs.reduce((s, x) => s + (x.duration_minutes ?? 0) + (x.intermission_minutes ?? 0), 0) || 60;
  const start = new Date(b.start_at);
  const end = new Date(start.getTime() + totalMin * 60_000);
  const isDemo = config().DEMO_MODE;

  const out = await db().tx(async (q) => {
    const [client] = b.customer_id ? await q.query<{ id: string }>('SELECT id FROM clients WHERE square_customer_id = $1', [b.customer_id]) : [];
    const [staff] = segs[0]?.team_member_id ? await q.query<{ id: string }>('SELECT id FROM staff WHERE square_team_member_id = $1', [segs[0].team_member_id]) : [];
    const [loc] = b.location_id ? await q.query<{ id: string }>('SELECT id FROM locations WHERE square_location_id = $1', [b.location_id]) : [];
    const services = segs.length
      ? await q.query<{ id: string; name: string; price_cents: number | null; square_variation_id: string }>(
          'SELECT id, name, price_cents, square_variation_id FROM services WHERE square_variation_id = ANY($1::text[])',
          [segs.map((s) => s.service_variation_id).filter(Boolean)],
        )
      : [];
    const byVar = new Map(services.map((s) => [s.square_variation_id, s]));
    const prices = segs.map((s) => byVar.get(s.service_variation_id ?? '')?.price_cents);
    const bookedValue = prices.length && prices.every((p) => p != null) ? prices.reduce((a, p) => a + (p ?? 0), 0) : null;

    const [existing] = await q.query<any>('SELECT * FROM appointments WHERE square_booking_id = $1', [b.id]);
    const events: string[] = [];
    let id: string;
    if (!existing) {
      const ins = await q.query<{ id: string }>(
        `INSERT INTO appointments(square_booking_id, square_version, source, square_customer_id, client_id, staff_id, location_id,
           start_at, end_at, square_status, customer_note, seller_note, booked_value_cents, square_created_at, square_updated_at, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb) RETURNING id`,
        [b.id, b.version ?? null, isDemo ? 'demo' : 'square', b.customer_id ?? null, client?.id ?? null, staff?.id ?? null, loc?.id ?? null,
          start, end, b.status, b.customer_note ?? null, b.seller_note ?? null, bookedValue, b.created_at ?? null, b.updated_at ?? null, JSON.stringify(b)],
      );
      id = ins[0].id;
      events.push('created');
      if (b.status === 'NO_SHOW') events.push('no_show');
      if (b.status.startsWith('CANCELLED')) events.push('cancelled');
    } else {
      id = existing.id;
      // Ignore stale webhook deliveries.
      if (existing.square_version != null && b.version != null && b.version < existing.square_version) {
        return { change: { appointmentId: id, created: false, changed: false, events } as BookingChange, note: null };
      }
      if (existing.square_status !== b.status) {
        if (b.status === 'NO_SHOW') events.push('no_show');
        else if (b.status.startsWith('CANCELLED') || b.status === 'DECLINED') events.push('cancelled');
        else if (b.status === 'ACCEPTED') events.push('accepted');
        else events.push('status_changed');
      }
      const moved = new Date(existing.start_at).getTime() !== start.getTime();
      if (moved) events.push('rescheduled');
      const changed = events.length > 0 || existing.square_version !== (b.version ?? null) || existing.staff_id !== (staff?.id ?? null);
      if (changed) {
        await q.query(
          `UPDATE appointments SET square_version = $2, square_customer_id = $3, client_id = $4, staff_id = $5, location_id = $6,
             start_at = $7, end_at = $8, square_status = $9, customer_note = $10, seller_note = $11, booked_value_cents = $12,
             square_updated_at = $13, raw = $14::jsonb,
             rescheduled_from = CASE WHEN $15 THEN start_at ELSE rescheduled_from END,
             client_confirmed_at = CASE WHEN $15 THEN NULL ELSE client_confirmed_at END,
             updated_at = now()
           WHERE id = $1`,
          [id, b.version ?? null, b.customer_id ?? null, client?.id ?? null, staff?.id ?? null, loc?.id ?? null, start, end, b.status,
            b.customer_note ?? null, b.seller_note ?? null, bookedValue, b.updated_at ?? null, JSON.stringify(b), moved],
        );
      }
    }
    // Services always mirror Square.
    await q.query('DELETE FROM appointment_services WHERE appointment_id = $1', [id]);
    for (let i = 0; i < segs.length; i++) {
      const svc = byVar.get(segs[i].service_variation_id ?? '');
      await q.query(
        'INSERT INTO appointment_services(appointment_id, position, service_id, service_name, duration_minutes) VALUES ($1,$2,$3,$4,$5)',
        [id, i, svc?.id ?? null, svc?.name ?? 'Service', segs[i].duration_minutes ?? null],
      );
    }
    for (const ev of events) {
      await q.query('INSERT INTO appointment_events(appointment_id, event, detail) VALUES ($1,$2,$3::jsonb)', [
        id, ev, JSON.stringify({ status: b.status, startAt: b.start_at }),
      ]);
    }
    let note: { title: string; link: string } | null = null;
    if (opts.notify && events.length) {
      const what = events.includes('cancelled') ? 'cancelled' : events.includes('no_show') ? 'was marked a no-show for' : events.includes('rescheduled') ? 'rescheduled' : events.includes('created') ? 'booked' : null;
      if (what) {
        const name = client ? (await q.query<any>("SELECT trim(first_name || ' ' || last_name) AS n FROM clients WHERE id = $1", [client.id]))[0]?.n : null;
        note = { title: `${name || 'A client'} ${what} an appointment in Square`, link: client ? `/clients/${client.id}` : '/appointments' };
      }
    }
    return { change: { appointmentId: id, created: !existing, changed: !existing || events.length > 0, events } as BookingChange, note };
  });
  // Notify outside the transaction (the embedded database is single-connection).
  if (out.note) await notifications.notify({ kind: 'square', ...out.note });
  return out.change;
}
