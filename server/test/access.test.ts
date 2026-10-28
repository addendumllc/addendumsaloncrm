import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { db } from '../src/db/index.js';
import { updateSettings } from '../src/repos/settings.js';
import { setup } from './helpers.js';

let app: Awaited<ReturnType<typeof setup>>['app'];
let admin: Awaited<ReturnType<typeof setup>>['api'];
const SALON = '203.0.113.10';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** A browser behind the host's proxy: the proxy (this test client) reports the visitor's IP in X-Forwarded-For. */
async function browser(email: string, ip: string, ua = DESKTOP) {
  const agent = request.agent(app);
  const h = (r: any) => r.set('X-Forwarded-For', ip).set('User-Agent', ua).set('X-Requested-With', 'addendum-crm');
  const login = await h(agent.post('/api/auth/login')).send({ email, password: 'addendum-demo' });
  expect(login.status).toBe(200);
  return {
    get: (url: string, extra: Record<string, string> = {}) => { let r = h(agent.get(url)); for (const [k, v] of Object.entries(extra)) r = r.set(k, v); return r; },
    put: (url: string, body: object) => h(agent.put(url)).send(body),
    post: (url: string, body: object = {}) => h(agent.post(url)).send(body),
    del: (url: string) => h(agent.delete(url)),
    patch: (url: string, body: object) => h(agent.patch(url)).send(body),
  };
}
const OFFICE = '198.51.100.200';
const restrict = (patch: object = {}) => updateSettings({ access: { allowAnywhere: false, networks: [{ name: 'Salon', ip: SALON }], salonIps: [], restrictMobile: false, ...patch } });

beforeAll(async () => {
  ({ app, api: admin } = await setup());
});
afterEach(async () => {
  await updateSettings({ access: { allowAnywhere: false, networks: [], salonIps: [], restrictMobile: false } });
});

describe('Location & Access (salon network)', () => {
  it('nothing is restricted until a salon IP is registered', async () => {
    const home = await browser('frontdesk@addendumsalon.com', '198.51.100.7');
    expect((await home.get('/api/clients')).status).toBe(200);
    expect((await home.get('/api/access/status')).body.status).toMatchObject({ configured: false, restricted: false, ip: '198.51.100.7' });
  });

  it('with Allow Access Anywhere off, a computer works only from the salon IP — for every role, without changing permissions', async () => {
    await restrict();
    for (const email of ['owner@addendumsalon.com', 'frontdesk@addendumsalon.com', 'jennifer@addendumsalon.com']) {
      const atSalon = await browser(email, SALON);
      const me = (await atSalon.get('/api/auth/me')).body.user;
      expect((await atSalon.get('/api/appointments?range=today')).status).toBe(200);
      const home = await browser(email, '198.51.100.7');
      const r = await home.get('/api/appointments?range=today');
      expect([email, r.status, r.body.error.code]).toEqual([email, 403, 'network_restricted']);
      // Still signed in, same permissions: only the place changed.
      expect((await home.get('/api/auth/me')).body.user.permissions).toEqual(me.permissions);
      expect((await home.get('/api/access/status')).body.status).toMatchObject({ restricted: true, onSalonNetwork: false });
    }
    // Being at the salon never adds access: a stylist is still refused admin areas there.
    const jen = await browser('jennifer@addendumsalon.com', SALON);
    expect((await jen.get('/api/admin/users')).status).toBe(403);
    expect((await jen.get('/api/analytics')).status).toBe(403);
  });

  it('an office network works like the salon, and shows which network you’re on', async () => {
    await restrict({ networks: [{ name: 'Salon', ip: SALON }, { name: 'Office', ip: OFFICE }] });
    const office = await browser('frontdesk@addendumsalon.com', OFFICE);
    expect((await office.get('/api/clients')).status).toBe(200);
    expect((await office.get('/api/access/status')).body.status).toMatchObject({ onSalonNetwork: true, networkName: 'Office', restricted: false });
    const home = await browser('frontdesk@addendumsalon.com', '192.0.2.44');
    expect((await home.get('/api/clients')).status).toBe(403);
  });

  it('IPs saved by the earlier version still count (as “Salon”)', async () => {
    await updateSettings({ access: { allowAnywhere: false, networks: [], salonIps: [SALON], restrictMobile: false } });
    const atSalon = await browser('frontdesk@addendumsalon.com', SALON);
    expect((await atSalon.get('/api/access/status')).body.status).toMatchObject({ networkName: 'Salon', restricted: false });
    expect((await (await browser('frontdesk@addendumsalon.com', '192.0.2.44')).get('/api/clients')).status).toBe(403);
  });

  it('phones keep working off-site (unless phones are restricted too)', async () => {
    await restrict();
    const phone = await browser('frontdesk@addendumsalon.com', '198.51.100.7', PHONE);
    expect((await phone.get('/api/clients')).status).toBe(200);
    const ipad = await browser('frontdesk@addendumsalon.com', '198.51.100.7');
    expect((await ipad.get('/api/clients', { 'X-Addendum-Device': 'touch' })).status).toBe(200);
    await restrict({ restrictMobile: true });
    expect((await phone.get('/api/clients')).status).toBe(403);
  });

  it('Allow Access Anywhere opens every network straight away', async () => {
    await restrict();
    const home = await browser('frontdesk@addendumsalon.com', '198.51.100.7');
    expect((await home.get('/api/clients')).status).toBe(403);
    await restrict({ allowAnywhere: true });
    expect((await home.get('/api/clients')).status).toBe(200);
  });

  it('uses the address the proxy saw, not one the browser claims', async () => {
    await restrict();
    // The visitor claims the salon IP; the proxy appends their real address, and that's the one used.
    const fake = await browser('frontdesk@addendumsalon.com', `${SALON}, 198.51.100.7`);
    expect((await fake.get('/api/clients')).status).toBe(403);
    expect((await fake.get('/api/access/status')).body.status.ip).toBe('198.51.100.7');
  });

  it('only an Owner/Admin changes it, with their password; the server switch recovers a lock-out', async () => {
    const owner = await browser('owner@addendumsalon.com', SALON);
    const body = { allowAnywhere: false, networks: [{ name: 'Salon', ip: SALON }, { name: 'Salon (IPv6)', ip: '2001:db8::1' }], password: 'addendum-demo' };
    expect((await owner.put('/api/access', { ...body, password: 'wrong' })).status).toBe(400);
    expect((await owner.put('/api/access', { ...body, networks: [{ name: 'Office', ip: 'not-an-ip' }] })).status).toBe(400);
    expect((await owner.put('/api/access', { ...body, networks: [{ name: 'A', ip: SALON }, { name: 'B', ip: SALON }] })).status).toBe(400);
    const ok = await owner.put('/api/access', body);
    expect(ok.status).toBe(200);
    expect(ok.body.access.networks.map((n: any) => n.ip)).toEqual([SALON, '2001:db8::1']);
    expect(ok.body.status).toMatchObject({ onSalonNetwork: true, restricted: false });

    // Front desk with "edit business settings" granted still isn't an Owner/Admin.
    const deskId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
    expect((await owner.put(`/api/admin/users/${deskId}/access`, { overrides: { 'settings:write': true }, confirm: true })).status).toBe(200);
    const desk = await browser('frontdesk@addendumsalon.com', SALON);
    expect((await desk.put('/api/access', { ...body, allowAnywhere: true })).status).toBe(403);
    expect((await (await browser('jennifer@addendumsalon.com', SALON)).put('/api/access', { ...body, allowAnywhere: true })).status).toBe(403);
    // Settings saves can't sneak the access rules in either.
    expect((await owner.patch('/api/settings', { access: { allowAnywhere: true } })).body.settings.access.allowAnywhere).toBe(false);
    // The plain test admin connects from elsewhere on a computer, so it's refused too.
    expect((await admin.get('/api/clients')).status).toBe(403);

    // Salon IP changed and nobody can get in: the server's recovery switch lifts the restriction.
    const home = await browser('owner@addendumsalon.com', '198.51.100.7');
    expect((await home.get('/api/clients')).status).toBe(403);
    loadConfig({ DEMO_MODE: 'true', OWNER_EMAIL: 'owner@addendumsalon.com', OWNER_PASSWORD: 'addendum-demo', APP_URL: 'http://localhost:4000', ACCESS_ALLOW_ANYWHERE: 'true' });
    expect((await home.get('/api/clients')).status).toBe(200);
    loadConfig({ DEMO_MODE: 'true', OWNER_EMAIL: 'owner@addendumsalon.com', OWNER_PASSWORD: 'addendum-demo', APP_URL: 'http://localhost:4000' });
  });
});

describe('Per-person exceptions away from the salon', () => {
  it('“Use the app from anywhere” lets one person in everywhere; “Dashboard only” opens just the Dashboard', async () => {
    const deskId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
    await restrict();
    const owner = await browser('owner@addendumsalon.com', SALON);
    let home = await browser('frontdesk@addendumsalon.com', '198.51.100.7');
    expect((await home.get('/api/clients')).status).toBe(403);

    const g = await owner.put(`/api/admin/users/${deskId}/access`, { overrides: { 'location:dashboard_away': true } });
    expect([g.status, g.body?.error?.message]).toEqual([200, undefined]);
    home = await browser('frontdesk@addendumsalon.com', '198.51.100.7');
    expect((await home.get('/api/access/status')).body.status).toMatchObject({ restricted: false, limited: ['dashboard'] });
    expect((await home.get('/api/dashboard')).status).toBe(200);
    expect((await home.get('/api/tasks?status=open&kind=task')).status).toBe(200);
    const blocked = await home.get('/api/clients');
    expect([blocked.status, blocked.body.error.code]).toEqual([403, 'network_restricted']);
    // At the salon nothing is limited.
    const atSalon = await browser('frontdesk@addendumsalon.com', SALON);
    expect((await atSalon.get('/api/clients')).status).toBe(200);

    await owner.put(`/api/admin/users/${deskId}/access`, { overrides: { 'location:dashboard_away': null, 'location:anywhere': true }, confirm: true });
    home = await browser('frontdesk@addendumsalon.com', '198.51.100.7');
    expect((await home.get('/api/access/status')).body.status).toMatchObject({ restricted: false, limited: null, personalAnywhere: true });
    expect((await home.get('/api/clients')).status).toBe(200);
    // Others are still restricted.
    expect((await (await browser('jennifer@addendumsalon.com', '198.51.100.7')).get('/api/inventory')).status).toBe(403);
    await owner.put(`/api/admin/users/${deskId}/access`, { overrides: { 'location:anywhere': null } });
  });

  it('away from the salon, tasks are internal tasks only — client follow-ups stay at the salon', async () => {
    const deskId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
    await restrict();
    const owner = await browser('owner@addendumsalon.com', SALON);
    // Some of each, made at the salon.
    const client = (await owner.get('/api/clients')).body.clients[0];
    const due = new Date().toISOString();
    const followUp = (await owner.post('/api/tasks', { kind: 'follow_up', type: 'call', title: 'Call about color', dueAt: due, clientId: client.id })).body.id;
    const internal = (await owner.post('/api/tasks', { kind: 'task', type: 'internal', title: 'Order towels', dueAt: due })).body.id;
    expect((await owner.put(`/api/admin/users/${deskId}/access`, { overrides: { 'location:tasks_away': true } })).status).toBe(200);
    const home = await browser('frontdesk@addendumsalon.com', '198.51.100.7');
    expect((await home.get('/api/access/status')).body.status.limited).toEqual(['tasks']);
    const list = (await home.get('/api/tasks?status=open')).body.tasks;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((t: any) => t.kind === 'task')).toBe(true);
    expect(list.some((t: any) => t.id === internal)).toBe(true);
    expect((await home.get(`/api/tasks/${followUp}`)).status).toBe(404);
    expect((await home.post(`/api/tasks/${followUp}/complete`)).status).toBe(403);
    expect((await home.post('/api/tasks', { kind: 'follow_up', type: 'call', title: 'x', dueAt: due, clientId: client.id })).status).toBe(403);
    expect((await home.post('/api/tasks', { kind: 'task', type: 'internal', title: 'Fold capes', dueAt: due })).status).toBe(201);
    expect((await home.post(`/api/tasks/${internal}/complete`)).status).toBe(200);
    // At the salon, follow-ups are there as usual.
    const atSalon = await browser('frontdesk@addendumsalon.com', SALON);
    expect((await atSalon.get('/api/tasks?status=open')).body.tasks.some((t: any) => t.id === followUp)).toBe(true);
    await owner.put(`/api/admin/users/${deskId}/access`, { overrides: { 'location:tasks_away': null } });
  });

  it('time clock: at the salon only (unless allowed anywhere); unpaid lunch comes off; the shift goes to Square', async () => {
    const deskId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
    await restrict();
    const owner = await browser('owner@addendumsalon.com', SALON);
    expect((await owner.put(`/api/admin/users/${deskId}/access`, { overrides: { 'timeclock:use': true, 'location:anywhere': true }, confirm: true })).status).toBe(200);
    expect((await owner.put(`/api/timeclock/schedule/${deskId}`, { days: [{ weekday: 2, start: '09:00', end: '17:30', lunchMinutes: 30, breakMinutes: 10 }] })).status).toBe(200);
    // Away from the salon: can use the app (location:anywhere) but not clock in.
    const home = await browser('frontdesk@addendumsalon.com', '198.51.100.7');
    expect((await home.get('/api/timeclock/me')).body).toMatchObject({ needsSalonNetwork: true, onSalonNetwork: false });
    expect((await home.post('/api/timeclock/in')).status).toBe(403);
    // At the salon.
    const desk = await browser('frontdesk@addendumsalon.com', SALON);
    expect((await desk.post('/api/timeclock/in')).status).toBe(200);
    expect((await desk.post('/api/timeclock/in')).status).toBe(400); // already in
    expect((await desk.post('/api/timeclock/break', { kind: 'lunch' })).body.shift.breaks[0]).toMatchObject({ kind: 'lunch', paid: false });
    expect((await desk.post('/api/timeclock/break/end')).status).toBe(200);
    expect((await desk.post('/api/timeclock/break', { kind: 'rest' })).body.shift.breaks[1]).toMatchObject({ kind: 'rest', paid: true, plannedMinutes: expect.any(Number) });
    // Make it a 4-hour shift with a 30-minute lunch two hours in.
    const shift = await db().one<any>('SELECT id FROM time_clock_shifts WHERE staff_id = $1 AND clock_out_at IS NULL', [deskId]);
    const ago = (m: number) => new Date(Date.now() - m * 60_000);
    await db().query('UPDATE time_clock_shifts SET clock_in_at = $2 WHERE id = $1', [shift.id, ago(240)]);
    await db().query("UPDATE time_clock_breaks SET started_at = $2, ended_at = $3 WHERE shift_id = $1 AND kind = 'lunch'", [shift.id, ago(120), ago(90)]);
    await db().query("UPDATE time_clock_breaks SET started_at = $2 WHERE shift_id = $1 AND kind = 'rest'", [shift.id, ago(30)]);
    const out = await desk.post('/api/timeclock/out');
    expect(out.status).toBe(200);
    expect(out.body.shift).toMatchObject({ paidMinutes: 210, squareSent: false }); // 240 − 30 unpaid lunch; the paid break counts
    expect(out.body.shift.squareError).toMatch(/isn’t linked to a Square team member/); // not linked: kept in the CRM, with the reason
    expect((await db().one<any>("SELECT source, minutes FROM staff_hours WHERE staff_id = $1 AND note = 'Time clock'", [deskId]))).toMatchObject({ source: 'manual', minutes: 210 });
    // Linked to Square: the shift is one timecard, with lunch on it as an unpaid break.
    const tm = (await db().one<any>("SELECT square_team_member_id FROM staff WHERE square_team_member_id IS NOT NULL AND id <> $1 LIMIT 1", [deskId])).square_team_member_id;
    const holder = await db().one<any>('SELECT id FROM staff WHERE square_team_member_id = $1', [tm]);
    await db().query('UPDATE staff SET square_team_member_id = NULL WHERE id = $1', [holder.id]);
    await db().query('UPDATE staff SET square_team_member_id = $2 WHERE id = $1', [deskId, tm]);
    expect((await desk.post('/api/timeclock/in')).status).toBe(200);
    const lunchAt = [ago(120), ago(90)];
    const s2 = await db().one<any>('SELECT id FROM time_clock_shifts WHERE staff_id = $1 AND clock_out_at IS NULL', [deskId]);
    await db().query('UPDATE time_clock_shifts SET clock_in_at = $2 WHERE id = $1', [s2.id, ago(240)]);
    await db().query("INSERT INTO time_clock_breaks(shift_id, kind, paid, planned_minutes, started_at, ended_at) VALUES ($1,'lunch',false,30,$2,$3)", [s2.id, ...lunchAt]);
    const out2 = await desk.post('/api/timeclock/out');
    expect(out2.body.shift).toMatchObject({ paidMinutes: 210, squareSent: true, squareError: null });
    const sq = await db().query<any>("SELECT minutes FROM staff_hours WHERE staff_id = $1 AND note = 'Time clock' AND source = 'square' ORDER BY minutes DESC", [deskId]);
    expect(sq.map((h) => h.minutes)).toEqual([210]);
    const { demoCreatedTimecards } = await import('../src/integrations/square/MockSquareService.js');
    const liveId = (await db().one<any>('SELECT square_timecard_ids FROM time_clock_shifts WHERE id = $1', [s2.id])).square_timecard_ids;
    expect(liveId).toHaveLength(1);
    expect(demoCreatedTimecards.find((t) => t.id === liveId[0])?.breaks).toEqual([{ start_at: lunchAt[0].toISOString(), end_at: lunchAt[1].toISOString(), is_paid: false }]);
    // An Owner edits the shift (left 30 minutes earlier): Square's timecards are replaced, Payroll follows.
    const before = out2.body.shift;
    const oldIds = (await db().one<any>('SELECT square_timecard_ids FROM time_clock_shifts WHERE id = $1', [before.id])).square_timecard_ids;
    const edited = await owner.put(`/api/timeclock/shifts/${before.id}`, {
      clockInAt: before.clockInAt, clockOutAt: new Date(new Date(before.clockOutAt).getTime() - 30 * 60_000).toISOString(),
      breaks: before.breaks.map((b: any) => ({ kind: b.kind, startedAt: b.startedAt, endedAt: b.endedAt })),
    });
    expect(edited.status).toBe(200);
    expect(edited.body.shift).toMatchObject({ paidMinutes: 180, squareSent: true });
    expect(demoCreatedTimecards.some((t) => oldIds.includes(t.id))).toBe(false); // old timecards gone from Square
    expect((await db().query<any>("SELECT minutes FROM staff_hours WHERE staff_id = $1 AND note = 'Time clock' AND source = 'square' ORDER BY minutes DESC", [deskId])).map((h) => h.minutes)).toEqual([180]);
    // Only Owners/Admins edit.
    expect((await desk.put(`/api/timeclock/shifts/${before.id}`, { clockInAt: before.clockInAt, clockOutAt: before.clockOutAt, breaks: [] })).status).toBe(403);
    // Bad times are refused.
    expect((await owner.put(`/api/timeclock/shifts/${before.id}`, { clockInAt: before.clockOutAt, clockOutAt: before.clockInAt, breaks: [] })).status).toBe(400);
    // A forgotten shift is added, then deleted — from Square too.
    const added = await owner.post('/api/timeclock/shifts', { staffId: deskId, clockInAt: ago(60 * 26).toISOString(), clockOutAt: ago(60 * 22).toISOString(), breaks: [] });
    expect(added.status).toBe(201);
    expect(added.body.shift).toMatchObject({ paidMinutes: 240, squareSent: true });
    const addedIds = (await db().one<any>('SELECT square_timecard_ids FROM time_clock_shifts WHERE id = $1', [added.body.shift.id])).square_timecard_ids;
    expect((await owner.del(`/api/timeclock/shifts/${added.body.shift.id}`)).status).toBe(200);
    expect(demoCreatedTimecards.some((t) => addedIds.includes(t.id))).toBe(false);
    expect(await db().one('SELECT 1 FROM staff_hours WHERE square_timecard_id = ANY($1::text[])', [addedIds])).toBeNull();
    // Live on Square: clocking in clocks in there; lunch is an unpaid break on that same timecard; clock-out closes it.
    const liveIn = await desk.post('/api/timeclock/in');
    expect(liveIn.body.shift.squareLive).toBe(true);
    const openNow = () => demoCreatedTimecards.filter((t) => t.team_member_id === tm && !t.end_at);
    expect(openNow().length).toBe(1);
    await desk.post('/api/timeclock/break', { kind: 'lunch' });
    expect(openNow().length).toBe(1); // still clocked in on Square, on an unpaid break
    expect(openNow()[0].breaks).toEqual([expect.objectContaining({ end_at: null, is_paid: false })]);
    await desk.post('/api/timeclock/break/end');
    expect(openNow()[0].breaks).toEqual([expect.objectContaining({ end_at: expect.any(String), is_paid: false })]);
    const liveOut = await desk.post('/api/timeclock/out');
    expect(liveOut.body.shift).toMatchObject({ squareSent: true, squareLive: false, squareError: null });
    expect(openNow().length).toBe(0);
    const liveIds = (await db().one<any>('SELECT square_timecard_ids FROM time_clock_shifts WHERE id = $1', [liveOut.body.shift.id])).square_timecard_ids;
    expect(liveIds.length).toBe(1); // one timecard, lunch on it
    expect(liveIds.every((id: string) => demoCreatedTimecards.some((t) => t.id === id && t.end_at))).toBe(true);
    await db().query('UPDATE staff SET square_team_member_id = NULL WHERE id = $1', [deskId]);
    await db().query('UPDATE staff SET square_team_member_id = $2 WHERE id = $1', [holder.id, tm]);
    // "Clock in from anywhere" lifts the network rule.
    await owner.put(`/api/admin/users/${deskId}/access`, { overrides: { 'timeclock:anywhere': true } });
    expect((await (await browser('frontdesk@addendumsalon.com', '198.51.100.7')).post('/api/timeclock/in')).status).toBe(200);
    await owner.put(`/api/admin/users/${deskId}/access`, { overrides: { 'timeclock:use': null, 'timeclock:anywhere': null, 'location:anywhere': null } });
  });

  it('“Clock in from anywhere” opens just the time clock away from the salon; without it, clocking needs an approved network', async () => {
    const deskId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
    await restrict();
    const owner = await browser('owner@addendumsalon.com', SALON);
    await owner.put(`/api/admin/users/${deskId}/access`, { overrides: { 'timeclock:use': true } });
    try {
      // Without the permission: refused away from the salon, fine at the salon.
      const away = await browser('frontdesk@addendumsalon.com', '198.51.100.7');
      expect((await away.post('/api/timeclock/in')).status).toBe(403);
      const atSalon = await browser('frontdesk@addendumsalon.com', SALON);
      await atSalon.post('/api/timeclock/out'); // an earlier test may have left this person clocked in
      expect((await atSalon.post('/api/timeclock/in')).status).toBe(200);
      expect((await atSalon.post('/api/timeclock/out')).status).toBe(200);
      // With it: the time clock works away (and only the time clock — the rest of the CRM stays at the salon).
      await owner.put(`/api/admin/users/${deskId}/access`, { overrides: { 'timeclock:use': true, 'timeclock:anywhere': true } });
      const away2 = await browser('frontdesk@addendumsalon.com', '198.51.100.7');
      expect((await away2.get('/api/timeclock/me')).body.needsSalonNetwork).toBe(false);
      expect((await away2.post('/api/timeclock/in')).status).toBe(200);
      expect((await away2.post('/api/timeclock/out')).status).toBe(200);
      expect((await away2.get('/api/clients')).status).toBe(403);
      expect((await away2.get('/api/auth/me')).status).toBe(200);
    } finally {
      await owner.put(`/api/admin/users/${deskId}/access`, { overrides: { 'timeclock:use': null, 'timeclock:anywhere': null } });
    }
  });

  it('chosen sections work away from the salon, and nothing else does', async () => {
    const jenId = (await db().one<any>("SELECT id FROM staff WHERE email = 'jennifer@addendumsalon.com'")).id;
    await restrict();
    const owner = await browser('owner@addendumsalon.com', SALON);
    const g = await owner.put(`/api/admin/users/${jenId}/access`, { overrides: { 'location:orders_away': true, 'location:commission_away': true, 'location:messages_away': true }, confirm: true });
    expect(g.status).toBe(200);
    const home = await browser('jennifer@addendumsalon.com', '198.51.100.7');
    // Messages isn't listed: she can't open Messages anyway, so the exception means nothing for her.
    expect((await home.get('/api/access/status')).body.status).toMatchObject({ restricted: false, limited: ['orders', 'commission'] });
    expect((await home.get('/api/inventory/requests')).status).toBe(200);
    expect((await home.get('/api/commission/me')).body.error?.code).not.toBe('network_restricted'); // allowed away (pay still asks for the password)
    const blocked = await home.get('/api/appointments');
    expect([blocked.status, blocked.body.error.code]).toEqual([403, 'network_restricted']);
    expect(blocked.body.error.message).toContain('Order Hair, Earnings & Goals');
    expect((await home.get('/api/inventory-sync')).status).toBe(403);
    await owner.put(`/api/admin/users/${jenId}/access`, { overrides: { 'location:orders_away': null, 'location:commission_away': null, 'location:messages_away': null } });
  });

  it('Transformations can be opened away from the salon: viewing, uploading and editing their own work', async () => {
    const jenId = (await db().one<any>("SELECT id FROM staff WHERE email = 'jennifer@addendumsalon.com'")).id;
    await restrict();
    const owner = await browser('owner@addendumsalon.com', SALON);
    expect((await owner.put(`/api/admin/users/${jenId}/access`, { overrides: { 'location:transformations_away': true }, confirm: true })).status).toBe(200);
    const home = await browser('jennifer@addendumsalon.com', '198.51.100.7');
    expect((await home.get('/api/access/status')).body.status).toMatchObject({ limited: ['transformations'] });
    expect((await home.get('/api/transformations')).status).toBe(200);
    const t = await home.post('/api/transformations', { mainService: 'Haircut', technicalNotes: 'from home' });
    expect(t.status).toBe(201);
    expect((await home.patch(`/api/transformations/${t.body.transformation.id}`, { technicalNotes: 'edited from home' })).status).toBe(200);
    expect((await home.get('/api/clients')).body.error.code).toBe('network_restricted'); // nothing else
    await owner.put(`/api/admin/users/${jenId}/access`, { overrides: { 'location:transformations_away': null } });
  });
});
