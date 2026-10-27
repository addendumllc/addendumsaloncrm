import { Router, type Request } from 'express';
import { can } from '../auth/permissions.js';
import { z } from 'zod';
import { requirePermission } from '../auth/session.js';
import {
  copyShopifySkuToSquare, editLinkedProduct, getRun, linkByIds, linkBySku, listLinks, listRuns, markSeparate, resolveLink, setProductKind, setShopifySync, skuCandidates, startInventorySync, syncOverview, unlink,
  unmarkSeparate,
} from '../domain/inventorySync.js';
import { addToSquare, confirmCounts, applyNewLength, applySwatches, moveSwatchesFirst, swatchPlan, applyPrices, applyProPrices, newLengthPlan, priceList, proPricePlan, squareCandidates,
  applyStockChanges, assignCollection, createPurchaseOrders, deleteLeadRule, setSupplierLeadDefault, leadRules, leadTimesFor, saveLeadRule, internalCollections, mergeSuppliers, renameCollection, saveCollectionList, productSales, skipProducts, suggestPurchaseOrders, suggestedOrderPlan, deletePurchaseOrder, forecastSettings, updatePoLine, addPoLines, removePoLine, setDefaultSupplier, forgetStockCache, listPurchaseOrders, listSuppliers, movePurchaseOrder, preorderReport, receivePurchaseOrder,
  assignSupplier, deleteSupplier, refreshShopifySales, renameSupplier, saveProductSettings, saveSupplier, setForecastSettings, setSupplierLeadTime, stockForecast, stockHistory, stockProducts, updatePurchaseOrder,
} from '../domain/stock.js';
import { setSquareSku } from '../domain/squareInventory.js';
import { ah, logAction, parse } from './util.js';

/** Square ↔ Shopify stock sync. Administrators only ("inventory:sync", enforced on the server). */
export const inventorySyncRouter = Router();
inventorySyncRouter.use(requirePermission('inventory:sync'));

inventorySyncRouter.get('/', ah(async (_req, res) => res.json(await syncOverview())));
inventorySyncRouter.get('/runs', ah(async (_req, res) => res.json({ runs: await listRuns() })));
inventorySyncRouter.get('/runs/:id', ah(async (req, res) => res.json({ run: await getRun(req.params.id) })));
inventorySyncRouter.get('/links', ah(async (req, res) => res.json({ links: await listLinks((req.query.status as string) || undefined) })));

/** Sync now. Returns straight away with the run; the screen polls /runs/:id for progress. */
inventorySyncRouter.post('/run', ah(async (req, res) => {
  const { onlyFailed } = parse(z.object({ onlyFailed: z.boolean().optional() }), req.body ?? {});
  const run = await startInventorySync({ trigger: onlyFailed ? 'retry' : 'manual', staffId: req.user!.id, onlyFailed });
  await logAction(req, 'inventory_sync.run', 'inventory_sync', run.id, { onlyFailed: !!onlyFailed });
  res.status(202).json({ run });
}));

/** Changes one product's SKU in Square. */
inventorySyncRouter.put('/products/:variationId/square-sku', ah(async (req, res) => {
  const { sku } = parse(z.object({ sku: z.string().trim().min(1, 'enter a SKU').max(120) }), req.body);
  const r = await setSquareSku(String(req.params.variationId), sku, req.user!.id);
  await logAction(req, 'inventory_sync.square_sku', 'square_inventory', String(req.params.variationId), { sku: r.sku, previous: r.previousSku ?? null });
  res.json(r);
}));

/** Product types: shared stock with Shopify, separate salon-floor stock, salon only, or add-on service. */
inventorySyncRouter.put('/products/kind', ah(async (req, res) => {
  const b = parse(z.object({ variationIds: z.array(z.string().min(1).max(64)).min(1, 'choose at least one product').max(500), kind: z.enum(['shared', 'separate', 'salon_only', 'service']) }), req.body);
  await setProductKind(b.variationIds, b.kind, req.user!.id);
  forgetStockCache();
  await logAction(req, 'inventory_sync.product_kind', 'square_inventory', b.variationIds.length === 1 ? b.variationIds[0] : null, { kind: b.kind, products: b.variationIds.length });
  res.json({ ok: true });
}));

/** Per-product "Sync to Shopify" on/off. Saves the choice only: stock is never written by changing it. */
inventorySyncRouter.put('/products/shopify-sync', ah(async (req, res) => {
  const b = parse(z.object({ variationIds: z.array(z.string().min(1).max(64)).min(1, 'choose at least one product').max(500), enabled: z.boolean() }), req.body);
  await setShopifySync(b.variationIds, b.enabled, req.user!.id);
  await logAction(req, 'inventory_sync.shopify_sync', 'square_inventory', b.variationIds.length === 1 ? b.variationIds[0] : null, { enabled: b.enabled, products: b.variationIds.length });
  res.json({ ok: true });
}));

inventorySyncRouter.post('/links/:id/resolve', ah(async (req, res) => {
  const { use } = parse(z.object({ use: z.enum(['square', 'shopify']) }), req.body);
  const link = await resolveLink(req.params.id, use, req.user!.id);
  await logAction(req, 'inventory_sync.resolve', 'inventory_sync_link', req.params.id, { use });
  res.json({ link });
}));

/** Edit a paired product's SKU and/or stock count in both Square and Shopify. */
inventorySyncRouter.patch('/links/:id/product', ah(async (req, res) => {
  const b = parse(z.object({ sku: z.string().trim().min(1, 'enter a SKU').max(120).optional(), quantity: z.number().int().min(0).max(100_000).optional() })
    .refine((x) => x.sku !== undefined || x.quantity !== undefined, 'change the SKU or the stock count'), req.body);
  const r = await editLinkedProduct(req.params.id, b);
  await logAction(req, 'inventory_sync.edit_product', 'inventory_sync_link', req.params.id, { sku: b.sku ?? null, quantity: b.quantity ?? null, ...r, link: undefined });
  res.json(r);
}));

inventorySyncRouter.post('/links', ah(async (req, res) => {
  const b = parse(z.object({ squareSku: z.string().trim().min(1).max(120), shopifySku: z.string().trim().min(1).max(120) }), req.body);
  await linkBySku(b.squareSku, b.shopifySku);
  await logAction(req, 'inventory_sync.link', 'inventory_sync', null, { squareSku: b.squareSku, shopifySku: b.shopifySku });
  res.status(201).json({ ok: true });
}));

/** Pairs two products picked from the "Not matched" lists, as they are. */
inventorySyncRouter.post('/links/by-id', ah(async (req, res) => {
  const b = parse(z.object({ squareVariationId: z.string().trim().min(1).max(64), shopifyInventoryItemId: z.string().trim().min(1).max(120) }), req.body);
  const r = await linkByIds(b.squareVariationId, b.shopifyInventoryItemId);
  await logAction(req, 'inventory_sync.link', 'inventory_sync', null, b);
  res.status(201).json(r);
}));

/** Unpaired products on each side, to copy a Shopify SKU onto a Square product. */
inventorySyncRouter.get('/sku-candidates', ah(async (_req, res) => res.json(await skuCandidates())));

/** Sets the Square product's SKU to the Shopify product's SKU (in Square) and pairs them. */
inventorySyncRouter.post('/links/from-shopify-sku', ah(async (req, res) => {
  const b = parse(z.object({ squareVariationId: z.string().trim().min(1).max(64), shopifyInventoryItemId: z.string().trim().min(1).max(120) }), req.body);
  const r = await copyShopifySkuToSquare(b.squareVariationId, b.shopifyInventoryItemId);
  await logAction(req, 'inventory_sync.square_sku_from_shopify', 'square_inventory', b.squareVariationId, { sku: r.sku, previousSku: r.previousSku, changedInSquare: r.changedInSquare });
  res.status(201).json(r);
}));

/** Mark unpaired products as sold in one store only (hidden from "Not matched"; a matching SKU still pairs them). */
const store = z.enum(['square', 'shopify']);
inventorySyncRouter.post('/separate', ah(async (req, res) => {
  const { items } = parse(z.object({
    items: z.array(z.object({ store, itemId: z.string().trim().min(1).max(120), label: z.string().trim().max(300).default(''), sku: z.string().trim().max(120).nullable().default(null) }))
      .min(1, 'choose at least one product').max(500),
  }), req.body);
  await markSeparate(items, req.user!.id);
  await logAction(req, 'inventory_sync.keep_separate', 'inventory_sync', items.length === 1 ? items[0].itemId : null, { products: items.length, stores: [...new Set(items.map((i) => i.store))] });
  res.json({ ok: true });
}));

inventorySyncRouter.delete('/separate/:store/:itemId', ah(async (req, res) => {
  const s = parse(store, req.params.store);
  await unmarkSeparate(s, req.params.itemId);
  await logAction(req, 'inventory_sync.sync_again', 'inventory_sync', req.params.itemId, { store: s });
  res.json({ ok: true });
}));

inventorySyncRouter.delete('/links/:id', ah(async (req, res) => {
  await unlink(req.params.id);
  await logAction(req, 'inventory_sync.unlink', 'inventory_sync_link', req.params.id);
  res.json({ ok: true });
}));

// ---------------- Inventory tools (from Addendum-Stockline) ----------------
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const intOrNull = (max: number) => z.number().int().min(0).max(max).nullable().optional();

/** Every product in Square and Shopify, with stock in each and ordering details. */
inventorySyncRouter.get('/stock/products', ah(async (_req, res) => res.json(await stockProducts())));

// Internal collections: the salon's own list, renamed or removed everywhere, and products put into one (with a preview).
inventorySyncRouter.get('/stock/collections', ah(async (_req, res) => res.json(await internalCollections())));
inventorySyncRouter.put('/stock/collections', ah(async (req, res) => {
  const b = parse(z.object({ names: z.array(z.string().trim().min(1).max(120)).max(200) }), req.body);
  await saveCollectionList(b.names);
  res.json(await internalCollections());
}));
inventorySyncRouter.post('/stock/collections/rename', ah(async (req, res) => {
  const b = parse(z.object({ from: z.string().min(1).max(120), to: z.string().trim().max(120).nullable() }), req.body);
  await renameCollection(b.from, b.to, req.user!.id);
  await logAction(req, 'stock.collection_rename', 'stock', null, b);
  res.json(await internalCollections());
}));
inventorySyncRouter.post('/stock/collections/assign', ah(async (req, res) => {
  const b = parse(z.object({
    collection: z.string().trim().max(120).nullable(), keys: z.array(z.string().min(1).max(200)).max(5000).optional(), storeCollection: z.string().max(200).optional(),
    nameContains: z.string().max(100).optional(), skuStarts: z.string().max(40).optional(), skuContains: z.string().max(40).optional(), onlyWithout: z.boolean().optional(), preview: z.boolean().optional(),
  }), req.body);
  const r = await assignCollection(b, req.user!.id);
  if (!b.preview) await logAction(req, 'stock.collection_assign', 'stock', null, { collection: b.collection, count: r.count });
  res.json(r);
}));
// To order → Skip: not going to order these (until a date, or until turned back on with until = null).
inventorySyncRouter.put('/stock/products/skip', ah(async (req, res) => {
  const b = parse(z.object({ keys: z.array(z.string().min(1).max(200)).min(1).max(1000), until: ymd.nullable() }), req.body);
  await skipProducts(b.keys, b.until, req.user!.id);
  await logAction(req, 'stock.skip', 'stock', null, { products: b.keys.length, until: b.until });
  res.json({ ok: true });
}));
inventorySyncRouter.put('/stock/products/settings', ah(async (req, res) => {
  const b = parse(z.object({ rows: z.array(z.object({
    key: z.string().min(1).max(200), supplier: z.string().max(120).nullable().optional(), costCents: intOrNull(10_000_000), leadTimeDays: intOrNull(730),
    safetyDays: intOrNull(365), moq: intOrNull(1_000_000), caseSize: z.number().int().min(1).max(100_000).nullable().optional(),
    status: z.enum(['active', 'discontinued', 'not_tracked']).optional(),
    shippingDays: intOrNull(365), supplierSku: z.string().trim().max(80).nullable().optional(), orderNote: z.string().trim().max(500).nullable().optional(),
    collection: z.string().trim().max(120).nullable().optional(),
  })).min(1).max(5000) }), req.body);
  await saveProductSettings(b.rows, req.user!.id);
  await logAction(req, 'stock.product_settings', 'stock', null, { count: b.rows.length });
  res.json({ ok: true });
}));

/** SKU and stock changes for many products, applied to Square and Shopify together and logged. */
inventorySyncRouter.post('/stock/apply', ah(async (req, res) => {
  const b = parse(z.object({
    kind: z.enum(['count', 'adjust', 'import', 'sku']),
    reason: z.string().trim().max(80).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
    changes: z.array(z.object({
      key: z.string().min(1).max(200), sku: z.string().trim().min(1).max(120).optional(),
      quantity: z.number().int().min(0).max(1_000_000).optional(), delta: z.number().int().min(-1_000_000).max(1_000_000).optional(),
      onlineQuantity: z.number().int().min(0).max(1_000_000).optional(),
    }).refine((c) => c.sku !== undefined || c.quantity !== undefined || c.delta !== undefined || c.onlineQuantity !== undefined, 'change the SKU or the stock')).min(1).max(5000),
  }), req.body);
  const r = await applyStockChanges(b.changes, { kind: b.kind, reason: b.reason ?? null, note: b.note ?? null, staffId: req.user!.id });
  await logAction(req, `stock.${b.kind}`, 'stock', null, { products: b.changes.length, changed: r.changed, reason: b.reason ?? null });
  res.json(r);
}));

// One product's sales: 7/30/90 days and 12 months, month by month and by store (follows the SKU).
inventorySyncRouter.get('/stock/products/:key/sales', ah(async (req, res) => res.json(await productSales(req.params.key))));
inventorySyncRouter.get('/stock/history', ah(async (req, res) => {
  const q = parse(z.object({ key: z.string().max(200).optional(), kind: z.string().max(20).optional(), q: z.string().max(100).optional(), from: ymd.optional(), to: ymd.optional() }), req.query);
  res.json({ entries: await stockHistory(q) });
}));

// Pre-orders: what customers are waiting for, what's on order (backordered) and what's still to order.
inventorySyncRouter.get('/stock/preorders', ah(async (_req, res) => res.json(await preorderReport())));

// Pricing: unit cost and each store's price (salon Square, each Shopify store), changed in one place.
inventorySyncRouter.get('/stock/prices', ah(async (_req, res) => res.json(await priceList())));
// Online products not in Square yet: create them there (stock tracked, starting at the online count, paired right away).
inventorySyncRouter.get('/stock/to-square', ah(async (_req, res) => res.json({ products: await squareCandidates() })));
inventorySyncRouter.post('/stock/to-square', ah(async (req, res) => {
  const { items } = parse(z.object({ items: z.array(z.object({
    key: z.string().min(1).max(200), itemName: z.string().trim().min(1).max(255), variationName: z.string().trim().min(1).max(255),
    categoryName: z.string().trim().max(255).nullable(), priceCents: z.number().int().min(0).max(10_000_000),
  })).min(1).max(200) }), req.body);
  const r = await addToSquare(items, req.user!.id);
  await logAction(req, 'stock.add_to_square', 'stock', null, { created: r.created, skipped: r.skipped.length });
  res.json(r);
}));
const cents = z.number().int().min(0).max(10_000_000);
// Add a length (e.g. 22" next to 18"): preview, then create, in every store that sells the product. Stock starts at 0.
const newLengthBody = z.object({
  search: z.string().trim().min(1).max(100), from: z.string().trim().regex(/^[0-9]{1,3}$/), to: z.string().trim().regex(/^[0-9]{1,3}$/),
  prices: z.object({ pro: cents.nullable(), retail: cents.nullable(), retailPro: cents.nullable(), square: cents.nullable() }),
});
inventorySyncRouter.post('/stock/new-length/preview', ah(async (req, res) => {
  const { services: _s, ...plan } = await newLengthPlan(parse(newLengthBody, req.body));
  res.json({ ...plan, plan: plan.plan.map(({ options: _o, productId: _p, ...p }) => p) });
}));
inventorySyncRouter.post('/stock/new-length', ah(async (req, res) => {
  const r = await applyNewLength(parse(newLengthBody, req.body));
  await logAction(req, 'stock.new_length', 'stock', null, { created: r.created, failed: r.failed.length });
  res.json(r);
}));
// A sample swatch for each matching product (e.g. Clip-Ins): preview, then create. Prices can wait (see SwatchInput).
const swatchBody = z.object({
  search: z.string().trim().min(1).max(100), stores: z.object({ pro: z.boolean(), retail: z.boolean(), square: z.boolean() }),
  prices: z.object({ pro: cents.nullable(), retail: cents.nullable(), retailPro: cents.nullable(), square: cents.nullable() }),
});
inventorySyncRouter.post('/stock/swatches/preview', ah(async (req, res) => {
  const { services: _s, ...plan } = await swatchPlan(parse(swatchBody, req.body));
  res.json({ ...plan, plan: plan.plan.map(({ options: _o, productId: _p, ...p }) => ({ ...p, priceCents: p.priceCents < 0 ? null : p.priceCents })) });
}));
inventorySyncRouter.post('/stock/swatches/to-top', ah(async (req, res) => {
  const r = await moveSwatchesFirst();
  await logAction(req, 'stock.swatches_top', 'stock', null, { moved: r.moved, failed: r.failed.length });
  res.json(r);
}));
inventorySyncRouter.post('/stock/swatches', ah(async (req, res) => {
  const r = await applySwatches(parse(swatchBody, req.body));
  await logAction(req, 'stock.swatches', 'stock', null, { created: r.created, failed: r.failed.length });
  res.json(r);
}));
// Pro listings in the retail store take the professional store's price for the same SKU (preview, then apply).
inventorySyncRouter.get('/stock/prices/pro', ah(async (_req, res) => {
  const { retailService: _s, ...plan } = await proPricePlan();
  res.json(plan);
}));
inventorySyncRouter.post('/stock/prices/pro', ah(async (req, res) => {
  const r = await applyProPrices();
  await logAction(req, 'stock.pro_prices', 'stock', null, { saved: r.saved, failed: r.failed.length });
  res.json(r);
}));
const variantPrices = z.array(z.object({ variantId: z.string().min(1).max(200), productId: z.string().min(1).max(200), priceCents: cents })).max(20);
inventorySyncRouter.put('/stock/prices', ah(async (req, res) => {
  const { changes } = parse(z.object({ changes: z.array(z.object({
    key: z.string().min(1).max(200), costCents: cents.nullable().optional(), square: cents.optional(), shopify: variantPrices.optional(), shopify2: variantPrices.optional(),
  })).min(1).max(500) }), req.body);
  const r = await applyPrices(changes, req.user!.id);
  await logAction(req, 'stock.prices', 'stock', null, { products: changes.length, saved: r.saved, failed: r.failed.length });
  res.json(r);
}));
inventorySyncRouter.get('/stock/forecast', ah(async (_req, res) => res.json(await stockForecast())));
inventorySyncRouter.put('/stock/forecast/settings', ah(async (req, res) => {
  const b = parse(z.object({ leadTimeDays: z.number().int().min(0).max(730), safetyDays: z.number().int().min(0).max(365), coverageDays: z.number().int().min(7).max(365), slowToUseDays: z.number().int().min(7).max(730).default(120),
    soonDays: z.number().int().min(0).max(180).default(7), watchDays: z.number().int().min(0).max(365).default(21), defaultMoq: z.number().int().min(0).max(100_000).default(0), collectionLeadConflict: z.enum(['longest', 'shortest']).default('longest'),
    discontinuedCollections: z.array(z.string().trim().min(1).max(80)).max(50).default(['Classic']),
    recountAt: z.number().int().min(0).max(1000).default(3), recountCollections: z.array(z.string().trim().min(1).max(200)).max(100).default([]) }).refine((x) => x.watchDays >= x.soonDays, 'the Watch window must be at least the Reorder soon window'), req.body);
  await setForecastSettings(b);
  res.json({ settings: await forecastSettings() });
}));
// Recount: the number was right (records a count without changing stock), which clears the Recount flag.
inventorySyncRouter.post('/stock/recounted', ah(async (req, res) => {
  const b = parse(z.object({ keys: z.array(z.string().min(1).max(200)).min(1).max(500) }), req.body);
  const r = await confirmCounts(b.keys, req.user!.id);
  await logAction(req, 'stock.recounted', 'stock', null, { products: r.counted });
  res.json(r);
}));
inventorySyncRouter.post('/stock/sales/refresh', ah(async (_req, res) => {
  await refreshShopifySales(true);
  res.json(await stockForecast());
}));

inventorySyncRouter.get('/stock/purchase-orders', ah(async (_req, res) => res.json({ orders: await listPurchaseOrders() })));
const poLines = z.array(z.object({
  productKey: z.string().min(1).max(200), quantity: z.number().int().min(1).max(1_000_000), costCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(730).nullable().optional(),
})).max(1000);
inventorySyncRouter.post('/stock/purchase-orders', ah(async (req, res) => {
  const b = parse(z.object({ lines: poLines.min(1), supplier: z.string().trim().max(120).nullable().optional(), suppliers: z.array(z.string().trim().min(1).max(120)).max(20).optional(), store: z.enum(['salon', 'shopify']).optional() }), req.body);
  const orders = await createPurchaseOrders(b.lines, req.user!.id, b.supplier, b.store, b.suppliers);
  await logAction(req, 'stock.po_create', 'purchase_order', orders[0]?.id ?? null, { orders: orders.map((o) => o.number) });
  res.status(201).json({ orders });
}));
const suggestBy = z.enum(['collection', 'length', 'collection_length']).catch('collection');
// Suggested orders: a draft per collection with what needs ordering (replaces earlier suggested drafts for the store).
inventorySyncRouter.get('/stock/purchase-orders/suggest', ah(async (req, res) => {
  const store = (['salon', 'shopify'] as const).find((s) => s === req.query.store) ?? 'all';
  res.json({ groups: await suggestedOrderPlan(store, suggestBy.parse(req.query.groupBy ?? 'collection')) });
}));
inventorySyncRouter.post('/stock/purchase-orders/suggest', ah(async (req, res) => {
  const b = parse(z.object({
    store: z.enum(['salon', 'shopify', 'all']).default('all'), groupBy: suggestBy.default('collection'),
    groups: z.array(z.object({ collection: z.string().min(1).max(120), lines: z.array(z.object({ productKey: z.string().min(1).max(200), quantity: z.number().int().min(0).max(100_000) })).max(500) })).max(200).optional(),
  }), req.body ?? {});
  const orders = await suggestPurchaseOrders(b.store, req.user!.id, b.groups, b.groupBy);
  await logAction(req, 'stock.po_suggest', 'purchase_order', null, { orders: orders.map((o) => o.number), store: b.store });
  res.status(201).json({ orders });
}));
inventorySyncRouter.patch('/stock/purchase-orders/:id', ah(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().max(80).nullable().optional(), lotNumber: z.string().trim().max(40).nullable().optional(),
    supplier: z.string().trim().max(500).nullable().optional(), status: z.enum(['draft', 'ordered', 'shipped', 'cancelled']).optional(),
    expectedOn: ymd.nullable().optional(), note: z.string().trim().max(1000).nullable().optional(), lines: poLines.min(1).optional(),
  }), req.body);
  const order = await updatePurchaseOrder(req.params.id, b);
  await logAction(req, 'stock.po_update', 'purchase_order', req.params.id, { status: b.status ?? null });
  res.json({ order });
}));
/** One item: its lead time (a draft), or its expected arrival date (once ordered). */
inventorySyncRouter.patch('/stock/purchase-orders/:id/lines/:lineId', ah(async (req, res) => {
  const b = parse(z.object({
    leadTimeDays: z.number().int().min(0).max(730).nullable().optional(), expectedOn: ymd.nullable().optional(),
    quantity: z.number().int().min(1).max(1_000_000).optional(), costCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
    lotNote: z.string().max(500).nullable().optional(),
  }), req.body);
  res.json({ order: await updatePoLine(req.params.id, req.params.lineId, b) });
}));
inventorySyncRouter.post('/stock/purchase-orders/:id/lines', ah(async (req, res) => {
  const b = parse(z.object({ lines: poLines.min(1) }), req.body);
  res.json({ order: await addPoLines(req.params.id, b.lines) });
}));
inventorySyncRouter.delete('/stock/purchase-orders/:id/lines/:lineId', ah(async (req, res) => {
  res.json({ order: await removePoLine(req.params.id, req.params.lineId) });
}));
inventorySyncRouter.delete('/stock/purchase-orders/:id', ah(async (req, res) => {
  await deletePurchaseOrder(req.params.id);
  await logAction(req, 'stock.po_delete', 'purchase_order', req.params.id);
  res.json({ ok: true });
}));
// Move an order to the other store (made in the wrong one), optionally moving units already received.
inventorySyncRouter.post('/stock/purchase-orders/:id/move', ah(async (req, res) => {
  const b = parse(z.object({ store: z.enum(['salon', 'shopify']), moveStock: z.boolean().default(false) }), req.body);
  const r = await movePurchaseOrder(req.params.id, b.store, b.moveStock, req.user!.id);
  await logAction(req, 'stock.po_move', 'purchase_order', req.params.id, { store: b.store, movedUnits: r.movedUnits, notMoved: r.notMoved.length });
  res.json(r);
}));
inventorySyncRouter.post('/stock/purchase-orders/:id/receive', ah(async (req, res) => {
  const b = parse(z.object({ lines: z.array(z.object({ lineId: z.string().uuid(), quantity: z.number().int().min(0).max(1_000_000) })).min(1), note: z.string().trim().max(500).nullable().optional() }), req.body);
  const r = await receivePurchaseOrder(req.params.id, b.lines, req.user!.id, b.note ?? null);
  await logAction(req, 'stock.po_receive', 'purchase_order', req.params.id, { changed: r.result.changed });
  res.json(r);
}));

// Suppliers: lead time quoted vs actual.
// Company names and contacts only for "See supplier company names and contacts"; everyone else sees the shown names.
const supplierDetails = (req: Request) => can(req.user, 'suppliers:details');
inventorySyncRouter.get('/stock/suppliers', ah(async (req, res) => {
  const all = await listSuppliers();
  res.json({
    suppliers: supplierDetails(req) ? all : all.map((s) => ({ ...s, companyName: null, email: null, phone: null, website: null, notes: null })),
    canSeeDetails: supplierDetails(req),
  });
}));
// Merge a duplicate supplier into another: products, orders and items move over; no product's timing changes.
inventorySyncRouter.post('/stock/suppliers/merge', ah(async (req, res) => {
  const b = parse(z.object({ from: z.string().min(1).max(120), into: z.string().min(1).max(120) }), req.body);
  await mergeSuppliers(b.from, b.into, req.user!.id);
  await logAction(req, 'stock.supplier_merge', 'stock', null, { from: b.from, into: b.into });
  res.json({ ok: true });
}));
// Lead times: the supplier's default, collection rules and products' own times (product → collection → default).
inventorySyncRouter.get('/stock/suppliers/lead-times', ah(async (req, res) => res.json(await leadTimesFor(parse(z.object({ name: z.string().min(1).max(120) }), req.query).name))));
// The supplier's default lead and shipping times only (contacts and the rest aren't touched).
inventorySyncRouter.put('/stock/suppliers/lead-default', ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().min(1).max(120), leadTimeDays: z.number().int().min(0).max(730).nullable(), shippingDays: z.number().int().min(0).max(365).nullable() }), req.body);
  await setSupplierLeadDefault(b.name, b.leadTimeDays, b.shippingDays);
  await logAction(req, 'stock.supplier_lead_default', 'stock', null, b);
  res.json({ ok: true });
}));
inventorySyncRouter.post('/stock/suppliers/lead-rules', ah(async (req, res) => {
  const b = parse(z.object({
    id: z.string().uuid().optional(), supplier: z.string().min(1).max(120), ref: z.string().min(3).max(300), label: z.string().trim().min(1).max(200),
    productionDays: z.number().int().min(0).max(730), shippingDays: z.number().int().min(0).max(365).nullable(), active: z.boolean().default(true), notes: z.string().trim().max(500).nullable().default(null),
  }), req.body);
  await saveLeadRule(b);
  await logAction(req, 'stock.lead_rule_save', 'stock', null, { supplier: b.supplier, collection: b.label, days: b.productionDays });
  res.json({ rules: await leadRules(b.supplier) });
}));
inventorySyncRouter.delete('/stock/suppliers/lead-rules/:id', ah(async (req, res) => {
  await deleteLeadRule(req.params.id);
  await logAction(req, 'stock.lead_rule_delete', 'stock', null, { id: req.params.id });
  res.json({ ok: true });
}));
inventorySyncRouter.put('/stock/suppliers/lead-time', ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().min(1).max(120), days: z.number().int().min(0).max(730) }), req.body);
  const n = await setSupplierLeadTime(b.name, b.days, req.user!.id);
  await logAction(req, 'stock.supplier_lead_time', 'stock', null, { supplier: b.name, days: b.days, products: n });
  res.json({ products: n });
}));
const supplierBody = z.object({
  name: z.string().trim().min(1, 'enter the supplier’s name').max(120), companyName: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().max(200).nullable().optional(),
  phone: z.string().trim().max(60).nullable().optional(), website: z.string().trim().max(300).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(), leadTimeDays: z.number().int().min(0).max(730).nullable().optional(),
  leadUntracked: z.boolean().optional(), shippingDays: z.number().int().min(0).max(365).nullable().optional(), defaultMoq: z.number().int().min(1).max(100_000).nullable().optional(),
});
inventorySyncRouter.post('/stock/suppliers', ah(async (req, res) => {
  const b = parse(supplierBody, req.body);
  await saveSupplier(b, null, req.user!.id, supplierDetails(req));
  await logAction(req, 'stock.supplier_add', 'stock', null, { supplier: b.name });
  res.status(201).json({ ok: true });
}));
inventorySyncRouter.put('/stock/suppliers/details', ah(async (req, res) => {
  const b = parse(supplierBody.extend({ previous: z.string().min(1).max(120) }), req.body);
  await saveSupplier(b, b.previous, req.user!.id, supplierDetails(req));
  await logAction(req, 'stock.supplier_edit', 'stock', null, { supplier: b.name, previous: b.previous });
  res.json({ ok: true });
}));
inventorySyncRouter.put('/stock/suppliers/default', ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().min(1).max(120).nullable() }), req.body);
  await setDefaultSupplier(b.name);
  await logAction(req, 'stock.supplier_default', 'stock', null, { supplier: b.name });
  res.json({ ok: true });
}));
inventorySyncRouter.post('/stock/suppliers/remove', ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().min(1).max(120) }), req.body);
  await deleteSupplier(b.name, req.user!.id);
  await logAction(req, 'stock.supplier_remove', 'stock', null, { supplier: b.name });
  res.json({ ok: true });
}));
/** Give products a supplier: chosen products, or every product in a store. */
inventorySyncRouter.put('/stock/suppliers/assign', ah(async (req, res) => {
  const b = parse(z.union([
    z.object({ supplier: z.string().min(1).max(120), keys: z.array(z.string().min(1).max(200)).min(1, 'choose at least one product').max(5000) }),
    z.object({ supplier: z.string().min(1).max(120), store: z.enum(['square', 'shopify', 'shopify2', 'all']), onlyWithout: z.boolean() }),
  ]), req.body);
  const n = await assignSupplier(b, req.user!.id);
  await logAction(req, 'stock.supplier_assign', 'stock', null, { supplier: b.supplier, products: n, store: 'store' in b ? b.store : null });
  res.json({ products: n });
}));
inventorySyncRouter.put('/stock/suppliers/rename', ah(async (req, res) => {
  const b = parse(z.object({ from: z.string().min(1).max(120), to: z.string().trim().min(1).max(120) }), req.body);
  await renameSupplier(b.from, b.to, req.user!.id);
  await logAction(req, 'stock.supplier_rename', 'stock', null, b);
  res.json({ ok: true });
}));
