import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { startInventorySync } from '../src/domain/inventorySync.js';
import { setIntegrationOverride } from '../src/integrations/registry.js';
import { IntegrationError } from '../src/lib/errors.js';
import { MockShopifyService } from '../src/integrations/shopify/ShopifyService.js';
import { demoSquareHooks, demoSquareStock, MockSquareService, resetDemoSquareStock } from '../src/integrations/square/MockSquareService.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: Awaited<ReturnType<typeof setup>>['app'];

// Demo catalog: Square SKU → Square variation; Shopify SKU → inventory item.
const SQ = { weft60: 'demo-v1', weft1822: 'demo-v2', ktip: 'demo-v4', tape: 'demo-v5' };
const SH = { weft60: 'gid://shopify/InventoryItem/1', weft1822: 'gid://shopify/InventoryItem/2', ktip: 'gid://shopify/InventoryItem/4', tape: 'gid://shopify/InventoryItem/5' };
const sync = () => startInventorySync({ trigger: 'manual', wait: true });
const link = (variation: string) => db().one<any>('SELECT * FROM inventory_sync_links WHERE square_variation_id = $1', [variation]);

beforeAll(async () => {
  ({ api, app } = await setup());
});

async function freshStart() {
  await db().query('DELETE FROM inventory_sync_links');
  await db().query('DELETE FROM inventory_sync_runs');
  resetDemoSquareStock();
  MockShopifyService.reset();
  setIntegrationOverride({ square: new MockSquareService(), shopify: new MockShopifyService() });
  await api.patch('/api/settings', { inventorySync: { enabled: false, firstSyncSource: 'square', holdChangesOver: 25 } });
}

describe('Square ↔ Shopify inventory sync', () => {
  beforeEach(freshStart);

  it('first sync pairs products by SKU, keeps Square’s counts, and never creates products', async () => {
    const shopifyCatalog = MockShopifyService.catalog.length;
    const run = await sync();
    expect(run.status).toBe('ok');
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(12);
    expect(MockShopifyService.stock.get(SH.weft1822)).toBe(4);
    expect(MockShopifyService.stock.get(SH.ktip)).toBe(7);
    expect(MockShopifyService.stock.get(SH.tape)).toBe(9);
    expect(run.updatedShopify).toBe(4);
    expect(run.updatedSquare).toBe(0);
    expect(MockShopifyService.catalog.length).toBe(shopifyCatalog);
    // Care kit: Shopify doesn't track stock → needs attention, nothing written.
    expect(run.attention).toBe(1);
    const overview = (await api.get('/api/inventory-sync')).body;
    expect(overview.unmatched.squareOnly.map((p: any) => p.sku)).toEqual(expect.arrayContaining(['HTW-22-60', 'BOND-RMV']));
    expect(overview.counts.inSync).toBe(4);
    expect(overview.lastSuccessfulSyncAt).toBeTruthy();
  });

  it('a second sync changes nothing (no loops, no duplicate updates)', async () => {
    await sync();
    const writes = MockShopifyService.sets.length;
    const run = await sync();
    expect(run.updatedShopify + run.updatedSquare).toBe(0);
    expect(run.unchanged).toBe(4);
    expect(MockShopifyService.sets.length).toBe(writes);
  });

  it('Shopify → Square: a Shopify sale updates Square', async () => {
    await sync();
    MockShopifyService.stock.set(SH.weft60, 10);
    const run = await sync();
    expect(run.updatedSquare).toBe(1);
    expect(demoSquareStock.get(SQ.weft60)).toBe(10);
    expect((await link(SQ.weft60)).baseline_quantity).toBe(10);
  });

  it('Square → Shopify: a Square change updates Shopify', async () => {
    await sync();
    demoSquareStock.set(SQ.tape, 15);
    const run = await sync();
    expect(run.updatedShopify).toBe(1);
    expect(MockShopifyService.stock.get(SH.tape)).toBe(15);
  });

  it('changes on both sides are combined, not overwritten', async () => {
    await sync(); // both 7
    demoSquareStock.set(SQ.ktip, 6); // sold 1 in the salon
    MockShopifyService.stock.set(SH.ktip, 5); // sold 2 online
    await sync();
    expect(demoSquareStock.get(SQ.ktip)).toBe(4);
    expect(MockShopifyService.stock.get(SH.ktip)).toBe(4);
  });

  it('holds results below zero for review, and a person can settle them', async () => {
    await sync(); // weft1822 both 4
    demoSquareStock.set(SQ.weft1822, 0);
    MockShopifyService.stock.set(SH.weft1822, 0);
    const run = await sync(); // 4 + (-4) + (-4) = -4
    expect(run.attention).toBeGreaterThanOrEqual(1);
    const l = await link(SQ.weft1822);
    expect(l.status).toBe('needs_attention');
    expect(MockShopifyService.stock.get(SH.weft1822)).toBe(0);
    const r = await api.post(`/api/inventory-sync/links/${l.id}/resolve`, { use: 'square' });
    expect(r.status).toBe(200);
    expect(r.body.link.status).toBe('in_sync');
    expect((await link(SQ.weft1822)).baseline_quantity).toBe(0);
  });

  it('holds unusually large changes for review', async () => {
    await sync();
    demoSquareStock.set(SQ.tape, 200);
    const run = await sync();
    expect(run.attention).toBeGreaterThanOrEqual(1);
    expect(MockShopifyService.stock.get(SH.tape)).toBe(9); // not overwritten
  });

  it('never overwrites a Shopify sale made during the sync (compare-and-set), and picks it up next time', async () => {
    await sync();
    demoSquareStock.set(SQ.weft60, 11); // Square sale → Shopify should become 11
    MockShopifyService.onBeforeSet = () => MockShopifyService.stock.set(SH.weft60, 9); // online sale lands mid-sync
    const run = await sync();
    expect(run.details.find((d) => d.sku === 'htw-20-60')?.result).toBe('retry');
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(9); // the online sale survived
    await sync(); // 12 + (-1) + (-3) = 8
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(8);
    expect(demoSquareStock.get(SQ.weft60)).toBe(8);
  });

  it('reports failures honestly and a retry finishes the job without double-counting', async () => {
    await sync(); // ktip both 7
    demoSquareStock.set(SQ.ktip, 6); // -1 in Square
    MockShopifyService.stock.set(SH.ktip, 5); // -2 in Shopify → both should become 4
    demoSquareHooks.failNext = new IntegrationError('square', 'Square didn’t allow updating stock.', false, true);
    const run = await sync();
    expect(run.status).not.toBe('ok');
    expect(run.failed).toBe(1);
    expect((await link(SQ.ktip)).status).toBe('error');
    const retry = (await api.post('/api/inventory-sync/run', { onlyFailed: true })).body.run;
    await new Promise((r) => setTimeout(r, 400));
    const done = (await api.get(`/api/inventory-sync/runs/${retry.id}`)).body.run;
    expect(done.status).toBe('ok');
    expect(demoSquareStock.get(SQ.ktip)).toBe(4);
    expect(MockShopifyService.stock.get(SH.ktip)).toBe(4);
  });

  it('a Shopify outage fails the run with a clear message and changes nothing in Square', async () => {
    await sync();
    MockShopifyService.stock.set(SH.tape, 3);
    demoSquareStock.set(SQ.weft60, 20);
    MockShopifyService.failNext = new IntegrationError('shopify', 'Shopify could not be reached. Try again in a moment.', true);
    const run = await sync();
    expect(run.status).toBe('partial'); // Square still received the Shopify-side change for the tape-in
    expect(run.details.find((d) => d.sku === 'htw-20-60')?.result).toBe('failed');
    expect(demoSquareStock.get(SQ.tape)).toBe(3);
    MockShopifyService.failNext = null;
  });

  it('only touches product stock — no customers, appointments, services or follow-ups', async () => {
    const counts = async () => db().one<any>(`SELECT (SELECT count(*) FROM clients)::int c, (SELECT count(*) FROM appointments)::int a,
      (SELECT count(*) FROM services)::int s, (SELECT count(*) FROM tasks)::int t, (SELECT max(updated_at) FROM clients) cu`);
    const before = await counts();
    await sync();
    MockShopifyService.stock.set(SH.weft60, 1);
    await sync();
    expect(await counts()).toEqual(before);
  });

  it('says exactly what’s missing when a system isn’t connected', async () => {
    setIntegrationOverride({ shopify: null });
    const run = await sync();
    expect(run.status).toBe('failed');
    expect(run.message).toMatch(/Shopify isn’t connected.*API & Integrations/);
  });

  it('runs one sync at a time', async () => {
    const [a, b] = await Promise.all([
      startInventorySync({ trigger: 'manual' }),
      startInventorySync({ trigger: 'manual' }),
    ]);
    expect(a.id).toBe(b.id);
    await new Promise((r) => setTimeout(r, 300));
  });

  it('runs automatically when turned on and due', async () => {
    const { maybeAutoSync } = await import('../src/domain/inventorySync.js');
    expect(await maybeAutoSync()).toBeNull(); // off
    await api.patch('/api/settings', { inventorySync: { enabled: true, intervalMinutes: 15 } });
    const run = await maybeAutoSync();
    expect(run?.trigger).toBe('auto');
    expect(await maybeAutoSync()).toBeNull(); // not due again yet
  });

  it('is for administrators only', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'frontdesk@addendumsalon.com', password: 'addendum-demo' });
    expect((await agent.get('/api/inventory-sync')).status).toBe(403);
    expect((await agent.post('/api/inventory-sync/run').set('X-Requested-With', 'addendum-crm').send({})).status).toBe(403);
  });
});

describe('Per-product “Sync to Shopify”', () => {
  beforeEach(async () => {
    await freshStart();
    await db().query('DELETE FROM product_shopify_sync');
  });
  const setSync = (variationIds: string[], enabled: boolean) => api.put('/api/inventory-sync/products/shopify-sync', { variationIds, enabled });

  it('only products with sync on reach Shopify; others stay Square-only and keep their own settings', async () => {
    await sync();
    expect((await setSync([SQ.tape], false)).status).toBe(200);
    demoSquareStock.set(SQ.tape, 20); // off
    demoSquareStock.set(SQ.ktip, 3); // on
    MockShopifyService.stock.set(SH.tape, 5); // a Shopify change on an off product doesn't reach Square either
    const run = await sync();
    expect(MockShopifyService.stock.get(SH.ktip)).toBe(3);
    expect(MockShopifyService.stock.get(SH.tape)).toBe(5);
    expect(demoSquareStock.get(SQ.tape)).toBe(20);
    expect(run.updatedShopify).toBe(1);
    expect(run.message).toContain('1 skipped (Sync to Shopify off)');
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(12); // untouched products unchanged
  });

  it('is respected by retries, automatic and webhook-triggered syncs', async () => {
    await sync();
    await setSync([SQ.weft60], false);
    demoSquareStock.set(SQ.weft60, 1);
    await db().query("UPDATE inventory_sync_links SET status = 'error' WHERE square_variation_id = $1", [SQ.weft60]);
    for (const trigger of ['retry', 'auto', 'webhook'] as const) {
      await startInventorySync({ trigger, onlyFailed: trigger === 'retry', wait: true });
      expect(MockShopifyService.stock.get(SH.weft60)).toBe(12);
    }
  });

  it('changing the switch writes no stock, keeps the pairing, and persists', async () => {
    await sync();
    const before = await link(SQ.ktip);
    const writes = MockShopifyService.sets.length;
    const runs = (await db().one<any>('SELECT count(*)::int n FROM inventory_sync_runs')).n;
    await setSync([SQ.ktip], false);
    await setSync([SQ.ktip], false); // twice is harmless
    expect(MockShopifyService.sets.length).toBe(writes);
    expect((await db().one<any>('SELECT count(*)::int n FROM inventory_sync_runs')).n).toBe(runs);
    const after = await link(SQ.ktip);
    expect(after.id).toBe(before.id);
    expect(after.baseline_quantity).toBe(before.baseline_quantity);
    // Saved in the database: read back fresh by both screens.
    expect((await api.get('/api/inventory-sync/links')).body.links.find((l: any) => l.squareVariationId === SQ.ktip).shopifySyncEnabled).toBe(false);
    expect((await api.get('/api/inventory/products?q=K-TIP')).body.products.every((p: any) => p.variationId !== SQ.ktip || p.shopifySync.enabled === false)).toBe(true);
    expect((await api.get('/api/inventory-sync')).body.counts.syncOff).toBe(1);
  });

  it('turning it back on syncs from the next run, combining what changed meanwhile', async () => {
    await sync();
    await setSync([SQ.weft1822], false);
    demoSquareStock.set(SQ.weft1822, 2); // sold 2 in Square while off
    await sync();
    expect(MockShopifyService.stock.get(SH.weft1822)).toBe(4);
    await setSync([SQ.weft1822], true);
    expect(MockShopifyService.stock.get(SH.weft1822)).toBe(4); // not on the switch itself
    await sync();
    expect(MockShopifyService.stock.get(SH.weft1822)).toBe(2);
  });

  it('manual push and “settle” skip products with sync off; unpaired products say so', async () => {
    await sync();
    await setSync([SQ.tape], false);
    const r = (await api.post('/api/inventory/products/shopify-push', { variationIds: [SQ.tape, SQ.ktip] })).body.result;
    expect(r.skipped).toEqual([expect.objectContaining({ variationId: SQ.tape, reason: 'Sync to Shopify is off for this product.' })]);
    expect(r.pushed.map((p: any) => p.variationId)).toEqual([SQ.ktip]);
    const l = await link(SQ.tape);
    expect((await api.post(`/api/inventory-sync/links/${l.id}/resolve`, { use: 'square' })).status).toBe(400);
    const products = (await api.get('/api/inventory/products?limit=200')).body.products;
    expect(products.find((p: any) => p.sku === 'HTW-22-60').shopifySync).toMatchObject({ enabled: true, linked: false });
  });

  it('only people who run the inventory sync can change it', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'jennifer@addendumsalon.com', password: 'addendum-demo' });
    const r = await agent.put('/api/inventory-sync/products/shopify-sync').set('X-Requested-With', 'addendum-crm').send({ variationIds: [SQ.tape], enabled: false });
    expect(r.status).toBe(403);
    expect((await db().one('SELECT 1 FROM product_shopify_sync'))).toBeNull();
  });
});
