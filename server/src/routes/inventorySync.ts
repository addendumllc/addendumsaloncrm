import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../auth/session.js';
import {
  getRun, linkBySku, listLinks, listRuns, resolveLink, setShopifySync, startInventorySync, syncOverview, unlink,
} from '../domain/inventorySync.js';
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

inventorySyncRouter.post('/links', ah(async (req, res) => {
  const b = parse(z.object({ squareSku: z.string().trim().min(1).max(120), shopifySku: z.string().trim().min(1).max(120) }), req.body);
  await linkBySku(b.squareSku, b.shopifySku);
  await logAction(req, 'inventory_sync.link', 'inventory_sync', null, { squareSku: b.squareSku, shopifySku: b.shopifySku });
  res.status(201).json({ ok: true });
}));

inventorySyncRouter.delete('/links/:id', ah(async (req, res) => {
  await unlink(req.params.id);
  await logAction(req, 'inventory_sync.unlink', 'inventory_sync_link', req.params.id);
  res.json({ ok: true });
}));
