import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { setup } from './helpers.js';

let app: Awaited<ReturnType<typeof setup>>['app'];
let admin: Awaited<ReturnType<typeof setup>>['api'];
let ava: Awaited<ReturnType<typeof signIn>>;
let avaId: string;
let jenId: string;
let michaelId: string;

async function signIn(email: string, password = 'addendum-demo') {
  const agent = request.agent(app);
  const h = (r: any) => r.set('X-Requested-With', 'addendum-crm');
  expect((await h(agent.post('/api/auth/login')).send({ email, password })).status).toBe(200);
  return {
    get: (url: string) => agent.get(url),
    post: (url: string, body: object = {}) => h(agent.post(url)).send(body),
    put: (url: string, body: object = {}) => h(agent.put(url)).send(body),
    patch: (url: string, body: object = {}) => h(agent.patch(url)).send(body),
    del: (url: string) => h(agent.delete(url)),
  };
}
const RANGE = '/api/appointments?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z';
const staffOf = async (api: { get: (u: string) => any }, extra = '') => new Set<string>((await api.get(`${RANGE}${extra}`)).body.appointments.map((a: any) => a.staffId));
const anAppointmentOf = async (staffId: string) => (await db().one<any>('SELECT id FROM appointments WHERE staff_id = $1 LIMIT 1', [staffId])).id as string;

beforeAll(async () => {
  ({ app, api: admin } = await setup());
  const id = async (email: string) => (await db().one<any>('SELECT id FROM staff WHERE email = $1', [email])).id;
  jenId = await id('jennifer@addendumsalon.com');
  michaelId = await id('michael@addendumsalon.com');
  const r = await admin.post('/api/admin/users', { name: 'Ava Assistant', email: 'ava@addendumsalon.com', approveNow: true });
  avaId = r.body.user.id;
  await request(app).post('/api/auth/reset').set('X-Requested-With', 'addendum-crm').send({ token: new URL(r.body.setupLink).searchParams.get('token'), password: 'Welcome-2026!' });
  ava = await signIn('ava@addendumsalon.com', 'Welcome-2026!');
});

describe('Assistant calendars', () => {
  it('by default an assistant sees only their own calendar, whatever they ask for', async () => {
    const me = (await ava.get('/api/auth/me')).body.user;
    expect(me.permissions).toContain('appointments:read_own');
    expect(me.permissions).not.toContain('appointments:read');
    expect((await staffOf(ava)).size).toBe(0); // not a provider, so nothing of their own
    expect((await staffOf(ava, `&staffId=${jenId}`)).size).toBe(0);
    expect((await ava.get(`/api/appointments/${await anAppointmentOf(jenId)}`)).status).toBe(404);
    expect((await ava.get('/api/dashboard')).body.summary.appointmentsToday).toBeNull();
  });

  it('“Can view team calendars” shows everyone’s, or only the chosen team members', async () => {
    await admin.put(`/api/admin/users/${avaId}/access`, { overrides: { 'appointments:read': true } });
    const all = await staffOf(ava);
    expect(all.has(jenId) && all.has(michaelId)).toBe(true);

    const r = await admin.put(`/api/admin/users/${avaId}/calendars`, { staffIds: [jenId] });
    expect(r.body.user.calendarStaffIds).toEqual([jenId]);
    expect([...(await staffOf(ava))]).toEqual([jenId]);
    expect((await staffOf(ava, `&staffId=${michaelId}`)).size).toBe(0);
    expect((await ava.get(`/api/appointments/${await anAppointmentOf(michaelId)}`)).status).toBe(404);
    const one = (await ava.get(`/api/appointments/${await anAppointmentOf(jenId)}`)).body.appointment;
    expect(one.bookedValueCents).toBeNull(); // a limited view hides prices
    const found = (await ava.get('/api/search?q=a')).body.appointments as any[];
    for (const a of found) expect((await db().one<any>('SELECT staff_id FROM appointments WHERE id = $1', [a.id])).staff_id).toBe(jenId);
    expect((await ava.get('/api/dashboard')).body.summary.appointmentsToday).toBeNull();

    await admin.put(`/api/admin/users/${avaId}/calendars`, { staffIds: null });
    expect((await staffOf(ava)).size).toBeGreaterThan(1);
  });

  it('viewing never allows changing appointments, and other access is unchanged', async () => {
    const id = await anAppointmentOf(jenId);
    for (const r of [await ava.post('/api/appointments', {}), await ava.patch(`/api/appointments/${id}`, { status: 'CANCELLED' }), await ava.del(`/api/appointments/${id}`), await ava.put(`/api/appointments/${id}`, {})]) {
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    expect((await ava.get('/api/admin/users')).status).toBe(403);
    expect((await ava.get('/api/leads')).status).toBe(403);
  });

  it('only people who manage permissions choose calendars, and never their own', async () => {
    expect((await ava.put(`/api/admin/users/${avaId}/calendars`, { staffIds: null })).status).toBe(403);
    const owner = (await admin.get('/api/auth/me')).body.user.id;
    expect((await admin.put(`/api/admin/users/${owner}/calendars`, { staffIds: [jenId] })).status).toBe(403);
    expect((await admin.put(`/api/admin/users/${avaId}/calendars`, { staffIds: ['00000000-0000-0000-0000-000000000000'] })).status).toBe(400);
  });

  it('stylists still see only their own calendar', async () => {
    const jen = await signIn('jennifer@addendumsalon.com');
    expect([...(await staffOf(jen))]).toEqual([jenId]);
    expect((await staffOf(jen, `&staffId=${michaelId}`)).size).toBe(0);
  });
});
