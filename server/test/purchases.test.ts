import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { syncCommission } from '../src/domain/commission.js';
import { setIntegrationOverride } from '../src/integrations/registry.js';
import { MockShopifyService, MockShopifyStore2 } from '../src/integrations/shopify/ShopifyService.js';
import { MockSquareService } from '../src/integrations/square/MockSquareService.js';
import { setup } from './helpers.js';

let app: Awaited<ReturnType<typeof setup>>['app'];
let api: Awaited<ReturnType<typeof setup>>['api'];
async function as(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email, password: 'addendum-demo' });
  return { get: (u: string) => agent.get(u) };
}

beforeAll(async () => {
  ({ app, api } = await setup());
  MockShopifyService.reset();
  MockShopifyStore2.reset();
  setIntegrationOverride({ square: new MockSquareService(), shopify: new MockShopifyService(), shopify2: new MockShopifyStore2() });
  await api.put('/api/commission/settings', { enabled: true });
  await syncCommission({ trigger: 'manual' } as any).catch(() => undefined);
  await api.post('/api/inventory-sync/stock/sales/refresh');
});

describe('Purchases & Transactions', () => {
  it('lists every store’s orders with their store, and the totals match the records', async () => {
    const r = (await api.get('/api/purchases?store=all&limit=5000')).body;
    expect(r.orders.length).toBeGreaterThan(0);
    const stores = new Set(r.orders.map((o: any) => o.store));
    expect([...stores].every((s) => ['square', 'shopify', 'shopify2'].includes(s as string))).toBe(true);
    const live = r.orders.filter((o: any) => o.status !== 'Cancelled');
    expect(r.summary.orders).toBe(live.length);
    expect(r.summary.units).toBe(live.reduce((a: number, o: any) => a + o.lines.reduce((b: number, l: any) => b + l.quantity, 0), 0));
    expect(r.summary.valueCents).toBe(live.reduce((a: number, o: any) => a + o.totalCents, 0));
    // One store only: nothing from the others.
    const hair = (await api.get('/api/purchases?store=hair&limit=5000')).body;
    expect(hair.orders.every((o: any) => o.store !== 'square')).toBe(true);
    // Newest first, and paging.
    const page = (await api.get('/api/purchases?store=all&limit=2')).body;
    expect(page.orders).toHaveLength(Math.min(2, r.total));
    expect(page.orders[0].at >= (page.orders[1]?.at ?? '')).toBe(true);
  });

  it('filtering by an item counts only that item’s lines, not whole orders', async () => {
    const items = (await api.get('/api/purchases/items?store=hair')).body.items;
    expect(items.length).toBeGreaterThan(0);
    const key = items[0].key;
    const r = (await api.get(`/api/purchases?store=hair&limit=5000&items=${encodeURIComponent(key)}`)).body;
    expect(r.itemMode).toBe(true);
    expect(r.orders.every((o: any) => o.lines.every((l: any) => l.key === key))).toBe(true);
    const live = r.orders.filter((o: any) => o.status !== 'Cancelled');
    expect(r.summary.units).toBe(live.reduce((a: number, o: any) => a + o.lines.reduce((b: number, l: any) => b + l.quantity, 0), 0));
    expect(r.summary.valueCents).toBe(live.reduce((a: number, o: any) => a + o.lines.reduce((b: number, l: any) => b + l.totalCents, 0), 0));
  });

  it('someone without access to a store can’t see its purchases', async () => {
    const jen = await as('jennifer@addendumsalon.com');
    expect([403]).toContain((await jen.get('/api/purchases?store=salon')).status);
  });
});
