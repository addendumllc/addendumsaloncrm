import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { setup } from './helpers.js';
import { localDate } from '../src/domain/rebookingSchedule.js';

/** Each role signs in with its own account and is checked against the API directly, not just the UI. */
let app: Awaited<ReturnType<typeof setup>>['app'];
let admin: Awaited<ReturnType<typeof setup>>['api'];
type Client = ReturnType<typeof as>;
let receptionist: Client;
let stylist: Client;
let otherStylist: Client;
let stylistId: string;
let otherStylistId: string;

function as(agent: ReturnType<typeof request.agent>) {
  return {
    get: (url: string) => agent.get(url),
    post: (url: string, body: object = {}) => agent.post(url).set('X-Requested-With', 'addendum-crm').send(body),
    patch: (url: string, body: object = {}) => agent.patch(url).set('X-Requested-With', 'addendum-crm').send(body),
    del: (url: string) => agent.delete(url).set('X-Requested-With', 'addendum-crm'),
  };
}
async function signIn(email: string) {
  const agent = request.agent(app);
  const r = await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email, password: 'addendum-demo' });
  expect(r.status).toBe(200);
  return as(agent);
}

beforeAll(async () => {
  ({ app, api: admin } = await setup());
  receptionist = await signIn('frontdesk@addendumsalon.com');
  stylist = await signIn('jennifer@addendumsalon.com');
  otherStylist = await signIn('michael@addendumsalon.com');
  stylistId = (await stylist.get('/api/auth/me')).body.user.id;
  otherStylistId = (await otherStylist.get('/api/auth/me')).body.user.id;
});

describe('Roles', () => {
  it('every user has one of Admin, Reception, Stylist or Assistant', async () => {
    const roles = (await db().query<{ role: string }>('SELECT DISTINCT role FROM staff')).map((r) => r.role).sort();
    expect(roles.every((r) => ['admin', 'receptionist', 'stylist', 'assistant'].includes(r))).toBe(true);
    expect((await receptionist.get('/api/auth/me')).body.user.role).toBe('receptionist');
    expect((await stylist.get('/api/auth/me')).body.user.role).toBe('stylist');
  });
});

describe('Stylists: their own calendar, clients and follow-ups, plus Order Hair', () => {
  it('are refused every other section, whatever the URL', async () => {
    const blocked: [string, string][] = [
      ['get', '/api/dashboard'], ['get', '/api/leads'],
      ['get', '/api/messages/conversations'], ['get', '/api/analytics'],
      ['get', '/api/staff'], ['get', '/api/audit'],
      ['get', '/api/integrations/status'], ['get', '/api/integrations/setup-info'], ['get', '/api/privacy/export'],
      ['post', '/api/leads'], ['post', '/api/clients'], ['post', '/api/messages/handoff'],
      ['patch', '/api/settings'], ['post', '/api/integrations/square/sync'], ['post', '/api/demo/reset'],
    ];
    for (const [m, url] of blocked) {
      const r = await (stylist as any)[m](url, {});
      expect([url, r.status]).toEqual([url, 403]);
    }
    // Notifications: only ones addressed to them (e.g. a task sent to them) — never salon-wide alerts like new texts.
    await db().query("INSERT INTO notifications(staff_id, kind, title) VALUES (NULL, 'message', 'New text from a client')");
    const n = await stylist.get('/api/notifications');
    expect(n.status).toBe(200);
    expect(n.body.notifications.every((x: any) => x.title !== 'New text from a client')).toBe(true);
    expect((await stylist.get('/api/updates')).body.unreadMessages).toBe(0);
  });

  it('search finds only their own clients, never leads or messages', async () => {
    const r = (await stylist.get('/api/search?q=a')).body;
    expect(r.leads ?? []).toEqual([]);
    expect(r.conversations ?? []).toEqual([]);
  });

  it('only ever get their own appointments, even when asking for someone else', async () => {
    const mine = (await stylist.get('/api/appointments?range=upcoming')).body.appointments;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((a: any) => a.staffId === stylistId)).toBe(true);
    const asked = (await stylist.get(`/api/appointments?range=upcoming&staffId=${otherStylistId}`)).body.appointments;
    expect(asked.every((a: any) => a.staffId === stylistId)).toBe(true);

    const theirs = (await admin.get(`/api/appointments?range=upcoming&staffId=${otherStylistId}`)).body.appointments;
    expect(theirs.length).toBeGreaterThan(0);
    expect((await stylist.get(`/api/appointments/${theirs[0].id}`)).status).toBe(404);
    expect((await stylist.get(`/api/appointments/${mine[0].id}`)).status).toBe(200);
  });

  it('manage only their own hair orders', async () => {
    const r = await stylist.post('/api/inventory/requests', { forStaffId: otherStylistId, neededBy: localDate(new Date(Date.now() + 5 * 86400_000), 'America/Los_Angeles'), items: [{ collection: 'K-Tip Extensions', quantity: 1 }] });
    expect(r.status).toBe(201);
    expect(r.body.request.forStaffId).toBe(stylistId); // can't order "for" someone else
    const item = r.body.request.items[0].id;
    expect((await stylist.patch(`/api/inventory/requests/${r.body.request.id}/items/${item}`, { neededBy: '2026-12-01' })).status).toBe(200);

    expect((await otherStylist.get(`/api/inventory/requests/${r.body.request.id}`)).status).toBe(403);
    expect((await otherStylist.patch(`/api/inventory/requests/${r.body.request.id}/items/${item}`, { neededBy: '2026-12-02' })).status).toBe(403);
    expect((await otherStylist.get('/api/inventory/requests')).body.requests.some((x: any) => x.id === r.body.request.id)).toBe(false);
    expect((await stylist.patch(`/api/inventory/requests/${r.body.request.id}`, { status: 'ordered' })).status).toBe(403);
    expect((await stylist.patch(`/api/inventory/requests/${r.body.request.id}`, { status: 'cancelled' })).status).toBe(200);
  });

  it('see only the harmless part of settings', async () => {
    const s = (await stylist.get('/api/settings')).body;
    expect(s.limited).toBe(true);
    expect(s.settings.highlevel).toBeUndefined();
  });
});

describe('Receptionists: the CRM, without administration', () => {
  it('use the day-to-day CRM, including every stylist’s calendar', async () => {
    for (const url of ['/api/dashboard', '/api/clients', '/api/leads', '/api/tasks', '/api/messages/conversations', '/api/staff', '/api/search?q=a']) {
      expect([url, (await receptionist.get(url)).status]).toEqual([url, 200]);
    }
    const appts = (await receptionist.get('/api/appointments?range=upcoming')).body.appointments;
    expect(new Set(appts.map((a: any) => a.staffId)).size).toBeGreaterThan(1);
  });

  it('are refused administrator-only settings, reports and destructive actions', async () => {
    const client = (await admin.get('/api/clients')).body.clients[0];
    const checks: [string, string, object?][] = [
      ['get', '/api/analytics'], ['get', '/api/audit'], ['get', '/api/integrations/setup-info'], ['get', '/api/privacy/export'],
      ['patch', '/api/settings', { rules: { newLeadHours: 2 } }], ['patch', '/api/settings', { business: { name: 'X' } }],
      ['post', '/api/integrations/shopify/test'], ['post', '/api/integrations/square/disconnect'], ['post', '/api/demo/reset'],
      ['get', `/api/clients/${client.id}/export`], ['post', `/api/clients/${client.id}/archive`], ['del', `/api/clients/${client.id}`],
      ['patch', `/api/staff/${stylistId}`, { color: '#123456' }],
    ];
    for (const [m, url, body] of checks) {
      const r = await (receptionist as any)[m](url, body ?? {});
      expect([url, r.status]).toEqual([url, 403]);
    }
    expect((await receptionist.get('/api/settings')).body.limited).toBe(true);
  });

  it('see every hair order and can order for a stylist, but not mark orders or touch Shopify', async () => {
    const r = await receptionist.post('/api/inventory/requests', { forStaffId: stylistId, neededBy: localDate(new Date(Date.now() + 5 * 86400_000), 'America/Los_Angeles'), items: [{ collection: 'Tape-In Extensions', quantity: 2 }] });
    expect(r.body.request.forStaffId).toBe(stylistId);
    expect((await receptionist.get('/api/inventory/requests')).body.requests.length).toBeGreaterThan(1);
    const item = r.body.request.items[0].id;
    expect((await receptionist.patch(`/api/inventory/requests/${r.body.request.id}/items/${item}`, { neededBy: '2026-12-05' })).status).toBe(200);
    expect((await receptionist.patch(`/api/inventory/requests/${r.body.request.id}`, { status: 'ordered' })).status).toBe(403);
    expect((await receptionist.post('/api/inventory/products/shopify-push', { variationIds: ['demo-v1'] })).status).toBe(403);
  });
});

describe('Administrators', () => {
  it('can reach everything', async () => {
    for (const url of ['/api/analytics', '/api/audit', '/api/integrations/setup-info', '/api/staff', '/api/clients']) {
      expect([url, (await admin.get(url)).status]).toEqual([url, 200]);
    }
    expect((await admin.get('/api/settings')).body.limited).toBeUndefined();
  });
});

describe('Role changes apply immediately', () => {
  it('uses the current role on every request, without signing in again', async () => {
    expect((await stylist.get('/api/leads')).status).toBe(403);
    await db().query("UPDATE staff SET role = 'receptionist' WHERE id = $1", [stylistId]);
    expect((await stylist.get('/api/leads')).status).toBe(200);
    expect((await stylist.get('/api/auth/me')).body.user.permissions).toContain('clients:read');
    await db().query("UPDATE staff SET role = 'stylist' WHERE id = $1", [stylistId]);
    expect((await stylist.get('/api/leads')).status).toBe(403);
  });
});

describe('Client preferences and notes', () => {
  it('anyone who adds notes can keep preferences and allergies up to date, and edit a note', async () => {
    const admin = (await setup()).api;
    const c = (await admin.get('/api/clients')).body.clients[0];
    expect((await admin.patch(`/api/clients/${c.id}/preferences`, { preferences: 'Oat latte · quiet appointment', allergies: 'Sensitive scalp' })).status).toBe(200);
    let d = (await admin.get(`/api/clients/${c.id}`)).body.client;
    expect([d.preferences, d.allergies]).toEqual(['Oat latte · quiet appointment', 'Sensitive scalp']);
    await admin.patch(`/api/clients/${c.id}/preferences`, { allergies: '' }); // cleared; preferences untouched
    d = (await admin.get(`/api/clients/${c.id}`)).body.client;
    expect([d.preferences, d.allergies]).toEqual(['Oat latte · quiet appointment', null]);
    const note = await admin.post(`/api/clients/${c.id}/notes`, { body: 'Likes it short' });
    expect((await admin.patch(`/api/notes/${note.body.id}`, { body: 'Likes it shorter in summer' })).status).toBe(200);
    expect((await admin.get(`/api/clients/${c.id}`)).body.notes.some((n: any) => n.body === 'Likes it shorter in summer')).toBe(true);
  });
});
