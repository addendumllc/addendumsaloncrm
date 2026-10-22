import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { startInventorySync } from '../src/domain/inventorySync.js';
import { forgetStockCache } from '../src/domain/stock.js';
import { syncSquareInventory } from '../src/domain/squareInventory.js';
import { setIntegrationOverride } from '../src/integrations/registry.js';
import { MockShopifyService } from '../src/integrations/shopify/ShopifyService.js';
import { demoSquareStock, MockSquareService, resetDemoSquareStock } from '../src/integrations/square/MockSquareService.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: Awaited<ReturnType<typeof setup>>['app'];
const SQ = { weft60: 'demo-v1', tape: 'demo-v5', care: 'demo-v6', bond: 'demo-v7' };
const SH = { weft60: 'gid://shopify/InventoryItem/1', tape: 'gid://shopify/InventoryItem/5' };
const sync = () => startInventorySync({ trigger: 'manual', wait: true });
const setKind = (ids: string[], kind: string) => api.put('/api/inventory-sync/products/kind', { variationIds: ids, kind });

beforeAll(async () => {
  ({ api, app } = await setup());
});

beforeEach(async () => {
  for (const t of ['inventory_sync_links', 'inventory_sync_runs', 'inventory_sync_separate', 'product_shopify_sync', 'product_kind', 'stock_txns', 'stock_products']) await db().query(`DELETE FROM ${t}`);
  resetDemoSquareStock();
  MockShopifyService.reset();
  setIntegrationOverride({ square: new MockSquareService(), shopify: new MockShopifyService() });
  forgetStockCache();
  await syncSquareInventory();
  await api.patch('/api/settings', { inventorySync: { enabled: false, firstSyncSource: 'square', holdChangesOver: 25 } });
});

describe('Product types', () => {
  it('paired products start as shared stock; unpaired ones have no type yet', async () => {
    await sync();
    const list = (await api.get('/api/inventory/products?kind=all')).body.products;
    expect(list.find((p: any) => p.variationId === SQ.weft60).kind).toBe('shared');
    expect(list.find((p: any) => p.variationId === SQ.bond).kind).toBeNull();
  });

  it('separate stock is never synced, and a count from the CRM goes to the salon (Square) only', async () => {
    await sync();
    expect((await setKind([SQ.tape], 'separate')).status).toBe(200);
    demoSquareStock.set(SQ.tape, 3); // salon floor sold some
    MockShopifyService.stock.set(SH.tape, 20); // online warehouse restocked
    await sync();
    expect(demoSquareStock.get(SQ.tape)).toBe(3);
    expect(MockShopifyService.stock.get(SH.tape)).toBe(20);
    const r = await api.post('/api/inventory-sync/stock/apply', { kind: 'count', reason: 'Stock count', changes: [{ key: SQ.tape, quantity: 5 }] });
    expect(r.status).toBe(200);
    expect(demoSquareStock.get(SQ.tape)).toBe(5);
    expect(MockShopifyService.stock.get(SH.tape)).toBe(20);
    const row = (await api.get('/api/inventory-sync/stock/products')).body.products.find((p: any) => p.key === SQ.tape);
    expect(row.kind).toBe('separate');
  });

  it('add-on services leave the product lists and “Not matched”; switching back to shared syncs again', async () => {
    await sync();
    await setKind([SQ.bond], 'service');
    const products = (await api.get('/api/inventory/products')).body.products.map((p: any) => p.variationId);
    expect(products).not.toContain(SQ.bond);
    expect((await api.get('/api/inventory/products?kind=service')).body.products.map((p: any) => p.variationId)).toEqual([SQ.bond]);
    forgetStockCache();
    expect((await api.get('/api/inventory-sync/stock/products')).body.products.map((p: any) => p.key)).not.toContain(SQ.bond);
    expect((await api.get('/api/inventory-sync')).body.unmatched.squareOnly.map((p: any) => p.id)).not.toContain(SQ.bond);

    await setKind([SQ.weft60], 'salon_only');
    demoSquareStock.set(SQ.weft60, 2);
    await sync();
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(12); // not synced while salon only
    await setKind([SQ.weft60], 'shared');
    await sync();
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(2);
  });

  it('turning “Sync to Shopify” off on a shared product makes it separate stock', async () => {
    await sync();
    await api.put('/api/inventory-sync/products/shopify-sync', { variationIds: [SQ.weft60], enabled: false });
    expect((await api.get('/api/inventory/products?kind=separate')).body.products.map((p: any) => p.variationId)).toEqual([SQ.weft60]);
  });

  it('a SKU can be changed in Square from the Salon inventory; one already in use is refused', async () => {
    const r = await api.put(`/api/inventory-sync/products/${SQ.bond}/square-sku`, { sku: 'BOND-RMV-2' });
    expect([r.status, r.body.changed]).toEqual([200, true]);
    expect((await new MockSquareService().listProducts()).find((p) => p.variationId === SQ.bond)!.sku).toBe('BOND-RMV-2');
    expect((await api.get('/api/inventory/products?q=bond-rmv-2')).body.products[0].variationId).toBe(SQ.bond);
    const dup = await api.put(`/api/inventory-sync/products/${SQ.bond}/square-sku`, { sku: 'htw-20-60' });
    expect([dup.status, dup.body.error.message]).toEqual([400, expect.stringMatching(/already used by/)]);
    const history = (await db().query<any>("SELECT old_sku, new_sku FROM stock_txns WHERE kind = 'sku' AND product_key = $1", [SQ.bond]));
    expect(history).toEqual([{ old_sku: 'BOND-RMV', new_sku: 'BOND-RMV-2' }]);
  });

  it('discontinued products stop being tracked: not synced, not listed, not “needs attention” — until made active again', async () => {
    await sync();
    const discontinue = (key: string, status: string) => api.put('/api/inventory-sync/stock/products/settings', { rows: [{ key, status }] });
    expect((await discontinue(SQ.weft60, 'discontinued')).status).toBe(200);
    expect((await discontinue(SQ.bond, 'discontinued')).status).toBe(200);
    demoSquareStock.set(SQ.weft60, 1);
    const run = await sync();
    expect(run.message).toMatch(/1 discontinued \(not tracked\)/);
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(12); // not synced
    const listed = (await api.get('/api/inventory/products')).body.products.map((p: any) => p.variationId);
    expect(listed).not.toContain(SQ.weft60);
    expect((await api.get('/api/inventory/products?kind=discontinued')).body.products.map((p: any) => [p.variationId, p.discontinued]))
      .toEqual(expect.arrayContaining([[SQ.weft60, true], [SQ.bond, true]]));
    expect((await api.get('/api/inventory-sync')).body.unmatched.squareOnly.map((p: any) => p.id)).not.toContain(SQ.bond);
    // Something that needed attention stops counting once discontinued.
    await db().query("UPDATE inventory_sync_links SET status = 'needs_attention' WHERE square_variation_id = $1", [SQ.weft60]);
    expect((await api.get('/api/inventory-sync/links?status=needs_attention')).body.links.map((l: any) => l.squareVariationId)).not.toContain(SQ.weft60);
    // Active again: the next sync picks it up.
    await discontinue(SQ.weft60, 'active');
    await sync();
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(1);
  });

  it('only people who run the inventory sync can set types', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'jennifer@addendumsalon.com', password: 'addendum-demo' });
    expect((await agent.put('/api/inventory-sync/products/kind').set('X-Requested-With', 'addendum-crm').send({ variationIds: [SQ.bond], kind: 'service' })).status).toBe(403);
  });
});
