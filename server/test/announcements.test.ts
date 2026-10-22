import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { setup } from './helpers.js';

let app: Awaited<ReturnType<typeof setup>>['app'];
let admin: Awaited<ReturnType<typeof setup>>['api'];
let deskId: string;
let jenId: string;

async function as(email: string) {
  const agent = request.agent(app);
  const h = (r: any) => r.set('X-Requested-With', 'addendum-crm');
  await h(agent.post('/api/auth/login')).send({ email, password: 'addendum-demo' });
  return {
    get: (u: string) => agent.get(u),
    post: (u: string, b: object = {}) => h(agent.post(u)).send(b),
    put: (u: string, b: object = {}) => h(agent.put(u)).send(b),
    del: (u: string) => h(agent.delete(u)),
  };
}
const tasks = async () => (await db().one<any>('SELECT count(*)::int n FROM tasks')).n;

beforeAll(async () => {
  ({ app, api: admin } = await setup());
  deskId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
  jenId = (await db().one<any>("SELECT id FROM staff WHERE email = 'jennifer@addendumsalon.com'")).id;
});

describe('Team announcements', () => {
  it('an admin publishes to the whole team; everyone sees it and can mark it read; no tasks are created', async () => {
    const before = await tasks();
    const r = await admin.post('/api/announcements', { title: 'Holiday hours', body: 'Closed Dec 25.', important: true, pinned: true, linkUrl: 'https://example.com/schedule.pdf', linkLabel: 'Schedule' });
    expect(r.status).toBe(201);
    expect(r.body.announcement).toMatchObject({ status: 'published', important: true, pinned: true, authorName: expect.any(String), publishedAt: expect.any(String) });
    expect(await tasks()).toBe(before);

    const jen = await as('jennifer@addendumsalon.com');
    const list = (await jen.get('/api/announcements')).body;
    expect(list.announcements.map((a: any) => a.title)).toContain('Holiday hours');
    expect(list.unread).toBeGreaterThan(0);
    expect((await jen.post(`/api/announcements/${r.body.announcement.id}/read`)).body.unread).toBe(list.unread - 1);
    // Stylists read; they can't publish.
    expect((await jen.post('/api/announcements', { title: 'Mine' })).status).toBe(403);
    expect((await jen.del(`/api/announcements/${r.body.announcement.id}`)).status).toBe(403);
    expect((await admin.post('/api/announcements', { title: 'Bad link', linkUrl: 'javascript:alert(1)' })).status).toBe(400);
  });

  it('audiences, drafts and who may change what', async () => {
    const desk = await as('frontdesk@addendumsalon.com');
    const jen = await as('jennifer@addendumsalon.com');
    // Front desk publishes for receptionists only.
    const forDesk = (await desk.post('/api/announcements', { title: 'Front desk only', audienceRoles: ['receptionist'] })).body.announcement;
    expect((await jen.get('/api/announcements')).body.announcements.some((a: any) => a.id === forDesk.id)).toBe(false);
    expect((await jen.get(`/api/announcements/${forDesk.id}`)).status).toBe(404);
    // A draft is only seen by its author (and people who manage all announcements).
    const draft = (await desk.post('/api/announcements', { title: 'Work in progress', publish: false })).body.announcement;
    expect(draft.status).toBe('draft');
    expect((await jen.get('/api/announcements')).body.announcements.some((a: any) => a.id === draft.id)).toBe(false);
    expect((await desk.post(`/api/announcements/${draft.id}/publish`)).body.announcement.status).toBe('published');
    // Front desk can't edit the owner's announcement; the owner (manage all) can edit front desk's.
    const owners = (await admin.post('/api/announcements', { title: 'Owner note' })).body.announcement;
    expect((await desk.put(`/api/announcements/${owners.id}`, { title: 'Changed' })).status).toBe(403);
    expect((await admin.put(`/api/announcements/${forDesk.id}`, { title: 'Front desk only (edited)', audienceRoles: ['receptionist'] })).status).toBe(200);
    expect((await desk.del(`/api/announcements/${draft.id}`)).status).toBe(200);
  });

  it('announcement permissions are separate from task permissions', async () => {
    const r = await admin.post('/api/admin/users', { name: 'Ann Only', email: 'ann@addendumsalon.com', approveNow: true, role: 'stylist' });
    const id = r.body.user.id;
    await admin.put(`/api/admin/users/${id}/access`, { overrides: { 'tasks:read_own': false, 'tasks:write': false } });
    await request(app).post('/api/auth/reset').set('X-Requested-With', 'addendum-crm').send({ token: new URL(r.body.setupLink).searchParams.get('token'), password: 'Welcome-2026!' });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'ann@addendumsalon.com', password: 'Welcome-2026!' });
    expect((await agent.get('/api/announcements')).status).toBe(200);
    expect((await agent.get('/api/tasks')).status).toBe(403);
    await admin.put(`/api/admin/users/${jenId}/access`, { overrides: { 'announcements:read': false } });
    const jen = await as('jennifer@addendumsalon.com');
    expect((await jen.get('/api/announcements')).status).toBe(403);
    expect((await jen.get('/api/tasks')).status).toBe(200);
    await admin.put(`/api/admin/users/${jenId}/access`, { overrides: { 'announcements:read': null } });
  });
});

describe('Dashboard widgets follow permissions (on the server)', () => {
  it('each role gets only its widgets; a widget never shows data its person can’t open', async () => {
    const own = (await admin.get('/api/dashboard')).body;
    expect(own.widgets).toMatchObject({ schedule: true, followups: true, clients: true, analytics: true });
    expect(own.widgets.teamCommission).not.toBeNull();
    expect(own.widgets.myCommission).not.toBeNull();

    const desk = await as('frontdesk@addendumsalon.com');
    const d = (await desk.get('/api/dashboard')).body;
    expect(d.widgets).toMatchObject({ schedule: true, followups: true, clients: true, analytics: false, teamCommission: null });
    expect(d.widgets.orders).toMatchObject({ scope: 'everyone' });
    expect(d.summary.appointmentsToday).not.toBeNull();

    // An administrator turns the schedule widget off for front desk: the counts disappear from the response.
    await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'dashboard:schedule': false } });
    const d2 = (await desk.get('/api/dashboard')).body;
    expect(d2.widgets.schedule).toBe(false);
    expect(d2.summary.appointmentsToday).toBeNull();
    // Granting the team-commission widget alone shows nothing without "View team commission".
    await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'dashboard:schedule': null, 'dashboard:team_commission': true }, confirm: true });
    expect((await desk.get('/api/dashboard')).body.widgets.teamCommission).toBeNull();
    expect((await desk.get('/api/commission/team?from=2026-01-01&to=2026-01-31')).status).toBe(403);
    expect((await desk.get('/api/analytics')).status).toBe(403);
  });

  it('“Today’s Priorities” can be turned off for one person: the heading and its three counts go, the rest stays', async () => {
    const desk = await as('frontdesk@addendumsalon.com');
    const before = (await desk.get('/api/dashboard')).body;
    expect(before.widgets.priorities).toBe(true);
    expect(before.summary.followUpsDue).not.toBeNull();
    await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'dashboard:priorities': false } });
    const after = (await desk.get('/api/dashboard')).body;
    expect(after.widgets.priorities).toBe(false);
    expect([after.summary.followUpsDue, after.summary.overdueFollowUps, after.summary.readyToRebook]).toEqual([null, null, null]);
    expect(after.summary.appointmentsToday).not.toBeNull();
    expect(after.widgets.followups).toBe(true);
    await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'dashboard:priorities': null } });
  });

  it('built-in role templates get the new permissions by default', async () => {
    const roles = (await admin.get('/api/admin/roles')).body.roles;
    const of = (r: string) => roles.find((x: any) => x.role === r).permissions;
    expect(of('admin')).toEqual(expect.arrayContaining(['dashboard:team_commission', 'announcements:manage']));
    expect(of('receptionist')).toEqual(expect.arrayContaining(['dashboard:schedule', 'announcements:publish']));
    expect(of('receptionist')).not.toContain('dashboard:team_commission');
    expect(of('stylist')).toContain('announcements:read');
    expect(of('stylist')).not.toContain('announcements:publish');
  });
});

describe('My Tasks on the dashboard', () => {
  it('internal tasks report who added them, so personal and assigned tasks can be shown first', async () => {
    const me = (await admin.get('/api/auth/me')).body.user;
    const due = new Date(Date.now() + 3600_000).toISOString();
    const own = await admin.post('/api/tasks', { kind: 'task', type: 'internal', title: 'Order more foils', dueAt: due, assignedStaffId: null });
    const sent = await admin.post('/api/tasks', { kind: 'task', type: 'internal', title: 'Restock the front desk', dueAt: due, assignedStaffId: deskId });
    expect([own.status, sent.status]).toEqual([201, 201]);
    const list = (await admin.get('/api/tasks?status=open&kind=task')).body.tasks as any[];
    expect(list.find((t) => t.id === own.body.id)).toMatchObject({ createdById: me.id, assignedStaffId: null });
    const desk = await as('frontdesk@addendumsalon.com');
    const theirs = (await desk.get('/api/tasks?status=open&kind=task')).body.tasks as any[];
    expect(theirs.find((t) => t.id === sent.body.id)).toMatchObject({ assignedStaffId: deskId, createdById: me.id });
  });
});

describe('Deleting tasks and messages', () => {
  it('only with the delete permission; deleted automatic follow-ups are not created again; finished ones can be cleared', async () => {
    const due = new Date(Date.now() + 3600_000).toISOString();
    const t = (await admin.post('/api/tasks', { kind: 'task', type: 'internal', title: 'Test task', dueAt: due })).body.id;
    const desk = await as('frontdesk@addendumsalon.com');
    expect((await desk.del(`/api/tasks/${t}`)).status).toBe(403);
    expect((await admin.del(`/api/tasks/${t}`)).status).toBe(200);
    expect(await db().one('SELECT 1 FROM tasks WHERE id = $1', [t])).toBeNull();

    // An automatic follow-up (with a rule key) stays deleted.
    const { createTask } = await import('../src/domain/tasks.js');
    const auto = await createTask({ type: 'follow_up', title: 'Auto', dueAt: new Date(), dedupeKey: 'test:auto:1' } as any);
    await admin.del(`/api/tasks/${auto}`);
    expect(await createTask({ type: 'follow_up', title: 'Auto', dueAt: new Date(), dedupeKey: 'test:auto:1' } as any)).toBeNull();

    // Clear finished: completed ones go, open ones stay.
    const open = (await admin.post('/api/tasks', { kind: 'task', type: 'internal', title: 'Still open', dueAt: due })).body.id;
    const done = (await admin.post('/api/tasks', { kind: 'task', type: 'internal', title: 'Done', dueAt: due })).body.id;
    await admin.post(`/api/tasks/${done}/complete`, {});
    const r = await admin.del('/api/tasks/finished?kind=task');
    expect(r.body.removed).toBeGreaterThanOrEqual(1);
    expect(await db().one('SELECT 1 FROM tasks WHERE id = $1', [done])).toBeNull();
    expect(await db().one('SELECT 1 FROM tasks WHERE id = $1', [open])).not.toBeNull();

    // Messages: one message, then the whole conversation.
    const conv = await db().one<any>("INSERT INTO conversations(phone) VALUES ('+15550001234') RETURNING id");
    const m1 = await db().one<any>("INSERT INTO messages(conversation_id, direction, body, status) VALUES ($1,'inbound','hello','received') RETURNING id", [conv.id]);
    await db().query("INSERT INTO messages(conversation_id, direction, body, status) VALUES ($1,'inbound','second','received')", [conv.id]);
    expect((await desk.del(`/api/messages/${m1.id}`)).status).toBe(403);
    expect((await admin.del(`/api/messages/${m1.id}`)).status).toBe(200);
    expect((await db().one<any>('SELECT count(*)::int n FROM messages WHERE conversation_id = $1', [conv.id])).n).toBe(1);
    expect((await admin.del(`/api/messages/conversations/${conv.id}`)).status).toBe(200);
    expect(await db().one('SELECT 1 FROM conversations WHERE id = $1', [conv.id])).toBeNull();
  });
});
