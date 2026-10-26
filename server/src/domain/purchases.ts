import { db } from '../db/index.js';
import { getKV, getSettings } from '../repos/settings.js';
import { shopifyService, shopifyService2, storeNames } from '../integrations/registry.js';
import { iso } from '../lib/time.js';
import { localDate } from './rebookingSchedule.js';
import { shopifyNameOf, stockRows } from './stock.js';

/**
 * Purchases & Transactions: completed orders from every connected store in one list — the salon's Square orders and
 * both Shopify stores' orders — each labelled with its store and source. Records are read as stored (synced from
 * Square for commission, and from Shopify for stock); nothing here changes an order or stock.
 */
export type PurchaseStore = 'square' | 'shopify' | 'shopify2';
export interface PurchaseLine { key: string | null; label: string; sku: string | null; quantity: number; unitCents: number | null; discountCents: number; totalCents: number }
export interface Purchase {
  id: string; store: PurchaseStore; storeName: string; source: 'Square' | 'Shopify'; at: string; number: string; customer: string | null; staff: string | null;
  status: string; lines: PurchaseLine[]; units: number; totalCents: number; refundCents: number;
}
export interface PurchaseFilter { stores: PurchaseStore[]; from?: string; to?: string; q?: string; items?: string[]; sort?: 'new' | 'old'; limit?: number; offset?: number; customers?: boolean }

const cents = (m: any) => (m?.amount != null ? Number(m.amount) : 0);

async function load(f: PurchaseFilter): Promise<Purchase[]> {
  const tz = (await getSettings()).business.timezone;
  const names = storeNames();
  const from = f.from ?? '2000-01-01';
  const to = f.to ?? '2999-12-31';
  const out: Purchase[] = [];
  if (f.stores.includes('square')) {
    const staff = new Map((await db().query<any>('SELECT square_team_member_id AS tm, name FROM staff WHERE square_team_member_id IS NOT NULL')).map((s) => [s.tm as string, s.name as string]));
    const pays = await db().query<any>('SELECT order_id, team_member_id FROM commission_payments WHERE team_member_id IS NOT NULL');
    const payBy = new Map(pays.map((p) => [p.order_id as string, p.team_member_id as string]));
    const clients = f.customers ? new Map((await db().query<any>("SELECT square_customer_id AS id, trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) AS name FROM clients WHERE square_customer_id IS NOT NULL")).map((c) => [c.id as string, c.name as string])) : new Map<string, string>();
    const orders = await db().query<any>(
      `SELECT order_id, customer_id, state, closed_at, raw FROM commission_orders
        WHERE state = 'COMPLETED' AND NOT is_return AND (closed_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`, [tz, from, to]);
    for (const o of orders) {
      const lines: PurchaseLine[] = (o.raw.line_items ?? []).map((l: any) => {
        const qty = Number(l.quantity) || 0;
        const gross = cents(l.gross_sales_money) || cents(l.base_price_money) * qty;
        const disc = cents(l.total_discount_money);
        return { key: l.catalog_object_id ?? null, label: [l.name, l.variation_name && l.variation_name !== 'Regular' ? l.variation_name : null].filter(Boolean).join(' · ') || 'Custom amount',
          sku: null, quantity: qty, unitCents: cents(l.base_price_money) || null, discountCents: disc, totalCents: gross - disc };
      });
      const refund = (o.raw.returns ?? []).reduce((a: number, r: any) => a + (r.return_line_items ?? []).reduce((b: number, x: any) => b + cents(x.gross_return_money ?? x.total_money), 0), 0);
      out.push({
        id: `square:${o.order_id}`, store: 'square', storeName: names.square, source: 'Square', at: iso(o.closed_at)!, number: `#${String(o.order_id).slice(-6).toUpperCase()}`,
        customer: o.customer_id ? clients.get(o.customer_id) || null : null, staff: staff.get(payBy.get(o.order_id) ?? '') ?? null,
        status: refund ? 'Partly refunded' : 'Completed', lines, units: lines.reduce((a, l) => a + l.quantity, 0),
        totalCents: cents(o.raw.total_money) || lines.reduce((a, l) => a + l.totalCents, 0), refundCents: refund,
      });
    }
  }
  const shStores = f.stores.filter((s): s is 'shopify' | 'shopify2' => s !== 'square');
  if (shStores.length) {
    const rows = await db().query<any>(
      `SELECT store, order_id, line_id, inventory_item_id, sku, quantity, unit_price_cents, ordered_at, cancelled, title FROM shopify_order_lines
        WHERE store = ANY($1::text[]) AND (ordered_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date ORDER BY ordered_at, line_id`, [shStores, tz, from, to]);
    const keyOf = new Map<string, string>();
    for (const r of await stockRows().catch(() => [])) {
      for (const id of [r.shopifyInventoryItemId, ...r.store2.map((e) => e.inventoryItemId), ...(r.siblings ?? []).map((e) => e.inventoryItemId)]) if (id) keyOf.set(id, r.key);
    }
    const byOrder = new Map<string, any[]>();
    for (const r of rows) byOrder.set(`${r.store}|${r.order_id}`, [...(byOrder.get(`${r.store}|${r.order_id}`) ?? []), r]);
    for (const [k, list] of byOrder) {
      const store = list[0].store === 'shopify2' ? 'shopify2' : 'shopify';
      const lines: PurchaseLine[] = list.map((r) => ({
        key: r.inventory_item_id ? keyOf.get(r.inventory_item_id) ?? `shopify:${r.inventory_item_id}` : null, label: r.title ?? (r.sku ? `SKU ${r.sku}` : 'Item'), sku: r.sku ?? null,
        quantity: Number(r.quantity), unitCents: r.unit_price_cents ?? null, discountCents: 0, totalCents: Number(r.quantity) * (r.unit_price_cents ?? 0),
      }));
      const cancelled = list.every((r) => r.cancelled);
      out.push({
        id: `${store}:${k.slice(k.indexOf('|') + 1)}`, store, storeName: shopifyNameOf(store), source: 'Shopify', at: iso(list[0].ordered_at)!, number: '', customer: null, staff: null,
        status: cancelled ? 'Cancelled' : 'Paid', lines, units: cancelled ? 0 : lines.reduce((a, l) => a + l.quantity, 0), totalCents: cancelled ? 0 : lines.reduce((a, l) => a + l.totalCents, 0), refundCents: 0,
      });
    }
  }
  return out;
}

/** What a list of purchases filtered by `items` counts: only those items' lines (item totals, not whole orders). */
export async function listPurchases(f: PurchaseFilter) {
  const all = await load(f);
  const items = new Set(f.items ?? []);
  const words = (f.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const text = (p: Purchase) => [p.number, p.id, p.customer, p.staff, p.storeName, ...p.lines.flatMap((l) => [l.label, l.sku])].join(' ').toLowerCase();
  const matching = all
    .map((p) => (items.size ? { ...p, lines: p.lines.filter((l) => l.key && items.has(l.key)) } : p))
    .filter((p) => (!items.size || p.lines.length) && words.every((w) => text(p).includes(w)))
    .sort((a, b) => (f.sort === 'old' ? a.at.localeCompare(b.at) : b.at.localeCompare(a.at)));
  const counted = matching.filter((p) => p.status !== 'Cancelled');
  const units = counted.reduce((a, p) => a + p.lines.reduce((b, l) => b + l.quantity, 0), 0);
  const value = items.size ? counted.reduce((a, p) => a + p.lines.reduce((b, l) => b + l.totalCents, 0), 0) : counted.reduce((a, p) => a + p.totalCents, 0);
  const page = matching.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 50));
  // Shopify order numbers and customers, for this page only (asked from Shopify; Square has them stored).
  for (const store of ['shopify', 'shopify2'] as const) {
    const mine = page.filter((p) => p.store === store);
    const svc = store === 'shopify' ? shopifyService() : shopifyService2();
    if (!mine.length || !svc) continue;
    const who = await svc.orderWho(mine.map((p) => p.id.slice(store.length + 1))).catch(() => new Map());
    for (const p of mine) { const w = who.get(p.id.slice(store.length + 1)); p.number = w?.name ?? p.number; if (f.customers) p.customer = w?.customer ?? null; }
  }
  return {
    orders: page, total: matching.length, itemMode: items.size > 0,
    summary: { orders: counted.length, units, valueCents: value, averageCents: items.size ? (units ? Math.round(value / units) : null) : (counted.length ? Math.round(value / counted.length) : null) },
    synced: {
      square: f.stores.includes('square') ? (await getKV<string>('commission.last_success')) ?? null : undefined,
      shopify: f.stores.some((s) => s !== 'square') ? (await getKV<{ updatedAt: string | null }>('stock.shopify-sales'))?.updatedAt ?? null : undefined,
    },
    today: localDate(new Date(), (await getSettings()).business.timezone),
  };
}

/** Items sold (for the item filter): distinct products in the stores' orders matching the search. */
export async function purchaseItems(f: PurchaseFilter) {
  const all = await load({ ...f, items: undefined });
  const words = (f.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Map<string, { key: string; label: string; sku: string | null; units: number }>();
  for (const p of all) for (const l of p.lines) {
    if (!l.key || !words.every((w) => `${l.label} ${l.sku ?? ''}`.toLowerCase().includes(w))) continue;
    const e = seen.get(l.key) ?? { key: l.key, label: l.label, sku: l.sku, units: 0 };
    e.units += l.quantity;
    seen.set(l.key, e);
  }
  return [...seen.values()].sort((a, b) => b.units - a.units).slice(0, 30);
}
