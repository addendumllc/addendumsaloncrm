import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  await db().query('DELETE FROM inventory_sync_separate');
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

  it('relinks by SKU when the Square product was deleted and re-created', async () => {
    await sync();
    const before = await link(SQ.weft60);
    // The link still points at the old (now gone) Square product.
    await db().query("UPDATE inventory_sync_links SET square_variation_id = 'demo-gone' WHERE id = $1", [before.id]);
    const run = await sync();
    const after = await db().one<any>('SELECT * FROM inventory_sync_links WHERE id = $1', [before.id]);
    expect(after.square_variation_id).toBe(SQ.weft60);
    expect(after.status).toBe('in_sync');
    expect(run.attention).toBe(1); // only the care kit, as before
  });

  it('a relinked product whose counts differ is held for review, not overwritten', async () => {
    await sync();
    const before = await link(SQ.weft60);
    await db().query("UPDATE inventory_sync_links SET square_variation_id = 'demo-gone' WHERE id = $1", [before.id]);
    demoSquareStock.set(SQ.weft60, 0);
    await sync();
    const after = await db().one<any>('SELECT * FROM inventory_sync_links WHERE id = $1', [before.id]);
    expect(after.square_variation_id).toBe(SQ.weft60);
    expect(after.status).toBe('needs_attention');
    expect(after.issue).toMatch(/Relinked by SKU/);
    expect(MockShopifyService.stock.get(SH.weft60)).toBe(12);
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
    expect(run.details.find((d) => d.sku === 'HTW-20-60')?.result).toBe('retry');
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
    expect(run.details.find((d) => d.sku === 'HTW-20-60')?.result).toBe('failed');
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
    expect(run.message).toContain('1 skipped (separate stock — not synced)');
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

describe('Use Shopify’s SKU in Square', () => {
  const extra = [
    { sku: 'HTW-22-60-AH', inventoryItemId: 'gid://shopify/InventoryItem/9', label: 'Signature Hand-Tied Weft – 22" / #60 Platinum', tracked: true },
    { sku: 'BOND-RMV', inventoryItemId: 'gid://shopify/InventoryItem/10', label: 'Bond Remover', tracked: true },
  ];
  beforeEach(async () => {
    await freshStart();
    MockShopifyService.catalog.push(...extra);
    for (const e of extra) MockShopifyService.stock.set(e.inventoryItemId, 5);
  });
  afterEach(() => {
    MockShopifyService.catalog.splice(MockShopifyService.catalog.findIndex((c) => c.sku === 'HTW-22-60-AH'), 2);
  });

  it('sets the Square product’s SKU to Shopify’s, pairs them, and the next sync handles their stock', async () => {
    await sync();
    const c = (await api.get('/api/inventory-sync/sku-candidates')).body;
    expect(c.square.map((p: any) => p.variationId)).toContain('demo-v3');
    expect(c.shopify.map((p: any) => p.sku)).toContain('HTW-22-60-AH');
    const r = await api.post('/api/inventory-sync/links/from-shopify-sku', { squareVariationId: 'demo-v3', shopifyInventoryItemId: 'gid://shopify/InventoryItem/9' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ sku: 'HTW-22-60-AH', previousSku: 'HTW-22-60', changedInSquare: true });
    expect((await new MockSquareService().listProducts()).find((p) => p.variationId === 'demo-v3')!.sku).toBe('HTW-22-60-AH');
    expect((await link('demo-v3')).shopify_inventory_item_id).toBe('gid://shopify/InventoryItem/9');
    // Not paired twice; the next sync applies the first-sync rule (Square's count kept).
    expect((await api.post('/api/inventory-sync/links/from-shopify-sku', { squareVariationId: 'demo-v3', shopifyInventoryItemId: 'gid://shopify/InventoryItem/9' })).status).toBe(400);
    await sync();
    expect(MockShopifyService.stock.get('gid://shopify/InventoryItem/9')).toBe(0);
    expect((await link('demo-v3')).status).toBe('in_sync');
  });

  it('never creates duplicate SKUs, and only people who run the sync can use it', async () => {
    await sync();
    // BOND-RMV is already used by another Square product.
    const dup = await api.post('/api/inventory-sync/links/from-shopify-sku', { squareVariationId: 'demo-v3', shopifyInventoryItemId: 'gid://shopify/InventoryItem/10' });
    expect([dup.status, dup.body.error.message]).toEqual([400, expect.stringMatching(/already uses SKU BOND-RMV/)]);
    expect((await new MockSquareService().listProducts()).find((p) => p.variationId === 'demo-v3')!.sku).toBe('HTW-22-60');
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'jennifer@addendumsalon.com', password: 'addendum-demo' });
    expect((await agent.post('/api/inventory-sync/links/from-shopify-sku').set('X-Requested-With', 'addendum-crm').send({ squareVariationId: 'demo-v3', shopifyInventoryItemId: 'gid://shopify/InventoryItem/9' })).status).toBe(403);
  });
});

describe('Products sold in one store only', () => {
  beforeEach(freshStart);

  it('can be taken off “Not matched”, stay unsynced, and still pair if a matching SKU appears', async () => {
    await sync();
    let o = (await api.get('/api/inventory-sync')).body;
    const bond = o.unmatched.squareOnly.find((p: any) => p.sku === 'BOND-RMV');
    expect(bond.id).toBeTruthy();
    expect((await api.post('/api/inventory-sync/separate', { items: [{ store: 'square', itemId: bond.id, label: bond.label, sku: bond.sku }] })).status).toBe(200);
    o = (await api.get('/api/inventory-sync')).body;
    expect(o.unmatched.squareOnly.map((p: any) => p.sku)).not.toContain('BOND-RMV');
    expect(o.separate).toEqual([expect.objectContaining({ store: 'square', itemId: bond.id, sku: 'BOND-RMV' })]);
    await sync();
    expect((await api.get('/api/inventory-sync')).body.unmatched.squareOnly.map((p: any) => p.sku)).not.toContain('BOND-RMV');
    expect(await link(bond.id)).toBeNull();

    // Paired products sync, so they can't be marked.
    const paired = await api.post('/api/inventory-sync/separate', { items: [{ store: 'square', itemId: SQ.ktip, label: 'K-Tip', sku: null }] });
    expect([paired.status, paired.body.error.message]).toEqual([400, expect.stringMatching(/paired by SKU/)]);

    // A matching SKU in Shopify still pairs it, and the mark is dropped.
    const item = { sku: 'BOND-RMV', inventoryItemId: 'gid://shopify/InventoryItem/11', label: 'Bond Remover', tracked: true };
    MockShopifyService.catalog.push(item);
    MockShopifyService.stock.set(item.inventoryItemId, 3);
    try {
      await sync();
      expect((await link(bond.id)).shopify_inventory_item_id).toBe(item.inventoryItemId);
      expect((await api.get('/api/inventory-sync')).body.separate).toEqual([]);
    } finally {
      MockShopifyService.catalog.splice(MockShopifyService.catalog.indexOf(item), 1);
    }
  });

  it('can be undone, and Shopify-only products can be marked too', async () => {
    await sync();
    const o = (await api.get('/api/inventory-sync')).body;
    const items = [
      ...o.unmatched.squareOnly.map((p: any) => ({ store: 'square', itemId: p.id, label: p.label, sku: p.sku })),
      ...o.unmatched.shopifyOnly.map((p: any) => ({ store: 'shopify', itemId: p.id, label: p.label, sku: p.sku })),
    ];
    await api.post('/api/inventory-sync/separate', { items });
    expect((await api.get('/api/inventory-sync')).body.separate.length).toBe(items.length);
    const first = items[0];
    expect((await api.del(`/api/inventory-sync/separate/${first.store}/${encodeURIComponent(first.itemId)}`)).status).toBe(200);
    const after = (await api.get('/api/inventory-sync')).body;
    expect(after.separate.length).toBe(items.length - 1);
    expect(after.unmatched.squareOnly.length + after.unmatched.shopifyOnly.length).toBe(1);
  });
});

describe('Linking two products picked from “Not matched”', () => {
  beforeEach(freshStart);

  it('pairs them as they are (no SKU changes) and drops any “only here” mark', async () => {
    const item = { sku: 'BR-PRO', inventoryItemId: 'gid://shopify/InventoryItem/12', label: 'Bond Remover Pro', tracked: true };
    MockShopifyService.catalog.push(item);
    MockShopifyService.stock.set(item.inventoryItemId, 2);
    try {
      await sync();
      const bond = (await api.get('/api/inventory-sync')).body.unmatched.squareOnly.find((p: any) => p.sku === 'BOND-RMV');
      await api.post('/api/inventory-sync/separate', { items: [{ store: 'square', itemId: bond.id, label: bond.label, sku: bond.sku }] });
      const r = await api.post('/api/inventory-sync/links/by-id', { squareVariationId: bond.id, shopifyInventoryItemId: item.inventoryItemId });
      expect(r.status).toBe(201);
      expect((await link(bond.id))).toMatchObject({ match_method: 'manual', shopify_inventory_item_id: item.inventoryItemId });
      expect((await new MockSquareService().listProducts()).find((p) => p.variationId === bond.id)!.sku).toBe('BOND-RMV');
      expect((await api.get('/api/inventory-sync')).body.separate).toEqual([]);
      expect((await api.post('/api/inventory-sync/links/by-id', { squareVariationId: bond.id, shopifyInventoryItemId: item.inventoryItemId })).status).toBe(400);
    } finally {
      MockShopifyService.catalog.splice(MockShopifyService.catalog.indexOf(item), 1);
    }
  });
});

describe('Editing a linked product in both stores', () => {
  beforeEach(freshStart);

  it('changes the SKU and stock count in Square and Shopify, and the next sync has nothing to do', async () => {
    await sync();
    const l = await link(SQ.tape);
    const r = await api.patch(`/api/inventory-sync/links/${l.id}/product`, { sku: 'TAPE-16-8B', quantity: 15 });
    expect(r.status).toBe(200);
    expect(r.body.changed).toEqual(['SKU in Square', 'SKU in Shopify', 'stock in Shopify', 'stock in Square']);
    expect((await new MockSquareService().listProducts()).find((p) => p.variationId === SQ.tape)!.sku).toBe('TAPE-16-8B');
    expect((await new MockShopifyService().findBySkus(['TAPE-16-8B'])).map((i) => i.inventoryItemId)).toEqual([SH.tape]);
    expect(demoSquareStock.get(SQ.tape)).toBe(15);
    expect(MockShopifyService.stock.get(SH.tape)).toBe(15);
    expect(await link(SQ.tape)).toMatchObject({ sku: 'TAPE-16-8B', baseline_quantity: 15, status: 'in_sync' });
    const run = await sync();
    expect(run.updatedShopify + run.updatedSquare).toBe(0);
    expect((await link(SQ.tape)).id).toBe(l.id);
  });

  it('refuses a SKU another product already uses, and changes nothing', async () => {
    await sync();
    const l = await link(SQ.tape);
    const r = await api.patch(`/api/inventory-sync/links/${l.id}/product`, { sku: 'KTIP-22-1B' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/already uses SKU KTIP-22-1B/);
    expect(MockShopifyService.skus.size).toBe(0);
    expect((await api.patch(`/api/inventory-sync/links/${l.id}/product`, {})).status).toBe(400);
  });
});
