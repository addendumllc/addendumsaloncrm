import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { pickRule, rebuildCommission, syncCommission, tieredCommission } from '../src/domain/commission.js';
import { localDate } from '../src/domain/rebookingSchedule.js';
import { setIntegrationOverride } from '../src/integrations/registry.js';
import { demoExtraOrders, demoPaymentTeam, MockSquareService } from '../src/integrations/square/MockSquareService.js';
import { payPeriodFor } from '@addendum/shared';
import { setup } from './helpers.js';

let app: Awaited<ReturnType<typeof setup>>['app'];
let admin: Awaited<ReturnType<typeof setup>>['api'];
let jenId: string;
let michaelId: string;
let lisaId: string;
const TZ = 'America/Los_Angeles';
const today = () => localDate(new Date(), TZ);
const daysAgo = (n: number) => localDate(new Date(Date.now() - n * 86400_000), TZ);
const RANGE = () => `from=${daysAgo(200)}&to=${today()}`;

/** Signs in and (unless `locked`) confirms the password, which pay pages need. */
async function signIn(email: string, locked = false) {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email, password: 'addendum-demo' })).status).toBe(200);
  if (!locked) expect((await agent.post('/api/auth/confirm-password').set('X-Requested-With', 'addendum-crm').send({ password: 'addendum-demo' })).status).toBe(200);
  return {
    get: (url: string) => agent.get(url),
    post: (url: string, body: object = {}) => agent.post(url).set('X-Requested-With', 'addendum-crm').send(body),
  };
}
const entries = (where = 'true', p: unknown[] = []) => db().query<any>(`SELECT * FROM commission_entries WHERE status <> 'void' AND ${where}`, p);
const sync = async () => {
  const id = await syncCommission({ trigger: 'manual' });
  return db().one<any>('SELECT * FROM commission_sync_runs WHERE id = $1', [id]);
};

beforeAll(async () => {
  ({ app, api: admin } = await setup());
  // Pay pages need a recent password confirmation (as in the app).
  expect((await admin.post('/api/auth/confirm-password', { password: 'addendum-demo' })).status).toBe(200);
  const id = async (email: string) => (await db().one<any>('SELECT id FROM staff WHERE email = $1', [email])).id;
  jenId = await id('jennifer@addendumsalon.com');
  michaelId = await id('michael@addendumsalon.com');
  lisaId = await id('owner@addendumsalon.com');
});

describe('Calculation rules', () => {
  it('tiers are marginal within the period', () => {
    const tiers = [{ upToCents: 100000, rateBps: 4000 }, { upToCents: null, rateBps: 5000 }];
    expect(tieredCommission(tiers, 0, 50000).commission).toBe(20000);
    expect(tieredCommission(tiers, 80000, 50000).commission).toBe(8000 + 15000); // $200 at 40% + $300 at 50%
    expect(tieredCommission(tiers, 200000, 10000).commission).toBe(5000);
  });

  it('the most specific rule wins, within its effective dates', () => {
    const r = (o: any) => ({ id: o.id, staff_id: null, category: 'service', target_type: 'all', target_id: null, target_name: null, method: 'percent', rate_bps: 4000, flat_cents: null, tiers: null, tier_period: 'month', from: '2026-01-01', to: null, ...o });
    const rules = [r({ id: 'everyone' }), r({ id: 'everyone-cut', target_type: 'service', target_id: 'cut' }), r({ id: 'jen', staff_id: 'jen' }),
      r({ id: 'jen-cut', staff_id: 'jen', target_type: 'service', target_id: 'cut', from: '2026-06-01' })];
    expect(pickRule(rules, 'jen', 'service', 'cut', null, '2026-07-01')?.id).toBe('jen-cut');
    expect(pickRule(rules, 'jen', 'service', 'cut', null, '2026-05-01')?.id).toBe('jen');
    expect(pickRule(rules, 'bob', 'service', 'cut', null, '2026-07-01')?.id).toBe('everyone-cut');
    expect(pickRule(rules, 'bob', 'service', 'color', null, '2026-07-01')?.id).toBe('everyone');
    expect(pickRule(rules, 'bob', 'retail', null, 'x', '2026-07-01')).toBeNull();
  });
});

describe('Square sales → commission', () => {
  it('builds commission from Square orders, matched to stylists through their bookings', async () => {
    const st = (await admin.get('/api/commission/status')).body.status;
    expect(st.lastSuccessfulSyncAt).toBeTruthy();
    const michael = await entries("staff_id = $1 AND kind = 'sale' AND category = 'service'", [michaelId]);
    expect(michael.length).toBeGreaterThan(3);
    for (const e of michael) {
      expect(e.attribution).toMatch(/booking/);
      expect(e.square_order_id).toBeTruthy();
      expect(e.square_line_item_uid).toBeTruthy();
      expect(e.rate_bps).toBe(4000);
      expect(e.commission_cents).toBe(Math.round(e.eligible_cents * 0.4));
    }
  });

  it('syncing again never duplicates anything', async () => {
    const before = (await db().one<any>('SELECT count(*)::int AS n, sum(commission_cents)::int AS c FROM commission_entries')).n;
    const run = await sync();
    expect(run.status).toBe('ok');
    expect(run.created).toBe(0);
    expect((await db().one<any>('SELECT count(*)::int AS n FROM commission_entries')).n).toBe(before);
  });

  it('applies discounts per the salon rule, and package redemptions earn nothing by default', async () => {
    const discounted = (await entries("kind = 'sale' AND discount_cents > 0 AND eligible_cents > 0 AND staff_id IS NOT NULL"))[0];
    expect(discounted.eligible_cents).toBe(discounted.gross_cents - discounted.discount_cents);
    const pkg = (await entries("item_name LIKE '%(package)%'"))[0];
    expect(pkg.gross_cents).toBeGreaterThan(0);
    expect(pkg.eligible_cents).toBe(0);
    expect(pkg.commission_cents).toBe(0);
    expect(JSON.stringify(pkg.calc)).toMatch(/package/);

    await admin.put('/api/commission/settings', { basis: 'before_discounts', zeroPriced: 'regular_price' });
    const after = await db().one<any>('SELECT * FROM commission_entries WHERE id = $1', [discounted.id]);
    expect(after.eligible_cents).toBe(discounted.gross_cents);
    expect((await db().one<any>('SELECT eligible_cents FROM commission_entries WHERE id = $1', [pkg.id])).eligible_cents).toBe(pkg.gross_cents);
    await admin.put('/api/commission/settings', { basis: 'after_discounts', zeroPriced: 'no_commission' });
  });

  it('anything from the Square catalog that isn’t a service counts as a product, even if the CRM’s copy hasn’t caught up', async () => {
    const saved = await db().query<any>('SELECT * FROM square_inventory');
    await db().query('DELETE FROM square_inventory');
    try {
      await rebuildCommission();
      const unknown = await entries("kind = 'sale' AND category = 'other' AND catalog_object_id IS NOT NULL");
      expect(unknown).toEqual([]);
      expect((await entries("kind = 'sale' AND category = 'retail' AND catalog_object_id IS NOT NULL")).length).toBeGreaterThan(0);
    } finally {
      for (const r of saved) await db().query(`INSERT INTO square_inventory SELECT * FROM json_populate_record(NULL::square_inventory, $1::json)`, [JSON.stringify(r)]);
      await rebuildCommission();
    }
  });

  it('keeps tips separate from commission', async () => {
    const tips = await entries("kind = 'tip' AND staff_id IS NOT NULL");
    expect(tips.length).toBeGreaterThan(0);
    expect(tips.every((t) => t.commission_cents === 0 && t.tip_cents > 0)).toBe(true);
    const me = (await admin.get(`/api/commission/staff/${michaelId}?${RANGE()}`)).body.summary;
    expect(me.tipsCents).toBeGreaterThan(0);
    expect(me.totalCommissionCents).toBe(me.serviceCommissionCents + me.retailCommissionCents + me.refundsCents + me.adjustmentsCents);
  });

  it('takes back commission on refunds at the original rate', async () => {
    const refund = (await entries("kind = 'refund' AND staff_id = $1", [lisaId]))[0];
    const original = (await entries("kind = 'sale' AND square_order_id = 'demo-ord-walkin' AND square_line_item_uid = 'walkin-1'"))[0];
    expect(refund.source_order_id).toBe('demo-ord-walkin');
    expect(refund.commission_cents).toBe(-Math.round(original.commission_cents / 2)); // 1 of 2 returned
    expect(refund.net_sales_cents).toBe(-6500);
    // Held until accepted: it doesn't come off commission on its own.
    expect(refund).toMatchObject({ on_hold: true, needs_review: true });
    expect(refund.review_reason).toMatch(/on hold/);
    const s = (await admin.get(`/api/commission/staff/${lisaId}?${RANGE()}`)).body.summary;
    expect(s.refundsCents).toBe(0);
    expect(s.totalCommissionCents).toBeGreaterThanOrEqual(0);
  });

  it('sends what Square can’t attribute to review instead of guessing, and a person can credit it', async () => {
    const review = (await admin.get('/api/commission/review')).body.entries;
    const custom = review.find((e: any) => e.itemName === 'Custom amount');
    expect(custom.staffId).toBeNull();
    expect(custom.reviewReason).toMatch(/Custom amount/);
    const r = await admin.post(`/api/commission/entries/${custom.id}/attribute`, { staffIds: [michaelId], note: 'Michael sold a clip-in' });
    expect(r.status).toBe(200);
    expect(r.body.entries.some((e: any) => e.id === custom.id)).toBe(false);
    const credited = (await entries("square_line_item_uid = 'walkin-2'"))[0];
    expect(credited.staff_id).toBe(michaelId);
    expect(credited.attribution).toBe('manual');
    expect(credited.category).toBe('retail'); // custom amounts credited by hand follow the retail rules
    expect(credited.commission_cents).toBe(Math.round(credited.eligible_cents * 0.1));
    expect(credited.needs_review).toBe(false);
  });

  it('says exactly what’s missing when Square isn’t connected', async () => {
    setIntegrationOverride({ square: null });
    const run = await sync();
    expect(run.status).toBe('failed');
    expect(run.message).toMatch(/Square isn’t connected/);
    setIntegrationOverride({ square: new MockSquareService() });
  });
});

describe('Rate changes, finalizing and history', () => {
  it('a new rate applies from its date and never rewrites finalized commission', async () => {
    // Finalize everything up to 30 days ago.
    const end = daysAgo(30);
    const before = await entries("staff_id = $1 AND kind = 'sale' AND category = 'service' AND posted_date <= $2::date", [michaelId, end]);
    expect(before.length).toBeGreaterThan(0);
    const refused = await admin.post('/api/commission/periods/finalize', { startDate: daysAgo(200), endDate: end });
    expect(refused.status).toBe(400); // must be confirmed
    const fin = await admin.post('/api/commission/periods/finalize', { startDate: daysAgo(200), endDate: end, confirm: true, force: true });
    expect(fin.status).toBe(200);
    expect(fin.body.finalized).toBeGreaterThan(0);

    // Raise everyone's service rate to 50% from 200 days ago — only open records follow it.
    const r = await admin.post('/api/commission/rules', { category: 'service', method: 'percent', rateBps: 5000, effectiveFrom: daysAgo(200) });
    expect(r.status).toBe(201);
    const finalized = await db().query<any>('SELECT * FROM commission_entries WHERE id = ANY($1::uuid[])', [before.map((b) => b.id)]);
    const was = new Map(before.map((b) => [b.id, b]));
    for (const e of finalized) {
      expect(e.status).toBe('finalized');
      expect(e.rate_bps).toBe(was.get(e.id).rate_bps);
      expect(e.commission_cents).toBe(was.get(e.id).commission_cents);
    }
    const open = await entries("staff_id = $1 AND kind = 'sale' AND category = 'service' AND status = 'estimated' AND eligible_cents > 0", [michaelId]);
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((e) => e.rate_bps === 5000)).toBe(true);
    // The old everyone-40% rule was ended the day before, and is kept for history.
    const rules = (await admin.get('/api/commission/rules')).body.rules;
    expect(rules.some((x: any) => x.rateBps === 4000 && x.category === 'service' && !x.staffId && x.targetType === 'all' && x.effectiveTo)).toBe(true);
  });

  it('a refund on a finalized sale is counted today, not in the closed period', async () => {
    const sale = (await entries("status = 'finalized' AND kind = 'sale' AND staff_id = $1 AND eligible_cents > 0", [michaelId]))[0];
    const now = new Date().toISOString();
    demoExtraOrders.push({
      id: 'demo-ord-late-refund', location_id: 'x', state: 'COMPLETED', created_at: now, updated_at: now, closed_at: now,
      returns: [{ uid: 'late', source_order_id: sale.square_order_id, return_line_items: [{ uid: 'late-1', source_line_item_uid: sale.square_line_item_uid, quantity: '1',
        name: sale.item_name, gross_return_money: { amount: sale.gross_cents }, total_discount_money: { amount: sale.discount_cents }, total_money: { amount: sale.gross_cents - sale.discount_cents } }] }],
    });
    await sync();
    const refund = (await entries("square_order_id = 'demo-ord-late-refund'"))[0];
    expect(refund.status).toBe('estimated');
    expect(localDate(refund.posted_date, 'UTC')).toBe(today());
    expect(refund.commission_cents).toBe(-sale.commission_cents);
    expect(refund.rate_bps).toBe(sale.rate_bps);
    demoExtraOrders.length = 0;
  });

  it('a product-only ticket goes to whoever checked out, on hold (not in pay) until confirmed', async () => {
    const tm = (await db().one<any>('SELECT square_team_member_id FROM staff WHERE id = $1', [jenId])).square_team_member_id;
    const now = new Date().toISOString();
    demoExtraOrders.push({
      id: 'demo-ord-retail-only', location_id: 'x', state: 'COMPLETED', created_at: now, updated_at: now, closed_at: now,
      line_items: [{ uid: 'ro-1', name: 'Extension Care Kit', quantity: '1', catalog_object_id: 'demo-v6', item_type: 'ITEM',
        gross_sales_money: { amount: 6500 }, total_discount_money: { amount: 0 }, total_money: { amount: 6500 } }],
      tenders: [{ id: 't-ro', payment_id: 'pay-retail-only', amount_money: { amount: 6500 } }],
    } as any);
    demoPaymentTeam.set('pay-retail-only', tm);
    await sync();
    const e = (await entries("square_order_id = 'demo-ord-retail-only'"))[0];
    expect(e).toMatchObject({ staff_id: jenId, on_hold: true, needs_review: true, attribution: 'payment' });
    expect(e.review_reason).toMatch(/Product-only sale/);
    // Not in her pay while on hold.
    const before = (await admin.get(`/api/commission/staff/${jenId}?${RANGE()}`)).body.summary.retailCommissionCents;
    expect((await admin.post(`/api/commission/entries/${e.id}/accept`, {})).status).toBe(200);
    const after = (await admin.get(`/api/commission/staff/${jenId}?${RANGE()}`)).body.summary.retailCommissionCents;
    expect(after - before).toBe(e.commission_cents);
    expect((await entries("square_order_id = 'demo-ord-retail-only'"))[0].on_hold).toBe(false);
    demoExtraOrders.length = 0;
  });

  it('when Square didn’t record who checked out: the front desk on the clock gets it (on hold); suggestions and bulk credit', async () => {
    const desk = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
    const saved = await db().query<any>('SELECT * FROM time_clock_shifts');
    await db().query('DELETE FROM time_clock_shifts');
    const ticket = (id: string, at: string) => ({
      id, location_id: 'x', state: 'COMPLETED', created_at: at, updated_at: new Date().toISOString(), closed_at: at,
      line_items: [{ uid: `${id}-1`, name: 'Extension Care Kit', quantity: '1', catalog_object_id: 'demo-v6', item_type: 'ITEM',
        gross_sales_money: { amount: 6500 }, total_discount_money: { amount: 0 }, total_money: { amount: 6500 } }],
      tenders: [{ id: `t-${id}`, payment_id: `pay-${id}`, amount_money: { amount: 6500 } }],
    } as any);
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const yesterday = new Date(Date.now() - 26 * 3600_000).toISOString();
    demoExtraOrders.push(ticket('demo-ord-nobody-a', hourAgo), ticket('demo-ord-nobody-b', yesterday));
    // The front desk and a stylist are on the clock now; nobody was yesterday.
    await db().query("INSERT INTO time_clock_shifts (staff_id, clock_in_at) VALUES ($1, now() - interval '3 hours'), ($2, now() - interval '2 hours')", [desk, jenId]);
    await sync();
    const a = (await entries("square_order_id = 'demo-ord-nobody-a'"))[0];
    expect(a).toMatchObject({ staff_id: desk, attribution: 'fallback', on_hold: true, needs_review: true });
    expect(a.review_reason).toMatch(/front desk, on the clock/);
    const b = (await entries("square_order_id = 'demo-ord-nobody-b'"))[0];
    expect(b).toMatchObject({ staff_id: null, needs_review: true });

    // A backup person covers the rest.
    const settings = (await admin.get('/api/settings')).body.settings.commission;
    expect((await admin.put('/api/commission/settings', { unrecordedCheckout: { ...settings.unrecordedCheckout, fallbackStaffId: michaelId } })).status).toBe(200);
    const b2 = (await entries("square_order_id = 'demo-ord-nobody-b'"))[0];
    expect(b2).toMatchObject({ staff_id: michaelId, attribution: 'fallback', on_hold: true });
    const review = (await admin.get('/api/commission/review')).body.entries;
    expect(review.find((e: any) => e.squareOrderId === 'demo-ord-nobody-b').calc.suggestions[0]).toMatchObject({ staffId: michaelId });
    // Someone switched off for suggestions (e.g. never at the salon) is never picked or suggested.
    expect((await admin.put(`/api/commission/pay/${michaelId}/suggest`, { suggest: false })).status).toBe(200);
    const b3 = (await entries("square_order_id = 'demo-ord-nobody-b'"))[0];
    expect(b3.staff_id).toBeNull();
    const review3 = (await admin.get('/api/commission/review')).body.entries.find((e: any) => e.squareOrderId === 'demo-ord-nobody-b');
    expect((review3.calc.suggestions ?? []).some((x: any) => x.staffId === michaelId)).toBe(false);
    await admin.put(`/api/commission/pay/${michaelId}/suggest`, { suggest: true });

    // Both credited to Jen at once.
    const ids = review.filter((e: any) => e.squareOrderId?.startsWith('demo-ord-nobody')).map((e: any) => e.id);
    const r = await admin.post('/api/commission/entries/attribute', { entryIds: ids, staffIds: [jenId] });
    expect(r.body.credited).toBe(2);
    expect((await entries("square_order_id LIKE 'demo-ord-nobody%'")).every((e) => e.staff_id === jenId && !e.needs_review)).toBe(true);

    await admin.put('/api/commission/settings', { unrecordedCheckout: settings.unrecordedCheckout });
    await db().query('DELETE FROM time_clock_shifts');
    for (const s of saved) await db().query('INSERT INTO time_clock_shifts (id, staff_id, clock_in_at, clock_out_at, paid_minutes) VALUES ($1,$2,$3,$4,$5)', [s.id, s.staff_id, s.clock_in_at, s.clock_out_at, s.paid_minutes]);
    demoExtraOrders.length = 0;
  });

  it('Needs review shows the last month unless other dates are chosen', async () => {
    const all = (await admin.get(`/api/commission/review?from=${daysAgo(400)}&to=${today()}`)).body.entries;
    const r = (await admin.get('/api/commission/review')).body;
    const monthAgo = (() => { const d = new Date(`${today()}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })();
    expect(r).toMatchObject({ from: monthAgo, to: today() });
    expect(r.entries.every((e: any) => e.transactionDate >= monthAgo)).toBe(true);
    expect(r.entries.length).toBe(all.filter((e: any) => e.transactionDate >= monthAgo).length);
    expect((await admin.get('/api/commission/status')).body.status?.needsReview ?? (await admin.get('/api/commission/status')).body.needsReview).toBe(r.entries.length);
  });

  it('a sale no rule covers uses the salon default (40% services, 10% products)', async () => {
    await db().query("DELETE FROM commission_rules WHERE category = 'retail'");
    await sync();
    const e = (await entries("kind = 'sale' AND category = 'retail' AND staff_id IS NOT NULL AND status = 'estimated' AND eligible_cents > 0 AND transaction_date > now() - interval '30 days'"))[0];
    expect(e.rate_bps).toBe(1000);
    expect(e.commission_cents).toBe(Math.round(e.eligible_cents * 0.1));
    expect(e.calc.rule).toMatch(/Salon default/);
  });

  it('keeps a history for each record', async () => {
    const e = (await entries("status = 'finalized'"))[0];
    const h = (await admin.get(`/api/commission/entries/${e.id}/history`)).body.history.map((x: any) => x.action);
    expect(h).toEqual(expect.arrayContaining(['created', 'finalized']));
    const audit = (await admin.get('/api/audit?limit=100')).body.entries.map((x: any) => x.action);
    expect(audit).toEqual(expect.arrayContaining(['commission.finalize', 'commission.rule_create', 'commission.attribute']));
  });

  it('adjustments are recorded with a reason and show in totals', async () => {
    expect((await admin.post('/api/commission/adjustments', { staffId: michaelId, amountCents: 2500, date: today(), note: '' })).status).toBe(400);
    const r = await admin.post('/api/commission/adjustments', { staffId: michaelId, amountCents: 2500, date: today(), note: 'Training bonus' });
    expect(r.status).toBe(201);
    const s = (await admin.get(`/api/commission/staff/${michaelId}?from=${today()}&to=${today()}`)).body.summary;
    expect(s.adjustmentsCents).toBe(2500);
    expect((await admin.post('/api/commission/adjustments', { staffId: michaelId, amountCents: 100, date: daysAgo(40), note: 'Too late' })).status).toBe(400);
  });

  it('exports for payroll with the rate and calculation of every record', async () => {
    const r = await admin.get(`/api/commission/export?${RANGE()}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    const [head, ...rows] = r.text.split('\n');
    expect(head).toContain('"Rate %"');
    expect(head).toContain('"How it was calculated"');
    expect(rows.length).toBeGreaterThan(50);
  });

  it('edits a rate in place, unless it was used for finalized commission', async () => {
    const created = await admin.post('/api/commission/rules', { staffId: jenId, category: 'retail', method: 'percent', rateBps: 1000, effectiveFrom: daysAgo(5) });
    expect(created.status).toBe(201);
    const body = { staffId: jenId, category: 'retail', method: 'percent', rateBps: 1500, effectiveFrom: daysAgo(5), note: 'Fixed typo' };
    const edited = await admin.put(`/api/commission/rules/${created.body.id}`, body);
    expect(edited.status).toBe(200);
    const rule = edited.body.rules.find((x: any) => x.id === created.body.id);
    expect(rule).toMatchObject({ rateBps: 1500, note: 'Fixed typo', locked: false });

    // Overlapping another rate for the same person and item is refused.
    const later = await admin.post('/api/commission/rules', { ...body, rateBps: 2000, effectiveFrom: today() });
    expect(later.status).toBe(201);
    expect((await admin.put(`/api/commission/rules/${later.body.id}`, { ...body, effectiveFrom: daysAgo(10) })).status).toBe(400);

    // The everyone-40% rule from earlier was used for finalized commission: it can only be replaced from a date.
    const old = (await admin.get('/api/commission/rules')).body.rules.find((x: any) => x.rateBps === 4000 && x.category === 'service' && !x.staffId && x.targetType === 'all');
    expect(old.locked).toBe(true);
    expect((await admin.put(`/api/commission/rules/${old.id}`, { category: 'service', method: 'percent', rateBps: 3000, effectiveFrom: old.effectiveFrom })).status).toBe(400);
  });

  it('validates rules', async () => {
    const bad = [
      { category: 'service', method: 'percent', rateBps: 12000, effectiveFrom: today() },
      { category: 'service', method: 'tiered', tiers: [{ upToCents: null, rateBps: 4000 }], effectiveFrom: today() },
      { category: 'retail', targetType: 'service', targetId: 'x', method: 'percent', rateBps: 100, effectiveFrom: today() },
      { category: 'service', method: 'flat', effectiveFrom: today() },
    ];
    for (const b of bad) expect((await admin.post('/api/commission/rules', b)).status).toBe(400);
  });
});

describe('Privacy', () => {
  it('pay stays hidden until the person re-enters their password', async () => {
    const jen = await signIn('jennifer@addendumsalon.com', true);
    expect((await jen.get('/api/auth/reauth-status')).body.unlocked).toBe(false);
    const locked = await jen.get(`/api/commission/me?${RANGE()}`);
    expect([locked.status, locked.body.error.code]).toEqual([403, 'reauth_required']);
    expect((await jen.get('/api/commission/me/year?year=2026')).status).toBe(403);
    expect((await jen.get(`/api/commission/staff/${jenId}?${RANGE()}`)).status).toBe(403);
    expect((await jen.post('/api/auth/confirm-password', { password: 'wrong' })).status).toBe(400);
    expect((await jen.post('/api/auth/confirm-password', { password: 'addendum-demo' })).status).toBe(200);
    expect((await jen.get('/api/auth/reauth-status')).body.unlocked).toBe(true);
    expect((await jen.get(`/api/commission/me?${RANGE()}`)).status).toBe(200);
  });

  it('an Admin can keep pay unlocked for a 4-hour session; others get 10 minutes; Lock now locks it', async () => {
    const age = (mins: number) => db().query(`UPDATE sessions SET reauthenticated_at = now() - make_interval(mins => ${mins}) WHERE reauthenticated_at IS NOT NULL`);
    const owner = await signIn('owner@addendumsalon.com', true);
    expect((await owner.post('/api/auth/confirm-password', { password: 'addendum-demo', keepPayUnlocked: true })).status).toBe(200);
    let st = (await owner.get('/api/auth/reauth-status')).body;
    expect(st).toMatchObject({ unlocked: true, canKeepUnlocked: true, sessionHours: 4 });
    expect(new Date(st.until).getTime()).toBeGreaterThan(Date.now() + 3.9 * 3600_000);
    await age(30); // past the usual 10 minutes — still open for the session
    expect((await owner.get(`/api/commission/team?${RANGE()}`)).status).toBe(200);
    // Lock now.
    await owner.post('/api/auth/lock-pay');
    expect((await owner.get(`/api/commission/team?${RANGE()}`)).status).toBe(403);
    // After 4 hours it locks by itself.
    await owner.post('/api/auth/confirm-password', { password: 'addendum-demo', keepPayUnlocked: true });
    await age(30);
    await db().query("UPDATE sessions SET pay_unlocked_until = now() - interval '1 minute' WHERE pay_unlocked_until IS NOT NULL");
    expect((await owner.get(`/api/commission/team?${RANGE()}`)).status).toBe(403);
    // Not an Admin: the box is ignored — 10 minutes as usual.
    const jen = await signIn('jennifer@addendumsalon.com', true);
    await jen.post('/api/auth/confirm-password', { password: 'addendum-demo', keepPayUnlocked: true });
    st = (await jen.get('/api/auth/reauth-status')).body;
    expect([st.canKeepUnlocked, st.until]).toEqual([false, null]);
    // Put everyone's confirmation back for the tests that follow.
    await db().query('UPDATE sessions SET reauthenticated_at = now()');
  });

  it('team pay, payroll, wages and exports are locked the same way for administrators', async () => {
    const owner = await signIn('owner@addendumsalon.com', true);
    for (const url of [`/api/commission/team?${RANGE()}`, `/api/commission/export?${RANGE()}`, `/api/commission/export/summary?${RANGE()}`,
      `/api/commission/pay/${jenId}?${RANGE()}`, `/api/commission/timesheet?from=${daysAgo(6)}&to=${today()}`, `/api/commission/staff/${jenId}?${RANGE()}`]) {
      const r = await owner.get(url);
      expect([url, r.status, r.body?.error?.code]).toEqual([url, 403, 'reauth_required']);
    }
    await owner.post('/api/auth/confirm-password', { password: 'addendum-demo' });
    expect((await owner.get(`/api/commission/team?${RANGE()}`)).status).toBe(200);
  });

  it('a stylist sees only their own commission, whatever they ask for', async () => {
    const jen = await signIn('jennifer@addendumsalon.com');
    const mine = (await jen.get(`/api/commission/me?${RANGE()}`)).body;
    expect(mine.entries.length).toBeGreaterThan(0);
    expect(mine.entries.every((e: any) => e.staffId === jenId)).toBe(true);
    expect(mine.summary.totalCommissionCents).toBeGreaterThan(0);
    expect((await jen.get(`/api/commission/me?${RANGE()}&staffId=${michaelId}`)).body.entries.every((e: any) => e.staffId === jenId)).toBe(true);
    expect((await jen.get(`/api/commission/staff/${michaelId}?${RANGE()}`)).status).toBe(404);
    expect((await jen.get(`/api/commission/staff/${jenId}?${RANGE()}`)).status).toBe(200);
    expect((await jen.get(`/api/commission/team?${RANGE()}`)).status).toBe(403);
    expect((await jen.get(`/api/commission/export?${RANGE()}`)).status).toBe(403);
    expect((await jen.get('/api/commission/rules')).status).toBe(403);
    expect((await jen.get('/api/commission/review')).status).toBe(403);
    expect((await jen.post('/api/commission/rules', { category: 'service', method: 'percent', rateBps: 9000, effectiveFrom: today() })).status).toBe(403);
    const other = (await entries('staff_id = $1', [michaelId]))[0];
    expect((await jen.get(`/api/commission/entries/${other.id}/history`)).status).toBe(404);
    const status = (await jen.get('/api/commission/status')).body.status;
    expect(status.unlinkedTeamMembers).toEqual([]);
  });

  it('front desk and assistants don’t see team commission unless granted', async () => {
    const desk = await signIn('frontdesk@addendumsalon.com');
    expect((await desk.get(`/api/commission/team?${RANGE()}`)).status).toBe(403);
    expect((await desk.get(`/api/commission/me?${RANGE()}`)).status).toBe(200);
    const deskId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
    await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'commission:team': true }, confirm: true });
    const team = await desk.get(`/api/commission/team?${RANGE()}`);
    expect(team.status).toBe(200);
    expect(team.body.rows.length).toBeGreaterThan(3);
    expect((await desk.get(`/api/commission/export?${RANGE()}`)).status).toBe(403); // export is separate
  });

  it('administrators see the team, with estimated and finalized amounts apart', async () => {
    const team = (await admin.get(`/api/commission/team?${RANGE()}`)).body;
    const m = team.rows.find((r: any) => r.staffId === michaelId);
    expect(m.finalizedCents).toBeGreaterThan(0);
    expect(m.estimatedCents).not.toBe(0);
    expect(m.estimatedCents + m.finalizedCents).toBe(m.totalCommissionCents);
    // Gross pay and estimated taxes side by side for payroll.
    expect(m.taxes.grossCents).toBe(m.totalCommissionCents + m.tipsCents + m.pay.wagesCents);
    expect(m.taxes.netCents).toBe(m.taxes.grossCents - m.taxes.withheldCents);
  });
});

describe('Rebuild is safe to run any time', () => {
  it('changes nothing when nothing changed', async () => {
    const snap = async () => db().query<any>("SELECT id, commission_cents, status FROM commission_entries ORDER BY id");
    const a = await snap();
    const r = await rebuildCommission();
    expect(r.created).toBe(0);
    expect(await snap()).toEqual(a);
  });
});

const NO_TAX = { workerType: 'w2', federalBps: null, stateBps: null, localBps: null,
  w4: { filingStatus: null, multipleJobs: false, dependentsCents: null, otherIncomeCents: null, deductionsCents: null, extraWithholdingCents: null } };

describe('Wages, hours and tips', () => {
  it('tips on a non-tip-eligible person’s work go to Needs review, and come back when eligible again', async () => {
    const before = await entries("kind = 'tip' AND staff_id = $1 AND status = 'estimated'", [michaelId]);
    expect(before.length).toBeGreaterThan(0);
    const pay = (await admin.get(`/api/commission/pay/${michaelId}?${RANGE()}`)).body.pay;
    expect((await admin.put(`/api/commission/pay/${michaelId}`, { ...pay, tipEligible: false })).status).toBe(200);
    expect((await entries("kind = 'tip' AND staff_id = $1 AND status = 'estimated'", [michaelId])).length).toBe(0);
    const held = await entries("kind = 'tip' AND staff_id IS NULL AND needs_review AND review_reason LIKE '%isn’t tip eligible%'");
    expect(held.length).toBeGreaterThan(0);
    expect((await admin.get(`/api/commission/team?${RANGE()}`)).body.rows.find((r: any) => r.staffId === michaelId).tipEligible).toBe(false);
    await admin.put(`/api/commission/pay/${michaelId}`, { ...pay, tipEligible: true });
    expect((await entries("kind = 'tip' AND staff_id = $1 AND status = 'estimated'", [michaelId])).length).toBe(before.length);
  });

  it('reads hours from Square timecards, adds hours entered by hand, and works out hourly and salary wages', async () => {
    await sync();
    const range = `from=${daysAgo(13)}&to=${daysAgo(7)}`;
    const square = (await admin.get(`/api/commission/pay/${jenId}?${range}`)).body;
    expect(square.hours.length).toBeGreaterThan(0);
    expect(square.hours.every((h: any) => h.source === 'square' && h.minutes === 450)).toBe(true); // 8h less a 30-minute unpaid break

    const added = await admin.post('/api/commission/hours', { staffId: jenId, date: daysAgo(10), hours: 2.5, note: 'Training' });
    expect(added.status).toBe(201);
    await admin.put(`/api/commission/pay/${jenId}`, { payType: 'hourly', hourlyRateCents: 2000, salaryCents: null, salaryPeriod: 'year', tipEligible: true, taxes: NO_TAX });
    const s = (await admin.get(`/api/commission/pay/${jenId}?${range}`)).body.summary;
    expect(s.manualMinutes).toBe(150);
    expect(s.minutes).toBe(s.squareMinutes + 150);
    expect(s.wagesCents).toBe(Math.round((s.minutes / 60) * 2000));

    // Square timecards can't be deleted here; hand-entered hours can.
    expect((await admin.del(`/api/commission/hours/${square.hours[0].id}`)).status).toBe(400);
    expect((await admin.del(`/api/commission/hours/${added.body.id}`)).status).toBe(200);

    await admin.put(`/api/commission/pay/${jenId}`, { payType: 'salary', hourlyRateCents: null, salaryCents: 5200000, salaryPeriod: 'year', tipEligible: true, taxes: NO_TAX });
    const week = (await admin.get(`/api/commission/pay/${jenId}?${range}`)).body.summary;
    expect(week.wagesCents).toBe(Math.round((5200000 / 365) * 7));

    const row = (await admin.get(`/api/commission/team?${range}`)).body.rows.find((r: any) => r.staffId === jenId);
    expect(row.pay.wagesCents).toBe(week.wagesCents);
    const csv = await admin.get(`/api/commission/export/summary?${range}`);
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toContain('"Service commission","Retail sales","Retail commission"');
    expect(csv.text).toContain('Jennifer');
    await admin.put(`/api/commission/pay/${jenId}`, { payType: 'none', hourlyRateCents: null, salaryCents: null, salaryPeriod: 'year', tipEligible: true, taxes: NO_TAX });
  });

  it('Clear & start over deletes one person’s saved hours for the dates and reloads them from Square', async () => {
    const sheet = async () => (await admin.get(`/api/commission/timesheet?from=${daysAgo(6)}&to=${today()}`)).body.rows.find((r: any) => r.staffId === michaelId);
    await sync();
    const before = await sheet();
    const day = Object.keys(before.square).find((d) => d < today() && !before.timesheet[d])!;
    // A stray copy (e.g. a timecard Square no longer has) and a typed-in day make it double.
    await db().query("INSERT INTO staff_hours(staff_id, work_date, minutes, source, square_timecard_id) VALUES ($1,$2,$3,'square','gone-from-square')", [michaelId, day, before.square[day]]);
    await db().query("INSERT INTO staff_hours(staff_id, work_date, minutes, source, note) VALUES ($1,$2,60,'manual','by hand')", [michaelId, day]);
    expect((await sheet()).pay.minutes).toBe(before.pay.minutes + before.square[day] + 60);
    const r = await admin.post('/api/commission/timesheet/clear', { staffId: michaelId, from: daysAgo(6), to: today() });
    expect(r.status).toBe(200);
    expect(r.body.reloaded).toBe(true);
    const after = await sheet();
    expect(after.square[day]).toBe(before.square[day]);
    expect(after.manual[day]).toBeUndefined();
    const jen = await signIn('jennifer@addendumsalon.com');
    expect((await jen.post('/api/commission/timesheet/clear', { staffId: michaelId, from: daysAgo(6), to: today() })).status).toBe(403);
  });

  it('a time clock shift kept only in the CRM isn’t added on top of Square’s hours for the same day', async () => {
    const sheet = async () => (await admin.get(`/api/commission/timesheet?from=${daysAgo(6)}&to=${today()}`)).body.rows.find((r: any) => r.staffId === michaelId);
    const before = await sheet();
    const day = Object.keys(before.square).find((d) => d < today() && !before.timesheet[d])!;
    const r = await db().one<any>("INSERT INTO staff_hours(staff_id, work_date, minutes, source, note) VALUES ($1,$2,$3,'manual','Time clock') RETURNING id", [michaelId, day, before.square[day]]);
    expect((await sheet()).pay.minutes).toBe(before.pay.minutes);
    await db().query('DELETE FROM staff_hours WHERE id = $1', [r.id]);
  });

  it('a day’s hours on the payroll timesheet replace Square’s for that day; clearing the box brings Square’s back', async () => {
    const sheet = async () => (await admin.get(`/api/commission/timesheet?from=${daysAgo(6)}&to=${today()}`)).body.rows.find((r: any) => r.staffId === michaelId);
    const before = await sheet();
    const day = Object.keys(before.square).find((d) => d < today())!;
    expect(day).toBeTruthy();
    const put = (hours: number | null) => admin.put('/api/commission/timesheet', { staffId: michaelId, date: day, hours });
    expect((await put(before.square[day] / 60)).status).toBe(200); // "Use Sq": same hours, not counted twice
    let row = await sheet();
    expect(row.timesheet[day]).toBe(before.square[day]);
    expect(row.pay.minutes).toBe(before.pay.minutes);
    expect((await put(10)).status).toBe(200); // adjusted: replaces Square's hours for the day
    row = await sheet();
    expect(row.pay.minutes).toBe(before.pay.minutes - before.square[day] + 600);
    expect(row.pay.squareMinutes).toBe(before.pay.squareMinutes - before.square[day]);
    expect((await put(null)).status).toBe(200); // cleared: Square's count again (Square was updated to the 10 hours)
    row = await sheet();
    expect(row.timesheet[day]).toBeUndefined();
    expect(row.square[day]).toBe(600);
    expect(row.pay.minutes).toBe(before.pay.minutes - before.square[day] + 600);
    expect((await admin.get(`/api/commission/timesheet?from=${daysAgo(60)}&to=${today()}`)).status).toBe(400);
    const jen = await signIn('jennifer@addendumsalon.com');
    expect((await jen.get(`/api/commission/timesheet?from=${daysAgo(6)}&to=${today()}`)).status).toBe(403);
  });

  it('the Year tab breaks estimated taxes down by tax (incl. CA SDI), shown per person when turned on', async () => {
    const pay = (await admin.get(`/api/commission/pay/${jenId}?${RANGE()}`)).body.pay;
    const save = (showBreakdown: boolean) => admin.put(`/api/commission/pay/${jenId}`, {
      payType: pay.payType, hourlyRateCents: pay.hourlyRateCents, salaryCents: pay.salaryCents, salaryPeriod: pay.salaryPeriod, tipEligible: pay.tipEligible,
      taxes: { ...pay.taxes, workerType: 'w2', federalBps: 1000, stateBps: 400, showBreakdown },
    });
    expect((await save(true)).status).toBe(200);
    const jen = await signIn('jennifer@addendumsalon.com', false);
    const y = (await jen.get('/api/commission/me/year?year=2026')).body;
    expect(y.showTaxBreakdown).toBe(true);
    const r = y.rows.find((x: any) => x.grossCents > 0);
    expect(r.federalCents).toBe(Math.round(r.grossCents * 0.10));
    expect(r.socialSecurityCents).toBe(Math.round(r.grossCents * 0.062));
    expect(r.medicareCents).toBe(Math.round(r.grossCents * 0.0145));
    expect(r.stateCents).toBe(Math.round(r.grossCents * 0.04));
    expect(r.sdiCents).toBe(Math.round(r.grossCents * 0.013)); // the salon is in California
    expect(r.federalCents + r.socialSecurityCents + r.medicareCents + r.stateCents + r.sdiCents + r.localCents).toBe(r.withheldCents);
    expect((await save(false)).status).toBe(200);
    expect((await jen.get('/api/commission/me/year?year=2026')).body.showTaxBreakdown).toBe(false);
    expect((await save(true)).status).toBe(200);
  });

  it('estimates taxes from each person’s withholding and the salon rates; contractors have nothing withheld', async () => {
    const taxes = { ...NO_TAX, federalBps: 1000, stateBps: 400, w4: { ...NO_TAX.w4, filingStatus: 'single', extraWithholdingCents: 2500 } };
    expect((await admin.put(`/api/commission/pay/${michaelId}`, { payType: 'none', hourlyRateCents: null, salaryCents: null, salaryPeriod: 'year', tipEligible: true, taxes })).status).toBe(200);
    expect((await admin.get(`/api/commission/pay/${michaelId}?${RANGE()}`)).body.pay.taxes).toMatchObject({ federalBps: 1000, w4: { filingStatus: 'single', extraWithholdingCents: 2500 } });
    const d = (await admin.get(`/api/commission/staff/${michaelId}?${RANGE()}`)).body;
    const gross = d.summary.totalCommissionCents + d.summary.tipsCents;
    expect(d.taxes.grossCents).toBe(gross);
    expect(d.taxes.federalCents).toBe(Math.round(gross * 0.10));
    expect(d.taxes.ficaCents).toBe(Math.round(gross * 0.062) + Math.round(gross * 0.0145));
    expect(d.taxes.netCents).toBe(gross - d.taxes.withheldCents);
    expect(d.taxes.employerCents).toBe(Math.round(gross * 0.062) + Math.round(gross * 0.0145) + Math.round(gross * 0.006));
    const csv = (await admin.get(`/api/commission/export/summary?${RANGE()}`)).text;
    expect(csv.split('\n')[0]).toContain('"Est. net pay"');

    // California DE 4: saved for payroll, and "exempt" means no state withholding in the estimate.
    const de4 = { exempt: true, filingStatus: 'single_or_married_two_incomes', regularAllowances: 1, additionalAllowances: 0, additionalWithholdingCents: 0 };
    await admin.put(`/api/commission/pay/${michaelId}`, { payType: 'none', hourlyRateCents: null, salaryCents: null, salaryPeriod: 'year', tipEligible: true, taxes: { ...taxes, de4 } });
    expect((await admin.get(`/api/commission/pay/${michaelId}?${RANGE()}`)).body.pay.taxes.de4).toEqual(de4);
    const ex = (await admin.get(`/api/commission/staff/${michaelId}?${RANGE()}`)).body.taxes;
    expect([ex.stateCents, ex.federalCents]).toEqual([0, Math.round(gross * 0.10)]);
    expect((await admin.get(`/api/commission/export/summary?${RANGE()}`)).text.split('\n')[0]).toContain('"CA DE 4 regular allowances"');

    await admin.put(`/api/commission/pay/${michaelId}`, { payType: 'none', hourlyRateCents: null, salaryCents: null, salaryPeriod: 'year', tipEligible: true, taxes: { ...taxes, workerType: '1099' } });
    const c = (await admin.get(`/api/commission/staff/${michaelId}?${RANGE()}`)).body.taxes;
    expect([c.withheldCents, c.employerCents, c.netCents]).toEqual([0, 0, gross]);
    await admin.put(`/api/commission/pay/${michaelId}`, { payType: 'none', hourlyRateCents: null, salaryCents: null, salaryPeriod: 'year', tipEligible: true, taxes: NO_TAX });
  });

  it('a raise starts on its date: hours before it are paid at the old wage, and past wages can be corrected', async () => {
    const base = { salaryCents: null, salaryPeriod: 'year', tipEligible: true, taxes: NO_TAX };
    await admin.put(`/api/commission/pay/${jenId}`, { ...base, payType: 'hourly', hourlyRateCents: 2000, effectiveFrom: null });
    await admin.put(`/api/commission/pay/${jenId}`, { ...base, payType: 'hourly', hourlyRateCents: 3000, effectiveFrom: daysAgo(10) });
    const range = `from=${daysAgo(13)}&to=${daysAgo(7)}`;
    const { hours, pay } = (await admin.get(`/api/commission/pay/${jenId}?${range}`)).body;
    const mins = (pred: (d: string) => boolean) => hours.filter((h: any) => pred(h.date)).reduce((a: number, h: any) => a + h.minutes, 0);
    const before = mins((d) => d < daysAgo(10));
    const after = mins((d) => d >= daysAgo(10));
    let s = (await admin.get(`/api/commission/pay/${jenId}?${range}`)).body.summary;
    expect(s.wagesCents).toBe(Math.round((before / 60) * 2000) + Math.round((after / 60) * 3000));
    expect(s.basis).toContain(' + ');
    expect(pay.rates.map((r: any) => r.hourlyRateCents)).toEqual([3000, 2000]);
    expect(pay.rates[1]).toMatchObject({ effectiveFrom: null, effectiveTo: daysAgo(11) });
    expect(pay.hourlyRateCents).toBe(3000); // the wage in effect today

    // Correct the earlier wage: only the hours before the raise change.
    const old = pay.rates[1];
    expect((await admin.patch(`/api/commission/pay-rates/${old.id}`, { payType: 'hourly', hourlyRateCents: 2500, salaryCents: null, salaryPeriod: 'year', effectiveFrom: null })).status).toBe(200);
    s = (await admin.get(`/api/commission/pay/${jenId}?${range}`)).body.summary;
    expect(s.wagesCents).toBe(Math.round((before / 60) * 2500) + Math.round((after / 60) * 3000));
    expect((await admin.patch(`/api/commission/pay-rates/${old.id}`, { payType: 'hourly', hourlyRateCents: 2500, salaryCents: null, salaryPeriod: 'year', effectiveFrom: daysAgo(10) })).status).toBe(400); // clash
    // Add another wage to the history (e.g. a later raise); one wage per start date.
    const later = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    const added = await admin.post('/api/commission/pay-rates', { staffId: jenId, payType: 'hourly', hourlyRateCents: 3500, salaryCents: null, salaryPeriod: 'year', effectiveFrom: later });
    expect(added.status).toBe(201);
    expect(added.body.pay.rates[0]).toMatchObject({ hourlyRateCents: 3500, effectiveFrom: later, effectiveTo: null });
    expect(added.body.pay.hourlyRateCents).toBe(3000); // still today's wage until then
    expect((await admin.post('/api/commission/pay-rates', { staffId: jenId, payType: 'hourly', hourlyRateCents: 1, salaryCents: null, salaryPeriod: 'year', effectiveFrom: later })).status).toBe(400);
    for (const r of (await admin.get(`/api/commission/pay/${jenId}?${range}`)).body.pay.rates) await admin.del(`/api/commission/pay-rates/${r.id}`);
    expect((await admin.get(`/api/commission/pay/${jenId}?${range}`)).body.pay.payType).toBe('none');
  });

  it('a wage for certain dates only: the earlier wage carries on the day after', async () => {
    const base = { salaryCents: null, salaryPeriod: 'year', tipEligible: true, taxes: NO_TAX };
    await admin.put(`/api/commission/pay/${jenId}`, { ...base, payType: 'hourly', hourlyRateCents: 3000, effectiveFrom: null });
    const r = await admin.post('/api/commission/pay-rates', { staffId: jenId, payType: 'hourly', hourlyRateCents: 2200, salaryCents: null, salaryPeriod: 'year', effectiveFrom: daysAgo(20), effectiveTo: daysAgo(15) });
    expect(r.status).toBe(201);
    expect(r.body.pay.rates.map((x: any) => [x.hourlyRateCents, x.effectiveFrom, x.effectiveTo])).toEqual([
      [3000, daysAgo(14), null], [2200, daysAgo(20), daysAgo(15)], [3000, null, daysAgo(21)],
    ]);
    expect(r.body.pay.hourlyRateCents).toBe(3000);
    // Another wage inside those dates, or an end before the start, is refused.
    expect((await admin.post('/api/commission/pay-rates', { staffId: jenId, payType: 'hourly', hourlyRateCents: 1, salaryCents: null, salaryPeriod: 'year', effectiveFrom: daysAgo(30), effectiveTo: daysAgo(18) })).status).toBe(400);
    expect((await admin.post('/api/commission/pay-rates', { staffId: jenId, payType: 'hourly', hourlyRateCents: 1, salaryCents: null, salaryPeriod: 'year', effectiveFrom: daysAgo(5), effectiveTo: daysAgo(8) })).status).toBe(400);
    for (const x of r.body.pay.rates) await admin.del(`/api/commission/pay-rates/${x.id}`);
    await admin.put(`/api/commission/pay/${jenId}`, { ...base, payType: 'none', hourlyRateCents: null });
  });

  it('an Owner/Admin can send hours entered in the CRM to Square as a timecard, once', async () => {
    const day = daysAgo(4);
    // A day Square has no timecard for (the demo one removed).
    const tmId = (await db().one<any>('SELECT square_team_member_id FROM staff WHERE id = $1', [michaelId])).square_team_member_id;
    const prevDay = new Date(new Date(`${day}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
    const { demoCreatedTimecards: made } = await import('../src/integrations/square/MockSquareService.js');
    for (const d of [day, prevDay]) {
      await new MockSquareService().deleteTimecard(`demo-tc-${tmId}-${d}`);
      for (const t of made.filter((x) => x.team_member_id === tmId && localDate(new Date(x.start_at), TZ) === d)) await new MockSquareService().deleteTimecard(t.id);
      await db().query(`DELETE FROM staff_hours WHERE staff_id = $1 AND work_date = $2::date`, [michaelId, d]);
    }
    // Scheduled 10:30 that weekday: the timecard starts then.
    const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
    await admin.put(`/api/timeclock/schedule/${michaelId}`, { days: [{ weekday: wd, start: '10:30', end: '17:30', lunchMinutes: 30, breakMinutes: 10 }] });
    // Typing hours into the box updates Square right away (Owner/Admin).
    const typed = await admin.put('/api/commission/timesheet', { staffId: michaelId, date: day, hours: 6.5 });
    expect(typed.body.square).toEqual({ updated: true, error: null });
    const squareRow = () => db().one<any>("SELECT minutes, square_timecard_id FROM staff_hours WHERE staff_id = $1 AND work_date = $2::date AND source = 'square'", [michaelId, day]);
    const row1 = await squareRow();
    expect(row1.minutes).toBe(390);
    // Filed under their assigned job in Square.
    const { demoCreatedTimecards } = await import('../src/integrations/square/MockSquareService.js');
    const card = demoCreatedTimecards.find((t) => t.id === row1.square_timecard_id) as any;
    expect(card.job_id).toMatch(/^demo-job-/);
    expect(new Date(card.start_at).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })).toBe('10:30 AM');
    expect((new Date(card.end_at).getTime() - new Date(card.start_at).getTime()) / 60_000).toBe(390);
    // Sending again changes nothing: Square already matches.
    const again = await admin.post('/api/commission/timesheet/to-square', { staffId: michaelId, date: day });
    expect([again.status, again.body.sent]).toEqual([200, 0]);
    // Changed in the box: that day's timecard is replaced (same start), never added to.
    await admin.put('/api/commission/timesheet', { staffId: michaelId, date: day, hours: 7 });
    const row1b = await squareRow();
    expect(row1b.minutes).toBe(420);
    expect(demoCreatedTimecards.some((t) => t.id === row1.square_timecard_id)).toBe(false);
    // Working a day they aren't scheduled: their normal start (here, the only scheduled start, 10:30). "Send week" sends it.
    const day2 = prevDay;
    await db().query("INSERT INTO staff_hours(staff_id, work_date, minutes, source, note) VALUES ($1,$2,240,'manual','test')", [michaelId, day2]);
    const wk = await admin.post('/api/commission/timesheet/to-square', { staffId: michaelId, from: daysAgo(6), to: today() });
    expect(wk.status).toBe(200);
    expect(wk.body.sent).toBeGreaterThanOrEqual(1);
    const row2 = await db().one<any>("SELECT square_timecard_id FROM staff_hours WHERE staff_id = $1 AND work_date = $2::date AND source = 'square'", [michaelId, day2]);
    const card2 = demoCreatedTimecards.find((t) => t.id === row2.square_timecard_id) as any;
    expect(new Date(card2.start_at).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })).toBe('10:30 AM');
    await admin.put(`/api/timeclock/schedule/${michaelId}`, { days: [] });
    // The next sync reads it back from Square, without doubling the day.
    await sync();
    const sheet = (await admin.get(`/api/commission/timesheet?from=${daysAgo(6)}&to=${today()}`)).body.rows.find((x: any) => x.staffId === michaelId);
    expect(sheet.square[day]).toBe(420);
    expect(sheet.timesheet[day]).toBe(420);
    // Managers who aren't Owner/Admin can't.
    const deskId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
    await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'commission:manage': true, 'commission:team': true }, confirm: true });
    const desk = await signIn('frontdesk@addendumsalon.com');
    expect((await desk.post('/api/commission/timesheet/to-square', { from: daysAgo(6), to: today() })).status).toBe(403);
    await admin.put(`/api/admin/users/${deskId}/access`, { overrides: { 'commission:manage': null, 'commission:team': null } });
  });

  it('only people who see team pay can see wages, and only managers change them', async () => {
    const jen = await signIn('jennifer@addendumsalon.com');
    expect((await jen.get(`/api/commission/pay/${jenId}?${RANGE()}`)).status).toBe(403);
    expect((await jen.post('/api/commission/hours', { staffId: jenId, date: today(), hours: 8 })).status).toBe(403);
    expect((await jen.get(`/api/commission/staff/${michaelId}?${RANGE()}`)).status).toBe(404); // someone else's pay
    expect((await jen.get(`/api/commission/staff/${michaelId}/year?year=2026`)).status).toBe(403);
    expect((await jen.get(`/api/commission/export/summary?${RANGE()}`)).status).toBe(403);
  });
});

describe('Pay periods', () => {
  const biweekly = { frequency: 'biweekly' as const, anchorStart: '2026-09-26', payDayOffsetDays: 7 };
  it('works out every-2-weeks periods and paydays from one known period', () => {
    expect(payPeriodFor('2026-10-01', biweekly)).toEqual({ from: '2026-09-26', to: '2026-10-09', payDate: '2026-10-16' });
    expect(payPeriodFor('2026-10-09', biweekly)).toEqual({ from: '2026-09-26', to: '2026-10-09', payDate: '2026-10-16' });
    expect(payPeriodFor('2026-10-15', biweekly)).toEqual({ from: '2026-10-10', to: '2026-10-23', payDate: '2026-10-30' });
    expect(payPeriodFor('2026-10-15', biweekly, -1)).toEqual({ from: '2026-09-26', to: '2026-10-09', payDate: '2026-10-16' });
    expect(payPeriodFor('2026-09-01', biweekly).from).toBe('2026-08-29'); // before the anchor too
    expect(payPeriodFor('2026-02-20', { frequency: 'semimonthly', anchorStart: '2026-01-01', payDayOffsetDays: 5 })).toEqual({ from: '2026-02-16', to: '2026-02-28', payDate: '2026-03-05' });
    expect(payPeriodFor('2026-01-10', { frequency: 'semimonthly', anchorStart: '2026-01-01', payDayOffsetDays: 0 }, -1)).toEqual({ from: '2025-12-16', to: '2025-12-31', payDate: '2025-12-31' });
  });

  it('My Commission shows the stylist’s hours worked, and everyone gets the pay schedule', async () => {
    const jen = await signIn('jennifer@addendumsalon.com');
    const me = (await jen.get(`/api/commission/me?from=${daysAgo(13)}&to=${daysAgo(7)}`)).body;
    expect(me.pay.squareMinutes).toBeGreaterThan(0);
    expect(me.taxes.grossCents).toBe(me.summary.totalCommissionCents + me.summary.tipsCents + me.pay.wagesCents);
    // Year: one line per pay period paid that year, adding up to the period figures.
    const year = (await jen.get('/api/commission/me/year?year=2026')).body.rows;
    expect(year[0].payDate >= '2026-01-01' && year.at(-1).payDate <= '2026-12-31').toBe(true);
    expect(year.find((r: any) => r.from === '2026-09-26')).toMatchObject({ to: '2026-10-09', payDate: '2026-10-16' });
    expect(year.length).toBe(26);
    const p = year.find((r: any) => r.from === '2026-09-26');
    const direct = (await jen.get('/api/commission/me?from=2026-09-26&to=2026-10-09')).body;
    expect([p.minutes, p.commissionCents, p.netCents]).toEqual([direct.pay.minutes, direct.summary.totalCommissionCents, direct.taxes.netCents]);
    expect((await jen.get('/api/commission/status')).body.status.paySchedule).toEqual(biweekly);
  });
});

describe('Payroll hours by week', () => {
  it('someone set to "By week" gets one weekly total; it counts, and never goes to Square or gets replaced by a day', async () => {
    const monday = (() => { const d = new Date(`${today()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7); return d.toISOString().slice(0, 10); })();
    const sunday = new Date(new Date(`${monday}T12:00:00Z`).getTime() + 6 * 86400_000).toISOString().slice(0, 10);
    await db().query('DELETE FROM staff_hours WHERE staff_id = $1 AND work_date BETWEEN $2::date AND $3::date', [michaelId, monday, sunday]);
    expect((await admin.put('/api/commission/timesheet/mode', { staffId: michaelId, mode: 'week' })).status).toBe(200);
    expect((await admin.put('/api/commission/timesheet/week', { staffId: michaelId, weekStart: monday, hours: 38.5 })).status).toBe(200);
    let row = (await admin.get(`/api/commission/timesheet?from=${monday}&to=${sunday}`)).body.rows.find((r: any) => r.staffId === michaelId);
    expect(row).toMatchObject({ mode: 'week', weekTotal: 2310 });
    expect(row.pay.minutes).toBe(2310);
    expect(row.manual[monday]).toBeUndefined(); // not a day's hand entry
    // A day's timesheet number adds to it rather than replacing it; "Send hours to Square" skips it.
    await admin.put('/api/commission/timesheet', { staffId: michaelId, date: monday, hours: 2 });
    row = (await admin.get(`/api/commission/timesheet?from=${monday}&to=${sunday}`)).body.rows.find((r: any) => r.staffId === michaelId);
    expect(row.pay.minutes).toBe(2310 + 120);
    await admin.put('/api/commission/timesheet', { staffId: michaelId, date: monday, hours: null });
    const sent = await admin.post('/api/commission/timesheet/to-square', { from: monday, to: sunday, staffId: michaelId });
    expect(sent.body.sent).toBe(0);
    // Replaced, then cleared.
    await admin.put('/api/commission/timesheet/week', { staffId: michaelId, weekStart: monday, hours: 40 });
    expect((await admin.get(`/api/commission/timesheet?from=${monday}&to=${sunday}`)).body.rows.find((r: any) => r.staffId === michaelId).weekTotal).toBe(2400);
    await admin.put('/api/commission/timesheet/week', { staffId: michaelId, weekStart: monday, hours: null });
    await admin.put('/api/commission/timesheet/mode', { staffId: michaelId, mode: 'day' });
  });
});

describe('Time clock and Square timecards for the same day', () => {
  it('“Fix doubled hours in Square” keeps the latest timecard when Square has overlapping ones for a day', async () => {
    const day = daysAgo(9);
    const tm = (await db().one<any>('SELECT square_team_member_id FROM staff WHERE id = $1', [michaelId])).square_team_member_id;
    const sq = new MockSquareService();
    const at = (h: number) => new Date(`${day}T${String(h).padStart(2, '0')}:00:00Z`);
    await sq.createTimecard({ teamMemberId: tm, locationId: 'L', startAt: at(17), endAt: at(23) }, `dup-a-${day}`);
    await sq.createTimecard({ teamMemberId: tm, locationId: 'L', startAt: at(17), endAt: at(23) }, `dup-b-${day}`);
    await sync();
    const total = async () => (await db().one<any>(`SELECT sum(minutes)::int AS m FROM staff_hours WHERE staff_id = $1 AND work_date = $2::date`, [michaelId, day])).m;
    expect(await total()).toBe(720); // doubled
    const r = await admin.post('/api/timeclock/shifts/fix-doubles', { from: daysAgo(13), to: today(), staffId: michaelId });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ days: 1, removed: 1, failed: [] });
    expect(await total()).toBe(360);
    // Hours typed in for the day replace Square's timecard; nothing is added on top.
    await admin.put('/api/commission/timesheet', { staffId: michaelId, date: day, hours: 2 });
    await admin.put('/api/commission/timesheet', { staffId: michaelId, date: day, hours: null });
    expect(await total()).toBe(120);
  });

  it('the latest time clock change replaces Square’s timecards for that day, so hours are never doubled', async () => {
    await sync(); // brings in Square timecards
    const day = (await db().one<any>(`SELECT to_char(work_date, 'YYYY-MM-DD') AS d FROM staff_hours WHERE staff_id = $1 AND source = 'square' AND note IS NULL ORDER BY work_date DESC LIMIT 1`, [michaelId])).d;
    const total = async () => (await db().one<any>(`SELECT sum(minutes)::int AS m FROM staff_hours WHERE staff_id = $1 AND work_date = $2::date`, [michaelId, day])).m;
    const at = (h: number) => new Date(`${day}T${String(h).padStart(2, '0')}:00:00`).toISOString();
    const r = await admin.post('/api/timeclock/shifts', { staffId: michaelId, clockInAt: at(9), clockOutAt: at(17), breaks: [] });
    expect(r.status).toBe(201);
    expect(r.body.shift).toMatchObject({ usesSquareHours: false, squareSent: true });
    expect(await total()).toBe(480);
    // Edited: only the latest times count, in the CRM and in Square — even after the next sync.
    const e = await admin.put(`/api/timeclock/shifts/${r.body.shift.id}`, { clockInAt: at(10), clockOutAt: at(16), breaks: [] });
    expect(e.status).toBe(200);
    expect(await total()).toBe(360);
    await sync();
    expect(await total()).toBe(360);
    await admin.del(`/api/timeclock/shifts/${r.body.shift.id}`);
  });
});
