import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ROLE_DEFAULT_PERMISSIONS } from '@addendum/shared';
import { db } from '../src/db/index.js';
import { setup } from './helpers.js';

let app: Awaited<ReturnType<typeof setup>>['app'];
let admin: Awaited<ReturnType<typeof setup>>['api'];

const H = (r: any) => r.set('X-Requested-With', 'addendum-crm');
const anon = () => ({
  post: (url: string, body: object = {}) => H(request(app).post(url)).send(body),
});
async function login(email: string, password: string) {
  const agent = request.agent(app);
  const r = await H(agent.post('/api/auth/login')).send({ email, password });
  return {
    status: r.status, code: r.body?.error?.code,
    get: (url: string) => agent.get(url),
    post: (url: string, body: object = {}) => H(agent.post(url)).send(body),
    put: (url: string, body: object = {}) => H(agent.put(url)).send(body),
    patch: (url: string, body: object = {}) => H(agent.patch(url)).send(body),
    del: (url: string) => H(agent.delete(url)),
  };
}
const tokenFrom = (url: string) => new URL(url).searchParams.get('token')!;
const status = async (id: string) => (await admin.get(`/api/admin/users/${id}`)).body.user.status;

beforeAll(async () => {
  ({ app, api: admin } = await setup());
});

describe('New logins wait for an Admin’s approval', () => {
  it('an account added by an Admin has its own login (no Square) but no access until approved', async () => {
    const r = await admin.post('/api/admin/users', { name: 'Penny Pending', email: 'penny@addendumsalon.com' });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ status: 'pending', squareTeamMemberId: null, canSignIn: false });
    // They can still choose their password from the set-up link…
    expect((await anon().post('/api/auth/reset', { token: tokenFrom(r.body.setupLink), password: 'Welcome-2026!' })).status).toBe(200);
    // …but signing in says it's waiting, and creates no session.
    const pending = await login('penny@addendumsalon.com', 'Welcome-2026!');
    expect([pending.status, pending.code]).toEqual([403, 'pending_approval']);
    expect((await pending.get('/api/auth/me')).status).toBe(401);
    expect((await pending.get('/api/clients')).status).toBe(401);
    // A wrong password gets the usual answer: nothing is revealed without the password.
    expect((await login('penny@addendumsalon.com', 'wrong-password-1')).status).toBe(401);
    // Pending accounts don't appear as active team members anywhere.
    expect((await admin.get('/api/staff')).body.staff.find((s: any) => s.id === r.body.user.id)?.active ?? false).toBe(false);

    const ok = await admin.post(`/api/admin/users/${r.body.user.id}/approve`, { role: 'stylist' });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ status: 'active', role: 'stylist', approvedByName: expect.any(String) });
    const penny = await login('penny@addendumsalon.com', 'Welcome-2026!');
    expect(penny.status).toBe(200);
    const me = (await penny.get('/api/auth/me')).body.user;
    expect(me.permissions.sort()).toEqual([...ROLE_DEFAULT_PERMISSIONS.stylist].sort());
  });

  it('people can request access from the sign-in screen; Admins are alerted and can reject', async () => {
    const before = (await db().one<any>("SELECT count(*)::int n FROM notifications WHERE kind = 'account_pending'")).n;
    const r = await anon().post('/api/auth/request-access', { name: 'Riley Request', email: 'riley@example.com', password: 'Let-me-in-2026' });
    expect(r.status).toBe(200);
    const row = await db().one<any>("SELECT id, approval_status, active, self_requested, role FROM staff WHERE email = 'riley@example.com'");
    expect(row).toMatchObject({ approval_status: 'pending', active: false, self_requested: true, role: 'assistant' });
    expect((await db().one<any>("SELECT count(*)::int n FROM notifications WHERE kind = 'account_pending'")).n).toBeGreaterThan(before);
    // Asking again with a taken email answers the same and changes nothing.
    const again = await anon().post('/api/auth/request-access', { name: 'Someone Else', email: 'OWNER@addendumsalon.com', password: 'Let-me-in-2026' });
    expect([again.status, again.body.message]).toEqual([200, r.body.message]);
    expect((await db().one<any>("SELECT name FROM staff WHERE email = 'owner@addendumsalon.com'")).name).not.toBe('Someone Else');
    // Weak passwords are refused.
    expect((await anon().post('/api/auth/request-access', { name: 'Weak One', email: 'weak@example.com', password: 'short' })).status).toBe(400);

    expect((await login('riley@example.com', 'Let-me-in-2026')).code).toBe('pending_approval');
    expect((await admin.post(`/api/admin/users/${row.id}/reject`)).status).toBe(200);
    expect(await status(row.id)).toBe('rejected');
    expect((await login('riley@example.com', 'Let-me-in-2026')).code).toBe('access_rejected');
    // Rejected isn't "deactivated": reactivate doesn't apply, approving does.
    expect((await admin.post(`/api/admin/users/${row.id}/reactivate`)).status).toBe(400);
    expect((await admin.post(`/api/admin/users/${row.id}/approve`)).status).toBe(200);
    expect((await login('riley@example.com', 'Let-me-in-2026')).status).toBe(200);
  });

  it('access requests can be turned off', async () => {
    expect((await admin.patch('/api/settings', { accounts: { allowAccessRequests: false } })).status).toBe(200);
    expect((await request(app).get('/api/auth/config')).body.allowAccessRequests).toBe(false);
    expect((await anon().post('/api/auth/request-access', { name: 'Late Comer', email: 'late@example.com', password: 'Let-me-in-2026' })).status).toBe(400);
    await admin.patch('/api/settings', { accounts: { allowAccessRequests: true } });
  });

  it('only Admins approve; others with account access can add people but not approve them', async () => {
    const deskId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
    await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'users:manage': true, 'users:permissions': true }, confirm: true });
    const desk = await login('frontdesk@addendumsalon.com', 'addendum-demo');
    const added = await desk.post('/api/admin/users', { name: 'Desk Added', email: 'deskadded@addendumsalon.com' });
    expect(added.status).toBe(201);
    expect(added.body.user.status).toBe('pending');
    expect((await desk.post(`/api/admin/users/${added.body.user.id}/approve`)).status).toBe(403);
    expect((await desk.post(`/api/admin/users/${added.body.user.id}/reject`)).status).toBe(403);
    expect((await desk.post('/api/admin/users', { name: 'Sneaky', email: 'sneaky@addendumsalon.com', approveNow: true })).status).toBe(403);
    expect((await desk.get('/api/admin/users')).body.canApprove).toBe(false);
    expect((await admin.get('/api/admin/users')).body.canApprove).toBe(true);
    // An Admin can add and approve in one step.
    const direct = await admin.post('/api/admin/users', { name: 'Direct Hire', email: 'direct@addendumsalon.com', approveNow: true });
    expect(direct.body.user.status).toBe('active');
  });

  it('approving with admin-level access needs confirming, and a session never outlives approval', async () => {
    const r = await admin.post('/api/admin/users', { name: 'Ada Admin', email: 'ada@addendumsalon.com' });
    const id = r.body.user.id;
    const first = await admin.post(`/api/admin/users/${id}/approve`, { role: 'admin' });
    expect([first.status, first.body.error.code]).toEqual([400, 'confirm_required']);
    expect((await admin.post(`/api/admin/users/${id}/approve`, { role: 'admin', confirm: true })).status).toBe(200);
    await anon().post('/api/auth/reset', { token: tokenFrom((await admin.post(`/api/admin/users/${id}/password-link`)).body.link), password: 'Welcome-2026!' });
    const ada = await login('ada@addendumsalon.com', 'Welcome-2026!');
    expect((await ada.get('/api/auth/me')).status).toBe(200);
    // Even with a live session, an account that isn't approved gets nothing.
    await db().query("UPDATE staff SET approval_status = 'pending' WHERE id = $1", [id]);
    expect((await ada.get('/api/auth/me')).status).toBe(401);
  });
});

describe('Custom role templates', () => {
  it('Admins create, edit, rename, assign and delete templates; built-ins stay', async () => {
    const created = await admin.post('/api/admin/roles', { label: 'Senior Stylist', description: 'Stylists who also manage clients', copyFrom: 'stylist' });
    expect(created.status).toBe(201);
    const key = created.body.role;
    const t = created.body.roles.find((x: any) => x.role === key);
    expect(t).toMatchObject({ label: 'Senior Stylist', builtin: false, members: 0 });
    expect([...t.permissions].sort()).toEqual([...ROLE_DEFAULT_PERMISSIONS.stylist].sort());
    expect((await admin.post('/api/admin/roles', { label: 'senior stylist' })).status).toBe(400); // names are unique

    expect((await admin.put(`/api/admin/roles/${key}`, { permissions: [...t.permissions, 'clients:read'] })).status).toBe(200);
    expect((await admin.patch(`/api/admin/roles/${key}`, { label: 'Lead Stylist' })).body.roles.find((x: any) => x.role === key).label).toBe('Lead Stylist');
    expect((await admin.patch('/api/admin/roles/stylist', { label: 'Renamed' })).status).toBe(400);
    expect((await admin.del('/api/admin/roles/admin')).status).toBe(400);

    // Assign it to someone, at approval or later.
    const u = await admin.post('/api/admin/users', { name: 'Tess Template', email: 'tess@addendumsalon.com' });
    const ok = await admin.post(`/api/admin/users/${u.body.user.id}/approve`, { role: key });
    expect(ok.body.user).toMatchObject({ role: key, roleLabel: 'Lead Stylist' });
    expect((await admin.del(`/api/admin/roles/${key}`)).status).toBe(400); // in use
    expect((await admin.put(`/api/admin/users/${u.body.user.id}/access`, { role: 'stylist' })).status).toBe(200);
    expect((await admin.del(`/api/admin/roles/${key}`)).status).toBe(200);
    expect((await admin.post(`/api/admin/users/${u.body.user.id}/approve`, { role: 'no-such-role' })).status).toBe(400);
  });

  it('only people who manage permissions can create templates, and only with access they hold', async () => {
    const jen = await login('jennifer@addendumsalon.com', 'addendum-demo');
    expect((await jen.post('/api/admin/roles', { label: 'Mine' })).status).toBe(403);
    const sensitive = await admin.post('/api/admin/roles', { label: 'Office Admin', copyFrom: 'admin' });
    expect(sensitive.body.error.code).toBe('confirm_required');
    expect((await admin.post('/api/admin/roles', { label: 'Office Admin', copyFrom: 'admin', confirm: true })).status).toBe(201);
  });
});

describe('Changing your own password', () => {
  it('needs the current password, signs other devices out, and the new one works', async () => {
    const r = await admin.post('/api/admin/users', { name: 'Cara Change', email: 'cara@addendumsalon.com', approveNow: true });
    await anon().post('/api/auth/reset', { token: tokenFrom(r.body.setupLink), password: 'First-pass-2026' });
    const phone = await login('cara@addendumsalon.com', 'First-pass-2026');
    const laptop = await login('cara@addendumsalon.com', 'First-pass-2026');
    expect((await laptop.post('/api/auth/change-password', { current: 'wrong-one-123', password: 'Second-pass-2026' })).status).toBe(400);
    expect((await laptop.post('/api/auth/change-password', { current: 'First-pass-2026', password: 'short' })).status).toBe(400);
    expect((await laptop.post('/api/auth/change-password', { current: 'First-pass-2026', password: 'Second-pass-2026' })).status).toBe(200);
    expect((await laptop.get('/api/auth/me')).status).toBe(200); // this device stays signed in
    expect((await phone.get('/api/auth/me')).status).toBe(401); // others are signed out
    expect((await login('cara@addendumsalon.com', 'First-pass-2026')).status).toBe(401);
    expect((await login('cara@addendumsalon.com', 'Second-pass-2026')).status).toBe(200);
  });
});

describe('Linking an account to Square', () => {
  it('lists Square’s team with who each is linked to', async () => {
    const r = await admin.get('/api/admin/users/square-team-members');
    expect(r.status).toBe(200);
    expect(r.body.connected).toBe(true);
    expect(r.body.members.length).toBeGreaterThan(0);
    expect(r.body.members.some((m: any) => m.linkedTo?.signsIn)).toBe(true);
  });

  it('moves the link off a placeholder the sync added, but never off a real account', async () => {
    const tm = (await admin.get('/api/admin/users/square-team-members')).body.members[0];
    const holder = await db().one<any>('SELECT id FROM staff WHERE square_team_member_id = $1', [tm.id]);
    const placeholder = await db().one<any>("INSERT INTO staff(name, role, square_team_member_id) VALUES ('Square Copy', 'assistant', 'TM-PLACEHOLDER') RETURNING id");
    const me = (await admin.post('/api/admin/users', { name: 'Linda Link', email: 'linda@addendumsalon.com' })).body.user;

    const moved = await admin.patch(`/api/admin/users/${me.id}`, { squareTeamMemberId: 'TM-PLACEHOLDER' });
    expect(moved.status).toBe(200);
    expect(moved.body.user.squareTeamMemberId).toBe('TM-PLACEHOLDER');
    expect((await db().one<any>('SELECT square_team_member_id FROM staff WHERE id = $1', [placeholder!.id])).square_team_member_id).toBeNull();

    if (holder) {
      await db().query("UPDATE staff SET password_hash = COALESCE(password_hash, 'x') WHERE id = $1", [holder.id]);
      expect((await admin.patch(`/api/admin/users/${me.id}`, { squareTeamMemberId: tm.id })).status).toBe(400);
    }
  });
});

describe('Internal tasks reach the person, and each person arranges their Dashboard', () => {
  it('a task sent to someone shows in their notifications, and their mobile can be saved for texting', async () => {
    const jen = await db().one<any>("SELECT id FROM staff WHERE email = 'jennifer@addendumsalon.com'");
    expect((await admin.patch(`/api/admin/users/${jen.id}`, { mobilePhone: 'not a phone' })).status).toBe(400);
    const p = await admin.patch(`/api/admin/users/${jen.id}`, { mobilePhone: '(619) 555-0142' });
    expect(p.body.user.mobilePhone).toBe('+16195550142');
    expect((await admin.get('/api/staff')).body.staff.find((s: any) => s.id === jen.id).mobilePhone).toBe('+16195550142');

    const t = await admin.post('/api/tasks', { kind: 'task', type: 'internal', title: 'Restock the color bar', priority: 'medium', dueAt: new Date(Date.now() + 3600_000).toISOString(), assignedStaffId: jen.id });
    expect(t.status).toBe(201);
    const stylist = await login('jennifer@addendumsalon.com', 'addendum-demo');
    const mine = (await stylist.get('/api/notifications')).body.notifications;
    expect(mine.some((n: any) => n.kind === 'task' && n.body === 'Restock the color bar')).toBe(true);
    // Only for that person, not everyone.
    const others = (await admin.get('/api/notifications')).body.notifications;
    expect(others.some((n: any) => n.body === 'Restock the color bar')).toBe(false);
  });

  it('saves a Dashboard layout per person, and reset clears it', async () => {
    expect((await admin.get('/api/dashboard/layout')).body.layout).toBeNull();
    const layout = { order: ['schedule', 'counts', 'actions'], sizes: { schedule: 'full', actions: 'm' }, hidden: ['counts'] }; // a hidden widget is kept
    expect((await admin.put('/api/dashboard/layout', { layout })).status).toBe(200);
    expect((await admin.get('/api/dashboard/layout')).body.layout).toEqual(layout);
    expect((await admin.put('/api/dashboard/layout', { layout: { order: [], sizes: { x: 'huge' } } })).status).toBe(400);
    const desk = await login('frontdesk@addendumsalon.com', 'addendum-demo');
    expect((await desk.get('/api/dashboard/layout')).body.layout).toBeNull(); // each person has their own
    await admin.put('/api/dashboard/layout', { layout: null });
    expect((await admin.get('/api/dashboard/layout')).body.layout).toBeNull();
  });
});

describe('Customize menu', () => {
  it('saves each person’s own sidebar order and hidden items', async () => {
    const admin = await login('owner@addendumsalon.com', 'addendum-demo');
    const layout = { order: ['/messages', '/', '/clients'], hidden: ['/tasks'] };
    expect((await admin.put('/api/sidebar/layout', { layout })).status).toBe(200);
    expect((await admin.get('/api/sidebar/layout')).body.layout).toEqual(layout);
    expect((await admin.put('/api/sidebar/layout', { layout: { order: ['not a path'], hidden: [] } })).status).toBe(400);
    const desk = await login('frontdesk@addendumsalon.com', 'addendum-demo');
    expect((await desk.get('/api/sidebar/layout')).body.layout).toBeNull(); // each person has their own
    await admin.put('/api/sidebar/layout', { layout: null });
  });
});

describe('Personal look', () => {
  it('each person saves their own accent and light/dark; the salon look is unchanged', async () => {
    const jen = await login('jennifer@addendumsalon.com', 'addendum-demo');
    expect((await jen.get('/api/look')).body.look).toEqual({ accent: null, mode: null, theme: null, workspace: null });
    expect((await jen.put('/api/look', { accent: '#2F6670', mode: 'dark' })).status).toBe(200);
    expect((await jen.get('/api/look')).body.look).toEqual({ accent: '#2F6670', mode: 'dark', theme: null, workspace: null });
    expect((await admin.get('/api/look')).body.look).toEqual({ accent: null, mode: null, theme: null, workspace: null });
    expect((await jen.put('/api/look', { accent: null, mode: null, theme: 'midnight' })).status).toBe(200);
    expect((await jen.get('/api/look')).body.look.theme).toBe('midnight');
    expect((await jen.put('/api/look', { accent: 'red', mode: 'dark' })).status).toBe(400);
    expect((await admin.patch('/api/settings', { appearance: { mode: 'auto', background: 'custom', backgroundColor: '#FFF8F0', textColor: '#222222' } })).status).toBe(200);
    expect((await admin.get('/api/settings')).body.settings.appearance).toMatchObject({ mode: 'auto', background: 'custom', backgroundColor: '#FFF8F0' });
  });
});

describe('My settings', () => {
  it('anyone can see their profile and set their own mobile, and nobody else’s', async () => {
    const jen = await login('jennifer@addendumsalon.com', 'addendum-demo');
    const p = (await jen.get('/api/my-profile')).body.profile;
    expect(p.email).toBe('jennifer@addendumsalon.com');
    expect(p.roleLabel).toBeTruthy();
    expect((await jen.patch('/api/my-profile', { mobilePhone: 'nope' })).status).toBe(400);
    expect((await jen.patch('/api/my-profile', { mobilePhone: '619-555-0177' })).body.profile.mobilePhone).toBe('+16195550177');
    expect((await jen.get('/api/my-profile')).body.profile.mobilePhone).toBe('+16195550177');
    // Their own colour, too.
    expect((await jen.patch('/api/my-profile', { color: '#2e8b6f' })).body.profile.color).toBe('#2E8B6F');
    expect((await jen.patch('/api/my-profile', { color: 'green' })).status).toBe(400);
    expect((await jen.get('/api/my-profile')).body.profile.mobilePhone).toBe('+16195550177'); // untouched
    // Only their own: they still can't edit other accounts.
    const other = await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'");
    expect((await jen.patch(`/api/admin/users/${other.id}`, { mobilePhone: '6195550100' })).status).toBe(403);
  });
});
