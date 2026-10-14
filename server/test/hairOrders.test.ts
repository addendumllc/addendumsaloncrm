import crypto from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { retryInventoryEmails } from '../src/domain/inventory.js';
import { localDate } from '../src/domain/rebookingSchedule.js';
import { MockEmailService, type EmailService } from '../src/integrations/email/EmailService.js';
import { setIntegrationOverride } from '../src/integrations/registry.js';
import { MockShopifyService } from '../src/integrations/shopify/ShopifyService.js';
import { IntegrationError } from '../src/lib/errors.js';
import { setup } from './helpers.js';

let app: Awaited<ReturnType<typeof setup>>['app'];
let api: Awaited<ReturnType<typeof setup>>['api'];
const D = (n: number) => localDate(new Date(Date.now() + n * 86400_000), 'America/Los_Angeles');
const ITEM = { weft: 'gid://shopify/InventoryItem/1', ktip: 'gid://shopify/InventoryItem/4' };
const stock = (id: string) => MockShopifyService.stock.get(id);
const sid = () => crypto.randomUUID();
const orders = async () => (await db().one<any>('SELECT count(*)::int n FROM inventory_requests')).n;
const place = (body: object) => api.post('/api/inventory/requests', { submissionId: sid(), neededBy: D(5), ...body });

beforeAll(async () => {
  ({ app, api } = await setup());
});
beforeEach(() => {
  MockShopifyService.reset(); // 50 of each tracked variant
  MockEmailService.outbox = [];
  setIntegrationOverride({ email: new MockEmailService(), shopify: new MockShopifyService() });
});
afterEach(() => { MockShopifyService.failNext = null; });

describe('Order Hair: Shopify inventory for the form', () => {
  it('lists tracked Shopify variants with SKU, length, colour and stock', async () => {
    const r = (await api.get('/api/inventory/shopify-products?fresh=true')).body;
    expect(r.connected).toBe(true);
    const weft = r.products.find((p: any) => p.sku === 'HTW-20-60');
    expect(weft).toMatchObject({ product: 'Signature Hand-Tied Weft', size: '20"', color: '#60 Platinum', available: 50 });
    expect(r.products.some((p: any) => p.sku === 'CARE-KIT')).toBe(false); // Shopify doesn't track its stock
    // Stylists can see it (to order), without other inventory powers.
    const jen = request.agent(app);
    await jen.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'jennifer@addendumsalon.com', password: 'addendum-demo' });
    expect((await jen.get('/api/inventory/shopify-products')).status).toBe(200);
  });
});

describe('Placing an order', () => {
  it('records it, takes the chosen items out of Shopify, then emails both addresses with every detail', async () => {
    const r = await place({
      note: 'Please send the platinum first.',
      items: [{ sku: 'HTW-20-60', quantity: 3 }, { sku: 'ktip-22-1b', quantity: 2 }, { collection: 'Weft Thread', color: 'Blonde', quantity: 1 }],
    });
    expect(r.status).toBe(201);
    const o = r.body.request;
    expect(o.inventoryStatus).toBe('reserved');
    expect(o.items.map((i: any) => i.sku)).toEqual(['HTW-20-60', 'KTIP-22-1B', null]);
    expect(o.items[0]).toMatchObject({ collection: 'Signature Hand-Tied Weft', size: '20"', color: '#60 Platinum', quantity: 3, neededBy: D(5) });
    expect([stock(ITEM.weft), stock(ITEM.ktip)]).toEqual([47, 48]); // typed items don't touch stock
    const mail = MockEmailService.outbox.at(-1)!;
    expect(mail.to).toBe('gaby@addendumhair.com');
    expect(mail.cc).toContain('info@addendumhair.com');
    for (const part of [`Order reference: #${o.number}`, 'Needed by:', 'Stylist: ', 'owner@addendumsalon.com', 'SKU: HTW-20-60', 'QTY: 3', 'SKU: KTIP-22-1B', 'Collection: Weft Thread', 'Please send the platinum first.']) {
      expect(mail.text).toContain(part);
    }
  });

  it('a second submit of the same form returns the same order: one order, one deduction, one email', async () => {
    const submissionId = sid();
    const body = { submissionId, neededBy: D(4), items: [{ sku: 'HTW-20-60', quantity: 2 }] };
    const first = await api.post('/api/inventory/requests', body);
    const again = await api.post('/api/inventory/requests', body);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.request.id).toBe(first.body.request.id);
    expect(stock(ITEM.weft)).toBe(48);
    expect(MockEmailService.outbox.length).toBe(1);
  });

  it('refuses unavailable stock, unknown SKUs and invalid dates — recording, deducting and emailing nothing', async () => {
    const before = await orders();
    const over = await place({ items: [{ sku: 'HTW-20-60', quantity: 51 }] });
    expect([over.status, over.body.error.code]).toEqual([409, 'inventory_unavailable']);
    expect(over.body.error.message).toMatch(/only 50 in stock/);
    // The same SKU on two lines counts together.
    expect((await place({ items: [{ sku: 'HTW-20-60', quantity: 30 }, { sku: 'HTW-20-60', quantity: 30 }] })).status).toBe(409);
    expect((await place({ items: [{ sku: 'NOT-A-SKU', quantity: 1 }] })).status).toBe(409);
    expect((await api.post('/api/inventory/requests', { submissionId: sid(), items: [{ sku: 'HTW-20-60', quantity: 1 }] })).status).toBe(400); // no date
    expect((await place({ neededBy: D(-1), items: [{ sku: 'HTW-20-60', quantity: 1 }] })).status).toBe(400); // past
    expect((await place({ neededBy: '2026-02-30', items: [{ sku: 'HTW-20-60', quantity: 1 }] })).status).toBe(400);
    expect((await place({ neededBy: D(400), items: [{ sku: 'HTW-20-60', quantity: 1 }] })).status).toBe(400);
    expect(await orders()).toBe(before);
    expect(stock(ITEM.weft)).toBe(50);
    expect(MockEmailService.outbox.length).toBe(0);
  });

  it('handles a sale landing mid-order: re-checks, and refuses if there’s no longer enough', async () => {
    MockShopifyService.onBeforeSet = () => MockShopifyService.stock.set(ITEM.weft, 49); // a Shopify sale
    expect((await place({ items: [{ sku: 'HTW-20-60', quantity: 3 }] })).status).toBe(201);
    expect(stock(ITEM.weft)).toBe(46); // nothing oversold or overwritten

    const before = await orders();
    MockShopifyService.onBeforeSet = () => MockShopifyService.stock.set(ITEM.weft, 1);
    const r = await place({ items: [{ sku: 'HTW-20-60', quantity: 3 }] });
    expect([r.status, r.body.error.code]).toEqual([409, 'inventory_unavailable']);
    expect(await orders()).toBe(before);
    expect(stock(ITEM.weft)).toBe(1);
  });

  it('if Shopify doesn’t confirm, nothing is shown as done; submitting again finishes it exactly once', async () => {
    const submissionId = sid();
    const body = { submissionId, neededBy: D(3), items: [{ sku: 'KTIP-22-1B', quantity: 4 }] };
    MockShopifyService.failNext = new IntegrationError('shopify', 'Shopify timed out.', true);
    const r = await api.post('/api/inventory/requests', body);
    expect([r.status, r.body.error.code]).toEqual([502, 'inventory_unconfirmed']);
    expect(MockEmailService.outbox.length).toBe(0);
    MockShopifyService.failNext = null;
    const again = await api.post('/api/inventory/requests', body);
    expect(again.status).toBe(200);
    expect(again.body.request.inventoryStatus).toBe('reserved');
    expect(stock(ITEM.ktip)).toBe(46);
    expect((await api.post('/api/inventory/requests', body)).status).toBe(200);
    expect(stock(ITEM.ktip)).toBe(46);
  });

  it('an email failure keeps the order and the stock change; the retry only sends the email', async () => {
    const failing: EmailService = { provider: 'smtp', from: 'x', send: async () => { throw new IntegrationError('email', 'The email could not be sent right now. It will be retried.', true); } };
    setIntegrationOverride({ email: failing, shopify: new MockShopifyService() });
    const r = await place({ items: [{ sku: 'HTW-20-60', quantity: 2 }] });
    expect(r.status).toBe(201);
    expect(r.body.request).toMatchObject({ inventoryStatus: 'reserved', email: { status: 'failed' } });
    expect(stock(ITEM.weft)).toBe(48);
    setIntegrationOverride({ email: new MockEmailService(), shopify: new MockShopifyService() });
    await db().query("UPDATE inventory_requests SET email_last_attempt_at = now() - interval '1 hour' WHERE id = $1", [r.body.request.id]);
    await retryInventoryEmails();
    expect((await api.get(`/api/inventory/requests/${r.body.request.id}`)).body.request.email.status).toBe('sent');
    expect(stock(ITEM.weft)).toBe(48);
    expect(MockShopifyService.sets.length).toBe(1);
  });
});
