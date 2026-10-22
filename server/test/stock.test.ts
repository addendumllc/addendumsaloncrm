import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/index.js';
import { startInventorySync } from '../src/domain/inventorySync.js';
import { forgetStockCache } from '../src/domain/stock.js';
import { setIntegrationOverride } from '../src/integrations/registry.js';
import { MockShopifyService } from '../src/integrations/shopify/ShopifyService.js';
import { demoSquareStock, MockSquareService, resetDemoSquareStock } from '../src/integrations/square/MockSquareService.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
const SQ = { weft60: 'demo-v1', ktip: 'demo-v4' };
const SH = { weft60: 'gid://shopify/InventoryItem/1', ktip: 'gid://shopify/InventoryItem/4' };

beforeAll(async () => {
  ({ api } = await setup());
});

beforeEach(async () => {
  for (const t of ['inventory_sync_links', 'inventory_sync_runs', 'stock_txns', 'stock_products', 'purchase_orders', 'shopify_order_lines']) await db().query(`DELETE FROM ${t}`);
  await db().query("DELETE FROM settings WHERE key = 'stock.shopify-sales'");
  resetDemoSquareStock();
  MockShopifyService.reset();
  setIntegrationOverride({ square: new MockSquareService(), shopify: new MockShopifyService() });
  forgetStockCache();
  await startInventorySync({ trigger: 'manual', wait: true }); // pairs products, Shopify takes Square's counts
  forgetStockCache();
});

const product = async (key: string) => (await api.get('/api/inventory-sync/stock/products')).body.products.find((p: any) => p.key === key);

describe('Inventory tools (Stockline features)', () => {
  it('lists every product with its stock in Square and Shopify', async () => {
    const p = await product(SQ.weft60);
    expect(p).toMatchObject({ squareQty: 12, shopifyQty: 12, shopifyInventoryItemId: SH.weft60, status: 'active' });
    expect(p.linkId).toBeTruthy();
  });

  it('a stock count sets both stores, keeps the sync in step and is logged', async () => {
    const r = await api.post('/api/inventory-sync/stock/apply', { kind: 'count', reason: 'Stock count', changes: [{ key: SQ.weft60, quantity: 20 }, { key: SQ.ktip, quantity: 3 }] });
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(2);
    expect(demoSquareStock.get(SQ.weft60)).toBe(20);
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(20);
    expect(MockShopifyService.stock.get(SH.ktip)).toBe(3);
    // The next sync has nothing to do.
    const run = await startInventorySync({ trigger: 'manual', wait: true });
    expect(run.updatedShopify + run.updatedSquare).toBe(0);
    const h = (await api.get(`/api/inventory-sync/stock/history?key=${SQ.weft60}`)).body.entries;
    expect(h[0]).toMatchObject({ kind: 'count', reason: 'Stock count', squareBefore: 12, squareAfter: 20, shopifyBefore: 12, shopifyAfter: 20 });
    expect(h[0].staffName).toBeTruthy();
  });

  it('adds or removes units, never below 0', async () => {
    expect((await api.post('/api/inventory-sync/stock/apply', { kind: 'adjust', reason: 'Damaged', changes: [{ key: SQ.weft60, delta: -2 }] })).body.changed).toBe(1);
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(10);
    expect(demoSquareStock.get(SQ.weft60)).toBe(10);
    expect((await api.post('/api/inventory-sync/stock/apply', { kind: 'adjust', changes: [{ key: SQ.weft60, delta: -50 }] })).status).toBe(400);
  });

  it('changes a SKU in both stores, and refuses one another product uses', async () => {
    const r = await api.post('/api/inventory-sync/stock/apply', { kind: 'sku', changes: [{ key: SQ.weft60, sku: 'RW-60-20' }] });
    expect(r.status).toBe(200);
    expect(MockShopifyService.skus.get(SH.weft60)).toBe('RW-60-20');
    forgetStockCache();
    expect((await product(SQ.weft60)).squareSku).toBe('RW-60-20');
    const k = await product(SQ.ktip);
    const dup = await api.post('/api/inventory-sync/stock/apply', { kind: 'sku', changes: [{ key: SQ.ktip, sku: 'rw-60-20' }] });
    expect(dup.body.results[0]).toMatchObject({ ok: false });
    expect(dup.body.results[0].note).toMatch(/already used/);
    expect(k.sku).not.toBe('RW-60-20');
  });

  it('a stale Shopify count stops the batch (a sale is never overwritten)', async () => {
    MockShopifyService.onBeforeSet = () => MockShopifyService.stock.set(SH.weft60, 11);
    const r = await api.post('/api/inventory-sync/stock/apply', { kind: 'count', changes: [{ key: SQ.weft60, quantity: 30 }] });
    expect(r.body.changed).toBe(0);
    expect(r.body.results[0].note).toMatch(/changed just now/);
    expect(demoSquareStock.get(SQ.weft60)).toBe(12);
  });

  it('forecasts from sales, suggests orders, and purchase orders add stock when received', async () => {
    await api.put('/api/inventory-sync/stock/products/settings', { rows: [{ key: SQ.weft60, supplier: 'Hair Co', costCents: 4000, leadTimeDays: 45, moq: 10, caseSize: 5 }] });
    const f = (await api.post('/api/inventory-sync/stock/sales/refresh')).body;
    const w = f.items.find((i: any) => i.key === SQ.weft60);
    expect(w.ratePerDay).toBeGreaterThan(0);
    expect(w.leadTimeDays).toBe(45);
    expect(['out', 'order_now', 'soon', 'watch', 'healthy']).toContain(w.status);
    if (w.suggestedQty) expect(w.suggestedQty % 5).toBe(0);
    // A purchase order: draft → ordered → received (part, then the rest).
    const po = (await api.post('/api/inventory-sync/stock/purchase-orders', { lines: [{ productKey: SQ.weft60, quantity: 10 }] })).body.orders[0];
    expect(po).toMatchObject({ supplier: 'Hair Co', status: 'draft', totalCents: 40000 });
    expect((await api.post(`/api/inventory-sync/stock/purchase-orders/${po.id}/receive`, { lines: [{ lineId: po.lines[0].id, quantity: 4 }] })).status).toBe(400); // still a draft
    await api.patch(`/api/inventory-sync/stock/purchase-orders/${po.id}`, { status: 'ordered', expectedOn: '2026-11-30' });
    forgetStockCache();
    expect((await api.get('/api/inventory-sync/stock/forecast')).body.items.find((i: any) => i.key === SQ.weft60).incoming).toBe(10);
    const r1 = await api.post(`/api/inventory-sync/stock/purchase-orders/${po.id}/receive`, { lines: [{ lineId: po.lines[0].id, quantity: 4 }] });
    expect(r1.body.order.status).toBe('ordered');
    // A salon order adds to Square; the shared stock reaches Shopify with the next sync (counted once).
    expect(demoSquareStock.get(SQ.weft60)).toBe(16);
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(12);
    await startInventorySync({ trigger: 'manual', wait: true });
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(16);
    expect(demoSquareStock.get(SQ.weft60)).toBe(16);
    forgetStockCache();
    const r2 = await api.post(`/api/inventory-sync/stock/purchase-orders/${po.id}/receive`, { lines: [{ lineId: po.lines[0].id, quantity: 6 }] });
    expect(r2.body.order.status).toBe('received');
    expect(demoSquareStock.get(SQ.weft60)).toBe(22);
    const h = (await api.get(`/api/inventory-sync/stock/history?kind=receive`)).body.entries;
    expect(h.map((x: any) => x.reference)).toEqual([`PO #${po.number}`, `PO #${po.number}`]);
  });

  it('a purchase order made under the salon by mistake moves to online, with its received units', async () => {
    const po = (await api.post('/api/inventory-sync/stock/purchase-orders', { lines: [{ productKey: SQ.weft60, quantity: 4 }], store: 'salon' })).body.orders[0];
    await api.patch(`/api/inventory-sync/stock/purchase-orders/${po.id}`, { status: 'ordered' });
    forgetStockCache();
    const sq0 = demoSquareStock.get(SQ.weft60)!;
    const sh0 = MockShopifyService.stock.get(SH.weft60)!;
    await api.post(`/api/inventory-sync/stock/purchase-orders/${po.id}/receive`, { lines: [{ lineId: po.lines[0].id, quantity: 4 }] });
    expect(demoSquareStock.get(SQ.weft60)).toBe(sq0 + 4);
    forgetStockCache();
    const r = await api.post(`/api/inventory-sync/stock/purchase-orders/${po.id}/move`, { store: 'shopify', moveStock: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ movedUnits: 4, notMoved: [], order: { store: 'shopify', status: 'received' } });
    expect(demoSquareStock.get(SQ.weft60)).toBe(sq0);
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(sh0 + 4);
    expect((await api.post(`/api/inventory-sync/stock/purchase-orders/${po.id}/move`, { store: 'shopify' })).status).toBe(400);
    // Back again, order only: stock stays.
    forgetStockCache();
    expect((await api.post(`/api/inventory-sync/stock/purchase-orders/${po.id}/move`, { store: 'salon', moveStock: false })).body.movedUnits).toBe(0);
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(sh0 + 4);
  });

  it('below zero in Shopify is pre-orders: shown as customers waiting and added to what to order', async () => {
    MockShopifyService.stock.set(SH.weft60, -3);
    demoSquareStock.set(SQ.weft60, 0);
    forgetStockCache();
    const f = (await api.get('/api/inventory-sync/stock/forecast')).body.items.find((i: any) => i.key === SQ.weft60);
    expect(f.preorders).toBe(3);
    expect(f.status).toBe('out');
    expect(f.suggestedQty).toBeGreaterThanOrEqual(3);
    expect(f.why.join(' ')).toMatch(/3 pre-orders/);
  });

  it('the sync’s own changes show in the stock history', async () => {
    MockShopifyService.stock.set(SH.ktip, 5);
    await startInventorySync({ trigger: 'manual', wait: true });
    const h = (await api.get(`/api/inventory-sync/stock/history?key=${SQ.ktip}&kind=sync`)).body.entries;
    expect(h[0]).toMatchObject({ squareBefore: 7, squareAfter: 5, shopifyBefore: 5, shopifyAfter: 5 });
  });

  it('Analytics → Product sales: sales under an old SKU or listing are combined with the product of the same name', async () => {
    const day = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    MockShopifyService.extraOrderLines = [
      // A listing that's since been replaced (new SKU): same name, written a little differently.
      { orderId: 'old-1', lineId: '1', inventoryItemId: 'gid://shopify/InventoryItem/999', sku: 'HTW2060-OLD', quantity: 4, unitPriceCents: 1000, orderedAt: `${day}T18:00:00Z`, cancelled: false, title: 'Signature Hand Tied Weft - 20 inch / #60 Platinum' },
      // A different colour stays its own product.
      { orderId: 'old-2', lineId: '1', inventoryItemId: 'gid://shopify/InventoryItem/998', sku: 'HTW2018-OLD', quantity: 2, unitPriceCents: 1000, orderedAt: `${day}T18:00:00Z`, cancelled: false, title: 'Signature Hand Tied Weft - 20 inch / #18 Honey' },
    ];
    await api.post('/api/inventory-sync/stock/sales/refresh');
    const a = (await api.get('/api/analytics/products?period=30&store=shopify')).body;
    const weft = a.top.find((t: any) => t.key === SQ.weft60);
    expect(weft.alsoSkus).toEqual(['HTW2060-OLD']);
    expect(a.top.some((t: any) => t.sku === 'HTW2060-OLD')).toBe(false);
    const honey = a.top.find((t: any) => t.sku === 'HTW2018-OLD');
    expect(honey).toMatchObject({ label: 'Signature Hand Tied Weft - 20 inch / #18 Honey', units: 2, alsoSkus: [] });
    expect(a.monthly.rows.filter((m: any) => m.sku === 'HTW2060-OLD')).toEqual([]);
  });

  it('Analytics → Product sales: units and sales by store, top sellers, monthly usage, stock value', async () => {
    await api.put('/api/inventory-sync/stock/products/settings', { rows: [{ key: SQ.weft60, costCents: 4000 }] });
    await api.post('/api/inventory-sync/stock/sales/refresh');
    const r = await api.get('/api/analytics/products?period=30');
    expect(r.status).toBe(200);
    const a = r.body;
    expect(a.totals.shopify.units).toBeGreaterThan(0);
    expect(a.totals.shopify.salesCents).toBeGreaterThan(0);
    expect(a.totals.units).toBe(a.totals.square.units + a.totals.shopify.units);
    expect(a.bucket).toBe('day');
    expect(a.trend.length).toBe(30);
    expect(a.trend.reduce((x: number, t: any) => x + t.square + t.shopify, 0)).toBe(a.totals.units);
    expect(a.top[0].units).toBeGreaterThanOrEqual(a.top[a.top.length - 1].units);
    expect(a.monthly.months).toHaveLength(13);
    expect(a.monthly.rows.find((m: any) => m.key === SQ.weft60)).toBeTruthy();
    expect(a.stock.atCostCents).toBeGreaterThanOrEqual(12 * 4000);
    expect((await api.get('/api/analytics/products?period=year')).body.bucket).toMatch(/week|month|day/);
    // Filtered to one store: only that store's sales.
    const sh = (await api.get('/api/analytics/products?period=30&store=shopify')).body;
    expect(sh.store).toBe('shopify');
    expect(sh.totals.units).toBe(a.totals.shopify.units);
    expect(sh.top.every((t: any) => t.squareUnits === 0)).toBe(true);
    const sq = (await api.get('/api/analytics/products?period=30&store=square')).body;
    expect(sq.totals.units).toBe(a.totals.square.units);
  });

  it('one SKU problem doesn’t stop the rest, and a SKU can be set back to an earlier one', async () => {
    const r = await api.post('/api/inventory-sync/stock/apply', { kind: 'sku', changes: [{ key: SQ.weft60, sku: 'KTIP-22-1B' }, { key: SQ.ktip, sku: 'KT-1B-22' }] });
    expect(r.status).toBe(200);
    expect(r.body.results.find((x: any) => x.key === SQ.weft60)).toMatchObject({ ok: false });
    expect(MockShopifyService.skus.get(SH.ktip)).toBe('KT-1B-22');
    forgetStockCache();
    await api.post('/api/inventory-sync/stock/apply', { kind: 'sku', changes: [{ key: SQ.ktip, sku: 'KTIP-22-1B' }] });
    forgetStockCache();
    expect((await product(SQ.ktip)).squareSku).toBe('KTIP-22-1B');
  });

  it('giving a Square-only product the SKU of a Shopify-only product pairs them', async () => {
    // Unpair K-Tip so each store has it on its own, with different SKUs.
    await db().query('DELETE FROM inventory_sync_links WHERE square_variation_id = $1', [SQ.ktip]);
    MockShopifyService.skus.set(SH.ktip, 'KT-ONLINE');
    forgetStockCache();
    const list = (await api.get('/api/inventory-sync/stock/products')).body.products;
    expect(list.find((p: any) => p.key === `shopify:${SH.ktip}`)).toBeTruthy();
    const r = await api.post('/api/inventory-sync/stock/apply', { kind: 'sku', changes: [{ key: SQ.ktip, sku: 'KT-ONLINE' }] });
    expect(r.body.results[0]).toMatchObject({ ok: true });
    expect(r.body.results[0].note).toMatch(/paired/);
    expect(await db().one('SELECT 1 FROM inventory_sync_links WHERE square_variation_id = $1 AND shopify_inventory_item_id = $2', [SQ.ktip, SH.ktip])).toBeTruthy();
  });

  it('suppliers: lead time quoted vs actual, and one click to use the actual one', async () => {
    await api.put('/api/inventory-sync/stock/products/settings', { rows: [{ key: SQ.weft60, supplier: 'Hair Co', leadTimeDays: 20, moq: 50, costCents: 1000 }] });
    const po = (await api.post('/api/inventory-sync/stock/purchase-orders', { lines: [{ productKey: SQ.weft60, quantity: 5 }] })).body.orders[0];
    await api.patch(`/api/inventory-sync/stock/purchase-orders/${po.id}`, { status: 'ordered' });
    await db().query("UPDATE purchase_orders SET ordered_at = now() - interval '33 days' WHERE id = $1", [po.id]);
    await api.post(`/api/inventory-sync/stock/purchase-orders/${po.id}/receive`, { lines: [{ lineId: po.lines[0].id, quantity: 5 }] });
    const s = (await api.get('/api/inventory-sync/stock/suppliers')).body.suppliers.find((x: any) => x.name === 'Hair Co');
    expect(s).toMatchObject({ products: 1, statedLeadDays: 20, actualLeadDays: 33, receivedOrders: 1, spentCents: 5000 });
    expect((await api.put('/api/inventory-sync/stock/suppliers/lead-time', { name: 'Hair Co', days: 33 })).body.products).toBe(1);
    forgetStockCache();
    const f = (await api.get('/api/inventory-sync/stock/forecast')).body.items.find((i: any) => i.key === SQ.weft60);
    expect(f.leadTimeDays).toBe(33);
    expect(f.moqCostCents).toBe(50000);
    expect(f.moqArrivesOn).toBeTruthy();
  });
});

describe('Pre-orders report and alert', () => {
  it('lists what customers are waiting for, what is backordered, and alerts once per new pre-order', async () => {
    const { notifyNewPreorders, preorderReport } = await import('../src/domain/stock.js');
    MockShopifyService.stock.set(SH.weft60, 0);
    forgetStockCache();
    const sent: string[] = [];
    const notify = async (_ids: string[], title: string) => { sent.push(title); };
    await notifyNewPreorders(notify, async () => ['x']); // remembers
    MockShopifyService.stock.set(SH.weft60, -4);
    forgetStockCache();
    const r = await preorderReport();
    const it1 = r.items.find((i) => i.key === SQ.weft60)!;
    expect(it1).toMatchObject({ waiting: 4, status: 'needs_order', toOrder: 4 });
    await notifyNewPreorders(notify, async () => ['x']);
    await notifyNewPreorders(notify, async () => ['x']); // no new pre-orders: no second alert
    expect(sent).toEqual([expect.stringMatching(/New pre-order/)]);
    // A purchase order covering them: backordered.
    const po = (await api.post('/api/inventory-sync/stock/purchase-orders', { lines: [{ productKey: SQ.weft60, quantity: 4 }] })).body.orders[0];
    await api.patch(`/api/inventory-sync/stock/purchase-orders/${po.id}`, { status: 'ordered', expectedOn: '2026-11-30' });
    const r2 = (await api.get('/api/inventory-sync/stock/preorders')).body;
    expect(r2.items.find((i: any) => i.key === SQ.weft60)).toMatchObject({ status: 'backordered', onOrder: 4, toOrder: 0 });
  });
});

describe('To order: who is waiting, and pricing', () => {
  it('each pre-order shows the order number and the customer waiting for it', async () => {
    const { preorderReport } = await import('../src/domain/stock.js');
    await db().query("DELETE FROM settings WHERE key = 'stock.order-who'");
    MockShopifyService.stock.set(SH.weft60, -3);
    await db().query(`INSERT INTO shopify_order_lines(store, order_id, line_id, inventory_item_id, sku, quantity, ordered_at) VALUES ('shopify', 'gid://shopify/Order/5551', 'l1', $1, 'HTW-20-60', 3, now())`, [SH.weft60]);
    forgetStockCache();
    const item = (await preorderReport()).items.find((i) => i.key === SQ.weft60)!;
    expect(item.orders[0]).toMatchObject({ orderId: '5551', quantity: 3, orderName: expect.stringMatching(/^#\d+/), customer: expect.any(String) });
  });

  it('lists unit cost and each store’s price, and saves changes to Square, Shopify and the CRM', async () => {
    const list = (await api.get('/api/inventory-sync/stock/prices')).body;
    const row = list.rows.find((r: any) => r.key === SQ.weft60);
    expect(row.square).toMatchObject({ variationId: SQ.weft60, priceCents: expect.any(Number) });
    expect(row.shopify[0]).toMatchObject({ inventoryItemId: SH.weft60, priceCents: expect.any(Number) });
    const r = await api.put('/api/inventory-sync/stock/prices', { changes: [{
      key: SQ.weft60, costCents: 6500, square: 21000,
      shopify: [{ variantId: row.shopify[0].variantId, productId: row.shopify[0].productId, priceCents: 18000 }],
    }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ failed: [] });
    const after = (await api.get('/api/inventory-sync/stock/prices')).body.rows.find((x: any) => x.key === SQ.weft60);
    expect(after).toMatchObject({ costCents: 6500, square: { priceCents: 21000 } });
    expect(after.shopify[0].priceCents).toBe(18000);
    expect((await api.put('/api/inventory-sync/stock/prices', { changes: [{ key: SQ.weft60, square: -5 }] })).status).toBe(400);
  });
});
