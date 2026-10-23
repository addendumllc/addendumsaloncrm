import type {
  CommissionEntryDTO,
  CommissionRuleDTO,
  CommissionSettings,
  CommissionStatusDTO,
  CommissionSummaryDTO,
  CommissionTier,
  CommissionSuggestion,
} from '@addendum/shared';
import { db } from '../db/index.js';
import { squareService } from '../integrations/registry.js';
import type { SquareOrder, SquareOrderLineItem } from '../integrations/square/types.js';
import { badRequest, IntegrationError, notFound } from '../lib/errors.js';
import { iso } from '../lib/time.js';
import { getKV, getSettings, setKV } from '../repos/settings.js';
import { hoursSyncError, syncTimecards } from './wages.js';
import { addDaysToDate, localDate } from './rebookingSchedule.js';

/**
 * Commission, calculated in the CRM from verified Square sales and the rules an administrator sets.
 *
 * What Square provides (verified against Square's SDK v46 types): orders with line items, discounts, returns and
 * refunds (Orders API, ORDERS_READ); payments with tips and the team member who took the payment (Payments API,
 * PAYMENTS_READ). Square does NOT record which team member performed a line item, and has no commission API.
 * So who did the work comes from the matching booking (same Square customer, same day, same service), with the
 * payment's team member and the salon's rules as fallbacks — and anything that can't be matched reliably goes to
 * "Needs review" instead of being guessed.
 *
 * How it stays accurate:
 *   - Square sales are stored as received; commission records are rebuilt from them, keyed by
 *     order + line item + stylist, so syncing twice never duplicates anything.
 *   - Estimated records follow the current rules. Finalized records are never recalculated — they keep the rate
 *     and calculation they were finalized with. Later refunds become new records on an open date.
 *   - Every record stores how it was worked out, in plain words, and has a history of changes.
 */

type Settings = CommissionSettings;
const RUN_STALE_MS = 15 * 60_000;
const LAST_SUCCESS_KEY = 'commission.last_success';
const CURSOR_KEY = 'commission.cursor';

const cents = (m?: { amount?: number | null } | null) => Math.round(Number(m?.amount ?? 0));
const money = (c: number) => `${c < 0 ? '−' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;

// ---------- Rules ----------
export interface RuleInput {
  staffId: string | null;
  category: 'service' | 'retail';
  targetType: 'all' | 'service' | 'product';
  targetId: string | null;
  method: 'percent' | 'flat' | 'tiered';
  rateBps: number | null;
  flatCents: number | null;
  tiers: CommissionTier[] | null;
  tierPeriod: 'month' | 'week';
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
}

export function ruleLabel(r: { method: string; rate_bps?: number | null; flat_cents?: number | null; tiers?: CommissionTier[] | null; tier_period?: string }) {
  if (r.method === 'percent') return `${pct(r.rate_bps ?? 0)} of sales`;
  if (r.method === 'flat') return `${money(r.flat_cents ?? 0)} per item`;
  const tiers = r.tiers ?? [];
  return `Tiered (${r.tier_period === 'week' ? 'weekly' : 'monthly'} sales): ${tiers.map((t, i) => {
    const from = i === 0 ? 0 : tiers[i - 1].upToCents ?? 0;
    return t.upToCents == null ? `${pct(t.rateBps)} above ${money(from)}` : `${pct(t.rateBps)} up to ${money(t.upToCents)}`;
  }).join(', ')}`;
}

function toRuleDTO(r: any, today: string): CommissionRuleDTO {
  const from = typeof r.effective_from === 'string' ? r.effective_from : r.effective_from_s;
  return {
    id: r.id,
    staffId: r.staff_id,
    staffName: r.staff_name ?? null,
    category: r.category,
    targetType: r.target_type,
    targetId: r.target_id,
    targetName: r.target_name,
    method: r.method,
    rateBps: r.rate_bps,
    flatCents: r.flat_cents,
    tiers: r.tiers,
    tierPeriod: r.tier_period,
    effectiveFrom: r.effective_from_s ?? from,
    effectiveTo: r.effective_to_s ?? null,
    note: r.note,
    createdByName: r.created_by_name ?? null,
    createdAt: iso(r.created_at)!,
    active: r.effective_from_s <= today && (!r.effective_to_s || r.effective_to_s >= today),
    label: ruleLabel(r),
    usedCount: r.used_count ?? 0,
    locked: !!r.locked,
  };
}

const RULE_SELECT = `
  SELECT r.*, to_char(r.effective_from, 'YYYY-MM-DD') AS effective_from_s, to_char(r.effective_to, 'YYYY-MM-DD') AS effective_to_s,
         s.name AS staff_name, cb.name AS created_by_name,
         (SELECT count(*)::int FROM commission_entries e WHERE e.rule_id = r.id AND e.status <> 'void') AS used_count,
         EXISTS (SELECT 1 FROM commission_entries e WHERE e.rule_id = r.id AND e.status = 'finalized') AS locked
    FROM commission_rules r LEFT JOIN staff s ON s.id = r.staff_id LEFT JOIN staff cb ON cb.id = r.created_by_staff_id`;

export async function listRules(): Promise<CommissionRuleDTO[]> {
  const today = localDate(new Date(), (await getSettings()).business.timezone);
  const rows = await db().query(`${RULE_SELECT} ORDER BY r.staff_id NULLS FIRST, r.category, r.target_type, r.effective_from DESC`);
  return rows.map((r) => toRuleDTO(r, today));
}

export function validateRuleInput(r: RuleInput): string | null {
  if (r.targetType === 'all' && r.targetId) return 'Choose a specific service or product, or “all”.';
  if (r.targetType !== 'all' && !r.targetId) return 'Choose which service or product this rule is for.';
  if (r.targetType === 'service' && r.category !== 'service') return 'Service-specific rules belong to service commission.';
  if (r.targetType === 'product' && r.category !== 'retail') return 'Product-specific rules belong to retail commission.';
  if (r.method === 'percent' && (r.rateBps == null || r.rateBps < 0 || r.rateBps > 10000)) return 'Enter a percentage between 0 and 100.';
  if (r.method === 'flat' && (r.flatCents == null || r.flatCents < 0)) return 'Enter the flat amount per item.';
  if (r.method === 'tiered') {
    const t = r.tiers ?? [];
    if (t.length < 2) return 'Tiered commission needs at least two tiers.';
    for (let i = 0; i < t.length; i++) {
      if (t[i].rateBps < 0 || t[i].rateBps > 10000) return 'Each tier needs a percentage between 0 and 100.';
      const last = i === t.length - 1;
      if (last !== (t[i].upToCents == null)) return 'Only the last tier is open-ended ("and above").';
      if (!last && i > 0 && (t[i].upToCents ?? 0) <= (t[i - 1].upToCents ?? 0)) return 'Tier limits must go up.';
    }
  }
  if (r.effectiveTo && r.effectiveTo < r.effectiveFrom) return 'The end date is before the start date.';
  return null;
}

/** Validates a rule and looks up the name of the service or product it's for. */
async function checkRuleInput(r: RuleInput): Promise<string | null> {
  const problem = validateRuleInput(r);
  if (problem) throw badRequest(problem);
  let targetName: string | null = null;
  if (r.targetType === 'service') {
    targetName = (await db().one<any>('SELECT name FROM services WHERE id = $1', [r.targetId]))?.name ?? null;
    if (!targetName) throw badRequest('That service could not be found.');
  } else if (r.targetType === 'product') {
    const p = await db().one<any>('SELECT item_name, variation_name FROM square_inventory WHERE variation_id = $1', [r.targetId]);
    if (!p) throw badRequest('That product could not be found in the Square catalog.');
    targetName = [p.item_name, p.variation_name].filter(Boolean).join(' — ');
  }
  if (r.staffId && !(await db().one('SELECT 1 FROM staff WHERE id = $1', [r.staffId]))) throw badRequest('That team member could not be found.');
  return targetName;
}

export async function createRule(r: RuleInput, staffId: string | null) {
  const targetName = await checkRuleInput(r);
  // A new rule for exactly the same person + item replaces the current one from its start date (history is kept).
  await db().query(
    `UPDATE commission_rules SET effective_to = ($6::date - 1), ended_by_staff_id = $7, ended_at = now()
      WHERE staff_id IS NOT DISTINCT FROM $1 AND category = $2 AND target_type = $3 AND target_id IS NOT DISTINCT FROM $4
        AND effective_from < $6::date AND (effective_to IS NULL OR effective_to >= $6::date) AND $5`,
    [r.staffId, r.category, r.targetType, r.targetId, true, r.effectiveFrom, staffId],
  );
  const clash = await db().one(
    `SELECT 1 FROM commission_rules WHERE staff_id IS NOT DISTINCT FROM $1 AND category = $2 AND target_type = $3
        AND target_id IS NOT DISTINCT FROM $4 AND effective_from >= $5::date`,
    [r.staffId, r.category, r.targetType, r.targetId, r.effectiveFrom]);
  if (clash) throw badRequest('There’s already a rule for this starting on or after that date. End or delete it first.');
  const row = await db().one<{ id: string }>(
    `INSERT INTO commission_rules(staff_id, category, target_type, target_id, target_name, method, rate_bps, flat_cents, tiers, tier_period,
        effective_from, effective_to, note, created_by_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14) RETURNING id`,
    [r.staffId, r.category, r.targetType, r.targetId, targetName, r.method, r.method === 'percent' ? r.rateBps : null,
      r.method === 'flat' ? r.flatCents : null, r.method === 'tiered' ? JSON.stringify(r.tiers) : null, r.tierPeriod,
      r.effectiveFrom, r.effectiveTo, r.note, staffId],
  );
  return row!.id;
}

/**
 * Changes a rule in place (fixing a typo, a wrong rate or dates). Rules already used for finalized commission can't be
 * rewritten — that would misstate paid history — so those change by adding a new rate from a date instead.
 */
export async function updateRule(id: string, r: RuleInput) {
  if (!(await db().one('SELECT 1 FROM commission_rules WHERE id = $1', [id]))) throw notFound('That rule');
  if (await db().one("SELECT 1 FROM commission_entries WHERE rule_id = $1 AND status = 'finalized'", [id])) {
    throw badRequest('This rate was used for finalized commission, so it can’t be changed in place. Add the new rate from the date it starts instead.');
  }
  const targetName = await checkRuleInput(r);
  const overlap = await db().one(
    `SELECT 1 FROM commission_rules WHERE id <> $1 AND staff_id IS NOT DISTINCT FROM $2 AND category = $3 AND target_type = $4
        AND target_id IS NOT DISTINCT FROM $5 AND effective_from <= COALESCE($7::date, 'infinity'::date)
        AND COALESCE(effective_to, 'infinity'::date) >= $6::date`,
    [id, r.staffId, r.category, r.targetType, r.targetId, r.effectiveFrom, r.effectiveTo]);
  if (overlap) throw badRequest('Those dates overlap another rate for the same person and item. Change the dates, or end or delete the other rate first.');
  await db().query(
    `UPDATE commission_rules SET staff_id = $2, category = $3, target_type = $4, target_id = $5, target_name = $6, method = $7,
        rate_bps = $8, flat_cents = $9, tiers = $10::jsonb, tier_period = $11, effective_from = $12, effective_to = $13, note = $14
      WHERE id = $1`,
    [id, r.staffId, r.category, r.targetType, r.targetId, targetName, r.method, r.method === 'percent' ? r.rateBps : null,
      r.method === 'flat' ? r.flatCents : null, r.method === 'tiered' ? JSON.stringify(r.tiers) : null, r.tierPeriod,
      r.effectiveFrom, r.effectiveTo, r.note],
  );
}

/** Ends a rule on a date (it stays in the history). */
export async function endRule(id: string, endDate: string, staffId: string | null) {
  const r = await db().one<any>("SELECT id, to_char(effective_from, 'YYYY-MM-DD') AS f FROM commission_rules WHERE id = $1", [id]);
  if (!r) throw notFound('That rule');
  if (endDate < r.f) throw badRequest('The end date is before the rule starts. Delete the rule instead.');
  await db().query('UPDATE commission_rules SET effective_to = $2, ended_by_staff_id = $3, ended_at = now() WHERE id = $1', [id, endDate, staffId]);
}

/** Only rules that were never used by a finalized record can be deleted; otherwise end them. */
export async function deleteRule(id: string) {
  if (await db().one("SELECT 1 FROM commission_entries WHERE rule_id = $1 AND status = 'finalized'", [id])) {
    throw badRequest('This rule was used for finalized commission, so it stays in the history. End it instead.');
  }
  await db().query("UPDATE commission_entries SET rule_id = NULL WHERE rule_id = $1 AND status <> 'finalized'", [id]);
  await db().query('DELETE FROM commission_rules WHERE id = $1', [id]);
}

// ---------- Square sync ----------
let running: Promise<string> | null = null;

export async function commissionStatus(): Promise<CommissionStatusDTO> {
  const s = (await getSettings()).commission;
  const sq = await squareService();
  const last = await db().one<any>('SELECT * FROM commission_sync_runs ORDER BY started_at DESC LIMIT 1');
  // The count by Needs review in the menu: the same last month it shows by default.
  const range = await reviewRange();
  const review = await db().one<{ n: number }>(
    "SELECT count(*)::int AS n FROM commission_entries WHERE needs_review AND status = 'estimated' AND transaction_date BETWEEN $1::date AND $2::date", [range.from, range.to]);
  const unlinked = await db().query<{ t: string }>(
    `SELECT DISTINCT t FROM (
       SELECT jsonb_array_elements(a.raw->'appointment_segments')->>'team_member_id' AS t FROM appointments a
        WHERE a.raw IS NOT NULL AND a.start_at > now() - interval '120 days'
       UNION SELECT team_member_id FROM commission_payments) x
     WHERE t IS NOT NULL AND NOT EXISTS (SELECT 1 FROM staff WHERE square_team_member_id = x.t)`);
  const missing: string[] = [];
  if (!sq) missing.push('Connect Square in Settings → API & Integrations (Square access token, or Connect with Square).');
  if (!s.enabled) missing.push('Turn on commission in Settings → Commission.');
  if (!(await db().one('SELECT 1 FROM commission_rules LIMIT 1'))) missing.push('Add at least one commission rule (rates) in Settings → Commission.');
  return {
    enabled: s.enabled,
    squareConnected: !!sq,
    lastSuccessfulSyncAt: (await getKV<string>(LAST_SUCCESS_KEY)) ?? null,
    lastRun: last ? {
      id: last.id, status: last.status, startedAt: iso(last.started_at)!, finishedAt: iso(last.finished_at), message: last.message,
      ordersSeen: last.orders_seen, created: last.created, updated: last.updated, needsReview: last.needs_review,
    } : null,
    needsReview: review?.n ?? 0,
    unlinkedTeamMembers: unlinked.map((u) => u.t),
    missing,
    disclaimer: s.disclaimer ?? '',
    hoursSyncError: await hoursSyncError(),
    paySchedule: s.paySchedule,
  };
}

/** Pulls new and changed Square orders and payments, then rebuilds estimated commission. One run at a time. */
export function syncCommission(opts: { trigger: 'manual' | 'auto'; staffId?: string | null }): Promise<string> {
  if (running) return running;
  running = doSync(opts).finally(() => (running = null));
  return running;
}

async function doSync(opts: { trigger: 'manual' | 'auto'; staffId?: string | null }): Promise<string> {
  await db().query(`UPDATE commission_sync_runs SET status = 'failed', finished_at = now(), message = 'Stopped unexpectedly.'
    WHERE status = 'running' AND started_at < $1`, [new Date(Date.now() - RUN_STALE_MS)]);
  const run = await db().one<{ id: string }>('INSERT INTO commission_sync_runs(trigger, started_by_staff_id) VALUES ($1,$2) RETURNING id', [opts.trigger, opts.staffId ?? null]);
  const id = run!.id;
  try {
    const settings = await getSettings();
    if (!settings.commission.enabled) throw new IntegrationError('square', 'Commission is turned off. Turn it on in Settings → Commission.', false);
    const sq = await squareService();
    if (!sq) throw new IntegrationError('square', 'Square isn’t connected. Add Square in Settings → API & Integrations, then sync again.', false, true);
    const now = new Date();
    const cursor = await getKV<string>(CURSOR_KEY);
    const start = settings.commission.syncStartDate
      ? new Date(`${settings.commission.syncStartDate}T00:00:00Z`)
      : new Date(now.getTime() - 90 * 86400_000);
    // Re-read a little overlap so nothing at the boundary is missed (stored orders are de-duplicated by id).
    const from = cursor ? new Date(Math.max(new Date(cursor).getTime() - 10 * 60_000, start.getTime())) : start;
    const locations = (await sq.listLocations()).map((l) => l.id);
    if (!locations.length) throw new IntegrationError('square', 'No Square locations were found for this account.', false);
    let orders: SquareOrder[];
    try {
      orders = await sq.searchOrders(locations, from, now);
    } catch (e) {
      throw scopeHint(e);
    }
    let maxUpdated = cursor ?? null;
    for (const o of orders) {
      const isReturn = !!o.returns?.length && !(o.line_items?.length);
      await db().query(
        `INSERT INTO commission_orders(order_id, location_id, customer_id, state, closed_at, square_updated_at, is_return, raw, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, now())
         ON CONFLICT (order_id) DO UPDATE SET location_id = EXCLUDED.location_id, customer_id = EXCLUDED.customer_id, state = EXCLUDED.state,
           closed_at = EXCLUDED.closed_at, square_updated_at = EXCLUDED.square_updated_at, is_return = EXCLUDED.is_return, raw = EXCLUDED.raw, synced_at = now()
         WHERE commission_orders.square_updated_at IS NULL OR EXCLUDED.square_updated_at >= commission_orders.square_updated_at`,
        [o.id, o.location_id, o.customer_id ?? null, o.state ?? null, o.closed_at ?? null, o.updated_at ?? null, isReturn, JSON.stringify(slimOrder(o))],
      );
      if (o.updated_at && (!maxUpdated || o.updated_at > maxUpdated)) maxUpdated = o.updated_at;
    }
    // Payments for the same period: tips and who took each payment.
    const earliest = orders.reduce((m, o) => Math.min(m, new Date(o.closed_at ?? o.created_at ?? now).getTime()), from.getTime());
    let payments;
    try {
      payments = await sq.listPayments(new Date(earliest - 86400_000), now);
    } catch (e) {
      throw scopeHint(e);
    }
    for (const p of payments) {
      await db().query(
        `INSERT INTO commission_payments(payment_id, order_id, team_member_id, status, tip_cents, created_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (payment_id) DO UPDATE SET order_id = EXCLUDED.order_id, team_member_id = EXCLUDED.team_member_id, status = EXCLUDED.status,
           tip_cents = EXCLUDED.tip_cents`,
        [p.id, p.order_id ?? null, p.team_member_id ?? null, p.status ?? null, cents(p.tip_money), p.created_at ?? null],
      );
    }
    // Hours for hourly wages (never fails the sync; a missing TIMECARDS_READ permission is shown on Team Commission).
    // The last 5 weeks are re-read, so changes made in Square to a past pay period reach My Commission too.
    await syncTimecards(sq, new Date(Math.min(from.getTime(), now.getTime() - 35 * 86400_000)), now);
    const r = await rebuildCommission();
    if (maxUpdated) await setKV(CURSOR_KEY, maxUpdated);
    await setKV(LAST_SUCCESS_KEY, new Date().toISOString());
    await db().query(
      `UPDATE commission_sync_runs SET status = 'ok', finished_at = now(), orders_seen = $2, created = $3, updated = $4, voided = $5, needs_review = $6,
         message = $7 WHERE id = $1`,
      [id, orders.length, r.created, r.updated, r.voided, r.needsReview,
        `${orders.length} Square order${orders.length === 1 ? '' : 's'} checked · ${r.created} new · ${r.updated} updated${r.needsReview ? ` · ${r.needsReview} need review` : ''}`],
    );
  } catch (e) {
    const msg = e instanceof IntegrationError ? e.userMessage : 'The commission sync failed. Nothing was changed; try again.';
    if (!(e instanceof IntegrationError)) console.error('[commission] sync failed', (e as Error).message);
    await db().query(`UPDATE commission_sync_runs SET status = 'failed', finished_at = now(), message = $2 WHERE id = $1`, [id, msg]);
  }
  return id;
}

function scopeHint(e: unknown) {
  if (e instanceof IntegrationError && e.authProblem && /permission/i.test(e.userMessage)) {
    return new IntegrationError('square', 'Square didn’t allow reading sales. Commission needs the ORDERS_READ and PAYMENTS_READ permissions: reconnect Square (or use a token with those permissions) in Settings → API & Integrations.', false, true);
  }
  return e;
}

/** Keeps only what commission uses (no card details or personal data). */
function slimOrder(o: SquareOrder): SquareOrder {
  return {
    id: o.id, location_id: o.location_id, customer_id: o.customer_id, state: o.state, version: o.version,
    created_at: o.created_at, updated_at: o.updated_at, closed_at: o.closed_at,
    line_items: o.line_items?.map((l) => ({
      uid: l.uid, name: l.name, quantity: l.quantity, catalog_object_id: l.catalog_object_id, variation_name: l.variation_name, item_type: l.item_type,
      base_price_money: l.base_price_money, gross_sales_money: l.gross_sales_money, total_discount_money: l.total_discount_money, total_money: l.total_money,
    })),
    returns: o.returns?.map((r) => ({ uid: r.uid, source_order_id: r.source_order_id, return_line_items: r.return_line_items?.map((x) => ({
      uid: x.uid, source_line_item_uid: x.source_line_item_uid, name: x.name, quantity: x.quantity, catalog_object_id: x.catalog_object_id,
      item_type: x.item_type, gross_return_money: x.gross_return_money, total_discount_money: x.total_discount_money, total_money: x.total_money,
    })) })),
    refunds: o.refunds?.map((r) => ({ id: r.id, tender_id: r.tender_id, amount_money: r.amount_money, status: r.status })),
    tenders: o.tenders?.map((t) => ({ id: t.id, payment_id: t.payment_id, type: t.type, amount_money: t.amount_money, tip_money: t.tip_money })),
    total_money: o.total_money, total_tip_money: o.total_tip_money, total_discount_money: o.total_discount_money,
  };
}

export async function maybeAutoSyncCommission(now = new Date()) {
  const s = (await getSettings()).commission;
  if (!s.enabled || !s.autoSync || !(await squareService())) return null;
  const last = await db().one<any>('SELECT started_at FROM commission_sync_runs ORDER BY started_at DESC LIMIT 1');
  if (last && now.getTime() - new Date(last.started_at).getTime() < s.syncIntervalMinutes * 60_000) return null;
  return syncCommission({ trigger: 'auto' });
}

// ---------- Rebuild: Square sales + rules → commission records ----------
interface Desired {
  source_key: string;
  staff_id: string | null;
  kind: 'sale' | 'refund' | 'tip';
  category: 'service' | 'retail' | 'tip' | 'other';
  square_order_id: string;
  square_line_item_uid: string | null;
  square_payment_ids: string[];
  source_order_id: string | null;
  appointment_id: string | null;
  service_id: string | null;
  catalog_object_id: string | null;
  item_name: string;
  quantity: number;
  share: number;
  transaction_at: Date;
  transaction_date: string;
  service_date: string | null;
  posted_date: string;
  gross_cents: number;
  discount_cents: number;
  eligible_cents: number;
  net_sales_cents: number;
  tip_cents: number;
  rule_id: string | null;
  method: string | null;
  rate_bps: number | null;
  flat_cents: number | null;
  commission_cents: number;
  calc: { steps: string[]; rule?: string | null; basis?: string | null };
  attribution: string | null;
  needs_review: boolean;
  review_reason: string | null;
  line_key: string | null;
  /** Credited, but not counted in pay until confirmed (several stylists split evenly; a product-only sale). */
  on_hold?: boolean;
}

interface Rule {
  id: string; staff_id: string | null; category: string; target_type: string; target_id: string | null; target_name: string | null;
  method: string; rate_bps: number | null; flat_cents: number | null; tiers: CommissionTier[] | null; tier_period: string; from: string; to: string | null;
}

export async function rebuildCommission(now = new Date()) {
  const settings = await getSettings();
  const cs = settings.commission;
  const tz = settings.business.timezone;
  const today = localDate(now, tz);

  const staffByTm = new Map((await db().query<any>('SELECT id, square_team_member_id FROM staff WHERE square_team_member_id IS NOT NULL'))
    .map((s) => [s.square_team_member_id as string, s.id as string]));
  const staffRows = await db().query<any>('SELECT id, name, tip_eligible FROM staff');
  const staffNames = new Map(staffRows.map((s) => [s.id, s.name]));
  const notTipEligible = new Set(staffRows.filter((s) => s.tip_eligible === false).map((s) => s.id as string));
  const services = new Map((await db().query<any>('SELECT id, name, square_variation_id FROM services WHERE square_variation_id IS NOT NULL'))
    .map((s) => [s.square_variation_id as string, { id: s.id as string, name: s.name as string }]));
  const products = new Set((await db().query<any>('SELECT variation_id FROM square_inventory')).map((p) => p.variation_id as string));
  const appts = await db().query<any>(
    `SELECT id, square_customer_id, start_at, square_status, raw->'appointment_segments' AS segments FROM appointments
      WHERE square_customer_id IS NOT NULL AND square_status IN ('ACCEPTED','PENDING','NO_SHOW')`);
  const apptsByKey = new Map<string, any[]>();
  for (const a of appts) {
    const k = `${a.square_customer_id}|${localDate(a.start_at, tz)}`;
    apptsByKey.set(k, [...(apptsByKey.get(k) ?? []), a]);
  }
  const orders = await db().query<any>("SELECT order_id, raw FROM commission_orders WHERE state = 'COMPLETED' ORDER BY closed_at");
  const paymentsByOrder = new Map<string, { id: string; team_member_id: string | null }[]>();
  for (const p of await db().query<any>("SELECT payment_id, order_id, team_member_id FROM commission_payments WHERE status IS NULL OR status = 'COMPLETED'")) {
    if (!p.order_id) continue;
    paymentsByOrder.set(p.order_id, [...(paymentsByOrder.get(p.order_id) ?? []), { id: p.payment_id, team_member_id: p.team_member_id }]);
  }
  const attributions = new Map((await db().query<any>('SELECT line_key, staff_ids FROM commission_attributions')).map((a) => [a.line_key, a.staff_ids as string[]]));
  const accepted = new Set((await db().query<any>('SELECT source_key FROM commission_review_accepted')).map((a) => a.source_key as string));
  const periods = await db().query<any>("SELECT to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS e FROM commission_periods");
  const inFinalized = (d: string) => periods.some((p) => d >= p.s && d <= p.e);
  const existing = new Map((await db().query<any>(
    `SELECT id, source_key, status, staff_id, commission_cents, eligible_cents, rate_bps, flat_cents, method, rule_id, needs_review, review_reason,
            posted_date::text AS posted_date, kind, category, share, transaction_at, square_order_id, square_line_item_uid, item_name, quantity,
            gross_cents, discount_cents, net_sales_cents, tip_cents, appointment_id, calc
       FROM commission_entries WHERE source_key NOT LIKE 'adj:%'`)).map((e) => [e.source_key as string, e]));
  const rules: Rule[] = (await db().query<any>(
    `SELECT id, staff_id, category, target_type, target_id, target_name, method, rate_bps, flat_cents, tiers, tier_period,
            to_char(effective_from, 'YYYY-MM-DD') AS "from", to_char(effective_to, 'YYYY-MM-DD') AS "to" FROM commission_rules`));

  const desired: Desired[] = [];
  const tm = (id: string | null | undefined) => (id ? staffByTm.get(id) ?? null : null);

  // When Square didn't record who checked out: the client's preferred stylist, whoever was on the clock, a backup person.
  // Saved settings from before this option existed fall back to the defaults (settings are deep-merged on read).
  const uc = cs.unrecordedCheckout ?? { clientStylist: true, onTheClock: true, fallbackStaffId: null, hold: true };
  const roles = new Map((await db().query<any>('SELECT id, role, active, commission_suggest FROM staff')).map((s) => [s.id as string, s]));
  const preferredByCustomer = new Map((await db().query<any>(
    'SELECT square_customer_id, preferred_staff_id FROM clients WHERE square_customer_id IS NOT NULL AND preferred_staff_id IS NOT NULL'))
    .map((c) => [c.square_customer_id as string, c.preferred_staff_id as string]));
  const shifts = await db().query<any>(
    `SELECT s.staff_id, s.clock_in_at, s.clock_out_at,
            COALESCE((SELECT json_agg(json_build_object('s', b.started_at, 'e', b.ended_at)) FROM time_clock_breaks b WHERE b.shift_id = s.id AND NOT b.paid), '[]') AS breaks
       FROM time_clock_shifts s`);
  const onTheClockAt = (at: Date) => shifts.filter((s) => {
    if (new Date(s.clock_in_at) > at || (s.clock_out_at && new Date(s.clock_out_at) < at)) return false;
    const breaks = typeof s.breaks === 'string' ? JSON.parse(s.breaks) : s.breaks;
    return !breaks.some((b: any) => new Date(b.s) <= at && (!b.e || new Date(b.e) >= at)); // out on lunch
  }).map((s) => s.staff_id as string);
  const fallbackFor = (customerId: string | null | undefined, at: Date) => {
    const suggestions: CommissionSuggestion[] = [];
    const add = (id: string | null | undefined, why: string) => {
      // Never someone who's switched off for suggestions (e.g. never at the salon) — they're credited only when chosen.
      if (id && staffNames.has(id) && roles.get(id)?.active !== false && roles.get(id)?.commission_suggest !== false && !suggestions.some((s) => s.staffId === id)) suggestions.push({ staffId: id, name: staffNames.get(id)!, why });
      return suggestions.find((s) => s.staffId === id) ?? null;
    };
    let pick: CommissionSuggestion | null = null;
    const pref = add(customerId ? preferredByCustomer.get(customerId) : null, 'the client’s preferred stylist');
    if (uc.clientStylist && pref) pick = pref;
    const time = at.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    const clocked = [...new Set(onTheClockAt(at))];
    const desk = clocked.filter((id) => roles.get(id)?.role === 'receptionist');
    for (const id of desk) add(id, `front desk, on the clock at ${time}`);
    for (const id of clocked) add(id, `on the clock at ${time}`);
    const only = desk.length === 1 ? desk[0] : clocked.length === 1 ? clocked[0] : null;
    if (uc.onTheClock && !pick && only) pick = suggestions.find((s) => s.staffId === only) ?? null;
    const backup = add(uc.fallbackStaffId, 'the backup person in commission settings');
    if (!pick && backup) pick = backup;
    return { pick, suggestions: suggestions.slice(0, 4) };
  };
  const NOBODY = 'No client on the ticket and Square didn’t record who checked out (sign in to Square POS as yourself when taking payment). Choose who gets credit.';

  const base = (o: any, txDate: string, at: Date): Pick<Desired, 'square_order_id' | 'transaction_at' | 'transaction_date' | 'posted_date' | 'square_payment_ids'> => ({
    square_order_id: o.id, transaction_at: at, transaction_date: txDate, posted_date: txDate,
    square_payment_ids: (paymentsByOrder.get(o.id) ?? []).map((p) => p.id),
  });

  // 1. Sales
  for (const { raw: o } of orders as { raw: SquareOrder }[]) {
    if (!o.line_items?.length) continue;
    const at = new Date(o.closed_at ?? o.created_at ?? now);
    const txDate = localDate(at, tz);
    const visits = o.customer_id ? apptsByKey.get(`${o.customer_id}|${txDate}`) ?? [] : [];
    const visit = visits.find((a) => a.square_status === 'ACCEPTED') ?? visits[0] ?? null;
    const segs: { service_variation_id?: string; team_member_id: string }[] = visit?.segments ?? [];
    const providerTms = [...new Set(segs.map((s) => s.team_member_id))];
    const providers = providerTms.map(tm);
    const payTms = [...new Set((paymentsByOrder.get(o.id) ?? []).map((p) => p.team_member_id).filter(Boolean) as string[])];
    // Who checked the client out: the team member on the ticket's payment (with split payments, the first one linked to a CRM account).
    const payStaff = payTms.map(tm).find(Boolean) ?? null;
    const serviceDate = visit ? localDate(visit.start_at, tz) : null;
    const saleRows: Desired[] = [];
    // A ticket with only products (no service on it): credited to whoever checked out, on hold until confirmed.
    const productOnly = o.line_items.every((l: any) => !(l.catalog_object_id && services.get(l.catalog_object_id)));

    for (const line of o.line_items) {
      const lineKey = `${o.id}:${line.uid}`;
      const qty = Number(line.quantity) || 1;
      const gross = cents(line.gross_sales_money) || cents(line.base_price_money) * qty;
      const discount = cents(line.total_discount_money);
      const net = gross - discount;
      if (line.item_type === 'GIFT_CARD') continue; // selling a gift card isn't a sale of work or product
      const svc = line.catalog_object_id ? services.get(line.catalog_object_id) : undefined;
      let category: Desired['category'] = svc ? 'service' : line.catalog_object_id && products.has(line.catalog_object_id) ? 'retail' : 'other';
      const steps: string[] = [];
      let reviewReason: string | null = null;
      let onHold = false;
      let suggestions: CommissionSuggestion[] = [];
      /** Square didn't record who checked out: credit the likeliest person (on hold), or list them as choices. */
      const useFallback = () => {
        const fb = fallbackFor(o.customer_id, at);
        suggestions = fb.suggestions;
        if (!fb.pick) {
          reviewReason = o.customer_id ? 'Square didn’t record who checked out, and nobody fits from the client or the time clock. Choose who gets credit.' : NOBODY;
          return;
        }
        who = [{ staff: fb.pick.staffId, share: 1 }];
        attribution = 'fallback';
        steps.push(`Square didn’t record who checked out: credited to ${fb.pick.name} (${fb.pick.why}).`);
        if (uc.hold) {
          onHold = true;
          reviewReason = `Square didn’t record who checked out — given to ${fb.pick.name} (${fb.pick.why}). On hold until you accept it or credit someone else.`;
        }
      };
      let eligible = cs.basis === 'before_discounts' ? gross : net;
      steps.push(`Square sale ${money(gross)}${discount ? ` − discount ${money(discount)} = ${money(net)}` : ''}.`);
      if (cs.basis === 'before_discounts' && discount) steps.push('Commission is on the price before discounts.');
      if (gross > 0 && net <= 0) {
        if (cs.zeroPriced === 'regular_price') {
          eligible = gross;
          steps.push('Paid with a package or 100% discount: commission on the regular price (salon rule).');
        } else if (cs.zeroPriced === 'review') {
          reviewReason = 'Paid with a package or 100% discount — decide whether commission applies.';
        } else {
          eligible = 0;
          steps.push('Paid with a package or 100% discount: no commission (salon rule).');
        }
      }
      if (category === 'other') reviewReason = line.item_type === 'CUSTOM_AMOUNT'
        ? 'Custom amount — Square doesn’t say what it was or who sold it.'
        : 'This item isn’t a known service or product in the Square catalog.';

      // Who did it?
      let who: { staff: string | null; share: number }[] = [];
      let attribution: string | null = null;
      const manual = attributions.get(lineKey);
      if (manual) {
        if (!manual.length) continue; // reviewed: no commission for this line
        who = manual.map((s) => ({ staff: s, share: 1 / manual.length }));
        attribution = 'manual';
        steps.push(`Credited by hand to ${manual.map((s) => staffNames.get(s) ?? 'team member').join(' and ')}.`);
        if (category === 'other') {
          reviewReason = null;
          category = 'retail';
          steps.push('Not a catalog item, so retail commission rules apply.');
        }
      } else if (category === 'service') {
        const matching = [...new Set(segs.filter((s) => s.service_variation_id === line.catalog_object_id).map((s) => s.team_member_id))];
        if (matching.length === 1) {
          who = [{ staff: tm(matching[0]), share: 1 }];
          attribution = 'booking';
          steps.push(`Provider from the Square booking on ${serviceDate}.`);
          if (!who[0].staff) reviewReason = `Square team member ${matching[0]} isn’t linked to a CRM account (Settings → Users & Permissions).`;
        } else if (matching.length > 1) {
          if (cs.multiProvider === 'split_evenly') {
            who = matching.map((t) => ({ staff: tm(t), share: 1 / matching.length }));
            attribution = 'split';
            steps.push(`${matching.length} providers on the booking: split evenly for now — on hold until the split is confirmed.`);
            onHold = true;
            reviewReason = who.some((w) => !w.staff) ? 'A provider on this booking isn’t linked to a CRM account.' : 'Several stylists worked on this service — split evenly and on hold. Confirm the split (or change it).';
          } else {
            reviewReason = 'Several providers worked on this service — choose who gets credit.';
          }
        } else if (providerTms.length === 1) {
          who = [{ staff: providers[0], share: 1 }];
          attribution = 'booking_single';
          steps.push(`Only provider on that day’s Square booking.`);
          if (!who[0].staff) reviewReason = `Square team member ${providerTms[0]} isn’t linked to a CRM account.`;
        } else {
          reviewReason = visit ? 'The booking doesn’t show who did this service.' : 'No Square booking matches this sale (same customer and day).';
        }
      } else if (category === 'retail' && productOnly && !visit) {
        // Product-only sale with no visit: the receptionist (whoever checked out) gets it, on hold until confirmed.
        if (payStaff) {
          who = [{ staff: payStaff, share: 1 }];
          attribution = 'payment';
          onHold = true;
          steps.push(`Product-only sale: credited to ${staffNames.get(payStaff) ?? 'the team member'} who checked out — on hold until confirmed.`);
          reviewReason = `Product-only sale — given to ${staffNames.get(payStaff) ?? 'who checked out'} (checked out). On hold until you accept it or credit someone else.`;
        } else if (payTms.length) {
          reviewReason = `Square team member ${payTms[0]} isn’t linked to a CRM account.`;
        } else {
          useFallback();
        }
      } else if (category === 'retail') {
        const byVisit = providerTms.length === 1 ? providers[0] : null;
        const pick = cs.productAttribution === 'payment_team_member' ? payStaff ?? byVisit : byVisit ?? payStaff;
        if (pick) {
          who = [{ staff: pick, share: 1 }];
          attribution = pick === byVisit && (cs.productAttribution === 'appointment_provider' || !payStaff) ? 'booking_single' : 'payment';
          steps.push(attribution === 'payment' ? 'Credited to the team member who took the payment in Square.' : 'Credited to the provider of that day’s visit.');
        } else if (payTms.length && !payStaff) {
          reviewReason = `Square team member ${payTms[0]} isn’t linked to a CRM account.`;
        } else {
          useFallback();
        }
      }
      if (!who.length) who = [{ staff: null, share: 1 }];
      // Anything left for review gets likely people as one-click choices.
      if (reviewReason && !suggestions.length) suggestions = fallbackFor(o.customer_id, at).suggestions;
      for (const w of who) {
        const key = w.staff ? `sale:${lineKey}:${w.staff}` : `sale:${lineKey}:review`;
        const shareEligible = Math.round(eligible * w.share);
        saleRows.push({
          ...base(o, txDate, at), source_key: key, staff_id: w.staff, kind: 'sale', category, square_line_item_uid: line.uid ?? null,
          source_order_id: null, appointment_id: visit?.id ?? null, service_id: svc?.id ?? null, catalog_object_id: line.catalog_object_id ?? null,
          item_name: [line.name, line.variation_name].filter(Boolean).join(' — ') || 'Item', quantity: qty, share: w.share, service_date: serviceDate,
          gross_cents: Math.round(gross * w.share), discount_cents: Math.round(discount * w.share), eligible_cents: shareEligible,
          net_sales_cents: Math.round(net * w.share), tip_cents: 0, rule_id: null, method: null, rate_bps: null, flat_cents: null,
          commission_cents: 0, calc: { steps: [...steps, ...(w.share < 1 ? [`Share ${Math.round(w.share * 100)}% → ${money(shareEligible)}.`] : [])], basis: cs.basis, ...(suggestions.length ? { suggestions } : {}) },
          attribution, needs_review: !!reviewReason || !w.staff, review_reason: reviewReason ?? (w.staff ? null : 'Needs a team member.'), line_key: lineKey,
          on_hold: onHold && !!w.staff,
        });
      }
    }
    desired.push(...saleRows);

    // Tips: shown separately, never part of commission.
    const tip = (o.tenders ?? []).reduce((a, t) => a + cents(t.tip_money), 0) || cents(o.total_tip_money);
    if (tip > 0 && cs.tips === 'separate') {
      let split: { staff: string | null; weight: number }[] = [];
      let how = '';
      const services = saleRows.filter((r) => r.category === 'service' && r.staff_id);
      const manualTip = attributions.get(`${o.id}:tip`);
      if (manualTip) {
        split = manualTip.map((staff) => ({ staff, weight: 1 }));
        how = 'Credited by hand.';
      } else if (cs.tipAttribution === 'service_share' && services.length) {
        const by = new Map<string, number>();
        for (const r of services) by.set(r.staff_id!, (by.get(r.staff_id!) ?? 0) + Math.max(r.net_sales_cents, r.gross_cents, 1));
        split = [...by].map(([staff, weight]) => ({ staff, weight }));
        how = by.size > 1 ? 'Split by each provider’s share of the services.' : 'Goes to the service provider.';
      } else if (payStaff) {
        split = [{ staff: payStaff, weight: 1 }];
        how = 'Goes to the team member who took the payment.';
      } else if (services.length) {
        split = [{ staff: services[0].staff_id, weight: 1 }];
        how = 'Goes to the service provider.';
      }
      const total = split.reduce((a, x) => a + x.weight, 0);
      let left = tip;
      // Someone who isn't tip eligible: their share is held for review (unless an admin credited this tip by hand).
      let held = 0;
      const heldFor: string[] = [];
      split.forEach((x, i) => {
        const amt = i === split.length - 1 ? left : Math.round(tip * (x.weight / total));
        left -= amt;
        if (!manualTip && x.staff && notTipEligible.has(x.staff)) {
          held += amt;
          heldFor.push(staffNames.get(x.staff) ?? 'Someone');
          return;
        }
        desired.push({
          ...base(o, txDate, at), source_key: `tip:${o.id}:${x.staff}`, staff_id: x.staff, kind: 'tip', category: 'tip', square_line_item_uid: null,
          source_order_id: null, appointment_id: visit?.id ?? null, service_id: null, catalog_object_id: null, item_name: 'Tip', quantity: 1,
          share: x.weight / total, service_date: serviceDate, gross_cents: 0, discount_cents: 0, eligible_cents: 0, net_sales_cents: 0, tip_cents: amt,
          rule_id: null, method: null, rate_bps: null, flat_cents: null, commission_cents: 0,
          calc: { steps: [`Tip ${money(tip)} on this sale. ${how}`, 'Tips are shown separately and are not commission.'] },
          attribution: null, needs_review: false, review_reason: null, line_key: null,
        });
      });
      if (held > 0) {
        desired.push({
          ...base(o, txDate, at), source_key: `tip:${o.id}:review`, staff_id: null, kind: 'tip', category: 'tip', square_line_item_uid: null,
          source_order_id: null, appointment_id: visit?.id ?? null, service_id: null, catalog_object_id: null, item_name: 'Tip', quantity: 1, share: held / tip,
          service_date: serviceDate, gross_cents: 0, discount_cents: 0, eligible_cents: 0, net_sales_cents: 0, tip_cents: held, rule_id: null, method: null,
          rate_bps: null, flat_cents: null, commission_cents: 0,
          calc: { steps: [`Tip ${money(tip)} on this sale. ${how}`, `${money(held)} would go to ${heldFor.join(' and ')}, who ${heldFor.length > 1 ? 'aren’t' : 'isn’t'} tip eligible.`] },
          attribution: null, needs_review: true, review_reason: `${heldFor.join(' and ')} ${heldFor.length > 1 ? 'aren’t' : 'isn’t'} tip eligible — credit this tip by hand.`, line_key: `${o.id}:tip`,
        });
      }
      if (!split.length && !manualTip) {
        desired.push({
          ...base(o, txDate, at), source_key: `tip:${o.id}:review`, staff_id: null, kind: 'tip', category: 'tip', square_line_item_uid: null,
          source_order_id: null, appointment_id: visit?.id ?? null, service_id: null, catalog_object_id: null, item_name: 'Tip', quantity: 1, share: 1,
          service_date: serviceDate, gross_cents: 0, discount_cents: 0, eligible_cents: 0, net_sales_cents: 0, tip_cents: tip, rule_id: null, method: null,
          rate_bps: null, flat_cents: null, commission_cents: 0, calc: { steps: [`Tip ${money(tip)} — nobody could be matched.`] },
          attribution: null, needs_review: true, review_reason: 'Square doesn’t show who this tip is for.', line_key: `${o.id}:tip`,
        });
      }
    }
  }

  // 2. Rates. Estimated sale records follow the current rules; tiers count everything earlier in the same period.
  const saleRecords = desired.filter((d) => d.kind === 'sale' && d.staff_id && d.category !== 'other');
  const finalizedSales = [...existing.values()].filter((e) => e.status === 'finalized' && e.kind === 'sale');
  const cumulative = new Map<string, number>();
  const timeline = [
    ...saleRecords.map((d) => ({ t: d.transaction_at.getTime(), d, fin: null as any })),
    ...finalizedSales.map((e) => ({ t: new Date(e.transaction_at).getTime(), d: null as Desired | null, fin: e })),
  ].sort((a, b) => a.t - b.t);
  for (const item of timeline) {
    if (item.fin) {
      const fin = item.fin;
      const r = rules.find((x) => x.id === fin.rule_id);
      if (r?.method === 'tiered') {
        const pk = periodKey(r.tier_period, localDate(fin.transaction_at, tz), fin.staff_id, fin.category);
        cumulative.set(pk, (cumulative.get(pk) ?? 0) + fin.eligible_cents);
      }
      continue;
    }
    const d = item.d!;
    if (existing.get(d.source_key)?.status === 'finalized') continue;
    const rule = pickRule(rules, d.staff_id!, d.category as 'service' | 'retail', d.service_id, d.catalog_object_id, d.transaction_date);
    if (!rule) {
      // No rule for this stylist and item: the salon's default rates (40% services, 10% products unless changed).
      const bps = d.category === 'service' ? cs.defaultServiceBps ?? 4000 : cs.defaultRetailBps ?? 1000;
      d.method = 'percent';
      d.rate_bps = bps;
      d.commission_cents = Math.round((d.eligible_cents * bps) / 10000);
      d.calc.rule = `Salon default · ${d.category === 'service' ? 'services' : 'products'} · ${pct(bps)}`;
      d.calc.steps.push(`No rule for this — salon default ${pct(bps)}: ${money(d.eligible_cents)} × ${pct(bps)} = ${money(d.commission_cents)}.`);
      continue;
    }
    d.rule_id = rule.id;
    d.method = rule.method;
    d.calc.rule = `${rule.staff_id ? staffNames.get(rule.staff_id) ?? 'Personal' : 'Everyone'} · ${rule.target_name ?? (d.category === 'service' ? 'all services' : 'all retail')} · ${ruleLabel(rule)} (from ${rule.from})`;
    if (rule.method === 'percent') {
      d.rate_bps = rule.rate_bps ?? 0;
      d.commission_cents = Math.round((d.eligible_cents * d.rate_bps) / 10000);
      d.calc.steps.push(`${money(d.eligible_cents)} × ${pct(d.rate_bps)} = ${money(d.commission_cents)}.`);
    } else if (rule.method === 'flat') {
      d.flat_cents = rule.flat_cents ?? 0;
      const units = d.eligible_cents > 0 ? d.quantity * d.share : 0;
      d.commission_cents = Math.round(d.flat_cents * units);
      d.calc.steps.push(units ? `${money(d.flat_cents)} × ${+units.toFixed(2)} = ${money(d.commission_cents)}.` : 'Nothing eligible → $0.');
    } else {
      const pk = periodKey(rule.tier_period, d.transaction_date, d.staff_id!, d.category);
      const before = cumulative.get(pk) ?? 0;
      const { commission, parts, topRate } = tieredCommission(rule.tiers ?? [], before, d.eligible_cents);
      cumulative.set(pk, before + d.eligible_cents);
      d.rate_bps = topRate;
      d.commission_cents = commission;
      d.calc.steps.push(`${rule.tier_period === 'week' ? 'Week' : 'Month'}-to-date sales before this: ${money(before)}.`, ...parts, `Commission ${money(commission)}.`);
    }
  }

  // 3. Refunds take back commission at the rate originally used.
  const byLine = new Map<string, { staff_id: string | null; share: number; eligible: number; commission: number; rate_bps: number | null; method: string | null; rule_id: string | null; category: string; item_name: string; appointment_id: string | null; service_id: string | null }[]>();
  const addLine = (k: string, v: any) => byLine.set(k, [...(byLine.get(k) ?? []), v]);
  for (const d of desired) if (d.kind === 'sale' && d.line_key) {
    const ex = existing.get(d.source_key);
    const src = ex?.status === 'finalized' ? { ...d, eligible_cents: ex.eligible_cents, commission_cents: ex.commission_cents, rate_bps: ex.rate_bps, method: ex.method, rule_id: ex.rule_id } : d;
    addLine(d.line_key, { staff_id: src.staff_id, share: src.share, eligible: src.eligible_cents, commission: src.commission_cents, rate_bps: src.rate_bps, method: src.method, rule_id: src.rule_id, category: src.category, item_name: src.item_name, appointment_id: src.appointment_id, service_id: src.service_id });
  }
  const itemizedReturned = new Map<string, number>();
  if (cs.refunds === 'reverse') {
    for (const { raw: o } of orders as { raw: SquareOrder }[]) {
      if (!o.returns?.length) continue;
      const at = new Date(o.closed_at ?? o.created_at ?? now);
      const txDate = localDate(at, tz);
      for (const ret of o.returns) {
        for (const rli of ret.return_line_items ?? []) {
          const src = `${ret.source_order_id}:${rli.source_line_item_uid}`;
          const grossR = cents(rli.gross_return_money);
          const discR = cents(rli.total_discount_money);
          const netR = grossR - discR;
          itemizedReturned.set(ret.source_order_id ?? '', (itemizedReturned.get(ret.source_order_id ?? '') ?? 0) + cents(rli.total_money));
          const originals = (byLine.get(src) ?? []).filter((x) => x.staff_id);
          if (!originals.length) {
            desired.push(refundRow(o, at, txDate, `refund:${o.id}:${rli.uid}:review`, null, rli.name ?? 'Refund', -grossR, -discR, 0, -netR, 0, null,
              ['Refund of a sale the CRM doesn’t have (before the sync start, or not credited to anyone).'], true, 'Refund of a sale that isn’t in the CRM — check whether commission should be taken back.', ret.source_order_id ?? null, base));
            continue;
          }
          const basisR = cs.basis === 'before_discounts' ? grossR : netR;
          for (const og of originals) {
            const eligR = Math.round(basisR * og.share);
            const back = og.eligible > 0 ? -Math.round(og.commission * Math.min(1, eligR / og.eligible)) : 0;
            desired.push(refundRow(o, at, txDate, `refund:${o.id}:${rli.uid}:${og.staff_id}`, og.staff_id, og.item_name, -Math.round(grossR * og.share),
              -Math.round(discR * og.share), -eligR, -Math.round(netR * og.share), back, og,
              [`Refund of ${money(Math.round(netR * og.share))} on ${og.item_name}.`, og.eligible > 0
                ? `Takes back ${money(-back)} — the same share of the ${money(og.commission)} commission paid on the original sale.`
                : 'No commission was paid on the original sale.'], false, null, ret.source_order_id ?? null, base));
          }
        }
      }
    }
    // Amount-only refunds (no items returned): spread over the sale by value, and flagged so someone checks it.
    for (const { raw: o } of orders as { raw: SquareOrder }[]) {
      const refunded = (o.refunds ?? []).filter((r) => r.status === 'COMPLETED' || r.status === 'APPROVED').reduce((a, r) => a + cents(r.amount_money), 0);
      const tip = (o.tenders ?? []).reduce((a, t) => a + cents(t.tip_money), 0);
      const unallocated = refunded - (itemizedReturned.get(o.id) ?? 0);
      if (unallocated <= 0 || !o.line_items?.length) continue;
      const lines = desired.filter((d) => d.kind === 'sale' && d.square_order_id === o.id && d.staff_id);
      const totalNet = lines.reduce((a, d) => a + d.net_sales_cents, 0);
      if (!totalNet) continue;
      const portion = Math.min(1, unallocated / Math.max(1, totalNet + tip));
      const at = new Date(o.updated_at ?? o.closed_at ?? now);
      const txDate = localDate(at, tz);
      for (const d of lines) {
        const back = -Math.round(d.commission_cents * portion);
        desired.push(refundRow(o, at, txDate, `refund:${o.id}:amount:${d.square_line_item_uid}:${d.staff_id}`, d.staff_id, d.item_name,
          -Math.round(d.gross_cents * portion), 0, -Math.round(d.eligible_cents * portion), -Math.round(d.net_sales_cents * portion), back,
          { rate_bps: d.rate_bps, method: d.method, rule_id: d.rule_id, category: d.category, appointment_id: d.appointment_id, service_id: d.service_id } as any,
          [`Square refunded ${money(unallocated)} on this sale without saying which items.`, `Spread by value: ${Math.round(portion * 100)}% of this line → takes back ${money(-back)}.`],
          true, 'Refund without items — check the split.', o.id, base));
      }
    }
  }

  // 4. Accepted reviews; dates that fall in finalized periods move to today.
  for (const d of desired) {
    if (d.needs_review && d.staff_id && accepted.has(d.source_key)) {
      d.needs_review = false;
      d.on_hold = false;
      d.review_reason = null;
      d.calc.steps.push('Reviewed and accepted.');
    }
    const ex = existing.get(d.source_key);
    if (ex && ex.status !== 'void' && ex.posted_date !== d.posted_date && inFinalized(d.posted_date)) d.posted_date = ex.posted_date;
    else if (inFinalized(d.posted_date) && ex?.status !== 'finalized') {
      d.calc.steps.push(`Counted on ${today} because the period for ${d.transaction_date} was already finalized.`);
      d.posted_date = today;
    }
  }

  // 5. Save: insert new, update estimated, void estimated records that no longer apply. Finalized records are untouched.
  let created = 0;
  let updated = 0;
  let voided = 0;
  const seen = new Set<string>();
  for (const d of desired) {
    seen.add(d.source_key);
    const ex = existing.get(d.source_key);
    if (ex?.status === 'finalized') continue;
    if (!ex) {
      const row = await db().one<{ id: string }>(
        `INSERT INTO commission_entries(source_key, staff_id, kind, category, square_order_id, square_line_item_uid, square_payment_ids, source_order_id,
            appointment_id, service_id, catalog_object_id, item_name, quantity, share, transaction_at, transaction_date, service_date, posted_date,
            gross_cents, discount_cents, eligible_cents, net_sales_cents, tip_cents, rule_id, method, rate_bps, flat_cents, commission_cents, calc,
            attribution, needs_review, review_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::date,$17::date,$18::date,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29::jsonb,$30,$31,$32)
         RETURNING id`,
        [d.source_key, d.staff_id, d.kind, d.category, d.square_order_id, d.square_line_item_uid, d.square_payment_ids, d.source_order_id,
          d.appointment_id, d.service_id, d.catalog_object_id, d.item_name, d.quantity, d.share, d.transaction_at, d.transaction_date, d.service_date,
          d.posted_date, d.gross_cents, d.discount_cents, d.eligible_cents, d.net_sales_cents, d.tip_cents, d.rule_id, d.method, d.rate_bps, d.flat_cents,
          d.commission_cents, JSON.stringify(d.calc), d.attribution, d.needs_review, d.review_reason],
      );
      await event(row!.id, 'created', null, { commissionCents: d.commission_cents, tipCents: d.tip_cents, staffId: d.staff_id });
      created++;
      continue;
    }
    const changed = ex.status === 'void' || ex.staff_id !== d.staff_id || ex.commission_cents !== d.commission_cents || ex.eligible_cents !== d.eligible_cents
      || ex.rate_bps !== d.rate_bps || ex.rule_id !== d.rule_id || ex.needs_review !== d.needs_review || ex.posted_date !== d.posted_date
      || ex.tip_cents !== d.tip_cents || JSON.stringify(ex.calc) !== JSON.stringify(d.calc);
    if (!changed) continue;
    await db().query(
      `UPDATE commission_entries SET status = 'estimated', staff_id = $2, appointment_id = $3, service_id = $4, item_name = $5, quantity = $6, share = $7,
         transaction_at = $8, transaction_date = $9::date, service_date = $10::date, posted_date = $11::date, gross_cents = $12, discount_cents = $13,
         eligible_cents = $14, net_sales_cents = $15, tip_cents = $16, rule_id = $17, method = $18, rate_bps = $19, flat_cents = $20,
         commission_cents = $21, calc = $22::jsonb, attribution = $23, needs_review = $24, review_reason = $25, square_payment_ids = $26, updated_at = now()
       WHERE id = $1`,
      [ex.id, d.staff_id, d.appointment_id, d.service_id, d.item_name, d.quantity, d.share, d.transaction_at, d.transaction_date, d.service_date,
        d.posted_date, d.gross_cents, d.discount_cents, d.eligible_cents, d.net_sales_cents, d.tip_cents, d.rule_id, d.method, d.rate_bps, d.flat_cents,
        d.commission_cents, JSON.stringify(d.calc), d.attribution, d.needs_review, d.review_reason, d.square_payment_ids],
    );
    if (ex.commission_cents !== d.commission_cents || ex.staff_id !== d.staff_id || ex.status === 'void' || ex.tip_cents !== d.tip_cents) {
      await event(ex.id, 'recalculated', null, { from: ex.commission_cents, to: d.commission_cents, staffFrom: ex.staff_id, staffTo: d.staff_id });
    }
    updated++;
  }
  for (const [key, ex] of existing) {
    if (seen.has(key) || ex.status !== 'estimated') continue;
    await db().query("UPDATE commission_entries SET status = 'void', needs_review = false, updated_at = now() WHERE id = $1", [ex.id]);
    await event(ex.id, 'voided', null, { reason: 'No longer in Square, or credited differently.' });
    voided++;
  }
  // On hold: credited but not counted in pay until confirmed (set in one go for everything just written).
  await db().query(
    `UPDATE commission_entries SET on_hold = (source_key = ANY($1::text[])), updated_at = now()
      WHERE status = 'estimated' AND source_key = ANY($2::text[]) AND on_hold <> (source_key = ANY($1::text[]))`,
    [desired.filter((d) => d.on_hold).map((d) => d.source_key), desired.map((d) => d.source_key)]);
  const review = await db().one<{ n: number }>("SELECT count(*)::int AS n FROM commission_entries WHERE needs_review AND status = 'estimated'");
  return { created, updated, voided, needsReview: review?.n ?? 0 };
}

function refundRow(o: SquareOrder, at: Date, txDate: string, key: string, staff: string | null, name: string, gross: number, disc: number, elig: number,
  net: number, commission: number, og: { rate_bps: number | null; method: string | null; rule_id: string | null; category: string; appointment_id: string | null; service_id: string | null } | null,
  steps: string[], review: boolean, reason: string | null, sourceOrder: string | null, base: (o: any, d: string, at: Date) => any): Desired {
  // Commission never goes negative on its own: a refund that takes commission back is held until an admin accepts it.
  const holds = !!staff && commission < 0;
  if (holds) steps.push('On hold: refunds don’t come off commission until accepted in Needs review.');
  return {
    ...base(o, txDate, at), source_key: key, staff_id: staff, kind: 'refund', category: (og?.category as any) ?? 'other', square_line_item_uid: null,
    source_order_id: sourceOrder, appointment_id: og?.appointment_id ?? null, service_id: og?.service_id ?? null, catalog_object_id: null,
    item_name: `Refund: ${name}`, quantity: 1, share: 1, service_date: null, gross_cents: gross, discount_cents: disc, eligible_cents: elig,
    net_sales_cents: net, tip_cents: 0, rule_id: og?.rule_id ?? null, method: og?.method ?? null, rate_bps: og?.rate_bps ?? null, flat_cents: null,
    commission_cents: commission, calc: { steps }, attribution: null, needs_review: review || !staff || holds,
    review_reason: reason ?? (!staff ? 'Needs a team member.' : holds ? 'Refund — on hold so commission doesn’t go negative. Accept it to take it off their commission.' : null),
    line_key: null, on_hold: holds,
  };
}

function periodKey(period: string, date: string, staff: string, category: string) {
  if (period === 'week') {
    const d = new Date(`${date}T00:00:00Z`);
    const monday = addDaysToDate(date, -((d.getUTCDay() + 6) % 7));
    return `${staff}|${category}|w${monday}`;
  }
  return `${staff}|${category}|m${date.slice(0, 7)}`;
}

/** Marginal tiers: each part of the sale earns the rate of the tier it falls in, based on sales so far this period. */
export function tieredCommission(tiers: CommissionTier[], before: number, amount: number) {
  let remaining = amount;
  let cursor = before;
  let commission = 0;
  let topRate = tiers[0]?.rateBps ?? 0;
  const parts: string[] = [];
  let lower = 0;
  for (const t of tiers) {
    const upper = t.upToCents ?? Infinity;
    if (remaining <= 0) break;
    if (cursor < upper) {
      const take = Math.min(remaining, upper - Math.max(cursor, lower));
      if (take > 0) {
        const c = (take * t.rateBps) / 10000;
        commission += c;
        topRate = t.rateBps;
        parts.push(`${money(take)} at ${pct(t.rateBps)} (${t.upToCents == null ? `above ${money(lower)}` : `${money(lower)}–${money(upper)} tier`}) = ${money(Math.round(c))}.`);
        remaining -= take;
        cursor += take;
      }
    }
    lower = upper;
  }
  return { commission: Math.round(commission), parts, topRate };
}

/** Most specific rule wins: this person + this item → this person + all → everyone + this item → everyone + all. */
export function pickRule(rules: Rule[], staffId: string, category: 'service' | 'retail', serviceId: string | null, variationId: string | null, date: string) {
  const live = rules.filter((r) => r.category === category && r.from <= date && (!r.to || r.to >= date));
  const item = (r: Rule) => (category === 'service' ? r.target_type === 'service' && r.target_id === serviceId : r.target_type === 'product' && r.target_id === variationId);
  return live.find((r) => r.staff_id === staffId && item(r))
    ?? live.find((r) => r.staff_id === staffId && r.target_type === 'all')
    ?? live.find((r) => r.staff_id === null && item(r))
    ?? live.find((r) => r.staff_id === null && r.target_type === 'all')
    ?? null;
}

async function event(entryId: string, action: string, staffId: string | null, detail: Record<string, unknown>) {
  await db().query('INSERT INTO commission_entry_events(entry_id, action, staff_id, detail) VALUES ($1,$2,$3,$4::jsonb)', [entryId, action, staffId, JSON.stringify(detail)]);
}

// ---------- Reports ----------
const ENTRY_SELECT = `
  SELECT e.*, s.name AS staff_name, to_char(e.transaction_date, 'YYYY-MM-DD') AS tx_date, to_char(e.service_date, 'YYYY-MM-DD') AS svc_date,
         to_char(e.posted_date, 'YYYY-MM-DD') AS post_date
    FROM commission_entries e LEFT JOIN staff s ON s.id = e.staff_id`;

export function toEntryDTO(r: any): CommissionEntryDTO {
  return {
    id: r.id, staffId: r.staff_id, staffName: r.staff_name ?? null, kind: r.kind, category: r.category, status: r.status,
    squareOrderId: r.square_order_id, squareLineItemUid: r.square_line_item_uid, squarePaymentIds: r.square_payment_ids ?? [],
    sourceOrderId: r.source_order_id, appointmentId: r.appointment_id, itemName: r.item_name, quantity: Number(r.quantity), share: Number(r.share),
    transactionAt: iso(r.transaction_at)!, transactionDate: r.tx_date, serviceDate: r.svc_date, postedDate: r.post_date,
    grossCents: r.gross_cents, discountCents: r.discount_cents, eligibleCents: r.eligible_cents, netSalesCents: r.net_sales_cents,
    tipCents: r.tip_cents, method: r.method, rateBps: r.rate_bps, flatCents: r.flat_cents, commissionCents: r.commission_cents,
    calc: typeof r.calc === 'string' ? JSON.parse(r.calc) : r.calc ?? { steps: [] }, attribution: r.attribution,
    needsReview: r.needs_review, reviewReason: r.review_reason, onHold: !!r.on_hold, note: r.note, finalizedAt: iso(r.finalized_at),
  };
}

export async function listEntries(f: { staffId: string | null | 'all'; from: string; to: string; reviewOnly?: boolean }) {
  const p: unknown[] = [f.from, f.to];
  const where = ["e.status <> 'void'", 'e.posted_date BETWEEN $1::date AND $2::date'];
  if (f.staffId !== 'all') {
    p.push(f.staffId);
    where.push(`e.staff_id = $${p.length}`);
  }
  if (f.reviewOnly) where.push("e.needs_review AND e.status = 'estimated'");
  const rows = await db().query(`${ENTRY_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.transaction_at DESC, e.square_order_id, e.kind, e.item_name LIMIT 5000`, p);
  return rows.map(toEntryDTO);
}

/** Needs review looks back one month (sale date) unless other dates are chosen. */
export async function reviewRange(range?: { from?: string | null; to?: string | null }) {
  const today = localDate(new Date(), (await getSettings()).business.timezone);
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return { from: range?.from || d.toISOString().slice(0, 10), to: range?.to || today };
}

export async function reviewQueue(range?: { from?: string | null; to?: string | null }) {
  const r = await reviewRange(range);
  const rows = await db().query(
    `${ENTRY_SELECT} WHERE e.needs_review AND e.status = 'estimated' AND e.transaction_date BETWEEN $1::date AND $2::date ORDER BY e.transaction_at DESC LIMIT 500`,
    [r.from, r.to]);
  return rows.map(toEntryDTO);
}

export function summarize(entries: CommissionEntryDTO[], from: string, to: string, staffId: string | null): CommissionSummaryDTO {
  const sum = (pred: (e: CommissionEntryDTO) => boolean, f: (e: CommissionEntryDTO) => number) => entries.filter(pred).reduce((a, e) => a + f(e), 0);
  // Unassigned records don't count for anyone yet, nor do ones on hold (until confirmed in Needs review).
  const counted = (e: CommissionEntryDTO) => !!e.staffId && !e.onHold;
  return {
    from, to, staffId,
    // Never below zero: what's owed can't be negative (refunds are held until accepted; anything left over waits).
    totalCommissionCents: Math.max(0, sum(counted, (e) => e.commissionCents)),
    serviceCommissionCents: sum((e) => counted(e) && e.kind === 'sale' && e.category === 'service', (e) => e.commissionCents),
    retailCommissionCents: sum((e) => counted(e) && e.kind === 'sale' && e.category === 'retail', (e) => e.commissionCents),
    refundsCents: sum((e) => counted(e) && e.kind === 'refund', (e) => e.commissionCents),
    serviceRefundsCents: sum((e) => counted(e) && e.kind === 'refund' && e.category === 'service', (e) => e.commissionCents),
    retailRefundsCents: sum((e) => counted(e) && e.kind === 'refund' && e.category === 'retail', (e) => e.commissionCents),
    adjustmentsCents: sum((e) => counted(e) && e.kind === 'adjustment', (e) => e.commissionCents),
    tipsCents: sum((e) => counted(e) && e.kind === 'tip', (e) => e.tipCents),
    estimatedCents: sum((e) => counted(e) && e.status === 'estimated', (e) => e.commissionCents),
    finalizedCents: sum((e) => counted(e) && e.status === 'finalized', (e) => e.commissionCents),
    totalSalesCents: sum((e) => counted(e) && (e.kind === 'sale' || e.kind === 'refund'), (e) => e.netSalesCents),
    serviceSalesCents: sum((e) => counted(e) && (e.kind === 'sale' || e.kind === 'refund') && e.category === 'service', (e) => e.netSalesCents),
    retailSalesCents: sum((e) => counted(e) && (e.kind === 'sale' || e.kind === 'refund') && e.category === 'retail', (e) => e.netSalesCents),
    entries: entries.length,
    needsReview: entries.filter((e) => e.needsReview && e.status === 'estimated').length,
  };
}

export async function entryHistory(entryId: string) {
  return (await db().query<any>(
    `SELECT ev.action, ev.detail, ev.created_at, s.name AS by FROM commission_entry_events ev LEFT JOIN staff s ON s.id = ev.staff_id
      WHERE ev.entry_id = $1 ORDER BY ev.created_at`, [entryId])).map((r) => ({ action: r.action, detail: r.detail, at: iso(r.created_at), by: r.by }));
}

// ---------- Review, adjustments, finalizing ----------
export async function attributeEntry(entryId: string, staffIds: string[], note: string | null, actor: string) {
  await creditLine(entryId, staffIds, note, actor, true);
  await rebuildCommission();
}

/** Credits several records to the same people (or no commission) with one rebuild. Records that can't be re-credited are skipped. */
export async function attributeEntries(entryIds: string[], staffIds: string[], note: string | null, actor: string) {
  for (const s of staffIds) if (!(await db().one('SELECT 1 FROM staff WHERE id = $1', [s]))) throw badRequest('That team member could not be found.');
  let n = 0;
  for (const id of entryIds) if (await creditLine(id, staffIds, note, actor, false)) n++;
  if (n) await rebuildCommission();
  return n;
}

async function creditLine(entryId: string, staffIds: string[], note: string | null, actor: string, strict: boolean) {
  const e = await db().one<any>("SELECT * FROM commission_entries WHERE id = $1 AND status = 'estimated'", [entryId]);
  if (!e) { if (strict) throw notFound('That commission record'); return false; }
  if (strict) for (const s of staffIds) if (!(await db().one('SELECT 1 FROM staff WHERE id = $1', [s]))) throw badRequest('That team member could not be found.');
  const lineKey = e.kind === 'tip' ? `${e.square_order_id}:tip` : e.square_line_item_uid ? `${e.square_order_id}:${e.square_line_item_uid}` : null;
  if (!lineKey || e.kind === 'refund') { if (strict) throw badRequest('This record can’t be re-credited; accept it or add an adjustment instead.'); return false; }
  await db().query(
    `INSERT INTO commission_attributions(line_key, staff_ids, note, set_by_staff_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (line_key) DO UPDATE SET staff_ids = EXCLUDED.staff_ids, note = EXCLUDED.note, set_by_staff_id = EXCLUDED.set_by_staff_id, set_at = now()`,
    [lineKey, staffIds, note, actor]);
  await event(entryId, 'attributed', actor, { staffIds, note });
  return true;
}

export async function acceptEntry(entryId: string, note: string | null, actor: string) {
  const e = await db().one<any>("SELECT id, source_key, staff_id FROM commission_entries WHERE id = $1 AND status = 'estimated'", [entryId]);
  if (!e) throw notFound('That commission record');
  if (!e.staff_id) throw badRequest('Choose who gets credit first.');
  await db().query('INSERT INTO commission_review_accepted(source_key, note, accepted_by_staff_id) VALUES ($1,$2,$3) ON CONFLICT (source_key) DO NOTHING', [e.source_key, note, actor]);
  await db().query('UPDATE commission_entries SET needs_review = false, on_hold = false, updated_at = now() WHERE id = $1', [entryId]);
  await event(entryId, 'accepted', actor, { note });
}

export async function addAdjustment(a: { staffId: string; amountCents: number; date: string; note: string }, actor: string) {
  if (!(await db().one('SELECT 1 FROM staff WHERE id = $1', [a.staffId]))) throw badRequest('That team member could not be found.');
  const tz = (await getSettings()).business.timezone;
  const periods = await db().query<any>("SELECT to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS e FROM commission_periods");
  if (periods.some((p) => a.date >= p.s && a.date <= p.e)) throw badRequest('That date is in a finalized period. Use a date in an open period.');
  const id = (await db().one<{ id: string }>(
    `INSERT INTO commission_entries(source_key, staff_id, kind, category, item_name, transaction_at, transaction_date, posted_date, commission_cents, calc,
        attribution, note, created_by_staff_id)
     VALUES ('adj:' || gen_random_uuid(), $1, 'adjustment', 'other', $2, now(), $3::date, $3::date, $4, $5::jsonb, 'manual', $6, $7) RETURNING id`,
    [a.staffId, `Adjustment: ${a.note}`.slice(0, 200), a.date, a.amountCents, JSON.stringify({ steps: [`Manual adjustment of ${money(a.amountCents)} by an administrator.`] }), a.note, actor],
  ))!.id;
  await event(id, 'created', actor, { amountCents: a.amountCents, note: a.note });
  void tz;
  return id;
}

export async function listPeriods() {
  return (await db().query<any>(
    `SELECT p.*, to_char(p.start_date, 'YYYY-MM-DD') AS s, to_char(p.end_date, 'YYYY-MM-DD') AS e, st.name AS by_name
       FROM commission_periods p LEFT JOIN staff st ON st.id = p.finalized_by_staff_id ORDER BY p.start_date DESC`)).map((p) => ({
    id: p.id, startDate: p.s, endDate: p.e, finalizedAt: iso(p.finalized_at)!, finalizedByName: p.by_name, note: p.note, totals: p.totals,
  }));
}

export async function finalizePeriod(f: { startDate: string; endDate: string; note: string | null; force: boolean }, actor: string) {
  if (f.endDate < f.startDate) throw badRequest('The end date is before the start date.');
  const today = localDate(new Date(), (await getSettings()).business.timezone);
  if (f.endDate >= today) throw badRequest('Only past days can be finalized (sales may still come in today).');
  const overlap = await db().one('SELECT 1 FROM commission_periods WHERE start_date <= $2::date AND end_date >= $1::date', [f.startDate, f.endDate]);
  if (overlap) throw badRequest('Part of these dates is already finalized.');
  const review = await db().one<{ n: number }>(
    "SELECT count(*)::int AS n FROM commission_entries WHERE needs_review AND status = 'estimated' AND posted_date BETWEEN $1::date AND $2::date",
    [f.startDate, f.endDate]);
  if (review!.n && !f.force) throw badRequest(`${review!.n} record${review!.n === 1 ? '' : 's'} in these dates still need review. Resolve them first.`, { needsReview: review!.n });
  const entries = await listEntries({ staffId: 'all', from: f.startDate, to: f.endDate });
  const totals: Record<string, { name: string; commissionCents: number; tipsCents: number; salesCents: number }> = {};
  for (const e of entries.filter((x) => x.staffId && x.status === 'estimated')) {
    const t = (totals[e.staffId!] ??= { name: e.staffName ?? '', commissionCents: 0, tipsCents: 0, salesCents: 0 });
    t.commissionCents += e.commissionCents;
    t.tipsCents += e.tipCents;
    if (e.kind === 'sale' || e.kind === 'refund') t.salesCents += e.netSalesCents;
  }
  return db().tx(async (q) => {
    const p = (await q.query<{ id: string }>(
      'INSERT INTO commission_periods(start_date, end_date, finalized_by_staff_id, note, totals) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id',
      [f.startDate, f.endDate, actor, f.note, JSON.stringify(totals)]))[0];
    const ids = await q.query<{ id: string }>(
      `UPDATE commission_entries SET status = 'finalized', period_id = $3, finalized_at = now(), finalized_by_staff_id = $4, updated_at = now()
        WHERE status = 'estimated' AND staff_id IS NOT NULL AND posted_date BETWEEN $1::date AND $2::date RETURNING id`,
      [f.startDate, f.endDate, p.id, actor]);
    for (const r of ids) await q.query("INSERT INTO commission_entry_events(entry_id, action, staff_id, detail) VALUES ($1,'finalized',$2,$3::jsonb)", [r.id, actor, JSON.stringify({ periodId: p.id })]);
    return { periodId: p.id, finalized: ids.length };
  });
}

/** CSV for payroll: one row per record, with the rate and calculation used. */
export function entriesCsv(entries: CommissionEntryDTO[]) {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const d = (c: number) => (c / 100).toFixed(2);
  const head = ['Stylist', 'Counted on', 'Transaction date', 'Service date', 'Type', 'Category', 'Item', 'Qty', 'Share', 'Gross', 'Discount', 'Eligible',
    'Method', 'Rate %', 'Flat per item', 'Commission', 'Tip', 'Status', 'Finalized at', 'Needs review', 'Square order', 'Square line item', 'Square payments', 'How it was calculated'];
  const rows = entries.map((e) => [e.staffName ?? 'Unassigned', e.postedDate, e.transactionDate, e.serviceDate ?? '', e.kind, e.category, e.itemName, e.quantity,
    e.share, d(e.grossCents), d(e.discountCents), d(e.eligibleCents), e.method ?? '', e.rateBps != null ? (e.rateBps / 100).toFixed(2) : '',
    e.flatCents != null ? d(e.flatCents) : '', d(e.commissionCents), d(e.tipCents), e.status, e.finalizedAt ?? '', e.needsReview ? 'yes' : '',
    e.squareOrderId ?? '', e.squareLineItemUid ?? '', e.squarePaymentIds.join(' '), [e.calc.rule, ...e.calc.steps].filter(Boolean).join(' ')].map(esc).join(','));
  return [head.map(esc).join(','), ...rows].join('\n');
}
