import type { InventorySeparateDTO, ProductKind, InventorySyncLinkDTO, InventorySyncOverviewDTO, InventorySyncRunDTO } from '@addendum/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { badRequest, IntegrationError, notFound } from '../lib/errors.js';
import { iso } from '../lib/time.js';
import { credentialStatus } from '../integrations/credentials.js';
import { isDemo, shopify2Name, shopifyName, shopifyService, shopifyService2, squareName, squareService } from '../integrations/registry.js';
import { ShopifyStaleQuantityError, type ShopifyInventoryEntry, type ShopifyService } from '../integrations/shopify/ShopifyService.js';
import type { SquareService } from '../integrations/square/types.js';
import { getSettings } from '../repos/settings.js';

/**
 * Two-way product stock sync between Square and Shopify.
 *
 * Scope: products and their stock quantities only, using Square's Catalog/Inventory APIs and Shopify's
 * inventory APIs. Customers, appointments, services and bookings are never read or written here.
 *
 * Matching: a Square variation and a Shopify variant are linked when they share a SKU (exactly one on each
 * side), or when an admin links them by hand. Nothing is ever created in either system.
 *
 * Conflict rule (shown in the app): each link remembers the quantity both systems agreed on after the last
 * sync (the baseline). Changes made on either side since then are combined — new = baseline + Square change +
 * Shopify change — so a sale in Shopify and a sale in Square both come off. The first time a product is linked
 * and the counts differ, the configured system (Square by default) wins. Anything that would go negative, or
 * a change larger than the review limit, is held for a person to resolve.
 *
 * Safety: Shopify writes are compare-and-set (refused if Shopify changed since it was read; retried next run).
 * Square writes are physical counts timestamped at the moment Square was read, so Square sales made during the
 * sync are applied on top. Every write carries an idempotency key. After a sync both sides equal the baseline,
 * so a following run — or the webhook our own write triggers — finds nothing to do (no loops).
 */

export const CONFLICT_RULE =
  'Changes made in either system since the last sync are combined (a sale in Shopify and a sale in Square both come off). ' +
  'The first time a product is paired and the counts differ, {source}’s count is kept. After that, results below zero, or single changes over {limit}, are held for review.';

const normSku = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
/** SKUs are matched ignoring case but stored and shown exactly as the store has them (Square's spelling first). */
const shownSku = (...skus: (string | null | undefined)[]) => skus.map((s) => s?.trim()).find(Boolean) ?? null;
const DETAIL_CAP = 400;

type Detail = InventorySyncRunDTO['details'][number];

function runDTO(r: any): InventorySyncRunDTO {
  return {
    id: r.id, trigger: r.trigger, status: r.status, startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at), startedBy: r.started_by ?? null,
    stage: r.stage, total: r.total, processed: r.processed, updatedSquare: r.updated_square, updatedShopify: r.updated_shopify,
    unchanged: r.unchanged, failed: r.failed, attention: r.attention, message: r.message, details: r.details ?? [],
  };
}

function linkDTO(r: any): InventorySyncLinkDTO {
  return {
    id: r.id, label: r.label, sku: r.sku, matchMethod: r.match_method, status: r.status, issue: r.issue,
    baselineQuantity: r.baseline_quantity, squareQuantity: r.last_square_quantity == null ? null : Number(r.last_square_quantity),
    shopifyQuantity: r.last_shopify_quantity, lastSyncedAt: iso(r.last_synced_at), lastChange: r.last_change,
    squareVariationId: r.square_variation_id, shopifyInventoryItemId: r.shopify_inventory_item_id, shopifySyncEnabled: r.shopify_sync_enabled !== false,
  };
}

const RUN_SELECT = `SELECT r.*, s.name AS started_by FROM inventory_sync_runs r LEFT JOIN staff s ON s.id = r.started_by_staff_id`;

export async function getRun(id: string) {
  const r = await db().one(`${RUN_SELECT} WHERE r.id = $1`, [id]);
  if (!r) throw notFound('That sync');
  return runDTO(r);
}

export async function listRuns(limit = 15) {
  return (await db().query(`${RUN_SELECT} ORDER BY r.started_at DESC LIMIT $1`, [limit])).map(runDTO);
}

export async function listLinks(status?: string) {
  const rows = await db().query(
    `SELECT l.*, COALESCE(p.enabled, true) AS shopify_sync_enabled
       FROM inventory_sync_links l LEFT JOIN product_shopify_sync p ON p.square_variation_id = l.square_variation_id
      ${status ? `WHERE status = $1 AND ${ACTIVE_LINK}` : ''}
      ORDER BY CASE status WHEN 'error' THEN 0 WHEN 'needs_attention' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, lower(label)`,
    status ? [status] : [],
  );
  return rows.map(linkDTO);
}

async function lastUnmatched() {
  const r = await db().one<{ value: any }>("SELECT value FROM settings WHERE key = 'inventory-sync.unmatched'");
  const u = r?.value ?? { squareOnly: [], shopifyOnly: [], duplicates: [], noSku: 0 };
  // Products marked "only in one store" since the last run drop out straight away.
  const sep = await separateIds();
  return { ...u, squareOnly: u.squareOnly.filter((p: any) => !sep.square.has(p.id)), shopifyOnly: u.shopifyOnly.filter((i: any) => !sep.shopify.has(i.id)) };
}

/**
 * Products marked Discontinued or Not tracked (Products tab, or Salon inventory → Set type). Keys are Square variation
 * IDs, or "shopify:<inventory item id>" for products only in Shopify. They're left out of every sync, of "Needs
 * attention" and of "Not matched"; marking one Active again brings it back (the next sync combines what changed meanwhile).
 */
export async function inactiveProducts(): Promise<Set<string>> {
  const rows = await db().query<{ product_key: string }>("SELECT product_key FROM stock_products WHERE status <> 'active'");
  return new Set(rows.map((r) => r.product_key));
}
const ACTIVE_LINK = `NOT EXISTS (SELECT 1 FROM stock_products sp WHERE sp.product_key = l.square_variation_id AND sp.status <> 'active')`;

// ---------------- Products kept in one store only ----------------

async function separateIds() {
  const rows = await db().query<{ store: string; item_id: string }>('SELECT store, item_id FROM inventory_sync_separate');
  // Discontinued (or not tracked) products drop out of "Not matched" too.
  const gone = await inactiveProducts();
  return {
    square: new Set([...rows.filter((r) => r.store === 'square').map((r) => r.item_id), ...[...gone].filter((k) => !k.startsWith('shopify:'))]),
    shopify: new Set([...rows.filter((r) => r.store === 'shopify').map((r) => r.item_id), ...[...gone].filter((k) => k.startsWith('shopify:')).map((k) => k.slice(8))]),
  };
}

export async function listSeparate(): Promise<InventorySeparateDTO[]> {
  const rows = await db().query<any>(
    `SELECT x.*, s.name AS marked_by FROM inventory_sync_separate x LEFT JOIN staff s ON s.id = x.marked_by_staff_id ORDER BY x.store, lower(x.label)`,
  );
  return rows.map((r) => ({ store: r.store, itemId: r.item_id, label: r.label, sku: r.sku, markedAt: iso(r.created_at)!, markedBy: r.marked_by ?? null }));
}

/**
 * Marks unpaired products as sold in one store only, so they're left out of "Not matched". It's only a label: if the
 * product later gets a SKU that matches one in the other store (or is paired by hand), it pairs and syncs as usual
 * and the mark is dropped. Paired products can't be marked — turn off their "Sync to Shopify" instead.
 */
export async function markSeparate(items: { store: 'square' | 'shopify'; itemId: string; label: string; sku: string | null }[], staffId: string | null) {
  for (const i of items) {
    const paired = await db().one<{ label: string }>(
      i.store === 'square' ? 'SELECT label FROM inventory_sync_links WHERE square_variation_id = $1' : 'SELECT label FROM inventory_sync_links WHERE shopify_inventory_item_id = $1', [i.itemId]);
    if (paired) throw badRequest(`${paired.label} is paired by SKU, so it syncs. To stop it, turn off its “Sync to Shopify” or unlink it.`);
  }
  for (const i of items) {
    await db().query(
      `INSERT INTO inventory_sync_separate(store, item_id, label, sku, marked_by_staff_id) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (store, item_id) DO UPDATE SET label = $3, sku = $4, marked_by_staff_id = $5, created_at = now()`,
      [i.store, i.itemId, i.label, i.sku, staffId],
    );
  }
}

/** Unmarks a product: it's listed under "Not matched" again until it pairs by SKU. */
export async function unmarkSeparate(store: 'square' | 'shopify', itemId: string) {
  await db().query('DELETE FROM inventory_sync_separate WHERE store = $1 AND item_id = $2', [store, itemId]);
}

/** Pairing (by SKU or by hand) overrides an "only in one store" mark. */
async function clearSeparate(squareVariationId: string, shopifyInventoryItemId: string) {
  await db().query(
    "DELETE FROM inventory_sync_separate WHERE (store = 'square' AND item_id = $1) OR (store = 'shopify' AND item_id = $2)",
    [squareVariationId, shopifyInventoryItemId],
  );
}

export async function syncOverview(): Promise<InventorySyncOverviewDTO> {
  const s = await getSettings();
  const [sq, sh, sh2] = await Promise.all([credentialStatus('square'), credentialStatus('shopify'), credentialStatus('shopify2')]);
  const sqSvc = await squareService();
  const shSvc = shopifyService();
  const counts = await db().one<any>(
    `SELECT count(*)::int linked, count(*) FILTER (WHERE status = 'in_sync')::int in_sync, count(*) FILTER (WHERE status = 'needs_attention' AND ${ACTIVE_LINK})::int attention,
            count(*) FILTER (WHERE status = 'error' AND ${ACTIVE_LINK})::int errors, count(*) FILTER (WHERE status = 'pending' AND ${ACTIVE_LINK})::int pending,
            count(*) FILTER (WHERE p.enabled = false)::int sync_off
       FROM inventory_sync_links l LEFT JOIN product_shopify_sync p ON p.square_variation_id = l.square_variation_id`,
  );
  const last = await db().one(`${RUN_SELECT} ORDER BY r.started_at DESC LIMIT 1`);
  const ok = await db().one<{ t: Date }>("SELECT max(finished_at) t FROM inventory_sync_runs WHERE status IN ('ok','partial')");
  const describe = (c: Awaited<ReturnType<typeof credentialStatus>>, connected: boolean) => ({
    connected,
    status: isDemo() ? 'demo' : !connected ? 'not_configured' : c.status,
    message: isDemo() ? 'Demo Mode — a simulated store' : !connected ? `Not configured. Missing: ${c.missing.join('; ') || 'credentials'}.` : c.lastTestMessage,
    lastSuccessAt: c.lastSuccessAt,
  });
  return {
    square: describe(sq, !!sqSvc),
    shopify: describe(sh, !!shSvc),
    shopify2: { name: shopify2Name(), ...describe(sh2, !!shopifyService2()) },
    lastRun: last ? runDTO(last) : null,
    lastSuccessfulSyncAt: iso(ok?.t),
    running: last?.status === 'running',
    counts: { linked: counts.linked, inSync: counts.in_sync, attention: counts.attention, errors: counts.errors, pending: counts.pending, syncOff: counts.sync_off },
    unmatched: await lastUnmatched(),
    separate: await listSeparate(),
    rule: CONFLICT_RULE.replace('{source}', s.inventorySync.firstSyncSource === 'square' ? 'Square' : 'Shopify')
      .replace('{limit}', s.inventorySync.holdChangesOver ? `${s.inventorySync.holdChangesOver} units` : 'any size (no limit set)'),
    settings: s.inventorySync,
    demoMode: isDemo(),
  };
}

/**
 * Per-product "Sync to Shopify". A product without a saved choice syncs. Turning it off leaves the pairing and its
 * last agreed count in place; the product is simply skipped by every sync (automatic, manual, webhook, retry),
 * by "settle" and by the manual push. Turning it back on syncs from the next run, combining changes since the
 * last agreed count like any other run — changing the setting never writes stock by itself.
 */
export async function shopifySyncOff(): Promise<Set<string>> {
  const rows = await db().query<{ square_variation_id: string }>('SELECT square_variation_id FROM product_shopify_sync WHERE NOT enabled');
  return new Set(rows.map((r) => r.square_variation_id));
}

export async function setShopifySync(variationIds: string[], enabled: boolean, staffId: string | null) {
  for (const id of new Set(variationIds)) {
    await db().query(
      `INSERT INTO product_shopify_sync(square_variation_id, enabled, updated_by_staff_id) VALUES ($1, $2, $3)
       ON CONFLICT (square_variation_id) DO UPDATE SET enabled = $2, updated_by_staff_id = $3, updated_at = now()`,
      [id, enabled, staffId],
    );
    // The product's type follows: syncing means shared stock; turning it off on a shared product means separate stock.
    await db().query(
      enabled ? `INSERT INTO product_kind(square_variation_id, kind, updated_by_staff_id) VALUES ($1, 'shared', $2)
                 ON CONFLICT (square_variation_id) DO UPDATE SET kind = 'shared', updated_by_staff_id = $2, updated_at = now()`
              : `UPDATE product_kind SET kind = 'separate', updated_by_staff_id = $2, updated_at = now() WHERE square_variation_id = $1 AND kind = 'shared'`,
      [id, staffId],
    );
  }
}

// ---------------- Product types ----------------

/** Each Square product's type: the saved choice, or (when none) shared/separate for paired products by their sync switch. */
export async function productKinds(): Promise<Map<string, ProductKind>> {
  const rows = await db().query<{ id: string; kind: ProductKind }>(
    `SELECT l.square_variation_id id, CASE WHEN COALESCE(p.enabled, true) THEN 'shared' ELSE 'separate' END kind
       FROM inventory_sync_links l LEFT JOIN product_shopify_sync p ON p.square_variation_id = l.square_variation_id
     UNION ALL SELECT square_variation_id, kind FROM product_kind`,
  );
  return new Map(rows.map((r) => [r.id, r.kind])); // saved choices come last, so they win
}

/**
 * Sets the type of Square products. Only shared stock syncs with Shopify; every other type turns "Sync to Shopify" off
 * (a pairing is kept, so the CRM still knows it's the same product). Unpaired products that aren't shared are taken
 * off "Not matched". Stock is never written by changing the type.
 */
export async function setProductKind(variationIds: string[], kind: ProductKind, staffId: string | null) {
  const ids = [...new Set(variationIds)];
  await setShopifySync(ids, kind === 'shared', staffId);
  for (const id of ids) {
    await db().query(
      `INSERT INTO product_kind(square_variation_id, kind, updated_by_staff_id) VALUES ($1, $2, $3)
       ON CONFLICT (square_variation_id) DO UPDATE SET kind = $2, updated_by_staff_id = $3, updated_at = now()`,
      [id, kind, staffId],
    );
    const paired = await db().one('SELECT 1 FROM inventory_sync_links WHERE square_variation_id = $1', [id]);
    if (kind === 'shared') await unmarkSeparate('square', id);
    else if (!paired) {
      await db().query(
        `INSERT INTO inventory_sync_separate(store, item_id, label, sku, marked_by_staff_id)
         SELECT 'square', variation_id, concat_ws(' · ', item_name, variation_name), sku, $2 FROM square_inventory WHERE variation_id = $1
         ON CONFLICT (store, item_id) DO NOTHING`,
        [id, staffId],
      );
    }
  }
}

/** Resolves which Square location's stock is synced. */
export async function squareLocation(sq: SquareService) {
  const want = config().SQUARE_INVENTORY_LOCATION_ID?.trim();
  const locations = await sq.listLocations();
  if (want) {
    if (!locations.some((l) => l.id === want)) throw badRequest(`Square location ${want} wasn’t found. Check the Inventory location ID in Settings → API & Integrations → Square.`);
    return want;
  }
  if (locations.length === 1) return locations[0].id;
  throw badRequest(`Square has ${locations.length} locations. Choose the one to sync in Settings → API & Integrations → Square → Inventory location ID.`);
}

let running: Promise<InventorySyncRunDTO> | null = null;

/**
 * Starts a sync. Only one runs at a time: a second request while one is running returns the running one.
 * `wait: false` returns as soon as the run is recorded (the screen then polls its progress).
 */
let starting: Promise<unknown> = Promise.resolve();
export function startInventorySync(opts: { trigger: InventorySyncRunDTO['trigger']; staffId?: string | null; onlyFailed?: boolean; wait?: boolean }): Promise<InventorySyncRunDTO> {
  // Serialise starts so two clicks (or a click and the scheduler) can't both begin a run.
  const next = starting.then(() => begin(opts));
  starting = next.catch(() => undefined);
  return next;
}

async function begin(opts: { trigger: InventorySyncRunDTO['trigger']; staffId?: string | null; onlyFailed?: boolean; wait?: boolean }): Promise<InventorySyncRunDTO> {
  // A run left "running" by a server restart is closed off so it can't block syncing forever.
  await db().query(`UPDATE inventory_sync_runs SET status = 'failed', finished_at = now(), message = 'Interrupted (the server restarted). Run the sync again.'
                     WHERE status = 'running' AND started_at < now() - interval '15 minutes'`);
  const active = await db().one<{ id: string }>("SELECT id FROM inventory_sync_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1");
  if (active || running) {
    if (opts.wait && running) return running;
    return getRun(active?.id ?? (await running!).id);
  }
  const run = await db().one<{ id: string }>(
    `INSERT INTO inventory_sync_runs(trigger, started_by_staff_id, stage) VALUES ($1, $2, 'Starting') RETURNING id`,
    [opts.trigger, opts.staffId ?? null],
  );
  const id = run!.id;
  running = execute(id, !!opts.onlyFailed)
    .catch(async (e) => {
      const msg = e instanceof IntegrationError ? e.userMessage : (e as any)?.userMessage ?? 'The sync stopped unexpectedly. Nothing further was changed. Try again.';
      console.warn('[inventory-sync] failed:', e instanceof IntegrationError ? e.technical ?? e.userMessage : (e as Error).message);
      await db().query(`UPDATE inventory_sync_runs SET status = 'failed', finished_at = now(), stage = NULL, message = $2 WHERE id = $1`, [id, msg]);
      return getRun(id);
    })
    .finally(() => { running = null; });
  if (opts.wait) return running;
  return getRun(id);
}


async function stage(id: string, text: string, total?: number) {
  await db().query(`UPDATE inventory_sync_runs SET stage = $2, total = COALESCE($3, total) WHERE id = $1`, [id, text, total ?? null]);
}

async function execute(runId: string, onlyFailed: boolean): Promise<InventorySyncRunDTO> {
  const settings = (await getSettings()).inventorySync;
  // What each store is called in the CRM (e.g. Salon / AH-PRO / AH). Instructions about the apps themselves keep the app names.
  const SQ = squareName();
  const SH = shopifyName();
  const sq = await squareService();
  const shop = shopifyService();
  if (!sq || !shop) {
    const missing = [!sq && 'Square', !shop && 'Shopify'].filter(Boolean).join(' and ');
    throw badRequest(`${missing} ${!sq && !shop ? 'aren’t' : 'isn’t'} connected. Add the credentials in Settings → API & Integrations, then test the connection.`);
  }

  await stage(runId, `Reading ${SQ} products and stock`);
  const sqLoc = await squareLocation(sq);
  const products = await sq.listProducts();
  const squareReadAt = new Date(Date.now() - 1000).toISOString(); // counts are applied "as of" this moment
  const counts = await sq.listInventoryCounts();
  const sqQty = new Map<string, number>();
  for (const c of counts) if (c.locationId === sqLoc) sqQty.set(c.variationId, (sqQty.get(c.variationId) ?? 0) + c.quantity);

  await stage(runId, `Reading ${SH} products and stock`);
  const shLoc = await shop.locationId();
  const shopItems = await shop.listInventory(shLoc);

  // A second Shopify store sharing the same stock: every product there with a synced SKU (duplicates included) keeps
  // the same count. Its sales since it was last set are added to the shared count.
  const shop2 = shopifyService2();
  const store2 = shopify2Name();
  let sh2Loc: string | null = null;
  let store2Problem: string | null = null;
  const sh2BySku = new Map<string, ShopifyInventoryEntry[]>();
  // Draft listings there usually start with "Track quantity" off; those with a synced SKU get tracking turned on (below).
  const sh2UntrackedDrafts: ShopifyInventoryEntry[] = [];
  let draftsTracked = 0;
  const extraRows = new Map((await db().query<any>('SELECT * FROM inventory_sync_extra')).map((r) => [r.inventory_item_id as string, r]));
  if (shop2) {
    await stage(runId, `Reading ${store2} products and stock`);
    try {
      sh2Loc = await shop2.locationId();
      for (const i of await shop2.listInventory(sh2Loc)) {
        if (!normSku(i.sku) || i.available == null) continue;
        if (!i.tracked) { if (i.status === 'DRAFT') sh2UntrackedDrafts.push(i); continue; }
        sh2BySku.set(normSku(i.sku), [...(sh2BySku.get(normSku(i.sku)) ?? []), i]);
      }
    } catch (e) {
      store2Problem = `${store2} couldn’t be read this time (${e instanceof IntegrationError ? e.userMessage : 'no answer'}); it’ll be updated next sync.`;
      sh2Loc = null;
    }
  }
  const markExtras = async (items: ShopifyInventoryEntry[], qty: number) => {
    for (const e of items) {
      await db().query(
        `INSERT INTO inventory_sync_extra(inventory_item_id, store, sku, label, synced_baseline) VALUES ($1,'shopify2',$2,$3,$4)
         ON CONFLICT (inventory_item_id) DO UPDATE SET sku = $2, label = $3, synced_baseline = $4, updated_at = now()`, [e.inventoryItemId, e.sku, e.label, qty]);
    }
  };

  await stage(runId, 'Matching products by SKU');
  const sqById = new Map(products.map((p) => [p.variationId, p]));
  const shById = new Map(shopItems.map((i) => [i.inventoryItemId, i]));
  const sqBySku = new Map<string, typeof products>();
  for (const p of products) if (normSku(p.sku)) sqBySku.set(normSku(p.sku), [...(sqBySku.get(normSku(p.sku)) ?? []), p]);
  const shBySku = new Map<string, ShopifyInventoryEntry[]>();
  for (const i of shopItems) if (normSku(i.sku)) shBySku.set(normSku(i.sku), [...(shBySku.get(normSku(i.sku)) ?? []), i]);

  const existing = await db().query<any>('SELECT * FROM inventory_sync_links');
  const linkedSq = new Set(existing.map((l) => l.square_variation_id));
  const linkedSh = new Set(existing.map((l) => l.shopify_inventory_item_id));
  // A SKU used twice in Square can't be paired reliably (listed for attention). In Shopify several listings may share a
  // SKU (e.g. a PRO listing): the paired (or first) one is the product and the others follow it with the same stock.
  const duplicates: { sku: string; where: string; count: number }[] = [];
  for (const [sku, list] of sqBySku) if (list.length > 1) duplicates.push({ sku: list[0].sku!, where: SQ, count: list.length });
  const dupSkus = new Set(duplicates.map((d) => normSku(d.sku)));
  const shSiblings = new Map<string, ShopifyInventoryEntry[]>();
  const siblingIds = new Set<string>();
  for (const [sku, list] of shBySku) {
    const tracked = list.filter((i) => i.tracked);
    if (tracked.length < 2) continue;
    const primary = tracked.find((i) => linkedSh.has(i.inventoryItemId)) ?? [...tracked].sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId))[0];
    const others = tracked.filter((i) => i !== primary && !linkedSh.has(i.inventoryItemId));
    shBySku.set(sku, [primary, ...list.filter((i) => !i.tracked && i !== primary)].slice(0, 1));
    if (!others.length) continue;
    shSiblings.set(sku, others);
    for (const i of others) siblingIds.add(i.inventoryItemId);
  }
  const markSiblings = async (items: ShopifyInventoryEntry[], qty: number) => {
    for (const e of items) {
      await db().query(
        `INSERT INTO inventory_sync_extra(inventory_item_id, store, sku, label, synced_baseline) VALUES ($1,'shopify_sibling',$2,$3,$4)
         ON CONFLICT (inventory_item_id) DO UPDATE SET store = 'shopify_sibling', sku = $2, label = $3, synced_baseline = $4, updated_at = now()`, [e.inventoryItemId, e.sku, e.label, qty]);
    }
  };

  // New SKU matches: exactly one product per SKU on each side, neither already linked. Never creates products.
  for (const [sku, list] of sqBySku) {
    if (dupSkus.has(sku)) continue;
    const other = shBySku.get(sku);
    if (!other || other.length !== 1) continue;
    const p = list[0];
    const i = other[0];
    if (linkedSq.has(p.variationId) || linkedSh.has(i.inventoryItemId)) continue;
    const label = [p.itemName, p.variationName].filter(Boolean).join(' · ');
    await db().query(
      `INSERT INTO inventory_sync_links(sku, match_method, label, square_variation_id, square_location_id, shopify_inventory_item_id, shopify_location_id)
       VALUES ($1,'sku',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [shownSku(p.sku, i.sku), label, p.variationId, sqLoc, i.inventoryItemId, shLoc],
    );
    linkedSq.add(p.variationId);
    linkedSh.add(i.inventoryItemId);
    // A matching SKU wins over "only in one store": the mark is dropped once the products pair.
    await clearSeparate(p.variationId, i.inventoryItemId);
  }
  const sep = await separateIds();
  const unmatched = {
    squareOnly: products.filter((p) => normSku(p.sku) && !linkedSq.has(p.variationId) && !sep.square.has(p.variationId) && !dupSkus.has(normSku(p.sku)) && p.trackInventory)
      .slice(0, 200).map((p) => ({ id: p.variationId, label: [p.itemName, p.variationName].filter(Boolean).join(' · '), sku: p.sku })),
    shopifyOnly: shopItems.filter((i) => !linkedSh.has(i.inventoryItemId) && !siblingIds.has(i.inventoryItemId) && !sep.shopify.has(i.inventoryItemId) && !dupSkus.has(normSku(i.sku)) && i.tracked)
      .slice(0, 200).map((i) => ({ id: i.inventoryItemId, label: i.label, sku: i.sku })),
    duplicates,
    noSku: products.filter((p) => !normSku(p.sku) && p.trackInventory && !sep.square.has(p.variationId)).length,
  };
  await db().query(
    `INSERT INTO settings(key, value) VALUES ('inventory-sync.unmatched', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
    [JSON.stringify(unmatched)],
  );

  const off = await shopifySyncOff();
  const allLinks = await db().query<any>(`SELECT * FROM inventory_sync_links ${onlyFailed ? "WHERE status IN ('error','pending')" : ''} ORDER BY lower(label)`);
  const gone = await inactiveProducts();
  const isGone = (l: any) => gone.has(l.square_variation_id) || gone.has(`shopify:${l.shopify_inventory_item_id}`);
  const links = allLinks.filter((l) => !off.has(l.square_variation_id) && !isGone(l));
  const skippedGone = allLinks.filter(isGone).length;
  const skippedOff = allLinks.length - links.length - skippedGone;
  // Separate-stock products: the salon isn't synced, but the online stock is still shared by the two Shopify stores.
  const onlineOnly = new Set(allLinks.filter((l) => off.has(l.square_variation_id) && !isGone(l)).map((l) => l.shopify_inventory_item_id as string));

  // Drafts aren't on sale yet, so turning on their stock tracking is safe — and it lets them go live with the right count.
  if (shop2 && sh2Loc && sh2UntrackedDrafts.length) {
    const syncedSkus = new Set(links.map((l) => normSku(sqById.get(l.square_variation_id)?.sku) || normSku(shById.get(l.shopify_inventory_item_id)?.sku)).filter(Boolean));
    // Shopify-only products (not in Square) sync between the two stores too.
    for (const i of shopItems) if (i.tracked && (!linkedSh.has(i.inventoryItemId) || onlineOnly.has(i.inventoryItemId)) && normSku(i.sku) && !dupSkus.has(normSku(i.sku)) && !gone.has(`shopify:${i.inventoryItemId}`)) syncedSkus.add(normSku(i.sku));
    for (const e of sh2UntrackedDrafts.filter((x) => syncedSkus.has(normSku(x.sku)))) {
      try {
        await shop2.setTracked(e.inventoryItemId, true);
        draftsTracked++;
        sh2BySku.set(normSku(e.sku), [...(sh2BySku.get(normSku(e.sku)) ?? []), { ...e, tracked: true }]);
      } catch (err) {
        console.warn('[inventory-sync] store 2 tracking not turned on:', e.sku, err instanceof IntegrationError ? err.technical ?? err.userMessage : (err as Error).message);
      }
    }
  }
  await stage(runId, 'Comparing stock', links.length);

  const details: Detail[] = [];
  const tally = { updated_square: 0, updated_shopify: 0, updated_store2: 0, unchanged: 0, failed: 0, attention: 0 };
  const note = (d: Detail) => { if (details.length < DETAIL_CAP) details.push(d); };
  const setLink = (id: string, patch: Record<string, unknown>) => {
    const keys = Object.keys(patch);
    return db().query(`UPDATE inventory_sync_links SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => patch[k])]);
  };
  const attention = async (l: any, issue: string, extra: Record<string, unknown> = {}) => {
    tally.attention++;
    note({ label: l.label, sku: l.sku, result: 'attention', note: issue });
    await setLink(l.id, { status: 'needs_attention', issue, ...extra });
  };

  type Plan = { link: any; S: number; H: number; target: number; why: string; extras: ShopifyInventoryEntry[]; siblings: ShopifyInventoryEntry[] };
  const plans: Plan[] = [];
  for (const l of links) {
    let p = sqById.get(l.square_variation_id);
    let i = shById.get(l.shopify_inventory_item_id);
    // A product deleted and re-created (or replaced) on one side is relinked by SKU: exactly one unpaired product there
    // must carry the SKU. The pairing starts over, and if the counts differ it's held so a person picks the right one.
    if (!p !== !i) {
      const sku = normSku(l.sku) || normSku(p?.sku) || normSku(i?.sku);
      const found = !sku || dupSkus.has(sku) ? [] : !p ? (sqBySku.get(sku) ?? []).filter((x) => !linkedSq.has(x.variationId)) : (shBySku.get(sku) ?? []).filter((x) => !linkedSh.has(x.inventoryItemId));
      if (found.length === 1) {
        const old = { sq: l.square_variation_id, sh: l.shopify_inventory_item_id };
        if (!p) { p = found[0] as typeof products[number]; l.square_variation_id = p.variationId; l.label = [p.itemName, p.variationName].filter(Boolean).join(' · '); }
        else { i = found[0] as ShopifyInventoryEntry; l.shopify_inventory_item_id = i.inventoryItemId; }
        l.sku = shownSku(p?.sku, i?.sku, l.sku);
        l.baseline_quantity = null;
        await setLink(l.id, { square_variation_id: l.square_variation_id, shopify_inventory_item_id: l.shopify_inventory_item_id, label: l.label, sku: l.sku, match_method: 'sku', baseline_quantity: null });
        if (old.sq !== l.square_variation_id) await db().query('UPDATE product_shopify_sync SET square_variation_id = $2 WHERE square_variation_id = $1', [old.sq, l.square_variation_id]);
        linkedSq.add(l.square_variation_id);
        linkedSh.add(l.shopify_inventory_item_id);
        await clearSeparate(l.square_variation_id, l.shopify_inventory_item_id);
        l.relinked = old.sq !== l.square_variation_id ? SQ : SH;
      }
    }
    if (!p) { await attention(l, `This product is no longer in Square (deleted or archived)${l.sku ? `, and no single unpaired Square product has SKU ${l.sku}` : ''}. Unlink it, or link the right product.`); continue; }
    // Keeps the shown SKU in step with the stores' own spelling (also fixes SKUs saved in lowercase before).
    if (l.sku && normSku(l.sku) === normSku(p?.sku ?? i?.sku) && shownSku(p?.sku, i?.sku) !== l.sku) {
      l.sku = shownSku(p?.sku, i?.sku);
      await setLink(l.id, { sku: l.sku });
    }
    if (!i) { await attention(l, `This product is no longer in Shopify${l.sku ? `, and no single unpaired Shopify product has SKU ${l.sku}` : ''}. Unlink it, or link the right product.`); continue; }
    if (l.square_location_id !== sqLoc || l.shopify_location_id !== shLoc) {
      // The synced location changed: start fresh for this product rather than mixing two locations' counts.
      await setLink(l.id, { square_location_id: sqLoc, shopify_location_id: shLoc, baseline_quantity: null });
      l.baseline_quantity = null;
    }
    if (!p.trackInventory) { await attention(l, 'Square isn’t tracking stock for this product. Turn on stock tracking in Square.'); continue; }
    if (!i.tracked) { await attention(l, 'Shopify isn’t tracking stock for this product. Turn on “Track quantity” in Shopify.'); continue; }
    if (i.available == null) { await attention(l, 'This product isn’t stocked at the Shopify location being synced.'); continue; }
    const S = sqQty.get(p.variationId) ?? 0;
    const H = i.available;
    if (!Number.isInteger(S)) { await attention(l, `Square has a part quantity (${S}); Shopify only counts whole units. Set a whole number in Square.`, { last_square_quantity: S, last_shopify_quantity: H }); continue; }
    const B: number | null = l.baseline_quantity;
    // The second store's products with this SKU, and how much they changed since they were last set.
    const skuKey = normSku(p.sku) || normSku(i.sku);
    const extras = (sh2Loc && skuKey && sh2BySku.get(skuKey)) || [];
    // Main-store listings sharing the SKU (e.g. PRO): their sales since last set count too, and they get the same count.
    const siblings = ((skuKey && shSiblings.get(skuKey)) || []).filter((e) => e.inventoryItemId !== i!.inventoryItemId && e.available != null);
    let dE = 0;
    for (const e of [...extras, ...siblings]) { const r = extraRows.get(e.inventoryItemId); if (r?.synced_baseline != null) dE += e.available! - r.synced_baseline; }
    const sign = (n: number) => `${n > 0 ? '+' : ''}${n}`;
    let target: number;
    let why: string;
    if (B == null) {
      if (S === H) {
        if (extras.every((e) => e.available === S) && siblings.every((e) => e.available === S)) {
          await setLink(l.id, { baseline_quantity: S, last_square_quantity: S, last_shopify_quantity: H, status: 'in_sync', issue: null, last_synced_at: new Date() });
          await markExtras(extras, S);
          await markSiblings(siblings, S);
          tally.unchanged++;
          continue;
        }
        target = S;
        why = `${store2} set to match`;
      } else if (l.relinked) {
        // A freshly relinked product (often re-created at 0) mustn't overwrite the other store's count unseen.
        await attention(l, `Relinked by SKU ${l.sku} to the new ${l.relinked} product, but the counts differ (${SQ} ${S}, ${SH} ${H}). Choose which count is right.`, { last_square_quantity: S, last_shopify_quantity: H });
        continue;
      } else {
        target = settings.firstSyncSource === 'square' ? S : H;
        why = `first sync — ${settings.firstSyncSource === 'square' ? SQ : SH}’s count kept`;
      }
    } else {
      const dS = S - B;
      const dH = H - B;
      if (dS === 0 && dH === 0 && dE === 0) {
        if (extras.every((e) => e.available === B) && siblings.every((e) => e.available === B)) {
          await setLink(l.id, { last_square_quantity: S, last_shopify_quantity: H, status: 'in_sync', issue: null, last_synced_at: new Date() });
          await markExtras(extras, B);
          await markSiblings(siblings, B);
          tally.unchanged++;
          continue;
        }
        target = B;
        why = `${store2} set to match`;
      } else {
        target = B + dS + dH + dE;
        const parts = [dS && `${SQ} ${sign(dS)}`, dH && `${SH} ${sign(dH)}`, dE && `${siblings.length ? 'other listings' : store2} ${sign(dE)}`].filter(Boolean) as string[];
        why = parts.length > 1 ? `changed in more than one store (${parts.join(', ')})` : `changed in ${parts[0]?.replace(/ ([+-]\d+)$/, ' ($1)')}`;
      }
    }
    if (target < 0) {
      await attention(l, `Combining the changes would leave ${target} in stock (${SQ} ${S}, ${SH} ${H}, last synced ${B}). Choose which count is right.`, { last_square_quantity: S, last_shopify_quantity: H });
      continue;
    }
    const limit = settings.holdChangesOver;
    // The review limit is for ongoing changes; the first pairing follows the first-sync rule (and is listed in the report).
    if (limit > 0 && B != null && (Math.abs(target - S) > limit || Math.abs(target - H) > limit)) {
      await attention(l, `Held for review: this would change stock by more than ${limit} (${SQ} ${S}, ${SH} ${H} → ${target}). Choose which count is right.`, { last_square_quantity: S, last_shopify_quantity: H });
      continue;
    }
    plans.push({ link: l, S, H, target, why, extras, siblings });
  }
  await db().query('UPDATE inventory_sync_runs SET processed = $2 WHERE id = $1', [runId, links.length - plans.length]);

  // ---- Writes ----
  await stage(runId, 'Updating stock');
  const shopifyWrites = plans.filter((p) => p.target !== p.H);
  const squareWrites = plans.filter((p) => p.target !== p.S);
  const shopifyOk = new Set<string>();
  const shopifyStale = new Set<string>();
  const shopifyFailed = new Map<string, string>();
  for (let n = 0; n < shopifyWrites.length; n += 25) {
    const batch = shopifyWrites.slice(n, n + 25);
    await writeShopify(shop, shLoc, batch, `${runId}-${n / 25}`, runId, shopifyOk, shopifyStale, shopifyFailed);
  }
  // Square is only updated for products whose Shopify side is settled (written, or needing no write).
  const squareOk = new Set<string>();
  const squareFailed = new Map<string, string>();
  const sqReady = squareWrites.filter((p) => p.target === p.H || shopifyOk.has(p.link.id));
  for (let n = 0; n < sqReady.length; n += 100) {
    const batch = sqReady.slice(n, n + 100);
    try {
      await sq.setInventoryCounts(
        batch.map((p) => ({ variationId: p.link.square_variation_id, locationId: sqLoc, quantity: p.target, occurredAt: squareReadAt, referenceId: `addendum-sync:${runId}` })),
        `inv-sync-${runId}-${n / 100}`,
      );
      batch.forEach((p) => squareOk.add(p.link.id));
    } catch (e) {
      const msg = e instanceof IntegrationError ? e.userMessage : 'Square could not be updated.';
      console.warn('[inventory-sync] square write failed:', e instanceof IntegrationError ? e.technical ?? e.userMessage : (e as Error).message);
      batch.forEach((p) => squareFailed.set(p.link.id, msg));
    }
  }

  for (const p of plans) {
    const l = p.link;
    const needSh = p.target !== p.H;
    const needSq = p.target !== p.S;
    if (needSh && shopifyStale.has(l.id)) {
      note({ label: l.label, sku: l.sku, result: 'retry', note: `${SH}’s count changed during the sync — it will be picked up next time.` });
      await setLink(l.id, { status: 'pending', issue: `Changed in ${SH} during the last sync; will sync next time.`, last_square_quantity: p.S, last_shopify_quantity: p.H });
      continue;
    }
    const err = (needSh && shopifyFailed.get(l.id)) || (needSq && (squareFailed.get(l.id) ?? (!squareOk.has(l.id) ? `Not updated because the ${SH} update didn’t go through.` : null)));
    if (err) {
      tally.failed++;
      note({ label: l.label, sku: l.sku, result: 'failed', note: err });
      // If Shopify was written but Square wasn't, the baseline becomes Square's count: the next run then sees
      // Shopify's new number as the only change and copies it to Square — finishing the job without double-counting.
      const shWritten = needSh && shopifyOk.has(l.id);
      await setLink(l.id, { status: 'error', issue: err, last_square_quantity: p.S, last_shopify_quantity: shWritten ? p.target : p.H, ...(shWritten ? { baseline_quantity: p.S } : {}) });
      continue;
    }
    if (needSh) tally.updated_shopify++;
    if (needSq) tally.updated_square++;
    // The second store's products with this SKU follow (each compare-and-set, so a sale there is never overwritten).
    let extraNote = '';
    if (shop2 && sh2Loc && p.extras.length) {
      const need = p.extras.filter((e) => e.available !== p.target);
      try {
        if (need.length) {
          await shop2.setAvailable(sh2Loc, need.map((e) => ({ inventoryItemId: e.inventoryItemId, quantity: p.target, changeFromQuantity: e.available })), `inv-sync2-${runId}-${l.id}`, `addendum-crm://inventory-sync/${runId}`);
          tally.updated_store2++;
          extraNote = `${store2}${need.length > 1 ? ` (${need.length} listings)` : ''} ${need.map((e) => e.available).join('/')} → ${p.target}`;
        }
        await markExtras(p.extras, p.target);
      } catch (e) {
        extraNote = e instanceof ShopifyStaleQuantityError ? `${store2} changed during the sync — next time` : `${store2} not updated (${e instanceof IntegrationError ? e.userMessage : 'no answer'})`;
      }
    }
    // Main-store listings sharing the SKU (e.g. PRO) follow too (compare-and-set).
    if (p.siblings.length) {
      const need = p.siblings.filter((e) => e.available !== p.target);
      try {
        if (need.length) {
          await shop.setAvailable(shLoc, need.map((e) => ({ inventoryItemId: e.inventoryItemId, quantity: p.target, changeFromQuantity: e.available })), `inv-sync-sib-${runId}-${l.id}`, `addendum-crm://inventory-sync/${runId}`);
          extraNote = [extraNote, `${SH} other listing${need.length > 1 ? 's' : ''} ${need.map((e) => e.available).join('/')} → ${p.target}`].filter(Boolean).join(', ');
        }
        await markSiblings(p.siblings, p.target);
      } catch (e) {
        extraNote = [extraNote, e instanceof ShopifyStaleQuantityError ? `${SH} other listings changed during the sync — next time` : `${SH} other listings not updated (${e instanceof IntegrationError ? e.userMessage : 'no answer'})`].filter(Boolean).join(', ');
      }
    }
    const change = [needSq && `${SQ} ${p.S} → ${p.target}`, needSh && `${SH} ${p.H} → ${p.target}`, extraNote].filter(Boolean).join(', ');
    note({ label: l.label, sku: l.sku, result: needSq && needSh ? 'updated_both' : needSq ? 'updated_square' : 'updated_shopify', note: `${change} (${p.why})` });
    await setLink(l.id, { baseline_quantity: p.target, last_square_quantity: p.target, last_shopify_quantity: p.target, status: 'in_sync', issue: null, last_synced_at: new Date(), last_change: `${change} (${p.why})` });
    if (needSq) await updateLocalSquareCopy(l.square_variation_id, sqLoc, p.target);
    // Stock history (Inventory Sync → Stock): what the sync changed and why.
    await db().query(
      `INSERT INTO stock_txns(product_key, label, sku, kind, reason, note, square_before, square_after, shopify_before, shopify_after, reference)
       VALUES ($1,$2,$3,'sync',$4,$5,$6,$7,$8,$9,$10)`,
      [l.square_variation_id, l.label, l.sku, p.why, extraNote || null, p.S, p.target, p.H, p.target, `sync:${runId}`]);
  }

  // ---- Shopify-only products: not in Square, same SKU in both Shopify stores. The two stores keep one shared count,
  // combined the same way (count when last set + changes in each store since). The first time, the main store's count is kept.
  let shopifyOnlySynced = 0;
  if (!onlyFailed && ((shop2 && sh2Loc) || shSiblings.size)) {
    await stage(runId, `Syncing ${SH}-only products`);
    for (const a of shopItems) {
      const sku = normSku(a.sku);
      if (!sku || siblingIds.has(a.inventoryItemId) || (linkedSh.has(a.inventoryItemId) && !onlineOnly.has(a.inventoryItemId)) || dupSkus.has(sku) || !a.tracked || a.available == null || gone.has(`shopify:${a.inventoryItemId}`)) continue;
      const extras = (shop2 && sh2Loc && sh2BySku.get(sku)) || [];
      const sibs = (shSiblings.get(sku) ?? []).filter((e) => e.available != null);
      if (!extras.length && !sibs.length) continue;
      const A = a.available;
      const B: number | null = extraRows.get(a.inventoryItemId)?.synced_baseline ?? null;
      let dE = 0;
      for (const e of [...extras, ...sibs]) { const r = extraRows.get(e.inventoryItemId); if (r?.synced_baseline != null) dE += e.available! - r.synced_baseline; }
      const target = B == null ? A : A + dE;
      const label = a.label;
      if (B != null && target === A && extras.every((e) => e.available === target) && sibs.every((e) => e.available === target)) { tally.unchanged++; continue; }
      if (target < 0) { tally.attention++; note({ label, sku: a.sku, result: 'attention', note: `${SH} + ${store2} only: combining the two stores’ sales would leave ${target}. Set the right count in the Products tab.` }); continue; }
      const limit = settings.holdChangesOver;
      if (limit > 0 && B != null && (Math.abs(target - A) > limit || extras.some((e) => Math.abs(target - e.available!) > limit))) {
        tally.attention++; note({ label, sku: a.sku, result: 'attention', note: `${SH} + ${store2} only: held for review — this would change stock by more than ${limit}. Set the right count in the Products tab.` }); continue;
      }
      try {
        const sibNeed = sibs.filter((e) => e.available !== target);
        if (A !== target || sibNeed.length) await shop.setAvailable(shLoc, [...(A !== target ? [{ inventoryItemId: a.inventoryItemId, quantity: target, changeFromQuantity: A }] : []), ...sibNeed.map((e) => ({ inventoryItemId: e.inventoryItemId, quantity: target, changeFromQuantity: e.available }))], `inv-sync-so-${runId}-${a.inventoryItemId}`, `addendum-crm://inventory-sync/${runId}`);
        const need = extras.filter((e) => e.available !== target);
        if (need.length && shop2 && sh2Loc) await shop2.setAvailable(sh2Loc, need.map((e) => ({ inventoryItemId: e.inventoryItemId, quantity: target, changeFromQuantity: e.available })), `inv-sync2-so-${runId}-${a.inventoryItemId}`, `addendum-crm://inventory-sync/${runId}`);
        await markExtras(extras, target);
        await markSiblings(sibs, target);
        await db().query(
          `INSERT INTO inventory_sync_extra(inventory_item_id, store, sku, label, synced_baseline) VALUES ($1,'shopify1',$2,$3,$4)
           ON CONFLICT (inventory_item_id) DO UPDATE SET sku = $2, label = $3, synced_baseline = $4, updated_at = now()`, [a.inventoryItemId, a.sku, label, target]);
        if (A !== target) tally.updated_shopify++;
        if (need.length) tally.updated_store2++;
        if (A !== target || need.length || sibNeed.length) {
          shopifyOnlySynced++;
          const change = [A !== target && `${SH} ${A} → ${target}`, sibNeed.length && `${SH} other listing${sibNeed.length > 1 ? 's' : ''} ${sibNeed.map((e) => e.available).join('/')} → ${target}`, need.length && `${store2} ${need.map((e) => e.available).join('/')} → ${target}`].filter(Boolean).join(', ');
          note({ label, sku: a.sku, result: 'updated_shopify', note: `${change} (${onlineOnly.has(a.inventoryItemId) ? `online stock, separate from ${SQ}` : `not in ${SQ}`} — ${B == null ? `first sync, ${SH}’s count kept` : 'both stores’ sales combined'})` });
        } else tally.unchanged++;
      } catch (e) {
        if (e instanceof ShopifyStaleQuantityError) note({ label, sku: a.sku, result: 'retry', note: 'A count changed during the sync — it will be picked up next time.' });
        else { tally.failed++; note({ label, sku: a.sku, result: 'failed', note: e instanceof IntegrationError ? e.userMessage : 'Not updated.' }); }
      }
    }
  }

  const status = tally.failed ? (tally.updated_square + tally.updated_shopify ? 'partial' : 'failed') : 'ok';
  const parts = [
    tally.updated_shopify && `${tally.updated_shopify} updated in ${SH}`,
    tally.updated_square && `${tally.updated_square} updated in ${SQ}`,
    tally.updated_store2 && `${tally.updated_store2} updated in ${store2}`,
    shopifyOnlySynced && `${shopifyOnlySynced} online product${shopifyOnlySynced === 1 ? '' : 's'} synced between ${SH} and ${store2}`,
    draftsTracked && `stock tracking turned on for ${draftsTracked} draft listing${draftsTracked === 1 ? '' : 's'} in ${store2}`,
    store2Problem,
    `${tally.unchanged} already matched`,
    tally.attention && `${tally.attention} need attention`,
    tally.failed && `${tally.failed} failed`,
    shopifyStale.size && `${shopifyStale.size} will retry`,
    skippedOff && `${skippedOff} skipped (separate stock — not synced)`,
    skippedGone && `${skippedGone} discontinued (not tracked)`,
  ].filter(Boolean);
  await db().query(
    `UPDATE inventory_sync_runs SET status = $2, finished_at = now(), stage = NULL, processed = total, updated_square = $3, updated_shopify = $4,
       unchanged = $5, failed = $6, attention = $7, message = $8, details = $9::jsonb WHERE id = $1`,
    [runId, status, tally.updated_square, tally.updated_shopify, tally.unchanged, tally.failed, tally.attention,
      `${parts.join(' · ')}.${status === 'failed' ? ' Nothing was reported as synced that didn’t sync.' : ''}`, JSON.stringify(details)],
  );
  return getRun(runId);
}

async function writeShopify(
  shop: ShopifyService, loc: string, batch: { link: any; H: number; target: number }[], key: string, runId: string,
  ok: Set<string>, stale: Set<string>, failed: Map<string, string>,
) {
  const send = (items: typeof batch, k: string) =>
    shop.setAvailable(loc, items.map((p) => ({ inventoryItemId: p.link.shopify_inventory_item_id, quantity: p.target, changeFromQuantity: p.H })), `inv-sync-${k}`, `addendum-crm://inventory-sync/${runId}`);
  try {
    await send(batch, key);
    batch.forEach((p) => ok.add(p.link.id));
  } catch (e) {
    if (e instanceof ShopifyStaleQuantityError && batch.length > 1) {
      // One product changed under us; send them one by one so the rest still go through.
      for (const [i, p] of batch.entries()) await writeShopify(shop, loc, [p], `${key}-${i}`, runId, ok, stale, failed);
      return;
    }
    if (e instanceof ShopifyStaleQuantityError) { stale.add(batch[0].link.id); return; }
    const msg = e instanceof IntegrationError ? e.userMessage : 'Shopify could not be updated.';
    console.warn('[inventory-sync] shopify write failed:', e instanceof IntegrationError ? e.technical ?? e.userMessage : (e as Error).message);
    batch.forEach((p) => failed.set(p.link.id, msg));
  }
}

/** Keeps the searchable Square stock list (Order Hair → Square inventory) in step with what the sync wrote. */
export async function updateLocalSquareCopy(variationId: string, locationId: string, qty: number) {
  await db().query(
    `UPDATE square_inventory SET quantities = jsonb_set(quantities, ARRAY[$2::text], to_jsonb($3::numeric)),
       quantity = (SELECT COALESCE(sum(value::numeric), 0) FROM jsonb_each_text(jsonb_set(quantities, ARRAY[$2::text], to_jsonb($3::numeric)))),
       updated_at = now() WHERE variation_id = $1`,
    [variationId, locationId, qty],
  );
}

/**
 * A person settles a product that needs attention: the chosen system's current count is written to the other
 * one (with the same safety checks), and becomes the new baseline.
 */
export async function resolveLink(linkId: string, use: 'square' | 'shopify', staffId: string) {
  const l = await db().one<any>('SELECT * FROM inventory_sync_links WHERE id = $1', [linkId]);
  if (!l) throw notFound('That product link');
  if ((await shopifySyncOff()).has(l.square_variation_id)) throw badRequest('Sync to Shopify is off for this product. Turn it on first.');
  const sq = await squareService();
  const shop = shopifyService();
  if (!sq || !shop) throw badRequest('Square and Shopify both need to be connected to settle this product.');
  const sqLoc = await squareLocation(sq);
  const shLoc = await shop.locationId();
  const readAt = new Date(Date.now() - 1000).toISOString();
  // A product gone from Square would read as 0 and wipe Shopify's count — refuse instead.
  if (!(await sq.listProducts()).some((p) => p.variationId === l.square_variation_id)) {
    throw badRequest('This product is no longer in Square. Relink it to the right Square product, or unlink it.');
  }
  const S = (await sq.listInventoryCounts()).filter((c) => c.variationId === l.square_variation_id && c.locationId === sqLoc).reduce((a, c) => a + c.quantity, 0);
  const item = (await shop.listInventory(shLoc)).find((i) => i.inventoryItemId === l.shopify_inventory_item_id);
  if (!item || item.available == null) throw badRequest('This product isn’t stocked at the Shopify location being synced.');
  const H = item.available;
  const target = use === 'square' ? Math.floor(S) : H;
  const run = await db().one<{ id: string }>(`INSERT INTO inventory_sync_runs(trigger, started_by_staff_id, stage, total) VALUES ('resolve', $1, 'Updating stock', 1) RETURNING id`, [staffId]);
  try {
    if (target !== H) {
      await shop.setAvailable(shLoc, [{ inventoryItemId: l.shopify_inventory_item_id, quantity: target, changeFromQuantity: H }], `inv-resolve-${run!.id}`, `addendum-crm://inventory-sync/${run!.id}`);
    }
    if (target !== S) {
      await sq.setInventoryCounts([{ variationId: l.square_variation_id, locationId: sqLoc, quantity: target, occurredAt: readAt, referenceId: `addendum-sync:${run!.id}` }], `inv-resolve-${run!.id}`);
      await updateLocalSquareCopy(l.square_variation_id, sqLoc, target);
    }
  } catch (e) {
    const msg = e instanceof ShopifyStaleQuantityError ? 'Shopify’s count changed just now. Look again and choose.' : e instanceof IntegrationError ? e.userMessage : 'The update didn’t go through. Try again.';
    await db().query(`UPDATE inventory_sync_runs SET status = 'failed', finished_at = now(), stage = NULL, failed = 1, processed = 1, message = $2 WHERE id = $1`, [run!.id, msg]);
    throw badRequest(msg);
  }
  const change = `${use === 'square' ? 'Square' : 'Shopify'}’s count (${target}) kept by hand`;
  await db().query(
    `UPDATE inventory_sync_links SET baseline_quantity = $2::int, last_square_quantity = $2::int, last_shopify_quantity = $2::int, status = 'in_sync', issue = NULL,
       last_synced_at = now(), last_change = $3, square_location_id = $4, shopify_location_id = $5, updated_at = now() WHERE id = $1`,
    [linkId, target, change, sqLoc, shLoc],
  );
  await db().query(
    `UPDATE inventory_sync_runs SET status = 'ok', finished_at = now(), stage = NULL, processed = 1, updated_square = $2, updated_shopify = $3, message = $4, details = $5::jsonb WHERE id = $1`,
    [run!.id, target !== S ? 1 : 0, target !== H ? 1 : 0, `${l.label}: ${change}.`, JSON.stringify([{ label: l.label, sku: l.sku, result: 'updated_both', note: change }])],
  );
  return linkDTO(await db().one('SELECT * FROM inventory_sync_links WHERE id = $1', [linkId]));
}

/**
 * Edits a paired product in both stores at once: its SKU (written to Square's catalog and Shopify's inventory item)
 * and/or its stock count (set in both, with the same safety checks as a sync; it becomes the new baseline).
 * Refuses a SKU another product already uses in either store.
 */
export async function editLinkedProduct(linkId: string, edit: { sku?: string; quantity?: number }) {
  const l = await db().one<any>('SELECT * FROM inventory_sync_links WHERE id = $1', [linkId]);
  if (!l) throw notFound('That product link');
  const sq = await squareService();
  const shop = shopifyService();
  if (!sq || !shop) throw badRequest('Square and Shopify both need to be connected to edit this product.');
  const sqLoc = await squareLocation(sq);
  const shLoc = await shop.locationId();
  const readAt = new Date(Date.now() - 1000).toISOString();
  const [products, items, counts] = await Promise.all([sq.listProducts(), shop.listInventory(shLoc), sq.listInventoryCounts()]);
  const p = products.find((x) => x.variationId === l.square_variation_id);
  const i = items.find((x) => x.inventoryItemId === l.shopify_inventory_item_id);
  if (!p) throw badRequest('This product wasn’t found in Square (it may have been deleted). Unlink it.');
  if (!i) throw badRequest('This product wasn’t found in Shopify (it may have been deleted). Unlink it.');

  const sku = edit.sku?.trim();
  const skuSquare = sku != null && p.sku !== sku;
  const skuShopify = sku != null && i.sku !== sku;
  if (sku != null) {
    if (!sku) throw badRequest('Enter a SKU.');
    const sqClash = products.find((x) => x.variationId !== p.variationId && normSku(x.sku) === normSku(sku));
    if (sqClash) throw badRequest(`Another Square product already uses SKU ${sku} (${[sqClash.itemName, sqClash.variationName].filter(Boolean).join(' · ')}).`);
    const shClash = items.find((x) => x.inventoryItemId !== i.inventoryItemId && normSku(x.sku) === normSku(sku));
    if (shClash) throw badRequest(`Another Shopify product already uses SKU ${sku} (${shClash.label}).`);
  }
  const S = Math.floor(counts.filter((c) => c.variationId === p.variationId && c.locationId === sqLoc).reduce((a, c) => a + c.quantity, 0));
  const H = i.available;
  const qty = edit.quantity;
  if (qty != null && H == null) throw badRequest('This product isn’t stocked at the Shopify location being synced, so its count can’t be set there.');

  const done: string[] = [];
  const fail = (e: unknown) => {
    const msg = e instanceof ShopifyStaleQuantityError ? 'Shopify’s count changed just now (a sale?). Look again and try once more.' : e instanceof IntegrationError ? e.userMessage : 'The update didn’t go through. Try again.';
    return badRequest(done.length ? `${msg} Already done: ${done.join(', ')}.` : msg);
  };
  try {
    if (skuSquare) {
      await sq.setVariationSku(p.variationId, sku!, `sku-${p.variationId}-${normSku(sku)}`);
      await db().query(`UPDATE square_inventory SET sku = $2, search_text = search_text || ' ' || lower($2), updated_at = now() WHERE variation_id = $1`, [p.variationId, sku]);
      done.push('SKU in Square');
    }
    if (skuShopify) {
      await shop.setSku(i.inventoryItemId, sku!);
      done.push('SKU in Shopify');
    }
    if (sku != null) await db().query(`UPDATE inventory_sync_links SET sku = $2, match_method = 'sku', updated_at = now() WHERE id = $1`, [linkId, sku]);
    if (qty != null) {
      const key = `inv-edit-${linkId}-${Date.now()}`;
      if (qty !== H) {
        await shop.setAvailable(shLoc, [{ inventoryItemId: i.inventoryItemId, quantity: qty, changeFromQuantity: H }], key, `addendum-crm://inventory-sync/edit/${linkId}`);
        done.push('stock in Shopify');
      }
      if (qty !== S) {
        await sq.setInventoryCounts([{ variationId: p.variationId, locationId: sqLoc, quantity: qty, occurredAt: readAt, referenceId: `addendum-edit:${linkId}` }], key);
        await updateLocalSquareCopy(p.variationId, sqLoc, qty);
        done.push('stock in Square');
      }
      await db().query(
        `UPDATE inventory_sync_links SET baseline_quantity = $2::int, last_square_quantity = $2::int, last_shopify_quantity = $2::int, status = 'in_sync', issue = NULL,
           last_synced_at = now(), last_change = $3, square_location_id = $4, shopify_location_id = $5, updated_at = now() WHERE id = $1`,
        [linkId, qty, `Set to ${qty} by hand (was Square ${S}, Shopify ${H})`, sqLoc, shLoc],
      );
    }
  } catch (e) {
    throw fail(e);
  }
  const summary = { previousSku: { square: p.sku ?? null, shopify: i.sku }, previousQuantity: { square: S, shopify: H }, changed: done };
  return { link: linkDTO(await db().one('SELECT * FROM inventory_sync_links WHERE id = $1', [linkId])), ...summary };
}

/** Removes a pairing (the products themselves are untouched in both systems). It is matched again next sync only by SKU. */
export async function unlink(linkId: string) {
  await db().query('DELETE FROM inventory_sync_links WHERE id = $1', [linkId]);
}

/** Pairs two products picked from the "Not matched" lists, as they are (no SKU changes). */
export async function linkByIds(squareVariationId: string, shopifyInventoryItemId: string) {
  const sq = await squareService();
  const shop = shopifyService();
  if (!sq || !shop) throw badRequest('Square and Shopify both need to be connected.');
  const sqLoc = await squareLocation(sq);
  const shLoc = await shop.locationId();
  const [products, items] = await Promise.all([sq.listProducts(), shop.listInventory(shLoc)]);
  const p = products.find((x) => x.variationId === squareVariationId);
  const i = items.find((x) => x.inventoryItemId === shopifyInventoryItemId);
  if (!p) throw badRequest('That Square product wasn’t found. Run a sync and try again.');
  if (!i) throw badRequest('That Shopify product wasn’t found. Run a sync and try again.');
  const taken = await db().one('SELECT 1 FROM inventory_sync_links WHERE square_variation_id = $1 OR shopify_inventory_item_id = $2', [p.variationId, i.inventoryItemId]);
  if (taken) throw badRequest('One of these products is already paired. Unlink it first.');
  await clearSeparate(p.variationId, i.inventoryItemId);
  const label = [p.itemName, p.variationName].filter(Boolean).join(' · ');
  await db().query(
    `INSERT INTO inventory_sync_links(sku, match_method, label, square_variation_id, square_location_id, shopify_inventory_item_id, shopify_location_id)
     VALUES (NULL, 'manual', $1, $2, $3, $4, $5)`,
    [label, p.variationId, sqLoc, i.inventoryItemId, shLoc],
  );
  return { label };
}

/** Pairs a Square product with a Shopify product by hand, by their SKUs (for SKUs that don't match exactly). */
export async function linkBySku(squareSku: string, shopifySku: string) {
  const sq = await squareService();
  const shop = shopifyService();
  if (!sq || !shop) throw badRequest('Square and Shopify both need to be connected.');
  const sqLoc = await squareLocation(sq);
  const shLoc = await shop.locationId();
  const p = (await sq.listProducts()).filter((x) => normSku(x.sku) === normSku(squareSku));
  const i = (await shop.listInventory(shLoc)).filter((x) => normSku(x.sku) === normSku(shopifySku));
  if (p.length !== 1) throw badRequest(p.length ? `${p.length} Square products have SKU ${squareSku}.` : `No Square product has SKU ${squareSku}.`);
  if (i.length !== 1) throw badRequest(i.length ? `${i.length} Shopify products have SKU ${shopifySku}.` : `No Shopify product has SKU ${shopifySku}.`);
  const taken = await db().one('SELECT 1 FROM inventory_sync_links WHERE square_variation_id = $1 OR shopify_inventory_item_id = $2', [p[0].variationId, i[0].inventoryItemId]);
  if (taken) throw badRequest('One of these products is already paired. Unlink it first.');
  await clearSeparate(p[0].variationId, i[0].inventoryItemId);
  await db().query(
    `INSERT INTO inventory_sync_links(sku, match_method, label, square_variation_id, square_location_id, shopify_inventory_item_id, shopify_location_id)
     VALUES (NULL, 'manual', $1, $2, $3, $4, $5)`,
    [[p[0].itemName, p[0].variationName].filter(Boolean).join(' · '), p[0].variationId, sqLoc, i[0].inventoryItemId, shLoc],
  );
}

/**
 * Products not paired yet on each side, for "use Shopify's SKU in Square": Square variations that track stock, and
 * Shopify variants that track stock and have a SKU.
 */
export async function skuCandidates() {
  const sq = await squareService();
  const shop = shopifyService();
  if (!sq || !shop) throw badRequest('Square and Shopify both need to be connected.');
  const shLoc = await shop.locationId();
  const [products, items, links] = await Promise.all([sq.listProducts(), shop.listInventory(shLoc), db().query<any>('SELECT square_variation_id, shopify_inventory_item_id FROM inventory_sync_links')]);
  const linkedSq = new Set(links.map((l) => l.square_variation_id));
  const linkedSh = new Set(links.map((l) => l.shopify_inventory_item_id));
  return {
    square: products.filter((p) => p.trackInventory && !linkedSq.has(p.variationId))
      .map((p) => ({ variationId: p.variationId, label: [p.itemName, p.variationName].filter(Boolean).join(' · '), sku: p.sku ?? null })),
    shopify: items.filter((i) => i.tracked && normSku(i.sku) && !linkedSh.has(i.inventoryItemId))
      .map((i) => ({ inventoryItemId: i.inventoryItemId, label: i.label, sku: i.sku })),
  };
}

/**
 * Sets a Square product's SKU to its Shopify product's SKU (in Square's catalog — only the SKU changes) and pairs them,
 * so the stock sync handles them from the next run. Refuses anything that would create duplicate SKUs.
 */
export async function copyShopifySkuToSquare(squareVariationId: string, shopifyInventoryItemId: string) {
  const sq = await squareService();
  const shop = shopifyService();
  if (!sq || !shop) throw badRequest('Square and Shopify both need to be connected.');
  const sqLoc = await squareLocation(sq);
  const shLoc = await shop.locationId();
  const [products, items] = await Promise.all([sq.listProducts(), shop.listInventory(shLoc)]);
  const p = products.find((x) => x.variationId === squareVariationId);
  const i = items.find((x) => x.inventoryItemId === shopifyInventoryItemId);
  if (!p) throw badRequest('That Square product wasn’t found. Refresh and try again.');
  if (!i) throw badRequest('That Shopify product wasn’t found. Refresh and try again.');
  const sku = i.sku?.trim();
  if (!sku) throw badRequest('The Shopify product has no SKU. Add one in Shopify first.');
  if (items.filter((x) => normSku(x.sku) === normSku(sku)).length > 1) throw badRequest(`Several Shopify products use SKU ${sku}. Make it unique in Shopify first.`);
  const clash = products.find((x) => x.variationId !== p.variationId && normSku(x.sku) === normSku(sku));
  if (clash) throw badRequest(`Another Square product already uses SKU ${sku} (${[clash.itemName, clash.variationName].filter(Boolean).join(' · ')}). Change that one first.`);
  if (await db().one('SELECT 1 FROM inventory_sync_links WHERE square_variation_id = $1 OR shopify_inventory_item_id = $2', [p.variationId, i.inventoryItemId])) {
    throw badRequest('One of these products is already paired. Unlink it first.');
  }
  await clearSeparate(p.variationId, i.inventoryItemId);
  const changed = p.sku !== sku;
  if (changed) {
    await sq.setVariationSku(p.variationId, sku, `sku-${p.variationId}-${normSku(sku)}`);
    // Keep the searchable Square list in step (it refreshes from Square on the next sync anyway).
    await db().query(`UPDATE square_inventory SET sku = $2, search_text = search_text || ' ' || lower($2), updated_at = now() WHERE variation_id = $1`, [p.variationId, sku]);
  }
  const label = [p.itemName, p.variationName].filter(Boolean).join(' · ');
  await db().query(
    `INSERT INTO inventory_sync_links(sku, match_method, label, square_variation_id, square_location_id, shopify_inventory_item_id, shopify_location_id)
     VALUES ($1,'sku',$2,$3,$4,$5,$6)`,
    [sku, label, p.variationId, sqLoc, i.inventoryItemId, shLoc],
  );
  return { label, sku, previousSku: p.sku ?? null, changedInSquare: changed };
}

/** Called every minute by the scheduler: runs an automatic sync when it's turned on and due. */
export async function maybeAutoSync(now = new Date()) {
  const s = (await getSettings()).inventorySync;
  if (!s.enabled || !(await squareService()) || !shopifyService()) return null;
  const last = await db().one<{ t: Date }>("SELECT max(started_at) t FROM inventory_sync_runs WHERE trigger IN ('auto','manual','webhook')");
  if (last?.t && now.getTime() - new Date(last.t).getTime() < s.intervalMinutes * 60_000) return null;
  return startInventorySync({ trigger: 'auto', wait: true });
}

let webhookTimer: NodeJS.Timeout | null = null;
/** Square reported a stock change: sync soon (debounced, so a burst of changes is one sync). */
export function scheduleWebhookSync() {
  if (webhookTimer) return;
  webhookTimer = setTimeout(async () => {
    webhookTimer = null;
    const s = (await getSettings()).inventorySync;
    if (s.enabled) await startInventorySync({ trigger: 'webhook', wait: true }).catch(() => undefined);
  }, 30_000);
  webhookTimer.unref?.();
}

/** After a manual push to Shopify (Square inventory screen), both sides match: record that as the baseline. */
export async function recordPushedQuantities(pushed: { inventoryItemId: string; quantity: number }[]) {
  for (const p of pushed) {
    await db().query(
      `UPDATE inventory_sync_links SET baseline_quantity = $2::int, last_shopify_quantity = $2::int, last_square_quantity = $2::int, status = 'in_sync', issue = NULL,
         last_synced_at = now(), last_change = 'Pushed from Square by hand', updated_at = now() WHERE shopify_inventory_item_id = $1`,
      [p.inventoryItemId, p.quantity],
    );
  }
}
