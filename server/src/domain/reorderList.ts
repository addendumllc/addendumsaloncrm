import { hairLengthOf, type StockForecastDTO, hairCompareByColor } from '@addendum/shared';
import { db } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import { getKV, setKV } from '../repos/settings.js';
import { createPurchaseOrders, defaultSupplier, stockForecast } from './stock.js';

/**
 * Reorder List (Addendum Hair): a short list of the wefts and K-tips that need attention, with an order amount for the
 * chosen plan. Built on To order's forecast (stock, pre-orders, what's on order, sales rate, lead times, MOQ, case size),
 * so there's one source of truth; nothing here changes stock or sends anything to a supplier.
 *
 *  Shown when: out of stock (or owed to pre-orders), fewer than 5 available, or selling out within 14 days.
 *  Coverage plans: need = sales over the plan's days + safety stock + pre-orders owed − available − on order.
 *  Normal order: the product's typical quantity (set by hand, else the median of its past orders); else calculated.
 *  Then the minimum order, then full cases (each step shown).
 */
export type Plan = 'normal' | '30' | '60' | '90';
export const PLANS: Plan[] = ['normal', '30', '60', '90'];
export type HairType = 'weft' | 'ktip' | 'tape' | 'clipin';
export const LOW_UNITS = 5;
export const SOON_DAYS = 14;
/** Production at or above this many days gets "Long production lead". */
export const LONG_LEAD_DAYS = 45;

export const hairTypeOf = (i: Pick<StockForecastDTO, 'label' | 'collections'> & { collection?: string | null; sku?: string | null }): HairType | null => {
  // Sample swatches aren't reordered here.
  if (/sample swatch/i.test(i.label) || /^swatch-/i.test(i.sku ?? '')) return null;
  // The product's own name first (a K-tip in a "Hair Extensions" collection is a K-tip), then its collections.
  for (const text of [i.label, [i.collection ?? '', ...i.collections].join(' ')]) {
    if (/\b[ik][\s-]?tips?\b/i.test(text)) return 'ktip';
    if (/\bclip[\s-]?ins?\b/i.test(text)) return 'clipin';
    if (/\btape[\s-]?ins?\b|\btapes?\b/i.test(text)) return 'tape';
    if (/\bwefts?\b/i.test(text)) return 'weft';
  }
  return null;
};
/** Lisa's sections (by collection — the length shows by each name), in the order she orders them; anything else follows by type. */
export const GROUP_ORDER = ['Redefined Wefts', 'Wefts', 'K-Tips', 'Tapes', 'Clip-Ins'];
const LINE: Record<HairType, string> = { weft: 'Wefts', ktip: 'K-Tips', tape: 'Tapes', clipin: 'Clip-Ins' };
export function groupOf(label: string, type: HairType) {
  return type === 'weft' && /redefined/i.test(label) ? 'Redefined Wefts' : LINE[type];
}
const groupRank = (g: string, type: HairType) => {
  const i = GROUP_ORDER.indexOf(g);
  return i >= 0 ? i : 100 + ['weft', 'ktip', 'tape', 'clipin'].indexOf(type) * 10;
};
/** The colour name alone ("Aperol Spritz Redefined Weft · 24\" Weft" → "Aperol Spritz"). */
export function shadeOf(label: string) {
  for (const part of label.split(/\s+·\s+/)) {
    const s = clean(part);
    if (s) return s;
  }
  return label;
}
function clean(first: string) {
  return first.replace(/\b\d+(\.\d+)?\s*("|”|″|inch(es)?|in)(?=\s|$)/gi, '')
    .replace(/\b(redefined|signature|hand[\s-]?tied|addendum)\b/gi, '')
    .replace(/\b(wefts?|[ik][\s-]?tips?|tape[\s-]?ins?|tapes?|clip[\s-]?ins?|extensions?)\b/gi, '')
    .replace(/(\s+[-–])+\s+/g, ' · ').replace(/\s{2,}/g, ' ').replace(/^[\s\-–·]+|[\s\-–·]+$/g, '').trim();
}

export interface Prefs { typicalQty: number | null; preferredPlan: Plan | null; safetyUnits: number | null; notes: string | null; updatedAt: string | null }
export interface ReorderRow {
  key: string; label: string; shade: string; group: string; sku: string | null; length: string | null; type: HairType; supplier: string | null; collection: string | null;
  available: number; committed: number; incoming: number; ratePerDay: number; units30: number; noSales: boolean;
  daysUntilStockout: number | null; stockoutOn: string | null; productionDays: number; shippingDays: number; leadDays: number; leadMissing: boolean;
  moq: number | null; moqMissing: boolean; caseSize: number | null; costCents: number | null;
  plan: Plan; planNote: string; calculatedNeed: number; netNeed: number; suggestedQty: number; minimumQty: number | null; explain: string; why: string[];
  /** 1 out of stock · 2 runs out before an order placed now could arrive · 3 other attention. */
  tier: 1 | 2 | 3; urgent: boolean; badges: string[]; warning: string | null; flags: string[];
  prefs: Prefs; history: { quantity: number; orderedOn: string; number: number }[];
}

const ceilTo = (n: number, step: number) => Math.ceil(n / step) * step;
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

/** Applies the minimum order then full cases to a quantity, saying why each changed it. */
export function applyRules(need: number, moq: number | null, caseSize: number | null) {
  const steps: string[] = [];
  let q = Math.max(0, Math.ceil(need));
  if (q > 0 && moq && q < moq) { q = moq; steps.push(`MOQ ${moq}`); }
  if (q > 0 && caseSize && caseSize > 1 && q % caseSize) { q = ceilTo(q, caseSize); steps.push(`Case size ${caseSize}`); }
  return { qty: q, steps };
}
/** A quantity the supplier will accept: 0, or at least the minimum and in full cases. Null when valid. */
export function quantityProblem(qty: number, moq: number | null, caseSize: number | null): { message: string; suggest: number } | null {
  if (qty <= 0) return null;
  if (moq && qty < moq) { const s = caseSize && caseSize > 1 ? ceilTo(moq, caseSize) : moq; return { message: `Below the minimum order of ${moq}`, suggest: s }; }
  if (caseSize && caseSize > 1 && qty % caseSize) return { message: `Not a full case of ${caseSize}`, suggest: ceilTo(qty, caseSize) };
  return null;
}

async function allPrefs() {
  const rows = await db().query<any>('SELECT * FROM reorder_prefs');
  return new Map(rows.map((r) => [r.product_key as string, {
    typicalQty: r.typical_qty, preferredPlan: r.preferred_plan, safetyUnits: r.safety_units, notes: r.notes, updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  } as Prefs]));
}
async function orderHistory(keys: string[]) {
  if (!keys.length) return new Map<string, ReorderRow['history']>();
  const rows = await db().query<any>(`SELECT l.product_key, l.quantity, p.number, to_char(COALESCE(p.ordered_at, p.created_at), 'YYYY-MM-DD') AS on
    FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id WHERE l.product_key = ANY($1) AND p.status IN ('ordered','shipped','received')
    ORDER BY COALESCE(p.ordered_at, p.created_at) DESC`, [keys]);
  const m = new Map<string, ReorderRow['history']>();
  for (const r of rows) { const l = m.get(r.product_key) ?? []; if (l.length < 6) l.push({ quantity: r.quantity, orderedOn: r.on, number: r.number }); m.set(r.product_key, l); }
  return m;
}

export async function reorderList(plan: Plan, opts: { type?: HairType; group?: string; collection?: string; supplier?: string } = {}) {
  const f = await stockForecast();
  const today = new Date().toISOString().slice(0, 10);
  const fallback = await defaultSupplier();
  // Addendum Hair = the online store (Shopify); wefts and K-tips only; not discontinued or skipped.
  const hair = f.items.filter((i) => i.stores.online && hairTypeOf(i) && i.status !== 'discontinued' && !i.skippedUntil);
  const prefs = await allPrefs();
  const rows: ReorderRow[] = [];
  const needs = hair.filter((i) => {
    const owed = Math.max(0, i.preorders - i.incoming);
    const days = i.ratePerDay > 0 ? i.stock / i.ratePerDay : null;
    return i.stock <= 0 || owed > 0 || i.stock < LOW_UNITS || (days != null && days <= SOON_DAYS);
  });
  const history = await orderHistory(needs.map((i) => i.key));
  for (const i of needs) {
    const type = hairTypeOf(i)!;
    const p = prefs.get(i.key) ?? { typicalQty: null, preferredPlan: null, safetyUnits: null, notes: null, updatedAt: null };
    const rate = i.ratePerDay;
    const committed = i.preorders;
    const owed = Math.max(0, committed - i.incoming);
    const lead = i.productionDays + i.shippingDays;
    const days = rate > 0 ? i.stock / rate : i.stock <= 0 ? 0 : null;
    const flags: string[] = [];
    if (rate <= 0) flags.push('No sales in the last 90 days — the forecast is a guess');
    if (i.leadSource.kind === 'missing') flags.push(`No lead time recorded — using the ${lead}-day default`);
    const moqMissing = i.moq == null;
    if (moqMissing) flags.push('No minimum order recorded');
    const hist = history.get(i.key) ?? [];

    // The plan for this product: a product's preferred coverage plan applies under Normal Order.
    const own: Plan = plan === 'normal' && p.preferredPlan && p.preferredPlan !== 'normal' ? p.preferredPlan : plan;
    let calculated = 0;
    let planNote = '';
    const why: string[] = [];
    const safety = p.safetyUnits ?? Math.ceil(rate * i.safetyDays);
    if (own === 'normal') {
      const fromHistory = median(hist.map((h) => h.quantity));
      if (p.typicalQty) { calculated = p.typicalQty; planNote = 'Your typical order'; why.push(`Typical order quantity set to ${p.typicalQty}.`); }
      else if (fromHistory) { calculated = fromHistory; planNote = `Usual from ${hist.length} past order${hist.length === 1 ? '' : 's'}`; why.push(`Past orders: ${hist.map((h) => h.quantity).join(', ')} (usual ${fromHistory}).`); }
      else {
        // Fallback: To order's own calculation (lead time + coverage + safety), shown as calculated.
        calculated = Math.max(0, Math.ceil(rate * (lead + 30) + safety + owed - i.stock - i.incoming));
        planNote = 'Calculated (no usual quantity yet)';
        why.push(`No typical quantity or past orders: calculated from sales through the ${lead}-day lead time plus 30 days, and safety stock.`);
      }
    } else {
      const n = Number(own);
      calculated = Math.ceil(rate * n + safety + owed);
      planNote = plan === 'normal' ? `${n}-day coverage (this product’s preferred plan)` : `${n}-day coverage`;
      why.push(`About ${(rate * n).toFixed(1)} sold in ${n} days + ${safety} safety stock${owed ? ` + ${owed} owed to pre-orders` : ''} = ${calculated}.`);
    }
    // Normal orders are the usual amount; coverage plans subtract what's here and on order.
    const net = own === 'normal' && (p.typicalQty || hist.length) ? calculated : Math.max(0, calculated - (own === 'normal' ? 0 : i.stock + i.incoming));
    const { qty, steps } = applyRules(net, i.moq, i.caseSize);
    const parts = [`Need ${calculated}`];
    if (own !== 'normal' && (i.stock > 0 || i.incoming > 0)) {
      if (i.stock > 0) parts.push(`Available ${i.stock}`);
      if (i.incoming > 0) parts.push(`Incoming ${i.incoming}`);
      parts.push(`Net need ${net}`);
    }
    parts.push(...steps, `Order ${qty}`);

    const stockoutOn = days == null ? null : addDays(today, Math.floor(days));
    const coveredDays = rate > 0 ? (i.stock + i.incoming) / rate : null;
    const out = i.stock <= 0 || owed > 0;
    const beforeArrival = !out && coveredDays != null && coveredDays < lead;
    const tier: 1 | 2 | 3 = out ? 1 : beforeArrival ? 2 : 3;
    const badges: string[] = [];
    if (out) badges.push('OUT OF STOCK');
    if (beforeArrival) badges.push('ORDER NOW');
    if (!out && days != null && days <= SOON_DAYS) badges.push('STOCKOUT WITHIN 14 DAYS');
    if (i.productionDays >= LONG_LEAD_DAYS) badges.push('LONG PRODUCTION LEAD');
    if (i.incoming > 0) badges.push('INCOMING STOCK');
    let warning: string | null = null;
    if (out) warning = `Out of stock now${owed ? ` with ${owed} owed to pre-orders` : ''}. An order placed today arrives in about ${lead} days — it can’t prevent this stock-out, only shorten it.`;
    else if (beforeArrival) warning = `Runs out in about ${Math.round(coveredDays!)} days${i.incoming ? ' (counting what’s on order)' : ''}, but an order placed today takes about ${lead} days to arrive. Order now.`;
    if (!out && !beforeArrival && i.incoming > 0 && qty === 0) why.push('Covered by what’s already on order.');
    if (own === 'normal' && i.incoming > 0 && qty > 0) why.push(`${i.incoming} already on order — lower the amount if that covers it.`);
    rows.push({
      key: i.key, label: i.label, shade: shadeOf(i.label), group: groupOf(i.label, type), sku: i.sku, length: hairLengthOf(i.label, i.sku), type, supplier: i.supplier ?? fallback, collection: i.collection ?? i.collections[0] ?? null,
      available: i.stock, committed, incoming: i.incoming, ratePerDay: rate, units30: i.units30, noSales: rate <= 0,
      daysUntilStockout: days == null ? null : Math.round(days), stockoutOn, productionDays: i.productionDays, shippingDays: i.shippingDays, leadDays: lead, leadMissing: i.leadSource.kind === 'missing',
      moq: i.moq, moqMissing, caseSize: i.caseSize, costCents: i.costCents,
      plan: own, planNote, calculatedNeed: calculated, netNeed: net, suggestedQty: qty, minimumQty: i.moq, explain: parts.join(' · '), why,
      tier, urgent: tier <= 2, badges, warning, flags, prefs: p, history: hist,
    });
  }
  // Wefts first, then K-tips; in each: out of stock, then runs out before an order could arrive, then the rest —
  // soonest stock-out first, longer lead first.
  // Lisa's sections in her order (Redefined Wefts, K-Tips, Tapes, Clip-Ins); in each, by colour then length — 18", 22", 24"
  // of a colour together (urgent ones are marked, not moved).
  rows.sort((a, b) => groupRank(a.group, a.type) - groupRank(b.group, b.type) || a.group.localeCompare(b.group) || hairCompareByColor({ label: a.label, sku: a.sku }, { label: b.label, sku: b.sku }));
  const filtered = rows.filter((r) => (!opts.type || r.type === opts.type) && (!opts.group || r.group === opts.group) && (!opts.collection || r.collection === opts.collection) && (!opts.supplier || r.supplier === opts.supplier));
  const suppliers = await supplierRules();
  return {
    plan, items: filtered,
    groups: [...new Set(rows.map((r) => r.group))],
    filters: { collections: [...new Set(rows.map((r) => r.collection).filter((x): x is string => !!x))].sort(), suppliers: [...new Set(rows.map((r) => r.supplier).filter((x): x is string => !!x))].sort() },
    supplierRules: Object.fromEntries([...suppliers].filter(([n]) => rows.some((r) => r.supplier === n))),
    // K-tips that can't wait for the end of the list (they'd run out before a new order arrives).
    urgentKtips: rows.filter((r) => r.type === 'ktip' && r.urgent).map((r) => r.key),
    salesFrom: f.salesFrom,
  };
}

async function supplierRules() {
  const rows = await db().query<any>('SELECT name, min_order_cents, min_order_units FROM suppliers');
  return new Map(rows.map((r) => [r.name as string, { minOrderCents: r.min_order_cents as number | null, minOrderUnits: r.min_order_units as number | null }]));
}

/** One product's usual-order preferences and its recent orders (the product settings popup). */
export async function productPrefs(key: string) {
  const p = (await allPrefs()).get(key) ?? { typicalQty: null, preferredPlan: null, safetyUnits: null, notes: null, updatedAt: null };
  const history = (await orderHistory([key])).get(key) ?? [];
  const usual = median(history.map((h) => h.quantity));
  return { prefs: p, history, usualFromHistory: usual };
}

export async function savePrefs(key: string, p: { typicalQty: number | null; preferredPlan: Plan | null; safetyUnits: number | null; notes: string | null }, staffId: string | null) {
  await db().query(`INSERT INTO reorder_prefs(product_key, typical_qty, preferred_plan, safety_units, notes, updated_by_staff_id) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (product_key) DO UPDATE SET typical_qty = $2, preferred_plan = $3, safety_units = $4, notes = $5, updated_by_staff_id = $6, updated_at = now()`,
  [key, p.typicalQty, p.preferredPlan, p.safetyUnits, p.notes?.trim() || null, staffId]);
}

// ---------------- saved list ----------------
export interface SavedList { plan: Plan; lines: { key: string; include: boolean; qty: number }[]; savedBy: string | null; savedAt: string }
const LIST_KEY = 'reorder.list.draft';
export const savedList = () => getKV<SavedList>(LIST_KEY);
export async function saveList(plan: Plan, lines: SavedList['lines'], savedBy: string | null) {
  const v: SavedList = { plan, lines, savedBy, savedAt: new Date().toISOString() };
  await setKV(LIST_KEY, v);
  return v;
}

// ---------------- review & purchase orders ----------------
export interface ReviewLine { key: string; qty: number }
/** Checks a chosen order: each line against its minimum and case size, each supplier against its order minimums. */
export async function reviewOrder(plan: Plan, lines: ReviewLine[]) {
  const { items } = await reorderList(plan);
  const byKey = new Map(items.map((i) => [i.key, i]));
  const rules = await supplierRules();
  const problems: { key: string; label: string; message: string; suggest: number }[] = [];
  const groups = new Map<string, { supplier: string; lines: { key: string; label: string; sku: string | null; qty: number; costCents: number | null; leadDays: number }[] }>();
  for (const l of lines.filter((x) => x.qty > 0)) {
    const i = byKey.get(l.key);
    if (!i) { problems.push({ key: l.key, label: l.key, message: 'No longer on the Reorder List (refresh)', suggest: 0 }); continue; }
    const p = quantityProblem(l.qty, i.moq, i.caseSize);
    if (p) problems.push({ key: i.key, label: i.label, ...p });
    const s = i.supplier ?? 'Supplier needed';
    const g = groups.get(s) ?? { supplier: s, lines: [] };
    g.lines.push({ key: i.key, label: i.label, sku: i.sku, qty: l.qty, costCents: i.costCents, leadDays: i.leadDays });
    groups.set(s, g);
  }
  const suppliers = [...groups.values()].map((g) => {
    const units = g.lines.reduce((n, l) => n + l.qty, 0);
    const known = g.lines.every((l) => l.costCents != null);
    const cents = g.lines.reduce((n, l) => n + (l.costCents ?? 0) * l.qty, 0);
    const r = rules.get(g.supplier);
    const warnings: string[] = [];
    if (g.supplier === 'Supplier needed') warnings.push('These products have no supplier — set one (Suppliers) before ordering.');
    if (r?.minOrderUnits && units < r.minOrderUnits) warnings.push(`Below ${g.supplier}’s minimum of ${r.minOrderUnits} units per order (${units} selected).`);
    if (r?.minOrderCents && cents < r.minOrderCents) warnings.push(`Below ${g.supplier}’s minimum order of $${(r.minOrderCents / 100).toFixed(2)} (${known ? '' : 'about '}$${(cents / 100).toFixed(2)} selected).`);
    return { ...g, units, estCents: known ? cents : null, estPartialCents: cents, warnings };
  });
  return { problems, suppliers };
}

/** Draft purchase orders (one per supplier, in the existing purchase orders) for the valid lines. Nothing is sent. */
export async function createReorderPOs(plan: Plan, lines: ReviewLine[], staffId: string | null) {
  const r = await reviewOrder(plan, lines);
  const bad = new Set(r.problems.map((p) => p.key));
  const groups = r.suppliers.filter((s) => s.supplier !== 'Supplier needed').map((s) => ({ supplier: s.supplier, lines: s.lines.filter((l) => !bad.has(l.key)) })).filter((g) => g.lines.length);
  if (!groups.length) throw badRequest(r.problems.length ? 'Fix the quantities shown (minimum order or case size) before creating the order.' : 'Choose at least one product with a supplier and a quantity.');
  const label = plan === 'normal' ? 'Normal order' : `${plan}-day coverage`;
  // One draft per supplier, as reviewed (Addendum Hair's store); ordering it is a separate, confirmed step.
  const orders = [];
  for (const g of groups) orders.push(...await createPurchaseOrders(g.lines.map((l) => ({ productKey: l.key, quantity: l.qty })), staffId, g.supplier, 'shopify', undefined, `Reorder List · ${label}`));
  return { orders, skipped: r.problems };
}
