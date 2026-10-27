import { getKV, setKV } from '../../repos/settings.js';
import type {
  SquareInventoryCount, SquareProductVariation, SquareSetCount,
  SquareBooking, SquareCustomer, SquareLocation, SquareService, SquareServiceVariation, SquareTeamMember,
  SquareOrder, SquarePaymentInfo, SquareTimecard, SquareJob, TimecardBreakInput,
} from './types.js';

/**
 * DEMO MODE ONLY. Simulates a Square seller account so the full sync pipeline
 * (import → change detection → follow-up rules) runs exactly as it would against Square.
 * State is stored in the settings table under `demo.square`. Nothing here is live Square data.
 */
export interface DemoSquareState {
  merchantName: string;
  locations: SquareLocation[];
  team: SquareTeamMember[];
  services: SquareServiceVariation[];
  customers: SquareCustomer[];
  bookings: SquareBooking[];
}

const KEY = 'demo.square';

export async function loadDemoSquare(): Promise<DemoSquareState> {
  const s = await getKV<DemoSquareState>(KEY);
  if (!s) throw new Error('Demo Square state missing — reset demo data.');
  return s;
}

export async function saveDemoSquare(s: DemoSquareState) {
  await setKV(KEY, s);
}

export class MockSquareService implements SquareService {
  readonly mode = 'demo' as const;

  async listBookings(startMin: Date, startMax: Date) {
    const s = await loadDemoSquare();
    return s.bookings.filter((b) => {
      const t = new Date(b.start_at).getTime();
      return t >= startMin.getTime() && t < startMax.getTime();
    });
  }
  async retrieveBooking(id: string) {
    return (await loadDemoSquare()).bookings.find((b) => b.id === id) ?? null;
  }
  async bulkRetrieveCustomers(ids: string[]) {
    const set = new Set(ids);
    return (await loadDemoSquare()).customers.filter((c) => set.has(c.id));
  }
  async listTeamMembers() {
    return (await loadDemoSquare()).team;
  }
  async listServices() {
    return (await loadDemoSquare()).services;
  }
  async listLocations() {
    return (await loadDemoSquare()).locations;
  }
  async merchantName() {
    return (await loadDemoSquare()).merchantName;
  }
  async listProducts() {
    return DEMO_PRODUCTS.map((p) => ({ ...p, ...(demoSquareSkus.has(p.variationId) ? { sku: demoSquareSkus.get(p.variationId)! } : {}), ...(demoSquarePrices.has(p.variationId) ? { priceCents: demoSquarePrices.get(p.variationId)! } : {}) }));
  }
  async createItems(items: { itemName: string; variationName: string; sku: string; priceCents: number; categoryName: string | null }[]) {
    return items.map((it, i) => {
      const id = `demo-new-${Date.now().toString(36)}-${i}`;
      DEMO_PRODUCTS.push({ variationId: id, itemId: `item-${id}`, itemName: it.itemName, variationName: it.variationName, sku: it.sku, upc: null, priceCents: it.priceCents, trackInventory: true, categories: it.categoryName ? [it.categoryName] : [] });
      return { sku: it.sku, variationId: id };
    });
  }
  async addVariations(variations: { itemId: string; name: string; sku: string; priceCents: number | null }[]) {
    return variations.map((v, i) => {
      const item = DEMO_PRODUCTS.find((p) => p.itemId === v.itemId);
      if (!item) throw new Error('not found');
      const id = `demo-var-${Date.now().toString(36)}-${i}`;
      DEMO_PRODUCTS.push({ ...item, variationId: id, variationName: v.name, sku: v.sku, upc: null, priceCents: v.priceCents, trackInventory: true });
      return { sku: v.sku, variationId: id };
    });
  }
  async setVariationPrice(variationId: string, priceCents: number) {
    if (!DEMO_PRODUCTS.some((p) => p.variationId === variationId)) throw new Error('not found');
    demoSquarePrices.set(variationId, priceCents);
  }
  async setVariationSku(variationId: string, sku: string) {
    if (demoSquareHooks.failNext) {
      const e = demoSquareHooks.failNext;
      demoSquareHooks.failNext = null;
      throw e;
    }
    if (!DEMO_PRODUCTS.some((p) => p.variationId === variationId)) throw new Error('not found');
    demoSquareSkus.set(variationId, sku);
  }
  async listInventoryCounts() {
    const locationId = (await loadDemoSquare()).locations[0]?.id ?? 'demo-location';
    return [...demoSquareStock.entries()].map(([variationId, quantity]) => ({ variationId, locationId, quantity, calculatedAt: null }));
  }
  async setInventoryCounts(counts: SquareSetCount[], idempotencyKey: string) {
    if (demoSquareHooks.failNext) {
      const e = demoSquareHooks.failNext;
      demoSquareHooks.failNext = null;
      throw e;
    }
    if (demoSquareApplied.has(idempotencyKey)) return;
    demoSquareApplied.add(idempotencyKey);
    for (const c of counts) demoSquareStock.set(c.variationId, c.quantity);
  }
  async tokenScopes() {
    return { scopes: null, expiresAt: null };
  }
  async searchOrders(_locationIds: string[], updatedFrom: Date, updatedTo: Date) {
    const all = await demoOrders();
    return all.filter((o) => {
      const t = new Date(o.updated_at!).getTime();
      return t >= updatedFrom.getTime() && t <= updatedTo.getTime();
    }).sort((a, b) => a.updated_at!.localeCompare(b.updated_at!));
  }
  async listPayments(from: Date, to: Date): Promise<SquarePaymentInfo[]> {
    const all = await demoOrders();
    const out: SquarePaymentInfo[] = [];
    for (const o of all) {
      for (const t of o.tenders ?? []) {
        const created = o.closed_at ?? o.created_at!;
        if (new Date(created) < from || new Date(created) > to) continue;
        out.push({ id: t.payment_id!, order_id: o.id, team_member_id: demoPaymentTeam.get(t.payment_id!) ?? null, status: 'COMPLETED', created_at: created, tip_money: t.tip_money, amount_money: t.amount_money });
      }
    }
    return out;
  }
  async assignedJob(teamMemberId: string): Promise<SquareJob | null> {
    return { jobId: `demo-job-${teamMemberId}`, title: 'Stylist', hourlyRateCents: 2000 };
  }
  async createTimecard(t: { teamMemberId: string; locationId: string; startAt: Date; endAt: Date; job?: SquareJob | null; breaks?: TimecardBreakInput[] }, idempotencyKey: string) {
    const id = `demo-tc-created-${idempotencyKey}`;
    if (!demoCreatedTimecards.some((x) => x.id === id)) {
      demoCreatedTimecards.push({ id, team_member_id: t.teamMemberId, status: 'CLOSED', start_at: t.startAt.toISOString(), end_at: t.endAt.toISOString(), breaks: demoBreaks(t.breaks), job_id: t.job?.jobId ?? null } as SquareTimecard);
    }
    return id;
  }
  async openTimecard(t: { teamMemberId: string; locationId: string; startAt: Date; job?: SquareJob | null }, idempotencyKey: string) {
    const id = `demo-tc-open-${idempotencyKey}`;
    if (!demoCreatedTimecards.some((x) => x.id === id)) {
      demoCreatedTimecards.push({ id, team_member_id: t.teamMemberId, status: 'OPEN', start_at: t.startAt.toISOString(), end_at: null, breaks: [], job_id: t.job?.jobId ?? null });
    }
    return id;
  }
  async setTimecardBreaks(id: string, breaks: TimecardBreakInput[]) {
    const c = demoCreatedTimecards.find((x) => x.id === id);
    if (!c) throw new Error('not found');
    c.breaks = demoBreaks(breaks);
  }
  async closeTimecard(id: string, endAt: Date, breaks?: TimecardBreakInput[]) {
    const c = demoCreatedTimecards.find((x) => x.id === id);
    if (!c) throw new Error('not found');
    if (breaks) c.breaks = demoBreaks(breaks);
    c.end_at = endAt.toISOString();
    c.status = 'CLOSED';
  }
  async deleteTimecard(id: string) {
    const i = demoCreatedTimecards.findIndex((t) => t.id === id);
    if (i >= 0) demoCreatedTimecards.splice(i, 1);
    else if (id.startsWith('demo-tc-')) demoDeletedTimecards.add(id);
  }
  /** Demo shifts: each team member works most weekdays and Saturdays, 9:00–17:00 local-ish, with a 30-minute unpaid lunch. */
  async listTimecards(from: Date, to: Date): Promise<SquareTimecard[]> {
    const { team } = await loadDemoSquare();
    // Like Square's search for CLOSED timecards: open ones (still clocked in) aren't listed.
    const out: SquareTimecard[] = demoCreatedTimecards.filter((t) => t.end_at && new Date(t.start_at) >= from && new Date(t.start_at) <= to);
    const last = Math.min(to.getTime(), Date.now() - 86400_000);
    for (let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())); d.getTime() <= last; d = new Date(d.getTime() + 86400_000)) {
      if (d.getUTCDay() === 0) continue;
      const day = d.toISOString().slice(0, 10);
      for (const m of team) {
        if (hash(`${m.id}:${day}`) % 5 === 0) continue; // a day off now and then
        if (demoCreatedTimecards.some((t) => t.team_member_id === m.id && t.start_at.slice(0, 10) === day)) continue; // a timecard sent from the CRM
        const start = new Date(`${day}T17:00:00Z`);
        if (start < from || demoDeletedTimecards.has(`demo-tc-${m.id}-${day}`)) continue;
        out.push({
          id: `demo-tc-${m.id}-${day}`, team_member_id: m.id, status: 'CLOSED', start_at: start.toISOString(), end_at: new Date(start.getTime() + 8 * 3600_000).toISOString(),
          breaks: [{ start_at: new Date(start.getTime() + 4 * 3600_000).toISOString(), end_at: new Date(start.getTime() + 4.5 * 3600_000).toISOString(), is_paid: false }],
        });
      }
    }
    return out;
  }
}

const demoBreaks = (b: TimecardBreakInput[] | undefined) => (b ?? []).map((x) => ({ start_at: x.startAt.toISOString(), end_at: x.endAt?.toISOString() ?? null, is_paid: x.paid }));

/** Timecards created from the CRM (demo). */
export const demoCreatedTimecards: SquareTimecard[] = [];
/** Demo Square timecards deleted from the CRM. */
const demoDeletedTimecards = new Set<string>();

// ---------- Demo sales (orders) ----------
// Built from the demo bookings, like Square Appointments checkouts: one order per completed visit with the booked
// services, some retail, discounts and tips — plus a few cases that need care: a refund, an amount-only refund,
// a $0 package redemption and a custom amount nobody can be matched to. DEMO MODE ONLY.
/** Who took each demo payment (tests can add their own). */
export const demoPaymentTeam = new Map<string, string>();
/** Test hook: extra demo orders (e.g. a refund made "today"). */
export const demoExtraOrders: SquareOrder[] = [];
const money = (amount: number) => ({ amount, currency: 'USD' });
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

async function demoOrders(): Promise<SquareOrder[]> {
  const s = await loadDemoSquare();
  const now = Date.now();
  const price = new Map(s.services.map((x) => [x.variationId, x.priceCents ?? 0]));
  const orders: SquareOrder[] = [];
  const done = s.bookings
    .filter((b) => b.status === 'ACCEPTED' && b.customer_id && new Date(b.start_at).getTime() < now - 4 * 3600_000 && new Date(b.start_at).getTime() > now - 85 * 86400_000)
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
  done.forEach((b, i) => {
    const h = hash(b.id);
    const end = new Date(new Date(b.start_at).getTime() + (b.appointment_segments ?? []).reduce((a, x) => a + (x.duration_minutes ?? 60), 0) * 60_000);
    const lines: SquareOrder['line_items'] = (b.appointment_segments ?? []).map((seg, j) => {
      const base = price.get(seg.service_variation_id ?? '') ?? 0;
      const disc = h % 6 === 0 ? Math.round(base * 0.1) : 0; // a 10% discount on some visits
      return {
        uid: `${b.id}-s${j}`, name: s.services.find((x) => x.variationId === seg.service_variation_id)?.name ?? 'Service', quantity: '1',
        catalog_object_id: seg.service_variation_id, item_type: 'ITEM',
        base_price_money: money(base), gross_sales_money: money(base), total_discount_money: money(disc), total_money: money(base - disc),
      };
    });
    if (h % 4 === 0) {
      const p = DEMO_PRODUCTS[h % 2 ? 5 : 6]; // care kit or bond remover
      lines.push({ uid: `${b.id}-r`, name: p.itemName, quantity: '1', catalog_object_id: p.variationId, item_type: 'ITEM',
        base_price_money: money(p.priceCents!), gross_sales_money: money(p.priceCents!), total_discount_money: money(0), total_money: money(p.priceCents!) });
    }
    if (i === done.length - 6 && lines[0]) { // package redemption: service paid with a prepaid package
      lines[0] = { ...lines[0], total_discount_money: lines[0].gross_sales_money, total_money: money(0), name: `${lines[0].name} (package)` };
    }
    const total = lines.reduce((a, l) => a + (l.total_money?.amount ?? 0), 0);
    const tip = h % 3 === 0 ? 0 : Math.round(total * 0.18);
    const paymentId = `demo-pay-${b.id}`;
    demoPaymentTeam.set(paymentId, b.appointment_segments?.[0]?.team_member_id ?? 'demo-tm-lisa');
    const at = end.toISOString();
    orders.push({
      id: `demo-ord-${b.id}`, location_id: b.location_id ?? s.locations[0].id, customer_id: b.customer_id, state: 'COMPLETED',
      created_at: at, updated_at: at, closed_at: at, line_items: lines,
      tenders: [{ id: `t-${b.id}`, payment_id: paymentId, type: 'CARD', amount_money: money(total + tip), tip_money: money(tip) }],
      total_money: money(total + tip), total_tip_money: money(tip),
    });
  });
  // A retail-only sale at the front desk with a custom amount line nobody can be matched to automatically.
  const walkIn = new Date(now - 3 * 86400_000).toISOString();
  demoPaymentTeam.set('demo-pay-walkin', 'demo-tm-lisa');
  orders.push({
    id: 'demo-ord-walkin', location_id: s.locations[0].id, state: 'COMPLETED', created_at: walkIn, updated_at: walkIn, closed_at: walkIn,
    line_items: [
      { uid: 'walkin-1', name: DEMO_PRODUCTS[5].itemName, quantity: '2', catalog_object_id: DEMO_PRODUCTS[5].variationId, item_type: 'ITEM',
        base_price_money: money(6500), gross_sales_money: money(13000), total_discount_money: money(0), total_money: money(13000) },
      { uid: 'walkin-2', name: 'Custom amount', quantity: '1', item_type: 'CUSTOM_AMOUNT',
        base_price_money: money(4000), gross_sales_money: money(4000), total_discount_money: money(0), total_money: money(4000) },
    ],
    tenders: [{ id: 't-walkin', payment_id: 'demo-pay-walkin', type: 'CARD', amount_money: money(17000), tip_money: money(0) }],
    total_money: money(17000), total_tip_money: money(0),
  });
  // Itemized refund: one care kit from the walk-in sale is returned (a separate return order, like Square makes).
  const ret = new Date(now - 1 * 86400_000).toISOString();
  orders.push({
    id: 'demo-ord-return-1', location_id: s.locations[0].id, state: 'COMPLETED', created_at: ret, updated_at: ret, closed_at: ret,
    returns: [{ uid: 'ret-1', source_order_id: 'demo-ord-walkin', return_line_items: [
      { uid: 'ret-1-1', source_line_item_uid: 'walkin-1', name: DEMO_PRODUCTS[5].itemName, quantity: '1', catalog_object_id: DEMO_PRODUCTS[5].variationId,
        gross_return_money: money(6500), total_discount_money: money(0), total_money: money(6500) },
    ] }],
  });
  return [...orders, ...demoExtraOrders];
}

/** Demo retail catalog (generic example products) with stock at the demo location. */
const v = (id: string, itemName: string, variationName: string | null, sku: string | null, priceCents: number, trackInventory = true): SquareProductVariation =>
  ({ variationId: id, itemId: `item-${id}`, itemName, variationName, sku, upc: sku ? `0840${id.replace(/\D/g, '').padStart(8, '0')}` : null, priceCents, trackInventory });
export const DEMO_PRODUCTS: SquareProductVariation[] = [
  v('demo-v1', 'Signature Hand-Tied Weft', '20" / #60 Platinum', 'HTW-20-60', 42000),
  v('demo-v2', 'Signature Hand-Tied Weft', '20" / #18/22 Balayage', 'HTW-20-1822', 42000),
  v('demo-v3', 'Signature Hand-Tied Weft', '22" / #60 Platinum', 'HTW-22-60', 46000),
  v('demo-v4', 'K-Tip Extensions', '22" / #1B Natural Black', 'KTIP-22-1B', 38000),
  v('demo-v5', 'Tape-In Extensions', '16" / #8 Chestnut', 'TAPE-16-8', 29000),
  v('demo-v6', 'Extension Care Kit', null, 'CARE-KIT', 6500),
  v('demo-v7', 'Bond Remover', null, 'BOND-RMV', 2400),
  v('demo-v8', 'Gift Card', null, null, 5000, false),
];
const DEMO_COUNTS: SquareInventoryCount[] = [
  ['demo-v1', 12], ['demo-v2', 4], ['demo-v3', 0], ['demo-v4', 7], ['demo-v5', 9], ['demo-v6', 22], ['demo-v7', 15],
].map(([id, q]) => ({ variationId: id as string, locationId: 'demo-location', quantity: q as number, calculatedAt: null }));

/** Demo stock, changeable by the inventory sync (and by tests). */
export const demoSquareStock = new Map<string, number>();
/** Test hook: make the next stock write fail. */
export const demoSquareHooks: { failNext: Error | null } = { failNext: null };
const demoSquareApplied = new Set<string>();
/** SKUs changed in the demo catalog (cleared by resetDemoSquareStock). */
export const demoSquareSkus = new Map<string, string>();
/** Demo price changes (Inventory → Pricing). */
export const demoSquarePrices = new Map<string, number>();
export function resetDemoSquareStock() {
  demoSquareStock.clear();
  demoSquareSkus.clear();
  demoSquareApplied.clear();
  for (const c of DEMO_COUNTS) demoSquareStock.set(c.variationId, c.quantity);
}
resetDemoSquareStock();

/** Simulator actions used by Demo Mode buttons and the automated workflow tests. */
export const demoSquareSimulator = {
  async updateBooking(id: string, patch: Partial<SquareBooking>): Promise<SquareBooking> {
    const s = await loadDemoSquare();
    const b = s.bookings.find((x) => x.id === id);
    if (!b) throw new Error('Demo booking not found');
    Object.assign(b, patch, { version: (b.version ?? 1) + 1, updated_at: new Date().toISOString() });
    await saveDemoSquare(s);
    return b;
  },
  async createBooking(b: Omit<SquareBooking, 'id' | 'version' | 'created_at' | 'updated_at'>, customer?: SquareCustomer) {
    const s = await loadDemoSquare();
    if (customer && !s.customers.some((c) => c.id === customer.id)) s.customers.push(customer);
    const booking: SquareBooking = {
      ...b,
      id: `demo-bk-${Math.random().toString(36).slice(2, 10)}`,
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    s.bookings.push(booking);
    await saveDemoSquare(s);
    return booking;
  },
};
