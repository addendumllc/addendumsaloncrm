import type { SquareInventoryDTO, SquareInventorySyncStatus, ShopifyPushResult } from '@addendum/shared';
import { db } from '../db/index.js';
import { badRequest, IntegrationError } from '../lib/errors.js';
import { iso } from '../lib/time.js';
import { shopifyService, squareService } from '../integrations/registry.js';
import { getKV, setKV } from '../repos/settings.js';
import { recordPushedQuantities, shopifySyncOff } from './inventorySync.js';

/**
 * Retail inventory from Square (the source of truth). The Square catalog's retail variations and their
 * in-stock counts are copied into `square_inventory` so staff can search them instantly. Administrators can
 * push those counts to Shopify by hand; nothing is ever sent to Shopify automatically.
 */
const SYNC_KEY = 'square-inventory-sync';

/** Lowercase, with curly quotes and doubled apostrophes (18”, 18'') written as a plain inch mark (18"). */
const normalize = (v: string) => v.toLowerCase().replace(/[“”″]|''|’’/g, '"').replace(/[‘’′]/g, "'");

export async function inventorySyncStatus(): Promise<SquareInventorySyncStatus> {
  return (await getKV<SquareInventorySyncStatus>(SYNC_KEY)) ?? { lastSyncAt: null, status: 'never', message: null, products: 0 };
}

/** Re-reads the catalog and stock counts from Square. Never throws; the outcome is stored and returned. */
export async function syncSquareInventory(): Promise<SquareInventorySyncStatus> {
  const svc = await squareService();
  const save = async (s: SquareInventorySyncStatus) => (await setKV(SYNC_KEY, s), s);
  if (!svc) return save({ ...(await inventorySyncStatus()), status: 'failed', message: 'Square is not connected.' });
  try {
    const products = await svc.listProducts();
    let counts: Awaited<ReturnType<typeof svc.listInventoryCounts>> = [];
    let countMessage: string | null = null;
    try {
      counts = await svc.listInventoryCounts();
    } catch (e) {
      // Products still show without counts, e.g. when an OAuth connection predates the INVENTORY_READ permission.
      countMessage = e instanceof IntegrationError && e.authProblem
        ? 'Square didn’t allow reading stock counts. Reconnect Square in Settings to grant inventory access.'
        : 'Stock counts could not be loaded from Square right now.';
      console.warn('[square-inventory] counts failed:', e instanceof IntegrationError ? e.technical ?? e.userMessage : (e as Error).message);
    }
    const byVariation = new Map<string, Record<string, number>>();
    for (const c of counts) byVariation.set(c.variationId, { ...(byVariation.get(c.variationId) ?? {}), [c.locationId]: c.quantity });

    await db().tx(async (q) => {
      const keep: string[] = [];
      for (const p of products) {
        keep.push(p.variationId);
        const locs = byVariation.get(p.variationId);
        const total = locs ? Object.values(locs).reduce((a, n) => a + n, 0) : p.trackInventory && !countMessage ? 0 : null;
        const search = normalize([p.itemName, p.variationName, p.sku, p.upc].filter(Boolean).join(' '));
        await q.query(
          `INSERT INTO square_inventory(variation_id, item_id, item_name, variation_name, sku, upc, price_cents, track_inventory, quantity, quantities, search_text, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11, now())
           ON CONFLICT (variation_id) DO UPDATE SET item_id = $2, item_name = $3, variation_name = $4, sku = $5, upc = $6, price_cents = $7,
             track_inventory = $8, quantity = CASE WHEN $12 THEN square_inventory.quantity ELSE $9 END,
             quantities = CASE WHEN $12 THEN square_inventory.quantities ELSE $10::jsonb END, search_text = $11, updated_at = now()`,
          [p.variationId, p.itemId, p.itemName, p.variationName, p.sku, p.upc, p.priceCents, p.trackInventory, total, JSON.stringify(locs ?? {}), search, !!countMessage],
        );
      }
      // Products deleted or archived in Square disappear here too.
      await q.query('DELETE FROM square_inventory WHERE NOT (variation_id = ANY($1::text[]))', [keep]);
    });
    return save({ lastSyncAt: new Date().toISOString(), status: countMessage ? 'partial' : 'ok', message: countMessage, products: products.length });
  } catch (e) {
    const msg = e instanceof IntegrationError ? e.userMessage : 'Square inventory could not be loaded right now.';
    console.warn('[square-inventory] sync failed:', e instanceof IntegrationError ? e.technical ?? e.userMessage : (e as Error).message);
    return save({ ...(await inventorySyncStatus()), status: 'failed', message: msg });
  }
}

function toDTO(r: any): SquareInventoryDTO {
  return {
    variationId: r.variation_id,
    itemName: r.item_name,
    variationName: r.variation_name,
    sku: r.sku,
    upc: r.upc,
    priceCents: r.price_cents,
    trackInventory: r.track_inventory,
    quantity: r.quantity == null ? null : Number(r.quantity),
    shopify: { pushedAt: iso(r.shopify_pushed_at), pushedQuantity: r.shopify_pushed_quantity == null ? null : Number(r.shopify_pushed_quantity), error: r.shopify_push_error },
    shopifySync: { enabled: r.shopify_sync_enabled !== false, linked: r.link_status != null, linkStatus: r.link_status ?? null },
  };
}

/**
 * Search by product name, variation (size/colour), SKU or UPC. Every word must match somewhere, so
 * "weft 60" finds "Signature Hand-Tied Weft · 20" / #60 Platinum". Exact SKU/UPC matches come first.
 */
export async function searchSquareInventory(f: { q?: string; inStock?: boolean; orderable?: boolean; limit?: number }) {
  const words = normalize(f.q ?? '').split(/\s+/).filter(Boolean).slice(0, 8);
  const where: string[] = [];
  const p: unknown[] = [];
  for (const w of words) { p.push(`%${w.replace(/[%_\\]/g, (m) => `\\${m}`)}%`); where.push(`search_text LIKE $${p.length}`); }
  if (f.inStock) where.push('quantity > 0');
  // Order Hair: stocked products only (gift cards and other untracked items can't be ordered).
  if (f.orderable) where.push('track_inventory');
  p.push((f.q ?? '').trim().toLowerCase());
  const exact = `$${p.length}`;
  p.push(Math.min(f.limit ?? 100, 500));
  const rows = await db().query(
    `SELECT *, COALESCE((SELECT enabled FROM product_shopify_sync x WHERE x.square_variation_id = square_inventory.variation_id), true) AS shopify_sync_enabled,
            (SELECT status FROM inventory_sync_links l WHERE l.square_variation_id = square_inventory.variation_id) AS link_status
       FROM square_inventory ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (lower(COALESCE(sku,'')) = ${exact} OR COALESCE(upc,'') = ${exact}) DESC, lower(item_name), lower(COALESCE(variation_name,''))
      LIMIT $${p.length}`,
    p,
  );
  const total = await db().one<{ n: number }>(`SELECT count(*)::int n FROM square_inventory ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, p.slice(0, words.length));
  return { products: rows.map(toDTO), total: total?.n ?? 0 };
}

/**
 * Admin-only: sets Shopify's available stock to Square's count for the chosen variations, matched by SKU.
 * Setting an exact number (not adding/subtracting) means pushing twice can't double-count.
 */
export async function pushInventoryToShopify(variationIds: string[]): Promise<ShopifyPushResult> {
  if (!variationIds.length) throw badRequest('Choose at least one product to push.');
  const shop = shopifyService();
  if (!shop) throw badRequest("Shopify isn't connected yet. Add the Shopify settings on the server first.");
  const rows = await db().query<any>('SELECT * FROM square_inventory WHERE variation_id = ANY($1::text[])', [variationIds]);
  const result: ShopifyPushResult = { pushed: [], skipped: [], failed: [] };
  const label = (r: any) => [r.item_name, r.variation_name].filter(Boolean).join(' · ');
  const skip = (r: any, reason: string) => result.skipped.push({ variationId: r.variation_id, label: label(r), reason });

  const off = await shopifySyncOff();
  const ready = rows.filter((r) => {
    if (off.has(r.variation_id)) return skip(r, 'Sync to Shopify is off for this product.'), false;
    if (!r.sku) return skip(r, 'No SKU in Square, so it can’t be matched to Shopify.'), false;
    if (!r.track_inventory || r.quantity == null) return skip(r, 'Square isn’t tracking stock for this item.'), false;
    return true;
  });
  if (!ready.length) return result;

  const matches = await shop.findBySkus([...new Set(ready.map((r) => r.sku as string))]);
  const bySku = new Map<string, typeof matches>();
  for (const m of matches) bySku.set(m.sku.toLowerCase(), [...(bySku.get(m.sku.toLowerCase()) ?? []), m]);
  const toSet: { row: any; inventoryItemId: string; quantity: number }[] = [];
  for (const r of ready) {
    const found = bySku.get(r.sku.toLowerCase()) ?? [];
    if (!found.length) { skip(r, `No Shopify product has SKU ${r.sku}.`); continue; }
    if (found.length > 1) { skip(r, `${found.length} Shopify products share SKU ${r.sku}. Make SKUs unique in Shopify first.`); continue; }
    if (!found[0].tracked) { skip(r, `Shopify isn't tracking stock for ${found[0].label}.`); continue; }
    // Shopify counts whole units; Square can hold decimals for some items.
    toSet.push({ row: r, inventoryItemId: found[0].inventoryItemId, quantity: Math.max(0, Math.floor(Number(r.quantity))) });
  }

  const locationId = toSet.length ? await shop.locationId() : '';
  const pushId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  for (let i = 0; i < toSet.length; i += 50) {
    const batch = toSet.slice(i, i + 50);
    try {
      await shop.setAvailable(locationId, batch.map((b) => ({ inventoryItemId: b.inventoryItemId, quantity: b.quantity })), `addendum-push-${pushId}-${i / 50}`, `addendum-crm://square-inventory/push/${pushId}`);
      // Both systems now hold Square's count, so the two-way sync records it as their agreed quantity.
      await recordPushedQuantities(batch.map((b) => ({ inventoryItemId: b.inventoryItemId, quantity: b.quantity })));
      for (const b of batch) {
        await db().query('UPDATE square_inventory SET shopify_pushed_at = now(), shopify_pushed_quantity = $2, shopify_push_error = NULL WHERE variation_id = $1', [b.row.variation_id, b.quantity]);
        result.pushed.push({ variationId: b.row.variation_id, label: label(b.row), quantity: b.quantity });
      }
    } catch (e) {
      const msg = e instanceof IntegrationError ? e.userMessage : 'Shopify could not be updated. Try again.';
      console.warn('[shopify-push] failed:', e instanceof IntegrationError ? e.technical ?? e.userMessage : (e as Error).message);
      for (const b of batch) {
        await db().query('UPDATE square_inventory SET shopify_push_error = $2 WHERE variation_id = $1', [b.row.variation_id, msg]);
        result.failed.push({ variationId: b.row.variation_id, label: label(b.row), error: msg });
      }
    }
  }
  return result;
}
