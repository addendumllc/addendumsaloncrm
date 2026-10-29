import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { syncSingleBooking } from '../src/domain/squareSync.js';
import { demoSquareSimulator } from '../src/integrations/square/MockSquareService.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: Awaited<ReturnType<typeof setup>>['app'];
beforeAll(async () => { ({ api, app } = await setup()); });

const HOUR = 3600_000;
describe('Schedule changes (from Square)', () => {
  it('lists cancellations (who cancelled), reschedules and stylist changes, with last-minute ones flagged', async () => {
    const [a, b] = await db().query<any>(`SELECT id, square_booking_id, start_at, staff_id FROM appointments WHERE square_status = 'ACCEPTED' AND start_at > now() + interval '3 hours' AND staff_id IS NOT NULL ORDER BY start_at LIMIT 2`);
    // Cancelled by the salon a day before → last minute.
    await db().query(`UPDATE appointments SET start_at = now() + interval '20 hours', end_at = now() + interval '21 hours' WHERE id = $1`, [a.id]);
    await demoSquareSimulator.updateBooking(a.square_booking_id, { start_at: new Date(Date.now() + 20 * HOUR).toISOString() });
    await demoSquareSimulator.updateBooking(a.square_booking_id, { status: 'CANCELLED_BY_SELLER' });
    await syncSingleBooking(a.square_booking_id);
    // Rescheduled, and given to another stylist.
    const other = await db().one<any>('SELECT id FROM staff WHERE id <> $1 AND square_team_member_id IS NOT NULL LIMIT 1', [b.staff_id]);
    const tm = await db().one<any>('SELECT square_team_member_id FROM staff WHERE id = $1', [other.id]);
    const later = new Date(new Date(b.start_at).getTime() + 2 * 24 * HOUR).toISOString();
    const booking = await demoSquareSimulator.updateBooking(b.square_booking_id, { start_at: later }) as any;
    if (booking?.appointment_segments) {
      booking.appointment_segments = booking.appointment_segments.map((s: any) => ({ ...s, team_member_id: tm.square_team_member_id }));
      await demoSquareSimulator.updateBooking(b.square_booking_id, { appointment_segments: booking.appointment_segments } as any);
    }
    await syncSingleBooking(b.square_booking_id);

    const r = await api.get('/api/appointments/changes');
    expect(r.status).toBe(200);
    const cancel = r.body.changes.find((c: any) => c.appointmentId === a.id && c.kind === 'cancelled');
    expect(cancel).toMatchObject({ by: 'salon', lastMinute: true });
    const moved = r.body.changes.find((c: any) => c.appointmentId === b.id && c.kind === 'rescheduled');
    expect(new Date(moved.fromStartAt).getTime()).toBe(new Date(b.start_at).getTime());
    expect(new Date(moved.startAt).getTime()).toBe(new Date(later).getTime());
    if (booking?.appointment_segments) expect(r.body.changes.find((c: any) => c.appointmentId === b.id && c.kind === 'staff_changed')).toBeTruthy();
    // Filters: last minute only; by stylist (either the one it was with or the one it went to).
    const lm = (await api.get('/api/appointments/changes?lastMinute=true')).body.changes;
    expect(lm.every((c: any) => c.lastMinute)).toBe(true);
    expect((await api.get(`/api/appointments/changes?staffId=${a.staff_id}`)).status).toBe(200);
  });

  it('is only for people allowed to see schedule changes', async () => {
    const jen = request.agent(app);
    await jen.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'jennifer@addendumsalon.com', password: 'addendum-demo' });
    expect((await jen.get('/api/appointments/changes')).status).toBe(403);
    expect((await jen.get('/api/appointments?range=upcoming')).status).toBe(200); // their own calendar still works
  });
});
