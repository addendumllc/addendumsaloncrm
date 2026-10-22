import { productSearchText, productSearchWords, type ProductKind, type SquareInventoryDTO, SquareInventorySyncStatus, ShopifyPushResult } from '@addendum/shared';
import { db } from '../db/index.js';
import { badRequest, IntegrationError } from '../lib/errors.js';
import { iso } from '../lib/time.js';
import { shopifyService, squareName, squareService } from '../integrations/registry.js';
import { getKV, setKV } from '../repos/settings.js';
import { inactiveProducts, productKinds, recordPushedQuantities, shopifySyncOff } from './inventorySync.js';
import { forgetStockCache } from './stock.js';

/**
 * Retail inventory from Square (the source of truth). The Square catalog's retail variations and their
 * in-stock counts are copied into `square_inventory` so staff can search them instantly. Administrators can
 * push those counts to Shopify by hand; nothing is ever sent to Shopify automatically.
 */
const SYNC_KEY = 'square-inventory-sync';

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
        const search = productSearchText(p.itemName, p.variationName, p.sku, p.upc, ...(p.categories ?? []));
        await q.query(
          `INSERT INTO square_inventory(variation_id, item_id, item_name, variation_name, sku, upc, price_cents, track_inventory, quantity, quantities, search_text, image_url, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$13, now())
           ON CONFLICT (variation_id) DO UPDATE SET item_id = $2, item_name = $3, variation_name = $4, sku = $5, upc = $6, price_cents = $7,
             track_inventory = $8, quantity = CASE WHEN $12 THEN square_inventory.quantity ELSE $9 END,
             quantities = CASE WHEN $12 THEN square_inventory.quantities ELSE $10::jsonb END, search_text = $11, image_url = $13, updated_at = now()`,
          [p.variationId, p.itemId, p.itemName, p.variationName, p.sku, p.upc, p.priceCents, p.trackInventory, total, JSON.stringify(locs ?? {}), search, !!countMessage, p.imageUrl ?? null],
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

function toDTO(r: any, kinds: Map<string, ProductKind>, gone: Set<string>): SquareInventoryDTO {
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
    kind: kinds.get(r.variation_id) ?? null,
    imageUrl: r.image_url ?? null,
    discontinued: gone.has(r.variation_id),
  };
}

/**
 * Search by product name, variation (size/colour), SKU or UPC. Every word must match somewhere, so
 * "weft 60" finds "Signature Hand-Tied Weft · 20" / #60 Platinum". Exact SKU/UPC matches come first.
 */
export async function searchSquareInventory(f: { q?: string; inStock?: boolean; orderable?: boolean; limit?: number; kind?: ProductKind | 'unset' | 'products' | 'all' | 'discontinued' }) {
  const words = productSearchWords(f.q ?? '').slice(0, 8);
  const where: string[] = [];
  const p: unknown[] = [];
  for (const w of words) { p.push(`%${w.replace(/[%_\\]/g, (m) => `\\${m}`)}%`); where.push(`search_text LIKE $${p.length}`); }
  if (f.inStock) where.push('quantity > 0');
  // Order Hair: stocked products only (gift cards and other untracked items can't be ordered).
  if (f.orderable) where.push('track_inventory');
  // Type filter. "products" (the default list) is everything except add-on services.
  const kinds = await productKinds();
  const ofKind = (k: string) => [...kinds].filter(([, v]) => v === k).map(([id]) => id);
  const kind = f.kind === 'all' ? undefined : f.kind ?? 'products';
  // Discontinued products are hidden unless asked for.
  const gone = await inactiveProducts();
  if (kind === 'discontinued') { p.push([...gone]); where.push(`variation_id = ANY($${p.length}::text[])`); }
  else if (kind !== undefined) { p.push([...gone]); where.push(`NOT (variation_id = ANY($${p.length}::text[]))`); }
  if (kind === 'products') { p.push(ofKind('service')); where.push(`NOT (variation_id = ANY($${p.length}::text[]))`); }
  else if (kind === 'unset') { p.push([...kinds.keys()]); where.push(`NOT (variation_id = ANY($${p.length}::text[]))`); }
  else if (kind && kind !== 'discontinued') { p.push(ofKind(kind)); where.push(`variation_id = ANY($${p.length}::text[])`); }
  const filterCount = p.length;
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
  const total = await db().one<{ n: number }>(`SELECT count(*)::int n FROM square_inventory ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, p.slice(0, filterCount));
  return { products: rows.map((r) => toDTO(r, kinds, gone)), total: total?.n ?? 0 };
}

/**
 * Changes one product's SKU in Square (only its SKU). A SKU another Square product already uses is refused. A paired
 * product stays paired (the pairing is by product, not SKU); an unpaired one pairs at the next sync if a Shopify product
 * has the same SKU. Logged in Stock history.
 */
export async function setSquareSku(variationId: string, sku: string, staffId: string | null) {
  const next = sku.trim();
  if (!next) throw badRequest('Enter a SKU.');
  const sq = await squareService();
  if (!sq) throw badRequest(`${squareName()} isn’t connected.`);
  const products = await sq.listProducts();
  const p = products.find((x) => x.variationId === variationId);
  if (!p) throw badRequest(`That product wasn’t found in ${squareName()}. Refresh and try again.`);
  if (p.sku === next) return { sku: next, changed: false };
  const clash = products.find((x) => x.variationId !== variationId && (x.sku ?? '').trim().toLowerCase() === next.toLowerCase());
  if (clash) throw badRequest(`SKU ${next} is already used by ${[clash.itemName, clash.variationName].filter(Boolean).join(' · ')}.`);
  // A fresh key each time: reusing one makes Square return the earlier result without changing anything.
  await sq.setVariationSku(variationId, next, `sku-${variationId}-${Date.now().toString(36)}`);
  await db().query(`UPDATE square_inventory SET sku = $2, search_text = search_text || ' ' || lower($2), updated_at = now() WHERE variation_id = $1`, [variationId, next]);
  await db().query(`UPDATE inventory_sync_links SET sku = $2, updated_at = now() WHERE square_variation_id = $1`, [variationId, next]);
  const label = [p.itemName, p.variationName].filter(Boolean).join(' · ');
  await db().query(
    `INSERT INTO stock_txns(product_key, label, sku, kind, reason, old_sku, new_sku, staff_id) VALUES ($1,$2,$3,'sku',$4,$5,$3,$6)`,
    [variationId, label, next, `SKU changed in ${squareName()}`, p.sku ?? null, staffId],
  );
  forgetStockCache();
  return { sku: next, changed: true, previousSku: p.sku ?? null };
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
