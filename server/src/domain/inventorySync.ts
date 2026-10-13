import type { InventorySyncLinkDTO, InventorySyncOverviewDTO, InventorySyncRunDTO } from '@addendum/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { badRequest, IntegrationError, notFound } from '../lib/errors.js';
import { iso } from '../lib/time.js';
import { credentialStatus } from '../integrations/credentials.js';
import { isDemo, shopifyService, squareService } from '../integrations/registry.js';
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
    squareVariationId: r.square_variation_id, shopifySyncEnabled: r.shopify_sync_enabled !== false,
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
      ${status ? 'WHERE status = $1' : ''}
      ORDER BY CASE status WHEN 'error' THEN 0 WHEN 'needs_attention' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, lower(label)`,
    status ? [status] : [],
  );
  return rows.map(linkDTO);
}

async function lastUnmatched() {
  const r = await db().one<{ value: any }>("SELECT value FROM settings WHERE key = 'inventory-sync.unmatched'");
  return r?.value ?? { squareOnly: [], shopifyOnly: [], duplicates: [], noSku: 0 };
}

export async function syncOverview(): Promise<InventorySyncOverviewDTO> {
  const s = await getSettings();
  const [sq, sh] = await Promise.all([credentialStatus('square'), credentialStatus('shopify')]);
  const sqSvc = await squareService();
  const shSvc = shopifyService();
  const counts = await db().one<any>(
    `SELECT count(*)::int linked, count(*) FILTER (WHERE status = 'in_sync')::int in_sync, count(*) FILTER (WHERE status = 'needs_attention')::int attention,
            count(*) FILTER (WHERE status = 'error')::int errors, count(*) FILTER (WHERE status = 'pending')::int pending,
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
    lastRun: last ? runDTO(last) : null,
    lastSuccessfulSyncAt: iso(ok?.t),
    running: last?.status === 'running',
    counts: { linked: counts.linked, inSync: counts.in_sync, attention: counts.attention, errors: counts.errors, pending: counts.pending, syncOff: counts.sync_off },
    unmatched: await lastUnmatched(),
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
  }
}

/** Resolves which Square location's stock is synced. */
async function squareLocation(sq: SquareService) {
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
  const sq = await squareService();
  const shop = shopifyService();
  if (!sq || !shop) {
    const missing = [!sq && 'Square', !shop && 'Shopify'].filter(Boolean).join(' and ');
    throw badRequest(`${missing} ${!sq && !shop ? 'aren’t' : 'isn’t'} connected. Add the credentials in Settings → API & Integrations, then test the connection.`);
  }

  await stage(runId, 'Reading Square products and stock');
  const sqLoc = await squareLocation(sq);
  const products = await sq.listProducts();
  const squareReadAt = new Date(Date.now() - 1000).toISOString(); // counts are applied "as of" this moment
  const counts = await sq.listInventoryCounts();
  const sqQty = new Map<string, number>();
  for (const c of counts) if (c.locationId === sqLoc) sqQty.set(c.variationId, (sqQty.get(c.variationId) ?? 0) + c.quantity);

  await stage(runId, 'Reading Shopify products and stock');
  const shLoc = await shop.locationId();
  const shopItems = await shop.listInventory(shLoc);

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
  const duplicates: { sku: string; where: string; count: number }[] = [];
  for (const [sku, list] of sqBySku) if (list.length > 1) duplicates.push({ sku: list[0].sku!, where: 'Square', count: list.length });
  for (const [sku, list] of shBySku) if (list.length > 1) duplicates.push({ sku: list[0].sku, where: 'Shopify', count: list.length });
  const dupSkus = new Set(duplicates.map((d) => normSku(d.sku)));

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
      [sku, label, p.variationId, sqLoc, i.inventoryItemId, shLoc],
    );
    linkedSq.add(p.variationId);
    linkedSh.add(i.inventoryItemId);
  }
  const unmatched = {
    squareOnly: products.filter((p) => normSku(p.sku) && !linkedSq.has(p.variationId) && !dupSkus.has(normSku(p.sku)) && p.trackInventory)
      .slice(0, 200).map((p) => ({ label: [p.itemName, p.variationName].filter(Boolean).join(' · '), sku: p.sku })),
    shopifyOnly: shopItems.filter((i) => !linkedSh.has(i.inventoryItemId) && !dupSkus.has(normSku(i.sku)) && i.tracked)
      .slice(0, 200).map((i) => ({ label: i.label, sku: i.sku })),
    duplicates,
    noSku: products.filter((p) => !normSku(p.sku) && p.trackInventory).length,
  };
  await db().query(
    `INSERT INTO settings(key, value) VALUES ('inventory-sync.unmatched', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
    [JSON.stringify(unmatched)],
  );

  const off = await shopifySyncOff();
  const allLinks = await db().query<any>(`SELECT * FROM inventory_sync_links ${onlyFailed ? "WHERE status IN ('error','pending')" : ''} ORDER BY lower(label)`);
  const links = allLinks.filter((l) => !off.has(l.square_variation_id));
  const skippedOff = allLinks.length - links.length;
  await stage(runId, 'Comparing stock', links.length);

  const details: Detail[] = [];
  const tally = { updated_square: 0, updated_shopify: 0, unchanged: 0, failed: 0, attention: 0 };
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

  type Plan = { link: any; S: number; H: number; target: number; why: string };
  const plans: Plan[] = [];
  for (const l of links) {
    const p = sqById.get(l.square_variation_id);
    const i = shById.get(l.shopify_inventory_item_id);
    if (!p) { await attention(l, 'This product is no longer in Square (deleted or archived). Unlink it, or link the right product.'); continue; }
    if (!i) { await attention(l, 'This product is no longer in Shopify. Unlink it, or link the right product.'); continue; }
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
    let target: number;
    let why: string;
    if (B == null) {
      if (S === H) {
        await setLink(l.id, { baseline_quantity: S, last_square_quantity: S, last_shopify_quantity: H, status: 'in_sync', issue: null, last_synced_at: new Date() });
        tally.unchanged++;
        continue;
      }
      target = settings.firstSyncSource === 'square' ? S : H;
      why = `first sync — ${settings.firstSyncSource === 'square' ? 'Square' : 'Shopify'}’s count kept`;
    } else {
      const dS = S - B;
      const dH = H - B;
      if (dS === 0 && dH === 0) {
        await setLink(l.id, { last_square_quantity: S, last_shopify_quantity: H, status: 'in_sync', issue: null, last_synced_at: new Date() });
        tally.unchanged++;
        continue;
      }
      target = B + dS + dH;
      why = dS && dH ? `changed in both (Square ${dS > 0 ? '+' : ''}${dS}, Shopify ${dH > 0 ? '+' : ''}${dH})` : dS ? `changed in Square (${dS > 0 ? '+' : ''}${dS})` : `changed in Shopify (${dH > 0 ? '+' : ''}${dH})`;
    }
    if (target < 0) {
      await attention(l, `Combining the changes would leave ${target} in stock (Square ${S}, Shopify ${H}, last synced ${B}). Choose which count is right.`, { last_square_quantity: S, last_shopify_quantity: H });
      continue;
    }
    const limit = settings.holdChangesOver;
    // The review limit is for ongoing changes; the first pairing follows the first-sync rule (and is listed in the report).
    if (limit > 0 && B != null && (Math.abs(target - S) > limit || Math.abs(target - H) > limit)) {
      await attention(l, `Held for review: this would change stock by more than ${limit} (Square ${S}, Shopify ${H} → ${target}). Choose which count is right.`, { last_square_quantity: S, last_shopify_quantity: H });
      continue;
    }
    plans.push({ link: l, S, H, target, why });
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
      note({ label: l.label, sku: l.sku, result: 'retry', note: 'Shopify’s count changed during the sync — it will be picked up next time.' });
      await setLink(l.id, { status: 'pending', issue: 'Changed in Shopify during the last sync; will sync next time.', last_square_quantity: p.S, last_shopify_quantity: p.H });
      continue;
    }
    const err = (needSh && shopifyFailed.get(l.id)) || (needSq && (squareFailed.get(l.id) ?? (!squareOk.has(l.id) ? 'Not updated because the Shopify update didn’t go through.' : null)));
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
    const change = [needSq && `Square ${p.S} → ${p.target}`, needSh && `Shopify ${p.H} → ${p.target}`].filter(Boolean).join(', ');
    note({ label: l.label, sku: l.sku, result: needSq && needSh ? 'updated_both' : needSq ? 'updated_square' : 'updated_shopify', note: `${change} (${p.why})` });
    await setLink(l.id, { baseline_quantity: p.target, last_square_quantity: p.target, last_shopify_quantity: p.target, status: 'in_sync', issue: null, last_synced_at: new Date(), last_change: `${change} (${p.why})` });
    if (needSq) await updateLocalSquareCopy(l.square_variation_id, sqLoc, p.target);
  }

  const status = tally.failed ? (tally.updated_square + tally.updated_shopify ? 'partial' : 'failed') : 'ok';
  const parts = [
    tally.updated_shopify && `${tally.updated_shopify} updated in Shopify`,
    tally.updated_square && `${tally.updated_square} updated in Square`,
    `${tally.unchanged} already matched`,
    tally.attention && `${tally.attention} need attention`,
    tally.failed && `${tally.failed} failed`,
    shopifyStale.size && `${shopifyStale.size} will retry`,
    skippedOff && `${skippedOff} skipped (Sync to Shopify off)`,
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
async function updateLocalSquareCopy(variationId: string, locationId: string, qty: number) {
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

/** Removes a pairing (the products themselves are untouched in both systems). It is matched again next sync only by SKU. */
export async function unlink(linkId: string) {
  await db().query('DELETE FROM inventory_sync_links WHERE id = $1', [linkId]);
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
  await db().query(
    `INSERT INTO inventory_sync_links(sku, match_method, label, square_variation_id, square_location_id, shopify_inventory_item_id, shopify_location_id)
     VALUES (NULL, 'manual', $1, $2, $3, $4, $5)`,
    [[p[0].itemName, p[0].variationName].filter(Boolean).join(' · '), p[0].variationId, sqLoc, i[0].inventoryItemId, shLoc],
  );
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
