import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/index.js';
import { startInventorySync } from '../src/domain/inventorySync.js';
import { forgetStockCache } from '../src/domain/stock.js';
import { setIntegrationOverride } from '../src/integrations/registry.js';
import { MockShopifyService, MockShopifyStore2 } from '../src/integrations/shopify/ShopifyService.js';
import { demoSquareStock, MockSquareService, resetDemoSquareStock } from '../src/integrations/square/MockSquareService.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
const SQ = { weft60: 'demo-v1', ktip: 'demo-v4' };
const SH = { weft60: 'gid://shopify/InventoryItem/1', ktip: 'gid://shopify/InventoryItem/4' };
// The second store lists HTW-20-60 twice (stylist and salon prices).
const PRO = { weftA: 'gid://shopify/InventoryItem/201', weftB: 'gid://shopify/InventoryItem/202', ktip: 'gid://shopify/InventoryItem/204', only: 'gid://shopify/InventoryItem/299' };
const sync = () => startInventorySync({ trigger: 'manual', wait: true });

beforeAll(async () => {
  ({ api } = await setup());
});
afterAll(() => setIntegrationOverride({ shopify2: null }));

beforeEach(async () => {
  for (const t of ['inventory_sync_links', 'inventory_sync_runs', 'inventory_sync_extra', 'stock_txns', 'stock_products', 'shopify_order_lines']) await db().query(`DELETE FROM ${t}`);
  await db().query("DELETE FROM settings WHERE key LIKE 'stock.shopify-sales%'");
  resetDemoSquareStock();
  MockShopifyService.reset();
  MockShopifyStore2.reset();
  setIntegrationOverride({ square: new MockSquareService(), shopify: new MockShopifyService(), shopify2: new MockShopifyStore2() });
  forgetStockCache();
  await api.patch('/api/settings', { inventorySync: { enabled: false, firstSyncSource: 'square', holdChangesOver: 25 } });
});

describe('A second Shopify store with the same stock and SKUs', () => {
  it('the first sync sets every listing of a SKU there (duplicates too) to the shared count; the store’s own SKUs are left alone', async () => {
    const run = await sync();
    expect(run.status).toBe('ok');
    expect(MockShopifyStore2.stock.get(PRO.weftA)).toBe(12);
    expect(MockShopifyStore2.stock.get(PRO.weftB)).toBe(12);
    expect(MockShopifyStore2.stock.get(PRO.ktip)).toBe(7);
    expect(MockShopifyStore2.stock.get(PRO.only)).toBe(50); // no matching product: untouched
    // A second sync has nothing to do.
    const again = await sync();
    expect(again.message).not.toMatch(/updated in/);
  });

  it('turns on stock tracking for draft listings with a synced SKU and sets their count; live listings are left alone', async () => {
    MockShopifyStore2.status.set(PRO.ktip, 'DRAFT');
    MockShopifyStore2.tracked.set(PRO.ktip, false);
    MockShopifyStore2.tracked.set(PRO.weftB, false); // an active listing without tracking: not ours to change
    MockShopifyStore2.status.set(PRO.only, 'DRAFT');
    MockShopifyStore2.tracked.set(PRO.only, false); // a draft with no matching product: untouched
    const run = await sync();
    expect(run.message).toMatch(/stock tracking turned on for 1 draft listing/);
    expect(MockShopifyStore2.tracked.get(PRO.ktip)).toBe(true);
    expect(MockShopifyStore2.stock.get(PRO.ktip)).toBe(7);
    expect(MockShopifyStore2.tracked.get(PRO.weftB)).toBe(false);
    expect(MockShopifyStore2.stock.get(PRO.weftB)).toBe(50);
    expect(MockShopifyStore2.tracked.get(PRO.only)).toBe(false);
    // Next time it's an ordinary tracked listing: nothing to do.
    const again = await sync();
    expect(again.message).not.toMatch(/tracking turned on|updated in/);
  });

  it('Shopify-only products (not in Square) sync between both Shopify stores, combining each store’s sales', async () => {
    const main = { sku: 'PRO-ONLY-1', inventoryItemId: 'gid://shopify/InventoryItem/77', label: 'Pro starter kit', tracked: true };
    MockShopifyService.catalog.push(main);
    try {
      MockShopifyService.stock.set(main.inventoryItemId, 8);
      const first = await sync();
      expect(first.message).toMatch(/1 online product synced between Shopify and/);
      expect(MockShopifyStore2.stock.get(PRO.only)).toBe(8); // the main store's count is kept the first time
      MockShopifyService.stock.set(main.inventoryItemId, 7); // sold one in the main store
      MockShopifyStore2.stock.set(PRO.only, 6); // and two in the second store
      await sync();
      expect(MockShopifyService.stock.get(main.inventoryItemId)).toBe(5);
      expect(MockShopifyStore2.stock.get(PRO.only)).toBe(5);
      expect((await sync()).message).not.toMatch(/online product/); // settled: nothing to do
      // A count set in the Products tab reaches both stores and isn't counted again by the next sync.
      forgetStockCache();
      const r = await api.post('/api/inventory-sync/stock/apply', { kind: 'count', reason: 'Stock count', changes: [{ key: `shopify:${main.inventoryItemId}`, quantity: 20 }] });
      expect(r.status).toBe(200);
      expect(MockShopifyStore2.stock.get(PRO.only)).toBe(20);
      await sync();
      expect(MockShopifyService.stock.get(main.inventoryItemId)).toBe(20);
      expect(MockShopifyStore2.stock.get(PRO.only)).toBe(20);
    } finally {
      MockShopifyService.catalog.splice(MockShopifyService.catalog.indexOf(main), 1);
    }
  });

  it('separate stock: salon and online counts are set on their own, and the online count is shared by both Shopify stores', async () => {
    await sync();
    await api.put('/api/inventory-sync/products/kind', { variationIds: [SQ.ktip], kind: 'separate' });
    forgetStockCache();
    const r = await api.post('/api/inventory-sync/stock/apply', { kind: 'count', reason: 'Stock count', changes: [{ key: SQ.ktip, quantity: 3, onlineQuantity: 30 }] });
    expect(r.status).toBe(200);
    expect(demoSquareStock.get(SQ.ktip)).toBe(3);
    expect(MockShopifyService.stock.get(SH.ktip)).toBe(30);
    expect(MockShopifyStore2.stock.get(PRO.ktip)).toBe(30);
    // A sale online in the second store comes off the main store's online count; the salon stays as it is.
    MockShopifyStore2.stock.set(PRO.ktip, 28);
    await sync();
    expect(MockShopifyService.stock.get(SH.ktip)).toBe(28);
    expect(demoSquareStock.get(SQ.ktip)).toBe(3);
    // A shared product can't be given a separate online count.
    forgetStockCache();
    const bad = await api.post('/api/inventory-sync/stock/apply', { kind: 'count', changes: [{ key: SQ.weft60, onlineQuantity: 5 }] });
    expect(bad.status).toBe(400);
  });

  it('a sale in the second store comes off everywhere, including its other listing of the same SKU', async () => {
    await sync();
    MockShopifyStore2.stock.set(PRO.weftA, 11); // sold one at the stylist price
    await sync();
    expect(demoSquareStock.get(SQ.weft60)).toBe(11);
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(11);
    expect(MockShopifyStore2.stock.get(PRO.weftB)).toBe(11);
    expect(MockShopifyStore2.stock.get(PRO.weftA)).toBe(11);
  });

  it('sales in all three at once add up (nothing lost or counted twice)', async () => {
    await sync();
    demoSquareStock.set(SQ.weft60, 11); // −1 in the salon
    MockShopifyService.stock.set(SH.weft60, 10); // −2 online
    MockShopifyStore2.stock.set(PRO.weftB, 9); // −3 at the salon price in the second store
    await sync();
    for (const v of [demoSquareStock.get(SQ.weft60), MockShopifyService.stock.get(SH.weft60), MockShopifyStore2.stock.get(PRO.weftA), MockShopifyStore2.stock.get(PRO.weftB)]) expect(v).toBe(6);
    const h = (await api.get(`/api/inventory-sync/stock/history?key=${SQ.weft60}&kind=sync`)).body.entries;
    expect(h[0].reason).toMatch(/more than one store/);
  });

  it('counts and SKU changes from the CRM reach every listing in the second store', async () => {
    await sync();
    forgetStockCache();
    const p = (await api.get('/api/inventory-sync/stock/products')).body;
    expect(p.store2).toBeTruthy();
    expect(p.products.find((x: any) => x.key === SQ.weft60).store2).toHaveLength(2);
    expect((await api.post('/api/inventory-sync/stock/apply', { kind: 'count', changes: [{ key: SQ.weft60, quantity: 30 }] })).body.changed).toBe(1);
    expect(MockShopifyStore2.stock.get(PRO.weftA)).toBe(30);
    expect(MockShopifyStore2.stock.get(PRO.weftB)).toBe(30);
    // The next sync sees nothing to do (its baseline followed).
    await sync();
    expect(demoSquareStock.get(SQ.weft60)).toBe(30);
    expect((await api.post('/api/inventory-sync/stock/apply', { kind: 'sku', changes: [{ key: SQ.weft60, sku: 'RW-60-20' }] })).body.results[0].ok).toBe(true);
    expect(MockShopifyStore2.skus.get(PRO.weftA)).toBe('RW-60-20');
    expect(MockShopifyStore2.skus.get(PRO.weftB)).toBe('RW-60-20');
    expect(MockShopifyService.skus.get(SH.weft60)).toBe('RW-60-20');
  });

  it('Analytics: the second store’s sales on their own, or with the others', async () => {
    await sync();
    forgetStockCache();
    await api.post('/api/inventory-sync/stock/sales/refresh');
    const pro = (await api.get('/api/analytics/products?period=30&store=shopify2')).body;
    expect(pro.store2Name).toBeTruthy();
    expect(pro.totals.units).toBeGreaterThan(0);
    expect(pro.top[0]).toMatchObject({ key: SQ.weft60 });
    const all = (await api.get('/api/analytics/products?period=30')).body;
    expect(all.totals.units).toBe(all.totals.square.units + all.totals.shopify.units + all.totals.shopify2.units);
  });
});

describe('Listings sharing a SKU in the main Shopify store (e.g. a PRO listing)', () => {
  const PROLIST = { sku: 'PRO-WEFT', inventoryItemId: 'gid://shopify/InventoryItem/77', label: 'Signature Hand-Tied Weft PRO – 20" / #60 Platinum', tracked: true };
  const withProListing = async (fn: () => Promise<void>) => {
    MockShopifyService.catalog.push(PROLIST);
    MockShopifyService.stock.set(PROLIST.inventoryItemId, 50);
    try { await fn(); } finally { MockShopifyService.catalog.splice(MockShopifyService.catalog.indexOf(PROLIST), 1); MockShopifyService.skus.delete(PROLIST.inventoryItemId); }
  };

  it('can be given the same SKU, then follow the product’s stock — and a sale on either one comes off the shared count', async () => {
    await withProListing(async () => {
      await sync();
      forgetStockCache();
      // Giving the PRO listing the regular listing's SKU is allowed (Shopify only; Square SKUs stay unique).
      const pro = (await api.get('/api/inventory-sync/stock/products')).body.products.find((p: any) => p.shopifyInventoryItemId === PROLIST.inventoryItemId);
      const r = await api.post('/api/inventory-sync/stock/apply', { kind: 'adjust', changes: [{ key: pro.key, sku: 'HTW-20-60' }] });
      expect(r.body.results[0]).toMatchObject({ ok: true });
      await sync();
      expect(MockShopifyService.stock.get(PROLIST.inventoryItemId)).toBe(12); // follows the product
      forgetStockCache();
      const list = (await api.get('/api/inventory-sync/stock/products')).body.products;
      expect(list.some((p: any) => p.shopifyInventoryItemId === PROLIST.inventoryItemId)).toBe(false); // not listed on its own
      expect(list.find((p: any) => p.key === SQ.weft60).siblings).toEqual([expect.objectContaining({ inventoryItemId: PROLIST.inventoryItemId, qty: 12 })]);
      // Two sold on the PRO listing: everything goes to 10.
      MockShopifyService.stock.set(PROLIST.inventoryItemId, 10);
      await sync();
      expect(demoSquareStock.get(SQ.weft60)).toBe(10);
      expect(MockShopifyService.stock.get(SH.weft60)).toBe(10);
      expect(MockShopifyStore2.stock.get(PRO.weftA)).toBe(10);
    });
  });

  it('a Square SKU is still unique', async () => {
    await sync();
    forgetStockCache();
    const r = await api.post('/api/inventory-sync/stock/apply', { kind: 'adjust', changes: [{ key: SQ.ktip, sku: 'HTW-20-60' }] });
    expect(r.body.results[0]).toMatchObject({ ok: false, note: expect.stringMatching(/already used .* in Square/) });
  });

  it('pre-orders count the shared shortfall once, not once per store', async () => {
    const { preorderReport } = await import('../src/domain/stock.js');
    await sync();
    MockShopifyService.stock.set(SH.weft60, -5);
    MockShopifyStore2.stock.set(PRO.weftA, -5);
    MockShopifyStore2.stock.set(PRO.weftB, -5);
    forgetStockCache();
    const item = (await preorderReport()).items.find((i) => i.key === SQ.weft60)!;
    expect(item).toMatchObject({ waiting: 5, toOrder: 5 });
  });
});

describe('Pro prices in the retail store', () => {
  it('only Pro listings (by name or tag) take the professional store’s price for the same SKU; nothing else changes', async () => {
    const { demoPrices, demoTags } = await import('../src/integrations/shopify/ShopifyService.js');
    const PROW = { sku: 'HTW-20-60', inventoryItemId: 'gid://shopify/InventoryItem/290', label: 'Signature Hand-Tied Weft PRO – 20" / #60', tracked: true };
    const TAGGED = { sku: 'KTIP-22-1B', inventoryItemId: 'gid://shopify/InventoryItem/291', label: 'K-Tip Extensions (stylists) – 22" / #1B', tracked: true };
    MockShopifyStore2.catalog.push(PROW, TAGGED);
    demoTags.set(TAGGED.inventoryItemId, ['Pro-Pricing']);
    // A retail listing tagged by mistake (its SKU has a listing named Pro): left alone.
    demoTags.set(PRO.weftA, ['professional']);
    demoPrices.set(SH.weft60, { priceCents: 15000, costCents: null }); // professional store's price
    demoPrices.set(SH.ktip, { priceCents: 9900, costCents: null });
    try {
      const before = (await api.get('/api/inventory-sync/stock/prices')).body.rows;
      const retailBefore = before.flatMap((r: any) => r.shopify2).filter((l: any) => ![PROW.inventoryItemId, TAGGED.inventoryItemId].includes(l.inventoryItemId));
      const plan = (await api.get('/api/inventory-sync/stock/prices/pro')).body;
      expect(plan.changes.map((c: any) => [c.sku, c.toCents])).toEqual(expect.arrayContaining([['HTW-20-60', 15000], ['KTIP-22-1B', 9900]]));
      expect(plan.changes).toHaveLength(2);
      expect(plan.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ sku: 'HTW-20-60', reason: expect.stringMatching(/retail listing/) })]));
      const r = (await api.post('/api/inventory-sync/stock/prices/pro')).body;
      expect(r).toMatchObject({ saved: 2, failed: [] });
      const after = (await api.get('/api/inventory-sync/stock/prices')).body.rows.flatMap((x: any) => x.shopify2);
      expect(after.find((l: any) => l.inventoryItemId === PROW.inventoryItemId).priceCents).toBe(15000);
      expect(after.find((l: any) => l.inventoryItemId === TAGGED.inventoryItemId).priceCents).toBe(9900);
      // Every other listing keeps its price.
      for (const l of retailBefore) expect(after.find((x: any) => x.inventoryItemId === l.inventoryItemId).priceCents).toBe(l.priceCents);
      expect((await api.get('/api/inventory-sync/stock/prices/pro')).body).toMatchObject({ changes: [], alreadyMatching: 2 });
    } finally {
      MockShopifyStore2.catalog.splice(MockShopifyStore2.catalog.indexOf(PROW), 2);
      for (const id of [PROW.inventoryItemId, TAGGED.inventoryItemId, SH.weft60, SH.ktip, PRO.weftA]) { demoPrices.delete(id); demoTags.delete(id); }
    }
  });
});
