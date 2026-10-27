import { config } from '../config.js';
import { shopifyService, shopifyService2 } from '../integrations/registry.js';
import type { ShopifyCustomer, ShopifyService } from '../integrations/shopify/ShopifyService.js';
import { badRequest } from '../lib/errors.js';
import { getKV, setKV } from '../repos/settings.js';

/**
 * One-time copy of the professional store's customers into the retail store (Addendum Hair): new ones are created with
 * their tags, name, phone, default address and marketing consent exactly as it was (never subscribed if they weren't);
 * ones already there (same email, or phone when there's no email) only get the tags they're missing. Nothing in the
 * professional store changes. Runs in the background; progress is kept so the page can show it.
 */
function stores(): { pro: ShopifyService; retail: ShopifyService; proName: string; retailName: string } {
  const c = config();
  const s1 = shopifyService(); const s2 = shopifyService2();
  if (!s1 || !s2) throw badRequest('Both Shopify stores need to be connected (Settings → API & Integrations).');
  const proFirst = /professional/i.test(c.SHOPIFY_STORE_DOMAIN ?? '') || !/professional/i.test(c.SHOPIFY2_STORE_DOMAIN ?? '');
  const [pro, retail] = proFirst ? [s1, s2] : [s2, s1];
  const [proName, retailName] = proFirst ? [c.SHOPIFY_STORE_DOMAIN ?? 'Pro store', c.SHOPIFY2_STORE_DOMAIN ?? 'Addendum Hair'] : [c.SHOPIFY2_STORE_DOMAIN ?? 'Pro store', c.SHOPIFY_STORE_DOMAIN ?? 'Addendum Hair'];
  return { pro, retail, proName, retailName };
}
const key = (c: { email: string | null; phone: string | null }) => (c.email ? `e:${c.email.trim().toLowerCase()}` : c.phone ? `p:${c.phone.replace(/[^\d+]/g, '')}` : null);

async function plan() {
  const { pro, retail, proName, retailName } = stores();
  const [from, to] = await Promise.all([pro.listCustomers(), retail.listCustomers()]);
  const there = new Map<string, ShopifyCustomer>();
  for (const c of to) { const k = key(c); if (k) there.set(k, c); }
  const create: ShopifyCustomer[] = []; const tag: { customer: ShopifyCustomer; existing: ShopifyCustomer; missing: string[] }[] = []; const skipped: string[] = [];
  let same = 0;
  for (const c of from) {
    const k = key(c);
    if (!k) { skipped.push(`${[c.firstName, c.lastName].filter(Boolean).join(' ') || c.id} (no email or phone)`); continue; }
    const hit = there.get(k);
    if (!hit) { create.push(c); continue; }
    const missing = c.tags.filter((t) => !hit.tags.some((x) => x.toLowerCase() === t.toLowerCase()));
    if (missing.length) tag.push({ customer: c, existing: hit, missing }); else same++;
  }
  return { proName, retailName, total: from.length, create, tag, same, skipped };
}

export async function previewCustomerCopy() {
  const p = await plan();
  const nameOf = (c: ShopifyCustomer) => [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c.phone || '';
  return {
    from: p.proName, to: p.retailName, total: p.total, toCreate: p.create.length, toTag: p.tag.length, alreadyThere: p.same, skipped: p.skipped,
    subscribed: p.create.filter((c) => c.emailConsent?.marketingState === 'SUBSCRIBED').length,
    sample: [...p.create.slice(0, 8).map((c) => ({ name: nameOf(c), action: 'add', tags: c.tags })), ...p.tag.slice(0, 4).map((t) => ({ name: nameOf(t.customer), action: 'tags', tags: t.missing }))],
  };
}

export interface CopyJob { state: 'running' | 'done' | 'failed'; startedAt: string; finishedAt: string | null; total: number; created: number; tagged: number; failed: { name: string; message: string }[]; message: string | null }
const JOB_KEY = 'customers.copy.job';
let running = false;
export const customerCopyStatus = () => getKV<CopyJob>(JOB_KEY);

/** Starts the copy in the background (one at a time). */
export async function startCustomerCopy(pauseMs = 250) {
  if (running) throw badRequest('A copy is already running.');
  const p = await plan();
  const job: CopyJob = { state: 'running', startedAt: new Date().toISOString(), finishedAt: null, total: p.create.length + p.tag.length, created: 0, tagged: 0, failed: [], message: null };
  await setKV(JOB_KEY, job);
  running = true;
  const { retail } = stores();
  void (async () => {
    try {
      let n = 0;
      for (const c of p.create) {
        try { await retail.createCustomer(c); job.created++; } catch (e) { job.failed.push({ name: c.email ?? c.phone ?? c.id, message: (e as { userMessage?: string }).userMessage ?? (e as Error).message }); }
        if (++n % 10 === 0) await setKV(JOB_KEY, job);
        if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
      }
      for (const t of p.tag) {
        try { await retail.addCustomerTags(t.existing.id, t.missing); job.tagged++; } catch (e) { job.failed.push({ name: t.customer.email ?? t.customer.phone ?? t.customer.id, message: (e as { userMessage?: string }).userMessage ?? (e as Error).message }); }
        if (++n % 10 === 0) await setKV(JOB_KEY, job);
        if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
      }
      job.state = 'done';
    } catch (e) {
      job.state = 'failed'; job.message = (e as { userMessage?: string }).userMessage ?? (e as Error).message;
    } finally {
      job.finishedAt = new Date().toISOString();
      await setKV(JOB_KEY, job);
      running = false;
    }
  })();
  return job;
}
