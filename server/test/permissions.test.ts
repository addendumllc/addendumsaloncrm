import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ROLE_DEFAULT_PERMISSIONS } from '@addendum/shared';
import { db } from '../src/db/index.js';
import { changeAccess } from '../src/domain/users.js';
import { MockEmailService } from '../src/integrations/email/EmailService.js';
import { setup } from './helpers.js';

let app: Awaited<ReturnType<typeof setup>>['app'];
let admin: Awaited<ReturnType<typeof setup>>['api'];
let ownerId: string;
let deskId: string;

function client(agent: ReturnType<typeof request.agent>) {
  const h = (r: any) => r.set('X-Requested-With', 'addendum-crm');
  return {
    agent,
    get: (url: string) => agent.get(url),
    post: (url: string, body: object = {}) => h(agent.post(url)).send(body),
    patch: (url: string, body: object = {}) => h(agent.patch(url)).send(body),
    put: (url: string, body: object = {}) => h(agent.put(url)).send(body),
    del: (url: string) => h(agent.delete(url)),
  };
}
async function signIn(email: string, password = 'addendum-demo') {
  const agent = request.agent(app);
  const r = await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email, password });
  expect([email, r.status]).toEqual([email, 200]);
  return client(agent);
}
const tokenFrom = (url: string) => new URL(url).searchParams.get('token')!;

/**
 * Creates an account through the API, sets its password through the one-time link like a new employee would, and has
 * the Admin approve it (new logins wait for approval).
 */
async function newEmployee(name: string, email: string, extra: object = {}) {
  const r = await admin.post('/api/admin/users', { name, email, ...extra });
  expect(r.status).toBe(201);
  const set = await request(app).post('/api/auth/reset').set('X-Requested-With', 'addendum-crm').send({ token: tokenFrom(r.body.setupLink), password: 'Welcome-2026!' });
  expect(set.status).toBe(200);
  expect((await admin.post(`/api/admin/users/${r.body.user.id}/approve`, { confirm: true })).status).toBe(200);
  return { id: r.body.user.id as string, user: r.body.user, api: await signIn(email, 'Welcome-2026!') };
}

beforeAll(async () => {
  ({ app, api: admin } = await setup());
  ownerId = (await admin.get('/api/auth/me')).body.user.id;
  deskId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
});

describe('Role templates', () => {
  it('offers Admin, Reception, Stylist and Assistant, with existing employees unchanged', async () => {
    const roles = (await admin.get('/api/admin/roles')).body.roles;
    expect(roles.map((r: any) => r.label)).toEqual(['Admin', 'Reception', 'Stylist', 'Assistant']);
    const roleOf = async (email: string) => (await db().one<any>('SELECT role FROM staff WHERE email = $1', [email])).role;
    expect(await roleOf('owner@addendumsalon.com')).toBe('admin');
    expect(await roleOf('frontdesk@addendumsalon.com')).toBe('receptionist');
    expect(await roleOf('jennifer@addendumsalon.com')).toBe('stylist');
    // Assistants: day-to-day help only.
    const assistant = roles.find((r: any) => r.role === 'assistant');
    for (const p of ['integrations:manage', 'users:manage', 'users:permissions', 'commission:team', 'inventory:sync', 'inventory:manage', 'clients:delete', 'privacy:export_all', 'transactions:read']) {
      expect(assistant.permissions).not.toContain(p);
    }
  });
});

describe('New accounts', () => {
  it('start as Assistant with the Assistant defaults, never as an administrator', async () => {
    const ava = await newEmployee('Nina New', 'nina@addendumsalon.com');
    expect(ava.user.role).toBe('assistant');
    const me = (await ava.api.get('/api/auth/me')).body.user;
    expect(me.role).toBe('assistant');
    expect(me.permissions.sort()).toEqual([...ROLE_DEFAULT_PERMISSIONS.assistant].sort());
    expect((await ava.api.get('/api/clients')).status).toBe(200);
    expect((await ava.api.get('/api/dashboard')).status).toBe(200);
    for (const [m, url] of [['get', '/api/admin/credentials'], ['get', '/api/admin/users'], ['get', '/api/inventory-sync'], ['get', '/api/analytics'],
      ['get', '/api/audit'], ['get', '/api/privacy/export'], ['patch', '/api/settings'], ['post', '/api/inventory/products/shopify-push']] as const) {
      expect([url, (await (ava.api as any)[m](url, { business: { name: 'X' }, variationIds: ['x'] })).status]).toEqual([url, 403]);
    }
    const someClient = (await admin.get('/api/clients')).body.clients[0];
    expect((await ava.api.del(`/api/clients/${someClient.id}`)).status).toBe(403);
  });

  it('the setup link works once', async () => {
    const r = await admin.post('/api/admin/users', { name: 'Once Only', email: 'once@addendumsalon.com' });
    const token = tokenFrom(r.body.setupLink);
    const send = (pw: string) => request(app).post('/api/auth/reset').set('X-Requested-With', 'addendum-crm').send({ token, password: pw });
    expect((await send('short')).status).toBe(400); // too weak
    expect((await send('Good-password-1')).status).toBe(200);
    expect((await send('Good-password-2')).status).toBe(400);
  });

  it('only people who can assign roles can create someone with another role, and Admin needs confirming', async () => {
    const plain = await admin.post('/api/admin/users', { name: 'Desk Two', email: 'desk2@addendumsalon.com', role: 'admin' });
    expect(plain.status).toBe(400);
    expect(plain.body.error.code).toBe('confirm_required');
    expect((await admin.post('/api/admin/users', { name: 'Desk Two', email: 'desk2@addendumsalon.com', role: 'receptionist' })).status).toBe(201);
    expect((await admin.post('/api/admin/users', { name: 'Dup', email: 'DESK2@addendumsalon.com' })).status).toBe(400);
  });
});

describe('Individual permissions', () => {
  it('a grant for one receptionist doesn’t change another receptionist', async () => {
    const two = await newEmployee('Rae Reception', 'rae@addendumsalon.com', { role: 'receptionist' });
    const desk = await signIn('frontdesk@addendumsalon.com');
    const r = await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'inventory:manage': true } });
    expect(r.status).toBe(200);
    expect(r.body.user.permissions.find((p: any) => p.key === 'inventory:manage')).toMatchObject({ effective: true, fromRole: false, source: 'granted' });
    expect((await desk.get('/api/auth/me')).body.user.permissions).toContain('inventory:manage');
    expect((await two.api.get('/api/auth/me')).body.user.permissions).not.toContain('inventory:manage');
    // The role template itself is untouched.
    expect((await admin.get('/api/admin/roles')).body.roles.find((x: any) => x.role === 'receptionist').permissions).not.toContain('inventory:manage');
  });

  it('removing a permission applies on the very next request', async () => {
    const desk = await signIn('frontdesk@addendumsalon.com');
    expect((await desk.get('/api/leads')).status).toBe(200);
    await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'leads:read': false, 'inventory:manage': true } });
    expect((await desk.get('/api/leads')).status).toBe(403);
  });

  it('sensitive permissions need explicit confirmation', async () => {
    const r = await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'commission:team': true } });
    expect(r.status).toBe(400);
    expect(r.body.error.details.sensitive).toEqual(['commission:team']);
    expect((await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'commission:team': true }, confirm: true })).status).toBe(200);
  });

  it('previews a role change, and changing role drops individual grants so nothing elevated carries over', async () => {
    const preview = (await admin.post(`/api/admin/users/${deskId}/access/preview`, { role: 'assistant' })).body.preview;
    expect(preview.droppedOverrides).toEqual(expect.arrayContaining(['inventory:manage', 'commission:team']));
    expect(preview.removed).toEqual(expect.arrayContaining(['inventory:manage', 'commission:team', 'leads:write']));
    expect(preview.droppedOverrides).not.toContain('leads:read'); // restrictions are kept
    const r = await admin.put(`/api/admin/users/${deskId}/access`, { role: 'assistant' });
    expect(r.body.user.role).toBe('assistant');
    const perms = r.body.user.permissions.filter((p: any) => p.effective).map((p: any) => p.key);
    expect(perms).not.toContain('inventory:manage');
    expect(perms).not.toContain('commission:team');
  });

  it('resets someone to their role defaults', async () => {
    await admin.put(`/api/admin/users/${deskId}/access`, { role: 'receptionist' });
    const r = await admin.put(`/api/admin/users/${deskId}/access`, { resetToRole: true });
    expect(r.body.user.overrideCount).toBe(0);
    expect(r.body.user.permissions.filter((p: any) => p.effective).map((p: any) => p.key).sort()).toEqual([...ROLE_DEFAULT_PERMISSIONS.receptionist].sort());
  });

  it('records role and permission changes in the activity log, names only', async () => {
    const entries = (await admin.get('/api/audit?limit=200')).body.entries;
    const actions = entries.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['user.create', 'user.permissions', 'user.role_change', 'user.permissions_reset', 'user.password_link']));
    const text = JSON.stringify(entries);
    expect(text).not.toMatch(/reset-password\?token=/);
    expect(text).not.toContain('Welcome-2026!');
  });
});

describe('No self-promotion, no going around the rules', () => {
  it('nobody can change their own role, permissions or status', async () => {
    expect((await admin.put(`/api/admin/users/${ownerId}/access`, { overrides: { 'audit:read': false } })).status).toBe(403);
    expect((await admin.post(`/api/admin/users/${ownerId}/deactivate`)).status).toBe(403);
  });

  it('non-administrators can’t reach user management at all', async () => {
    const desk = await signIn('frontdesk@addendumsalon.com');
    const stylist = await signIn('jennifer@addendumsalon.com');
    for (const who of [desk, stylist]) {
      expect((await who.get('/api/admin/users')).status).toBe(403);
      expect((await who.put(`/api/admin/users/${deskId}/access`, { role: 'admin', confirm: true })).status).toBe(403);
      expect((await who.put('/api/admin/roles/receptionist', { permissions: ['integrations:manage'], confirm: true })).status).toBe(403);
    }
  });

  it('an account manager can only create Assistants, can only give out what they have, and can’t touch admins', async () => {
    const mgr = await newEmployee('Mia Manager', 'mia@addendumsalon.com', { role: 'receptionist' });
    const g = await admin.put(`/api/admin/users/${mgr.id}/access`, { overrides: { 'users:manage': true }, confirm: true });
    expect([g.status, g.body.error]).toEqual([200, undefined]);
    const al = await mgr.api.post('/api/admin/users', { name: 'Al Assist', email: 'al@addendumsalon.com' });
    expect([al.status, al.body.error]).toEqual([201, undefined]);
    expect((await mgr.api.post('/api/admin/users', { name: 'Big Boss', email: 'boss@addendumsalon.com', role: 'admin', confirm: true })).status).toBe(403);
    expect((await mgr.api.post(`/api/admin/users/${ownerId}/password-link`)).status).toBe(403);
    expect((await mgr.api.post(`/api/admin/users/${ownerId}/deactivate`)).status).toBe(403);
    expect((await mgr.api.put(`/api/admin/users/${deskId}/access`, { overrides: { 'leads:read': true } })).status).toBe(403); // needs users:permissions

    // With users:permissions too, they still can't hand out permissions they don't have themselves.
    await admin.put(`/api/admin/users/${mgr.id}/access`, { overrides: { 'users:manage': true, 'users:permissions': true }, confirm: true });
    const grant = await mgr.api.put(`/api/admin/users/${deskId}/access`, { overrides: { 'integrations:manage': true }, confirm: true });
    expect(grant.status).toBe(403);
    expect(grant.body.error.message).toMatch(/only give out permissions you have/);
  });

  it('there is always someone left who can manage permissions', async () => {
    // Simulates an all-powerful actor trying to remove the last account that can manage permissions.
    const admins = await db().query<any>(`SELECT s.id FROM staff s WHERE s.active AND s.password_hash IS NOT NULL AND (s.role = 'admin'
      OR EXISTS (SELECT 1 FROM staff_permission_overrides o WHERE o.staff_id = s.id AND o.permission = 'users:permissions' AND o.granted))`);
    const fake = { id: deskId, name: 'x', email: 'x', role: 'admin' as const, permissions: ROLE_DEFAULT_PERMISSIONS.admin };
    for (const a of admins.slice(1).filter((x: any) => x.id !== deskId)) await changeAccess(fake, a.id, { overrides: { 'users:permissions': false } });
    const last = admins.find((x: any) => x.id !== deskId);
    await db().query("DELETE FROM staff_permission_overrides WHERE staff_id = $1 AND permission = 'users:permissions'", [deskId]);
    await expect(changeAccess(fake, last.id, { overrides: { 'users:permissions': false } })).rejects.toThrow(/nobody able to manage/);
    expect((await admin.put('/api/admin/roles/admin', { permissions: ['dashboard:view'] })).status).toBe(403); // not your own role
  });
});

describe('Account status and passwords', () => {
  it('deactivating signs the person out immediately; reactivating lets them back in', async () => {
    const tmp = await newEmployee('Tess Temp', 'tess@addendumsalon.com');
    expect((await tmp.api.get('/api/auth/me')).status).toBe(200);
    expect((await admin.post(`/api/admin/users/${tmp.id}/deactivate`)).status).toBe(200);
    expect((await tmp.api.get('/api/auth/me')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'tess@addendumsalon.com', password: 'Welcome-2026!' })).status).toBe(401);
    await admin.post(`/api/admin/users/${tmp.id}/reactivate`);
    await signIn('tess@addendumsalon.com', 'Welcome-2026!');
  });

  it('forgot-password answers the same either way and emails a one-time link', async () => {
    MockEmailService.outbox.length = 0;
    const post = (email: string) => request(app).post('/api/auth/forgot').set('X-Requested-With', 'addendum-crm').send({ email });
    const a = await post('tess@addendumsalon.com');
    const b = await post('nobody@nowhere.com');
    expect(a.body).toEqual(b.body);
    expect(MockEmailService.outbox).toHaveLength(1);
    const url = MockEmailService.outbox[0].text.match(/https?:\/\/\S+reset-password\?token=\S+/)![0];
    const old = await signIn('tess@addendumsalon.com', 'Welcome-2026!');
    expect((await request(app).get(`/api/auth/reset/${tokenFrom(url)}`)).body.valid).toBe(true);
    expect((await request(app).post('/api/auth/reset').set('X-Requested-With', 'addendum-crm').send({ token: tokenFrom(url), password: 'Brand-new-pass-9' })).status).toBe(200);
    expect((await old.get('/api/auth/me')).status).toBe(401); // other devices signed out
    await signIn('tess@addendumsalon.com', 'Brand-new-pass-9');
  });
});

describe('Record-level privacy', () => {
  it('hides phone numbers and emails from people without contact access', async () => {
    const nina = await signIn('nina@addendumsalon.com', 'Welcome-2026!');
    const ninaId = (await nina.get('/api/auth/me')).body.user.id;
    await admin.put(`/api/admin/users/${ninaId}/access`, { overrides: { 'clients:contact': false } });
    const list = (await nina.get('/api/clients')).body.clients;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c: any) => c.phone === null && c.email === null)).toBe(true);
    const profile = (await nina.get(`/api/clients/${list[0].id}`)).body;
    expect(profile.client.phone).toBeNull();
    expect((await nina.get('/api/tasks')).body.tasks.every((t: any) => t.contactPhone === null)).toBe(true);
    expect((await admin.get('/api/clients')).body.clients.some((c: any) => c.phone)).toBe(true);
  });

  it('a stylist allowed “their own customers” sees only those, whatever the URL', async () => {
    const jen = await signIn('jennifer@addendumsalon.com');
    const jenId = (await jen.get('/api/auth/me')).body.user.id;
    // Stylists get "their own customers" by default, never everyone's.
    const perms = (await jen.get('/api/auth/me')).body.user.permissions;
    expect(perms).toContain('clients:read_assigned');
    expect(perms).not.toContain('clients:read');
    expect(jenId).toBeTruthy();
    const mine = (await jen.get('/api/clients?limit=500')).body.clients;
    const all = (await admin.get('/api/clients?limit=500')).body.clients;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.length).toBeLessThan(all.length);
    const notMine = all.find((c: any) => !mine.some((m: any) => m.id === c.id));
    expect((await jen.get(`/api/clients/${notMine.id}`)).status).toBe(404);
    expect((await jen.get(`/api/rebooking/clients/${notMine.id}`)).status).toBe(404);
    expect((await jen.get(`/api/clients/${mine[0].id}`)).status).toBe(200);
  });

  it('unknown API paths are refused by default, even for administrators', async () => {
    expect((await admin.get('/api/some-new-thing')).status).toBe(403);
  });

  it('activity log export is limited to people allowed to export it', async () => {
    const desk = await signIn('frontdesk@addendumsalon.com');
    expect((await desk.get('/api/audit/export')).status).toBe(403);
    const r = await admin.get('/api/audit/export');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
  });
});
