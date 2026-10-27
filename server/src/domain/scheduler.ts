import { config } from '../config.js';
import { squareService } from '../integrations/registry.js';
import { getIntegration } from '../repos/integrations.js';
import { processHighLevelQueue } from './highlevelPush.js';
import { maybeAutoPullHairClients } from './hairHighLevel.js';
import { retryInventoryEmails } from './inventory.js';
import { maybeAutoSyncCommission } from './commission.js';
import { maybeAutoSync } from './inventorySync.js';
import { runRules } from './rulesEngine.js';
import { maybePurgeOldInternalTasks } from './tasks.js';
import { checkPreorders, checkRecounts, checkStockAlerts } from './preorderAlerts.js';
import { maybeProcessShowit } from './showit.js';
import { syncSquareInventory } from './squareInventory.js';
import { runSquareSync } from './squareSync.js';

/**
 * In-process background jobs (fine for a single salon on one server):
 *  - every minute: HighLevel retry queue, inventory order email retries, automatic Square ↔ Shopify stock sync and
 *    commission sales sync (each only when turned on and due)
 *  - every 5 minutes: follow-up rules (texts are never sent in the background; staff send them from Apple Messages)
 *  - every SQUARE_SYNC_INTERVAL_MINUTES: Square safety-net sync (webhooks handle real-time changes) + retail inventory
 */
export function startScheduler() {
  let tick = 0;
  const guard = (name: string, fn: () => Promise<unknown>) => fn().catch((e) => console.error(`[scheduler] ${name} failed:`, e?.message ?? e));
  const timer = setInterval(async () => {
    tick++;
    await guard('highlevel-queue', () => processHighLevelQueue());
    await guard('inventory-email', () => retryInventoryEmails());
    await guard('inventory-sync', () => maybeAutoSync()); // only when automatic Square ↔ Shopify sync is on and due
    await guard('commission-sync', () => maybeAutoSyncCommission()); // only when commission is on and the interval has passed
    if (tick % 5 === 0) {
      await guard('rules', () => runRules());
      await guard('hair-highlevel', () => maybeAutoPullHairClients()); // hourly, only when turned on
      await guard('showit', () => maybeProcessShowit()); // website inquiries from Gmail, when connected and a sender is verified
      await guard('task-retention', () => maybePurgeOldInternalTasks()); // daily: finished internal tasks past the chosen months
      await guard('preorders', () => checkPreorders()); // new online pre-orders → bell for inventory managers
      await guard('stock-alerts', () => checkStockAlerts()); // selling products out of stock or at risk → bell
      await guard('recount-alerts', () => checkRecounts()); // extensions dropped to the recount level → bell
    }
    if (tick % Math.max(1, config().SQUARE_SYNC_INTERVAL_MINUTES) === 0) {
      await guard('square-sync', async () => {
        const svc = await squareService();
        const row = await getIntegration('square');
        if (svc && row?.status !== 'needs_reconnect') {
          await runSquareSync();
          await syncSquareInventory(); // retail stock for Order Hair search
        }
      });
    }
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
