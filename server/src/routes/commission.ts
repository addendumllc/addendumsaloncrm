import { Router } from 'express';
import { payPeriodFor, type CommissionSummaryDTO, type PayPeriodRowDTO, type PaySummaryDTO } from '@addendum/shared';
import { z } from 'zod';
import { can } from '../auth/permissions.js';
import { requireAnyPermission, requirePermission } from '../auth/session.js';
import { db } from '../db/index.js';
import {
  acceptEntry,
  addAdjustment,
  attributeEntry,
  attributeEntries,
  reviewRange,
  commissionStatus,
  createRule,
  deleteRule,
  endRule,
  entriesCsv,
  entryHistory,
  finalizePeriod,
  listEntries,
  listPeriods,
  listRules,
  rebuildCommission,
  reviewQueue,
  summarize,
  syncCommission,
  updateRule,
} from '../domain/commission.js';
import { newClientStats } from '../domain/newClients.js';
import { addManualHours, addRate, clearHours, sendDayToSquare, updateDayInSquare, setTimesheetMode, setWeekTotal, deleteManualHours, deleteRate, estimateTaxes, getPay, updateRate, listHours, paySummaries, setTimesheetDay, setPay, taxDetails, timesheet } from '../domain/wages.js';
import { localDate } from '../domain/rebookingSchedule.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { squareService } from '../integrations/registry.js';
import { requirePayUnlock } from '../auth/reauth.js';
import { getSettings, updateSettings } from '../repos/settings.js';
import { ah, logAction, parse } from './util.js';

/**
 * Commission. Privacy is enforced here on the server:
 *  - /me only ever returns the signed-in person's own records (the id comes from the session, never the request).
 *  - Anyone else's numbers need commission:team; changes need commission:manage / commission:approve; CSV needs commission:export.
 */
export const commissionRouter = Router();

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)').refine((s) => !Number.isNaN(Date.parse(s)), 'must be a valid date');
/** A percentage in basis points (1200 = 12%). */
const bps = z.number().int().min(0).max(10000);
const range = z.object({ from: ymd, to: ymd }).refine((r) => r.from <= r.to, 'the start date must be before the end date')
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86400_000 <= 400, 'choose a range of 400 days or less');

const seesTeam = (req: any) => can(req.user, 'commission:team');

commissionRouter.get('/status', ah(async (req, res) => {
  const st = await commissionStatus();
  // Team-level details (who isn't linked, sync messages) are for people who manage commission.
  if (!can(req.user, 'commission:manage') && !can(req.user, 'commission:approve') && !seesTeam(req)) {
    return res.json({ status: { enabled: st.enabled, squareConnected: st.squareConnected, lastSuccessfulSyncAt: st.lastSuccessfulSyncAt, lastRun: null, needsReview: 0, unlinkedTeamMembers: [], missing: [], disclaimer: st.disclaimer, hoursSyncError: null, paySchedule: st.paySchedule } });
  }
  res.json({ status: st });
}));

// ---------- My Commission ----------
/** On someone's own page: their hours worked, not the split between time with clients and hourly time (admins only). */
function asTheySee<T extends { pay: PaySummaryDTO | null }>(pt: T): T {
  return pt.pay ? { ...pt, pay: { ...pt.pay, servicingMinutes: undefined, basis: pt.pay.basis.replace(/ \([\d.]+ hours with clients paid as commission\)/g, '') } } : pt;
}
const COMMISSION_ONLY = { pay: null, taxes: null, commissionOnly: true } as const;
/** Year view as the person sees it: commission and tips only ("Show only commission"), else everything (tax-by-tax if turned on for them). */
async function yearAsTheySee(staffId: string, year: number) {
  const rows = await yearByPayPeriod(staffId, year);
  if (await commissionOnly(staffId)) return { commissionOnly: true, showTaxBreakdown: false, rows: rows.map((r) => ({ from: r.from, to: r.to, payDate: r.payDate, commissionCents: r.commissionCents, tipsCents: r.tipsCents })) };
  return { rows, showTaxBreakdown: (await taxDetails([staffId])).get(staffId)?.showBreakdown ?? true };
}
const commissionOnly = async (staffId: string) => (await db().one<{ c: boolean }>('SELECT commission_only_view AS c FROM staff WHERE id = $1', [staffId]))?.c === true;

/** Wages and estimated taxes for one person over a range, given their commission records for it. */
async function payAndTaxes(staffId: string, from: string, to: string, summary: CommissionSummaryDTO) {
  const pay = (await paySummaries([staffId], from, to)).get(staffId) ?? null;
  if (!pay) return { pay: null, taxes: null };
  const taxes = estimateTaxes(summary.totalCommissionCents + summary.tipsCents + pay.wagesCents, (await taxDetails([staffId])).get(staffId)!, (await getSettings()).commission.payrollTaxes);
  return { pay, taxes };
}

/** One row per pay period paid in `year`: hours, commission, tips, wages and estimated taxes. */
async function yearByPayPeriod(staffId: string, year: number): Promise<PayPeriodRowDTO[]> {
  const settings = (await getSettings()).commission;
  const periods: { from: string; to: string; payDate: string }[] = [];
  for (let p = payPeriodFor(`${year}-01-01`, settings.paySchedule, -1); p.payDate <= `${year}-12-31`; p = payPeriodFor(p.from, settings.paySchedule, 1)) {
    if (p.payDate >= `${year}-01-01`) periods.push(p);
  }
  if (!periods.length) return [];
  const entries = await listEntries({ staffId, from: periods[0].from, to: periods[periods.length - 1].to });
  const tax = (await taxDetails([staffId])).get(staffId)!;
  const rows: PayPeriodRowDTO[] = [];
  for (const p of periods) {
    const m = summarize(entries.filter((e) => e.postedDate >= p.from && e.postedDate <= p.to), p.from, p.to, staffId);
    const w = (await paySummaries([staffId], p.from, p.to)).get(staffId)!;
    const t = estimateTaxes(m.totalCommissionCents + m.tipsCents + w.wagesCents, tax, settings.payrollTaxes);
    rows.push({
      ...p, minutes: w.minutes, commissionCents: m.totalCommissionCents, tipsCents: m.tipsCents, wagesCents: w.wagesCents, grossCents: t.grossCents, withheldCents: t.withheldCents, netCents: t.netCents,
      federalCents: t.federalCents, socialSecurityCents: t.socialSecurityCents, medicareCents: t.medicareCents, stateCents: t.stateCents, sdiCents: t.sdiCents, localCents: t.localCents,
    });
  }
  return rows;
}
const yearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100) });

commissionRouter.get('/me/year', requirePermission('commission:own'), requirePayUnlock, ah(async (req, res) => {
  const { year } = parse(yearQuery, req.query);
  res.json(await yearAsTheySee(req.user!.id, year));
}));

commissionRouter.get('/staff/:id/year', requirePermission('commission:team'), requirePayUnlock, ah(async (req, res) => {
  const { year } = parse(yearQuery, req.query);
  if (!(await db().one('SELECT 1 FROM staff WHERE id = $1', [req.params.id]))) throw notFound('That team member');
  await logAction(req, 'commission.staff_year_view', 'staff', req.params.id, { year });
  // ?as=them: exactly what the person sees on their own Earnings page.
  if (req.query.as === 'them') return res.json(await yearAsTheySee(req.params.id, year));
  res.json({ rows: await yearByPayPeriod(req.params.id, year), showTaxBreakdown: true });
}));

commissionRouter.get('/me', requirePermission('commission:own'), requirePayUnlock, ah(async (req, res) => {
  const r = parse(range, req.query);
  const me = await db().one<any>('SELECT square_team_member_id FROM staff WHERE id = $1', [req.user!.id]);
  const entries = await listEntries({ staffId: req.user!.id, ...r });
  // Their own hours, estimated wages and estimated taxes.
  const summary = summarize(entries, r.from, r.to, req.user!.id);
  // "Show only commission": no hours, wages, taxes or net on their own page (admins still see them).
  if (await commissionOnly(req.user!.id)) return res.json({ summary, entries, squareLinked: !!me?.square_team_member_id, ...COMMISSION_ONLY });
  const pt = await payAndTaxes(req.user!.id, r.from, r.to, summary);
  res.json({ summary, entries, squareLinked: !!me?.square_team_member_id, ...(can(req.user, 'commission:manage') ? pt : asTheySee(pt)) });
}));

// New clients for My Commission: two counts, always for the signed-in person (no client names or details).
commissionRouter.get('/me/new-clients', requirePermission('commission:own'), ah(async (req, res) => {
  const r = parse(range, req.query);
  const { summary } = await newClientStats({ ...r, staffId: req.user!.id });
  res.json({ newClients: summary.newClients, rebookedFuture: summary.withFuture });
}));

// ---------- Team ----------
commissionRouter.get('/team', requirePermission('commission:team'), requirePayUnlock, ah(async (req, res) => {
  const r = parse(range, req.query);
  const entries = await listEntries({ staffId: 'all', ...r });
  const staff = await db().query<any>('SELECT id, name, active, square_team_member_id, tip_eligible FROM staff ORDER BY active DESC, name');
  const pay = await paySummaries(staff.map((s) => s.id), r.from, r.to);
  const tax = await taxDetails(staff.map((s) => s.id));
  const rates = (await getSettings()).commission.payrollTaxes;
  const rows = staff.map((s) => {
    const m = summarize(entries.filter((e) => e.staffId === s.id), r.from, r.to, s.id);
    const p = pay.get(s.id)!;
    return {
      ...m, staffName: s.name, squareLinked: !!s.square_team_member_id, active: s.active, pay: p, tipEligible: s.tip_eligible,
      taxes: estimateTaxes(m.totalCommissionCents + m.tipsCents + p.wagesCents, tax.get(s.id)!, rates),
    };
  }).filter((x) => x.entries > 0 || (x.active && x.squareLinked) || x.pay.minutes > 0 || x.pay.wagesCents > 0);
  const unassigned = entries.filter((e) => !e.staffId);
  await logAction(req, 'commission.team_view', 'commission', null, r);
  res.json({ rows, total: summarize(entries.filter((e) => e.staffId), r.from, r.to, null), unassigned: unassigned.length });
}));

commissionRouter.get('/staff/:id', requireAnyPermission('commission:own', 'commission:team'), requirePayUnlock, ah(async (req, res) => {
  const r = parse(range, req.query);
  // Your own page, or anyone's with team access. Otherwise it doesn't exist as far as you can tell.
  if (req.params.id !== req.user!.id && !seesTeam(req)) throw notFound('That page');
  const s = await db().one<any>('SELECT id, name, square_team_member_id FROM staff WHERE id = $1', [req.params.id]);
  if (!s) throw notFound('That team member');
  const entries = await listEntries({ staffId: s.id, ...r });
  if (req.params.id !== req.user!.id) await logAction(req, 'commission.staff_view', 'staff', s.id, r);
  // Wages are for people who see the team's pay.
  const summary = summarize(entries, r.from, r.to, s.id);
  const staff = { id: s.id, name: s.name, squareLinked: !!s.square_team_member_id };
  // ?as=them (people who see the team): exactly what the person sees on their own Earnings page.
  if (req.query.as === 'them' && req.params.id !== req.user!.id) {
    if (await commissionOnly(s.id)) return res.json({ staff, summary, entries, ...COMMISSION_ONLY });
    return res.json({ staff, summary, entries, ...asTheySee(await payAndTaxes(s.id, r.from, r.to, summary)) });
  }
  res.json({ staff, summary, entries, ...(await payAndTaxes(s.id, r.from, r.to, summary)) });
}));

commissionRouter.get('/entries/:id/history', requireAnyPermission('commission:own', 'commission:team'), ah(async (req, res) => {
  const e = await db().one<any>('SELECT staff_id FROM commission_entries WHERE id = $1', [req.params.id]);
  if (!e || (e.staff_id !== req.user!.id && !seesTeam(req) && !can(req.user, 'commission:approve'))) throw notFound('That record');
  res.json({ history: await entryHistory(req.params.id) });
}));

commissionRouter.get('/export', requirePermission('commission:export'), requirePayUnlock, ah(async (req, res) => {
  const r = parse(range.and(z.object({ staffId: z.string().uuid().optional() })), req.query);
  const entries = await listEntries({ staffId: r.staffId ?? 'all', from: r.from, to: r.to });
  await logAction(req, 'commission.export', 'commission', r.staffId ?? null, { from: r.from, to: r.to, rows: entries.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="commission-${r.from}-to-${r.to}.csv"`);
  res.send(entriesCsv(entries));
}));

/** One row per person: service and retail commission apart, tips, hours, wages and total pay — for payroll. */
commissionRouter.get('/export/summary', requirePermission('commission:export'), requirePayUnlock, ah(async (req, res) => {
  const r = parse(range, req.query);
  const entries = await listEntries({ staffId: 'all', ...r });
  const staff = await db().query<any>('SELECT id, name, active, tip_eligible FROM staff ORDER BY name');
  const pay = await paySummaries(staff.map((s) => s.id), r.from, r.to);
  const tax = await taxDetails(staff.map((s) => s.id));
  const rates = (await getSettings()).commission.payrollTaxes;
  const d = (c: number) => (c / 100).toFixed(2);
  const pct = (b: number | null) => (b == null ? '' : (b / 100).toFixed(2));
  const opt = (c: number | null) => (c == null ? '' : d(c));
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Stylist', 'From', 'To', 'Service sales', 'Service commission', 'Retail sales', 'Retail commission', 'Other & adjustments', 'Total commission',
    'Tips', 'Tip eligible', 'Pay type', 'Hours (Square)', 'Hours (by hand)', 'Hours', 'Wages', 'How wages were worked out', 'Total pay (commission + tips + wages)',
    'Worker type', 'Federal withholding %', 'State withholding %', 'Local withholding %', 'W-4 filing status', 'W-4 multiple jobs', 'W-4 dependents', 'W-4 other income',
    'W-4 deductions', 'W-4 extra withholding per paycheck', 'CA DE 4 exempt', 'CA DE 4 filing status', 'CA DE 4 regular allowances',
    'CA DE 4 additional allowances', 'CA DE 4 additional withholding', 'Est. federal', 'Est. state', 'Est. local', 'Est. Social Security + Medicare (employee)',
    'Est. total withheld', 'Est. net pay', 'Est. employer taxes', 'Work location'];
  const lines = staff.map((s) => {
    const m = summarize(entries.filter((e) => e.staffId === s.id), r.from, r.to, s.id);
    const p = pay.get(s.id)!;
    if (!m.entries && !p.minutes && !p.wagesCents) return null;
    const other = m.adjustmentsCents + m.refundsCents - m.serviceRefundsCents - m.retailRefundsCents;
    return [s.name, r.from, r.to, d(m.serviceSalesCents), d(m.serviceCommissionCents + m.serviceRefundsCents), d(m.retailSalesCents), d(m.retailCommissionCents + m.retailRefundsCents),
      d(other), d(m.totalCommissionCents), d(m.tipsCents), s.tip_eligible ? 'yes' : 'no', p.payType, (p.squareMinutes / 60).toFixed(2), (p.manualMinutes / 60).toFixed(2),
      (p.minutes / 60).toFixed(2), d(p.wagesCents), p.basis, d(m.totalCommissionCents + m.tipsCents + p.wagesCents),
      ...(() => {
        const t = tax.get(s.id)!;
        const e = estimateTaxes(m.totalCommissionCents + m.tipsCents + p.wagesCents, t, rates);
        return [t.workerType === '1099' ? '1099' : 'W-2', pct(t.federalBps), pct(t.stateBps), pct(t.localBps), t.w4.filingStatus ?? '', t.w4.multipleJobs ? 'yes' : 'no',
          opt(t.w4.dependentsCents), opt(t.w4.otherIncomeCents), opt(t.w4.deductionsCents), opt(t.w4.extraWithholdingCents),
          t.de4.exempt ? 'yes' : 'no', t.de4.filingStatus ?? '', t.de4.regularAllowances, t.de4.additionalAllowances, d(t.de4.additionalWithholdingCents),
          d(e.federalCents), d(e.stateCents), d(e.localCents), d(e.ficaCents), d(e.withheldCents), d(e.netCents), d(e.employerCents), rates.workAddress];
      })()].map(esc).join(',');
  }).filter(Boolean);
  await logAction(req, 'commission.export_summary', 'commission', null, { from: r.from, to: r.to, rows: lines.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="pay-summary-${r.from}-to-${r.to}.csv"`);
  res.send([head.map(esc).join(','), ...lines].join('\n'));
}));

// ---------- Wages, tip eligibility and hours (Users & Permissions → Wages & tips) ----------
const seesPay = requireAnyPermission('commission:team', 'commission:manage');

commissionRouter.get('/pay/:staffId', seesPay, requirePayUnlock, ah(async (req, res) => {
  const r = parse(range, req.query);
  const pay = await getPay(req.params.staffId);
  res.json({ pay, hours: await listHours(req.params.staffId, r.from, r.to), summary: (await paySummaries([req.params.staffId], r.from, r.to)).get(req.params.staffId) });
}));

commissionRouter.put('/pay/:staffId', requirePermission('commission:manage'), ah(async (req, res) => {
  const b = parse(z.object({
    payType: z.enum(['none', 'hourly', 'salary']),
    hourlyRateCents: z.number().int().min(0).max(100_000).nullable(),
    salaryCents: z.number().int().min(0).max(100_000_000).nullable(),
    salaryPeriod: z.enum(['week', 'biweekly', 'semimonthly', 'month', 'year']),
    tipEligible: z.boolean(),
    /** When a changed wage starts (null = from the beginning). */
    effectiveFrom: ymd.nullable().optional(),
    taxes: z.object({
      workerType: z.enum(['w2', '1099']),
      federalBps: bps.nullable(), stateBps: bps.nullable(), localBps: bps.nullable(),
      showBreakdown: z.boolean().default(true),
      w4: z.object({
        filingStatus: z.enum(['single', 'married_jointly', 'head_of_household']).nullable(),
        multipleJobs: z.boolean(),
        dependentsCents: z.number().int().min(0).max(100_000_000).nullable(),
        otherIncomeCents: z.number().int().min(0).max(100_000_000).nullable(),
        deductionsCents: z.number().int().min(0).max(100_000_000).nullable(),
        extraWithholdingCents: z.number().int().min(0).max(100_000_000).nullable(),
      }),
      // Optional so older screens still save; missing = not exempt, no DE 4 details.
      de4: z.object({
        exempt: z.boolean(),
        filingStatus: z.enum(['single_or_married_two_incomes', 'married_one_income', 'head_of_household']).nullable(),
        regularAllowances: z.number().int().min(0).max(99),
        additionalAllowances: z.number().int().min(0).max(99),
        additionalWithholdingCents: z.number().int().min(0).max(100_000_000),
      }).default({ exempt: false, filingStatus: null, regularAllowances: 0, additionalAllowances: 0, additionalWithholdingCents: 0 }),
    }),
  }), req.body);
  const r = await setPay(req.params.staffId, b, req.user!.id);
  // Audit records which fields changed, never the amounts.
  await logAction(req, 'commission.pay_update', 'staff', req.params.staffId, { payType: b.payType, tipEligible: b.tipEligible, workerType: b.taxes.workerType });
  if (r.tipEligibilityChanged && (await getSettings()).commission.enabled) await rebuildCommission();
  res.json({ pay: await getPay(req.params.staffId) });
}));

/** Their own Earnings page: commission and tips only, or everything (admins always see it all). */
commissionRouter.put('/pay/:staffId/commission-only', requirePermission('commission:manage'), ah(async (req, res) => {
  const b = parse(z.object({ on: z.boolean() }), req.body);
  const r = await db().query('UPDATE staff SET commission_only_view = $2, updated_at = now() WHERE id = $1 RETURNING id', [req.params.staffId, b.on]);
  if (!r.length) throw notFound('That team member');
  await logAction(req, 'commission.view_update', 'staff', req.params.staffId, { commissionOnly: b.on });
  res.json({ pay: await getPay(req.params.staffId) });
}));

/** Hourly pay: all hours, only hours not with a client (appointments paid as commission), or off. Wage and hours stay saved. */
commissionRouter.put('/pay/:staffId/hourly', requirePermission('commission:manage'), ah(async (req, res) => {
  const b = parse(z.object({ mode: z.enum(['all', 'not_servicing', 'off']) }), req.body);
  const r = await db().query('UPDATE staff SET hourly_mode = $2, updated_at = now() WHERE id = $1 RETURNING id', [req.params.staffId, b.mode]);
  if (!r.length) throw notFound('That team member');
  await logAction(req, 'commission.hourly_update', 'staff', req.params.staffId, { mode: b.mode });
  res.json({ pay: await getPay(req.params.staffId) });
}));

/** Whether someone can be picked or suggested for commission when Square didn't record who checked out. */
commissionRouter.put('/pay/:staffId/suggest', requirePermission('commission:manage'), ah(async (req, res) => {
  const b = parse(z.object({ suggest: z.boolean() }), req.body);
  const r = await db().query('UPDATE staff SET commission_suggest = $2, updated_at = now() WHERE id = $1 RETURNING id', [req.params.staffId, b.suggest]);
  if (!r.length) throw notFound('That team member');
  await logAction(req, 'commission.suggest_update', 'staff', req.params.staffId, { suggest: b.suggest });
  if ((await getSettings()).commission.enabled) await rebuildCommission();
  res.json({ pay: await getPay(req.params.staffId) });
}));

/** Correct a wage in the history (amount, type or start date), or remove it. */
const rateInput = z.object({
  payType: z.enum(['none', 'hourly', 'salary']), hourlyRateCents: z.number().int().min(0).max(100_000).nullable(),
  salaryCents: z.number().int().min(0).max(100_000_000).nullable(), salaryPeriod: z.enum(['week', 'biweekly', 'semimonthly', 'month', 'year']), effectiveFrom: ymd.nullable(),
});
commissionRouter.post('/pay-rates', requirePermission('commission:manage'), ah(async (req, res) => {
  const b = parse(rateInput.extend({ staffId: z.string().uuid(), effectiveTo: ymd.nullable().optional() }), req.body);
  await addRate(b.staffId, b, req.user!.id);
  await logAction(req, 'commission.pay_rate_add', 'staff', b.staffId, { effectiveFrom: b.effectiveFrom, payType: b.payType });
  res.status(201).json({ pay: await getPay(b.staffId) });
}));
commissionRouter.patch('/pay-rates/:id', requirePermission('commission:manage'), ah(async (req, res) => {
  const b = parse(rateInput, req.body);
  const staffId = await updateRate(req.params.id, b);
  await logAction(req, 'commission.pay_rate_update', 'staff', staffId, { effectiveFrom: b.effectiveFrom, payType: b.payType });
  res.json({ pay: await getPay(staffId) });
}));
commissionRouter.delete('/pay-rates/:id', requirePermission('commission:manage'), ah(async (req, res) => {
  const staffId = await deleteRate(req.params.id);
  await logAction(req, 'commission.pay_rate_delete', 'staff', staffId, { id: req.params.id });
  res.json({ pay: await getPay(staffId) });
}));

commissionRouter.post('/hours', requirePermission('commission:manage'), ah(async (req, res) => {
  const b = parse(z.object({ staffId: z.string().uuid(), date: ymd, hours: z.number().positive().max(744), note: z.string().trim().max(300).nullable().default(null) }), req.body);
  const id = await addManualHours(b.staffId, b.date, Math.round(b.hours * 60), b.note, req.user!.id);
  await logAction(req, 'commission.hours_add', 'staff', b.staffId, { date: b.date, hours: b.hours });
  res.status(201).json({ id });
}));

/** Payroll tab: hours per person per day for a range (at most 31 days). */
commissionRouter.get('/timesheet', seesPay, requirePayUnlock, ah(async (req, res) => {
  const r = parse(range, req.query);
  if (Date.parse(`${r.to}T12:00:00Z`) - Date.parse(`${r.from}T12:00:00Z`) > 31 * 86400_000) throw badRequest('Choose up to a month at a time.');
  res.json({ rows: await timesheet(r.from, r.to) });
}));

/** Owner/Admin only (by role): send hours entered in the CRM to Square as timecards. */
const ownerAdminPayroll = (req: any, _res: any, next: any) =>
  next(req.user?.role === 'admin' && can(req.user, 'commission:manage') ? undefined : forbidden('Only an Owner or Admin can send hours to Square.'));

/**
 * One person's day, or every day with hours entered in a range (`staffId` optional — e.g. the whole week), sent to
 * Square. Days typed into Payroll hours replace that day's Square timecards; days with only hand-added hours become a
 * timecard when Square has none yet.
 */
commissionRouter.post('/timesheet/to-square', requirePermission('commission:manage'), ownerAdminPayroll, ah(async (req, res) => {
  const b = parse(z.object({ staffId: z.string().uuid().optional(), date: ymd.optional(), from: ymd.optional(), to: ymd.optional() }), req.body);
  const sq = await squareService();
  if (!sq) throw badRequest('Square isn’t connected.');
  const hasTimesheet = async (staffId: string, date: string) =>
    !!(await db().one(`SELECT 1 FROM staff_hours WHERE staff_id = $1 AND work_date = $2::date AND source = 'timesheet' AND minutes > 0`, [staffId, date]));
  const sendOne = async (staffId: string, date: string) =>
    (await hasTimesheet(staffId, date)) ? updateDayInSquare(sq, staffId, date) : sendDayToSquare(sq, staffId, date).then(() => true);
  if (b.staffId && b.date) {
    const changed = await sendOne(b.staffId, b.date);
    await logAction(req, 'commission.hours_to_square', 'staff', b.staffId, { date: b.date });
    return res.json({ sent: changed ? 1 : 0, failed: [] });
  }
  if (!b.from || !b.to) throw badRequest('Choose the dates to send.');
  // Every day in the range typed into Payroll hours, and days with hand-added hours and no Square timecard yet.
  const days = await db().query<any>(
    `SELECT staff_id, to_char(work_date, 'YYYY-MM-DD') AS d FROM staff_hours h
      WHERE work_date BETWEEN $1::date AND $2::date AND work_date <= $3::date ${b.staffId ? 'AND staff_id = $4' : ''}
      GROUP BY staff_id, work_date
     HAVING sum(minutes) FILTER (WHERE source = 'timesheet') > 0
         OR (sum(minutes) FILTER (WHERE source = 'manual' AND coalesce(note, '') <> 'Week total') > 0 AND coalesce(sum(minutes) FILTER (WHERE source = 'square'), 0) = 0)`,
    [b.from, b.to, localDate(new Date(), (await getSettings()).business.timezone), ...(b.staffId ? [b.staffId] : [])]);
  let sent = 0;
  const failed: string[] = [];
  for (const d of days) {
    try {
      if (await sendOne(d.staff_id, d.d)) sent++;
    } catch (e) {
      failed.push((e as { userMessage?: string; message: string }).userMessage ?? (e as Error).message);
    }
  }
  await logAction(req, 'commission.hours_to_square', 'commission', null, { from: b.from, to: b.to, sent, failed: failed.length });
  res.json({ sent, failed: [...new Set(failed)] });
}));

/** Owners/Admins: clear one person's hours for these dates and reload them from Square (start over). */
commissionRouter.post('/timesheet/clear', requirePermission('commission:manage'), ownerAdminPayroll, ah(async (req, res) => {
  const b = parse(z.object({ staffId: z.string().uuid(), from: ymd, to: ymd }), req.body);
  if (b.from > b.to) throw badRequest('Choose the dates to clear.');
  const r = await clearHours(await squareService(), b.staffId, b.from, b.to);
  await logAction(req, 'commission.hours_cleared', 'staff', b.staffId, { from: b.from, to: b.to, removed: r.removed });
  res.json(r);
}));

/** Payroll tab: one weekly total for someone entered "By week" (null clears it). */
commissionRouter.put('/timesheet/week', requirePermission('commission:manage'), ah(async (req, res) => {
  const b = parse(z.object({ staffId: z.string().uuid(), weekStart: ymd, hours: z.number().min(0).max(168).nullable() }), req.body);
  await setWeekTotal(b.staffId, b.weekStart, b.hours ? Math.round(b.hours * 60) : null, req.user!.id);
  await logAction(req, 'commission.hours_week', 'staff', b.staffId, { weekStart: b.weekStart, hours: b.hours });
  res.json({ ok: true });
}));

/** Payroll tab: enter someone's hours by day or as one weekly total. */
commissionRouter.put('/timesheet/mode', requirePermission('commission:manage'), ah(async (req, res) => {
  const b = parse(z.object({ staffId: z.string().uuid(), mode: z.enum(['day', 'week']) }), req.body);
  await setTimesheetMode(b.staffId, b.mode);
  await logAction(req, 'commission.hours_mode', 'staff', b.staffId, { mode: b.mode });
  res.json({ ok: true });
}));

/** Payroll tab: the hours entered by hand for one person on one day (0 clears them). */
commissionRouter.put('/timesheet', requirePermission('commission:manage'), ah(async (req, res) => {
  // hours null = clear the day (Square's hours count again).
  const b = parse(z.object({ staffId: z.string().uuid(), date: ymd, hours: z.number().min(0).max(24).nullable() }), req.body);
  await setTimesheetDay(b.staffId, b.date, b.hours == null ? null : Math.round(b.hours * 60), req.user!.id);
  await logAction(req, 'commission.hours_set', 'staff', b.staffId, { date: b.date, hours: b.hours });
  // Owners/Admins: hours typed in for a past day or today update Square too (that day's timecards are replaced).
  let square: { updated: boolean; error: string | null } | null = null;
  const sq = b.hours != null && req.user?.role === 'admin' && b.date <= localDate(new Date(), (await getSettings()).business.timezone) ? await squareService() : null;
  if (sq) {
    try {
      square = { updated: await updateDayInSquare(sq, b.staffId, b.date), error: null };
      if (square.updated) await logAction(req, 'commission.hours_to_square', 'staff', b.staffId, { date: b.date, hours: b.hours });
    } catch (e) {
      square = { updated: false, error: (e as { userMessage?: string; message: string }).userMessage ?? (e as Error).message };
    }
  }
  res.json({ ok: true, square });
}));

commissionRouter.delete('/hours/:id', requirePermission('commission:manage'), ah(async (req, res) => {
  const staffId = await deleteManualHours(req.params.id);
  await logAction(req, 'commission.hours_delete', 'staff', staffId, { id: req.params.id });
  res.json({ ok: true });
}));

// ---------- Settings & rules (administrators / designated managers) ----------
const manageOrTeam = requireAnyPermission('commission:manage', 'commission:team', 'commission:approve');

commissionRouter.get('/rules', manageOrTeam, ah(async (_req, res) => {
  res.json({ rules: await listRules(), settings: (await getSettings()).commission });
}));

commissionRouter.get('/options', manageOrTeam, ah(async (_req, res) => {
  res.json({
    staff: await db().query('SELECT id, name, role, active, square_team_member_id IS NOT NULL AS "squareLinked" FROM staff ORDER BY active DESC, name'),
    services: await db().query('SELECT id, name, price_cents AS "priceCents" FROM services ORDER BY name'),
    products: await db().query(`SELECT variation_id AS id, item_name || COALESCE(' — ' || variation_name, '') AS name, price_cents AS "priceCents"
      FROM square_inventory ORDER BY item_name, variation_name LIMIT 2000`),
  });
}));

const tier = z.object({ upToCents: z.number().int().positive().nullable(), rateBps: z.number().int().min(0).max(10000) });
const ruleInput = z.object({
  staffId: z.string().uuid().nullable().default(null),
  category: z.enum(['service', 'retail']),
  targetType: z.enum(['all', 'service', 'product']).default('all'),
  targetId: z.string().max(100).nullable().default(null),
  method: z.enum(['percent', 'flat', 'tiered']),
  rateBps: z.number().int().min(0).max(10000).nullable().default(null),
  flatCents: z.number().int().min(0).max(10_000_00).nullable().default(null),
  tiers: z.array(tier).max(10).nullable().default(null),
  tierPeriod: z.enum(['month', 'week']).default('month'),
  effectiveFrom: ymd,
  effectiveTo: ymd.nullable().default(null),
  note: z.string().trim().max(300).nullable().default(null),
});

commissionRouter.post('/rules', requirePermission('commission:manage'), ah(async (req, res) => {
  const b = parse(ruleInput, req.body);
  const id = await createRule(b, req.user!.id);
  await logAction(req, 'commission.rule_create', 'commission_rule', id, { ...b, tiers: b.tiers?.length ?? null });
  await rebuildCommission();
  res.status(201).json({ id, rules: await listRules() });
}));

commissionRouter.put('/rules/:id', requirePermission('commission:manage'), ah(async (req, res) => {
  const b = parse(ruleInput, req.body);
  await updateRule(req.params.id, b);
  await logAction(req, 'commission.rule_update', 'commission_rule', req.params.id, { ...b, tiers: b.tiers?.length ?? null });
  await rebuildCommission();
  res.json({ rules: await listRules() });
}));

commissionRouter.post('/rules/:id/end', requirePermission('commission:manage'), ah(async (req, res) => {
  const { endDate } = parse(z.object({ endDate: ymd }), req.body);
  await endRule(req.params.id, endDate, req.user!.id);
  await logAction(req, 'commission.rule_end', 'commission_rule', req.params.id, { endDate });
  await rebuildCommission();
  res.json({ rules: await listRules() });
}));

commissionRouter.delete('/rules/:id', requirePermission('commission:manage'), ah(async (req, res) => {
  await deleteRule(req.params.id);
  await logAction(req, 'commission.rule_delete', 'commission_rule', req.params.id);
  await rebuildCommission();
  res.json({ rules: await listRules() });
}));

const settingsInput = z.object({
  enabled: z.boolean(),
  autoSync: z.boolean(),
  syncIntervalMinutes: z.number().int().min(15).max(1440),
  syncStartDate: ymd.nullable(),
  basis: z.enum(['after_discounts', 'before_discounts']),
  refunds: z.enum(['reverse', 'ignore']),
  zeroPriced: z.enum(['no_commission', 'regular_price', 'review']),
  multiProvider: z.enum(['split_evenly', 'review']),
  productAttribution: z.enum(['appointment_provider', 'payment_team_member']),
  unrecordedCheckout: z.object({ clientStylist: z.boolean(), onTheClock: z.boolean(), fallbackStaffId: z.string().uuid().nullable(), hold: z.boolean() }),
  defaultServiceBps: z.number().int().min(0).max(10000), defaultRetailBps: z.number().int().min(0).max(10000),
  tips: z.enum(['separate', 'exclude']),
  tipAttribution: z.enum(['service_share', 'payment_team_member']),
  disclaimer: z.string().trim().max(1000),
  payrollTaxes: z.object({ socialSecurityBps: bps, medicareBps: bps, futaBps: bps, sutaBps: bps, sdiBps: bps.default(130), stateIncomeBps: bps.default(400), federalIncomeBps: bps.default(1000), netCushionBps: bps.default(200), workAddress: z.string().trim().max(300) }),
  paySchedule: z.object({ frequency: z.enum(['weekly', 'biweekly', 'semimonthly', 'monthly']), anchorStart: ymd, payDayOffsetDays: z.number().int().min(0).max(31) }),
}).partial();

commissionRouter.put('/settings', requirePermission('commission:manage'), ah(async (req, res) => {
  const b = parse(settingsInput, req.body);
  const s = await updateSettings({ commission: b });
  await logAction(req, 'commission.settings', 'settings', null, b);
  await rebuildCommission();
  res.json({ settings: s.commission });
}));

commissionRouter.post('/sync', requireAnyPermission('commission:manage', 'commission:approve'), ah(async (req, res) => {
  const runId = await syncCommission({ trigger: 'manual', staffId: req.user!.id });
  await logAction(req, 'commission.sync', 'commission', runId);
  res.json({ runId, status: await commissionStatus() });
}));

// ---------- Review, adjustments, finalizing ----------
/** Needs review: the last month by default, or ?from=&to= (also on the actions below, so the list they return matches). */
const reviewDates = (req: any) => {
  const q = parse(z.object({ from: ymd.optional(), to: ymd.optional() }), req.query ?? {});
  return { from: q.from ?? null, to: q.to ?? null };
};

commissionRouter.get('/review', requireAnyPermission('commission:approve', 'commission:manage'), ah(async (req, res) => {
  const range = await reviewRange(reviewDates(req));
  res.json({ entries: await reviewQueue(range), ...range });
}));

commissionRouter.post('/entries/:id/attribute', requirePermission('commission:approve'), ah(async (req, res) => {
  const b = parse(z.object({ staffIds: z.array(z.string().uuid()).max(5), note: z.string().trim().max(300).nullable().default(null) }), req.body);
  await attributeEntry(req.params.id, b.staffIds, b.note, req.user!.id);
  await logAction(req, 'commission.attribute', 'commission_entry', req.params.id, { staffIds: b.staffIds });
  res.json({ entries: await reviewQueue(reviewDates(req)) });
}));

// Several at once (Needs review → select → Credit to… / Accept): one rebuild for all of them.
commissionRouter.post('/entries/attribute', requirePermission('commission:approve'), ah(async (req, res) => {
  const b = parse(z.object({ entryIds: z.array(z.string().uuid()).min(1).max(500), staffIds: z.array(z.string().uuid()).max(5), note: z.string().trim().max(300).nullable().default(null) }), req.body);
  const n = await attributeEntries(b.entryIds, b.staffIds, b.note, req.user!.id);
  await logAction(req, 'commission.attribute', 'commission_entry', null, { entries: b.entryIds.length, staffIds: b.staffIds });
  res.json({ entries: await reviewQueue(reviewDates(req)), credited: n });
}));

commissionRouter.post('/entries/accept', requirePermission('commission:approve'), ah(async (req, res) => {
  const b = parse(z.object({ entryIds: z.array(z.string().uuid()).min(1).max(500) }), req.body);
  let n = 0;
  for (const id of b.entryIds) { try { await acceptEntry(id, null, req.user!.id); n++; } catch { /* not credited yet, or already done */ } }
  await logAction(req, 'commission.accept', 'commission_entry', null, { entries: n });
  res.json({ entries: await reviewQueue(reviewDates(req)), accepted: n });
}));

commissionRouter.post('/entries/:id/accept', requirePermission('commission:approve'), ah(async (req, res) => {
  const b = parse(z.object({ note: z.string().trim().max(300).nullable().default(null) }), req.body ?? {});
  await acceptEntry(req.params.id, b.note, req.user!.id);
  await logAction(req, 'commission.accept', 'commission_entry', req.params.id);
  res.json({ entries: await reviewQueue(reviewDates(req)) });
}));

commissionRouter.post('/adjustments', requirePermission('commission:approve'), ah(async (req, res) => {
  const b = parse(z.object({
    staffId: z.string().uuid(),
    amountCents: z.number().int().min(-10_000_00).max(10_000_00).refine((v) => v !== 0, 'can’t be zero'),
    date: ymd,
    note: z.string().trim().min(3, 'explain the adjustment').max(300),
  }), req.body);
  const id = await addAdjustment(b, req.user!.id);
  await logAction(req, 'commission.adjustment', 'commission_entry', id, { staffId: b.staffId, amountCents: b.amountCents, date: b.date });
  res.status(201).json({ id });
}));

commissionRouter.get('/periods', requireAnyPermission('commission:approve', 'commission:team'), ah(async (_req, res) => {
  res.json({ periods: await listPeriods() });
}));

commissionRouter.post('/periods/finalize', requirePermission('commission:approve'), ah(async (req, res) => {
  const b = parse(z.object({ startDate: ymd, endDate: ymd, note: z.string().trim().max(300).nullable().default(null), confirm: z.literal(true, { errorMap: () => ({ message: 'please confirm — finalized commission can’t be changed' }) }), force: z.boolean().default(false) }), req.body);
  const out = await finalizePeriod(b, req.user!.id);
  await logAction(req, 'commission.finalize', 'commission_period', out.periodId, { startDate: b.startDate, endDate: b.endDate, records: out.finalized });
  res.json({ ...out, periods: await listPeriods() });
}));

/** Helper for the UI's date filters (salon time zone). */
commissionRouter.get('/today', ah(async (_req, res) => {
  res.json({ today: localDate(new Date(), (await getSettings()).business.timezone) });
}));

