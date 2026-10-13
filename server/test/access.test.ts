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
    patch: (url: string, body: object) => h(agent.patch(url)).send(body),
  };
}
const restrict = (patch: object = {}) => updateSettings({ access: { allowAnywhere: false, salonIps: [SALON], restrictMobile: false, ...patch } });

beforeAll(async () => {
  ({ app, api: admin } = await setup());
});
afterEach(async () => {
  await updateSettings({ access: { allowAnywhere: false, salonIps: [], restrictMobile: false } });
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
    const body = { allowAnywhere: false, salonIps: [SALON, '2001:db8::1'], password: 'addendum-demo' };
    expect((await owner.put('/api/access', { ...body, password: 'wrong' })).status).toBe(400);
    expect((await owner.put('/api/access', { ...body, salonIps: ['not-an-ip'] })).status).toBe(400);
    const ok = await owner.put('/api/access', body);
    expect(ok.status).toBe(200);
    expect(ok.body.access.salonIps).toEqual([SALON, '2001:db8::1']);
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
