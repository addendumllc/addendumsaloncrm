import { beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db/index.js';
import { setup } from './helpers.js';

// The Reorder List reads To order's forecast; here it's given chosen numbers for real products, so purchase orders are
// created through the real purchase order code.
let fake: any[] | null = null;
vi.mock('../src/domain/stock.js', async (orig) => {
  const m: any = await orig();
  return { ...m, stockForecast: async () => (fake ? { items: fake, settings: {}, salesFrom: {} } : m.stockForecast()) };
});
const { applyRules, quantityProblem, reorderList, saveAmountRules, DEFAULT_AMOUNTS, ROUND_TO } = await import('../src/domain/reorderList.js');
const { stockRows } = await import('../src/domain/stock.js');

let api: Awaited<ReturnType<typeof setup>>['api'];
const item = (key: string, o: object) => ({
  key, label: 'Product', sku: null, supplier: 'Hair Co', collections: [], collection: null, stock: 10, incoming: 0, ratePerDay: 0.5, units7: 3, units30: 15, units90: 45,
  leadTimeDays: 35, productionDays: 30, shippingDays: 5, leadSource: { kind: 'product', label: null }, leadUntracked: false, stockoutRisk: false, skippedUntil: null, safetyDays: 0,
  daysOfStock: 20, orderBy: null, status: 'soon', suggestedQty: 0, moq: null, caseSize: null, costCents: 5000, moqCostCents: null, moqArrivesOn: null, moqLastsDays: null,
  slowToUse: false, why: [], stores: { salon: false, online: true }, sellOutOn: null, preorders: 0, ...o,
});
let K: string[] = [];
beforeAll(async () => {
  ({ api } = await setup());
  K = (await stockRows()).map((r) => r.key).slice(0, 12);
  fake = [
    item(K[0], { label: '18" Redefined Weft · Aperol', stock: 0, moq: 12 }), // out
    item(K[1], { label: '22" Signature Weft · Ash', stock: 3, ratePerDay: 0.05 }), // below 5, slow
    item(K[2], { label: '18" Redefined Weft · Honey', stock: 8, ratePerDay: 1 }), // 8 days left despite ≥ 5 → shown
    item(K[3], { label: '22" Redefined Weft · Mocha', stock: 40, ratePerDay: 0.5 }), // healthy → hidden
    item(K[4], { label: 'K-Tip Extensions · 20" Platinum', stock: 4, ratePerDay: 0.5, productionDays: 60, shippingDays: 5 }), // long lead
    item(K[5], { label: 'K-Tip Extensions · 22" Black', stock: 0, ratePerDay: 0.2, productionDays: 60, caseSize: 10 }), // out, case 10
    item(K[6], { label: '18" Weft · Covered', stock: 2, incoming: 40, ratePerDay: 0.5 }), // covered by incoming
    item(K[7], { label: 'Clip-In Set', stock: 0 }), // not a weft or K-tip
    item(K[8], { label: '18" Weft · Pre-ordered', stock: 0, preorders: 3, ratePerDay: 0.3 }),
    item(K[9], { label: '22" Weft · Salon only', stock: 0, stores: { salon: true, online: false } }), // Addendum Salon, not Hair
  ];
});

describe('Reorder List', () => {
  it('minimums and cases: need 6 · MOQ 12 → 12; need 13 · case 10 → 20; flags quantities that break the rules', () => {
    expect(applyRules(6, 12, null)).toEqual({ qty: 12, steps: ['MOQ 12'] });
    expect(applyRules(13, null, 10)).toEqual({ qty: 20, steps: ['Case size 10'] });
    expect(applyRules(0, 12, 10).qty).toBe(0); // nothing needed → nothing forced
    expect(quantityProblem(6, 12, null)).toEqual({ message: 'Below the minimum order of 12', suggest: 12 });
    expect(quantityProblem(15, 12, 10)).toEqual({ message: 'Not a full case of 10', suggest: 20 });
    expect(quantityProblem(20, 12, 10)).toBeNull();
  });

  it('shows only what needs attention (out, under 5, or selling out within 14 days), wefts first then K-tips', async () => {
    const r = await reorderList('30');
    const labels = r.items.map((i) => i.label);
    expect(labels).not.toContain('22" Redefined Weft · Mocha');
    expect(labels).toContain('Clip-In Set'); // clip-ins and tapes are on the list too
    expect(labels).not.toContain('22" Weft · Salon only');
    expect(labels).toContain('18" Redefined Weft · Honey'); // 8 days of stock with 8 units
    expect(labels).toContain('22" Signature Weft · Ash');
    // Lisa's sections in her order: Redefined Wefts, other wefts, K-Tips, then Clip-Ins (the length is by each name).
    const order = r.items.map((i) => i.group);
    expect(order.indexOf('Redefined Wefts')).toBe(0);
    expect(order.lastIndexOf('K-Tips')).toBeLessThan(order.indexOf('Clip-Ins'));
    // In a section: by length (18", 22", 24"), then colour.
    const rw = r.items.filter((i) => i.group === 'Redefined Wefts').map((i) => Number.parseInt(i.length ?? '999', 10));
    expect(rw).toEqual([...rw].sort((a, b) => a - b));
    expect(r.items.find((i) => i.label.includes('Aperol'))!.shade).toBe('Aperol');
    expect(r.items.find((i) => i.label.includes('Platinum'))!.group).toBe('K-Tips');
    // Suggested from sales beside the usual amount: covers the lead time + 30 days, in full cases.
    const black = r.items.find((i) => i.label.includes('22" Black'))!;
    expect(black.forecastQty).toBeGreaterThanOrEqual(Math.ceil(0.2 * (black.leadDays + 30)));
    expect(black.forecastQty % 10).toBe(0);
    // Out of stock first in each section.
    expect(r.items[0].badges).toContain('OUT OF STOCK');
    const kt = r.items.filter((i) => i.type === 'ktip');
    expect(kt.map((i) => i.label.match(/(\d+)"/)?.[1])).toEqual(['20', '22']); // by length
    // Long-lead K-tips are urgent even at the end of the list.
    const plat = kt.find((i) => i.label.includes('Platinum'))!;
    expect(plat.badges).toEqual(expect.arrayContaining(['ORDER NOW', 'LONG PRODUCTION LEAD']));
    expect(plat.warning).toMatch(/65 days to arrive/);
    expect(r.urgentKtips).toContain(plat.key);
    // An out-of-stock item says a new order can't prevent the stock-out.
    expect(r.items[0].warning).toMatch(/can’t prevent this stock-out/);
    // Missing settings are flagged, not invented.
    expect(r.items.find((i) => i.label.includes('Ash'))!.flags).toContain('No minimum order recorded');
  });

  it('order amounts: tapes always 17, K-Tips always 40, 24" Redefined at least 20; others round to 5s; no blank 0s', async () => {
    expect(DEFAULT_AMOUNTS).toMatchObject({ Tapes: { fixed: 17 }, 'K-Tips': { fixed: 40 }, 'Redefined Wefts 24"': { min: 20 } });
    const saved = fake;
    fake = [
      item(K[0], { label: '22" Tape-Ins · Honey', stock: 0, ratePerDay: 2 }),
      item(K[1], { label: 'K-Tip Extensions · 18" Black', stock: 1, ratePerDay: 0.1 }),
      item(K[2], { label: '24" Redefined Weft · Aperol', stock: 1, ratePerDay: 0.05 }),
      item(K[3], { label: '18" Redefined Weft · Honey', stock: 0, ratePerDay: 0.43 }),
      item(K[4], { label: '18" Redefined Weft · Covered', stock: 2, incoming: 400, ratePerDay: 0.01, moq: 10 }),
    ];
    const r = await reorderList('normal');
    const q = (label: string) => r.items.find((i) => i.label.includes(label))!;
    expect([q('Tape-Ins').suggestedQty, q('Tape-Ins').forecastQty]).toEqual([17, 17]);
    expect([q('K-Tip').suggestedQty, q('K-Tip').forecastQty]).toEqual([40, 40]);
    expect(q('24"').suggestedQty).toBeGreaterThanOrEqual(20);
    expect(q('24"').moq).toBe(20);
    for (const i of r.items.filter((x) => !['tape', 'ktip'].includes(x.type))) {
      expect(i.suggestedQty % ROUND_TO).toBe(0);
      expect(i.forecastQty % ROUND_TO).toBe(0);
      expect(i.suggestedQty).toBeGreaterThan(0); // never a blank 0 — at least the minimum
    }
    expect(r.items.find((i) => i.label.includes('Covered'))).toBeUndefined(); // covered by what's on order → doesn't need buying
    // Labelled: set amounts, the minimum, or Suggested when sales need more than the minimum.
    expect([q('Tape-Ins').forecastKind, q('K-Tip').forecastKind]).toEqual(['set', 'set']);
    const aperol = q('24"');
    expect(aperol.forecastKind).toBe(aperol.forecastQty > 20 ? 'suggested' : 'minimum');
    expect(q('18" Redefined Weft · Honey').forecastKind).toBe('suggested'); // no minimum, sales need it
    fake = saved;
  });

  it('each plan recalculates: coverage subtracts stock and incoming, then MOQ and cases', async () => {
    await saveAmountRules({});
    const at = async (plan: any, label: string) => (await reorderList(plan)).items.find((i) => i.label.includes(label))!;
    // 30 days × 0.5 = 15 → MOQ 12 doesn't change it.
    expect((await at('30', 'Aperol')).suggestedQty).toBe(15);
    expect((await at('60', 'Aperol')).suggestedQty).toBe(30);
    expect((await at('90', 'Aperol')).suggestedQty).toBe(45);
    // K-tip black: 30 × 0.2 = 6 → case of 10 → 10; 90 days = 18 → 20.
    const b30 = await at('30', 'Black');
    expect([b30.suggestedQty, b30.explain]).toEqual([10, 'Need 6 · Case size 10 · Order 10']);
    expect((await at('90', 'Black')).suggestedQty).toBe(20);
    // Honey: 30 days = 30, minus 8 available = 22 → rounded up to 25 (no odd amounts).
    expect((await at('30', 'Honey')).explain).toBe('Need 30 · Available 8 · Net need 22 · Rounded to 5s · Order 25');
    // Covered by incoming (2 here + 40 on order): doesn't need buying, so it isn't on the list.
    expect((await reorderList('30')).items.some((i) => i.label.includes('Covered'))).toBe(false);
    // Pre-orders owed are added on top.
    expect((await at('30', 'Pre-ordered')).calculatedNeed).toBe(9 + 3);
  });

  it('Normal Order uses the typical quantity, else past orders, else a labelled calculation', async () => {
    const plain = (await reorderList('normal')).items.find((i) => i.label.includes('Honey'))!;
    expect(plain.planNote).toMatch(/Calculated/);
    // Past orders of 20 and 30 → usual 20.
    for (const q of [20, 30]) {
      const [p] = await db().query<{ id: string }>("INSERT INTO purchase_orders(supplier, status, store, ordered_at) VALUES ('Hair Co','received','shopify', now()) RETURNING id");
      await db().query('INSERT INTO purchase_order_lines(po_id, product_key, label, quantity, received) VALUES ($1,$2,$3,$4,$4)', [p.id, K[2], 'Honey', q]);
    }
    const hist = (await reorderList('normal')).items.find((i) => i.label.includes('Honey'))!;
    expect([hist.suggestedQty, hist.planNote]).toEqual([20, 'Usual from 2 past orders']);
    // Lisa's own typical quantity wins; a preferred plan applies under Normal Order.
    expect((await api.put('/api/inventory-sync/reorder-list/prefs', { key: K[2], typicalQty: 25, preferredPlan: null, safetyUnits: null, notes: 'Ask for the new dye lot' })).status).toBe(200);
    expect((await reorderList('normal')).items.find((i) => i.label.includes('Honey'))!.suggestedQty).toBe(25);
    await api.put('/api/inventory-sync/reorder-list/prefs', { key: K[0], typicalQty: null, preferredPlan: '60', safetyUnits: 2, notes: null });
    const ap = (await reorderList('normal')).items.find((i) => i.label.includes('Aperol'))!;
    expect([ap.plan, ap.suggestedQty]).toEqual(['60', 35]); // 30 + 2 safety = 32 → 35
  });

  it('reviews before ordering, then creates one draft purchase order per supplier (only valid lines; nothing sent)', async () => {
    await api.post('/api/inventory-sync/stock/suppliers', { name: 'Hair Co', minOrderUnits: 100 });
    await api.post('/api/inventory-sync/stock/suppliers', { name: 'Tip Co' });
    fake = fake!.map((x) => (x.label.includes('K-Tip') ? { ...x, supplier: 'Tip Co' } : x));
    const lines = [{ key: K[0], qty: 6 }, { key: K[2], qty: 22 }, { key: K[5], qty: 15 }, { key: K[4], qty: 0 }];
    const rev = (await api.post('/api/inventory-sync/reorder-list/review', { plan: '30', lines })).body;
    expect(rev.problems).toEqual([
      expect.objectContaining({ key: K[0], message: 'Below the minimum order of 12', suggest: 12 }),
      expect.objectContaining({ key: K[5], message: 'Not a full case of 10', suggest: 20 }),
    ]);
    const hair = rev.suppliers.find((s: any) => s.supplier === 'Hair Co');
    expect(hair.warnings[0]).toMatch(/minimum of 100 units/);
    expect(hair.estCents).toBe((6 + 22) * 5000);
    // Valid lines go ahead; the others are reported, not silently changed.
    const made = await api.post('/api/inventory-sync/reorder-list/purchase-orders', { plan: '30', lines });
    expect(made.status).toBe(201);
    expect(made.body.orders).toHaveLength(1);
    expect(made.body.orders[0]).toMatchObject({ supplier: 'Hair Co', status: 'draft', store: 'shopify', name: 'Easy Reorder List · 30-day coverage' });
    expect(made.body.orders[0].lines.map((l: any) => [l.productKey, l.quantity])).toEqual([[K[2], 22]]);
    expect(made.body.skipped).toHaveLength(2);
    // Fixed quantities: both suppliers get their own draft.
    const fixed = await api.post('/api/inventory-sync/reorder-list/purchase-orders', { plan: '30', lines: [{ key: K[0], qty: 12 }, { key: K[5], qty: 20 }] });
    expect(fixed.body.orders.map((o: any) => o.supplier).sort()).toEqual(['Hair Co', 'Tip Co']);
    expect(fixed.body.orders.every((o: any) => o.status === 'draft')).toBe(true);
  });

  it('order amounts can be changed (and are kept), and the list uses them', async () => {
    const res = await api.put('/api/inventory-sync/reorder-list/amounts', { rules: { 'K-Tips': { fixed: 30, min: null }, 'Redefined Wefts 18"': { fixed: null, min: null } } });
    expect(res.status).toBe(200);
    expect(res.body.rules).toEqual({ 'K-Tips': { fixed: 30, min: null } }); // empty ones dropped
    expect((await api.get('/api/inventory-sync/reorder-list?plan=normal')).body.amounts).toEqual({ 'K-Tips': { fixed: 30, min: null } });
    expect((await reorderList('normal')).items.filter((i) => i.type === 'ktip').every((i) => i.suggestedQty === 30)).toBe(true);
    await saveAmountRules({});
  });

  it('a product’s own amount (Suggested each time) is used exactly, over the section’s amounts', async () => {
    await saveAmountRules({ 'Redefined Wefts': { fixed: null, min: 10 } });
    await api.put('/api/inventory-sync/reorder-list/prefs', { key: K[2], typicalQty: 20, preferredPlan: null, safetyUnits: null, notes: null });
    const honey = (await reorderList('normal')).items.find((i) => i.label.includes('Honey'))!;
    expect([honey.typicalQty, honey.forecastQty, honey.suggestedQty]).toEqual([20, 20, 20]);
    expect(honey.explain).toMatch(/Set to 20 each time/);
    // Suggested is never 0 — covered by what's on order still shows the smallest order.
    expect((await reorderList('normal')).items.every((i) => i.forecastQty > 0)).toBe(true);
    await api.put('/api/inventory-sync/reorder-list/prefs', { key: K[2], typicalQty: null, preferredPlan: null, safetyUnits: null, notes: null });
    await saveAmountRules({});
  });

  it('approves products to order: the approved list, the dashboard summary, and ordered ones come off', async () => {
    const all = (await api.get('/api/inventory-sync/reorder-list?plan=normal')).body.items;
    const res = await api.put('/api/inventory-sync/reorder-list/approved', { plan: 'normal', lines: [{ key: K[2], qty: 20 }, { key: K[0], qty: 0 }] });
    expect(res.status).toBe(200);
    expect(res.body.approved).toMatchObject({ plan: 'normal', lines: [{ key: K[2], qty: 20 }], approvedBy: 'Lisa Ha' }); // 0s aren't approved
    expect((await api.get('/api/inventory-sync/reorder-list?plan=normal')).body.approved.lines).toEqual([{ key: K[2], qty: 20 }]);
    const sum = (await api.get('/api/inventory-sync/reorder-list/summary')).body;
    expect(sum).toMatchObject({ approved: 1, units: 20, approvedBy: 'Lisa Ha', notApproved: all.length - 1 });
    // Creating the order takes it off the approved list.
    expect((await api.post('/api/inventory-sync/reorder-list/purchase-orders', { plan: 'normal', lines: [{ key: K[2], qty: 20 }] })).status).toBe(201);
    expect((await api.get('/api/inventory-sync/reorder-list?plan=normal')).body.approved.lines).toEqual([]);
  });

  it('only people with Approve the Easy Reorder List can approve', async () => {
    // Front desk with the Easy Reorder List (inventory sync) but not approval: sees the approved list, can't approve.
    const deskId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
    await api.put(`/api/admin/users/${deskId}/access`, { overrides: { 'inventory:sync': true }, confirm: true });
    const request = (await import('supertest')).default;
    const { createApp } = await import('../src/app.js');
    const desk = request.agent(createApp()).set('X-Requested-With', 'addendum-crm');
    await desk.post('/api/auth/login').send({ email: 'frontdesk@addendumsalon.com', password: 'addendum-demo' });
    expect((await desk.get('/api/inventory-sync/reorder-list/summary')).status).toBe(200);
    expect((await desk.put('/api/inventory-sync/reorder-list/approved').send({ plan: 'normal', lines: [] })).status).toBe(403);
    expect((await desk.delete('/api/inventory-sync/reorder-list/approved')).status).toBe(403);
    await api.put(`/api/admin/users/${deskId}/access`, { overrides: { 'inventory:sync': null } });
  });

  it('saves the list to come back to', async () => {
    await api.put('/api/inventory-sync/reorder-list/saved', { plan: '60', lines: [{ key: K[0], include: true, qty: 30 }] });
    const r = (await api.get('/api/inventory-sync/reorder-list?plan=60')).body;
    expect(r.saved).toMatchObject({ plan: '60', lines: [{ key: K[0], include: true, qty: 30 }], savedBy: 'Lisa Ha' });
  });

  it('is only for people with inventory access', async () => {
    const request = (await import('supertest')).default;
    const { createApp } = await import('../src/app.js');
    const a = request.agent(createApp());
    await a.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'jennifer@addendumsalon.com', password: 'addendum-demo' });
    expect((await a.get('/api/inventory-sync/reorder-list')).status).toBe(403);
  });
});
