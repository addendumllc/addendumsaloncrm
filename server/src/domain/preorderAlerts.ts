import { db } from '../db/index.js';
import { effectivePermissions } from '../auth/permissions.js';
import { shopifyService } from '../integrations/registry.js';
import { notifyNewPreorders, notifyStockAlerts } from './stock.js';

/** Everyone active who manages inventory (Inventory sync permission). */
async function inventoryManagers() {
  const staff = await db().query<{ id: string; role: any }>("SELECT id, role FROM staff WHERE active AND approval_status = 'approved'");
  const out: string[] = [];
  for (const s of staff) if ((await effectivePermissions(s.id, s.role)).includes('inventory:sync')) out.push(s.id);
  return out;
}

/** Scheduler: a bell notification when customers pre-order something new online. */
export async function checkPreorders() {
  if (!shopifyService()) return 0;
  return notifyNewPreorders(async (ids, title, body) => {
    for (const id of ids) {
      await db().query('INSERT INTO notifications(staff_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5)', [id, 'preorder', title, body, '/inventory-sync?view=preorders&for=hair']);
    }
  }, inventoryManagers);
}

/** Scheduler: a bell notification when a selling product runs out, or will run out before a new order could arrive. */
export async function checkStockAlerts() {
  if (!shopifyService()) return 0;
  return notifyStockAlerts(async (ids, title, body) => {
    for (const id of ids) {
      await db().query('INSERT INTO notifications(staff_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5)', [id, 'stock', title, body, '/inventory-sync?view=reorder&show=alerts']);
    }
  }, inventoryManagers);
}
