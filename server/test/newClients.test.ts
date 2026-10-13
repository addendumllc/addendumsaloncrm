import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { localDate } from '../src/domain/rebookingSchedule.js';
import { setup } from './helpers.js';

let app: Awaited<ReturnType<typeof setup>>['app'];
let admin: Awaited<ReturnType<typeof setup>>['api'];
let ana: string; // test stylists, so demo data never affects the exact counts
let ben: string;
const TZ = 'America/Los_Angeles';
const DAY = 86400_000;
const day = (n: number) => localDate(new Date(Date.now() + n * DAY), TZ);
const RANGE = () => `from=${day(-60)}&to=${day(2)}`;
let n = 0;

async function client(name: string, createdDaysAgo = 90) {
  const [first, last] = name.split(' ');
  return (await db().one<any>('INSERT INTO clients(first_name, last_name, created_at) VALUES ($1,$2,$3) RETURNING id',
    [first, last, new Date(Date.now() - createdDaysAgo * DAY)])).id as string;
}
async function appt(clientId: string, staffId: string, daysFromNow: number, status = 'ACCEPTED', service = 'Haircut') {
  const start = new Date(Date.now() + daysFromNow * DAY);
  const a = await db().one<any>(
    `INSERT INTO appointments(square_booking_id, source, client_id, staff_id, start_at, end_at, square_status)
     VALUES ($1,'demo',$2,$3,$4,$5,$6) RETURNING id`,
    [`test-nc-${++n}`, clientId, staffId, start, new Date(start.getTime() + 3600_000), status]);
  await db().query('INSERT INTO appointment_services(appointment_id, position, service_name) VALUES ($1,0,$2)', [a.id, service]);
  return a.id as string;
}
async function signIn(email: string) {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email, password: 'addendum-demo' })).status).toBe(200);
  return { get: (url: string) => agent.get(url) };
}

beforeAll(async () => {
  ({ app, api: admin } = await setup());
  const staff = async (name: string) => (await db().one<any>("INSERT INTO staff(name, role) VALUES ($1, 'stylist') RETURNING id", [name])).id as string;
  ana = await staff('Ana Test');
  ben = await staff('Ben Test');

  // New, booked ahead: first visit 10 days ago, next one in 20 days.
  const a = await client('Avery Future');
  await appt(a, ana, -10, 'ACCEPTED', 'Color');
  await appt(a, ana, 20, 'ACCEPTED', 'Gloss');
  // New, came back once, nothing ahead.
  const b = await client('Blake Returned');
  await appt(b, ana, -15);
  await appt(b, ben, -5);
  // New, only a cancelled and an unconfirmed booking after: not rebooked.
  const c = await client('Casey Cancelled');
  await appt(c, ben, -8);
  await appt(c, ben, 12, 'CANCELLED_BY_CUSTOMER');
  await appt(c, ben, 14, 'PENDING');
  // First booking was cancelled: the first real visit (6 days ago) is the new-client visit.
  const d = await client('Drew Second');
  await appt(d, ana, -30, 'CANCELLED_BY_SELLER');
  await appt(d, ben, -6, 'ACCEPTED', 'Extensions');
  // No-show first, then booked ahead.
  const g = await client('Gray Noshow');
  await appt(g, ben, -9, 'NO_SHOW');
  await appt(g, ben, 3);
  await appt(g, ben, 40);
  // Existing client: first visit long before the range, back 3 days ago.
  const e = await client('Ellis Existing', 400);
  await appt(e, ana, -200);
  await appt(e, ana, -3);
  // Square profile from years ago (older than the CRM's history): existing, even though it's their first visit here.
  const f = await client('Frankie Longtime', 365 * 6);
  await appt(f, ben, -4);
  // New client whose first visit is still ahead.
  const h = await client('Harper Upcoming', 5);
  await appt(h, ana, 1);
});

describe('New clients & rebooking (owner/admin)', () => {
  const get = async (q = '') => {
    const r = await admin.get(`/api/analytics/new-clients?${RANGE()}${q}`);
    expect(r.status).toBe(200);
    return r.body;
  };
  const names = (rows: any[]) => rows.map((c: any) => c.clientName).sort();

  it('counts each new client once, by their first real visit and its stylist', async () => {
    const forAna = await get(`&staffId=${ana}`);
    expect(names(forAna.clients)).toEqual(['Avery Future', 'Blake Returned', 'Harper Upcoming']);
    const forBen = await get(`&staffId=${ben}`);
    expect(names(forBen.clients)).toEqual(['Casey Cancelled', 'Drew Second', 'Gray Noshow']);
    const drew = forBen.clients.find((c: any) => c.clientName === 'Drew Second');
    expect(drew.first.serviceNames).toEqual(['Extensions']);
    expect(drew.first.staffName).toBe('Ben Test');
    const all = await get();
    for (const x of ['Ellis Existing', 'Frankie Longtime']) expect(names(all.clients)).not.toContain(x);
  });

  it('rebooking needs a later confirmed appointment; cancelled and unconfirmed ones never count', async () => {
    const rows = [...(await get(`&staffId=${ana}`)).clients, ...(await get(`&staffId=${ben}`)).clients];
    const by = Object.fromEntries(rows.map((c: any) => [c.clientName, c]));
    expect(by['Avery Future'].rebookStatus).toBe('future');
    expect(by['Avery Future'].next.serviceNames).toEqual(['Gloss']);
    expect(by['Blake Returned'].rebookStatus).toBe('returned');
    expect(by['Blake Returned'].next).toBeNull();
    expect(by['Casey Cancelled'].rebookStatus).toBe('not_rebooked');
    expect(by['Casey Cancelled'].futureAppointments).toBe(0);
    expect(by['Gray Noshow'].first.state).toBe('no_show');
    expect(by['Gray Noshow'].rebookStatus).toBe('future');
    expect(by['Gray Noshow'].futureAppointments).toBe(2);
    expect(by['Harper Upcoming'].first.state).toBe('upcoming');
    expect(by['Harper Upcoming'].rebookStatus).toBe('not_rebooked');
  });

  it('summary totals count unique clients, with appointment totals alongside', async () => {
    const s = (await get(`&staffId=${ben}`)).summary;
    expect(s).toMatchObject({ newClients: 3, rebooked: 1, withFuture: 1, futureAppointments: 2, rebookedAppointments: 2 });
    // Ben also saw Frankie (existing). Blake's visit with Ben is a rebooking, not a returning client.
    expect(s.returningClients).toBe(1);
    const a = (await get(`&staffId=${ana}`)).summary;
    expect(a).toMatchObject({ newClients: 3, rebooked: 2, withFuture: 1, futureAppointments: 1 });
    expect(a.returningClients).toBe(1); // Ellis
  });

  it('breaks totals down by stylist, and follows cancellations as they sync', async () => {
    const before = (await get()).byStylist.find((r: any) => r.staffId === ana);
    expect(before).toMatchObject({ newClients: 3, rebooked: 2, withFuture: 1 });
    await db().query(`UPDATE appointments SET square_status = 'CANCELLED_BY_CUSTOMER'
                       WHERE client_id = (SELECT id FROM clients WHERE first_name = 'Avery' AND last_name = 'Future') AND start_at > now()`);
    const after = (await get()).byStylist.find((r: any) => r.staffId === ana);
    expect(after).toMatchObject({ newClients: 3, rebooked: 1, withFuture: 0 });
  });

  it('only people with business analytics can see it, and it validates dates', async () => {
    const jen = await signIn('jennifer@addendumsalon.com');
    expect((await jen.get(`/api/analytics/new-clients?${RANGE()}`)).status).toBe(403);
    expect((await admin.get(`/api/analytics/new-clients?from=${day(0)}&to=${day(-5)}`)).status).toBe(400);
  });
});

describe('My Commission: new clients', () => {
  it('a stylist gets two counts for themselves only, whatever they ask for', async () => {
    await db().query("UPDATE staff SET email = 'ben.test@addendumsalon.com', password_hash = (SELECT password_hash FROM staff WHERE email = 'jennifer@addendumsalon.com') WHERE id = $1", [ben]);
    const me = await signIn('ben.test@addendumsalon.com');
    const r = await me.get(`/api/commission/me/new-clients?${RANGE()}&staffId=${ana}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ newClients: 3, rebookedFuture: 1 });
  });
});

describe('Cross-check against the raw appointment records', () => {
  it('matches a plain recount of every appointment in the CRM', async () => {
    const from = day(-400);
    const to = day(30);
    const api = (await admin.get(`/api/analytics/new-clients?from=${from}&to=${to}`)).body;
    const appts = await db().query<any>('SELECT client_id, staff_id, start_at, square_status FROM appointments WHERE client_id IS NOT NULL ORDER BY start_at, id');
    const created = new Map((await db().query<any>('SELECT id, created_at FROM clients')).map((c) => [c.id, new Date(c.created_at).getTime()]));
    const histStart = Math.min(...(await db().query<any>('SELECT start_at FROM appointments')).map((a) => new Date(a.start_at).getTime()));
    const now = Date.now();
    const start = new Date(`${from}T00:00:00`).getTime() - 2 * DAY; // loose outer bounds, then exact check by local date
    const inRange = (t: number) => { const k = localDate(new Date(t), TZ); return k >= from && k <= to; };

    const expected = new Map<string, { staff: string | null; status: string }>();
    const byClient = new Map<string, any[]>();
    for (const a of appts) byClient.set(a.client_id, [...(byClient.get(a.client_id) ?? []), a]);
    for (const [id, list] of byClient) {
      const first = list.find((a) => a.square_status === 'ACCEPTED' || a.square_status === 'NO_SHOW');
      if (!first) continue;
      const t = new Date(first.start_at).getTime();
      if (t < start || !inRange(t) || created.get(id)! < histStart - 60 * DAY) continue;
      const later = list.filter((a) => a.square_status === 'ACCEPTED' && new Date(a.start_at).getTime() > t);
      const status = later.some((a) => new Date(a.start_at).getTime() > now) ? 'future' : later.length ? 'returned' : 'not_rebooked';
      expected.set(id, { staff: first.staff_id, status });
    }
    const got = new Map(api.clients.map((c: any) => [c.clientId, { staff: c.first.staffId, status: c.rebookStatus }]));
    expect(got).toEqual(expected);
    expect(api.summary.newClients).toBe(expected.size);
    expect(api.summary.withFuture).toBe([...expected.values()].filter((x) => x.status === 'future').length);
    expect(api.summary.rebooked).toBe([...expected.values()].filter((x) => x.status !== 'not_rebooked').length);
    expect(expected.size).toBeGreaterThan(10); // the demo salon really has new clients in this window
  });
});
