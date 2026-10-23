import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { forgetStockCache } from '../src/domain/stock.js';
import { setIntegrationOverride } from '../src/integrations/registry.js';
import { MockShopifyService } from '../src/integrations/shopify/ShopifyService.js';
import { demoSquareStock, MockSquareService, resetDemoSquareStock } from '../src/integrations/square/MockSquareService.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: Awaited<ReturnType<typeof setup>>['app'];

beforeAll(async () => {
  ({ api, app } = await setup());
});
beforeEach(async () => {
  for (const t of ['suppliers', 'stock_products', 'inventory_sync_links', 'purchase_orders']) await db().query(`DELETE FROM ${t}`);
  resetDemoSquareStock();
  MockShopifyService.reset();
  setIntegrationOverride({ square: new MockSquareService(), shopify: new MockShopifyService(), shopify2: null });
  forgetStockCache();
});

describe('Suppliers', () => {
  it('can be added with contact details, then given products by store or one by one', async () => {
    expect((await api.post('/api/inventory-sync/stock/suppliers', { name: 'Hair Co', email: 'orders@hairco.test', phone: '555-0100', leadTimeDays: 10 })).status).toBe(201);
    expect((await api.post('/api/inventory-sync/stock/suppliers', { name: 'hair co' })).status).toBe(400); // already added
    let list = (await api.get('/api/inventory-sync/stock/suppliers')).body.suppliers;
    expect(list).toEqual([expect.objectContaining({ name: 'Hair Co', email: 'orders@hairco.test', products: 0, leadTimeDays: 10 })]);

    // Every Square (salon) product.
    const byStore = await api.put('/api/inventory-sync/stock/suppliers/assign', { supplier: 'Hair Co', store: 'square', onlyWithout: true });
    expect(byStore.status).toBe(200);
    expect(byStore.body.products).toBeGreaterThan(0);
    forgetStockCache();
    const products = (await api.get('/api/inventory-sync/stock/products')).body.products;
    const square = products.filter((p: any) => p.squareVariationId);
    expect(square.every((p: any) => p.supplier === 'Hair Co' && p.leadTimeDays === 10)).toBe(true);
    expect(products.filter((p: any) => !p.squareVariationId).every((p: any) => p.supplier == null)).toBe(true);

    // Chosen products, for another supplier; "only without a supplier" leaves those alone afterwards.
    await api.post('/api/inventory-sync/stock/suppliers', { name: 'Tools Inc' });
    expect((await api.put('/api/inventory-sync/stock/suppliers/assign', { supplier: 'Tools Inc', keys: [square[0].key] })).body.products).toBe(1);
    expect((await api.put('/api/inventory-sync/stock/suppliers/assign', { supplier: 'Tools Inc', store: 'square', onlyWithout: true })).body.products).toBe(0);
    list = (await api.get('/api/inventory-sync/stock/suppliers')).body.suppliers;
    expect(list.find((s: any) => s.name === 'Tools Inc').products).toBe(1);

    // Renamed everywhere; removed leaves products without a supplier.
    expect((await api.put('/api/inventory-sync/stock/suppliers/details', { previous: 'Tools Inc', name: 'Tools Ltd', phone: '555-0199' })).status).toBe(200);
    list = (await api.get('/api/inventory-sync/stock/suppliers')).body.suppliers;
    expect(list.find((s: any) => s.name === 'Tools Ltd')).toMatchObject({ products: 1, phone: '555-0199' });
    await api.post('/api/inventory-sync/stock/suppliers/remove', { name: 'Tools Ltd' });
    expect((await db().one<any>('SELECT supplier FROM stock_products WHERE product_key = $1', [square[0].key])).supplier).toBeNull();
  });

  it('purchase orders: each item keeps its own lead time and arrival date; the default supplier fills in', async () => {
    const products = (await api.get('/api/inventory-sync/stock/products')).body.products.filter((p: any) => p.squareVariationId).slice(0, 2);
    await api.post('/api/inventory-sync/stock/suppliers', { name: 'Hair Co', leadTimeDays: 10 });
    expect((await api.put('/api/inventory-sync/stock/suppliers/default', { name: 'Hair Co' })).status).toBe(200);
    expect((await api.get('/api/inventory-sync/stock/suppliers')).body.suppliers[0]).toMatchObject({ name: 'Hair Co', isDefault: true });
    // No supplier named anywhere: the default is used.
    const r = await api.post('/api/inventory-sync/stock/purchase-orders', { lines: [
      { productKey: products[0].key, quantity: 5, leadTimeDays: 7 },
      { productKey: products[1].key, quantity: 2, leadTimeDays: 21 },
    ] });
    expect(r.status).toBe(201);
    const po = r.body.orders[0];
    expect(po.supplier).toBe('Hair Co');
    expect(po.lines.map((l: any) => [l.leadTimeDays, l.expectedOn])).toEqual(expect.arrayContaining([[7, null], [21, null]]));
    // Placed: each item gets its own date; the order's date is the last of them.
    const placed = (await api.patch(`/api/inventory-sync/stock/purchase-orders/${po.id}`, { status: 'ordered' })).body.order;
    const plus = (d: number) => { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };
    const byLead = Object.fromEntries(placed.lines.map((l: any) => [l.leadTimeDays, l.expectedOn]));
    // Counted from the salon's date (its time zone), so compare the items with each other.
    expect(Math.round((Date.parse(byLead[21]) - Date.parse(byLead[7])) / 86400_000)).toBe(14);
    expect(placed.expectedOn).toBe(byLead[21]);
    // One item delayed: the order's date follows.
    const late = placed.lines.find((l: any) => l.leadTimeDays === 21);
    const moved = (await api.patch(`/api/inventory-sync/stock/purchase-orders/${po.id}/lines/${late.id}`, { expectedOn: plus(30) })).body.order;
    expect(moved.expectedOn).toBe(plus(30));
  });

  it('the company name and contacts are only for people who may see supplier details; others see the shown name', async () => {
    await api.post('/api/inventory-sync/stock/suppliers', { name: 'Addendum Hair', companyName: 'Hair Imports LLC', email: 'buy@imports.test' });
    expect((await api.get('/api/inventory-sync/stock/suppliers')).body.suppliers[0]).toMatchObject({ name: 'Addendum Hair', companyName: 'Hair Imports LLC', email: 'buy@imports.test' });
    // Someone with inventory access but not supplier details.
    const deskId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
    await api.put(`/api/admin/users/${deskId}/access`, { overrides: { 'inventory:sync': true } });
    try {
      const agent = request.agent(app);
      const h = (r: any) => r.set('X-Requested-With', 'addendum-crm');
      await h(agent.post('/api/auth/login')).send({ email: 'frontdesk@addendumsalon.com', password: 'addendum-demo' });
      const seen = (await h(agent.get('/api/inventory-sync/stock/suppliers'))).body;
      expect(seen.canSeeDetails).toBe(false);
      expect(seen.suppliers[0]).toMatchObject({ name: 'Addendum Hair', companyName: null, email: null });
      expect(JSON.stringify(seen)).not.toContain('Hair Imports');
      // Their edits change the lead time but never the hidden details.
      expect((await h(agent.put('/api/inventory-sync/stock/suppliers/details')).send({ previous: 'Addendum Hair', name: 'Addendum Hair', leadTimeDays: 12, companyName: null, email: null })).status).toBe(200);
      expect((await api.get('/api/inventory-sync/stock/suppliers')).body.suppliers[0]).toMatchObject({ companyName: 'Hair Imports LLC', email: 'buy@imports.test', leadTimeDays: 12 });
    } finally {
      await api.put(`/api/admin/users/${deskId}/access`, { overrides: { 'inventory:sync': null } });
    }
  });

  it('purchase orders can be edited while open, and lot numbers and notes any time', async () => {
    const products = (await api.get('/api/inventory-sync/stock/products')).body.products.filter((p: any) => p.squareVariationId).slice(0, 3);
    const po = (await api.post('/api/inventory-sync/stock/purchase-orders', { lines: [{ productKey: products[0].key, quantity: 4 }, { productKey: products[1].key, quantity: 2 }] })).body.orders[0];
    await api.patch(`/api/inventory-sync/stock/purchase-orders/${po.id}`, { status: 'ordered' });
    const [a, b] = po.lines;
    // Placed orders can still change: quantity and cost, add and remove items.
    let o = (await api.patch(`/api/inventory-sync/stock/purchase-orders/${po.id}/lines/${a.id}`, { quantity: 6, costCents: 1250, lotNote: 'Lot 24-118' })).body.order;
    expect(o.lines.find((l: any) => l.id === a.id)).toMatchObject({ quantity: 6, costCents: 1250, lotNote: 'Lot 24-118' });
    o = (await api.post(`/api/inventory-sync/stock/purchase-orders/${po.id}/lines`, { lines: [{ productKey: products[2].key, quantity: 1 }] })).body.order;
    expect(o.lines).toHaveLength(3);
    o = (await api.del(`/api/inventory-sync/stock/purchase-orders/${po.id}/lines/${b.id}`)).body.order;
    expect(o.lines).toHaveLength(2);
    // Partly received: can't go below what arrived, can't be removed.
    await api.post(`/api/inventory-sync/stock/purchase-orders/${po.id}/receive`, { lines: [{ lineId: a.id, quantity: 3 }] });
    expect((await api.patch(`/api/inventory-sync/stock/purchase-orders/${po.id}/lines/${a.id}`, { quantity: 2 })).status).toBe(400);
    expect((await api.del(`/api/inventory-sync/stock/purchase-orders/${po.id}/lines/${a.id}`)).status).toBe(400);
    // Fully received (closed): only lot numbers and notes still change.
    const rest = (await api.get('/api/inventory-sync/stock/purchase-orders')).body.orders.find((x: any) => x.id === po.id);
    await api.post(`/api/inventory-sync/stock/purchase-orders/${po.id}/receive`, { lines: rest.lines.map((l: any) => ({ lineId: l.id, quantity: l.quantity - l.received })) });
    expect((await api.patch(`/api/inventory-sync/stock/purchase-orders/${po.id}/lines/${a.id}`, { quantity: 9 })).status).toBe(400);
    expect((await api.patch(`/api/inventory-sync/stock/purchase-orders/${po.id}/lines/${a.id}`, { lotNote: 'Lot 24-119, exp 03/27' })).body.order.lines.find((l: any) => l.id === a.id).lotNote).toBe('Lot 24-119, exp 03/27');
    expect((await api.patch(`/api/inventory-sync/stock/purchase-orders/${po.id}`, { note: 'Invoice #5521' })).body.order.note).toBe('Invoice #5521');
    // Renamed any time, even once received.
    expect((await api.patch(`/api/inventory-sync/stock/purchase-orders/${po.id}`, { name: 'October restock' })).body.order.name).toBe('October restock');
  });

  it('purchase orders are for the salon or online: receiving adds stock to that store only', async () => {
    forgetStockCache();
    const products = (await api.get('/api/inventory-sync/stock/products')).body.products;
    const sq = products.find((p: any) => p.squareVariationId && p.squareQty != null);
    const sh = products.find((p: any) => !p.squareVariationId && p.shopifyInventoryItemId && p.shopifyQty != null);
    const sqBefore = demoSquareStock.get(sq.squareVariationId) ?? 0;
    const shBefore = MockShopifyService.stock.get(sh.shopifyInventoryItemId) ?? 0;
    // Salon order: Square only.
    const salon = (await api.post('/api/inventory-sync/stock/purchase-orders', { store: 'salon', lines: [{ productKey: sq.key, quantity: 3 }] })).body.orders[0];
    expect(salon.store).toBe('salon');
    await api.patch(`/api/inventory-sync/stock/purchase-orders/${salon.id}`, { status: 'ordered' });
    await api.post(`/api/inventory-sync/stock/purchase-orders/${salon.id}/receive`, { lines: [{ lineId: salon.lines[0].id, quantity: 3 }] });
    expect(demoSquareStock.get(sq.squareVariationId)).toBe(sqBefore + 3);
    // Online order: Shopify only.
    const online = (await api.post('/api/inventory-sync/stock/purchase-orders', { store: 'shopify', lines: [{ productKey: sh.key, quantity: 2 }] })).body.orders[0];
    expect(online.store).toBe('shopify');
    await api.patch(`/api/inventory-sync/stock/purchase-orders/${online.id}`, { status: 'ordered' });
    await api.post(`/api/inventory-sync/stock/purchase-orders/${online.id}/receive`, { lines: [{ lineId: online.lines[0].id, quantity: 2 }] });
    expect(MockShopifyService.stock.get(sh.shopifyInventoryItemId)).toBe(shBefore + 2);
    expect(demoSquareStock.get(sq.squareVariationId)).toBe(sqBefore + 3);
    // No store given (e.g. from Reorder): split by where each product is sold.
    const both = (await api.post('/api/inventory-sync/stock/purchase-orders', { lines: [{ productKey: sq.key, quantity: 1 }, { productKey: sh.key, quantity: 1 }] })).body.orders;
    expect(both.map((o: any) => o.store).sort()).toEqual(['salon', 'shopify']);
  });

  it('lead time not tracked: reorder timing leaves it out and its orders get no lead time', async () => {
    await api.post('/api/inventory-sync/stock/suppliers', { name: 'Beauty Supply', leadTimeDays: 20, leadUntracked: true });
    expect((await api.get('/api/inventory-sync/stock/suppliers')).body.suppliers[0]).toMatchObject({ name: 'Beauty Supply', leadUntracked: true });
    const key = (await api.get('/api/inventory-sync/stock/products')).body.products.find((p: any) => p.squareVariationId).key;
    await api.put('/api/inventory-sync/stock/products/settings', { rows: [{ key, supplier: 'Beauty Supply', leadTimeDays: 45 }] });
    forgetStockCache();
    const item = (await api.get('/api/inventory-sync/stock/forecast')).body.items.find((i: any) => i.key === key);
    expect(item.leadTimeDays).toBe(0);
    const po = (await api.post('/api/inventory-sync/stock/purchase-orders', { lines: [{ productKey: key, quantity: 2 }] })).body.orders[0];
    expect(po.lines[0].leadTimeDays).toBeNull();
    // Tracked again: the product's own lead time is back.
    await api.put('/api/inventory-sync/stock/suppliers/details', { previous: 'Beauty Supply', name: 'Beauty Supply', leadTimeDays: 20, leadUntracked: false });
    forgetStockCache();
    expect((await api.get('/api/inventory-sync/stock/forecast')).body.items.find((i: any) => i.key === key).leadTimeDays).toBe(45);
  });

  it('Analytics → Forecast groups what to order by urgency and leaves out suppliers whose lead time isn’t tracked', async () => {
    await api.post('/api/inventory-sync/stock/sales/refresh');
    forgetStockCache();
    const before = (await api.get('/api/analytics/forecast')).body.items;
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((i: any) => ['order_now', 'soon', 'watch', 'healthy'].includes(i.status))).toBe(true);
    const key = before[0].key;
    await api.post('/api/inventory-sync/stock/suppliers', { name: 'As Needed Co', leadUntracked: true });
    await api.put('/api/inventory-sync/stock/products/settings', { rows: [{ key, supplier: 'As Needed Co' }] });
    forgetStockCache();
    const after = (await api.get('/api/analytics/forecast')).body.items;
    expect(after.some((i: any) => i.key === key)).toBe(false);
    expect(after.length).toBe(before.length - 1);
  });

  it('shipping days add to the lead time, the default MOQ fills in, and amounts round to practical numbers then full cases', async () => {
    const { practicalQty } = await import('../src/domain/stock.js');
    expect([2, 7, 23, 101, 512].map(practicalQty)).toEqual([2, 10, 25, 110, 550]);
    await api.post('/api/inventory-sync/stock/suppliers', { name: 'Ship Co', leadTimeDays: 10, shippingDays: 5, defaultMoq: 40 });
    expect((await api.get('/api/inventory-sync/stock/suppliers')).body.suppliers[0]).toMatchObject({ shippingDays: 5, defaultMoq: 40 });
    const key = (await api.get('/api/inventory-sync/stock/products')).body.products.find((p: any) => p.squareVariationId).key;
    await api.put('/api/inventory-sync/stock/products/settings', { rows: [{ key, supplier: 'Ship Co', leadTimeDays: null, caseSize: 12 }] });
    forgetStockCache();
    const i = (await api.post('/api/inventory-sync/stock/sales/refresh')).body.items.find((x: any) => x.key === key);
    expect(i).toMatchObject({ leadTimeDays: 15, shippingDays: 5, moq: 40 });
    if (i.suggestedQty) { expect(i.suggestedQty).toBeGreaterThanOrEqual(40); expect(i.suggestedQty % 12).toBe(0); }
    // Windows are adjustable; Watch can't be shorter than Reorder soon.
    const base = (await api.get('/api/inventory-sync/stock/forecast')).body.settings;
    expect((await api.put('/api/inventory-sync/stock/forecast/settings', { ...base, soonDays: 20, watchDays: 10 })).status).toBe(400);
    expect((await api.put('/api/inventory-sync/stock/forecast/settings', { ...base, soonDays: 10, watchDays: 30 })).body.settings).toMatchObject({ soonDays: 10, watchDays: 30 });
  });

  it('alerts once when a selling product runs out or is at risk of running out', async () => {
    const { notifyStockAlerts } = await import('../src/domain/stock.js');
    const { setKV } = await import('../src/repos/settings.js');
    await setKV('stock.alerts.seen', null as any);
    const sent: string[] = [];
    const send = async (_ids: string[], title: string) => { sent.push(title); };
    await api.post('/api/inventory-sync/stock/sales/refresh');
    expect(await notifyStockAlerts(send, async () => ['x'])).toBe(0); // first run remembers
    // A long lead time puts every selling product at risk.
    await api.post('/api/inventory-sync/stock/suppliers', { name: 'Slow Co', leadTimeDays: 700 });
    const products = (await api.get('/api/inventory-sync/stock/products')).body.products;
    await api.put('/api/inventory-sync/stock/products/settings', { rows: products.map((p: any) => ({ key: p.key, supplier: 'Slow Co', leadTimeDays: 700 })) });
    forgetStockCache();
    const n = await notifyStockAlerts(send, async () => ['x']);
    expect(n).toBeGreaterThan(0);
    expect(sent[0]).toMatch(/at risk of running out|out of stock/);
    forgetStockCache();
    expect(await notifyStockAlerts(send, async () => ['x'])).toBe(0); // not again
  });
});

