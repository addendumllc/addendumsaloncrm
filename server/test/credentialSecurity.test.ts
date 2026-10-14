import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { config, loadConfig } from '../src/config.js';
import { db } from '../src/db/index.js';
import { setConnectionTestOverride } from '../src/integrations/connectionTests.js';
import { loadSavedCredentials } from '../src/integrations/credentials.js';
import { redact } from '../src/lib/redact.js';
import { setup } from './helpers.js';

// Test-only placeholder values — not real credentials for any service.
const TOKEN_1 = 'pit-TEST-0000-aaaa-not-a-real-token';
const TOKEN_2 = 'pit-TEST-1111-bbbb-not-a-real-token';
const SHOP_SECRET = 'shpss_TEST-placeholder-secret-0000';

let app: Awaited<ReturnType<typeof setup>>['app'];
let admin: Awaited<ReturnType<typeof setup>>['api'];

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
const ok = (message = 'Connected (test stand-in).') => async () => ({ ok: true, message, warnings: [] });
const fail = async () => ({ ok: false, message: 'HighLevel rejected the token.', warnings: [] });

beforeAll(async () => {
  ({ app, api: admin } = await setup());
  expect((await admin.post('/api/auth/confirm-password', { password: 'addendum-demo' })).status).toBe(200);
});
afterEach(() => setConnectionTestOverride(null));

describe('Owner-only credential changes', () => {
  it('needs the Owner/Admin role and a confirmed password; a wrong password confirms nothing', async () => {
    const owner = await as('owner@addendumsalon.com');
    const body = { values: { HIGHLEVEL_PRIVATE_TOKEN: TOKEN_1, HIGHLEVEL_LOCATION_ID: 'loc-test' } };
    expect((await owner.put('/api/admin/credentials/highlevel', body)).body.error.code).toBe('reauth_required');
    expect((await owner.post('/api/auth/confirm-password', { password: 'not-it' })).status).toBe(400);
    expect((await owner.put('/api/admin/credentials/highlevel', body)).body.error.code).toBe('reauth_required');

    // Front desk given "manage integrations" can see the status, but never change secrets.
    const deskId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
    await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'integrations:manage': true }, confirm: true });
    const desk = await as('frontdesk@addendumsalon.com');
    expect((await desk.get('/api/admin/credentials')).status).toBe(200);
    expect((await desk.post('/api/auth/confirm-password', { password: 'addendum-demo' })).status).toBe(200);
    for (const r of [await desk.put('/api/admin/credentials/highlevel', body), await desk.del('/api/admin/credentials/highlevel'),
      await desk.post('/api/admin/credentials/highlevel/disable'), await desk.post('/api/integrations/square/disconnect')]) {
      expect(r.status).toBe(403);
    }
    // Stylists can't even read the status.
    expect((await (await as('jennifer@addendumsalon.com')).get('/api/admin/credentials')).status).toBe(403);
  });
});

describe('Replacing a working credential', () => {
  it('tests the new value first and keeps the working one if it fails', async () => {
    setConnectionTestOverride(ok());
    await admin.put('/api/admin/credentials/highlevel', { values: { HIGHLEVEL_PRIVATE_TOKEN: TOKEN_1, HIGHLEVEL_LOCATION_ID: 'loc-test' } });
    expect((await admin.post('/api/admin/credentials/highlevel/test')).body.integration.status).toBe('connected');

    setConnectionTestOverride(fail);
    const bad = await admin.put('/api/admin/credentials/highlevel', { values: { HIGHLEVEL_PRIVATE_TOKEN: TOKEN_2 } });
    expect([bad.status, bad.body.error.code]).toEqual([409, 'verification_failed']);
    expect(config().HIGHLEVEL_PRIVATE_TOKEN).toBe(TOKEN_1);
    const st = (await admin.get('/api/admin/credentials')).body.integrations.find((i: any) => i.provider === 'highlevel');
    expect(st.status).toBe('connected');

    // Saving anyway is a deliberate choice (e.g. while the provider is down).
    const forced = await admin.put('/api/admin/credentials/highlevel', { values: { HIGHLEVEL_PRIVATE_TOKEN: TOKEN_2 }, skipVerify: true });
    expect(forced.status).toBe(200);
    expect(config().HIGHLEVEL_PRIVATE_TOKEN).toBe(TOKEN_2);
  });

  it('switches an integration off without deleting it, and back on', async () => {
    const off = await admin.post('/api/admin/credentials/highlevel/disable');
    expect(off.body.integration).toMatchObject({ status: 'disabled', disabled: true });
    expect(config().HIGHLEVEL_PRIVATE_TOKEN).toBeUndefined();
    const on = await admin.post('/api/admin/credentials/highlevel/enable');
    expect(on.body.integration.disabled).toBe(false);
    expect(config().HIGHLEVEL_PRIVATE_TOKEN).toBe(TOKEN_2);
  });

  it('keeps saved credentials when a deployment brings empty values', async () => {
    loadConfig({ DEMO_MODE: 'true', OWNER_EMAIL: 'owner@addendumsalon.com', OWNER_PASSWORD: 'addendum-demo', APP_URL: 'http://localhost:4000', HIGHLEVEL_PRIVATE_TOKEN: '' });
    await loadSavedCredentials();
    expect(config().HIGHLEVEL_PRIVATE_TOKEN).toBe(TOKEN_2);
  });
});

describe('Secrets stay secret', () => {
  it('never returns, records or logs secret values', async () => {
    setConnectionTestOverride(ok('Connected to Test Shop (test-shop.myshopify.com). Permissions granted: read_products, read_inventory, write_inventory, read_locations.'));
    await admin.put('/api/admin/credentials/shopify', { values: { SHOPIFY_STORE_DOMAIN: 'test-shop.myshopify.com', SHOPIFY_CLIENT_ID: 'client-id-test', SHOPIFY_CLIENT_SECRET: SHOP_SECRET } });
    const t = (await admin.post('/api/admin/credentials/shopify/test')).body.integration;
    expect(t.lastTestMessage).toContain('Permissions granted');
    const shown = JSON.stringify((await admin.get('/api/admin/credentials')).body);
    expect(shown).toContain('test-shop.myshopify.com'); // public settings are shown…
    for (const s of [SHOP_SECRET, TOKEN_1, TOKEN_2]) expect(shown).not.toContain(s); // …secrets never

    const history = (await admin.get('/api/admin/credentials/history')).body.history;
    expect(history.some((h: any) => h.action === 'credentials.update_rejected')).toBe(true);
    expect(history.find((h: any) => h.provider === 'shopify' && h.action === 'credentials.update').fields).toContain('SHOPIFY_CLIENT_SECRET');
    const stored = JSON.stringify([history, await db().query('SELECT * FROM audit_logs'), await db().query('SELECT * FROM integration_credentials')]);
    for (const s of [SHOP_SECRET, TOKEN_1, TOKEN_2]) expect(stored).not.toContain(s);

    // Anything logged that contains a secret is scrubbed.
    expect(redact(`Shopify said: invalid client_secret ${SHOP_SECRET}`)).not.toContain(SHOP_SECRET);
    expect(redact('Authorization: Bearer abcdefgh12345678')).toBe('Authorization: Bearer [redacted]');
    expect(redact('postgres://user:hunter2pass@db:5432/x')).toBe('postgres://user:[redacted]@db:5432/x');
  });
});
