import { beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { MAX_FAILED, weakCode } from '../src/domain/loginCodes.js';
import { setup } from './helpers.js';

let app: Awaited<ReturnType<typeof setup>>['app'];
let admin: Awaited<ReturnType<typeof setup>>['api'];
let jenId: string;
let michaelId: string;
const JEN = 'jennifer@addendumsalon.com';

async function as(email: string, password = 'addendum-demo') {
  const agent = request.agent(app);
  const h = (r: any) => r.set('X-Requested-With', 'addendum-crm');
  await h(agent.post('/api/auth/login')).send({ email, password });
  return {
    get: (u: string) => agent.get(u),
    post: (u: string, b: object = {}) => h(agent.post(u)).send(b),
    put: (u: string, b: object = {}) => h(agent.put(u)).send(b),
    del: (u: string) => h(agent.delete(u)),
  };
}
async function codeLogin(email: string, code: string) {
  const agent = request.agent(app);
  const r = await agent.post('/api/auth/login-code').set('X-Requested-With', 'addendum-crm').send({ email, code });
  return { status: r.status, code: r.body?.error?.code, agent };
}
const setCode = async (id: string, body: object) => admin.put(`/api/admin/users/${id}/code`, body);

beforeAll(async () => {
  ({ app, admin } = await setup().then((s) => ({ app: s.app, admin: s.api })));
  expect((await admin.post('/api/auth/confirm-password', { password: 'addendum-demo' })).status).toBe(200);
  const id = async (email: string) => (await db().one<any>('SELECT id FROM staff WHERE email = $1', [email])).id;
  jenId = await id(JEN);
  michaelId = await id('michael@addendumsalon.com');
});

describe('Sign in with a custom code', () => {
  it('an Owner generates a code; the person signs in with email + code; a wrong code is refused', async () => {
    const r = await setCode(jenId, { generate: true });
    expect(r.status).toBe(200);
    const code: string = r.body.generatedCode;
    expect(code).toMatch(/^\d{8}$/);
    expect(r.body.code).toMatchObject({ set: true, enabled: true, locked: false });
    expect(JSON.stringify(r.body.code)).not.toContain(code); // the status never includes it

    const ok = await codeLogin(JEN, code);
    expect(ok.status).toBe(200);
    const me = (await ok.agent.get('/api/auth/me')).body.user;
    expect(me.id).toBe(jenId);
    expect(me.permissions).not.toContain('users:manage'); // same role permissions as a password sign-in
    expect((await codeLogin(JEN, '83920175')).status).toBe(401);
    expect((await codeLogin('nobody@addendumsalon.com', code)).status).toBe(401);
  });

  it('someone’s code never opens another account', async () => {
    const jenCode = (await setCode(jenId, { generate: true })).body.generatedCode;
    await setCode(michaelId, { code: 'Blowout-7731' });
    expect((await codeLogin('michael@addendumsalon.com', jenCode)).status).toBe(401);
    expect((await codeLogin(JEN, 'Blowout-7731')).status).toBe(401);
    expect((await codeLogin('michael@addendumsalon.com', 'Blowout-7731')).status).toBe(200);
  });

  it('locks after repeated wrong codes (even the right one then fails), alerts Admins, and a reset unlocks', async () => {
    const code = (await setCode(jenId, { generate: true })).body.generatedCode;
    for (let i = 0; i < MAX_FAILED - 1; i++) expect((await codeLogin(JEN, `9${i}482716`)).status).toBe(401);
    expect((await codeLogin(JEN, '90000001')).code).toBe('code_locked');
    expect((await codeLogin(JEN, code)).code).toBe('code_locked');
    expect((await db().one<any>("SELECT count(*)::int n FROM notifications WHERE kind = 'code_locked'")).n).toBeGreaterThan(0);
    expect((await admin.get(`/api/admin/users/${jenId}/code`)).body.code.locked).toBe(true);
    // Password sign-in is unaffected.
    expect((await (await as(JEN)).get('/api/auth/me')).status).toBe(200);
    const fresh = (await setCode(jenId, { generate: true })).body.generatedCode;
    expect((await codeLogin(JEN, fresh)).status).toBe(200);
  });

  it('a new code works at once; the old one stops; disabling and revoking end code sessions immediately', async () => {
    const oldCode = (await setCode(jenId, { generate: true })).body.generatedCode;
    const session = await codeLogin(JEN, oldCode);
    const pwSession = await as(JEN);
    const newCode = (await setCode(jenId, { generate: true })).body.generatedCode;
    expect((await codeLogin(JEN, oldCode)).status).toBe(401);
    expect((await session.agent.get('/api/auth/me')).status).toBe(401); // the old code's session ended
    expect((await pwSession.get('/api/auth/me')).status).toBe(200); // a password session isn't touched
    const s2 = await codeLogin(JEN, newCode);
    expect(s2.status).toBe(200);

    expect((await admin.post(`/api/admin/users/${jenId}/code/disable`)).body.code.enabled).toBe(false);
    expect((await s2.agent.get('/api/auth/me')).status).toBe(401);
    expect((await codeLogin(JEN, newCode)).status).toBe(401);
    await admin.post(`/api/admin/users/${jenId}/code/enable`);
    expect((await codeLogin(JEN, newCode)).status).toBe(200);

    expect((await admin.del(`/api/admin/users/${jenId}/code`)).body.code.set).toBe(false);
    expect((await codeLogin(JEN, newCode)).status).toBe(401);
  });

  it('a correct code doesn’t get round approval or deactivation', async () => {
    const r = await admin.post('/api/admin/users', { name: 'Petra Pending', email: 'petra@addendumsalon.com' });
    const code = (await setCode(r.body.user.id, { generate: true })).body.generatedCode;
    expect((await codeLogin('petra@addendumsalon.com', code)).code).toBe('pending_approval');
    const mCode = (await setCode(michaelId, { generate: true })).body.generatedCode;
    await admin.post(`/api/admin/users/${michaelId}/deactivate`);
    expect((await codeLogin('michael@addendumsalon.com', mCode)).status).toBe(401);
    await admin.post(`/api/admin/users/${michaelId}/reactivate`);
  });
});

describe('Owner controls', () => {
  it('only an Owner/Admin who confirmed their password can create, change, disable or revoke codes', async () => {
    const deskId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
    await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'users:manage': true, 'users:permissions': true }, confirm: true });
    const desk = await as('frontdesk@addendumsalon.com');
    await desk.post('/api/auth/confirm-password', { password: 'addendum-demo' });
    for (const r of [await desk.put(`/api/admin/users/${jenId}/code`, { generate: true }), await desk.post(`/api/admin/users/${jenId}/code/disable`), await desk.del(`/api/admin/users/${jenId}/code`)]) {
      expect(r.status).toBe(403);
    }
    const jen = await as(JEN);
    expect((await jen.put(`/api/admin/users/${jenId}/code`, { code: 'Self-Made-9921' })).status).toBe(403);
    // An Owner who hasn't confirmed their password yet is asked to.
    const owner = await as('owner@addendumsalon.com');
    expect((await owner.put(`/api/admin/users/${jenId}/code`, { generate: true })).body.error.code).toBe('reauth_required');
  });

  it('refuses easily guessed codes', async () => {
    for (const bad of ['1234', '123456', '12345678', '11111111', '87654321', 'abcdef', 'abababab', 'password', 'Jennifer2026', 'qwerty123']) {
      expect([bad, (await setCode(jenId, { code: bad })).status]).toEqual([bad, 400]);
    }
    expect(weakCode('Blowout-7731')).toBeNull();
    expect(weakCode('48201937')).toBeNull();
  });

  it('assigns a Square location from the synced locations only', async () => {
    await setCode(jenId, { generate: true });
    const locs = (await admin.get('/api/admin/locations')).body.locations;
    expect(locs.length).toBeGreaterThan(0);
    const r = await admin.put(`/api/admin/users/${jenId}/code/location`, { squareLocationId: locs[0].id });
    expect(r.body.code).toMatchObject({ squareLocationId: locs[0].id, squareLocationName: locs[0].name });
    expect((await admin.put(`/api/admin/users/${jenId}/code/location`, { squareLocationId: 'NOT-A-LOCATION' })).status).toBe(400);
  });
});

describe('Codes are never stored or logged in plain text', () => {
  it('keeps only an Argon2id hash, and nothing records the code', async () => {
    const logs: string[] = [];
    const spies = (['log', 'warn', 'error', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => { logs.push(a.map(String).join(' ')); }));
    const code = (await setCode(jenId, { generate: true })).body.generatedCode;
    await setCode(michaelId, { code: 'Highlight-5521' });
    await codeLogin(JEN, code);
    await codeLogin(JEN, '50293817');
    spies.forEach((s) => s.mockRestore());
    const row = await db().one<any>('SELECT code_hash FROM staff_login_codes WHERE staff_id = $1', [jenId]);
    expect(row.code_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const everything = JSON.stringify([await db().query('SELECT * FROM staff_login_codes'), await db().query('SELECT * FROM audit_logs'), await db().query('SELECT * FROM notifications'), await db().query('SELECT * FROM sessions')]);
    for (const c of [code, 'Highlight-5521', '50293817']) {
      expect(everything).not.toContain(c);
      expect(logs.join('\n')).not.toContain(c);
    }
    // Unique salt: the same code gives different hashes.
    await setCode(michaelId, { code: 'Highlight-5521' });
    const again = await db().one<any>('SELECT code_hash FROM staff_login_codes WHERE staff_id = $1', [michaelId]);
    await setCode(michaelId, { code: 'Highlight-5521' });
    expect((await db().one<any>('SELECT code_hash FROM staff_login_codes WHERE staff_id = $1', [michaelId])).code_hash).not.toBe(again.code_hash);
  });
});
