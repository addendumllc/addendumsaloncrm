import type { CommissionSettings, PayRateDTO, PaySummaryDTO, PayType, SalaryPeriod, StaffHoursDTO, StaffPayDTO, StaffTaxDTO, TaxEstimateDTO, TimesheetRowDTO } from '@addendum/shared';
import { db } from '../db/index.js';
import { badRequest, IntegrationError, notFound } from '../lib/errors.js';
import type { SquareService } from '../integrations/square/types.js';
import { getKV, getSettings, setKV } from '../repos/settings.js';
import { addDaysToDate, localDate } from './rebookingSchedule.js';
import { config } from '../config.js';
import { zonedToUtc } from '../lib/time.js';

/**
 * Wages and tips per person. Pay is hourly (hours × rate) or a salary (prorated by the days in the range viewed).
 * Hours come from closed Square timecards (TIMECARDS_READ) and from hours an administrator enters by hand; both count.
 * Tip eligibility is used by the commission rebuild: tips on a non-eligible person's work go to Needs review.
 */

export const HOURS_ERROR_KEY = 'wages.hours-sync-error';
const PERIODS_PER_YEAR: Record<SalaryPeriod, number> = { week: 52, biweekly: 26, semimonthly: 24, month: 12, year: 1 };
const PERIOD_LABEL: Record<SalaryPeriod, string> = { week: 'week', biweekly: '2 weeks', semimonthly: 'half-month', month: 'month', year: 'year' };
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400_000) + 1;

export const taxDTO = (r: any): StaffTaxDTO => ({
  workerType: r.worker_type, federalBps: r.federal_withholding_bps, stateBps: r.state_withholding_bps, localBps: r.local_withholding_bps,
  showBreakdown: r.show_tax_breakdown ?? true,
  w4: {
    filingStatus: r.w4_filing_status, multipleJobs: r.w4_multiple_jobs, dependentsCents: r.w4_dependents_cents, otherIncomeCents: r.w4_other_income_cents,
    deductionsCents: r.w4_deductions_cents, extraWithholdingCents: r.w4_extra_withholding_cents,
  },
  de4: {
    exempt: !!r.de4_exempt, filingStatus: r.de4_filing_status ?? null, regularAllowances: r.de4_regular_allowances ?? 0,
    additionalAllowances: r.de4_additional_allowances ?? 0, additionalWithholdingCents: r.de4_additional_withholding_cents ?? 0,
  },
});

/** Rates before history existed, or set "from the beginning", start on this date. */
const BEGINNING = '2000-01-01';

async function listRates(staffId: string): Promise<PayRateDTO[]> {
  const rows = await db().query<any>(
    `SELECT r.*, to_char(r.effective_from, 'YYYY-MM-DD') AS f, s.name AS by FROM staff_pay_rates r LEFT JOIN staff s ON s.id = r.created_by_staff_id
      WHERE r.staff_id = $1 ORDER BY r.effective_from DESC`, [staffId]);
  return rows.map((r, i) => ({
    id: r.id, effectiveFrom: r.f === BEGINNING ? null : r.f, effectiveTo: i === 0 ? null : addDaysToDate(rows[i - 1].f, -1),
    payType: r.pay_type, hourlyRateCents: r.hourly_rate_cents, salaryCents: r.salary_cents, salaryPeriod: r.salary_period, createdByName: r.by ?? null,
  }));
}

const payDTO = async (r: any): Promise<StaffPayDTO> => ({
  staffId: r.id, payType: r.pay_type, hourlyRateCents: r.hourly_rate_cents, salaryCents: r.salary_cents, salaryPeriod: r.salary_period, tipEligible: r.tip_eligible,
  taxes: taxDTO(r), rates: await listRates(r.id),
});

export async function getPay(staffId: string): Promise<StaffPayDTO> {
  const r = await db().one<any>('SELECT * FROM staff WHERE id = $1', [staffId]);
  if (!r) throw notFound('That team member');
  return payDTO(r);
}

type RateInput = { payType: PayType; hourlyRateCents: number | null; salaryCents: number | null; salaryPeriod: SalaryPeriod };
function checkRate(p: RateInput) {
  if (p.payType === 'hourly' && p.hourlyRateCents == null) throw badRequest('Enter the hourly rate.');
  if (p.payType === 'salary' && p.salaryCents == null) throw badRequest('Enter the salary amount.');
}

/** Keeps staff.pay_type etc. equal to the rate in effect today (or none). */
async function syncCurrentRate(staffId: string) {
  const today = localDate(new Date(), (await getSettings()).business.timezone);
  const r = await db().one<any>('SELECT * FROM staff_pay_rates WHERE staff_id = $1 AND effective_from <= $2::date ORDER BY effective_from DESC LIMIT 1', [staffId, today]);
  await db().query('UPDATE staff SET pay_type = $2, hourly_rate_cents = $3, salary_cents = $4, salary_period = $5, updated_at = now() WHERE id = $1',
    [staffId, r?.pay_type ?? 'none', r?.hourly_rate_cents ?? null, r?.salary_cents ?? null, r?.salary_period ?? 'year']);
}

/**
 * Saves pay, tip eligibility and tax details. A changed wage starts on `effectiveFrom` (null = from the beginning) and
 * earlier dates keep the rate they had. Returns whether tip eligibility changed (commission needs rebuilding then).
 */
export async function setPay(staffId: string, p: Omit<StaffPayDTO, 'staffId' | 'rates'> & { effectiveFrom?: string | null }, by: string | null = null) {
  const before = await getPay(staffId);
  checkRate(p);
  const t = p.taxes;
  await db().query(
    `UPDATE staff SET tip_eligible = $2, worker_type = $3, federal_withholding_bps = $4, state_withholding_bps = $5, local_withholding_bps = $6, w4_filing_status = $7,
       w4_multiple_jobs = $8, w4_dependents_cents = $9, w4_other_income_cents = $10, w4_deductions_cents = $11, w4_extra_withholding_cents = $12,
       de4_exempt = $13, de4_filing_status = $14, de4_regular_allowances = $15, de4_additional_allowances = $16, de4_additional_withholding_cents = $17,
       show_tax_breakdown = $18, updated_at = now() WHERE id = $1`,
    [staffId, p.tipEligible, t.workerType, t.federalBps, t.stateBps, t.localBps,
      t.w4.filingStatus, t.w4.multipleJobs, t.w4.dependentsCents, t.w4.otherIncomeCents, t.w4.deductionsCents, t.w4.extraWithholdingCents,
      t.de4.exempt, t.de4.filingStatus, t.de4.regularAllowances, t.de4.additionalAllowances, t.de4.additionalWithholdingCents, t.showBreakdown ?? true],
  );
  const wageChanged = p.payType !== before.payType || p.hourlyRateCents !== before.hourlyRateCents || p.salaryCents !== before.salaryCents || p.salaryPeriod !== before.salaryPeriod;
  if (wageChanged) await upsertRate(staffId, p.effectiveFrom ?? null, p, by);
  return { tipEligibilityChanged: before.tipEligible !== p.tipEligible };
}

async function upsertRate(staffId: string, from: string | null, p: RateInput, by: string | null) {
  await db().query(
    `INSERT INTO staff_pay_rates(staff_id, effective_from, pay_type, hourly_rate_cents, salary_cents, salary_period, created_by_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (staff_id, effective_from) DO UPDATE SET pay_type = EXCLUDED.pay_type, hourly_rate_cents = EXCLUDED.hourly_rate_cents,
       salary_cents = EXCLUDED.salary_cents, salary_period = EXCLUDED.salary_period, updated_at = now()`,
    [staffId, from ?? BEGINNING, p.payType, p.payType === 'hourly' ? p.hourlyRateCents : null, p.payType === 'salary' ? p.salaryCents : null, p.salaryPeriod, by]);
  await syncCurrentRate(staffId);
}

/** Adds a wage to the history from a date (a past raise, or one coming up). One wage per start date. */
export async function addRate(staffId: string, p: RateInput & { effectiveFrom: string | null }, by: string | null) {
  if (!(await db().one('SELECT 1 FROM staff WHERE id = $1', [staffId]))) throw notFound('That team member');
  checkRate(p);
  if (await db().one('SELECT 1 FROM staff_pay_rates WHERE staff_id = $1 AND effective_from = $2::date', [staffId, p.effectiveFrom ?? BEGINNING])) {
    throw badRequest('A wage already starts on that date. Edit that one instead.');
  }
  await upsertRate(staffId, p.effectiveFrom, p, by);
}

/** Corrects a past (or current) wage: its amount, type or start date. */
export async function updateRate(id: string, p: RateInput & { effectiveFrom: string | null }) {
  const r = await db().one<any>('SELECT staff_id FROM staff_pay_rates WHERE id = $1', [id]);
  if (!r) throw notFound('That wage');
  checkRate(p);
  const from = p.effectiveFrom ?? BEGINNING;
  if (await db().one('SELECT 1 FROM staff_pay_rates WHERE staff_id = $1 AND effective_from = $2::date AND id <> $3', [r.staff_id, from, id])) {
    throw badRequest('Another wage already starts on that date. Edit that one instead.');
  }
  await db().query(
    `UPDATE staff_pay_rates SET effective_from = $2, pay_type = $3, hourly_rate_cents = $4, salary_cents = $5, salary_period = $6, updated_at = now() WHERE id = $1`,
    [id, from, p.payType, p.payType === 'hourly' ? p.hourlyRateCents : null, p.payType === 'salary' ? p.salaryCents : null, p.salaryPeriod]);
  await syncCurrentRate(r.staff_id);
  return r.staff_id as string;
}

export async function deleteRate(id: string) {
  const r = await db().one<any>('SELECT staff_id FROM staff_pay_rates WHERE id = $1', [id]);
  if (!r) throw notFound('That wage');
  await db().query('DELETE FROM staff_pay_rates WHERE id = $1', [id]);
  await syncCurrentRate(r.staff_id);
  return r.staff_id as string;
}

export async function listHours(staffId: string, from: string, to: string): Promise<StaffHoursDTO[]> {
  const rows = await db().query<any>(
    `SELECT h.*, to_char(h.work_date, 'YYYY-MM-DD') AS d, s.name AS created_by_name FROM staff_hours h LEFT JOIN staff s ON s.id = h.created_by_staff_id
      WHERE h.staff_id = $1 AND h.work_date BETWEEN $2::date AND $3::date ORDER BY h.work_date DESC, h.created_at DESC`, [staffId, from, to]);
  return rows.map((r) => ({ id: r.id, staffId: r.staff_id, date: r.d, minutes: r.minutes, source: r.source, note: r.note, createdByName: r.created_by_name ?? null }));
}

export async function addManualHours(staffId: string, date: string, minutes: number, note: string | null, by: string) {
  if (!(await db().one('SELECT 1 FROM staff WHERE id = $1', [staffId]))) throw notFound('That team member');
  const r = await db().one<{ id: string }>(
    `INSERT INTO staff_hours(staff_id, work_date, minutes, source, note, created_by_staff_id) VALUES ($1,$2,$3,'manual',$4,$5) RETURNING id`, [staffId, date, minutes, note, by]);
  return r!.id;
}

/**
 * Payroll timesheet: sets one person's hours for one day. The number is that day's hours for pay, in place of Square
 * timecards and other hand entries (which stay on record). null clears it, so Square's hours count again.
 */
export async function setTimesheetDay(staffId: string, date: string, minutes: number | null, by: string) {
  if (!(await db().one('SELECT 1 FROM staff WHERE id = $1', [staffId]))) throw notFound('That team member');
  await db().tx(async (q) => {
    await q.query(`DELETE FROM staff_hours WHERE staff_id = $1 AND work_date = $2::date AND source = 'timesheet'`, [staffId, date]);
    if (minutes != null) {
      await q.query(`INSERT INTO staff_hours(staff_id, work_date, minutes, source, note, created_by_staff_id) VALUES ($1,$2,$3,'timesheet','Payroll timesheet',$4)`, [staffId, date, minutes, by]);
    }
  });
}

type DayRow = { staff_id: string; d: string; source: 'square' | 'manual' | 'timesheet' | 'week' | 'clock'; m: number };
/**
 * Hours that count, per day: a timesheet entry if there is one for the day, otherwise Square + hand entries.
 * A time clock shift kept in the CRM only ('clock') counts only when Square has no hours that day — otherwise the
 * same time would be counted twice. squareMinutes / manualMinutes split the total by where it came from.
 */
function countedDays(rows: DayRow[]) {
  const days = new Map<string, { square: number; manual: number; timesheet: number | null; week: number; clock: number }>();
  for (const r of rows) {
    const x = days.get(r.d) ?? { square: 0, manual: 0, timesheet: null, week: 0, clock: 0 };
    if (r.source === 'timesheet') x.timesheet = (x.timesheet ?? 0) + r.m;
    else x[r.source] += r.m;
    days.set(r.d, x);
  }
  for (const x of days.values()) if (!x.square) x.manual += x.clock;
  let squareMinutes = 0;
  let manualMinutes = 0;
  const counted = new Map<string, number>();
  for (const [d, x] of days) {
    // A weekly total always counts (a day's timesheet number never replaces it).
    if (x.timesheet != null) { manualMinutes += x.timesheet + x.week; counted.set(d, x.timesheet + x.week); } else { squareMinutes += x.square; manualMinutes += x.manual + x.week; counted.set(d, x.square + x.manual + x.week); }
  }
  return { squareMinutes, manualMinutes, counted };
}

/** Everyone active (and anyone with hours in the range), with hours per day split by where they came from. */
export async function timesheet(from: string, to: string): Promise<TimesheetRowDTO[]> {
  const staff = await db().query<any>(
    `SELECT id, name, pay_type, hourly_rate_cents, timesheet_mode FROM staff s
      WHERE (active AND password_hash IS NOT NULL) OR EXISTS (SELECT 1 FROM staff_hours h WHERE h.staff_id = s.id AND h.work_date BETWEEN $1::date AND $2::date)
      ORDER BY CASE pay_type WHEN 'hourly' THEN 0 WHEN 'salary' THEN 1 ELSE 2 END, name`, [from, to]);
  const hours = await db().query<any>(
    `SELECT staff_id, to_char(work_date, 'YYYY-MM-DD') AS d, CASE WHEN note = 'Week total' AND source = 'manual' THEN 'week' WHEN note = 'Time clock' AND source = 'manual' THEN 'clock' ELSE source END AS source, sum(minutes)::int AS m FROM staff_hours
      WHERE work_date BETWEEN $1::date AND $2::date GROUP BY staff_id, work_date, 3`, [from, to]);
  const pay = await paySummaries(staff.map((s) => s.id), from, to);
  const weekTotals = await db().query<any>(
    `SELECT staff_id, sum(minutes)::int AS m FROM staff_hours WHERE note = '${WEEK_NOTE}' AND work_date BETWEEN $1::date AND $2::date GROUP BY staff_id`, [from, to]);
  return staff.map((s) => {
    const mine = hours.filter((h) => h.staff_id === s.id);
    const by = (src: string) => {
      const out: Record<string, number> = {};
      for (const h of mine) if (h.source === src) out[h.d] = (out[h.d] ?? 0) + h.m;
      // A CRM-only time clock shift shows with hand-entered hours, unless Square already has that day.
      if (src === 'manual') for (const h of mine) if (h.source === 'clock' && !mine.some((x) => x.d === h.d && x.source === 'square')) out[h.d] = (out[h.d] ?? 0) + h.m;
      return out;
    };
    const week = weekTotals.find((w) => w.staff_id === s.id);
    return {
      staffId: s.id, name: s.name, payType: s.pay_type, hourlyRateCents: s.hourly_rate_cents, square: by('square'), manual: by('manual'), timesheet: by('timesheet'),
      pay: pay.get(s.id)!, mode: s.timesheet_mode, weekTotal: week ? week.m : null,
    };
  });
}

export const WEEK_NOTE = 'Week total';

/**
 * Hours for a whole week entered as one total (people set to "By week"): replaces the total entered for that week
 * (null clears it). Kept on the week's first day as hours entered by hand; Square timecards still count alongside.
 */
export async function setWeekTotal(staffId: string, weekStart: string, minutes: number | null, by: string) {
  if (!(await db().one('SELECT 1 FROM staff WHERE id = $1', [staffId]))) throw notFound('That team member');
  await db().tx(async (q) => {
    await q.query(`DELETE FROM staff_hours WHERE staff_id = $1 AND source = 'manual' AND note = $3 AND work_date BETWEEN $2::date AND ($2::date + 6)`, [staffId, weekStart, WEEK_NOTE]);
    if (minutes) await q.query(`INSERT INTO staff_hours(staff_id, work_date, minutes, source, note, created_by_staff_id) VALUES ($1,$2,$3,'manual',$4,$5)`, [staffId, weekStart, minutes, WEEK_NOTE, by]);
  });
}

export async function setTimesheetMode(staffId: string, mode: 'day' | 'week') {
  await db().query('UPDATE staff SET timesheet_mode = $2, updated_at = now() WHERE id = $1', [staffId, mode]);
}

/** Only hours entered by hand can be removed; Square timecards are changed in Square. */
export async function deleteManualHours(id: string) {
  const r = await db().one<any>('SELECT source, staff_id FROM staff_hours WHERE id = $1', [id]);
  if (!r) throw notFound('Those hours');
  if (r.source === 'square') throw badRequest('These hours come from a Square timecard. Change the timecard in Square; the next sync updates it here.');
  await db().query('DELETE FROM staff_hours WHERE id = $1', [id]);
  return r.staff_id as string;
}

/**
 * Reads closed Square timecards that started in [from, to] and stores their paid minutes (unpaid breaks taken off),
 * for team members linked to a CRM account. Timecards deleted in Square disappear here too. Never throws: a missing
 * TIMECARDS_READ permission is recorded and shown, and commission carries on without it.
 */
export async function syncTimecards(sq: SquareService, from: Date, to: Date) {
  try {
    const tz = (await getSettings()).business.timezone;
    const cards = await sq.listTimecards(from, to);
    const staff = new Map((await db().query<any>('SELECT id, square_team_member_id FROM staff WHERE square_team_member_id IS NOT NULL')).map((s) => [s.square_team_member_id, s.id]));
    const seen: string[] = [];
    for (const t of cards) {
      const staffId = staff.get(t.team_member_id);
      if (!staffId || !t.end_at) continue;
      const unpaid = (t.breaks ?? []).filter((b) => !b.is_paid && b.end_at).reduce((a, b) => a + (Date.parse(b.end_at!) - Date.parse(b.start_at)), 0);
      const minutes = Math.max(0, Math.round((Date.parse(t.end_at) - Date.parse(t.start_at) - unpaid) / 60_000));
      seen.push(t.id);
      await db().query(
        `INSERT INTO staff_hours(staff_id, work_date, minutes, source, square_timecard_id) VALUES ($1,$2,$3,'square',$4)
         ON CONFLICT (square_timecard_id) DO UPDATE SET staff_id = EXCLUDED.staff_id, work_date = EXCLUDED.work_date, minutes = EXCLUDED.minutes, updated_at = now()`,
        [staffId, localDate(t.start_at, tz), minutes, t.id]);
    }
    // Timecards deleted in Square: only whole days inside the window (the first and last day may be partly outside it).
    await db().query(
      `DELETE FROM staff_hours WHERE source = 'square' AND work_date > $1::date AND work_date < $2::date AND NOT (square_timecard_id = ANY($3::text[]))`,
      [localDate(from, tz), localDate(to, tz), seen]);
    await setKV(HOURS_ERROR_KEY, null);
    return seen.length;
  } catch (e) {
    const msg = e instanceof IntegrationError && e.authProblem
      ? 'Hours couldn’t be read from Square: approve the TIMECARDS_READ permission (Settings → API & Integrations → Connect Square), or enter hours by hand.'
      : 'Hours couldn’t be read from Square this time. They’ll be tried again on the next sync.';
    console.warn('[wages] timecards sync failed:', e instanceof IntegrationError ? e.technical ?? e.userMessage : (e as Error).message);
    await setKV(HOURS_ERROR_KEY, msg);
    return 0;
  }
}

export const hoursSyncError = async () => (await getKV<string | null>(HOURS_ERROR_KEY)) ?? null;

/**
 * Estimated taxes on gross pay (commission + tips + wages). W-2: the person's withholding percentages plus the employee
 * share of Social Security and Medicare are withheld; the employer pays its share plus FUTA and state unemployment.
 * 1099: nothing withheld, no employer taxes. Wage-base caps and the W-4 worksheet aren't applied — the payroll provider
 * calculates the real amounts.
 */
export function estimateTaxes(grossCents: number, t: StaffTaxDTO, rates: CommissionSettings['payrollTaxes']): TaxEstimateDTO {
  const of = (bps: number | null) => Math.round((Math.max(0, grossCents) * (bps ?? 0)) / 10000);
  if (t.workerType === '1099') {
    return { workerType: '1099', grossCents, federalCents: 0, stateCents: 0, localCents: 0, ficaCents: 0, socialSecurityCents: 0, medicareCents: 0, sdiCents: 0, withheldCents: 0, netCents: grossCents, employerCents: 0 };
  }
  const federalCents = of(t.federalBps);
  // DE 4 "exempt from withholding": nothing withheld for California. Without their own state rate, the salon's default
  // CA state income tax rate is used (so it isn't $0.00).
  const stateCents = t.de4.exempt ? 0 : of(t.stateBps ?? rates.stateIncomeBps ?? 400);
  const localCents = of(t.localBps);
  const socialSecurityCents = of(rates.socialSecurityBps);
  const medicareCents = of(rates.medicareBps);
  const ficaCents = socialSecurityCents + medicareCents;
  // California SDI: withheld from W-2 pay for work in California (a DE 4 exemption doesn't change it).
  const sdiCents = /,\s*CA\b|California/i.test(rates.workAddress ?? '') ? of(rates.sdiBps ?? 0) : 0;
  const withheldCents = federalCents + stateCents + localCents + ficaCents + sdiCents;
  const employerCents = of(rates.socialSecurityBps) + of(rates.medicareBps) + of(rates.futaBps) + of(rates.sutaBps);
  return { workerType: 'w2', grossCents, federalCents, stateCents, localCents, ficaCents, socialSecurityCents, medicareCents, sdiCents, withheldCents, netCents: grossCents - withheldCents, employerCents };
}

/** Tax details for these people (for estimates). */
export async function taxDetails(staffIds: string[]): Promise<Map<string, StaffTaxDTO>> {
  if (!staffIds.length) return new Map();
  const rows = await db().query<any>('SELECT * FROM staff WHERE id = ANY($1::uuid[])', [staffIds]);
  return new Map(rows.map((r) => [r.id as string, taxDTO(r)]));
}

/** Hours and wages for each of these people in [from, to]. */
export async function paySummaries(staffIds: string[], from: string, to: string): Promise<Map<string, PaySummaryDTO>> {
  const out = new Map<string, PaySummaryDTO>();
  if (!staffIds.length) return out;
  const staff = await db().query<any>('SELECT id, pay_type FROM staff WHERE id = ANY($1::uuid[])', [staffIds]);
  const rates = await db().query<any>(
    `SELECT staff_id, to_char(effective_from, 'YYYY-MM-DD') AS f, pay_type, hourly_rate_cents, salary_cents, salary_period FROM staff_pay_rates
      WHERE staff_id = ANY($1::uuid[]) ORDER BY effective_from`, [staffIds]);
  const hours = await db().query<any>(
    `SELECT staff_id, to_char(work_date, 'YYYY-MM-DD') AS d, CASE WHEN note = 'Week total' AND source = 'manual' THEN 'week' WHEN note = 'Time clock' AND source = 'manual' THEN 'clock' ELSE source END AS source, sum(minutes)::int AS m FROM staff_hours
      WHERE staff_id = ANY($1::uuid[]) AND work_date BETWEEN $2::date AND $3::date GROUP BY staff_id, work_date, 3`,
    [staffIds, from, to]);
  for (const s of staff) {
    const { squareMinutes, manualMinutes, counted } = countedDays(hours.filter((h) => h.staff_id === s.id));
    // Each wage covers its start date up to the day before the next one; only the part inside [from, to] counts.
    const own = rates.filter((r) => r.staff_id === s.id);
    let wagesCents = 0;
    const parts: string[] = [];
    let payType: PayType = 'none';
    own.forEach((r, i) => {
      const segFrom = r.f > from ? r.f : from;
      const end = own[i + 1] ? addDaysToDate(own[i + 1].f, -1) : to;
      const segTo = end < to ? end : to;
      if (segFrom > segTo) return;
      payType = r.pay_type;
      if (r.pay_type === 'hourly' && r.hourly_rate_cents != null) {
        const m = [...counted].filter(([d]) => d >= segFrom && d <= segTo).reduce((a, [, mins]) => a + mins, 0);
        wagesCents += Math.round((m / 60) * r.hourly_rate_cents);
        parts.push(`${(m / 60).toFixed(2)} hours × ${money(r.hourly_rate_cents)}/hour`);
      } else if (r.pay_type === 'salary' && r.salary_cents != null) {
        const n = days(segFrom, segTo);
        wagesCents += Math.round(((r.salary_cents * PERIODS_PER_YEAR[r.salary_period as SalaryPeriod]) / 365) * n);
        parts.push(`${money(r.salary_cents)} per ${PERIOD_LABEL[r.salary_period as SalaryPeriod]}, prorated for ${n} day${n === 1 ? '' : 's'}`);
      }
    });
    if (!own.length) payType = s.pay_type;
    out.set(s.id, { payType, minutes: squareMinutes + manualMinutes, squareMinutes, manualMinutes, wagesCents, basis: parts.length ? parts.join(' + ') : 'No wage set.' });
  }
  return out;
}

/** Which Square team member and location a person's timecards go to. */
export async function squareTarget(staffId: string) {
  const s = await db().one<any>(
    `SELECT s.name, s.square_team_member_id, c.square_location_id AS code_location
       FROM staff s LEFT JOIN staff_login_codes c ON c.staff_id = s.id WHERE s.id = $1`, [staffId]);
  if (!s) throw notFound('That team member');
  if (!s.square_team_member_id) throw badRequest(`${s.name} isn’t linked to a Square team member yet (Users & Permissions → Account).`);
  // Location: the person's Square location, else the salon's only one, else the inventory location setting.
  const locations = await db().query<any>('SELECT square_location_id FROM locations WHERE square_location_id IS NOT NULL');
  const locationId: string | null = s.code_location ?? (locations.length === 1 ? locations[0].square_location_id : null) ?? config().SQUARE_INVENTORY_LOCATION_ID ?? null;
  if (!locationId) throw badRequest(`Choose ${s.name}’s Square location first (Users & Permissions → Account → Square location).`);
  return { name: s.name as string, teamMemberId: s.square_team_member_id as string, locationId };
}

/** squareTarget plus their assigned job in Square (best effort: no job → Square's default). */
export async function squareTargetWithJob(sq: SquareService, staffId: string) {
  const t = await squareTarget(staffId);
  const job = await sq.assignedJob(t.teamMemberId).catch(() => null);
  return { ...t, job };
}

export function timecardScopeHint(e: unknown) {
  if (e instanceof IntegrationError && e.authProblem) {
    return new IntegrationError('square', 'Square didn’t allow adding timecards. Approve TIMECARDS_WRITE: Settings → API & Integrations → Connect Square.', false, true, e.technical);
  }
  return e;
}

/**
 * Sends a day's hours entered in the CRM (Payroll hours, or added by hand) to Square as a closed timecard, starting at
 * their scheduled start for that day (their normal start on an unscheduled day; 9:00 AM salon time with no schedule). Only for days with no Square timecard yet (those are changed in Square). Afterwards the day's
 * hours come from that timecard, so nothing is counted twice.
 */
/**
 * Start over for one person: every hour saved in the CRM for these dates is deleted (typed-in days, weekly totals,
 * hand-added hours, time clock hours kept here only, and the copies of Square's timecards), then their hours are read
 * fresh from Square's timecards. Nothing is deleted in Square. Time clock shifts stay listed.
 */
export async function clearHours(sq: SquareService | null, staffId: string, from: string, to: string) {
  const removed = await db().tx(async (q) => {
    const gone = await q.query<{ id: string }>('DELETE FROM staff_hours WHERE staff_id = $1 AND work_date BETWEEN $2::date AND $3::date RETURNING id', [staffId, from, to]);
    await q.query('UPDATE time_clock_shifts SET staff_hours_id = NULL WHERE staff_hours_id = ANY($1::uuid[])', [gone.map((g) => g.id)]);
    return gone.length;
  });
  if (!sq) return { removed, reloaded: false };
  const tz = (await getSettings()).business.timezone;
  const start = zonedToUtc(+from.slice(0, 4), +from.slice(5, 7), +from.slice(8, 10), 0, 0, tz);
  const end = new Date(zonedToUtc(+to.slice(0, 4), +to.slice(5, 7), +to.slice(8, 10), 0, 0, tz).getTime() + 24 * 3600_000 - 1);
  await syncTimecards(sq, new Date(start.getTime() - 24 * 3600_000), new Date(end.getTime() + 24 * 3600_000));
  return { removed, reloaded: !(await hoursSyncError()) };
}

/**
 * Hours typed into Payroll hours for a day become that day in Square: the person's timecards that day are replaced by
 * one timecard of the entered hours (starting when their first timecard that day started, else their scheduled start).
 * Nothing changes when Square already has exactly those hours (e.g. Square's own hours imported into the box).
 * Returns false when nothing needed changing.
 */
export async function updateDayInSquare(sq: SquareService, staffId: string, date: string) {
  const minutes = (await db().one<{ m: number | null }>(
    `SELECT sum(minutes)::int AS m FROM staff_hours WHERE staff_id = $1 AND work_date = $2::date AND source = 'timesheet'`, [staffId, date]))?.m ?? 0;
  if (minutes <= 0) return false;
  const { teamMemberId, locationId, job } = await squareTargetWithJob(sq, staffId);
  const tz = (await getSettings()).business.timezone;
  const dayStart = zonedToUtc(+date.slice(0, 4), +date.slice(5, 7), +date.slice(8, 10), 0, 0, tz);
  const cards = (await sq.listTimecards(dayStart, new Date(dayStart.getTime() + 24 * 3600_000 - 1)))
    .filter((c) => c.team_member_id === teamMemberId && localDate(new Date(c.start_at), tz) === date);
  const synced = await db().query<{ square_timecard_id: string; minutes: number }>(
    `SELECT square_timecard_id, minutes FROM staff_hours WHERE staff_id = $1 AND work_date = $2::date AND source = 'square' AND square_timecard_id IS NOT NULL`, [staffId, date]);
  const ids = [...new Set([...cards.map((c) => c.id), ...synced.map((r) => r.square_timecard_id)])];
  if (ids.length && synced.length === ids.length && synced.reduce((a, r) => a + r.minutes, 0) === minutes) return false;
  let startAt: Date;
  if (cards.length) startAt = new Date(Math.min(...cards.map((c) => Date.parse(c.start_at))));
  else {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const sched = await db().one<{ start_time: string }>(
      `SELECT start_time FROM staff_schedules WHERE staff_id = $1 AND start_time IS NOT NULL
        ORDER BY (weekday = $2) DESC, count(*) OVER (PARTITION BY start_time) DESC, start_time LIMIT 1`, [staffId, weekday]);
    const [sh, sm] = (sched?.start_time ?? '09:00').split(':').map(Number);
    startAt = zonedToUtc(+date.slice(0, 4), +date.slice(5, 7), +date.slice(8, 10), sh, sm, tz);
  }
  let id: string;
  try {
    for (const old of ids) await sq.deleteTimecard(old);
    id = await sq.createTimecard({ teamMemberId, locationId, startAt, endAt: new Date(startAt.getTime() + minutes * 60_000), job },
      `crm-day-${staffId}-${date}-${Date.now().toString(36)}`);
  } catch (e) {
    throw timecardScopeHint(e);
  }
  // The box still decides the day's hours; Square's row is kept in step so a sync doesn't change anything.
  await db().tx(async (q) => {
    await q.query('DELETE FROM staff_hours WHERE square_timecard_id = ANY($1::text[])', [ids]);
    await q.query(`INSERT INTO staff_hours(staff_id, work_date, minutes, source, square_timecard_id, note) VALUES ($1,$2,$3,'square',$4,'Payroll hours')
      ON CONFLICT (square_timecard_id) DO NOTHING`, [staffId, date, minutes, id]);
    // Time clock shifts that day no longer own the replaced timecards.
    await q.query(`UPDATE time_clock_shifts SET square_timecard_ids = ARRAY(SELECT x FROM unnest(square_timecard_ids) x WHERE NOT (x = ANY($2::text[])))
      WHERE staff_id = $1 AND square_timecard_ids && $2::text[]`, [staffId, ids]);
  });
  return true;
}

export async function sendDayToSquare(sq: SquareService, staffId: string, date: string) {
  const { name, teamMemberId, locationId, job } = await squareTargetWithJob(sq, staffId);
  const s = { name };
  const rows = await db().query<any>(`SELECT source, sum(minutes)::int AS m FROM staff_hours WHERE staff_id = $1 AND work_date = $2::date AND coalesce(note, '') <> '${WEEK_NOTE}' GROUP BY source`, [staffId, date]);
  const of = (src: string) => rows.find((r) => r.source === src)?.m ?? 0;
  if (of('square') > 0) throw badRequest(`Square already has a timecard for ${s.name} on ${date}. Change it in Square.`);
  const minutes = rows.some((r) => r.source === 'timesheet') ? of('timesheet') : of('manual');
  if (minutes <= 0) throw badRequest(`No hours entered for ${s.name} on ${date}.`);
  const tz = (await getSettings()).business.timezone;
  // Square may have a timecard that day that isn't synced yet: never add a second one.
  const dayStart = zonedToUtc(+date.slice(0, 4), +date.slice(5, 7), +date.slice(8, 10), 0, 0, tz);
  const already = (await sq.listTimecards(dayStart, new Date(dayStart.getTime() + 24 * 3600_000 - 1)).catch(() => []))
    .some((c) => c.team_member_id === teamMemberId && localDate(new Date(c.start_at), tz) === date);
  if (already) throw badRequest(`Square already has a timecard for ${s.name} on ${date}. Change it in Square.`);
  // Starts at their scheduled start for that weekday. Working a day they aren't scheduled: their normal start (the
  // start time they're scheduled most often), or 9:00 AM with no schedule at all.
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const sched = await db().one<{ start_time: string }>(
    `SELECT start_time FROM staff_schedules WHERE staff_id = $1 AND start_time IS NOT NULL
      ORDER BY (weekday = $2) DESC, count(*) OVER (PARTITION BY start_time) DESC, start_time LIMIT 1`, [staffId, weekday]);
  const [sh, sm] = (sched?.start_time ?? '09:00').split(':').map(Number);
  const startAt = zonedToUtc(+date.slice(0, 4), +date.slice(5, 7), +date.slice(8, 10), sh, sm, tz);
  const endAt = new Date(startAt.getTime() + minutes * 60_000);
  let id: string;
  try {
    id = await sq.createTimecard({ teamMemberId, locationId, startAt, endAt, job }, `crm-hours-${staffId}-${date}-${minutes}`);
  } catch (e) {
    throw timecardScopeHint(e);
  }
  // The day's hours now come from that timecard.
  await db().tx(async (q) => {
    await q.query(`DELETE FROM staff_hours WHERE staff_id = $1 AND work_date = $2::date AND source IN ('manual','timesheet') AND coalesce(note, '') <> '${WEEK_NOTE}'`, [staffId, date]);
    await q.query(
      `INSERT INTO staff_hours(staff_id, work_date, minutes, source, square_timecard_id, note) VALUES ($1,$2,$3,'square',$4,'Sent from the CRM')
       ON CONFLICT (square_timecard_id) DO NOTHING`, [staffId, date, minutes, id]);
  });
  return { timecardId: id, minutes };
}
