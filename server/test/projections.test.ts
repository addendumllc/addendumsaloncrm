import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { zonedToUtc } from '../src/lib/time.js';
import { setup } from './helpers.js';

let app: Awaited<ReturnType<typeof setup>>['app'];
let admin: Awaited<ReturnType<typeof setup>>['api'];
const TZ = 'America/Los_Angeles';
// A week far from the demo data, so the numbers are exact: Mon 4 – Sun 10 March 2030.
const WEEK = 'from=2030-03-04&to=2030-03-10';
let n = 0;
let staffId: string;
const ids: Record<string, string> = {};

async function client(key: string) {
  ids[key] = (await db().one<any>("INSERT INTO clients(first_name, last_name) VALUES ($1, 'Projection') RETURNING id", [key])).id;
  return ids[key];
}
/** An appointment at a salon-local date and time, with services (name, catalog price). */
async function appt(clientKey: string | null, day: string, hh: number, mm: number, status: string, value: number | null, services: [string, number | null][] = [['Haircut', value]]) {
  const start = zonedToUtc(+day.slice(0, 4), +day.slice(5, 7), +day.slice(8, 10), hh, mm, TZ);
  const a = await db().one<any>(
    `INSERT INTO appointments(square_booking_id, source, client_id, staff_id, start_at, end_at, square_status, booked_value_cents)
     VALUES ($1,'demo',$2,$3,$4,$5,$6,$7) RETURNING id`,
    [`proj-${++n}`, clientKey ? ids[clientKey] : null, staffId, start, new Date(start.getTime() + 3600_000), status, value]);
  let pos = 0;
  for (const [name, price] of services) {
    const svc = await db().one<any>('INSERT INTO services(name, price_cents) VALUES ($1,$2) RETURNING id', [`${name} ${n}-${pos}`, price]);
    await db().query('INSERT INTO appointment_services(appointment_id, position, service_id, service_name) VALUES ($1,$2,$3,$4)', [a.id, pos++, svc.id, name]);
  }
  return a.id as string;
}
async function as(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email, password: 'addendum-demo' });
  return agent;
}

let movable: string;
beforeAll(async () => {
  ({ app, api: admin } = await setup());
  staffId = (await db().one<any>("INSERT INTO staff(name, role) VALUES ('Projection Stylist', 'stylist') RETURNING id")).id;
  for (const k of ['Ava', 'Bea', 'Cal', 'Dee', 'Eve', 'Fay', 'Gia']) await client(k);
  movable = await appt('Ava', '2030-03-04', 10, 0, 'ACCEPTED', 15000); // Mon
  await appt('Ava', '2030-03-06', 11, 0, 'ACCEPTED', 8000); // Wed — same client again
  await appt('Bea', '2030-03-05', 9, 0, 'ACCEPTED', null, [['Colour', null]]); // Tue — no price
  await appt('Gia', '2030-03-05', 13, 0, 'ACCEPTED', 10000, [['Cut', 6000], ['Gloss', 4000]]); // Tue — two services
  await appt('Cal', '2030-03-05', 15, 0, 'CANCELLED_BY_CUSTOMER', 20000);
  await appt('Dee', '2030-03-07', 10, 0, 'NO_SHOW', 9000);
  await appt('Eve', '2030-03-08', 10, 0, 'PENDING', 12000); // awaiting confirmation
  await appt('Fay', '2030-03-10', 23, 30, 'ACCEPTED', 5000); // Sunday 11:30 pm salon time: still this week
  await appt('Fay', '2030-03-11', 0, 30, 'ACCEPTED', 7000); // Monday 12:30 am: next week
  await appt('Gia', '2030-03-31', 23, 0, 'ACCEPTED', 3000); // last evening of March
  await appt('Gia', '2030-04-01', 0, 30, 'ACCEPTED', 4000); // first hour of April
});

describe('Projected service revenue — calculations', () => {
  it('weekly totals: unique clients, one count per appointment, cancelled/no-shows out, unpriced flagged', async () => {
    const r = (await admin.get(`/api/projections?${WEEK}&by=day`)).body;
    expect(r.total).toMatchObject({
      revenueCents: 38000, appointments: 5, clients: 4, estimatedAppointments: 4, unestimatedAppointments: 1, pricedClients: 3,
      avgPerClientCents: 12667, avgPerAppointmentCents: 9500,
    });
    expect(r.awaitingConfirmation).toMatchObject({ appointments: 1, revenueCents: 12000 });
    expect(r.buckets).toHaveLength(7);
    const day = (d: string) => r.buckets.find((b: any) => b.from === d);
    expect(day('2030-03-04')).toMatchObject({ revenueCents: 15000, clients: 1, appointments: 1 });
    expect(day('2030-03-05')).toMatchObject({ revenueCents: 10000, clients: 2, appointments: 2, unestimatedAppointments: 1 });
    expect(day('2030-03-07')).toMatchObject({ revenueCents: 0, appointments: 0 }); // the no-show isn't revenue
    expect(day('2030-03-10')).toMatchObject({ revenueCents: 5000 });
    // Buckets add up to the total; unique clients over the week aren't the sum of daily uniques.
    expect(r.buckets.reduce((s: number, b: any) => s + b.revenueCents, 0)).toBe(r.total.revenueCents);
  });

  it('monthly totals by week: each appointment in exactly one week and month (salon time zone)', async () => {
    const m = (await admin.get('/api/projections?from=2030-03-01&to=2030-03-31&by=week')).body;
    expect(m.total.revenueCents).toBe(38000 + 7000 + 3000);
    expect(m.buckets.map((b: any) => [b.from, b.to])).toEqual([
      ['2030-03-01', '2030-03-03'], ['2030-03-04', '2030-03-10'], ['2030-03-11', '2030-03-17'],
      ['2030-03-18', '2030-03-24'], ['2030-03-25', '2030-03-31'],
    ]);
    expect(m.buckets.reduce((s: number, b: any) => s + b.appointments, 0)).toBe(m.total.appointments);
    const april = (await admin.get('/api/projections?from=2030-04-01&to=2030-04-30&by=week')).body;
    expect(april.total.revenueCents).toBe(4000);
    // A range spanning both months counts each appointment once.
    const both = (await admin.get('/api/projections?from=2030-03-25&to=2030-04-07&by=month')).body;
    expect(both.buckets.map((b: any) => b.revenueCents)).toEqual([3000, 4000]);
    expect(both.total.revenueCents).toBe(7000);
  });

  it('appointment details: services with prices, combined total, status, what counts', async () => {
    const list = (await admin.get(`/api/projections/appointments?${WEEK}`)).body.appointments;
    expect(list.some((a: any) => a.clientName === 'Cal Projection')).toBe(false); // cancelled
    expect(list.some((a: any) => a.clientName === 'Dee Projection')).toBe(false); // no-show
    const two = list.find((a: any) => a.clientName === 'Gia Projection');
    expect(two).toMatchObject({ expectedCents: 10000, status: 'confirmed', counted: true, staffName: 'Projection Stylist' });
    expect(two.services).toEqual([{ name: 'Cut', priceCents: 6000 }, { name: 'Gloss', priceCents: 4000 }]);
    expect(list.find((a: any) => a.clientName === 'Bea Projection')).toMatchObject({ expectedCents: null, counted: false });
    expect(list.find((a: any) => a.clientName === 'Eve Projection')).toMatchObject({ status: 'awaiting confirmation', counted: false });
  });

  it('updates when bookings are rescheduled or cancelled', async () => {
    await db().query("UPDATE appointments SET start_at = start_at + interval '7 days', end_at = end_at + interval '7 days' WHERE id = $1", [movable]);
    expect((await admin.get(`/api/projections?${WEEK}`)).body.total.revenueCents).toBe(23000);
    expect((await admin.get('/api/projections?from=2030-03-11&to=2030-03-17')).body.total.revenueCents).toBe(22000);
    await db().query("UPDATE appointments SET square_status = 'CANCELLED_BY_SELLER' WHERE id = $1", [movable]);
    expect((await admin.get('/api/projections?from=2030-03-11&to=2030-03-17')).body.total.revenueCents).toBe(7000);
  });

  it('validates dates', async () => {
    expect((await admin.get('/api/projections?from=2030-03-10&to=2030-03-04')).status).toBe(400);
    expect((await admin.get('/api/projections?from=2030-02-30&to=2030-03-04')).status).toBe(400);
    expect((await admin.get('/api/projections?from=2030-01-01&to=2033-01-01')).status).toBe(400);
  });
});

describe('Projected service revenue — Admin/Owner only', () => {
  it('nobody else can read it through the API or the dashboard', async () => {
    expect((await admin.get('/api/dashboard')).body.widgets.projections.week).toBeTruthy();
    for (const email of ['frontdesk@addendumsalon.com', 'jennifer@addendumsalon.com']) {
      const agent = await as(email);
      expect([email, (await agent.get(`/api/projections?${WEEK}`)).status]).toEqual([email, 403]);
      expect((await agent.get(`/api/projections/appointments?${WEEK}`)).status).toBe(403);
      const dash = await agent.get('/api/dashboard');
      if (dash.status === 200) expect(dash.body.widgets.projections).toBeNull();
      expect(JSON.stringify(dash.body)).not.toContain('revenueCents');
    }
  });

  it('the widget permission alone shows nothing, and only holders of the permission can grant it', async () => {
    const deskId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
    await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'dashboard:projections': true, 'users:permissions': true, 'users:manage': true }, confirm: true });
    const desk = await as('frontdesk@addendumsalon.com');
    expect((await desk.get('/api/dashboard')).body.widgets.projections).toBeNull();
    // Front desk can manage permissions now, but can't hand out access they don't have.
    const jenId = (await db().one<any>("SELECT id FROM staff WHERE email = 'jennifer@addendumsalon.com'")).id;
    const grant = await desk.put(`/api/admin/users/${jenId}/access`).set('X-Requested-With', 'addendum-crm').send({ overrides: { 'revenue:projections': true }, confirm: true });
    expect(grant.status).toBe(403);
    // An admin can grant it; then it works for that person.
    await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'revenue:projections': true }, confirm: true });
    expect((await desk.get(`/api/projections?${WEEK}`)).status).toBe(200);
  });
});
