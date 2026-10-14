import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { retryInventoryEmails } from '../src/domain/inventory.js';
import { MockEmailService, type EmailService } from '../src/integrations/email/EmailService.js';
import { syncSquareInventory } from '../src/domain/squareInventory.js';
import { MockShopifyService } from '../src/integrations/shopify/ShopifyService.js';
import { setIntegrationOverride } from '../src/integrations/registry.js';
import { IntegrationError } from '../src/lib/errors.js';
import { setup } from './helpers.js';
import { localDate } from '../src/domain/rebookingSchedule.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: Awaited<ReturnType<typeof setup>>['app'];
beforeAll(async () => {
  ({ api, app } = await setup());
});
afterEach(() => setIntegrationOverride({ email: new MockEmailService(), shopify: new MockShopifyService() }));

const TZ = 'America/Los_Angeles';
/** A date `n` days from today in the salon's time zone (orders can't be needed in the past). */
const D = (n: number) => localDate(new Date(Date.now() + n * 86400_000), TZ);
const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const order = {
  note: 'Install moved up.',
  items: [
    { collection: 'Signature Hand-Tied Weft', size: '20"', color: '#60 Platinum', quantity: 3, neededBy: D(6) },
    { collection: 'Bond Remover', quantity: 1, neededBy: D(2) },
  ],
};
const one = (collection: string, extra: object = {}) => ({ neededBy: D(5), items: [{ collection, quantity: 1, ...extra }] });

describe('Inventory order requests → emailed to Addendum Hair', () => {
  it('saves the request and emails gaby@addendumhair.com with every item', async () => {
    MockEmailService.outbox = [];
    const r = await api.post('/api/inventory/requests', order);
    expect(r.status).toBe(201);
    const req = r.body.request;
    expect(req.email.to).toBe('gaby@addendumhair.com');
    expect(req.email.status).toBe('sent');
    expect(req.totalUnits).toBe(4);
    expect(req.urgency).toBeUndefined();
    expect(req.neededBy).toBe(D(2)); // earliest item date
    expect(req.items[0]).toMatchObject({ size: '20"', color: '#60 Platinum', collection: 'Signature Hand-Tied Weft', quantity: 3, neededBy: D(6) });
    const mail = MockEmailService.outbox.at(-1)!;
    expect(mail.to).toBe('gaby@addendumhair.com');
    expect(mail.subject).toMatch(/^Addendum Hair order request #\d+ — /);
    expect(mail.text).toContain(`Size: 20" | Color: #60 Platinum | Collection: Signature Hand-Tied Weft | QTY: 3 | Needed by: ${fmt(D(6))}`);
    expect(mail.text).toContain(`Size: — | Color: — | Collection: Bond Remover | QTY: 1 | Needed by: ${fmt(D(2))}`);
    expect(mail.text).not.toMatch(/rush|urgency/i);
    expect(mail.html).toMatch(/Size<\/th><th[^>]*>Color<\/th><th[^>]*>Collection<\/th><th[^>]*>QTY<\/th><th[^>]*>Needed By/);
    expect(mail.text).toContain('Install moved up.');
    expect(mail.html).toContain('&quot;'); // values are HTML-escaped
  });

  it('copies info@addendumhair.com on every order email, once, alongside the stylist', async () => {
    MockEmailService.outbox = [];
    const r = (await api.post('/api/inventory/requests', one('Tape-In'))).body.request;
    const mail = MockEmailService.outbox.at(-1)!;
    expect(mail.to).toBe('gaby@addendumhair.com');
    expect(mail.cc).toEqual(['info@addendumhair.com', 'owner@addendumsalon.com']);
    expect(r.email.cc).toEqual(['info@addendumhair.com', 'owner@addendumsalon.com']);
    // Sending again (e.g. "Email again") copies the same people once each, and sends one email.
    const before = MockEmailService.outbox.length;
    await api.post(`/api/inventory/requests/${r.id}/resend`);
    expect(MockEmailService.outbox.length).toBe(before + 1);
    expect(MockEmailService.outbox.at(-1)!.cc).toEqual(['info@addendumhair.com', 'owner@addendumsalon.com']);
    // Stylist copy turned off: Addendum Hair is still copied.
    await api.patch('/api/settings', { inventory: { ccRequester: false } });
    await api.post('/api/inventory/requests', one('Tape-In'));
    expect(MockEmailService.outbox.at(-1)!.cc).toEqual(['info@addendumhair.com']);
    // Orders already going to info@addendumhair.com don't copy it to itself.
    await api.patch('/api/settings', { inventory: { orderEmail: 'Info@AddendumHair.com', ccRequester: true } });
    await api.post('/api/inventory/requests', one('Tape-In'));
    expect(MockEmailService.outbox.at(-1)!.cc).toEqual(['owner@addendumsalon.com']);
    await api.patch('/api/settings', { inventory: { orderEmail: 'gaby@addendumhair.com', ccRequester: true } });
  });

  it('keeps the request when email fails, then retries it', async () => {
    const failing: EmailService = { provider: 'smtp', from: 'x', send: async () => { throw new IntegrationError('email', 'The email could not be sent right now. It will be retried.', true); } };
    setIntegrationOverride({ email: failing });
    const r = await api.post('/api/inventory/requests', one('Clip-In Set'));
    expect(r.status).toBe(201);
    expect(r.body.request.email.status).toBe('failed');
    expect(r.body.request.email.error).toMatch(/retried/);

    setIntegrationOverride({ email: new MockEmailService() });
    // Backoff: not retried immediately…
    expect((await retryInventoryEmails()).retried).toBe(0);
    // …but it is once the wait has passed.
    await retryInventoryEmails(new Date(Date.now() + 5 * 60_000));
    const after = (await api.get(`/api/inventory/requests/${r.body.request.id}`)).body.request;
    expect(after.email.status).toBe('sent');
  });

  it('saves requests even when email is not set up, and sends them once it is', async () => {
    setIntegrationOverride({ email: null });
    const r = await api.post('/api/inventory/requests', { neededBy: D(4), items: [{ collection: 'Weft Thread', quantity: 2 }] });
    expect(r.body.request.email.status).toBe('not_configured');
    setIntegrationOverride({ email: new MockEmailService() });
    await retryInventoryEmails();
    expect((await api.get(`/api/inventory/requests/${r.body.request.id}`)).body.request.email.status).toBe('sent');
  });

  it('uses the email address set in Settings → Inventory', async () => {
    await api.patch('/api/settings', { inventory: { orderEmail: 'orders@addendumhair.com' } });
    const r = await api.post('/api/inventory/requests', one('Tape-In Extensions'));
    expect(r.body.request.email.to).toBe('orders@addendumhair.com');
    await api.patch('/api/settings', { inventory: { orderEmail: 'gaby@addendumhair.com' } });
  });

  it('validates input', async () => {
    expect((await api.post('/api/inventory/requests', { items: [] })).status).toBe(400);
    expect((await api.post('/api/inventory/requests', { neededBy: D(3), items: [{ collection: 'X', quantity: 0 }] })).status).toBe(400);
    expect((await api.post('/api/inventory/requests', { neededBy: D(3), items: [{ collection: '', quantity: 1 }] })).status).toBe(400);
    expect((await api.post('/api/inventory/requests', one('X', { neededBy: 'soon' }))).status).toBe(400);
  });

  it('lets managers move requests to Ordered → Received; staff only see and cancel their own', async () => {
    const r = (await api.post('/api/inventory/requests', order)).body.request;
    expect((await api.patch(`/api/inventory/requests/${r.id}`, { status: 'ordered' })).body.request.status).toBe('ordered');
    expect((await api.patch(`/api/inventory/requests/${r.id}`, { status: 'received' })).body.request.status).toBe('received');

    const staff = request.agent(app);
    const login = await staff.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'michael@addendumsalon.com', password: 'addendum-demo' });
    expect(login.status).toBe(200);
    const mine = (await staff.post('/api/inventory/requests').set('X-Requested-With', 'addendum-crm').send(one('K-Tip Extensions'))).body.request;
    const list = (await staff.get('/api/inventory/requests')).body;
    expect(list.canManage).toBe(false);
    expect(list.requests.every((x: any) => x.forStaffId === mine.forStaffId || x.requestedById === mine.requestedById)).toBe(true);
    expect((await staff.get(`/api/inventory/requests/${r.id}`)).status).toBe(403);
    expect((await staff.patch(`/api/inventory/requests/${mine.id}`).set('X-Requested-With', 'addendum-crm').send({ status: 'ordered' })).status).toBe(403);
    expect((await staff.patch(`/api/inventory/requests/${mine.id}`).set('X-Requested-With', 'addendum-crm').send({ status: 'cancelled' })).status).toBe(200);
  });

  it('lets the needed-by date be added and changed per item', async () => {
    const r = (await api.post('/api/inventory/requests', one('Clip-In Set'))).body.request;
    expect(r.items[0].neededBy).toBe(D(5)); // the order's Needed By date
    const item = r.items[0].id;
    let u = await api.patch(`/api/inventory/requests/${r.id}/items/${item}`, { neededBy: D(20) });
    expect(u.status).toBe(200);
    expect(u.body.request.items[0].neededBy).toBe(D(20));
    expect(u.body.request.neededBy).toBe(D(20));
    u = await api.patch(`/api/inventory/requests/${r.id}/items/${item}`, { neededBy: '' });
    expect(u.body.request.items[0].neededBy).toBeNull();
    expect((await api.patch(`/api/inventory/requests/${r.id}/items/${item}`, { neededBy: '11/02' })).status).toBe(400);
  });

  it('demo data includes example requests', async () => {
    const n = await db().one<any>('SELECT count(*)::int n FROM inventory_requests');
    expect(n.n).toBeGreaterThanOrEqual(3);
  });
});

describe('Team colours are editable; accounts are managed in Users & Permissions', () => {
  it('the old staff endpoint only changes display settings, never roles or passwords', async () => {
    expect([403, 404]).toContain((await api.post('/api/staff', { name: 'New', email: 'new@x.com', role: 'owner', password: 'abcdefghijkl' })).status);
    const someone = (await api.get('/api/staff')).body.staff.find((s: any) => s.role === 'stylist');
    expect((await api.patch(`/api/staff/${someone.id}`, { role: 'admin' })).status).toBe(400);
    expect((await api.patch(`/api/staff/${someone.id}`, { password: 'abcdefghijkl' })).status).toBe(400);
    expect((await api.patch(`/api/staff/${someone.id}`, { color: '#7B86B8' })).status).toBe(200);
    expect((await api.get('/api/staff')).body.staff.find((s: any) => s.id === someone.id).color).toBe('#7B86B8');
  });

  it('saves the accent colour and shares it with the sign-in screen', async () => {
    expect((await api.patch('/api/settings', { appearance: { accent: 'not-a-colour' } })).status).toBe(400);
    await api.patch('/api/settings', { appearance: { accent: '#2F6670' } });
    expect((await api.get('/api/auth/config')).body.accent).toBe('#2F6670');
  });
});

describe('Items typed by hand are emailed without touching Shopify', () => {
  it('has no Shopify switch on orders, and marking Ordered leaves Shopify alone', async () => {
    MockShopifyService.reset();
    const r = (await api.post('/api/inventory/requests', { neededBy: D(3), items: [{ collection: 'Signature Hand-Tied Weft', size: '20"', color: '#60 Platinum', quantity: 2, shopifyDeduct: true }] })).body.request;
    expect(r.items[0].shopify).toBeUndefined();
    expect(r.email.status).toBe('sent');
    const o = await api.patch(`/api/inventory/requests/${r.id}`, { status: 'ordered' });
    expect(o.status).toBe(200);
    expect(o.body.shopify).toBeUndefined();
    expect(MockShopifyService.sets).toHaveLength(0);
    expect((await api.post(`/api/inventory/requests/${r.id}/shopify`)).status).toBe(404);
  });
});

describe('Square inventory: searchable, Square is the source of truth', () => {
  it('loads products and stock from Square and finds them by name, size/colour, SKU or UPC', async () => {
    expect((await syncSquareInventory()).status).toBe('ok');
    const all = (await api.get('/api/inventory/products')).body;
    expect(all.sync.products).toBe(8);
    expect(all.products.find((p: any) => p.sku === 'HTW-20-60')).toMatchObject({ itemName: 'Signature Hand-Tied Weft', variationName: '20" / #60 Platinum', quantity: 12 });
    expect(all.products.find((p: any) => p.itemName === 'Gift Card').quantity).toBeNull(); // not tracked in Square

    const words = (await api.get('/api/inventory/products?q=weft%2060')).body.products.map((p: any) => p.sku);
    expect(words.sort()).toEqual(['HTW-20-60', 'HTW-22-60']);
    expect((await api.get('/api/inventory/products?q=ktip-22-1b')).body.products[0].sku).toBe('KTIP-22-1B');
    const upc = all.products.find((p: any) => p.sku === 'CARE-KIT').upc;
    expect((await api.get(`/api/inventory/products?q=${upc}`)).body.products[0].sku).toBe('CARE-KIT');
    expect((await api.get('/api/inventory/products?q=weft&inStock=true')).body.products.every((p: any) => p.quantity > 0)).toBe(true);
    expect((await api.get('/api/inventory/products?q=100%25')).status).toBe(200); // wildcards are treated as text
    // Curly and straight inch marks match each other.
    expect((await api.get(`/api/inventory/products?q=${encodeURIComponent('20” 60')}`)).body.products.map((p: any) => p.sku)).toEqual(['HTW-20-60']);
  });
});

describe('Shopify inventory push: administrators only, never automatic', () => {
  const ids = async (...skus: string[]) => (await api.get('/api/inventory/products')).body.products.filter((p: any) => skus.includes(p.sku)).map((p: any) => p.variationId);

  it('sets Shopify stock to the Square count, matched by SKU, and explains what it skipped', async () => {
    MockShopifyService.reset();
    await syncSquareInventory();
    const chosen = [...(await ids('HTW-20-60', 'KTIP-22-1B', 'HTW-22-60', 'CARE-KIT', 'BOND-RMV')), ...(await api.get('/api/inventory/products?q=gift')).body.products.map((p: any) => p.variationId)];
    const r = (await api.post('/api/inventory/products/shopify-push', { variationIds: chosen })).body.result;
    expect(r.pushed.map((p: any) => [p.label, p.quantity]).sort()).toEqual([
      ['K-Tip Extensions · 22" / #1B Natural Black', 7], ['Signature Hand-Tied Weft · 20" / #60 Platinum', 12],
    ]);
    expect(MockShopifyService.stock.get('gid://shopify/InventoryItem/1')).toBe(12);
    expect(MockShopifyService.stock.get('gid://shopify/InventoryItem/4')).toBe(7);
    const reasons = Object.fromEntries(r.skipped.map((x: any) => [x.label, x.reason]));
    expect(reasons['Signature Hand-Tied Weft · 22" / #60 Platinum']).toMatch(/No Shopify product has SKU HTW-22-60/);
    expect(reasons['Extension Care Kit']).toMatch(/isn't tracking stock/);
    expect(reasons['Bond Remover']).toMatch(/No Shopify product/);
    expect(reasons['Gift Card']).toMatch(/No SKU/);
    expect(r.failed).toEqual([]);

    // Pushing again sets the same numbers: nothing is double-counted.
    await api.post('/api/inventory/products/shopify-push', { variationIds: chosen });
    expect(MockShopifyService.stock.get('gid://shopify/InventoryItem/1')).toBe(12);
    const row = (await api.get('/api/inventory/products?q=HTW-20-60')).body.products[0];
    expect(row.shopify.pushedQuantity).toBe(12);
    expect(row.shopify.pushedAt).toBeTruthy();
  });

  it('reports failures without losing anything', async () => {
    MockShopifyService.reset();
    MockShopifyService.failNext = new IntegrationError('shopify', 'Shopify had a problem. Try again in a moment.', true);
    const r = (await api.post('/api/inventory/products/shopify-push', { variationIds: await ids('HTW-20-60') })).body.result;
    expect(r.failed).toEqual([expect.objectContaining({ error: 'Shopify had a problem. Try again in a moment.' })]);
    expect((await api.get('/api/inventory/products?q=HTW-20-60')).body.products[0].shopify.error).toMatch(/Shopify had a problem/);

    setIntegrationOverride({ shopify: null });
    const off = await api.post('/api/inventory/products/shopify-push', { variationIds: await ids('HTW-20-60') });
    expect(off.status).toBe(400);
    expect(off.body.error.message).toMatch(/Shopify isn't connected/);
  });

  it('is refused for receptionists and stylists, who also never see push details', async () => {
    for (const email of ['frontdesk@addendumsalon.com', 'jennifer@addendumsalon.com']) {
      const agent = request.agent(app);
      await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email, password: 'addendum-demo' });
      const search = await agent.get('/api/inventory/products?q=weft');
      expect(search.status).toBe(200);
      expect(search.body.canPushToShopify).toBe(false);
      expect(search.body.products.every((p: any) => p.shopify.pushedAt === null)).toBe(true);
      const push = await agent.post('/api/inventory/products/shopify-push').set('X-Requested-With', 'addendum-crm').send({ variationIds: ['demo-v1'] });
      expect(push.status).toBe(403);
    }
    expect((await api.get('/api/inventory/products')).body.canPushToShopify).toBe(true);
  });

  it('is never triggered by the Square sync or by orders', async () => {
    MockShopifyService.reset();
    await syncSquareInventory();
    const r = (await api.post('/api/inventory/requests', one('K-Tip Extensions'))).body.request;
    await api.patch(`/api/inventory/requests/${r.id}`, { status: 'received' });
    expect(MockShopifyService.sets).toHaveLength(0);
  });
});

describe('Order Hair: inventory search for stylists', () => {
  async function stylist() {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'jennifer@addendumsalon.com', password: 'addendum-demo' });
    return {
      get: (url: string) => agent.get(url),
      post: (url: string, body: object) => agent.post(url).set('X-Requested-With', 'addendum-crm').send(body),
      put: (url: string, body: object) => agent.put(url).set('X-Requested-With', 'addendum-crm').send(body),
    };
  }

  it('lists only orderable (stocked) products, searchable by length, colour and SKU', async () => {
    await syncSquareInventory();
    const jen = await stylist();
    const all = (await jen.get('/api/inventory/products?orderable=true&limit=500')).body.products;
    expect(all.length).toBeGreaterThan(3);
    expect(all.every((p: any) => p.trackInventory)).toBe(true);
    expect(all.some((p: any) => p.itemName === 'Gift Card')).toBe(false);
    const hit = (await jen.get('/api/inventory/products?orderable=true&q=22%E2%80%9D%2060')).body.products; // 22” 60 (curly quote)
    expect(hit.map((p: any) => p.sku)).toEqual(['HTW-22-60']);
    expect((await jen.get('/api/inventory/products?orderable=true&q=ktip-22')).body.products.map((p: any) => p.sku)).toEqual(['KTIP-22-1B']);
  });

  it('a stylist can order from search without admin powers, and nothing about Shopify changes', async () => {
    const jen = await stylist();
    expect((await jen.post('/api/inventory/products/shopify-push', { variationIds: ['demo-v1'] })).status).toBe(403);
    expect((await jen.put('/api/inventory-sync/products/shopify-sync', { variationIds: ['demo-v1'], enabled: false })).status).toBe(403);
    expect((await jen.get('/api/inventory-sync/links')).status).toBe(403);
    const snapshot = async () => JSON.stringify([
      await db().query('SELECT * FROM product_shopify_sync ORDER BY square_variation_id'),
      await db().query('SELECT id, square_variation_id, shopify_inventory_item_id, baseline_quantity FROM inventory_sync_links ORDER BY id'),
    ]);
    const before = await snapshot();
    const shopifyWrites = MockShopifyService.sets.length;
    MockEmailService.outbox = [];
    const r = await jen.post('/api/inventory/requests', { neededBy: D(3), items: [{ collection: 'Signature Hand-Tied Weft', size: '22"', color: '#60 Platinum', quantity: 2, note: 'SKU HTW-22-60' }] });
    expect(r.status).toBe(201);
    const mail = MockEmailService.outbox.at(-1)!;
    expect(mail.text).toContain('Size: 22" | Color: #60 Platinum | Collection: Signature Hand-Tied Weft | QTY: 2');
    expect(mail.text).toContain('Note: SKU HTW-22-60');
    expect(mail.cc).toContain('info@addendumhair.com');
    expect(await snapshot()).toBe(before);
    expect(MockShopifyService.sets.length).toBe(shopifyWrites);
  });
});
