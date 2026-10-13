import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { pickRule, rebuildCommission, syncCommission, tieredCommission } from '../src/domain/commission.js';
import { localDate } from '../src/domain/rebookingSchedule.js';
import { setIntegrationOverride } from '../src/integrations/registry.js';
import { demoExtraOrders, MockSquareService } from '../src/integrations/square/MockSquareService.js';
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

async function signIn(email: string) {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email, password: 'addendum-demo' })).status).toBe(200);
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
