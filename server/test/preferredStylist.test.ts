import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/index.js';
import { updatePreferredStylists } from '../src/domain/preferredStylist.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let a: string; // a stylist
let b: string; // another stylist
let gone: string; // a stylist who has left

beforeAll(async () => {
  ({ api } = await setup());
  const staff = await db().query<any>("SELECT id FROM staff WHERE active ORDER BY email LIMIT 2");
  [a, b] = staff.map((s) => s.id);
  gone = (await db().one<any>(`INSERT INTO staff(name, email, role, active) VALUES ('Left Salon', 'left-${Date.now()}@test.example', 'stylist', false) RETURNING id`)).id;
});

let n = 0;
async function client() {
  return (await db().one<any>(`INSERT INTO clients(first_name, last_name) VALUES ('Pref', 'Test${++n}') RETURNING id`)).id as string;
}
/** A completed visit `daysAgo` days back with this stylist, for this service. */
async function visit(clientId: string, staffId: string, service: string, daysAgo: number) {
  const start = new Date(Date.now() - daysAgo * 86400_000);
  const appt = await db().one<any>(
    `INSERT INTO appointments(square_booking_id, client_id, staff_id, start_at, end_at, square_status) VALUES ($1,$2,$3,$4,$5,'ACCEPTED') RETURNING id`,
    [`pref-${clientId}-${daysAgo}-${Math.random()}`, clientId, staffId, start, new Date(start.getTime() + 3600_000)]);
  await db().query(`INSERT INTO appointment_services(appointment_id, position, service_name) VALUES ($1, 0, $2)`, [appt.id, service]);
}
const pref = async (id: string) => db().one<any>('SELECT preferred_staff_id AS staff, preferred_staff_source AS source FROM clients WHERE id = $1', [id]);

describe('Preferred stylist from visits', () => {
  it('3+ visits with the same stylist for the same service make them the preferred stylist, even if they saw someone else last', async () => {
    const c = await client();
    for (const d of [90, 60, 30]) await visit(c, a, 'Color', d);
    await visit(c, b, 'Blowout', 5);
    await updatePreferredStylists({ clientId: c });
    expect(await pref(c)).toEqual({ staff: a, source: 'auto' });
  });

  it('without a pattern it’s the last stylist they saw; blank when that stylist has left', async () => {
    const c = await client();
    await visit(c, a, 'Color', 40);
    await visit(c, b, 'Cut', 10);
    await updatePreferredStylists({ clientId: c });
    expect((await pref(c)).staff).toBe(b);
    const c2 = await client();
    await visit(c2, gone, 'Cut', 3);
    await updatePreferredStylists({ clientId: c2 });
    expect(await pref(c2)).toEqual({ staff: null, source: 'auto' });
  });

  it('a stylist chosen by hand is kept, and “Automatic” brings the visit-based choice back', async () => {
    const c = await client();
    for (const d of [90, 60, 30]) await visit(c, a, 'Color', d);
    expect((await api.patch(`/api/clients/${c}`, { preferredStaffId: b })).status).toBe(200);
    await updatePreferredStylists();
    expect(await pref(c)).toEqual({ staff: b, source: 'manual' });
    expect((await api.get(`/api/clients/${c}`)).body.client.preferredStaffAuto).toBe(false);
    await api.patch(`/api/clients/${c}`, { preferredStaffAuto: true });
    expect(await pref(c)).toEqual({ staff: a, source: 'auto' });
  });

  it('one set before this existed is only replaced by a clear pattern', async () => {
    const c = await client();
    await db().query('UPDATE clients SET preferred_staff_id = $2 WHERE id = $1', [c, b]);
    await visit(c, a, 'Cut', 10);
    await updatePreferredStylists({ clientId: c });
    expect((await pref(c)).staff).toBe(b); // one visit with someone else isn't enough
    for (const d of [80, 50]) await visit(c, a, 'Cut', d);
    await updatePreferredStylists({ clientId: c });
    expect((await pref(c)).staff).toBe(a);
  });

  it('only stylists (bookable online in Square) count: the sync marks who is, and others are never a preferred stylist', async () => {
    const { MockSquareService } = await import('../src/integrations/square/MockSquareService.js');
    const { runSquareSync } = await import('../src/domain/squareSync.js');
    await runSquareSync({ full: false });
    const linked = await db().query<any>('SELECT id, square_team_member_id FROM staff WHERE active AND square_team_member_id IS NOT NULL ORDER BY name LIMIT 2');
    expect(linked.length).toBe(2);
    const [front, stylist] = linked.map((r) => r.id as string);
    const tm = linked[0].square_team_member_id as string;
    MockSquareService.notBookable.add(tm);
    try {
      await runSquareSync({ full: false });
      expect((await db().one<any>('SELECT square_bookable FROM staff WHERE id = $1', [front])).square_bookable).toBe(false);
      const list = (await api.get('/api/staff')).body.staff;
      expect(list.find((s: any) => s.id === front).stylist).toBe(false);
      expect(list.find((s: any) => s.id === stylist).stylist).toBe(true);
      // Seen last by someone who isn't a stylist: no preferred stylist (not them).
      const c = await client();
      await visit(c, front, 'Cut', 3);
      await updatePreferredStylists({ clientId: c });
      expect((await pref(c)).staff).toBeNull();
    } finally {
      MockSquareService.notBookable.delete(tm);
      await runSquareSync({ full: false });
    }
  });
});
