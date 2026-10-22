import { Router } from 'express';
import { IntegrationError } from '../lib/errors.js';
import { z } from 'zod';
import { can } from '../auth/permissions.js';
import { requirePermission } from '../auth/session.js';
import { forbidden } from '../lib/errors.js';
import {
  createInventoryRequest, getInventoryRequest, inventorySuggestions, listInventoryRequests, sendInventoryEmail, setInventoryStatus,
  updateInventoryItem, shopifyHairProducts } from '../domain/inventory.js';
import { inventorySyncStatus, pushInventoryToShopify, searchSquareInventory, syncSquareInventory } from '../domain/squareInventory.js';
import { storeNames } from '../integrations/registry.js';
import { ah, logAction, parse } from './util.js';

/**
 * Order Hair: Addendum Hair order requests.
 * Everyone signed in can request; staff see their own; owners/managers ("inventory:manage") see all
 * and move requests to Ordered / Received. Square inventory search is open to the same people; pushing
 * stock counts to Shopify is for administrators only ("shopify:push").
 */
export const inventoryRouter = Router();

const manages = (req: any) => can(req.user, 'inventory:manage');
/** Receptionists see every order (and can order for a stylist); stylists only their own. */
const seesAll = (req: any) => manages(req) || can(req.user, 'inventory:read_all');

inventoryRouter.use((req, _res, next) => {
  // Products and stock: inventory:view. Hair orders: ordering, or seeing everyone's orders.
  const ok = req.path === '/store-names' ? true : req.path.startsWith('/products')
    ? can(req.user, 'inventory:view') || manages(req)
    : can(req.user, 'inventory:order') || seesAll(req);
  if (!ok) return next(forbidden());
  next();
});

inventoryRouter.get('/requests', ah(async (req, res) => {
  const all = seesAll(req) && req.query.scope !== 'mine';
  res.json({
    requests: await listInventoryRequests({ forStaffId: all ? undefined : req.user!.id, status: (req.query.status as string) || undefined }),
    canManage: manages(req),
    seesAll: seesAll(req),
  });
}));

inventoryRouter.get('/suggestions', ah(async (_req, res) => res.json(await inventorySuggestions())));

inventoryRouter.get('/requests/:id', ah(async (req, res) => {
  const r = await getInventoryRequest(req.params.id);
  if (!seesAll(req) && !mine(r, req.user!.id)) throw forbidden();
  res.json({ request: r });
}));

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date').nullable().or(z.literal('').transform(() => null));

const itemSchema = z.object({
  // Picked from Shopify inventory (the server looks it up) — or typed by hand with a collection name.
  sku: z.string().trim().max(120).optional().nullable(),
  collection: z.string().trim().max(160).optional().nullable().transform((v) => v ?? ''),
  size: z.string().trim().max(80).optional().nullable(),
  color: z.string().trim().max(120).optional().nullable(),
  quantity: z.coerce.number().int().min(1).max(999),
  neededBy: dateField.optional(),
  clientId: z.string().uuid().optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
});

/** Shopify hair inventory for the order form (search by SKU or name). Read-only. */
inventoryRouter.get('/shopify-products', ah(async (req, res) => {
  try {
    res.json(await shopifyHairProducts(req.query.fresh === 'true'));
  } catch (e) {
    res.json({ connected: true, products: [], error: e instanceof IntegrationError ? e.userMessage : 'Shopify inventory couldn’t be loaded right now.' });
  }
}));

inventoryRouter.post('/requests', ah(async (req, res) => {
  const b = parse(z.object({
    forStaffId: z.string().uuid().optional().nullable(),
    note: z.string().trim().max(1000).optional().nullable(),
    customerName: z.string().trim().max(120).optional().nullable(),
    neededBy: dateField.optional(),
    submissionId: z.string().uuid().optional().nullable(),
    items: z.array(itemSchema.refine((i) => !!i.sku || !!i.collection, 'choose a product or type one')).min(1, 'add at least one product').max(60),
  }), req.body);
  // Only people allowed to order for others can pick a different stylist.
  if (!can(req.user, 'inventory:order_for_others')) b.forStaffId = req.user!.id;
  const { request: r, duplicate } = await createInventoryRequest(b, req.user!.id);
  if (!duplicate) await logAction(req, 'inventory.request', 'inventory_request', r.id, { items: r.items.length, fromInventory: r.items.filter((i) => i.sku).length });
  res.status(duplicate ? 200 : 201).json({ request: r, duplicate });
}));

/** Send the email again (e.g. after fixing email settings). */
inventoryRouter.post('/requests/:id/resend', ah(async (req, res) => {
  const r = await getInventoryRequest(req.params.id);
  if (!seesAll(req) && !mine(r, req.user!.id)) throw forbidden();
  await sendInventoryEmail(r.id);
  await logAction(req, 'inventory.resend', 'inventory_request', r.id);
  res.json({ request: await getInventoryRequest(r.id) });
}));

inventoryRouter.patch('/requests/:id', ah(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['submitted', 'ordered', 'received', 'cancelled']) }), req.body);
  const r = await getInventoryRequest(req.params.id);
  // Staff may only cancel their own request while it's still just requested.
  const ownCancel = status === 'cancelled' && r.status === 'submitted' && mine(r, req.user!.id);
  if (!manages(req) && !ownCancel) throw forbidden();
  const updated = await setInventoryStatus(r.id, status, req.user!.id);
  await logAction(req, 'inventory.status', 'inventory_request', r.id, { status });
  res.json({ request: updated });
}));

/** Edit an item's Needed By date. */
inventoryRouter.patch('/requests/:id/items/:itemId', ah(async (req, res) => {
  const b = parse(z.object({ neededBy: dateField.optional() }), req.body);
  const r = await getInventoryRequest(req.params.id);
  // Stylists edit their own open orders; receptionists can also update dates on anyone's open order.
  const open = r.status === 'submitted' || r.status === 'ordered';
  if (!manages(req) && !(open && (mine(r, req.user!.id) || seesAll(req)))) throw forbidden();
  const out = await updateInventoryItem(r.id, req.params.itemId, b);
  await logAction(req, 'inventory.item', 'inventory_request', r.id, { itemId: req.params.itemId, ...b });
  res.json(out);
}));

/** What each store is called in the CRM (e.g. Salon, AH-PRO, AH). */
inventoryRouter.get('/store-names', ah(async (_req, res) => {
  res.json(storeNames());
}));

// ---------- Square inventory (source of truth) ----------

/** Search Square products by name, size/colour, SKU or UPC. */
inventoryRouter.get('/products', ah(async (req, res) => {
  const q = req.query as Record<string, string>;
  // First use: load the catalog from Square so search works straight away.
  if ((await inventorySyncStatus()).status === 'never') await syncSquareInventory();
  const kind = (['shared', 'separate', 'salon_only', 'service', 'unset', 'products', 'all', 'discontinued'] as const).find((k) => k === q.kind);
  const found = await searchSquareInventory({ q: q.q, inStock: q.inStock === 'true', orderable: q.orderable === 'true', limit: Number(q.limit) || undefined, kind });
  const isAdmin = can(req.user, 'shopify:push');
  res.json({
    ...found,
    // Shopify push details are admin-only.
    products: isAdmin ? found.products : found.products.map((p) => ({ ...p, shopify: { pushedAt: null, pushedQuantity: null, error: null } })),
    sync: await inventorySyncStatus(),
    canPushToShopify: isAdmin,
    canChangeShopifySync: can(req.user, 'inventory:sync'),
  });
}));

/** Re-read products and stock from Square now (it also refreshes with every Square sync). */
inventoryRouter.post('/products/refresh', ah(async (_req, res) => {
  res.json({ sync: await syncSquareInventory() });
}));

/** Administrators only: set Shopify's stock to Square's count for the chosen products. Never automatic. */
inventoryRouter.post('/products/shopify-push', requirePermission('shopify:push'), ah(async (req, res) => {
  const { variationIds } = parse(z.object({ variationIds: z.array(z.string().min(1).max(64)).min(1, 'choose at least one product').max(1000) }), req.body);
  const result = await pushInventoryToShopify(variationIds);
  await logAction(req, 'shopify.inventory_push', 'square_inventory', null, { pushed: result.pushed.length, skipped: result.skipped.length, failed: result.failed.length });
  res.json({ result });
}));

function mine(r: { forStaffId: string | null; requestedById: string | null }, staffId: string) {
  return r.forStaffId === staffId || r.requestedById === staffId;
}
