import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { config } from '../src/config.js';
import { db } from '../src/db/index.js';
import { loadSavedCredentials } from '../src/integrations/credentials.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: Awaited<ReturnType<typeof setup>>['app'];
beforeAll(async () => {
  ({ api, app } = await setup());
  // Changing credentials needs the Owner to have confirmed their password recently.
  expect((await api.post('/api/auth/confirm-password', { password: 'addendum-demo' })).status).toBe(200);
});

const SECRET = 'shpss_TEST-very-secret-value-123456';

async function as(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email, password: 'addendum-demo' });
  return agent;
}

describe('Settings → API & Integrations', () => {
  it('lists every integration with its status and required fields', async () => {
    const r = await api.get('/api/admin/credentials');
    expect(r.status).toBe(200);
    expect(r.body.integrations.map((i: any) => i.provider)).toEqual(['square', 'shopify', 'shopify2', 'highlevel', 'highlevel_hair', 'email', 'google', 'ai']);
    const shopify = r.body.integrations.find((i: any) => i.provider === 'shopify');
    expect(shopify.status).toBe('not_configured');
    expect(shopify.missing.length).toBeGreaterThan(0);
  });

  it('saves credentials encrypted, uses them, and never sends a secret back', async () => {
    const r = await api.put('/api/admin/credentials/shopify', {
      values: { SHOPIFY_STORE_DOMAIN: 'https://AddendumHair.myshopify.com/admin', SHOPIFY_CLIENT_ID: 'client-abc', SHOPIFY_CLIENT_SECRET: SECRET },
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    const f = Object.fromEntries(r.body.integration.fields.map((x: any) => [x.key, x]));
    expect(f.SHOPIFY_CLIENT_SECRET).toMatchObject({ set: true, source: 'saved', value: null, secret: true });
    expect(f.SHOPIFY_CLIENT_ID).toMatchObject({ set: true, value: 'client-abc', secret: false }); // public ID is shown
    expect(f.SHOPIFY_STORE_DOMAIN.value).toBe('addendumhair.myshopify.com'); // normalised
    expect(r.body.integration.missing).toEqual([]);
    expect(r.body.integration.status).toBe('untested');
    // Encrypted at rest.
    const row = await db().one<any>("SELECT * FROM integration_credentials WHERE provider = 'shopify'");
    expect(row.encrypted_values).not.toContain(SECRET);
    expect(row.encrypted_values).not.toContain('client-abc');
    // Applied to the running config, and again after a restart.
    expect(config().SHOPIFY_CLIENT_SECRET).toBe(SECRET);
    await loadSavedCredentials();
    expect(config().SHOPIFY_STORE_DOMAIN).toBe('addendumhair.myshopify.com');
    // The list endpoint never includes it either.
    expect(JSON.stringify((await api.get('/api/admin/credentials')).body)).not.toContain(SECRET);
  });

  it('keeps a saved secret when the box is left blank, and replaces it when a new one is typed', async () => {
    await api.put('/api/admin/credentials/shopify', { values: { SHOPIFY_CLIENT_SECRET: '' } });
    expect(config().SHOPIFY_CLIENT_SECRET).toBe(SECRET);
    await api.put('/api/admin/credentials/shopify', { values: { SHOPIFY_CLIENT_SECRET: 'shpss_new-one' } });
    expect(config().SHOPIFY_CLIENT_SECRET).toBe('shpss_new-one');
  });

  it('records which fields changed in the activity log, never the values', async () => {
    const entries = (await api.get('/api/audit?limit=20')).body.entries.filter((e: any) => e.action === 'credentials.update');
    expect(entries.length).toBeGreaterThan(0);
    const text = JSON.stringify(entries);
    expect(text).toContain('SHOPIFY_CLIENT_SECRET');
    expect(text).not.toContain('shpss_new-one');
    expect(text).not.toContain(SECRET);
  });

  it('validates values with clear messages', async () => {
    const bad = await api.put('/api/admin/credentials/shopify', { values: { SHOPIFY_STORE_DOMAIN: 'addendumhair.com' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/myshopify\.com/);
    expect((await api.put('/api/admin/credentials/email', { values: { SMTP_PORT: 'abc' } })).status).toBe(400);
    expect((await api.put('/api/admin/credentials/square', { values: { NOT_A_FIELD: 'x' } })).status).toBe(400);
    expect((await api.put('/api/admin/credentials/nope', { values: {} })).status).toBe(400);
  });

  it('Test connection reports what is missing instead of pretending', async () => {
    const r = await api.post('/api/admin/credentials/highlevel/test');
    expect(r.body.result.ok).toBe(false);
    expect(r.body.result.message).toMatch(/Missing/);
    expect(r.body.integration.status).toBe('not_configured');
  });

  it('removes saved credentials', async () => {
    const agent = await as('owner@addendumsalon.com');
    // A fresh session hasn't confirmed the password yet: refused until it does.
    const first = await agent.delete('/api/admin/credentials/shopify').set('X-Requested-With', 'addendum-crm');
    expect([first.status, first.body.error.code]).toEqual([403, 'reauth_required']);
    expect((await agent.post('/api/auth/confirm-password').set('X-Requested-With', 'addendum-crm').send({ password: 'addendum-demo' })).status).toBe(200);
    const del = await agent.delete('/api/admin/credentials/shopify').set('X-Requested-With', 'addendum-crm');
    expect(del.status).toBe(200);
    expect(del.body.integration.status).toBe('not_configured');
    expect(config().SHOPIFY_CLIENT_SECRET).toBeUndefined();
  });

  it('only administrators can see or change credentials (enforced on the server)', async () => {
    for (const email of ['frontdesk@addendumsalon.com', 'jennifer@addendumsalon.com']) {
      const agent = await as(email);
      expect((await agent.get('/api/admin/credentials')).status).toBe(403);
      expect((await agent.put('/api/admin/credentials/shopify').set('X-Requested-With', 'addendum-crm').send({ values: { SHOPIFY_ADMIN_TOKEN: 'x' } })).status).toBe(403);
      expect((await agent.post('/api/admin/credentials/square/test').set('X-Requested-With', 'addendum-crm')).status).toBe(403);
    }
    expect((await request(app).get('/api/admin/credentials')).status).toBe(401);
  });
});
