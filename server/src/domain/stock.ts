import { productSearchWords } from '@addendum/shared';
import type {
  ProductAnalyticsDTO, PurchaseOrderDTO, PurchaseOrderStatus, SupplierDTO, StockApplyResultDTO, StockChangeInput, StockForecastDTO, StockForecastResponse, StockForecastSettings,
  StockProductDTO, StockProductStatus, StockTxnDTO, StockTxnKind, SupplierAssign, SupplierInput,
} from '@addendum/shared';
import { db } from '../db/index.js';
import { badRequest, IntegrationError, notFound } from '../lib/errors.js';
import { iso } from '../lib/time.js';
import { shopify2Name, shopifyService, shopifyService2, squareService, storeNames } from '../integrations/registry.js';
import { ShopifyStaleQuantityError, type ShopifyInventoryEntry } from '../integrations/shopify/ShopifyService.js';
import type { SquareProductVariation } from '../integrations/square/types.js';
import { getKV, getSettings, setKV } from '../repos/settings.js';
import { linkByIds, productKinds, squareLocation, updateLocalSquareCopy } from './inventorySync.js';
import { localDate } from './rebookingSchedule.js';

/**
 * Inventory tools from Addendum-Stockline, built on the Square ↔ Shopify sync: one product list across both stores,
 * editing SKUs and stock in both at once (by table, by pasted lines or by spreadsheet), stock counts and adjustments
 * with a reason, a stock history, sales-based forecasts and purchase orders. Ordering details (supplier, cost, lead
 * time, MOQ) stay in the CRM.
 */

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const shopKey = (inventoryItemId: string) => `shopify:${inventoryItemId}`;

interface Live {
  products: SquareProductVariation[];
  squareQty: Map<string, number>;
  sqLoc: string | null;
  items: ShopifyInventoryEntry[];
  shLoc: string | null;
  /** The second Shopify store (same stock, same SKUs). */
  items2: ShopifyInventoryEntry[];
  sh2Loc: string | null;
  links: any[];
  rows: StockProductDTO[];
}

let cache: { at: number; live: Live } | null = null;
export const forgetStockCache = () => { cache = null; };

/** Both stores read now (or from the last 30 seconds), joined into one product list. */
async function live(fresh = false): Promise<Live> {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.live;
  const sq = await squareService();
  const shop = shopifyService();
  const [sqLoc, shLoc] = await Promise.all([sq ? squareLocation(sq) : null, shop ? shop.locationId() : null]);
  const shop2 = shopifyService2();
  const sh2Loc = shop2 ? await shop2.locationId().catch(() => null) : null;
  const [products, counts, items, items2] = await Promise.all([
    sq ? sq.listProducts() : [], sq ? sq.listInventoryCounts() : [], shop && shLoc ? shop.listInventory(shLoc) : [],
    shop2 && sh2Loc ? shop2.listInventory(sh2Loc).catch(() => [] as ShopifyInventoryEntry[]) : ([] as ShopifyInventoryEntry[]),
  ]);
  const store2BySku = new Map<string, StockProductDTO['store2']>();
  for (const i of items2) {
    if (!norm(i.sku) || !i.tracked) continue;
    store2BySku.set(norm(i.sku), [...(store2BySku.get(norm(i.sku)) ?? []), { inventoryItemId: i.inventoryItemId, label: i.label, qty: i.available }]);
  }
  const squareQty = new Map<string, number>();
  for (const c of counts) if (c.locationId === sqLoc) squareQty.set(c.variationId, (squareQty.get(c.variationId) ?? 0) + c.quantity);
  const links = await db().query<any>('SELECT * FROM inventory_sync_links');
  const settings = new Map((await db().query<any>('SELECT * FROM stock_products')).map((r) => [r.product_key as string, r]));
  const kinds = await productKinds();
  const linkBySq = new Map(links.map((l) => [l.square_variation_id as string, l]));
  const itemById = new Map(items.map((i) => [i.inventoryItemId, i]));
  const linkedItems = new Set(links.map((l) => l.shopify_inventory_item_id as string));
  const withSettings = (r: Omit<StockProductDTO, 'supplier' | 'costCents' | 'leadTimeDays' | 'safetyDays' | 'moq' | 'caseSize' | 'status' | 'store2' | 'kind'>): StockProductDTO => {
    const s = settings.get(r.key);
    const kind = r.squareVariationId ? kinds.get(r.squareVariationId) ?? null : null;
    return {
      ...r, kind, store2: store2BySku.get(norm(r.squareSku) || norm(r.shopifySku)) ?? [], supplier: s?.supplier ?? null, costCents: s?.cost_cents ?? null, leadTimeDays: s?.lead_time_days ?? null, safetyDays: s?.safety_days ?? null,
      moq: s?.moq ?? null, caseSize: s?.case_size ?? null, status: (s?.status ?? 'active') as StockProductStatus,
      shippingDays: s?.shipping_days ?? null, supplierSku: s?.supplier_sku ?? null, orderNote: s?.order_note ?? null, collection: s?.collection ?? null,
      // The purchasing collection (when set) comes first, so search and grouping use it.
      collections: s?.collection ? [s.collection, ...r.collections.filter((c) => c !== s.collection)] : r.collections,
    };
  };
  // Several listings in the main Shopify store can share a SKU (e.g. a PRO listing): they're one product with one stock.
  // The paired (or first) listing is the product; the others follow it and aren't listed on their own.
  const siblingsOf = new Map<string, StockProductDTO['store2']>();
  const siblingIds = new Set<string>();
  const groups = new Map<string, ShopifyInventoryEntry[]>();
  for (const i of items) if (i.tracked && norm(i.sku)) groups.set(norm(i.sku), [...(groups.get(norm(i.sku)) ?? []), i]);
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const primary = list.find((i) => linkedItems.has(i.inventoryItemId)) ?? [...list].sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId))[0];
    const others = list.filter((i) => i !== primary && !linkedItems.has(i.inventoryItemId));
    if (!others.length) continue;
    siblingsOf.set(primary.inventoryItemId, others.map((i) => ({ inventoryItemId: i.inventoryItemId, label: i.label, qty: i.available })));
    for (const i of others) siblingIds.add(i.inventoryItemId);
  }
  const rows: StockProductDTO[] = [];
  for (const p of products) {
    const l = linkBySq.get(p.variationId);
    const i = l ? itemById.get(l.shopify_inventory_item_id) : undefined;
    if ((!p.trackInventory && !l) || kinds.get(p.variationId) === 'service') continue; // add-on services have no stock
    rows.push(withSettings({
      key: p.variationId, label: l?.label ?? [p.itemName, p.variationName].filter(Boolean).join(' · '),
      sku: p.sku ?? i?.sku ?? null, squareSku: p.sku ?? null, shopifySku: i?.sku ?? null,
      squareVariationId: p.variationId, shopifyInventoryItemId: i?.inventoryItemId ?? null, linkId: l?.id ?? null,
      squareQty: p.trackInventory ? Math.floor(squareQty.get(p.variationId) ?? 0) : null, shopifyQty: i?.available ?? null, priceCents: p.priceCents,
      siblings: i ? siblingsOf.get(i.inventoryItemId) ?? [] : [],
      collections: [...new Set([...(p.categories ?? []), ...(i?.collections ?? [])])],
      collectionRefs: i?.collectionRefs ?? [],
      imageUrl: p.imageUrl ?? i?.imageUrl ?? null,
    }));
  }
  for (const i of items) {
    if (linkedItems.has(i.inventoryItemId) || !i.tracked || siblingIds.has(i.inventoryItemId)) continue;
    rows.push(withSettings({
      key: shopKey(i.inventoryItemId), label: i.label, sku: i.sku, squareSku: null, shopifySku: i.sku,
      squareVariationId: null, shopifyInventoryItemId: i.inventoryItemId, linkId: null, squareQty: null, shopifyQty: i.available, priceCents: null,
      siblings: siblingsOf.get(i.inventoryItemId) ?? [],
      collections: i.collections ?? [],
      collectionRefs: i.collectionRefs ?? [],
      imageUrl: i.imageUrl ?? null,
    }));
  }
  rows.sort((a, b) => a.label.localeCompare(b.label));
  const out: Live = { products, squareQty, sqLoc, items, shLoc, items2, sh2Loc, links, rows };
  cache = { at: Date.now(), live: out };
  return out;
}

// ---------------- Lead times (Suppliers → Lead times) ----------------
export interface LeadRuleDTO { id: string; supplier: string; ref: string; label: string; productionDays: number; shippingDays: number | null; active: boolean; notes: string | null }
const ruleDTO = (r: any): LeadRuleDTO => ({ id: r.id, supplier: r.supplier, ref: r.ref, label: r.label, productionDays: r.production_days, shippingDays: r.shipping_days ?? null, active: r.active, notes: r.notes ?? null });
type LeadSource = StockForecastDTO['leadSource'];

/**
 * Works out each product's lead time, in this order: the product's own production time; else its supplier's active
 * collection rules for any collection it's in (the longest by default — Forecast settings can say shortest); else the
 * supplier's default; else nothing (flagged as missing — never a silent 0 or guess). Shipping: the product's own, the
 * chosen collection rule's, the supplier's, else none. A supplier whose lead time isn't tracked has none.
 */
export async function leadResolver(conflict: 'longest' | 'shortest' = 'longest') {
  const sups = new Map((await db().query<any>('SELECT * FROM suppliers')).map((x) => [x.name as string, x]));
  const rules = new Map<string, LeadRuleDTO[]>();
  for (const r of (await db().query<any>('SELECT * FROM supplier_lead_rules WHERE active')).map(ruleDTO)) rules.set(r.supplier, [...(rules.get(r.supplier) ?? []), r]);
  const fallback = await defaultSupplier();
  return (p: Pick<StockProductDTO, 'supplier' | 'leadTimeDays' | 'shippingDays' | 'collection' | 'collections' | 'collectionRefs'>) => {
    const name = p.supplier ?? fallback ?? '';
    const sup = sups.get(name);
    if (sup?.lead_untracked) return { production: 0, shipping: 0, source: { kind: 'untracked', label: name } as LeadSource };
    const refs = new Set([...(p.collectionRefs ?? []).map((c) => `shopify:${c.id}`), ...(p.collection ? [`internal:${p.collection}`] : []), ...(p.collections ?? []).map((c) => `name:${c}`)]);
    const hit = (rules.get(name) ?? []).filter((r) => refs.has(r.ref))
      .sort((a, b) => (conflict === 'shortest' ? a.productionDays - b.productionDays : b.productionDays - a.productionDays))[0];
    let production: number | null; let source: LeadSource;
    if (p.leadTimeDays != null) { production = p.leadTimeDays; source = { kind: 'product', label: null }; }
    else if (hit) { production = hit.productionDays; source = { kind: 'collection', label: hit.label }; }
    else if (sup?.lead_time_days != null) { production = sup.lead_time_days; source = { kind: 'supplier', label: name }; }
    else { production = null; source = { kind: 'missing', label: null }; }
    const shipping = p.shippingDays ?? (source.kind === 'collection' ? hit!.shippingDays : null) ?? sup?.shipping_days ?? 0;
    return { production, shipping, source };
  };
}

/**
 * Suppliers → Lead times: the supplier's default, its collection rules, its products with their own times, the
 * collections to choose from (Shopify's by id, the salon's inventory collections, other store collections by name), and
 * which of its products have no lead time at all.
 */
export async function leadTimesFor(supplier: string) {
  const sup = await db().one<any>('SELECT * FROM suppliers WHERE name = $1', [supplier]);
  if (!sup) throw notFound('That supplier');
  const rows = (await live()).rows.filter((r) => r.status !== 'not_tracked');
  const fallback = await defaultSupplier();
  const mine = rows.filter((r) => (r.supplier ?? fallback) === supplier);
  const resolve = await leadResolver((await forecastSettings()).collectionLeadConflict ?? 'longest');
  const options = new Map<string, string>();
  for (const r of rows) for (const c of r.collectionRefs ?? []) options.set(`shopify:${c.id}`, `${c.title} (Shopify)`);
  for (const c of (await internalCollections()).collections) options.set(`internal:${c.name}`, `${c.name} (inventory collection)`);
  for (const r of rows) for (const c of r.collections) if (![...options.values()].some((v) => v.startsWith(`${c} (`))) options.set(`name:${c}`, c);
  return {
    supplier: { name: sup.name, leadTimeDays: sup.lead_time_days ?? null, shippingDays: sup.shipping_days ?? null, leadUntracked: !!sup.lead_untracked },
    rules: await leadRules(supplier),
    products: mine.map((r) => ({ key: r.key, label: r.label, sku: r.sku, collection: r.collection ?? null, leadTimeDays: r.leadTimeDays, shippingDays: r.shippingDays ?? null, source: resolve(r).source })),
    collections: [...options].map(([ref, label]) => ({ ref, label })).sort((a, b) => a.label.localeCompare(b.label)),
  };
}

/** A supplier's default lead and shipping times (nothing else about it changes). */
export async function setSupplierLeadDefault(name: string, leadTimeDays: number | null, shippingDays: number | null) {
  const r = await db().query('UPDATE suppliers SET lead_time_days = $2, shipping_days = $3, updated_at = now() WHERE name = $1 RETURNING name', [name, leadTimeDays, shippingDays]);
  if (!r.length) throw notFound('That supplier');
  forgetStockCache();
}

export async function leadRules(supplier: string) {
  return (await db().query<any>('SELECT * FROM supplier_lead_rules WHERE supplier = $1 ORDER BY lower(label)', [supplier])).map(ruleDTO);
}
/** Adds or changes a collection rule (one per collection per supplier). */
export async function saveLeadRule(r: { id?: string; supplier: string; ref: string; label: string; productionDays: number; shippingDays: number | null; active: boolean; notes: string | null }) {
  if (!/^(shopify|internal|name):.+/.test(r.ref)) throw badRequest('Choose a collection.');
  const clash = await db().one<{ id: string }>('SELECT id FROM supplier_lead_rules WHERE supplier = $1 AND ref = $2 AND id::text <> $3', [r.supplier, r.ref, r.id ?? '']);
  if (clash) throw badRequest(`${r.supplier} already has a lead time for ${r.label}. Edit that one instead.`);
  if (r.id) {
    const done = await db().query('UPDATE supplier_lead_rules SET ref = $2, label = $3, production_days = $4, shipping_days = $5, active = $6, notes = $7, updated_at = now() WHERE id = $1 RETURNING id',
      [r.id, r.ref, r.label, r.productionDays, r.shippingDays, r.active, r.notes]);
    if (!done.length) throw notFound('That lead time');
  } else {
    await db().query('INSERT INTO supplier_lead_rules(supplier, ref, label, production_days, shipping_days, active, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [r.supplier, r.ref, r.label, r.productionDays, r.shippingDays, r.active, r.notes]);
  }
  forgetStockCache();
}
export async function deleteLeadRule(id: string) {
  await db().query('DELETE FROM supplier_lead_rules WHERE id = $1', [id]);
  forgetStockCache();
}

// ---------------- Internal collections (Inventory → Products → Collections) ----------------
/**
 * The salon's own collections for inventory (e.g. K-Tips, Tapes, 18" Redefined), separate from the stores'
 * storefront collections — set on each product as its purchasing collection. Changing them never touches Shopify or
 * Square. The list keeps their order; each product is in at most one.
 */
const COLLECTIONS_KEY = 'stock.collections';
export async function internalCollections() {
  const names = (await getKV<string[]>(COLLECTIONS_KEY)) ?? [];
  const counts = new Map((await db().query<{ c: string; n: number }>(`SELECT collection AS c, count(*)::int AS n FROM stock_products WHERE collection IS NOT NULL GROUP BY 1`)).map((r) => [r.c, r.n]));
  // Collections set on products before the list existed are kept in it.
  const all = [...names, ...[...counts.keys()].filter((c) => !names.includes(c)).sort((a, b) => a.localeCompare(b))];
  const tracked = (await live().catch(() => null))?.rows.filter((r) => r.status !== 'not_tracked') ?? [];
  return { collections: all.map((name) => ({ name, products: counts.get(name) ?? 0 })), withoutCollection: tracked.filter((r) => !r.collection).length };
}
export async function saveCollectionList(names: string[]) {
  await setKV(COLLECTIONS_KEY, [...new Set(names.map((n) => n.trim()).filter(Boolean))]);
}
/** Renames a collection on every product in it (null = removes it from them). */
export async function renameCollection(from: string, to: string | null, staffId: string | null) {
  const target = to?.trim() || null;
  await db().query('UPDATE stock_products SET collection = $2, updated_by_staff_id = $3, updated_at = now() WHERE collection = $1', [from, target, staffId]);
  const list = (await getKV<string[]>(COLLECTIONS_KEY)) ?? [];
  await saveCollectionList(target ? list.map((n) => (n === from ? target : n)) : list.filter((n) => n !== from));
  forgetStockCache();
}
/**
 * Puts products into a collection: chosen ones, or those matching a rule — in a store collection, a word in the name,
 * or a SKU start (e.g. "18-" + "CI"). `onlyWithout` skips products already in a collection. `preview` changes nothing.
 */
export async function assignCollection(a: { collection: string | null; keys?: string[]; storeCollection?: string; nameContains?: string; skuStarts?: string; skuContains?: string; onlyWithout?: boolean; preview?: boolean }, staffId: string | null) {
  const rows = (await live()).rows.filter((r) => r.status !== 'not_tracked');
  const words = (a.nameContains ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const hit = rows.filter((r) => (a.keys ? a.keys.includes(r.key) : true)
    && (!a.storeCollection || r.collections.includes(a.storeCollection))
    && words.every((w) => r.label.toLowerCase().includes(w))
    && (!a.skuStarts || norm(r.sku).startsWith(a.skuStarts.trim().toLowerCase()))
    && (!a.skuContains || norm(r.sku).includes(a.skuContains.trim().toLowerCase()))
    && (!a.onlyWithout || !r.collection)
    && (a.keys || a.storeCollection || words.length || a.skuStarts || a.skuContains));
  if (a.preview) return { count: hit.length, sample: hit.slice(0, 8).map((r) => r.label) };
  const name = a.collection?.trim() || null;
  if (hit.length) {
    await db().query(
      `INSERT INTO stock_products(product_key, collection, updated_by_staff_id) SELECT k, $2, $3 FROM unnest($1::text[]) k
       ON CONFLICT (product_key) DO UPDATE SET collection = $2, updated_by_staff_id = $3, updated_at = now()`, [hit.map((r) => r.key), name, staffId]);
  }
  if (name) { const list = (await getKV<string[]>(COLLECTIONS_KEY)) ?? []; if (!list.includes(name)) await saveCollectionList([...list, name]); }
  forgetStockCache();
  return { count: hit.length, sample: [] as string[] };
}

/** The products as listed now (for other parts of the CRM, e.g. Purchases & Transactions). */
export const stockRows = async () => (await live()).rows;

export async function stockProducts() {
  const l = await live();
  const sq = await squareService();
  return { products: l.rows, square: !!sq, shopify: !!shopifyService(), store2: shopifyService2() ? shopify2Name() : null };
}

/** Ordering details for products (CRM only). */
export async function saveProductSettings(rows: { key: string; supplier?: string | null; costCents?: number | null; leadTimeDays?: number | null; safetyDays?: number | null; moq?: number | null; caseSize?: number | null; status?: StockProductStatus;
  shippingDays?: number | null; supplierSku?: string | null; orderNote?: string | null; collection?: string | null }[], staffId: string | null) {
  await db().tx(async (q) => {
    for (const r of rows) {
      const cur = await q.query<any>('SELECT * FROM stock_products WHERE product_key = $1', [r.key]);
      const c = cur[0] ?? {};
      const pick = <T>(v: T | undefined, old: T) => (v === undefined ? old : v);
      await q.query(
        `INSERT INTO stock_products(product_key, supplier, cost_cents, lead_time_days, safety_days, moq, case_size, status, updated_by_staff_id, shipping_days, supplier_sku, order_note, collection)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (product_key) DO UPDATE SET supplier = $2, cost_cents = $3, lead_time_days = $4, safety_days = $5, moq = $6, case_size = $7, status = $8,
           updated_by_staff_id = $9, shipping_days = $10, supplier_sku = $11, order_note = $12, collection = $13, updated_at = now()`,
        [r.key, pick(r.supplier, c.supplier ?? null)?.trim() || null, pick(r.costCents, c.cost_cents ?? null), pick(r.leadTimeDays, c.lead_time_days ?? null),
          pick(r.safetyDays, c.safety_days ?? null), pick(r.moq, c.moq ?? null), pick(r.caseSize, c.case_size ?? null), pick(r.status, c.status ?? 'active'), staffId,
          pick(r.shippingDays, c.shipping_days ?? null), pick(r.supplierSku, c.supplier_sku ?? null)?.trim() || null, pick(r.orderNote, c.order_note ?? null)?.trim() || null,
          pick(r.collection, c.collection ?? null)?.trim() || null]);
        // A new supplier named on a product gets its row (so it can be picked, merged and given defaults).
        const sup = pick(r.supplier, c.supplier ?? null)?.trim();
        if (sup) await q.query('INSERT INTO suppliers(name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [sup]);
    }
  });
  forgetStockCache();
}

/**
 * Applies SKU and stock changes to Square and Shopify together (one read of both stores, then batched writes), and
 * logs each one. A count sets both stores to that number; +/− moves each store by that amount. Shopify's count is
 * compare-and-set, so a sale that lands meanwhile is never overwritten (that batch is refused; read again and retry).
 */
export async function applyStockChanges(changes: StockChangeInput[], opts: { kind: StockTxnKind; reason?: string | null; note?: string | null; staffId: string | null; reference?: string | null; only?: 'square' | 'shopify' }): Promise<StockApplyResultDTO> {
  if (!changes.length) throw badRequest('Nothing to change.');
  const sq = await squareService();
  const shop = shopifyService();
  const L = await live(true);
  const byKey = new Map(L.rows.map((r) => [r.key, r]));
  const results: StockApplyResultDTO['results'] = [];
  const readAt = new Date(Date.now() - 1000).toISOString();

  // Check everything first: unknown products, bad numbers, SKUs already used by another product.
  const planned: { row: StockProductDTO; sku: string | null; pairWith: StockProductDTO | null; sq: number | null; sh: number | null }[] = [];
  const newSkus = new Map<string, string>();
  for (const c of changes) {
    const row = byKey.get(c.key);
    if (!row) throw badRequest(`A product wasn’t found in Square or Shopify (${c.key}). Refresh and try again.`);
    let sku = c.sku != null ? c.sku.trim() : null;
    let pairWith: StockProductDTO | null = null;
    if (sku != null) {
      // A SKU must be unique in Square (it's how products pair). In Shopify several listings may share one (e.g. a PRO
      // listing of the same hair): they become one product with one stock. Giving a Square-only product the SKU of a
      // Shopify-only product (or the other way round) isn't a clash: it pairs them, so they sync from then on.
      const s = sku;
      const sameStore = L.rows.find((r) => r.key !== row.key && row.squareVariationId && r.squareVariationId && norm(r.squareSku) === norm(s));
      const twin = !sameStore ? L.rows.find((r) => r.key !== row.key && !r.linkId && !row.linkId
        && ((!row.shopifyInventoryItemId && !r.squareVariationId && norm(r.shopifySku) === norm(s)) || (!row.squareVariationId && !r.shopifyInventoryItemId && norm(r.squareSku) === norm(s)))) : undefined;
      const dup = newSkus.get(norm(s));
      const dupRow = dup && dup !== row.key ? byKey.get(dup) : undefined;
      const problem = !s ? 'enter a SKU' : sameStore ? `SKU ${s} is already used by ${sameStore.label} in Square` : dupRow?.squareVariationId && row.squareVariationId ? `SKU ${s} is given to two Square products in this change` : null;
      if (problem) {
        results.push({ key: row.key, label: row.label, ok: false, note: `SKU not changed: ${problem}.` });
        sku = null;
      } else {
        newSkus.set(norm(s), row.key);
        pairWith = twin ?? null;
      }
      if (sku == null && c.quantity == null && c.delta == null && c.onlineQuantity == null) continue;
    }
    let sqQ: number | null = null;
    let shQ: number | null = null;
    const separate = row.kind === 'separate';
    if (c.onlineQuantity != null && !separate) throw badRequest(`${row.label} shares one count across the stores — set its count, not a separate online count.`);
    if (c.quantity != null || c.delta != null || c.onlineQuantity != null) {
      if (c.quantity != null && (!Number.isInteger(c.quantity) || c.quantity < 0)) throw badRequest(`Stock for ${row.label} must be a whole number, 0 or more.`);
      if (c.delta != null && !Number.isInteger(c.delta)) throw badRequest(`The change for ${row.label} must be a whole number.`);
      if (row.squareQty != null && (c.quantity != null || c.delta != null)) sqQ = c.quantity ?? row.squareQty + (c.delta ?? 0);
      // Separate stock: the count/adjustment is the salon floor's (Square); the online count is set on its own.
      if (separate) { if (row.shopifyQty != null && c.onlineQuantity != null) shQ = c.onlineQuantity; }
      else if (row.shopifyQty != null) shQ = c.quantity ?? row.shopifyQty + (c.delta ?? 0);
      // One store only (a purchase order for the salon or for online): the other side is left for the sync to settle.
      if (opts.only === 'square') shQ = null;
      if (opts.only === 'shopify') sqQ = null;
      if ((sqQ ?? 0) < 0 || (shQ ?? 0) < 0) throw badRequest(`That would take ${row.label} below 0.`);
    }
    planned.push({ row, sku, pairWith, sq: sqQ, sh: shQ });
  }

  // SKUs (one product at a time; each store keeps its own).
  for (const p of planned) {
    if (p.sku == null) continue;
    const notes: string[] = [];
    try {
      if (p.row.squareVariationId && p.row.squareSku !== p.sku) {
        if (!sq) throw badRequest('Square isn’t connected.');
        // A fresh key each time: reusing one makes Square return the earlier result without changing anything.
        await sq.setVariationSku(p.row.squareVariationId, p.sku, `sku-${p.row.squareVariationId}-${Date.now().toString(36)}`);
        await db().query(`UPDATE square_inventory SET sku = $2, search_text = search_text || ' ' || lower($2), updated_at = now() WHERE variation_id = $1`, [p.row.squareVariationId, p.sku]);
        notes.push('Square');
      }
      if (p.row.shopifyInventoryItemId && p.row.shopifySku !== p.sku) {
        if (!shop) throw badRequest('Shopify isn’t connected.');
        await shop.setSku(p.row.shopifyInventoryItemId, p.sku);
        notes.push('Shopify');
      }
      // Every listing of the old SKU in the second store (duplicates included) gets the new one.
      if (p.row.store2.length) {
        const shop2 = shopifyService2();
        if (!shop2) throw badRequest(`${shopify2Name()} isn’t connected.`);
        for (const e of p.row.store2) await shop2.setSku(e.inventoryItemId, p.sku);
        notes.push(`${shopify2Name()}${p.row.store2.length > 1 ? ` (${p.row.store2.length} listings)` : ''}`);
      }
      if (p.row.linkId) await db().query(`UPDATE inventory_sync_links SET sku = $2, match_method = 'sku', updated_at = now() WHERE id = $1`, [p.row.linkId, p.sku]);
      if (p.pairWith) {
        // Same SKU in both stores now: pair them (the next sync settles their stock).
        const sqId = p.row.squareVariationId ?? p.pairWith.squareVariationId!;
        const shId = p.row.shopifyInventoryItemId ?? p.pairWith.shopifyInventoryItemId!;
        try {
          await linkByIds(sqId, shId);
          await db().query(`UPDATE inventory_sync_links SET sku = $2, match_method = 'sku', updated_at = now() WHERE square_variation_id = $1`, [sqId, p.sku]);
          notes.push(`paired with ${p.pairWith.squareVariationId ? 'Square' : 'Shopify'}’s ${p.pairWith.label}`);
        } catch (e) {
          notes.push(`not paired yet (${msg(e)}) — the next sync pairs them by SKU`);
        }
      }
      if (notes.length) {
        await log(p.row, { kind: 'sku', reason: opts.reason ?? 'SKU change', note: opts.note ?? null, staffId: opts.staffId, reference: opts.reference ?? null, oldSku: p.row.sku, newSku: p.sku });
        results.push({ key: p.row.key, label: p.row.label, ok: true, note: `SKU ${p.row.sku ?? '—'} → ${p.sku} (${notes.join(' and ')})` });
      }
    } catch (e) {
      results.push({ key: p.row.key, label: p.row.label, ok: false, note: `SKU not changed: ${msg(e)}${notes.length ? ` (it was already changed in ${notes.join(' and ')})` : ''}` });
    }
  }

  // Stock: Shopify first (compare-and-set), then Square, each in one batch.
  const qty = planned.filter((p) => (p.sq != null && p.sq !== p.row.squareQty) || (p.sh != null && p.sh !== p.row.shopifyQty));
  const key = `stock-${opts.kind}-${Date.now()}`;
  let shopifyOk = true;
  let shopifyErr = '';
  const sibNeed = (p: (typeof planned)[number]) => (p.sh == null ? [] : (p.row.siblings ?? []).filter((x) => x.qty != null && x.qty !== p.sh));
  const shWrites = qty.filter((p) => p.sh != null && (p.sh !== p.row.shopifyQty || sibNeed(p).length));
  if (shWrites.length) {
    try {
      if (!shop || !L.shLoc) throw badRequest('Shopify isn’t connected.');
      // Listings sharing the SKU (e.g. PRO) get the same count, in the same compare-and-set request.
      await shop.setAvailable(L.shLoc, shWrites.flatMap((p) => [
        ...(p.sh !== p.row.shopifyQty ? [{ inventoryItemId: p.row.shopifyInventoryItemId!, quantity: p.sh!, changeFromQuantity: p.row.shopifyQty }] : []),
        ...sibNeed(p).map((x) => ({ inventoryItemId: x.inventoryItemId, quantity: p.sh!, changeFromQuantity: x.qty })),
      ]), key, `addendum-crm://stock/${opts.kind}`);
      for (const p of shWrites) for (const x of p.row.siblings ?? []) await markSibling(x.inventoryItemId, p.row.sku, x.label, p.sh!);
    } catch (e) {
      shopifyOk = false;
      shopifyErr = e instanceof ShopifyStaleQuantityError ? 'Shopify’s count changed just now (a sale?). Nothing was changed — look again and retry.' : msg(e);
    }
  }
  if (!shopifyOk) {
    for (const p of qty) results.push({ key: p.row.key, label: p.row.label, ok: false, note: `Stock not changed: ${shopifyErr}` });
    forgetStockCache();
    return { changed: results.filter((r) => r.ok).length, results };
  }
  const sqWrites = qty.filter((p) => p.sq != null && p.sq !== p.row.squareQty);
  let squareErr = '';
  if (sqWrites.length) {
    try {
      if (!sq || !L.sqLoc) throw badRequest('Square isn’t connected.');
      await sq.setInventoryCounts(sqWrites.map((p) => ({ variationId: p.row.squareVariationId!, locationId: L.sqLoc!, quantity: p.sq!, occurredAt: readAt, referenceId: `addendum-${opts.kind}` })), key);
      for (const p of sqWrites) await updateLocalSquareCopy(p.row.squareVariationId!, L.sqLoc!, p.sq!);
    } catch (e) {
      squareErr = msg(e);
    }
  }
  // The second store's listings with that SKU get the same count (compare-and-set; its sync baseline follows).
  const store2Err = new Map<string, string>();
  const shop2 = shopifyService2();
  for (const p of planned) {
    // The second store shares the online stock: for separate-stock products it follows the online count, not the salon's.
    const v = p.row.kind === 'separate' ? p.sh : p.sq ?? p.sh;
    if (v == null || !p.row.store2.length || opts.only === 'square') continue;
    if (!qty.includes(p) && p.row.store2.every((e) => e.qty === v)) continue;
    const need = p.row.store2.filter((e) => e.qty !== v && e.qty != null);
    try {
      if (!shop2 || !L.sh2Loc) throw badRequest(`${shopify2Name()} isn’t connected.`);
      if (need.length) await shop2.setAvailable(L.sh2Loc, need.map((e) => ({ inventoryItemId: e.inventoryItemId, quantity: v, changeFromQuantity: e.qty })), `${key}-2-${p.row.key}`, `addendum-crm://stock/${opts.kind}`);
      for (const e of p.row.store2) {
        await db().query(
          `INSERT INTO inventory_sync_extra(inventory_item_id, store, sku, label, synced_baseline) VALUES ($1,'shopify2',$2,$3,$4)
           ON CONFLICT (inventory_item_id) DO UPDATE SET synced_baseline = $4, updated_at = now()`, [e.inventoryItemId, p.row.sku, e.label, v]);
      }
      // A Shopify-only product syncs between the two stores; its main-store count when last set follows too.
      if ((p.row.kind === 'separate' || (!p.row.linkId && !p.row.squareVariationId)) && p.row.shopifyInventoryItemId) {
        await db().query(
          `INSERT INTO inventory_sync_extra(inventory_item_id, store, sku, label, synced_baseline) VALUES ($1,'shopify1',$2,$3,$4)
           ON CONFLICT (inventory_item_id) DO UPDATE SET synced_baseline = $4, updated_at = now()`, [p.row.shopifyInventoryItemId, p.row.sku, p.row.label, v]);
      }
      if (!qty.includes(p) && need.length) qty.push(p);
    } catch (e) {
      store2Err.set(p.row.key, e instanceof ShopifyStaleQuantityError ? `${shopify2Name()}’s count changed just now — the next sync settles it` : msg(e));
    }
  }
  for (const p of qty) {
    const sqDone = p.sq != null && p.sq !== p.row.squareQty && !squareErr;
    const shDone = p.sh != null && p.sh !== p.row.shopifyQty;
    const sqAfter = sqDone ? p.sq : p.row.squareQty;
    const shAfter = shDone ? p.sh : p.row.shopifyQty;
    // The sync's baseline follows, so it doesn't treat this as a change to copy across.
    // One store only: the agreed count stays, so the next sync sees this as a change and carries it to the other store.
    if (p.row.linkId && !opts.only) {
      const l = L.links.find((x) => x.id === p.row.linkId);
      const delta = changes.find((c) => c.key === p.row.key)?.delta;
      const same = sqAfter != null && sqAfter === shAfter;
      const baseline = same ? sqAfter : delta != null && l?.baseline_quantity != null ? l.baseline_quantity + delta : l?.baseline_quantity ?? null;
      await db().query(
        `UPDATE inventory_sync_links SET baseline_quantity = $2, last_square_quantity = $3, last_shopify_quantity = $4, status = CASE WHEN $5 THEN 'in_sync' ELSE status END,
           issue = CASE WHEN $5 THEN NULL ELSE issue END, last_synced_at = now(), last_change = $6, updated_at = now() WHERE id = $1`,
        [p.row.linkId, baseline, sqAfter, shAfter, same, `${labelOf(opts.kind)}${opts.reason ? ` (${opts.reason})` : ''}: Square ${p.row.squareQty ?? '—'} → ${sqAfter ?? '—'}, Shopify ${p.row.shopifyQty ?? '—'} → ${shAfter ?? '—'}`]);
    }
    if (sqDone || shDone) {
      await log(p.row, { kind: opts.kind, reason: opts.reason ?? null, note: opts.note ?? null, staffId: opts.staffId, reference: opts.reference ?? null, squareAfter: sqAfter, shopifyAfter: shAfter });
    }
    const v2 = p.row.kind === 'separate' ? p.sh : p.sq ?? p.sh;
    const parts = [p.sq != null && p.sq !== p.row.squareQty && (squareErr ? `Square not changed (${squareErr})` : `Square ${p.row.squareQty} → ${p.sq}`), shDone && `Shopify ${p.row.shopifyQty} → ${p.sh}`,
      p.row.store2.length > 0 && (store2Err.has(p.row.key) ? `${shopify2Name()} not changed (${store2Err.get(p.row.key)})` : p.row.store2.some((e) => e.qty !== v2) && `${shopify2Name()} ${p.row.store2.map((e) => e.qty ?? '—').join('/')} → ${v2}`)].filter(Boolean);
    results.push({ key: p.row.key, label: p.row.label, ok: !(squareErr && p.sq != null && p.sq !== p.row.squareQty), note: parts.join(', ') });
  }
  forgetStockCache();
  return { changed: results.filter((r) => r.ok).length, results };
}

const labelOf = (k: StockTxnKind) => ({ count: 'Stock count', adjust: 'Adjusted', import: 'Updated from a list', receive: 'Received', sku: 'SKU changed', sync: 'Sync' })[k];
const msg = (e: unknown) => (e instanceof IntegrationError ? e.userMessage : (e as { userMessage?: string; message?: string })?.userMessage ?? (e as Error)?.message ?? 'It didn’t go through.');

async function log(row: StockProductDTO, x: { kind: StockTxnKind; reason: string | null; note: string | null; staffId: string | null; reference: string | null; squareAfter?: number | null; shopifyAfter?: number | null; oldSku?: string | null; newSku?: string | null }) {
  await db().query(
    `INSERT INTO stock_txns(product_key, label, sku, kind, reason, note, square_before, square_after, shopify_before, shopify_after, old_sku, new_sku, staff_id, reference)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [row.key, row.label, x.newSku ?? row.sku, x.kind, x.reason, x.note, x.kind === 'sku' ? null : row.squareQty, x.squareAfter ?? null, x.kind === 'sku' ? null : row.shopifyQty, x.shopifyAfter ?? null,
      x.oldSku ?? null, x.newSku ?? null, x.staffId, x.reference]);
}

/** Stock history: newest first, filtered by product, kind, text or dates. */
export async function stockHistory(f: { key?: string; kind?: string; q?: string; from?: string; to?: string; limit?: number }): Promise<StockTxnDTO[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
  if (f.key) add('t.product_key = ?', f.key);
  if (f.kind) add('t.kind = ?', f.kind);
  if (f.q) add(`(lower(t.label) || ' ' || lower(coalesce(t.sku, '')) || ' ' || lower(coalesce(t.reason, '')) || ' ' || lower(coalesce(t.note, ''))) LIKE ?`, `%${f.q.toLowerCase()}%`);
  if (f.from) add('t.created_at >= ?::date', f.from);
  if (f.to) add(`t.created_at < (?::date + 1)`, f.to);
  const rows = await db().query<any>(
    `SELECT t.*, s.name AS staff_name FROM stock_txns t LEFT JOIN staff s ON s.id = t.staff_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY t.created_at DESC LIMIT ${Math.min(2000, f.limit ?? 500)}`, args);
  const n = (v: unknown) => (v == null ? null : Number(v));
  return rows.map((r) => ({
    id: r.id, productKey: r.product_key, label: r.label, sku: r.sku, kind: r.kind, reason: r.reason, note: r.note,
    squareBefore: n(r.square_before), squareAfter: n(r.square_after), shopifyBefore: n(r.shopify_before), shopifyAfter: n(r.shopify_after),
    oldSku: r.old_sku, newSku: r.new_sku, staffName: r.staff_name ?? null, reference: r.reference, createdAt: iso(r.created_at)!,
  }));
}

// ---------------- Sales and forecasts ----------------
const SALES_KEY = 'stock.shopify-sales';
const FORECAST_KEY = 'stock.forecast-settings';
export const DEFAULT_FORECAST: StockForecastSettings = { leadTimeDays: 30, safetyDays: 14, coverageDays: 60, slowToUseDays: 120, soonDays: 7, watchDays: 21, defaultMoq: 0, discontinuedCollections: ['Classic'] };

/**
 * What a product is counted in, from its name: "Prosecco Redefined Weft · 18\" Weft" → weft(s), "Black Magic Clip-Ins" →
 * clip-ins; "units" when the name doesn't say.
 */
export function unitNoun(label: string, n: number) {
  // Hair first, wherever it's named ("Signature Hand-Tied Weft · 22\" / #60 Platinum" → wefts).
  const hair = label.match(/\b(weft|clip-ins?|tape-ins?|extensions?|bundles?|ponytails?|toppers?|wigs?|[ik]-tips?)\b/i)?.[1].toLowerCase();
  if (hair) return n === 1 ? hair.replace(/s$/, '') : hair.endsWith('s') ? hair : `${hair}s`;
  const part = label.split(/\s+[·]\s+|\s+[-–]\s+/).reverse().find((x) => /[a-z]{3,}/i.test(x.replace(/\d+(\.\d+)?\s*("|”|inch(es)?|in|g|oz|ml)\b/gi, ''))) ?? '';
  const word = part.replace(/\d+(\.\d+)?\s*("|”|inch(es)?|in|g|oz|ml)?/gi, '').trim().split(/\s+/).pop()?.toLowerCase() ?? '';
  if (!/^[a-z][a-z-]{2,}$/.test(word)) return n === 1 ? 'unit' : 'units';
  if (n === 1) return word.replace(/(?<=[^s])s$/, '');
  return word.endsWith('s') ? word : `${word}s`;
}

/** A practical order amount: small amounts stay as they are; then up to the next 5 (7 → 10, 23 → 25), 10 from 100, 50 from 500. */
export function practicalQty(n: number) {
  if (n <= 3) return Math.max(0, Math.ceil(n));
  const step = n >= 500 ? 50 : n >= 100 ? 10 : 5;
  return Math.ceil(n / step) * step;
}

export async function forecastSettings(): Promise<StockForecastSettings> {
  return { ...DEFAULT_FORECAST, ...((await getKV<StockForecastSettings>(FORECAST_KEY)) ?? {}) };
}
export async function setForecastSettings(s: StockForecastSettings) {
  await setKV(FORECAST_KEY, s);
}

let salesRefresh: Promise<void> | null = null;
/** Brings Shopify's order lines up to date (in the background; at most one at a time). */
export function refreshShopifySales(force = false): Promise<void> {
  if (salesRefresh) return salesRefresh;
  salesRefresh = (async () => {
    // Each Shopify store's orders (the main store, and a second store sharing the same stock).
    const stores = [
      { id: 'shopify', name: 'Shopify', svc: shopifyService(), key: SALES_KEY },
      { id: 'shopify2', name: shopify2Name(), svc: shopifyService2(), key: `${SALES_KEY}-2` },
    ];
    for (const st of stores) {
      if (!st.svc) continue;
      const state = (await getKV<{ updatedAt: string | null; note: string | null }>(st.key)) ?? { updatedAt: null, note: null };
      if (!force && state.updatedAt && Date.now() - Date.parse(state.updatedAt) < 6 * 3600_000) continue;
      const since = state.updatedAt ? new Date(Date.parse(state.updatedAt) - 3600_000) : new Date(Date.now() - 400 * 86400_000);
      const startedAt = new Date().toISOString();
      try {
        const lines = await st.svc.listOrderLines(since);
        for (let i = 0; i < lines.length; i += 200) {
          await db().tx(async (q) => {
            for (const l of lines.slice(i, i + 200)) {
              await q.query(
                `INSERT INTO shopify_order_lines(store, order_id, line_id, inventory_item_id, sku, quantity, ordered_at, cancelled, unit_price_cents, title) VALUES ($9,$1,$2,$3,$4,$5,$6,$7,$8,$10)
                 ON CONFLICT (store, order_id, line_id) DO UPDATE SET inventory_item_id = $3, sku = $4, quantity = $5, ordered_at = $6, cancelled = $7, unit_price_cents = $8, title = COALESCE($10, shopify_order_lines.title)`,
                [l.orderId, l.lineId, l.inventoryItemId, l.sku, l.quantity, l.orderedAt, l.cancelled, l.unitPriceCents, st.id, l.title ?? null]);
            }
          });
        }
        await setKV(st.key, { updatedAt: startedAt, note: null });
      } catch (e) {
        const scope = e instanceof IntegrationError && e.authProblem;
        await setKV(st.key, { updatedAt: state.updatedAt, note: scope ? `${st.name} sales aren’t included: its Shopify app needs the read_orders permission (and read_all_orders for more than 60 days).` : `${st.name} sales couldn’t be read this time (${msg(e)}).` });
      }
    }
  })().finally(() => { salesRefresh = null; });
  return salesRefresh;
}

/** Problems reading Shopify sales, if any (one note per store). */
async function salesNotes() {
  const a = await getKV<{ note: string | null }>(SALES_KEY);
  const b = shopifyService2() ? await getKV<{ note: string | null }>(`${SALES_KEY}-2`) : null;
  return [a?.note, b?.note].filter(Boolean).join(' ') || null;
}

/** Units sold per product per day (salon time), Square and Shopify together, for the last `days` days. */
async function salesByDay(days: number, keyOfItem: Map<string, string>) {
  const tz = (await getSettings()).business.timezone;
  const out = new Map<string, Map<string, number>>();
  const add = (key: string, d: string, n: number) => {
    const m = out.get(key) ?? new Map<string, number>();
    m.set(d, (m.get(d) ?? 0) + n);
    out.set(key, m);
  };
  const sq = await db().query<any>(
    `SELECT li->>'catalog_object_id' AS id, to_char(o.closed_at AT TIME ZONE $2, 'YYYY-MM-DD') AS d, sum((li->>'quantity')::numeric) AS n
       FROM commission_orders o, jsonb_array_elements(coalesce(o.raw->'line_items', '[]'::jsonb)) li
      WHERE o.state = 'COMPLETED' AND o.closed_at >= now() - ($1 || ' days')::interval AND li->>'catalog_object_id' IS NOT NULL
      GROUP BY 1, 2`, [String(days), tz]);
  for (const r of sq) add(r.id, r.d, Number(r.n));
  const back = await db().query<any>(
    `SELECT rl->>'catalog_object_id' AS id, to_char(o.closed_at AT TIME ZONE $2, 'YYYY-MM-DD') AS d, sum((rl->>'quantity')::numeric) AS n
       FROM commission_orders o, jsonb_array_elements(coalesce(o.raw->'returns', '[]'::jsonb)) rt, jsonb_array_elements(coalesce(rt->'return_line_items', '[]'::jsonb)) rl
      WHERE o.state = 'COMPLETED' AND o.closed_at >= now() - ($1 || ' days')::interval AND rl->>'catalog_object_id' IS NOT NULL
      GROUP BY 1, 2`, [String(days), tz]);
  for (const r of back) add(r.id, r.d, -Number(r.n));
  const sh = await db().query<any>(
    `SELECT inventory_item_id AS id, to_char(ordered_at AT TIME ZONE $2, 'YYYY-MM-DD') AS d, sum(quantity) AS n FROM shopify_order_lines
      WHERE NOT cancelled AND inventory_item_id IS NOT NULL AND ordered_at >= now() - ($1 || ' days')::interval GROUP BY 1, 2`, [String(days), tz]);
  for (const r of sh) {
    const key = keyOfItem.get(r.id);
    if (key) add(key, r.d, Number(r.n));
  }
  return { out, today: localDate(new Date(), tz) };
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** What to order, how much and by when, for every active product, with the reasoning. */
export async function stockForecast(): Promise<StockForecastResponse> {
  void refreshShopifySales();
  const L = await live();
  const settings = await forecastSettings();
  const keyOfItem = new Map<string, string>();
  for (const r of L.rows) {
    if (r.shopifyInventoryItemId) keyOfItem.set(r.shopifyInventoryItemId, r.key);
    for (const e of r.store2) keyOfItem.set(e.inventoryItemId, r.key);
  }
  const { out: sales, today } = await salesByDay(120, keyOfItem);
  const incoming = new Map((await db().query<any>(
    `SELECT l.product_key, sum(l.quantity - l.received)::int AS n FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id
      WHERE p.status IN ('ordered','shipped') GROUP BY 1`)).map((r) => [r.product_key as string, Number(r.n)]));
  const firstSale = (m: Map<string, number> | undefined) => (m && m.size ? [...m.keys()].sort()[0] : null);
  const units = (m: Map<string, number> | undefined, days: number) => {
    if (!m) return 0;
    const from = addDays(today, -days);
    let n = 0;
    for (const [d, v] of m) if (d > from && d <= today) n += v;
    return Math.max(0, n);
  };
  const items: StockForecastDTO[] = [];
  // Each product's supplier (products without one follow the default): lead time tracked or not, usual lead time,
  // shipping days and default minimum order.
  const supRows = new Map((await db().query<any>('SELECT * FROM suppliers')).map((x) => [x.name as string, x]));
  const resolveLead = await leadResolver(settings.collectionLeadConflict ?? 'longest');
  const untracked = new Set([...supRows.values()].filter((x) => x.lead_untracked).map((x) => x.name as string));
  const fallback = await defaultSupplier();
  // Skipped products (To order → Skip): not suggested or alerted until the date passes.
  const skips = new Map((await db().query<any>(`SELECT product_key, to_char(skip_until, 'YYYY-MM-DD') AS u FROM stock_products WHERE skip_until >= $1::date`, [today])).map((x) => [x.product_key as string, x.u as string]));
  const goneWords = settings.discontinuedCollections.map((w) => w.trim()).filter(Boolean);
  const discontinuedWord = (r: (typeof L.rows)[number]) => goneWords.find((w) => {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return (r.collections ?? []).some((c) => re.test(c)) || re.test(r.label);
  }) ?? null;
  // One line per SKU: hair comes from one supplier for the whole CRM, so a product listed in Square and online without
  // being paired (the same SKU twice) is forecast and ordered once — its stock, sales and what's on order added together.
  const stockOf = (r: (typeof L.rows)[number]) => Math.max(0, r.squareQty ?? r.shopifyQty ?? 0);
  // Below zero in Shopify = pre-orders: customers waiting for units that aren't in stock yet.
  const preordersOf = (r: (typeof L.rows)[number]) => Math.max(0, -(r.shopifyQty ?? 0), ...r.store2.map((e) => -(e.qty ?? 0)));
  const bySku = new Map<string, (typeof L.rows)[number][]>();
  for (const r of L.rows) if (r.status !== 'not_tracked' && norm(r.sku)) bySku.set(norm(r.sku), [...(bySku.get(norm(r.sku)) ?? []), r]);
  const mergedInto = new Set<string>();
  const group = new Map<string, (typeof L.rows)[number][]>(); // primary key → every row of that SKU
  for (const list of bySku.values()) {
    if (list.length < 2) continue;
    const primary = list.find((x) => x.squareVariationId && x.shopifyInventoryItemId) ?? list.find((x) => x.squareVariationId) ?? list[0];
    group.set(primary.key, list);
    for (const o of list) {
      if (o === primary) continue;
      mergedInto.add(o.key);
      const from = sales.get(o.key);
      if (from) { const into = sales.get(primary.key) ?? new Map<string, number>(); for (const [d, v] of from) into.set(d, (into.get(d) ?? 0) + v); sales.set(primary.key, into); }
      incoming.set(primary.key, (incoming.get(primary.key) ?? 0) + (incoming.get(o.key) ?? 0));
    }
  }
  for (const r of L.rows) {
    if (r.status === 'not_tracked' || mergedInto.has(r.key)) continue;
    const all = group.get(r.key) ?? [r];
    const m = sales.get(r.key);
    const stock = all.reduce((n, x) => n + stockOf(x), 0);
    const preorders = Math.max(...all.map(preordersOf));
    const inc = incoming.get(r.key) ?? 0;
    const u7 = units(m, 7), u30 = units(m, 30), u90 = units(m, 90);
    // A newer product's 90-day rate uses only the days since its first sale.
    const first = firstSale(m);
    const since = first ? Math.max(7, Math.min(90, Math.round((Date.parse(today) - Date.parse(first)) / 86400_000) + 1)) : 90;
    const rate = 0.2 * (u7 / 7) + 0.5 * (u30 / 30) + 0.3 * (u90 / since);
    const sup = supRows.get(r.supplier ?? fallback ?? '');
    const noLead = untracked.has(r.supplier ?? fallback ?? '');
    // Each product's own timing: its production lead time and transit days, else its supplier's defaults.
    // Lead time: the product's own, a collection rule, the supplier's default — or missing (flagged; the forecast default
    // stands in until one is set, so reorder timing still shows).
    const res = resolveLead({ ...r, supplier: r.supplier ?? all.find((x) => x.supplier)?.supplier ?? null });
    const shipping = noLead ? 0 : res.shipping;
    const production = noLead ? 0 : res.production ?? settings.leadTimeDays;
    const lead = production + shipping;
    // Minimum order: the product's own, else its supplier's default, else the overall default (Forecast settings).
    const moq: number | null = r.moq ?? sup?.default_moq ?? (settings.defaultMoq || null);
    const moqFrom = r.moq != null ? '' : sup?.default_moq != null ? `${sup.name}’s default` : 'the default minimum order';
    const safety = r.safetyDays ?? settings.safetyDays;
    const why: string[] = [];
    let status: StockForecastDTO['status'];
    let orderBy: string | null = null;
    let suggested = 0;
    const daysOfStock = rate > 0 ? (stock + inc) / rate : null;
    // Discontinued: set on the product, or in a discontinued collection (Forecast settings, e.g. Classic).
    const goneWith = discontinuedWord(r);
    const discontinued = r.status === 'discontinued' || !!goneWith;
    if (res.source.kind === 'missing' && !discontinued) why.push(`No lead time set for this product, its collections or its supplier — using the ${settings.leadTimeDays}-day default until one is set (Suppliers → Lead times).`);
    if (discontinued) {
      status = 'discontinued';
      why.push(goneWith ? `In a discontinued collection (${goneWith}): no reorders.` : 'Discontinued: no reorders.');
    } else if (rate <= 0) {
      status = stock <= 0 ? 'out' : 'no_sales';
      why.push('No sales in the last 90 days.');
    } else {
      const cover = rate * (lead + safety);
      const daysUntil = Math.floor((stock + inc - cover) / rate);
      orderBy = addDays(today, daysUntil);
      status = stock <= 0 ? 'out' : daysUntil <= 0 ? 'order_now' : daysUntil <= settings.soonDays ? 'soon' : daysUntil <= settings.watchDays ? 'watch' : 'healthy';
      why.push(`Selling about ${rate.toFixed(2)} a day (${u7} in 7 days, ${u30} in 30, ${u90} in 90).`);
      why.push(`${stock} in stock${inc ? ` + ${inc} on order` : ''} lasts about ${Math.round(daysOfStock!)} days.`);
      if (res.source.kind === 'collection') why.push(`Production lead time from the ${res.source.label} rule.`);
      if (shipping) why.push(`Lead time includes ${shipping} days of shipping.`);
      why.push(noLead ? `Lead time not tracked for ${r.supplier ?? fallback} · ${safety} days of safety stock = order when it’s down to ${Math.ceil(cover)}.` : `Lead time ${lead} days + ${safety} days of safety stock = order when it’s down to ${Math.ceil(cover)}.`);
      if (status !== 'healthy' && status !== 'watch') {
        const need = rate * (lead + settings.coverageDays + safety) - (stock + inc);
        suggested = Math.max(0, Math.ceil(need));
        why.push(`Order enough for ${settings.coverageDays} days after it arrives, plus safety stock: ${suggested}.`);
      }
    }
    // Pre-orders are owed to customers: always order at least enough to fill them (on top of what's on order).
    if (preorders > 0 && !discontinued) {
      const owed = Math.max(0, preorders - inc);
      if (owed > 0) {
        status = 'out';
        // Stock above was counted as 0, so the pre-orders come on top of what keeps it in stock.
        suggested += owed;
      }
      why.push(`${preorders} ${unitNoun(r.label, preorders)} pre-ordered${inc ? `, ${Math.min(inc, preorders)} covered by what's on order` : ''}.`);
    }
    // Any order: a practical amount, then at least the minimum order, then full cases.
    if (suggested > 0) {
      const practical = practicalQty(suggested);
      if (practical !== suggested) { why.push(`Rounded up to ${practical}.`); suggested = practical; }
      if (moq && suggested < moq) { suggested = moq; why.push(`Raised to the minimum order (${moq}${moqFrom ? `, ${moqFrom}` : ''}).`); }
      if (r.caseSize && suggested % r.caseSize) { suggested = Math.ceil(suggested / r.caseSize) * r.caseSize; why.push(`Rounded up to full cases of ${r.caseSize}.`); }
    }
    // MOQ timing: the minimum order's cost, when it lands if ordered today, and how long it lasts at this rate.
    const moqLastsDays = moq && rate > 0 ? Math.round(moq / rate) : null;
    if (moqLastsDays != null && moqLastsDays > settings.slowToUseDays) why.push(`Slow to use: the minimum order of ${moq} lasts about ${moqLastsDays} days.`);
    // Runs out before an order placed today would arrive (what's on order counts as stock).
    const skippedUntil = skips.get(r.key) ?? null;
    if (skippedUntil) { suggested = 0; why.push(skippedUntil === '9999-12-31' ? 'Skipped — not being ordered (until turned back on).' : `Skipped — not being ordered until ${skippedUntil}.`); }
    const stockoutRisk = !discontinued && !skippedUntil && rate > 0 && stock > 0 && daysOfStock != null && daysOfStock < lead;
    if (stockoutRisk) why.push(`Stock-out risk: about ${Math.round(daysOfStock!)} days of stock, but an order takes ${lead} days to arrive.`);
    items.push({
      key: r.key, label: r.label, sku: r.sku, supplier: r.supplier ?? all.find((x) => x.supplier)?.supplier ?? null, collections: [...new Set(all.flatMap((x) => x.collections ?? []))], collection: all.find((x) => x.collection)?.collection ?? null, stock, incoming: inc, ratePerDay: Math.round(rate * 100) / 100, units7: u7, units30: u30, units90: u90,
      leadTimeDays: lead, productionDays: production, leadSource: res.source, leadUntracked: noLead, shippingDays: shipping, stockoutRisk, skippedUntil, safetyDays: safety, daysOfStock: daysOfStock == null ? null : Math.round(daysOfStock), orderBy, status, suggestedQty: suggested,
      moq, caseSize: r.caseSize, costCents: r.costCents,
      moqCostCents: moq && r.costCents != null ? moq * r.costCents : null, moqArrivesOn: moq ? addDays(today, lead) : null, moqLastsDays,
      slowToUse: moqLastsDays != null && moqLastsDays > settings.slowToUseDays, why, preorders,
      // Inventory → To order: which stores sell it, and the day it runs out at this rate (not counting what's on order).
      stores: { salon: all.some((x) => !!x.squareVariationId), online: all.some((x) => !!x.shopifyInventoryItemId || x.store2.length > 0) },
      sellOutOn: stock <= 0 ? today : rate > 0 ? addDays(today, Math.floor(stock / rate)) : null,
    });
  }
  const order: StockForecastDTO['status'][] = ['out', 'order_now', 'soon', 'watch', 'healthy', 'no_sales', 'discontinued'];
  items.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || (a.orderBy ?? '9').localeCompare(b.orderBy ?? '9') || a.label.localeCompare(b.label));
  const state = await getKV<{ updatedAt: string | null; note: string | null }>(SALES_KEY);
  const notes = await salesNotes();
  return {
    items, settings,
    salesFrom: { square: !!(await squareService()), shopify: !!shopifyService() && !state?.note, shopifyNote: notes, shopifyUpdatedAt: state?.updatedAt ?? null },
  };
}

// ---------------- Purchase orders ----------------
async function poDTOs(where = '', args: unknown[] = []): Promise<PurchaseOrderDTO[]> {
  const pos = await db().query<any>(
    // Dates as text: a DATE read as a JS Date can shift a day with the server's time zone.
    `SELECT p.*, to_char(p.expected_on, 'YYYY-MM-DD') AS expected_on, s.name AS created_by_name FROM purchase_orders p LEFT JOIN staff s ON s.id = p.created_by_staff_id ${where} ORDER BY p.created_at DESC LIMIT 300`, args);
  if (!pos.length) return [];
  const lines = await db().query<any>(`SELECT *, to_char(expected_on, 'YYYY-MM-DD') AS expected_on FROM purchase_order_lines WHERE po_id = ANY($1::uuid[]) ORDER BY label`, [pos.map((p) => p.id)]);
  return pos.map((p) => {
    const mine = lines.filter((l) => l.po_id === p.id).map((l) => ({
      id: l.id, productKey: l.product_key, label: l.label, sku: l.sku, quantity: l.quantity, received: l.received, costCents: l.cost_cents,
      leadTimeDays: l.lead_time_days ?? null, expectedOn: l.expected_on ? localDateOnly(l.expected_on) : null, lotNote: l.lot_note ?? null, supplier: l.supplier ?? null,
    }));
    return {
      id: p.id, number: p.number, name: p.name ?? null, lotNumber: p.lot_number ?? null, store: p.store === 'shopify' ? 'shopify' as const : 'salon' as const, supplier: p.supplier, status: p.status, expectedOn: p.expected_on ? localDateOnly(p.expected_on) : null, note: p.note,
      createdAt: iso(p.created_at)!, orderedAt: iso(p.ordered_at), receivedAt: iso(p.received_at), createdByName: p.created_by_name ?? null,
      lines: mine, totalCents: mine.reduce((a, l) => a + (l.costCents ?? 0) * l.quantity, 0),
    };
  });
}
const localDateOnly = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);

export const listPurchaseOrders = () => poDTOs();
async function onePO(id: string) {
  const [p] = await poDTOs('WHERE p.id = $1', [id]);
  if (!p) throw notFound('That purchase order');
  return p;
}

type PoLineInput = { productKey: string; quantity: number; costCents?: number | null; leadTimeDays?: number | null };
async function lineRows(lines: PoLineInput[]) {
  const L = await live();
  const byKey = new Map(L.rows.map((r) => [r.key, r]));
  // Each item's supplier: its lead time (+ shipping) unless one is entered; none when its lead time isn't tracked.
  const fallback = await defaultSupplier();
  const resolveLead = await leadResolver((await forecastSettings()).collectionLeadConflict ?? 'longest');
  // The same lead time as To order (product, collection rule, supplier); none when untracked or missing.
  const leadFor = (r: StockProductDTO) => { const x = resolveLead(r); return x.source.kind === 'untracked' || x.production == null ? null : x.production + x.shipping; };
  return lines.map((l) => {
    const r = byKey.get(l.productKey);
    if (!r) throw badRequest('A product on this order wasn’t found. Refresh and try again.');
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw badRequest(`Enter how many of ${r.label} to order.`);
    // Its own lead time: as entered, else the product's (which comes from its supplier when not set).
    return { key: r.key, label: r.label, sku: r.sku, quantity: l.quantity, cost: l.costCents ?? r.costCents, lead: l.leadTimeDays === undefined ? leadFor(r) : l.leadTimeDays, supplier: r.supplier ?? fallback };
  });
}
const LINE_INSERT = 'INSERT INTO purchase_order_lines(po_id, product_key, label, sku, quantity, cost_cents, lead_time_days, supplier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)';

/**
 * When an order is placed: each item's expected date is today (salon time) + its own lead time, and the order's expected
 * date (if not entered) is the last of those.
 */
async function setArrivalDates(q: { query: (sql: string, args: unknown[]) => Promise<unknown> }, poId: string) {
  const today = localDate(new Date(), (await getSettings()).business.timezone);
  await q.query(`UPDATE purchase_order_lines SET expected_on = $2::date + lead_time_days WHERE po_id = $1 AND lead_time_days IS NOT NULL AND expected_on IS NULL`, [poId, today]);
  await q.query(`UPDATE purchase_orders SET expected_on = COALESCE(expected_on, (SELECT max(expected_on) FROM purchase_order_lines WHERE po_id = $1)) WHERE id = $1`, [poId]);
}

/** Changes one item's lead time (a draft) or its expected date (once ordered); the order's date follows the latest item. */
/**
 * Edits one item: quantity, cost, lead time (draft) or expected date (ordered) — while the order is open — and its lot
 * number / note at any time (lot numbers often arrive with the delivery). A quantity can't go below what's been received.
 */
export async function updatePoLine(poId: string, lineId: string, b: { leadTimeDays?: number | null; expectedOn?: string | null; quantity?: number; costCents?: number | null; lotNote?: string | null }) {
  const p = await onePO(poId);
  const line = p.lines.find((l) => l.id === lineId);
  if (!line) throw notFound('That item');
  const closed = p.status === 'received' || p.status === 'cancelled';
  const onlyNote = b.leadTimeDays === undefined && b.expectedOn === undefined && b.quantity === undefined && b.costCents === undefined;
  if (closed && !onlyNote) throw badRequest('This order is closed — only lot numbers and notes can still be changed.');
  if (b.quantity !== undefined && b.quantity < Math.max(1, line.received)) throw badRequest(line.received ? `${line.label}: ${line.received} already received, so the quantity can’t be lower.` : 'Enter a quantity of 1 or more.');
  await db().tx(async (q) => {
    if (b.quantity !== undefined) await q.query('UPDATE purchase_order_lines SET quantity = $3 WHERE id = $2 AND po_id = $1', [poId, lineId, b.quantity]);
    if (b.costCents !== undefined) await q.query('UPDATE purchase_order_lines SET cost_cents = $3 WHERE id = $2 AND po_id = $1', [poId, lineId, b.costCents]);
    if (b.lotNote !== undefined) await q.query('UPDATE purchase_order_lines SET lot_note = $3 WHERE id = $2 AND po_id = $1', [poId, lineId, b.lotNote?.trim() || null]);
    if (b.leadTimeDays !== undefined) {
      await q.query(`UPDATE purchase_order_lines SET lead_time_days = $3, expected_on = CASE WHEN $4::date IS NULL OR $3::int IS NULL THEN expected_on ELSE $4::date + $3::int END WHERE id = $2 AND po_id = $1`,
        [poId, lineId, b.leadTimeDays, p.orderedAt ? localDate(new Date(p.orderedAt), (await getSettings()).business.timezone) : null]);
    }
    if (b.expectedOn !== undefined) await q.query('UPDATE purchase_order_lines SET expected_on = $3 WHERE id = $2 AND po_id = $1', [poId, lineId, b.expectedOn]);
    if (p.status !== 'draft' && !closed && (b.leadTimeDays !== undefined || b.expectedOn !== undefined)) {
      await q.query(`UPDATE purchase_orders SET expected_on = (SELECT max(expected_on) FROM purchase_order_lines WHERE po_id = $1), updated_at = now() WHERE id = $1`, [poId]);
    }
  });
  return onePO(poId);
}

/** Adds products to an open order (draft or placed). On a placed order, each new item's expected date follows its lead time. */
export async function addPoLines(poId: string, lines: PoLineInput[]) {
  const p = await onePO(poId);
  if (p.status === 'received' || p.status === 'cancelled') throw badRequest('This order is closed.');
  const rows = await lineRows(lines);
  await db().tx(async (q) => {
    for (const r of rows) await q.query(LINE_INSERT, [poId, r.key, r.label, r.sku, r.quantity, r.cost, r.lead, r.supplier]);
    if (p.status !== 'draft') await setArrivalDates(q, poId);
  });
  return onePO(poId);
}

/** Removes an item from an open order — not once any of it has been received. */
export async function removePoLine(poId: string, lineId: string) {
  const p = await onePO(poId);
  if (p.status === 'received' || p.status === 'cancelled') throw badRequest('This order is closed.');
  const line = p.lines.find((l) => l.id === lineId);
  if (!line) throw notFound('That item');
  if (line.received > 0) throw badRequest(`${line.label}: ${line.received} already received, so it can’t be removed. Lower the quantity instead.`);
  if (p.lines.length === 1) throw badRequest('An order needs at least one item. Cancel or delete the order instead.');
  await db().query('DELETE FROM purchase_order_lines WHERE id = $2 AND po_id = $1', [poId, lineId]);
  return onePO(poId);
}

/**
 * New draft purchase orders: one per supplier and store. Without a store (e.g. from Reorder), products in Square go on salon
 * orders and online-only products on online (Shopify) orders.
 */
/** Several suppliers on one order are listed together: "AH - 18in + AH - 22in". */
export const joinSuppliers = (names: string[]) => [...new Set(names.map((n) => n.trim()).filter(Boolean))].join(' + ') || null;

/**
 * Makes draft orders: one per store and supplier — or, given `suppliers` (several, e.g. one company's product lines with
 * different lead times), one order for all of them. Each item keeps its own supplier and lead time either way.
 */
export async function createPurchaseOrders(lines: PoLineInput[], staffId: string | null, supplier?: string | null, store?: 'salon' | 'shopify', suppliers?: string[], name?: string | null) {
  if (!lines.length) throw badRequest('Add at least one product.');
  const rows = await lineRows(lines);
  const L = await live();
  const fallback = await defaultSupplier();
  const together = suppliers && suppliers.length ? joinSuppliers(suppliers) : null;
  const supplierOf = (k: string) => together ?? supplier ?? L.rows.find((r) => r.key === k)?.supplier ?? fallback;
  const storeOf = (k: string): 'salon' | 'shopify' => store ?? (L.rows.find((r) => r.key === k)?.squareVariationId ? 'salon' : 'shopify');
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${storeOf(r.key)}|${supplierOf(r.key) ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const ids: string[] = [];
  for (const [key, g] of groups) {
    const [poStore, s] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
    const id = await db().tx(async (q) => {
      const [p] = await q.query<{ id: string }>('INSERT INTO purchase_orders(supplier, created_by_staff_id, store, name) VALUES ($1,$2,$3,$4) RETURNING id', [s || null, staffId, poStore, name?.trim() || null]);
      for (const r of g) await q.query(LINE_INSERT, [p.id, r.key, r.label, r.sku, r.quantity, r.cost, r.lead, r.supplier]);
      return p.id;
    });
    ids.push(id);
  }
  return Promise.all(ids.map(onePO));
}

/** The most specific collection of each product (the one with the fewest products), as To order groups them. */
function collectionOfEach(items: StockForecastDTO[]) {
  const size = new Map<string, number>();
  for (const i of items) for (const c of i.collections) size.set(c, (size.get(c) ?? 0) + 1);
  // A purchasing collection set on the product wins; else the most specific store collection.
  return (i: StockForecastDTO) => i.collection ?? [...i.collections].sort((a, b) => (size.get(a) ?? 0) - (size.get(b) ?? 0) || a.localeCompare(b))[0] ?? 'Other';
}

/**
 * Suggested orders: a draft purchase order per collection and supplier with what needs ordering (out of stock with sales or
 * pre-orders, order now, reorder soon) at the suggested amounts — named "Suggested · <collection>". Earlier suggested
 * drafts for the same store are replaced, so it can be run again after stock changes. Nothing is ordered.
 */
export interface SuggestedGroup {
  collection: string;
  suppliers: string[];
  lines: { productKey: string; label: string; sku: string | null; status: StockForecastDTO['status']; stock: number; quantity: number; costCents: number | null }[];
}

/** What suggested orders would contain, per collection (nothing is saved). */
export async function suggestedOrderPlan(store: 'salon' | 'shopify' | 'all'): Promise<SuggestedGroup[]> {
  const f = await stockForecast();
  const fallback = await defaultSupplier();
  const inStore = (i: StockForecastDTO) => store === 'all' || (store === 'salon' ? i.stores.salon : i.stores.online);
  const need = f.items.filter((i) => i.suggestedQty > 0 && !i.skippedUntil && ['out', 'order_now', 'soon'].includes(i.status) && inStore(i));
  const coll = collectionOfEach(f.items.filter(inStore));
  // One draft per collection and supplier — never two suppliers on one order; products without one are "Supplier needed".
  const groups = new Map<string, StockForecastDTO[]>();
  const keyOf = (i: StockForecastDTO) => `${coll(i)} · ${i.supplier ?? fallback ?? 'Supplier needed'}`;
  for (const i of need) groups.set(keyOf(i), [...(groups.get(keyOf(i)) ?? []), i]);
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([collection, list]) => ({
    collection,
    suppliers: [...new Set(list.map((i) => i.supplier ?? fallback).filter((x): x is string => !!x))],
    lines: list.map((i) => ({ productKey: i.key, label: i.label, sku: i.sku, status: i.status, stock: i.stock, quantity: i.suggestedQty, costCents: i.costCents })),
  }));
}

/**
 * Makes the suggested drafts — the plan as previewed (with any products left out or amounts changed), or the current
 * plan. Earlier suggested drafts for the same store are replaced first.
 */
export async function suggestPurchaseOrders(store: 'salon' | 'shopify' | 'all', staffId: string | null, chosen?: { collection: string; lines: { productKey: string; quantity: number }[] }[]) {
  const plan = await suggestedOrderPlan(store);
  const groups = chosen
    ? chosen.filter((g) => g.lines.some((l) => l.quantity > 0)).map((g) => ({ collection: g.collection, suppliers: plan.find((p) => p.collection === g.collection)?.suppliers ?? [], lines: g.lines.filter((l) => l.quantity > 0) }))
    : plan;
  await db().query(`DELETE FROM purchase_orders WHERE status = 'draft' AND name LIKE 'Suggested · %' AND ($1 = 'all' OR store = $1)`, [store]);
  const orders: PurchaseOrderDTO[] = [];
  for (const g of groups) {
    orders.push(...await createPurchaseOrders(g.lines.map((l) => ({ productKey: l.productKey, quantity: l.quantity })), staffId, null,
      store === 'all' ? undefined : store, g.suppliers.length ? g.suppliers : undefined, `Suggested · ${g.collection}`.slice(0, 80)));
  }
  return orders;
}

export async function updatePurchaseOrder(id: string, b: { name?: string | null; lotNumber?: string | null; supplier?: string | null; status?: PurchaseOrderStatus; expectedOn?: string | null; note?: string | null; lines?: PoLineInput[] }) {
  const p = await onePO(id);
  if (b.lines && p.status !== 'draft') throw badRequest('Items can only be changed while the order is a draft.');
  if (b.status === 'received') throw badRequest('Use Receive to add the items to stock.');
  // A closed order's note can still change (e.g. lot or delivery details); nothing else can.
  const noteOnly = Object.keys(b).every((k) => k === 'note' || k === 'name' || k === 'lotNumber');
  if ((p.status === 'received' || p.status === 'cancelled') && !noteOnly) throw badRequest('This order is closed.');
  const rows = b.lines ? await lineRows(b.lines) : null;
  await db().tx(async (q) => {
    if (b.name !== undefined) await q.query('UPDATE purchase_orders SET name = $2, updated_at = now() WHERE id = $1', [id, b.name?.trim() || null]);
    if (b.lotNumber !== undefined) await q.query('UPDATE purchase_orders SET lot_number = $2, updated_at = now() WHERE id = $1', [id, b.lotNumber?.trim() || null]);
    await q.query(
      `UPDATE purchase_orders SET supplier = $2, status = $3, expected_on = $4, note = $5,
         ordered_at = CASE WHEN $3 IN ('ordered','shipped') AND ordered_at IS NULL THEN now() ELSE ordered_at END, updated_at = now() WHERE id = $1`,
      [id, b.supplier === undefined ? p.supplier : b.supplier?.trim() || null, b.status ?? p.status, b.expectedOn === undefined ? p.expectedOn : b.expectedOn, b.note === undefined ? p.note : b.note?.trim() || null]);
    if (rows) {
      await q.query('DELETE FROM purchase_order_lines WHERE po_id = $1', [id]);
      for (const r of rows) await q.query(LINE_INSERT, [id, r.key, r.label, r.sku, r.quantity, r.cost, r.lead, r.supplier]);
    }
    if ((b.status === 'ordered' || b.status === 'shipped') && !p.orderedAt) await setArrivalDates(q, id);
  });
  return onePO(id);
}

export async function deletePurchaseOrder(id: string) {
  const p = await onePO(id);
  if (p.status !== 'draft') throw badRequest('Only a draft can be deleted. Cancel it instead.');
  await db().query('DELETE FROM purchase_orders WHERE id = $1', [id]);
}

/** Receives units (all or part): added to stock in Square and Shopify, logged with the order number. */
export async function receivePurchaseOrder(id: string, got: { lineId: string; quantity: number }[], staffId: string | null, note?: string | null) {
  const p = await onePO(id);
  if (p.status === 'draft' || p.status === 'cancelled' || p.status === 'received') throw badRequest(p.status === 'draft' ? 'Mark the order as ordered first.' : 'This order is closed.');
  const lines = got.filter((g) => g.quantity > 0).map((g) => {
    const l = p.lines.find((x) => x.id === g.lineId);
    if (!l) throw badRequest('A line on this order wasn’t found.');
    if (!Number.isInteger(g.quantity)) throw badRequest('Enter whole units.');
    return { l, n: g.quantity };
  });
  if (!lines.length) throw badRequest('Enter what arrived.');
  // Into the order's own store (salon = Square, online = Shopify).
  const res = await applyStockChanges(lines.map((x) => ({ key: x.l.productKey, delta: x.n })), { kind: 'receive', reason: 'Received', note: note ?? null, staffId, reference: p.name ? `${p.name} (PO #${p.number})` : `PO #${p.number}`, only: p.store === 'shopify' ? 'shopify' : 'square' });
  const ok = new Set(res.results.filter((r) => r.ok).map((r) => r.key));
  await db().tx(async (q) => {
    for (const x of lines) if (ok.has(x.l.productKey)) await q.query('UPDATE purchase_order_lines SET received = received + $2 WHERE id = $1', [x.l.id, x.n]);
    await q.query(
      `UPDATE purchase_orders SET status = CASE WHEN NOT EXISTS (SELECT 1 FROM purchase_order_lines WHERE po_id = $1 AND received < quantity) THEN 'received' ELSE status END,
         received_at = CASE WHEN NOT EXISTS (SELECT 1 FROM purchase_order_lines WHERE po_id = $1 AND received < quantity) THEN now() ELSE received_at END, updated_at = now() WHERE id = $1`, [id]);
  });
  return { order: await onePO(id), result: res };
}

/**
 * Moves an order to the other store (e.g. made under the salon by mistake). An open order simply receives into the new
 * store from now on. Units already received went into the old store: with `moveStock` they're taken out of it and added
 * to the new one (only where both steps work, so stock is never lost or doubled); otherwise only the order moves.
 */
export async function movePurchaseOrder(id: string, store: 'salon' | 'shopify', moveStock: boolean, staffId: string | null) {
  const p = await onePO(id);
  if (p.store === store) throw badRequest('The order is already in that store.');
  const ref = `${p.name ? `${p.name} (PO #${p.number})` : `PO #${p.number}`} moved to ${store === 'shopify' ? 'online' : 'the salon'}`;
  const from = p.store === 'shopify' ? 'shopify' : 'square';
  const to = store === 'shopify' ? 'shopify' : 'square';
  const received = p.lines.filter((l) => l.received > 0);
  let moved = 0;
  const problems: string[] = [];
  if (moveStock && received.length) {
    const out = await applyStockChanges(received.map((l) => ({ key: l.productKey, delta: -l.received })), { kind: 'adjust', reason: 'Moved purchase order', staffId, reference: ref, only: from });
    const taken = received.filter((l) => out.results.some((r) => r.key === l.productKey && r.ok));
    const back = taken.length ? await applyStockChanges(taken.map((l) => ({ key: l.productKey, delta: l.received })), { kind: 'adjust', reason: 'Moved purchase order', staffId, reference: ref, only: to }) : null;
    for (const l of taken) {
      if (back?.results.some((r) => r.key === l.productKey && r.ok)) { moved += l.received; continue; }
      // Couldn't add it to the new store (e.g. not sold there): put it back where it was.
      await applyStockChanges([{ key: l.productKey, delta: l.received }], { kind: 'adjust', reason: 'Moved purchase order (undone)', staffId, reference: ref, only: from });
      problems.push(l.label);
    }
    for (const l of received) if (!taken.includes(l)) problems.push(l.label);
  }
  await db().query('UPDATE purchase_orders SET store = $2, updated_at = now() WHERE id = $1', [id, store]);
  return { order: await onePO(id), movedUnits: moved, notMoved: problems };
}

// ---------------- Analytics → Product sales ----------------
/** Product sales for a period (days back from today, or "year" = since January 1) from Square, Shopify or both, plus 12 months of monthly usage. */
/**
 * A product's name as a set of words, for matching the same product under another SKU or listing: lower case, sizes in
 * one form (22", 22 in, 22 inch → 22in), "Default Title"/"Regular" and punctuation dropped, words in any order. Exact
 * matches only, so different colours or sizes never combine.
 */
export function productNameKey(label: string | null | undefined): string | null {
  if (!label) return null;
  const words = productSearchWords(label.replace(/\bdefault title\b|\bregular\b/gi, ' ')).join(' ').split(/[^a-z0-9]+/).filter(Boolean);
  return words.length ? [...new Set(words)].sort().join(' ') : null;
}

/**
 * Re-keys sale lines so one product's sales under different SKUs or listings count once: each name's sales go to the
 * current product with that name (a paired product first), or to one row when none is current. Returns, per kept row,
 * the other SKUs combined into it.
 */
function mergeByName(lines: { key: string }[], names: Map<string, { label: string; sku: string | null }>, rows: StockProductDTO[]) {
  const rank = (key: string) => { const r = rows.find((x) => x.key === key); return r ? (r.linkId ? 3 : r.sku ? 2 : 1) : 0; };
  const keep = new Map<string, string>(); // name → key that keeps the sales
  const keys = [...new Set([...rows.map((r) => r.key), ...lines.map((l) => l.key)])];
  for (const k of keys) {
    const nk = productNameKey(names.get(k)?.label);
    if (!nk) continue;
    const cur = keep.get(nk);
    if (!cur || rank(k) > rank(cur)) keep.set(nk, k);
  }
  const also = new Map<string, string[]>();
  const into = new Map<string, string>();
  for (const k of keys) {
    const nk = productNameKey(names.get(k)?.label);
    const target = nk ? keep.get(nk)! : k;
    if (target === k) continue;
    into.set(k, target);
  }
  for (const l of lines) {
    const t = into.get(l.key);
    if (!t) continue;
    const sku = names.get(l.key)?.sku;
    if (sku && sku !== names.get(t)?.sku && !(also.get(t) ?? []).includes(sku)) also.set(t, [...(also.get(t) ?? []), sku]);
    l.key = t;
  }
  return { also, into };
}

/**
 * One product's sales (Inventory → a product): units and revenue over 7, 30, 90 days and 12 months, the 30 days before,
 * month by month (the current month marked partial) and by store. It follows the SKU — every listing of it in Square and
 * both Shopify stores — so a rename or a new collection keeps the history. Square returns subtract; cancelled Shopify
 * orders don't count. `hasSales` false = no sales recorded (not the same as zero demand).
 */
export async function productSales(key: string) {
  const tz = (await getSettings()).business.timezone;
  const today = localDate(new Date(), tz);
  const L = await live();
  const row = L.rows.find((r) => r.key === key);
  if (!row) throw notFound('That product');
  const group = norm(row.sku) ? L.rows.filter((r) => norm(r.sku) === norm(row.sku)) : [row];
  const sqIds = group.map((r) => r.squareVariationId).filter((x): x is string => !!x);
  const shIds = group.flatMap((r) => [r.shopifyInventoryItemId, ...r.store2.map((e) => e.inventoryItemId), ...(r.siblings ?? []).map((e) => e.inventoryItemId)]).filter((x): x is string => !!x);
  const monthStart = (() => { const [y, m] = today.split('-').map(Number); return new Date(Date.UTC(y, m - 1 - 12, 1)).toISOString().slice(0, 10); })();
  type Line = { d: string; n: number; cents: number; ch: 'square' | 'shopify' | 'shopify2' };
  const lines: Line[] = [];
  const money = `coalesce((x->'gross_sales_money'->>'amount')::numeric, 0) - coalesce((x->'total_discount_money'->>'amount')::numeric, 0)`;
  if (sqIds.length) {
    for (const [path, sign] of [[`coalesce(o.raw->'line_items', '[]'::jsonb)`, 1], [`(SELECT coalesce(jsonb_agg(rl), '[]'::jsonb) FROM jsonb_array_elements(coalesce(o.raw->'returns', '[]'::jsonb)) rt, jsonb_array_elements(coalesce(rt->'return_line_items', '[]'::jsonb)) rl)`, -1]] as const) {
      const rows = await db().query<any>(
        `SELECT to_char(o.closed_at AT TIME ZONE $2, 'YYYY-MM-DD') AS d, sum((x->>'quantity')::numeric) AS n, sum(${money}) AS c
           FROM commission_orders o, jsonb_array_elements(${path}) x
          WHERE o.state = 'COMPLETED' AND o.closed_at >= ($1::date - 1) AND x->>'catalog_object_id' = ANY($3::text[]) GROUP BY 1`, [monthStart, tz, sqIds]);
      for (const r of rows) lines.push({ d: r.d, n: sign * Number(r.n), cents: sign * Number(r.c), ch: 'square' });
    }
  }
  if (shIds.length) {
    const rows = await db().query<any>(
      `SELECT store, to_char(ordered_at AT TIME ZONE $2, 'YYYY-MM-DD') AS d, sum(quantity) AS n, sum(quantity * coalesce(unit_price_cents, 0)) AS c
         FROM shopify_order_lines WHERE NOT cancelled AND ordered_at >= ($1::date - 1) AND inventory_item_id = ANY($3::text[]) GROUP BY 1, 2`, [monthStart, tz, shIds]);
    for (const r of rows) lines.push({ d: r.d, n: Number(r.n), cents: Number(r.c), ch: r.store === 'shopify2' ? 'shopify2' : 'shopify' });
  }
  const sum = (from: string, to = today) => {
    const l = lines.filter((x) => x.d >= from && x.d <= to);
    return { units: l.reduce((a, x) => a + x.n, 0), revenueCents: Math.round(l.reduce((a, x) => a + x.cents, 0)) };
  };
  const months: { month: string; square: number; shopify: number; shopify2: number; total: number; partial: boolean }[] = [];
  for (let i = 12; i >= 0; i--) {
    const [y, m] = today.split('-').map(Number);
    const month = new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7);
    const l = lines.filter((x) => x.d.startsWith(month));
    const by = (ch: Line['ch']) => l.filter((x) => x.ch === ch).reduce((a, x) => a + x.n, 0);
    months.push({ month, square: by('square'), shopify: by('shopify'), shopify2: by('shopify2'), total: l.reduce((a, x) => a + x.n, 0), partial: i === 0 });
  }
  const done = months.filter((m) => !m.partial);
  const year = addDays(today, -364);
  const names = storeNames();
  return {
    hasSales: lines.length > 0,
    lastSaleOn: lines.filter((x) => x.n > 0).map((x) => x.d).sort().pop() ?? null,
    periods: { d7: sum(addDays(today, -6)), d30: sum(addDays(today, -29)), d90: sum(addDays(today, -89)), d365: sum(year) },
    previous30: sum(addDays(today, -59), addDays(today, -30)),
    avgPerDay30: Math.round((sum(addDays(today, -29)).units / 30) * 100) / 100,
    // Average over the 12 completed months (the current, partial month isn't in it).
    avgPerMonth: Math.round((done.reduce((a, m) => a + m.total, 0) / done.length) * 10) / 10,
    months,
    byChannel: (['square', 'shopify', 'shopify2'] as const).map((ch) => {
      const l = lines.filter((x) => x.ch === ch && x.d >= year);
      return { channel: ch, name: ch === 'square' ? names.square : ch === 'shopify' ? shopifyNameOf('shopify') : shopifyNameOf('shopify2'), units: l.reduce((a, x) => a + x.n, 0), revenueCents: Math.round(l.reduce((a, x) => a + x.cents, 0)) };
    }).filter((c) => c.units !== 0 || c.revenueCents !== 0),
  };
}

export async function productAnalytics(period: number | 'year', store: ProductAnalyticsDTO['store'] = 'all'): Promise<ProductAnalyticsDTO> {
  void refreshShopifySales();
  const tz = (await getSettings()).business.timezone;
  const today = localDate(new Date(), tz);
  const from = period === 'year' ? `${today.slice(0, 4)}-01-01` : addDays(today, -(period - 1));
  const span = Math.round((Date.parse(today) - Date.parse(from)) / 86400_000) + 1;
  const prevFrom = addDays(from, -span);
  const monthStart = (() => { const [y, m] = today.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 - 12, 1)); return d.toISOString().slice(0, 10); })();
  const since = [from, prevFrom, monthStart].sort()[0];

  // Products and names (live when the stores answer, else the local Square copy).
  let rows: StockProductDTO[] = [];
  try { rows = (await live()).rows; } catch { rows = []; }
  const keyOfItem = new Map<string, string>();
  for (const r of rows) {
    if (r.shopifyInventoryItemId) keyOfItem.set(r.shopifyInventoryItemId, r.key);
    for (const e of r.store2) keyOfItem.set(e.inventoryItemId, r.key);
  }
  const names = new Map(rows.map((r) => [r.key, { label: r.label, sku: r.sku }]));
  for (const r of await db().query<any>('SELECT variation_id, item_name, variation_name, sku FROM square_inventory')) {
    if (!names.has(r.variation_id)) names.set(r.variation_id, { label: [r.item_name, r.variation_name].filter(Boolean).join(' · '), sku: r.sku });
  }

  // Sale lines: Square retail (catalog products, not services; returns subtract) and Shopify.
  type Line = { key: string; d: string; n: number; cents: number; ch: 'square' | 'shopify' | 'shopify2' };
  const lines: Line[] = [];
  const money = `coalesce((x->'gross_sales_money'->>'amount')::numeric, 0) - coalesce((x->'total_discount_money'->>'amount')::numeric, 0)`;
  for (const [path, sign] of [[`coalesce(o.raw->'line_items', '[]'::jsonb)`, 1], [`(SELECT coalesce(jsonb_agg(rl), '[]'::jsonb) FROM jsonb_array_elements(coalesce(o.raw->'returns', '[]'::jsonb)) rt, jsonb_array_elements(coalesce(rt->'return_line_items', '[]'::jsonb)) rl)`, -1]] as const) {
    const sq = await db().query<any>(
      `SELECT x->>'catalog_object_id' AS id, to_char(o.closed_at AT TIME ZONE $2, 'YYYY-MM-DD') AS d, sum((x->>'quantity')::numeric) AS n, sum(${money}) AS c
         FROM commission_orders o, jsonb_array_elements(${path}) x
        WHERE o.state = 'COMPLETED' AND o.closed_at >= ($1::date - 1) AND x->>'catalog_object_id' IN (SELECT variation_id FROM square_inventory)
        GROUP BY 1, 2`, [since, tz]);
    for (const r of sq) lines.push({ key: r.id, d: r.d, n: sign * Number(r.n), cents: sign * Number(r.c), ch: 'square' });
  }
  const sh = await db().query<any>(
    `SELECT store, inventory_item_id AS id, sku, to_char(ordered_at AT TIME ZONE $2, 'YYYY-MM-DD') AS d, sum(quantity) AS n, sum(quantity * coalesce(unit_price_cents, 0)) AS c, max(title) AS title
       FROM shopify_order_lines WHERE NOT cancelled AND ordered_at >= ($1::date - 1) GROUP BY 1, 2, 3, 4`, [since, tz]);
  for (const r of sh) {
    const key = (r.id && keyOfItem.get(r.id)) ?? (r.id ? shopKey(r.id) : `sku:${r.sku ?? '?'}`);
    if (!names.has(key)) names.set(key, { label: r.title ?? (r.sku ? `SKU ${r.sku}` : 'Shopify product'), sku: r.sku ?? null });
    else if (r.title && /^SKU /.test(names.get(key)!.label)) names.get(key)!.label = r.title;
    lines.push({ key, d: r.d, n: Number(r.n), cents: Number(r.c), ch: r.store === 'shopify2' ? 'shopify2' : 'shopify' });
  }
  // The same product sold under different SKUs or listings (a SKU was changed, a listing replaced): combined by name.
  const { also: merged, into: mergedAway } = mergeByName(lines, names, rows);
  // Only the chosen store's sales.
  const mine = store === 'all' ? lines : store === 'online' ? lines.filter((l) => l.ch === 'shopify' || l.ch === 'shopify2') : lines.filter((l) => l.ch === store);
  const inPeriod = mine.filter((l) => l.d >= from && l.d <= today);
  const prev = mine.filter((l) => l.d >= prevFrom && l.d < from);
  const sum = (ls: Line[], f: (l: Line) => number) => ls.reduce((a, l) => a + f(l), 0);
  const ch = (c: Line['ch']) => ({ units: sum(inPeriod.filter((l) => l.ch === c), (l) => l.n), salesCents: Math.round(sum(inPeriod.filter((l) => l.ch === c), (l) => l.cents)) });

  // Trend buckets.
  const bucket: ProductAnalyticsDTO['bucket'] = span <= 31 ? 'day' : span <= 120 ? 'week' : 'month';
  const startOf = (d: string) => {
    if (bucket === 'day') return d;
    if (bucket === 'month') return `${d.slice(0, 7)}-01`;
    const wd = (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday weeks
    return addDays(d, -wd);
  };
  const trendMap = new Map<string, { start: string; square: number; shopify: number; shopify2: number; salesCents: number }>();
  for (let d = startOf(from); d <= today; d = bucket === 'day' ? addDays(d, 1) : bucket === 'week' ? addDays(d, 7) : (() => { const [y, m] = d.split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); })()) {
    trendMap.set(d, { start: d, square: 0, shopify: 0, shopify2: 0, salesCents: 0 });
  }
  for (const l of inPeriod) {
    const t = trendMap.get(startOf(l.d));
    if (!t) continue;
    t[l.ch] += l.n;
    t.salesCents += l.cents;
  }

  // Every product bought, best sellers first.
  const per = new Map<string, { units: number; salesCents: number; squareUnits: number; shopifyUnits: number; shopify2Units: number }>();
  for (const l of inPeriod) {
    const p = per.get(l.key) ?? { units: 0, salesCents: 0, squareUnits: 0, shopifyUnits: 0, shopify2Units: 0 };
    p.units += l.n; p.salesCents += l.cents;
    if (l.ch === 'square') p.squareUnits += l.n; else if (l.ch === 'shopify') p.shopifyUnits += l.n; else p.shopify2Units += l.n;
    per.set(l.key, p);
  }
  const top = [...per].filter(([, p]) => p.units > 0).sort((a, b) => b[1].units - a[1].units || b[1].salesCents - a[1].salesCents)
    .map(([key, p]) => ({ key, label: names.get(key)?.label ?? key, sku: names.get(key)?.sku ?? null, alsoSkus: merged.get(key) ?? [], ...p, salesCents: Math.round(p.salesCents) }));

  // Monthly usage: the last 12 complete months and this month. The average uses complete months from the first with sales.
  const months: string[] = [];
  for (let i = 12; i >= 0; i--) { const [y, m] = today.split('-').map(Number); months.push(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7)); }
  const usage = new Map<string, number[]>();
  for (const l of mine) {
    const i = months.indexOf(l.d.slice(0, 7));
    if (i < 0) continue;
    const u = usage.get(l.key) ?? months.map(() => 0);
    u[i] += l.n;
    usage.set(l.key, u);
  }
  for (const r of rows) if (r.status !== 'not_tracked' && !usage.has(r.key) && !mergedAway.has(r.key)) usage.set(r.key, months.map(() => 0));
  const monthlyRows = [...usage].map(([key, u]) => {
    const complete = u.slice(0, 12);
    const first = complete.findIndex((x) => x !== 0);
    const counted = first < 0 ? [] : complete.slice(first);
    return { key, label: names.get(key)?.label ?? key, sku: names.get(key)?.sku ?? null, units: u, total: u.reduce((a, x) => a + x, 0), avgPerMonth: counted.length ? Math.round((counted.reduce((a, x) => a + x, 0) / counted.length) * 10) / 10 : 0 };
  }).sort((a, b) => a.label.localeCompare(b.label));

  // Stock value now.
  let unitsOnHand = 0, atCost = 0, atRetail = 0, missingCost = 0;
  for (const r of rows) {
    if (r.status === 'not_tracked') continue;
    const q = Math.max(0, r.squareQty ?? r.shopifyQty ?? 0);
    if (!q) continue;
    unitsOnHand += q;
    if (r.costCents != null) atCost += q * r.costCents; else missingCost++;
    if (r.priceCents != null) atRetail += q * r.priceCents;
  }
  const state = await getKV<{ updatedAt: string | null; note: string | null }>(SALES_KEY);
  return {
    from, to: today, store, store2Name: shopifyService2() ? shopify2Name() : null,
    totals: { units: sum(inPeriod, (l) => l.n), salesCents: Math.round(sum(inPeriod, (l) => l.cents)), products: [...per.values()].filter((p) => p.units > 0).length, square: ch('square'), shopify: ch('shopify'), shopify2: ch('shopify2') },
    previous: { units: sum(prev, (l) => l.n), salesCents: Math.round(sum(prev, (l) => l.cents)) },
    bucket, trend: [...trendMap.values()], top,
    monthly: { months, rows: monthlyRows },
    stock: { unitsOnHand, atCostCents: atCost, atRetailCents: atRetail, missingCost },
    salesFrom: { square: !!(await squareService()), shopify: !!shopifyService() && !state?.note, shopifyNote: await salesNotes() },
  };
}

// ---------------- Suppliers ----------------
/**
 * Analytics → Forecast: what to order, by urgency (order now, reorder soon, watch, healthy). Products whose supplier's
 * lead time isn't tracked are left out, as are products without sales (nothing to forecast). Out of stock with sales
 * counts as order now.
 */
export async function analyticsForecast() {
  const f = await stockForecast();
  const bucket = (i: StockForecastDTO) => (i.status === 'out' ? (i.ratePerDay > 0 ? 'order_now' : null) : (['order_now', 'soon', 'watch', 'healthy'] as const).find((s) => s === i.status) ?? null);
  return {
    items: f.items.filter((i) => !i.leadUntracked && !i.skippedUntil).flatMap((i) => {
      const b = bucket(i);
      return b ? [{ key: i.key, label: i.label, sku: i.sku, status: b, stock: i.stock, incoming: i.incoming, ratePerDay: i.ratePerDay, daysOfStock: i.daysOfStock, orderBy: i.orderBy,
        suggestedQty: i.suggestedQty, costCents: i.costCents, supplier: i.supplier, collections: i.collections, collection: i.collection, stores: i.stores }] : [];
    }),
  };
}

/** Each supplier: products, the lead time set on them vs the real time from ordered to received, open and received orders. */
export async function listSuppliers(): Promise<SupplierDTO[]> {
  const prods = await db().query<any>(`SELECT supplier, count(*)::int AS n, avg(lead_time_days)::float AS lead FROM stock_products WHERE supplier IS NOT NULL GROUP BY supplier`);
  const pos = await db().query<any>(
    `SELECT s.name AS supplier,
            count(*) FILTER (WHERE p.status = 'received')::int AS received,
            count(*) FILTER (WHERE p.status IN ('draft','ordered','shipped'))::int AS open,
            avg(EXTRACT(EPOCH FROM (p.received_at - p.ordered_at)) / 86400) FILTER (WHERE p.status = 'received' AND p.ordered_at IS NOT NULL)::float AS actual,
            coalesce(sum((SELECT sum(l.received * coalesce(l.cost_cents, 0)) FROM purchase_order_lines l WHERE l.po_id = p.id AND coalesce(l.supplier, p.supplier) = s.name)), 0)::bigint AS spent
       FROM purchase_orders p CROSS JOIN LATERAL unnest(string_to_array(p.supplier, ' + ')) AS s(name)
      WHERE p.supplier IS NOT NULL GROUP BY s.name`);
  const saved = await db().query<any>('SELECT * FROM suppliers');
  const names = new Set<string>([...saved.map((s) => s.name), ...prods.map((p) => p.supplier), ...pos.map((p) => p.supplier)]);
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
    const p = prods.find((x) => x.supplier === name);
    const o = pos.find((x) => x.supplier === name);
    const s = saved.find((x) => x.name === name);
    return {
      name, products: p?.n ?? 0, statedLeadDays: p?.lead != null ? Math.round(p.lead) : s?.lead_time_days ?? null, actualLeadDays: o?.actual != null ? Math.round(o.actual) : null,
      receivedOrders: o?.received ?? 0, openOrders: o?.open ?? 0, spentCents: Number(o?.spent ?? 0),
      companyName: s?.company_name ?? null, email: s?.email ?? null, phone: s?.phone ?? null, website: s?.website ?? null, notes: s?.notes ?? null,
      leadTimeDays: s?.lead_time_days ?? null, leadUntracked: !!s?.lead_untracked, shippingDays: s?.shipping_days ?? null, defaultMoq: s?.default_moq ?? null, isDefault: !!s?.is_default,
    };
  });
}

/**
 * Adds a supplier, or updates its details (`previous` = its current name, to rename it everywhere). Without `details`
 * (the "See supplier company names and contacts" permission), only the shown name and lead time change; the company
 * name and contacts are kept as they are.
 */
export async function saveSupplier(input: SupplierInput, previous: string | null, staffId: string | null, details = true) {
  const name = input.name.trim();
  if (!name) throw badRequest('Enter the supplier’s name.');
  const clean = (v: string | null | undefined) => v?.trim() || null;
  if (previous && previous !== name) await renameSupplier(previous, name, staffId);
  else if (!previous && await db().one('SELECT 1 FROM suppliers WHERE lower(name) = lower($1)', [name])) throw badRequest(`${name} is already a supplier.`);
  if (!details) {
    await db().query(
      `INSERT INTO suppliers(name, lead_time_days, lead_untracked, shipping_days, default_moq) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (name) DO UPDATE SET lead_time_days = $2, lead_untracked = $3, shipping_days = $4, default_moq = $5, updated_at = now()`,
      [name, input.leadTimeDays ?? null, !!input.leadUntracked, input.shippingDays ?? null, input.defaultMoq ?? null]);
    return;
  }
  await db().query(
    `INSERT INTO suppliers(name, company_name, email, phone, website, notes, lead_time_days, lead_untracked, shipping_days, default_moq) VALUES ($1,$7,$2,$3,$4,$5,$6,$8,$9,$10)
     ON CONFLICT (name) DO UPDATE SET company_name = $7, email = $2, phone = $3, website = $4, notes = $5, lead_time_days = $6, lead_untracked = $8, shipping_days = $9, default_moq = $10, updated_at = now()`,
    [name, clean(input.email), clean(input.phone), clean(input.website), clean(input.notes), input.leadTimeDays ?? null, clean(input.companyName), !!input.leadUntracked, input.shippingDays ?? null, input.defaultMoq ?? null]);
  forgetStockCache();
}

/** The default supplier's name (used where a product or order doesn't name one), or null. */
export async function defaultSupplier(): Promise<string | null> {
  return (await db().one<{ name: string }>('SELECT name FROM suppliers WHERE is_default'))?.name ?? null;
}
/** Makes a supplier the default (or none, with null). */
export async function setDefaultSupplier(name: string | null) {
  await db().tx(async (q) => {
    await q.query('UPDATE suppliers SET is_default = false WHERE is_default');
    if (name) {
      await q.query('INSERT INTO suppliers(name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
      await q.query('UPDATE suppliers SET is_default = true WHERE name = $1', [name]);
    }
  });
  // Orders saved without a supplier take the default too.
  if (name) await db().query("UPDATE purchase_orders SET supplier = $1 WHERE supplier IS NULL AND status NOT IN ('received','cancelled')", [name]);
}

/** Removes a supplier. Its products keep their stock and details; they just have no supplier. Purchase orders keep the name. */
export async function deleteSupplier(name: string, staffId: string | null) {
  await db().tx(async (q) => {
    await q.query('UPDATE stock_products SET supplier = NULL, updated_by_staff_id = $2, updated_at = now() WHERE supplier = $1', [name, staffId]);
    await q.query('DELETE FROM suppliers WHERE name = $1', [name]);
  });
  forgetStockCache();
}

/**
 * Gives products a supplier: chosen products, or every product in a store (Square = the salon, Shopify, the second
 * store), optionally only those without one yet. Products with no lead time of their own get the supplier's usual one.
 */
export async function assignSupplier(a: SupplierAssign, staffId: string | null) {
  // A supplier typed on a product (before suppliers could be added here) gets its row now.
  await db().query('INSERT INTO suppliers(name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [a.supplier]);
  let keys: string[];
  if ('keys' in a) keys = [...new Set(a.keys)];
  else {
    const rows = (await live()).rows;
    keys = rows.filter((r) => (a.store === 'all' || (a.store === 'square' && r.squareVariationId) || (a.store === 'shopify' && r.shopifyInventoryItemId) || (a.store === 'shopify2' && r.store2.length > 0))
      && r.status === 'active' && (!a.onlyWithout || !r.supplier)).map((r) => r.key);
  }
  if (!keys.length) return 0;
  await db().query(
    `INSERT INTO stock_products(product_key, supplier, updated_by_staff_id)
       SELECT k, $2, $3 FROM unnest($1::text[]) k
     ON CONFLICT (product_key) DO UPDATE SET supplier = $2, updated_by_staff_id = $3, updated_at = now()`,
    [keys, a.supplier, staffId]);
  // Products keep no copy of the supplier's lead time: one left blank uses the supplier's default, so it follows changes.
  forgetStockCache();
  return keys.length;
}

/** To order → Skip: leave products out of suggestions and alerts until a date (null = turn them back on). */
export async function skipProducts(keys: string[], until: string | null, staffId: string | null) {
  await db().query(
    `INSERT INTO stock_products(product_key, skip_until, updated_by_staff_id) SELECT k, $2::date, $3 FROM unnest($1::text[]) k
     ON CONFLICT (product_key) DO UPDATE SET skip_until = $2::date, updated_by_staff_id = $3, updated_at = now()`, [[...new Set(keys)], until, staffId]);
  forgetStockCache();
}

/** Sets the lead time on all of a supplier's products (e.g. to what they actually take). */
export async function setSupplierLeadTime(name: string, days: number, staffId: string | null) {
  const r = await db().query<{ product_key: string }>('UPDATE stock_products SET lead_time_days = $2, updated_by_staff_id = $3, updated_at = now() WHERE supplier = $1 RETURNING product_key', [name, days, staffId]);
  forgetStockCache();
  return r.length;
}

/** Renames a supplier on its products and open purchase orders. */
/**
 * Merges a duplicate supplier into another (e.g. two records for the same hair company). Its products, purchase orders
 * and items move over. Products that used the duplicate's defaults (lead time, shipping, minimum order) keep those
 * values as their own when the other supplier's differ — so no product's timing changes by merging.
 */
export async function mergeSuppliers(from: string, into: string, staffId: string | null) {
  if (from === into) throw badRequest('Choose two different suppliers.');
  const [a, b] = await Promise.all([db().one<any>('SELECT * FROM suppliers WHERE name = $1', [from]), db().one<any>('SELECT * FROM suppliers WHERE name = $1', [into])]);
  if (!b) throw notFound('That supplier');
  if (a) {
    for (const [col, def] of [['lead_time_days', 'lead_time_days'], ['shipping_days', 'shipping_days'], ['moq', 'default_moq']] as const) {
      if (a[def] != null && a[def] !== b[def]) {
        await db().query(`UPDATE stock_products SET ${col} = $2, updated_by_staff_id = $3, updated_at = now() WHERE supplier = $1 AND ${col} IS NULL`, [from, a[def], staffId]);
      }
    }
  }
  await renameSupplier(from, into, staffId);
  await db().query('DELETE FROM suppliers WHERE name = $1', [from]);
  forgetStockCache();
}

export async function renameSupplier(from: string, to: string, staffId: string | null) {
  const name = to.trim();
  if (!name) throw badRequest('Enter a name.');
  await db().tx(async (q) => {
    await q.query('UPDATE stock_products SET supplier = $2, updated_by_staff_id = $3, updated_at = now() WHERE supplier = $1', [from, name, staffId]);
    await q.query('UPDATE purchase_orders SET supplier = $2, updated_at = now() WHERE supplier = $1', [from, name]);
    await q.query(`UPDATE purchase_orders SET supplier = array_to_string(array_replace(string_to_array(supplier, ' + '), $1, $2), ' + '), updated_at = now() WHERE supplier LIKE '% + %' AND $1 = ANY(string_to_array(supplier, ' + '))`, [from, name]);
    await q.query('UPDATE purchase_order_lines SET supplier = $2 WHERE supplier = $1', [from, name]);
    await q.query('UPDATE suppliers SET name = $2, updated_at = now() WHERE name = $1 AND NOT EXISTS (SELECT 1 FROM suppliers WHERE name = $2)', [from, name]);
  });
  forgetStockCache();
}

// ---------------- Pre-orders (Inventory → Pre-orders) ----------------
/**
 * What customers are waiting for: products below zero in Shopify (ordered online before they were in stock). For each,
 * what's already on a purchase order (backordered, with when it's due), what's still to order, and the recent online
 * orders that took it below zero.
 */
export async function preorderReport() {
  const L = await live();
  const openLines = await db().query<any>(
    `SELECT l.product_key, sum(l.quantity - l.received)::int AS n, min(to_char(COALESCE(l.expected_on, p.expected_on), 'YYYY-MM-DD')) AS due,
            string_agg(DISTINCT COALESCE(p.name, 'PO #' || p.number), ', ') AS orders
       FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id
      WHERE p.status IN ('ordered','shipped','draft') AND l.quantity > l.received GROUP BY 1`);
  const po = new Map(openLines.map((r) => [r.product_key as string, { units: Number(r.n), due: r.due as string | null, orders: r.orders as string }]));
  const items = [];
  for (const r of L.rows) {
    const stores = [
      ...(r.shopifyQty != null && r.shopifyQty < 0 ? [{ store: shopifyNameOf('shopify'), itemId: r.shopifyInventoryItemId!, waiting: -r.shopifyQty }] : []),
      ...(r.siblings ?? []).filter((e) => (e.qty ?? 0) < 0).map((e) => ({ store: shopifyNameOf('shopify'), itemId: e.inventoryItemId, waiting: -(e.qty ?? 0) })),
      ...r.store2.filter((e) => (e.qty ?? 0) < 0).map((e) => ({ store: shopifyNameOf('shopify2'), itemId: e.inventoryItemId, waiting: -(e.qty ?? 0) })),
    ];
    if (!stores.length) continue;
    // The stores share one stock, so each shows the same shortfall: count it once (the deepest), not once per store.
    // The orders below say which store each customer ordered from.
    const waiting = Math.max(...stores.map((s) => s.waiting));
    const p = po.get(r.key);
    // The newest online orders for it, enough to cover what's waiting (the ones that took it below zero).
    const lines = await db().query<any>(
      `SELECT order_id, quantity, ordered_at, store FROM shopify_order_lines
        WHERE inventory_item_id = ANY($1::text[]) AND NOT cancelled ORDER BY ordered_at DESC LIMIT 30`, [stores.map((s) => s.itemId)]);
    const orders: { orderId: string; quantity: number; orderedAt: string; store: string; orderName?: string | null; customer?: string | null }[] = [];
    let covered = 0;
    for (const l of lines) {
      if (covered >= waiting) break;
      orders.push({ orderId: String(l.order_id).replace(/^gid:\/\/shopify\/Order\//, ''), quantity: Number(l.quantity), orderedAt: iso(l.ordered_at)!, store: l.store === 'shopify2' ? shopifyNameOf('shopify2') : shopifyNameOf('shopify') });
      covered += Number(l.quantity);
    }
    // Who is waiting: each order's number and customer (asked from the store once, then remembered).
    await fillOrderWho(lines.filter((l) => orders.some((o) => String(l.order_id).endsWith(o.orderId))));
    for (const o of orders) {
      const w = orderWhoCache?.[o.orderId];
      Object.assign(o, { orderName: w?.name ?? null, customer: w?.customer ?? null });
    }
    const onOrder = p?.units ?? 0;
    items.push({
      key: r.key, label: r.label, sku: r.sku, imageUrl: (r as any).imageUrl ?? null, waiting, stores: stores.map((s) => ({ store: s.store, waiting: s.waiting })),
      onOrder, due: p?.due ?? null, purchaseOrders: p?.orders ?? null, toOrder: Math.max(0, waiting - onOrder),
      // Backordered: on a purchase order that covers them; waiting: nothing (or not enough) ordered yet.
      status: onOrder >= waiting ? 'backordered' as const : 'needs_order' as const,
      orders,
    });
  }
  items.sort((a, b) => Number(b.status === 'needs_order') - Number(a.status === 'needs_order') || b.waiting - a.waiting);
  return { items, waiting: items.reduce((n, i) => n + i.waiting, 0), toOrder: items.reduce((n, i) => n + i.toOrder, 0) };
}
// Order numbers and customers for pre-orders, by order id (without the gid prefix). Kept so each order is asked once.
let orderWhoCache: Record<string, { name: string | null; customer: string | null }> | null = null;
async function fillOrderWho(lines: { order_id: string; store: string }[]) {
  orderWhoCache ??= (await getKV<Record<string, { name: string | null; customer: string | null }>>('stock.order-who')) ?? {};
  const short = (id: string) => String(id).replace(/^gid:\/\/shopify\/Order\//, '');
  const missing = lines.filter((l) => !orderWhoCache![short(l.order_id)]);
  if (!missing.length) return;
  for (const which of ['shopify', 'shopify2'] as const) {
    const shop = which === 'shopify2' ? shopifyService2() : shopifyService();
    const ids = [...new Set(missing.filter((l) => (l.store === 'shopify2') === (which === 'shopify2')).map((l) => String(l.order_id)))];
    if (!shop || !ids.length) continue;
    try {
      const got = await shop.orderWho(ids);
      for (const [id, w] of got) orderWhoCache[short(id)] = w;
    } catch { /* names are a nice-to-have: the order list still shows */ }
  }
  await setKV('stock.order-who', orderWhoCache);
}

export const shopifyNameOf = (which: 'shopify' | 'shopify2') => (which === 'shopify2' ? storeNames().shopify2 ?? shopify2Name() ?? 'Store 2' : storeNames().shopify);

/**
 * Bell notification when customers pre-order something new (a product goes further below zero online), to everyone who
 * manages inventory. Remembers the last counts so each pre-order is announced once.
 */
export async function notifyNewPreorders(notify: (staffIds: string[], title: string, body: string) => Promise<void>, recipients: () => Promise<string[]>) {
  const r = await preorderReport();
  const before = (await getKV<Record<string, number>>('stock.preorders.seen')) ?? null;
  const now = Object.fromEntries(r.items.map((i) => [i.key, i.waiting]));
  await setKV('stock.preorders.seen', now);
  if (!before) return 0; // first run: just remember
  const grew = r.items.filter((i) => i.waiting > (before[i.key] ?? 0));
  if (!grew.length) return 0;
  const ids = await recipients();
  if (!ids.length) return 0;
  const title = grew.length === 1 ? `New pre-order: ${grew[0].label}` : `${grew.length} products have new pre-orders`;
  const body = grew.slice(0, 5).map((i) => `${i.label}: ${i.waiting} waiting${i.toOrder ? `, ${i.toOrder} still to order` : ` (on order${i.due ? `, due ${i.due}` : ''})`}`).join('\n');
  await notify(ids, title, body);
  return grew.length;
}

/**
 * Bell notification when a product that sells runs out, or is at risk of running out before a new order could arrive.
 * Each product is announced once per state (out, or at risk) until it's back in stock.
 */
export async function notifyStockAlerts(notify: (staffIds: string[], title: string, body: string) => Promise<void>, recipients: () => Promise<string[]>) {
  const f = await stockForecast();
  const state = (i: StockForecastDTO) => (i.status === 'discontinued' || i.skippedUntil ? null : i.stock <= 0 && i.ratePerDay > 0 ? 'out' : i.stockoutRisk ? 'risk' : null);
  const now: Record<string, 'out' | 'risk'> = {};
  for (const i of f.items) { const s = state(i); if (s) now[i.key] = s; }
  const before = (await getKV<Record<string, string>>('stock.alerts.seen')) ?? null;
  await setKV('stock.alerts.seen', now);
  if (!before) return 0; // first run: just remember
  const fresh = f.items.filter((i) => now[i.key] && before[i.key] !== now[i.key]);
  if (!fresh.length) return 0;
  const ids = await recipients();
  if (!ids.length) return 0;
  const out = fresh.filter((i) => now[i.key] === 'out');
  const risk = fresh.filter((i) => now[i.key] === 'risk');
  const title = [out.length && `${out.length} out of stock`, risk.length && `${risk.length} at risk of running out`].filter(Boolean).join(' · ');
  const body = [...out.map((i) => `Out of stock: ${i.label}`), ...risk.map((i) => `At risk: ${i.label} — about ${i.daysOfStock} days left, ${i.leadTimeDays} days to arrive`)].slice(0, 6).join('\n');
  await notify(ids, title, body);
  return fresh.length;
}

// ---------------- Pricing (Inventory → Pricing) ----------------
export interface PriceListing {
  variantId: string; productId: string; inventoryItemId: string; label: string; priceCents: number | null;
  /** The retail store's Pro-pricing listing (see isProListing); its other listing is the direct-to-consumer one. */
  pro?: boolean;
}
export interface PriceRow {
  key: string; label: string; sku: string | null; costCents: number | null;
  /** Where the unit cost comes from: set in the CRM, or the Shopify listing's cost per item. */
  costFrom: 'crm' | 'shopify' | null;
  /** The salon's price in Square (null when it isn't sold in the salon). */
  square: { variationId: string; priceCents: number | null } | null;
  /** Each Shopify store's listings of it (a store can list one SKU more than once, e.g. stylist and salon prices). */
  shopify: PriceListing[]; shopify2: PriceListing[];
}

/**
 * Every product's unit cost and its price in each store: the salon (Square), and each Shopify store (e.g. stylist
 * pricing on the pro store, retail on the other). Read live from the stores.
 */
export async function priceList(): Promise<{ rows: PriceRow[]; stores: { square: string; shopify: string; shopify2: string | null }; errors: string[] }> {
  const L = await live(true);
  const errors: string[] = [];
  const read = async (which: 'shopify' | 'shopify2') => {
    const shop = which === 'shopify2' ? shopifyService2() : shopifyService();
    if (!shop) return new Map<string, PriceListing>();
    try {
      return new Map((await shop.listPrices()).map((p) => [p.inventoryItemId, p]));
    } catch (e) {
      errors.push(`${shopifyNameOf(which)}: ${(e as Error).message}`);
      return new Map<string, PriceListing>();
    }
  };
  const [p1, p2] = await Promise.all([read('shopify'), read('shopify2')]);
  const listing = (m: Map<string, PriceListing>, id: string | null, label?: string): PriceListing[] => {
    const p = id ? m.get(id) : undefined;
    return p ? [{ variantId: p.variantId, productId: p.productId, inventoryItemId: p.inventoryItemId, label: label ?? p.label, priceCents: p.priceCents, pro: isProListing(p) }] : [];
  };
  // As in proPricePlan: a listing only tagged pro isn't the Pro one when another listing of that SKU is named Pro.
  const proOnly = (list: PriceListing[]) => {
    const named = list.filter((l) => /\bpro\b/i.test(`${(p2.get(l.inventoryItemId) as { productTitle?: string } | undefined)?.productTitle ?? ''} ${l.label}`));
    return named.length ? list.map((l) => ({ ...l, pro: named.includes(l) })) : list;
  };
  // Unit cost: the CRM's, else the cost per item set on the Shopify listing (pro store first; $0 counts as not set).
  const shopifyCost = (r: (typeof L.rows)[number]) => [p1.get(r.shopifyInventoryItemId ?? ''), ...r.store2.map((e) => p2.get(e.inventoryItemId))]
    .map((p) => (p as { costCents?: number | null } | undefined)?.costCents).find((c) => c != null && c > 0) ?? null;
  const rows: PriceRow[] = L.rows.filter((r) => r.status !== 'not_tracked').map((r) => ({
    key: r.key, label: r.label, sku: r.sku, costCents: r.costCents ?? shopifyCost(r), costFrom: r.costCents != null ? 'crm' as const : shopifyCost(r) != null ? 'shopify' as const : null,
    square: r.squareVariationId ? { variationId: r.squareVariationId, priceCents: r.priceCents } : null,
    shopify: listing(p1, r.shopifyInventoryItemId),
    shopify2: proOnly(r.store2.flatMap((e) => listing(p2, e.inventoryItemId, e.label))),
  }));
  return { rows, stores: { square: storeNames().square, shopify: shopifyNameOf('shopify'), shopify2: shopifyService2() ? shopifyNameOf('shopify2') : null }, errors };
}

export interface PriceChange {
  key: string;
  costCents?: number | null;
  square?: number;
  shopify?: { variantId: string; productId: string; priceCents: number }[];
  shopify2?: { variantId: string; productId: string; priceCents: number }[];
}

/**
 * Saves price changes: unit cost in the CRM (and on each Shopify listing's inventory item, so Shopify's margins match),
 * Square prices, and each Shopify store's prices (grouped per product). Each store is tried separately; what didn't
 * save is listed so nothing is lost silently.
 */
export async function applyPrices(changes: PriceChange[], staffId: string | null) {
  const L = await live();
  const rowOf = new Map(L.rows.map((r) => [r.key, r]));
  const failed: { key: string; store: string; message: string }[] = [];
  let saved = 0;
  const sq = await squareService();
  const shops = { shopify: shopifyService(), shopify2: shopifyService2() };
  for (const c of changes) {
    const r = rowOf.get(c.key);
    if (!r) { failed.push({ key: c.key, store: 'CRM', message: 'That product is no longer in the stores.' }); continue; }
    if (c.costCents !== undefined) {
      await saveProductSettings([{ key: c.key, costCents: c.costCents }], staffId);
      saved++;
      for (const [which, ids] of [['shopify', r.shopifyInventoryItemId ? [r.shopifyInventoryItemId] : []], ['shopify2', r.store2.map((e) => e.inventoryItemId)]] as const) {
        const shop = shops[which];
        for (const id of ids) {
          try { await shop?.setUnitCost(id, c.costCents); } catch (e) { failed.push({ key: c.key, store: shopifyNameOf(which), message: `Cost: ${(e as Error).message}` }); }
        }
      }
    }
    if (c.square != null) {
      if (!sq || !r.squareVariationId) failed.push({ key: c.key, store: storeNames().square, message: 'Not sold in Square.' });
      else {
        try {
          await sq.setVariationPrice(r.squareVariationId, c.square, `price-${r.squareVariationId}-${c.square}-${Date.now().toString(36)}`);
          await db().query('UPDATE square_inventory SET price_cents = $2, updated_at = now() WHERE variation_id = $1', [r.squareVariationId, c.square]);
          saved++;
        } catch (e) {
          const m = (e as Error).message;
          failed.push({ key: c.key, store: storeNames().square, message: e instanceof IntegrationError && e.authProblem ? 'Square needs the ITEMS_WRITE permission to change prices.' : m });
        }
      }
    }
    for (const which of ['shopify', 'shopify2'] as const) {
      const list = c[which];
      if (!list?.length) continue;
      const shop = shops[which];
      if (!shop) { failed.push({ key: c.key, store: shopifyNameOf(which), message: 'That store isn’t connected.' }); continue; }
      const byProduct = new Map<string, { variantId: string; priceCents: number }[]>();
      for (const v of list) byProduct.set(v.productId, [...(byProduct.get(v.productId) ?? []), { variantId: v.variantId, priceCents: v.priceCents }]);
      for (const [productId, variants] of byProduct) {
        try { await shop.setPrices(productId, variants); saved += variants.length; } catch (e) { failed.push({ key: c.key, store: shopifyNameOf(which), message: (e as Error).message }); }
      }
    }
  }
  forgetStockCache();
  return { saved, failed };
}

/** A main-store listing sharing a SKU (e.g. PRO): its count when last set, so the sync can add its own sales. */
export async function markSibling(inventoryItemId: string, sku: string | null, label: string, qty: number) {
  await db().query(
    `INSERT INTO inventory_sync_extra(inventory_item_id, store, sku, label, synced_baseline) VALUES ($1,'shopify_sibling',$2,$3,$4)
     ON CONFLICT (inventory_item_id) DO UPDATE SET store = 'shopify_sibling', sku = $2, label = $3, synced_baseline = $4, updated_at = now()`, [inventoryItemId, sku, label, qty]);
}

// ---------------- Pro prices (Inventory → Pricing → Match Pro prices) ----------------
/** A Pro listing: "Pro" in its name, or the product tagged "professional" or "pro-pricing". */
export const isProListing = (p: { label: string; productTitle?: string; tags?: string[] }) =>
  /\bpro\b/i.test(`${p.productTitle ?? ''} ${p.label}`) || (p.tags ?? []).some((t) => ['professional', 'pro-pricing'].includes(t.trim().toLowerCase()));

/**
 * The retail store lists each product twice: retail and Pro. Its Pro listings should cost what the professional store
 * charges for the same SKU. Plans those changes only — nothing else is touched. The professional store is the one whose
 * address says "professional" (else the main store).
 */
export async function proPricePlan() {
  const { config } = await import('../config.js');
  const c = config();
  const s1 = shopifyService();
  const s2 = shopifyService2();
  if (!s1 || !s2) throw badRequest('Both Shopify stores need to be connected.');
  const proFirst = /professional/i.test(c.SHOPIFY_STORE_DOMAIN ?? '') || !/professional/i.test(c.SHOPIFY2_STORE_DOMAIN ?? '');
  const [pro, retail] = proFirst ? [s1, s2] : [s2, s1];
  const names = { pro: shopifyNameOf(proFirst ? 'shopify' : 'shopify2'), retail: shopifyNameOf(proFirst ? 'shopify2' : 'shopify') };
  const [proPrices, retailPrices] = await Promise.all([pro.listPrices(), retail.listPrices()]);
  const proBySku = new Map<string, Set<number>>();
  for (const p of proPrices) if (norm(p.sku) && p.priceCents != null) proBySku.set(norm(p.sku), new Set([...(proBySku.get(norm(p.sku)) ?? []), p.priceCents]));
  const changes: { variantId: string; productId: string; label: string; sku: string | null; fromCents: number | null; toCents: number }[] = [];
  const skipped: { label: string; sku: string | null; reason: string }[] = [];
  let same = 0;
  // "Pro" in the name is the surest sign. A tag only counts when the SKU has no listing named Pro in that store —
  // otherwise the tagged one is the retail listing (tagged by mistake) and its price is left alone.
  const namedPro = (p: { label: string; productTitle?: string }) => /\bpro\b/i.test(`${p.productTitle ?? ''} ${p.label}`);
  const skusWithNamedPro = new Set(retailPrices.filter(namedPro).map((p) => norm(p.sku)).filter(Boolean));
  for (const l of retailPrices.filter(isProListing)) {
    if (!namedPro(l) && skusWithNamedPro.has(norm(l.sku))) {
      skipped.push({ label: l.label, sku: l.sku, reason: 'Tagged professional / pro-pricing, but this SKU already has a listing named Pro — treated as the retail listing, not changed' });
      continue;
    }
    const prices = norm(l.sku) ? proBySku.get(norm(l.sku)) : undefined;
    if (!norm(l.sku)) { skipped.push({ label: l.label, sku: null, reason: 'No SKU' }); continue; }
    if (!prices?.size) { skipped.push({ label: l.label, sku: l.sku, reason: `SKU not found in ${names.pro}` }); continue; }
    if (prices.size > 1) { skipped.push({ label: l.label, sku: l.sku, reason: `${names.pro} has more than one price for this SKU (${[...prices].map((x) => `$${(x / 100).toFixed(2)}`).join(', ')})` }); continue; }
    const to = [...prices][0];
    if (l.priceCents === to) { same++; continue; }
    changes.push({ variantId: l.variantId, productId: l.productId, label: l.label, sku: l.sku, fromCents: l.priceCents, toCents: to });
  }
  return { proStore: names.pro, retailStore: names.retail, changes, skipped, alreadyMatching: same, retailService: retail };
}

/** Applies the plan (recomputed now, so it's never stale): only the Pro listings' prices in the retail store. */
export async function applyProPrices() {
  const plan = await proPricePlan();
  const byProduct = new Map<string, typeof plan.changes>();
  for (const ch of plan.changes) byProduct.set(ch.productId, [...(byProduct.get(ch.productId) ?? []), ch]);
  const failed: { label: string; message: string }[] = [];
  let saved = 0;
  for (const [productId, list] of byProduct) {
    try {
      await plan.retailService.setPrices(productId, list.map((x) => ({ variantId: x.variantId, priceCents: x.toCents })));
      saved += list.length;
    } catch (e) {
      for (const x of list) failed.push({ label: x.label, message: (e as Error).message });
    }
  }
  return { saved, failed, skipped: plan.skipped, alreadyMatching: plan.alreadyMatching };
}

// ---------------- Add a length (Inventory → Products → Add a length) ----------------
export interface NewLengthInput {
  /** Words the products' names must contain, e.g. "Clip-Ins". */
  search: string;
  /** The length to copy and the new one, e.g. 18 → 22: SKU "18-BMCI-120g" → "22-BMCI-120g", option "18 inch - 120g" → "22 inch - 120g". */
  from: string;
  to: string;
  /** Prices for the new variants (null: leave that store out). */
  prices: { pro: number | null; retail: number | null; retailPro: number | null; square: number | null };
}
type NewVariantPlan = { store: 'pro' | 'retail' | 'square'; label: string; fromSku: string; sku: string; option: string; priceCents: number; productId: string; options: { name: string; value: string }[]; pro?: boolean };

const swapLength = (text: string, from: string, to: string) => text.replace(new RegExp(`(^|[^0-9])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'g'), `$1${to}`);

/**
 * Plans a new length for products that already come in another one: for each matching variant whose SKU starts with
 * "<from>-", a "<to>-" variant with the same option values (the length swapped), in each store that sells it — the
 * professional store, the retail store's retail and Pro listings, and Square — at the prices given. Stock starts at 0.
 * Nothing is changed here.
 */
export async function newLengthPlan(input: NewLengthInput) {
  const { config } = await import('../config.js');
  const c = config();
  const s1 = shopifyService();
  const s2 = shopifyService2();
  const from = input.from.trim(); const to = input.to.trim();
  if (!/^[0-9]+$/.test(from) || !/^[0-9]+$/.test(to) || from === to) throw badRequest('Enter the length to copy and the new length as numbers, e.g. 18 and 22.');
  const words = input.search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) throw badRequest('Enter which products, e.g. Clip-Ins.');
  const proFirst = /professional/i.test(c.SHOPIFY_STORE_DOMAIN ?? '') || !/professional/i.test(c.SHOPIFY2_STORE_DOMAIN ?? '');
  const [pro, retail] = s1 && s2 ? (proFirst ? [s1, s2] : [s2, s1]) : [s1, null];
  const names = { pro: shopifyNameOf(proFirst ? 'shopify' : 'shopify2'), retail: s2 ? shopifyNameOf(proFirst ? 'shopify2' : 'shopify') : null, square: storeNames().square };
  const prefix = `${from}-`.toLowerCase();
  const newSkuOf = (sku: string) => `${to}-${sku.slice(prefix.length)}`;
  const matches = (text: string, sku: string | null) => !!sku && sku.toLowerCase().startsWith(prefix) && words.every((w) => text.toLowerCase().includes(w));
  const plan: NewVariantPlan[] = [];
  const skipped: { store: string; label: string; reason: string }[] = [];

  const shopifyPart = async (svc: NonNullable<typeof s1>, which: 'pro' | 'retail') => {
    const prices = await svc.listPrices();
    const have = new Set(prices.map((p) => norm(p.sku)).filter(Boolean));
    const hits = prices.filter((p) => matches(`${p.productTitle ?? ''} ${p.label}`, p.sku));
    const variants = new Map((await svc.productVariants([...new Set(hits.map((h) => h.productId))])).map((v) => [v.productId, v]));
    const named = (p: { label: string; productTitle?: string }) => /\bpro\b/i.test(`${p.productTitle ?? ''} ${p.label}`);
    const skusWithNamedPro = new Set(prices.filter(named).map((p) => norm(p.sku)));
    for (const h of hits) {
      const sku = newSkuOf(h.sku!);
      const isPro = which === 'retail' && (named(h) || (isProListing(h) && !skusWithNamedPro.has(norm(h.sku))));
      const price = which === 'pro' ? input.prices.pro : isPro ? input.prices.retailPro : input.prices.retail;
      const storeName = which === 'pro' ? names.pro : `${names.retail}${isPro ? ' (Pro listing)' : ''}`;
      if (price == null) continue;
      const source = variants.get(h.productId)?.variants.find((v) => norm(v.sku) === norm(h.sku));
      if (!source) { skipped.push({ store: storeName, label: h.label, reason: 'Couldn’t read its options' }); continue; }
      const options = source.options.map((o) => ({ name: o.name, value: swapLength(o.value, from, to) }));
      if (options.every((o, i) => o.value === source.options[i].value)) { skipped.push({ store: storeName, label: h.label, reason: `No option mentions ${from}` }); continue; }
      const taken = variants.get(h.productId)!.variants.some((v) => v.options.every((o, i) => o.value === options[i]?.value));
      if (have.has(norm(sku)) || taken) { skipped.push({ store: storeName, label: h.label, reason: `${sku} is already there` }); continue; }
      plan.push({ store: which, label: h.productTitle ?? h.label, fromSku: h.sku!, sku, option: options.map((o) => o.value).join(' / '), priceCents: price, productId: h.productId, options, pro: isPro });
    }
  };
  if (pro) await shopifyPart(pro, 'pro');
  if (retail) await shopifyPart(retail, 'retail');

  const sq = await squareService();
  if (sq && input.prices.square != null) {
    const products = await sq.listProducts();
    const have = new Set(products.map((p) => norm(p.sku)).filter(Boolean));
    for (const p of products.filter((x) => matches(`${x.itemName} ${x.variationName}`, x.sku))) {
      const sku = newSkuOf(p.sku!);
      const name = swapLength(p.variationName ?? '', from, to) || 'Regular';
      if (have.has(norm(sku))) { skipped.push({ store: names.square, label: p.itemName, reason: `${sku} is already there` }); continue; }
      plan.push({ store: 'square', label: p.itemName, fromSku: p.sku!, sku, option: name, priceCents: input.prices.square, productId: p.itemId, options: [] });
    }
  }
  return { stores: names, plan, skipped, services: { pro, retail, sq } };
}

/** Creates what newLengthPlan lists (worked out again now). Each store and product is tried separately. */
export async function applyNewLength(input: NewLengthInput) {
  const { plan, skipped, services } = await newLengthPlan(input);
  const failed: { label: string; store: string; message: string }[] = [];
  let created = 0;
  for (const which of ['pro', 'retail'] as const) {
    const svc = services[which];
    const mine = plan.filter((p) => p.store === which);
    if (!svc || !mine.length) continue;
    const loc = await svc.locationId();
    const byProduct = new Map<string, NewVariantPlan[]>();
    for (const p of mine) byProduct.set(p.productId, [...(byProduct.get(p.productId) ?? []), p]);
    for (const [productId, list] of byProduct) {
      try {
        created += (await svc.addVariants(productId, list.map((p) => ({ options: p.options, sku: p.sku, priceCents: p.priceCents })), loc)).length;
      } catch (e) {
        for (const p of list) failed.push({ label: p.label, store: which, message: (e as Error).message });
      }
    }
  }
  const sqPlan = plan.filter((p) => p.store === 'square');
  if (services.sq && sqPlan.length) {
    try {
      const made = await services.sq.addVariations(sqPlan.map((p) => ({ itemId: p.productId, name: p.option, sku: p.sku, priceCents: p.priceCents })), `add-len-${Date.now().toString(36)}`);
      created += made.length;
      const ok = new Set(made.map((m) => norm(m.sku)));
      for (const p of sqPlan) if (!ok.has(norm(p.sku))) failed.push({ label: p.label, store: 'square', message: 'Square didn’t confirm it' });
    } catch (e) {
      const msg = e instanceof IntegrationError && e.authProblem ? 'Square needs the ITEMS_WRITE permission to add variations.' : (e as Error).message;
      for (const p of sqPlan) failed.push({ label: p.label, store: 'square', message: msg });
    }
  }
  forgetStockCache();
  return { created, failed, skipped };
}

// ---------------- Add online products to Square (Inventory → Products → Add to Square) ----------------
/**
 * "Black Magic - Clip-Ins - 18 inch - 120g" → item "Black Magic Clip-Ins", variation `18" Clip-Ins`, category
 * "Addendum Hair Clip-Ins" — the way the salon's hair is set up in Square (e.g. "Aperol Spritz Redefined Weft" / 18" Weft).
 */
export function squareNamesFor(label: string) {
  const parts = label.split(/\s+[-–]\s+/).map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== 'default title');
  if (parts.length < 2) return { itemName: parts[0] ?? label, variationName: 'Regular', categoryName: null as string | null };
  const collection = parts[1].replace(/\bpro\b/i, '').trim();
  const inches = parts.slice(2).join(' ').match(/(\d+(?:\.\d+)?)\s*(?:inch|in\b|"|”)/i)?.[1];
  return {
    itemName: `${parts[0]} ${collection}`,
    variationName: inches ? `${inches}" ${collection}` : parts.slice(2).join(' ') || 'Regular',
    categoryName: `Addendum Hair ${collection}`,
  };
}

/** Online products not in Square yet, with suggested Square names and the retail price (the retail store's non-Pro listing). */
export async function squareCandidates() {
  const L = await live(true);
  const retail = shopifyService2();
  const retailPrices = retail ? await retail.listPrices().catch(() => []) : [];
  const own = shopifyService() ? await shopifyService()!.listPrices().catch(() => []) : [];
  const retailBySku = new Map<string, number>();
  for (const p of retailPrices) if (norm(p.sku) && p.priceCents != null && !isProListing(p) && !retailBySku.has(norm(p.sku))) retailBySku.set(norm(p.sku), p.priceCents);
  const ownByItem = new Map(own.map((p) => [p.inventoryItemId, p.priceCents]));
  const inSquare = new Set(L.products.map((p) => norm(p.sku)).filter(Boolean));
  return L.rows.filter((r) => !r.squareVariationId && r.shopifyInventoryItemId && norm(r.sku) && !inSquare.has(norm(r.sku))).map((r) => ({
    key: r.key, label: r.label, sku: r.sku!, onlineQty: r.shopifyQty,
    ...squareNamesFor(r.label),
    priceCents: retailBySku.get(norm(r.sku)) ?? ownByItem.get(r.shopifyInventoryItemId!) ?? null,
  }));
}

/**
 * Creates the chosen online products in Square (stock tracked), starts each at the online count and pairs it with its
 * Shopify product right away — so the first sync sees them in step and never copies a 0 across.
 */
export async function addToSquare(items: { key: string; itemName: string; variationName: string; categoryName: string | null; priceCents: number }[], staffId: string | null) {
  const sq = await squareService();
  const shop = shopifyService();
  if (!sq || !shop) throw badRequest('Square and Shopify both need to be connected.');
  const L = await live(true);
  if (!L.sqLoc || !L.shLoc) throw badRequest('The Square or Shopify location isn’t set up yet.');
  const byKey = new Map(L.rows.map((r) => [r.key, r]));
  const inSquare = new Set(L.products.map((p) => norm(p.sku)).filter(Boolean));
  const skipped: { label: string; reason: string }[] = [];
  const todo = items.flatMap((it) => {
    const r = byKey.get(it.key);
    if (!r?.shopifyInventoryItemId || !norm(r.sku)) { skipped.push({ label: r?.label ?? it.key, reason: 'Not found online, or no SKU' }); return []; }
    if (r.squareVariationId || inSquare.has(norm(r.sku))) { skipped.push({ label: r.label, reason: 'Already in Square' }); return []; }
    return [{ ...it, row: r }];
  });
  if (!todo.length) return { created: 0, skipped };
  let made: { sku: string; variationId: string }[];
  try {
    made = await sq.createItems(todo.map((t) => ({ itemName: t.itemName.trim(), variationName: t.variationName.trim(), sku: t.row.sku!, priceCents: t.priceCents, categoryName: t.categoryName?.trim() || null })), `add-sq-${Date.now().toString(36)}`);
  } catch (e) {
    throw e instanceof IntegrationError && e.authProblem ? new IntegrationError('square', 'Square needs the ITEMS_WRITE permission to add products.', false, true, e.technical) : e;
  }
  const idBySku = new Map(made.map((m) => [norm(m.sku), m.variationId]));
  const ready = todo.filter((t) => idBySku.has(norm(t.row.sku)));
  // Start at the online count (never below 0), then pair them with that count as the agreed one.
  const counts = ready.map((t) => ({ variationId: idBySku.get(norm(t.row.sku))!, locationId: L.sqLoc!, quantity: Math.max(0, t.row.shopifyQty ?? 0), occurredAt: new Date().toISOString(), referenceId: 'addendum-add-to-square' }));
  if (counts.length) await sq.setInventoryCounts(counts, `add-sq-count-${Date.now().toString(36)}`);
  for (const t of ready) {
    const vid = idBySku.get(norm(t.row.sku))!;
    const qty = t.row.shopifyQty ?? 0;
    await db().query(
      `INSERT INTO inventory_sync_links(sku, match_method, label, square_variation_id, square_location_id, shopify_inventory_item_id, shopify_location_id, baseline_quantity, status, last_square_quantity, last_shopify_quantity)
       VALUES ($1,'sku',$2,$3,$4,$5,$6,$7,'in_sync',$8,$9) ON CONFLICT DO NOTHING`,
      [t.row.sku, `${t.itemName} · ${t.variationName}`, vid, L.sqLoc, t.row.shopifyInventoryItemId, L.shLoc, qty >= 0 ? qty : null, Math.max(0, qty), qty]);
    await db().query(
      `INSERT INTO stock_txns(product_key, label, sku, kind, reason, note, square_after, shopify_before, shopify_after, staff_id) VALUES ($1,$2,$3,'import',$4,$5,$6,$7,$7,$8)`,
      [vid, `${t.itemName} · ${t.variationName}`, t.row.sku, 'Added to Square', `$${(t.priceCents / 100).toFixed(2)}${t.categoryName ? ` · ${t.categoryName}` : ''}`, Math.max(0, qty), t.row.shopifyQty, staffId]);
  }
  for (const t of todo) if (!idBySku.has(norm(t.row.sku))) skipped.push({ label: t.row.label, reason: 'Square didn’t confirm it' });
  forgetStockCache();
  return { created: ready.length, skipped };
}
