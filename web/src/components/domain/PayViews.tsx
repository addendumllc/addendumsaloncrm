import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PayPeriodRowDTO, PaySummaryDTO, TaxEstimateDTO } from '@addendum/shared';
import { ChevronDown, ChevronLeft, ChevronRight, Columns3, Plus } from 'lucide-react';
import { api } from '../../api/client';
import { dayKey, labelOfKey } from '../../lib/format';
import { Button, PageLoading, cx, useToast } from '../ui';
import { usd } from './Commission';

/** Hours always with 2 decimals (8.00, 9.25). */
const hrs = (m: number) => (m / 60).toFixed(2);
const fmt = (k: string) => labelOfKey(k, { month: 'short', day: 'numeric' });

/** Commission tab: hours worked, estimated wages and estimated net pay for the dates shown. */
export function HoursWagesCard({ pay, taxes }: { pay: PaySummaryDTO; taxes?: TaxEstimateDTO | null }) {
  return (
    <div className={`mb-3 grid gap-3 ${taxes ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
      <div className="rounded-xl2 border border-line bg-white px-4 py-3">
        <p className="text-[12px] font-medium uppercase tracking-wide text-stone">Hours worked</p>
        <p className="num mt-1 font-display text-[28px] leading-none text-ink">{hrs(pay.minutes)}</p>
        <p className="mt-1 text-[12px] text-stone">{pay.minutes ? `${hrs(pay.squareMinutes)} from Square timecards${pay.manualMinutes ? ` · ${hrs(pay.manualMinutes)} added by payroll` : ''}` : 'No hours recorded for these dates yet.'}</p>
        {/* Admins only (the server leaves it out for everyone else): time with clients, paid as commission. */}
        {(pay.servicingMinutes ?? 0) > 0 && <p className="text-[12px] text-stone">{hrs(pay.servicingMinutes!)} with clients (commission) · {hrs(pay.minutes - pay.servicingMinutes!)} hourly</p>}
      </div>
      <div className="rounded-xl2 border border-line bg-white px-4 py-3">
        <p className="text-[12px] font-medium uppercase tracking-wide text-stone">Estimated wages</p>
        <p className="num mt-1 font-display text-[28px] leading-none text-ink">{pay.payType === 'none' ? '—' : usd(pay.wagesCents)}</p>
        <p className="mt-1 text-[12px] text-stone">{pay.payType === 'none' ? 'Commission and tips only (no wage set).' : pay.basis}</p>
      </div>
      {taxes && (
        <div className="rounded-xl2 border border-line bg-white px-4 py-3">
          <p className="text-[12px] font-medium uppercase tracking-wide text-stone">Estimated net</p>
          <p className="num mt-1 font-display text-[28px] leading-none text-ink">{usd(taxes.netCents)}</p>
          <p className="mt-1 text-[12px] text-stone">{usd(taxes.grossCents)} gross (commission + tips + wages){taxes.workerType === '1099' ? ' · 1099, nothing withheld' : ` − ${usd(taxes.withheldCents)} est. taxes`}</p>
        </div>
      )}
    </div>
  );
}

/** Taxes tab: estimated withholding on commission + tips + wages for the dates shown. */
export function TaxesPanel({ taxes }: { taxes: TaxEstimateDTO | null }) {
  if (!taxes) return <p className="text-[14px] text-stone">No tax details yet.</p>;
  const row = (label: string, cents: number, strong = false) => (
    <div className="flex justify-between gap-4 py-2"><span className={strong ? 'font-medium text-ink' : 'text-ink-soft'}>{label}</span><span className={`num ${strong ? 'font-medium text-ink' : ''}`}>{usd(cents)}</span></div>
  );
  return (
    <div className="max-w-xl rounded-xl2 border border-line bg-white px-4 py-2 text-[14px]">
      <div className="divide-y divide-line">
        {row('Gross pay (commission + tips + wages)', taxes.grossCents, true)}
        {taxes.workerType === '1099' ? (
          <p className="py-2 text-ink-soft">1099 contractor — nothing is withheld; taxes are handled by the contractor.</p>
        ) : (
          <>
            {row('Federal income tax', -taxes.federalCents)}
            {row('Social Security', -taxes.socialSecurityCents)}
            {row('Medicare', -taxes.medicareCents)}
            {row('CA state income tax', -taxes.stateCents)}
            {taxes.sdiCents > 0 && row('CA disability insurance (SDI)', -taxes.sdiCents)}
            {taxes.localCents > 0 && row('Local tax', -taxes.localCents)}
            {(taxes.cushionCents ?? 0) > 0 && row('Cushion (keeps the estimate under your real pay)', -(taxes.cushionCents ?? 0))}
            {row('Estimated net pay', taxes.netCents, true)}
          </>
        )}
      </div>
      <p className="py-2 text-[12px] text-stone">Estimates only — payroll calculates the actual withholding.</p>
    </div>
  );
}

/** Year tab: one line per pay period paid in the year. `showPaid` adds the payday column (Team Commission). */
/** Estimated withholding, tax by tax (adds up to "Est. taxes"). */
const TAX_PARTS = [
  ['federalCents', 'Federal income tax'], ['socialSecurityCents', 'Social Security'], ['medicareCents', 'Medicare'],
  ['stateCents', 'CA state income tax'], ['sdiCents', 'CA disability (SDI)'], ['localCents', 'Local tax'],
] as const;

/** The optional earnings columns: not everyone has commission, tips, wages or hours. */
const OPTIONAL = [['minutes', 'Hours'], ['commissionCents', 'Commission'], ['tipsCents', 'Tips'], ['wagesCents', 'Wages']] as const;
type Optional = (typeof OPTIONAL)[number][0];
const COLS_KEY = 'addendum:year-columns';

/**
 * Add hours to one pay period (Team Commission → a person → Year): saved as manual hours on the period's last day
 * (or today, for the current period), noted with the period's dates.
 */
function AddPeriodHours({ staffId, row, onDone }: { staffId: string; row: PayPeriodRowDTO; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState('');
  const [busy, setBusy] = useState(false);
  const n = Number(hours);
  const save = async () => {
    setBusy(true);
    try {
      const today = dayKey(new Date());
      await api.post('/commission/hours', { staffId, date: row.to < today ? row.to : today, hours: n, note: `Pay period ${fmt(row.from)} – ${fmt(row.to)}` });
      toast(`${n} hours added to ${fmt(row.from)} – ${fmt(row.to)}`);
      setHours(''); setOpen(false); onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <button type="button" className="inline-flex items-center gap-1 text-[12px] text-plum hover:underline" onClick={() => setOpen(true)}><Plus className="h-3.5 w-3.5" />Add hours</button>;
  return (
    <span className="inline-flex items-center gap-1">
      <input autoFocus inputMode="decimal" className="w-16 rounded-md border border-line bg-white px-1.5 py-0.5 text-right text-[13px] num" placeholder="hrs" value={hours} onChange={(e) => setHours(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && n > 0) void save(); if (e.key === 'Escape') setOpen(false); }} aria-label={`Hours to add to ${fmt(row.from)} – ${fmt(row.to)}`} />
      <Button size="sm" variant="primary" loading={busy} disabled={!(n > 0 && n <= 744)} onClick={save}>Add</Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </span>
  );
}

/** `staffId` (people who manage pay): each pay period gets "Add hours". */
export function YearTable({ url, showPaid = true, staffId }: { url: string; showPaid?: boolean; staffId?: string }) {
  const qc = useQueryClient();
  const refreshPay = () => { for (const k of ['pay-year', 'commission-staff', 'pay']) void qc.invalidateQueries({ queryKey: [k] }); };
  const [year, setYear] = useState(Number(dayKey(new Date()).slice(0, 4)));
  // Columns chosen in the dropdown (remembered on this device). Until someone chooses, columns that are zero all year are hidden.
  const [chosen, setChosen] = useState<Optional[] | null>(() => { try { const v = localStorage.getItem(COLS_KEY); return v ? JSON.parse(v) : null; } catch { return null; } });
  const choose = (v: Optional[] | null) => { setChosen(v); try { if (v) localStorage.setItem(COLS_KEY, JSON.stringify(v)); else localStorage.removeItem(COLS_KEY); } catch { /* private window */ } };
  const { data, isLoading } = useQuery({ queryKey: ['pay-year', url, year], queryFn: () => api.get<{ rows: PayPeriodRowDTO[]; showTaxBreakdown?: boolean }>(`${url}?year=${year}`) });
  const today = dayKey(new Date());
  const rows = data?.rows ?? [];
  const sum = (k: keyof PayPeriodRowDTO) => rows.reduce((a, r) => a + ((r[k] as number) ?? 0), 0);
  // Tax-by-tax columns: when turned on for this person; the toggle hides or shows them on this screen.
  const allowed = data?.showTaxBreakdown ?? false;
  const [breakdown, setBreakdown] = useState(true);
  const parts = allowed && breakdown ? TAX_PARTS.filter(([k]) => k !== 'localCents' || sum('localCents') > 0) : [];
  const cell = 'num px-3 py-2 text-right';
  const auto = OPTIONAL.filter(([k]) => rows.some((r) => ((r[k] as number) ?? 0) !== 0)).map(([k]) => k);
  const shown = new Set<Optional>(chosen ?? (rows.length ? auto : OPTIONAL.map(([k]) => k)));
  const toggle = (k: Optional) => { const next = new Set(shown); if (next.has(k)) next.delete(k); else next.add(k); choose(OPTIONAL.map(([x]) => x).filter((x) => next.has(x))); };
  const val = (r: PayPeriodRowDTO | null, k: Optional) => { const n = r ? (r[k] as number) ?? 0 : sum(k); return k === 'minutes' ? hrs(n) : usd(n); };
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1">
        <Button size="sm" variant="ghost" icon={<ChevronLeft className="h-4 w-4" />} onClick={() => setYear(year - 1)} aria-label="Previous year" />
        <span className="min-w-[60px] text-center text-[15px] font-medium text-ink">{year}</span>
        <Button size="sm" variant="ghost" icon={<ChevronRight className="h-4 w-4" />} onClick={() => setYear(year + 1)} aria-label="Next year" />
        <details className="relative ml-auto">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg border border-line-strong bg-white px-3 py-1.5 text-[13px] font-medium text-ink-soft hover:bg-mist/60">
            <Columns3 className="h-4 w-4" />Columns<ChevronDown className="h-3.5 w-3.5" />
          </summary>
          <div className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-line bg-white p-2 shadow-pop">
            {OPTIONAL.map(([k, label]) => (
              <label key={k} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[14px] hover:bg-mist/60">
                <input type="checkbox" className="h-4 w-4 accent-plum" checked={shown.has(k)} onChange={() => toggle(k)} />{label}
                {rows.length > 0 && !auto.includes(k) && <span className="ml-auto text-[11px] text-stone">none this year</span>}
              </label>
            ))}
            <p className="px-2 pt-1 text-[11px] text-stone">Gross, taxes and net always show.</p>
            {chosen && <button type="button" className="px-2 pt-1 text-[12px] text-plum underline" onClick={() => choose(null)}>Only show what I have</button>}
          </div>
        </details>
        {allowed && (
          <label className="flex items-center gap-2 text-[13px] text-ink-soft">
            <input type="checkbox" checked={breakdown} onChange={(e) => setBreakdown(e.target.checked)} />Show tax breakdown
          </label>
        )}
      </div>
      {/* Phones: one card per pay period (the chosen columns, then gross, taxes and net). */}
      {!isLoading && (
        <ul className="space-y-2 sm:hidden">
          {[...rows].reverse().filter((r) => r.from <= today).map((r) => {
            const current = r.from <= today && r.to >= today;
            return (
              <li key={r.from} className={cx('rounded-xl2 border bg-white p-3', current ? 'border-plum/40' : 'border-line')}>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-[15px] font-medium text-ink">{fmt(r.from)} – {fmt(r.to)}{current && <span className="ml-1.5 text-[12px] text-plum">current</span>}</p>
                  <p className="num text-[17px] font-medium text-ink">{usd(r.netCents)}<span className="ml-1 text-[11px] font-normal text-stone">net</span></p>
                </div>
                {showPaid && <p className="text-[12px] text-stone">Paid {fmt(r.payDate)}</p>}
                {staffId && <div className="mt-1"><AddPeriodHours staffId={staffId} row={r} onDone={refreshPay} /></div>}
                <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 text-[13px]">
                  {OPTIONAL.filter(([k]) => shown.has(k)).map(([k, label]) => <div key={k}><dt className="text-[11px] text-stone">{label}</dt><dd className="num text-ink">{val(r, k)}</dd></div>)}
                  <div><dt className="text-[11px] text-stone">Gross</dt><dd className="num font-medium text-ink">{usd(r.grossCents)}</dd></div>
                  <div><dt className="text-[11px] text-stone">Est. taxes</dt><dd className="num text-ink-soft">{usd(r.withheldCents)}</dd></div>
                  {parts.map(([k, label]) => <div key={k}><dt className="text-[11px] text-stone">{label}</dt><dd className="num text-ink-soft">{usd(r[k] ?? 0)}</dd></div>)}
                </dl>
              </li>
            );
          })}
          {rows.length > 0 && (
            <li className="rounded-xl2 border border-line bg-mist/40 p-3 text-[13px]">
              <p className="font-medium text-ink">Year total</p>
              <dl className="mt-1 grid grid-cols-3 gap-x-3 gap-y-1">
                {OPTIONAL.filter(([k]) => shown.has(k)).map(([k, label]) => <div key={k}><dt className="text-[11px] text-stone">{label}</dt><dd className="num">{val(null, k)}</dd></div>)}
                <div><dt className="text-[11px] text-stone">Gross</dt><dd className="num font-medium">{usd(sum('grossCents'))}</dd></div>
                <div><dt className="text-[11px] text-stone">Est. taxes</dt><dd className="num">{usd(sum('withheldCents'))}</dd></div>
                <div><dt className="text-[11px] text-stone">Est. net</dt><dd className="num font-medium">{usd(sum('netCents'))}</dd></div>
              </dl>
            </li>
          )}
        </ul>
      )}
      {isLoading ? <PageLoading /> : (
        <div className="hidden overflow-x-auto rounded-xl2 border border-line bg-white sm:block">
          <table className={cx('w-full text-left text-[14px]', parts.length ? 'min-w-[1300px]' : shown.size > 2 ? 'min-w-[820px]' : 'min-w-[560px]')}>
            <thead className="border-b border-line bg-mist/50 text-[12px] uppercase tracking-wide text-stone">
              <tr>
                <th className="px-4 py-2 font-medium">Pay period</th>{showPaid && <th className="px-3 py-2 font-medium">Paid</th>}{OPTIONAL.filter(([k]) => shown.has(k)).map(([k, label]) => <th key={k} className="px-3 py-2 text-right font-medium">{label}</th>)}<th className="px-3 py-2 text-right font-medium">Gross</th>
                {parts.map(([k, label]) => <th key={k} className="px-3 py-2 text-right font-medium normal-case">{label}</th>)}
                <th className="px-3 py-2 text-right font-medium">Est. taxes</th><th className="px-3 py-2 text-right font-medium">Est. net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.from} className={r.from > today ? 'text-stone' : r.from <= today && r.to >= today ? 'bg-mist/30' : ''}>
                  <td className="px-4 py-2">{fmt(r.from)} – {fmt(r.to)}{r.from <= today && r.to >= today && <span className="ml-1.5 text-[12px] text-plum">current</span>}
                    {staffId && r.from <= today && <span className="block"><AddPeriodHours staffId={staffId} row={r} onDone={refreshPay} /></span>}</td>
                  {showPaid && <td className="px-3 py-2 text-ink-soft">{fmt(r.payDate)}</td>}
                  {OPTIONAL.filter(([k]) => shown.has(k)).map(([k]) => <td key={k} className={cell}>{val(r, k)}</td>)}
                  <td className={`${cell} font-medium`}>{usd(r.grossCents)}</td>
                  {parts.map(([k]) => <td key={k} className={`${cell} text-ink-soft`}>{usd(r[k] ?? 0)}</td>)}
                  <td className={cell}>{usd(r.withheldCents)}</td>
                  <td className={`${cell} font-medium`}>{usd(r.netCents)}</td>
                </tr>
              ))}
              {rows.length > 0 && (
                <tr className="bg-mist/40 font-medium">
                  <td className="px-4 py-2" colSpan={showPaid ? 2 : 1}>Year total</td>
                  {OPTIONAL.filter(([k]) => shown.has(k)).map(([k]) => <td key={k} className={cell}>{val(null, k)}</td>)}<td className={cell}>{usd(sum('grossCents'))}</td>
                  {parts.map(([k]) => <td key={k} className={cell}>{usd(sum(k))}</td>)}
                  <td className={cell}>{usd(sum('withheldCents'))}</td><td className={cell}>{usd(sum('netCents'))}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[12px] text-stone">Pay periods paid in {year}. Taxes and net pay are estimates — payroll calculates the actual amounts{parts.length ? ' (Social Security’s yearly wage limit isn’t applied)' : ''}.</p>
    </div>
  );
}
