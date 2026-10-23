import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommissionSettings, PayRateDTO, PaySummaryDTO, SalaryPeriod, StaffHoursDTO, StaffPayDTO, StaffTaxDTO } from '@addendum/shared';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import { useCanDo } from '../../api/hooks';
import { addDaysKey, dayKey, labelOfKey } from '../../lib/format';
import { Badge, Button, Field, Segmented, Spinner, Toggle, useToast } from '../../components/ui';

const PERIODS: [SalaryPeriod, string][] = [['week', 'per week'], ['biweekly', 'every 2 weeks'], ['semimonthly', 'twice a month'], ['month', 'per month'], ['year', 'per year']];
const usd = (c: number) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Hours always with 2 decimals (8.00 h). */
const hrs = (m: number) => `${(m / 60).toFixed(2)} h`;
const toCents = (v: string) => (v.trim() === '' ? null : Math.round(Number(v) * 100));
const toBps = toCents; // "12.5" % → 1250
const str = (c: number | null) => (c == null ? '' : String(c / 100));
type TaxDraft = {
  workerType: StaffTaxDTO['workerType']; federal: string; state: string; local: string; filingStatus: string; multipleJobs: boolean; dependents: string; otherIncome: string; deductions: string; extra: string;
  de4Exempt: boolean; de4Status: string; de4Regular: string; de4Additional: string; de4Extra: string; showBreakdown: boolean;
};
/** State (and city) from the salon's work address, e.g. "12853 El Camino Real Ste 104, San Diego, CA 92130". */
type TaxLocation = { address: string; state: string | null; stateName: string; city: string | null };
const STATE_NAMES: Record<string, string> = { CA: 'California', NY: 'New York', TX: 'Texas', FL: 'Florida', WA: 'Washington', NV: 'Nevada', AZ: 'Arizona', OR: 'Oregon', IL: 'Illinois', NJ: 'New Jersey', CO: 'Colorado', GA: 'Georgia', MA: 'Massachusetts', PA: 'Pennsylvania' };
function taxLocation(address: string): TaxLocation {
  const m = address.match(/,\s*([^,]+?),\s*([A-Z]{2})\s*\d{5}(-\d{4})?\s*$/);
  const state = m ? m[2] : null;
  return { address, state, stateName: state ? STATE_NAMES[state] ?? state : 'State', city: m ? m[1].trim() : null };
}
const int = (v: string) => Math.max(0, Math.min(99, Math.round(Number(v) || 0)));
// Boxes always show a value: 0 % and 0.00 when nothing is set (saved as "not set", which counts as 0).
const pctBox = (b: number | null) => (b == null ? '0' : String(b / 100));
const moneyBox = (c: number | null) => ((c ?? 0) / 100).toFixed(2);
const orNull = (c: number | null) => (c ? c : null);
const taxDraft = (t: StaffTaxDTO): TaxDraft => ({
  workerType: t.workerType, federal: pctBox(t.federalBps), state: pctBox(t.stateBps), local: pctBox(t.localBps), filingStatus: t.w4.filingStatus ?? '', multipleJobs: t.w4.multipleJobs,
  dependents: moneyBox(t.w4.dependentsCents), otherIncome: moneyBox(t.w4.otherIncomeCents), deductions: moneyBox(t.w4.deductionsCents), extra: moneyBox(t.w4.extraWithholdingCents),
  de4Exempt: t.de4.exempt, de4Status: t.de4.filingStatus ?? '', de4Regular: String(t.de4.regularAllowances), de4Additional: String(t.de4.additionalAllowances),
  de4Extra: (t.de4.additionalWithholdingCents / 100).toFixed(2), showBreakdown: t.showBreakdown ?? true,
});
const taxBody = (t: TaxDraft): StaffTaxDTO => ({
  workerType: t.workerType, federalBps: orNull(toBps(t.federal)), stateBps: orNull(toBps(t.state)), localBps: orNull(toBps(t.local)), showBreakdown: t.showBreakdown,
  w4: { filingStatus: (t.filingStatus || null) as StaffTaxDTO['w4']['filingStatus'], multipleJobs: t.multipleJobs, dependentsCents: orNull(toCents(t.dependents)), otherIncomeCents: orNull(toCents(t.otherIncome)), deductionsCents: orNull(toCents(t.deductions)), extraWithholdingCents: orNull(toCents(t.extra)) },
  de4: {
    exempt: t.de4Exempt, filingStatus: (t.de4Status || null) as StaffTaxDTO['de4']['filingStatus'], regularAllowances: int(t.de4Regular),
    additionalAllowances: int(t.de4Additional), additionalWithholdingCents: toCents(t.de4Extra) ?? 0,
  },
});

/**
 * Users & Permissions → one person: how they're paid besides commission (hourly or salary), whether they get tips, and
 * their hours — from Square timecards and entered by hand. Wages show on Team Payroll and in the pay summary export.
 */
export function WagesSection({ staffId, staffName, part }: { staffId: string; staffName: string; part?: 'pay' | 'taxes' }) {
  // The salon's work address decides the state (and local) tax section, e.g. California → DE 4.
  const { data: commission } = useQuery({ queryKey: ['commission-rules'], queryFn: () => api.get<{ settings: CommissionSettings }>('/commission/rules') });
  const location = taxLocation(commission?.settings.payrollTaxes.workAddress ?? '');
  const canDo = useCanDo();
  const editable = canDo('commission:manage');
  const toast = useToast();
  const qc = useQueryClient();
  const today = dayKey(new Date());
  const range = { from: addDaysKey(today, -27), to: today };
  const { data } = useQuery({
    queryKey: ['staff-pay', staffId, range.from],
    queryFn: () => api.get<{ pay: StaffPayDTO; hours: StaffHoursDTO[]; summary: PaySummaryDTO }>(`/commission/pay/${staffId}?from=${range.from}&to=${range.to}`),
  });
  const [d, setD] = useState<{ payType: StaffPayDTO['payType']; hourly: string; salary: string; period: SalaryPeriod; tipEligible: boolean; tax: TaxDraft } | null>(null);
  const [saving, setSaving] = useState(false);
  // When a changed wage starts: today by default; empty = from the beginning (only offered for someone's first wage).
  const [startsOn, setStartsOn] = useState(today);
  const [entry, setEntry] = useState({ date: today, hours: '', note: '' });
  const first = staffName.split(' ')[0];
  useEffect(() => {
    if (data) setD({ payType: data.pay.payType, hourly: data.pay.hourlyRateCents != null ? String(data.pay.hourlyRateCents / 100) : '', salary: data.pay.salaryCents != null ? String(data.pay.salaryCents / 100) : '', period: data.pay.salaryPeriod, tipEligible: data.pay.tipEligible, tax: taxDraft(data.pay.taxes) });
  }, [data]);
  if (!data || !d) return <div className="flex justify-center py-4"><Spinner /></div>;

  const reload = () => {
    for (const k of ['staff-pay', 'commission-team', 'commission-staff', 'commission-review']) qc.invalidateQueries({ queryKey: [k] });
  };
  const saved = data.pay;
  const wageChanged = d.payType !== saved.payType || toCents(d.hourly) !== saved.hourlyRateCents || toCents(d.salary) !== saved.salaryCents || d.period !== saved.salaryPeriod;
  const firstWage = saved.rates.length === 0;
  const dirty = d.payType !== saved.payType || toCents(d.hourly) !== saved.hourlyRateCents || toCents(d.salary) !== saved.salaryCents || d.period !== saved.salaryPeriod || d.tipEligible !== saved.tipEligible
    || JSON.stringify(taxBody(d.tax)) !== JSON.stringify(taxBody(taxDraft(saved.taxes)));
  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/commission/pay/${staffId}`, { payType: d.payType, hourlyRateCents: toCents(d.hourly), salaryCents: toCents(d.salary), salaryPeriod: d.period, tipEligible: d.tipEligible, taxes: taxBody(d.tax), effectiveFrom: firstWage && !startsOn ? null : startsOn || today });
      toast(d.tipEligible !== saved.tipEligible ? 'Saved. Tips were recalculated (finalized periods don’t change).' : 'Saved');
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const addHours = async () => {
    try {
      await api.post('/commission/hours', { staffId, date: entry.date, hours: Number(entry.hours), note: entry.note.trim() || null });
      toast('Hours added');
      setEntry({ ...entry, hours: '', note: '' });
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const removeHours = async (h: StaffHoursDTO) => {
    try {
      await api.del(`/commission/hours/${h.id}`);
      toast('Hours removed');
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="space-y-4">
      {part !== 'taxes' && <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Pay">
          <select className="field" disabled={!editable} value={d.payType} onChange={(e) => setD({ ...d, payType: e.target.value as StaffPayDTO['payType'] })}>
            <option value="none">Commission and tips only</option><option value="hourly">Hourly wage</option><option value="salary">Salary</option>
          </select>
        </Field>
        {d.payType === 'hourly' && (
          <Field label="Hourly rate"><div className="flex items-center gap-2"><span className="text-stone">$</span><input type="number" min={0} step="0.01" className="field num w-32" disabled={!editable} value={d.hourly} onChange={(e) => setD({ ...d, hourly: e.target.value })} /><span className="text-stone">/ hour</span></div></Field>
        )}
        {d.payType === 'salary' && (
          <Field label="Salary">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-stone">$</span><input type="number" min={0} step="0.01" className="field num w-32" disabled={!editable} value={d.salary} onChange={(e) => setD({ ...d, salary: e.target.value })} />
              <select className="field w-auto" disabled={!editable} value={d.period} onChange={(e) => setD({ ...d, period: e.target.value as SalaryPeriod })}>{PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </div>
          </Field>
        )}
      </div>
      {editable && wageChanged && (
        <Field label={firstWage ? 'This wage starts on' : 'New wage starts on'} hint={firstWage ? 'Leave empty to use it for all past hours too.' : 'Hours before this date stay at the earlier wage. You can correct past wages in the history below.'}>
          <input type="date" className="field w-auto" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </Field>
      )}
      {(saved.rates.length > 0 || editable) && <RateHistory staffId={staffId} rates={saved.rates} editable={editable} onChanged={reload} />}
      <Toggle checked={d.tipEligible} disabled={!editable} onChange={(v) => setD({ ...d, tipEligible: v })} label="Tip eligible"
        description={d.tipEligible ? `Tips on ${first}’s work go to ${first}.` : `Tips on ${first}’s work go to Needs review on Team Payroll, to be credited by hand.`} />
      {/* Saved right away (not with Save pay). */}
      <Toggle checked={saved.suggestForCommission !== false} disabled={!editable} label="Suggest for commission"
        onChange={async (v) => { try { await api.put(`/commission/pay/${staffId}/suggest`, { suggest: v }); toast(v ? `${first} can be suggested again` : `${first} won’t be suggested for commission`); reload(); } catch (e) { toast((e as Error).message, 'error'); } }}
        description={saved.suggestForCommission !== false ? `When Square didn’t record who checked out, ${first} can be picked or suggested.` : `Never picked or suggested (e.g. not at the salon) — credit ${first} only by choosing them.`} />
      </>}
      {part !== 'pay' && <TaxFields t={d.tax} editable={editable} location={location} onChange={(tax) => setD({ ...d, tax })} />}
      {editable && dirty && <Button variant="primary" size="sm" loading={saving} onClick={save}>{part === 'taxes' ? 'Save tax information' : part === 'pay' ? 'Save pay' : 'Save pay & taxes'}</Button>}

      {part !== 'taxes' && <div>
        <p className="mb-1 flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">
          Hours, last 4 weeks: {hrs(data.summary.minutes)}
          {data.summary.wagesCents > 0 && <span className="font-normal text-stone">· wages {usd(data.summary.wagesCents)} ({data.summary.basis})</span>}
        </p>
        <p className="mb-2 text-[12px] text-stone">Closed Square timecards come in with each commission sync. Hours entered here are added on top (for shifts not clocked in Square).</p>
        {data.hours.length > 0 && (
          <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-xl border border-line">
            {data.hours.map((h) => (
              <li key={h.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                <span className="w-24 text-ink">{labelOfKey(h.date, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                <span className="num w-16 text-ink">{hrs(h.minutes)}</span>
                {h.source === 'square' ? <Badge>Square timecard</Badge> : h.source === 'timesheet' ? <Badge tone="sage">Payroll timesheet (replaces that day)</Badge> : <Badge tone="plum">By hand{h.createdByName ? ` · ${h.createdByName}` : ''}</Badge>}
                <span className="min-w-0 flex-1 truncate text-stone">{h.note}</span>
                {editable && h.source !== 'square' && <Button size="sm" variant="ghost" aria-label="Remove hours" icon={<Trash2 className="h-4 w-4" />} onClick={() => removeHours(h)} />}
              </li>
            ))}
          </ul>
        )}
        {editable && (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Field label="Date"><input type="date" className="field h-9 w-auto" max={today} value={entry.date} onChange={(e) => setEntry({ ...entry, date: e.target.value })} /></Field>
            <Field label="Hours"><input type="number" min={0.25} step={0.25} className="field num h-9 w-24" value={entry.hours} onChange={(e) => setEntry({ ...entry, hours: e.target.value })} /></Field>
            <Field label="Note (optional)"><input className="field h-9 w-48" maxLength={300} value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })} placeholder="e.g. training day" /></Field>
            <Button size="sm" icon={<Plus className="h-4 w-4" />} disabled={!(Number(entry.hours) > 0) || !entry.date} onClick={addHours}>Add hours</Button>
          </div>
        )}
      </div>}
    </div>
  );
}

/** Worker type, withholding % and W-4 details — for payroll estimates only. Never SSNs or bank details. */
function TaxFields({ t, editable, location, onChange }: { t: TaxDraft; editable: boolean; location: TaxLocation; onChange: (t: TaxDraft) => void }) {
  const [view, setView] = useState<'federal' | 'state' | 'local'>('federal');
  const set = <K extends keyof TaxDraft>(k: K, v: TaxDraft[K]) => onChange({ ...t, [k]: v });
  const pct = (k: 'federal' | 'state' | 'local', label: string) => (
    <Field label={label}><div className="flex items-center gap-1.5"><input type="number" min={0} max={100} step="0.01" className="field num w-24" disabled={!editable} value={t[k]} onChange={(e) => set(k, e.target.value)} /><span className="text-stone">%</span></div></Field>
  );
  const amt = (k: 'dependents' | 'otherIncome' | 'deductions' | 'extra', label: string, hint?: string) => (
    <Field label={label} hint={hint}><div className="flex items-center gap-1.5"><span className="text-stone">$</span><input type="number" min={0} step="0.01" className="field num w-28" disabled={!editable} value={t[k]} onChange={(e) => set(k, e.target.value)} /></div></Field>
  );
  return (
    <div className="rounded-xl border border-line p-3">
      <p className="text-[14px] font-medium text-ink">Taxes</p>
      <p className="mb-3 text-[12px] text-stone">For estimates on Team Payroll and the pay summary — your payroll provider does the real withholding. Don’t enter Social Security numbers or bank details here.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Worker type">
          <select className="field" disabled={!editable} value={t.workerType} onChange={(e) => set('workerType', e.target.value as TaxDraft['workerType'])}>
            <option value="w2">W-2 employee (taxes withheld)</option><option value="1099">1099 contractor (no withholding)</option>
          </select>
        </Field>
      </div>
      <label className="mt-3 flex items-start gap-2 text-[13px] text-ink">
        <input type="checkbox" className="mt-0.5" disabled={!editable} checked={t.showBreakdown} onChange={(e) => set('showBreakdown', e.target.checked)} />
        <span>Show the tax breakdown on their Earnings & Goals → Year<span className="block text-[12px] text-stone">Federal income tax, Social Security, Medicare, state income tax and CA SDI, per pay period (estimates).</span></span>
      </label>
      {t.workerType === 'w2' ? (
        <>
          <Segmented className="mt-4" value={view} onChange={setView} options={[
            { value: 'federal', label: 'Federal (W-4)' }, { value: 'state', label: location.state === 'CA' ? 'California (DE 4)' : location.state ? `State (${location.state})` : 'State' }, { value: 'local', label: 'Local' },
          ]} />
          {view === 'federal' && <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">{pct('federal', 'Federal withholding')}</div>
          <p className="mt-3 text-[13px] font-medium text-ink">W-4</p>
          <div className="mt-1 grid gap-3 sm:grid-cols-2">
            <Field label="Filing status (Step 1c)">
              <select className="field" disabled={!editable} value={t.filingStatus} onChange={(e) => set('filingStatus', e.target.value)}>
                <option value="">Not given</option><option value="single">Single or married filing separately</option><option value="married_jointly">Married filing jointly</option><option value="head_of_household">Head of household</option>
              </select>
            </Field>
            <div className="pt-6"><Toggle checked={t.multipleJobs} disabled={!editable} onChange={(v) => set('multipleJobs', v)} label="Multiple jobs or spouse works (Step 2)" /></div>
            {amt('dependents', 'Dependents amount (Step 3)')}
            {amt('otherIncome', 'Other income (Step 4a)')}
            {amt('deductions', 'Deductions (Step 4b)')}
            {amt('extra', 'Extra withholding (Step 4c)', 'Per paycheck')}
          </div>
          <p className="mt-2 text-[12px] text-stone">Social Security and Medicare are added automatically at the salon rates in Settings → Commission.</p>
          </>}

          {view === 'state' && <>
          <p className="mt-3 text-[12px] text-stone">Based on the salon’s work address{location.address ? `: ${location.address}` : ' (Settings → Commission → Payroll tax rates)'}.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">{pct('state', location.state ? `${location.stateName} withholding` : 'State withholding')}</div>
          {location.state === 'CA' ? (
          <div className="mt-4 border-t border-line pt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[13px] font-medium text-ink">California State Tax (DE 4)</p>
              <a className="text-[12px] text-plum underline" href="https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de4.pdf" target="_blank" rel="noreferrer">About the DE 4</a>
            </div>
            <div className="mt-2"><Toggle checked={t.de4Exempt} disabled={!editable} onChange={(v) => set('de4Exempt', v)} label="Exempt from withholding" description="This employee claims exemption from California withholding (state withholding estimate becomes $0)." /></div>
            {!t.de4Exempt && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Filing status" className="sm:col-span-2">
                  <select className="field" disabled={!editable} value={t.de4Status} onChange={(e) => set('de4Status', e.target.value)}>
                    <option value="">Not given</option>
                    <option value="single_or_married_two_incomes">Single or Married (with two or more incomes)</option>
                    <option value="married_one_income">Married (one income)</option>
                    <option value="head_of_household">Head of Household</option>
                  </select>
                </Field>
                <Field label="Regular allowances"><input type="number" min={0} max={99} step={1} className="field num w-24" disabled={!editable} value={t.de4Regular} onChange={(e) => set('de4Regular', e.target.value)} /></Field>
                <Field label="Additional allowances"><input type="number" min={0} max={99} step={1} className="field num w-24" disabled={!editable} value={t.de4Additional} onChange={(e) => set('de4Additional', e.target.value)} /></Field>
                <Field label="Additional withholding" hint="Per paycheck"><div className="flex items-center gap-1.5"><span className="text-stone">$</span><input type="number" min={0} step="0.01" className="field num w-28" disabled={!editable} value={t.de4Extra} onChange={(e) => set('de4Extra', e.target.value)} /></div></Field>
              </div>
            )}
            <p className="mt-2 text-[12px] text-stone">California also takes State Disability Insurance (SDI) from employees — include it in the withholding % above.</p>
          </div>
          ) : <p className="mt-3 text-[13px] text-stone">{location.state ? `Enter ${location.stateName}’s withholding % above; the state form details are kept with your payroll provider.` : 'Add the salon’s work address (Settings → Commission → Payroll tax rates) to show the right state form.'}</p>}
          </>}

          {view === 'local' && <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">{pct('local', 'Local withholding')}</div>
          <p className="mt-2 text-[12px] text-stone">{location.state === 'CA' ? `${location.city ? `${location.city} has` : 'Most California cities have'} no local income tax, so this is usually 0%.` : 'Only some cities and counties have a local income tax; leave it at 0% if yours doesn’t.'}</p>
          </>}
        </>
      ) : <p className="mt-2 text-[13px] text-stone">Nothing is withheld for contractors; they handle their own taxes.</p>}
    </div>
  );
}

const rateLabel = (r: Pick<PayRateDTO, 'payType' | 'hourlyRateCents' | 'salaryCents' | 'salaryPeriod'>) =>
  r.payType === 'hourly' ? `${usd(r.hourlyRateCents ?? 0)} / hour` : r.payType === 'salary' ? `${usd(r.salaryCents ?? 0)} ${PERIODS.find(([v]) => v === r.salaryPeriod)?.[1]}` : 'No wage';

/** Wage history: each wage pays the hours worked from its start date until the next one starts. Past wages can be corrected. */
type RateDraft = { payType: PayRateDTO['payType']; hourly: string; salary: string; period: SalaryPeriod; from: string; to?: string };
const rateBody = (d: RateDraft) => ({ payType: d.payType, hourlyRateCents: toCents(d.hourly), salaryCents: toCents(d.salary), salaryPeriod: d.period, effectiveFrom: d.from || null });

/** Start date, pay type and amount — used to add a wage and to correct one. */
function RateForm({ d, onChange, onSave, onCancel, saveLabel, fromRequired, withEnd }: { d: RateDraft; onChange: (d: RateDraft) => void; onSave: () => void; onCancel: () => void; saveLabel: string; fromRequired?: boolean; withEnd?: boolean }) {
  const missing = (fromRequired && !d.from) || (d.payType === 'hourly' && !d.hourly) || (d.payType === 'salary' && !d.salary) || (!!d.to && !!d.from && d.to < d.from);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Starts on"><input type="date" className="field h-9 w-auto" value={d.from} onChange={(e) => onChange({ ...d, from: e.target.value })} /></Field>
      {withEnd && <Field label="Until (optional)"><input type="date" className="field h-9 w-auto" min={d.from || undefined} value={d.to ?? ''} onChange={(e) => onChange({ ...d, to: e.target.value })} /></Field>}
      <Field label="Pay">
        <select className="field h-9 w-auto" value={d.payType} onChange={(e) => onChange({ ...d, payType: e.target.value as PayRateDTO['payType'] })}>
          <option value="hourly">Hourly</option><option value="salary">Salary</option><option value="none">No wage</option>
        </select>
      </Field>
      {d.payType === 'hourly' && <Field label="$ / hour"><input type="number" min={0} step="0.01" className="field num h-9 w-24" value={d.hourly} onChange={(e) => onChange({ ...d, hourly: e.target.value })} /></Field>}
      {d.payType === 'salary' && (
        <Field label="Salary">
          <span className="flex gap-1"><input type="number" min={0} step="0.01" className="field num h-9 w-28" value={d.salary} onChange={(e) => onChange({ ...d, salary: e.target.value })} />
            <select className="field h-9 w-auto" value={d.period} onChange={(e) => onChange({ ...d, period: e.target.value as SalaryPeriod })}>{PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></span>
        </Field>
      )}
      <Button size="sm" variant="primary" disabled={missing} onClick={onSave}>{saveLabel}</Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

/** Wage history: each wage pays the hours worked from its start date until the next one starts. Add, correct or remove wages. */
function RateHistory({ staffId, rates, editable, onChanged }: { staffId: string; rates: PayRateDTO[]; editable: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState<(RateDraft & { id: string }) | null>(null);
  const [adding, setAdding] = useState<RateDraft | null>(null);
  const f = (k: string) => labelOfKey(k, { month: 'short', day: 'numeric', year: 'numeric' });
  const call = async (p: Promise<unknown>, msg: string, done: () => void) => {
    try {
      await p;
      toast(msg);
      done();
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = (r: PayRateDTO) => call(api.del(`/commission/pay-rates/${r.id}`), 'Wage removed', () => undefined);
  const current = rates[0];
  return (
    <div>
      <p className="mb-1 text-[13px] font-medium text-ink">Wage history</p>
      {rates.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {rates.map((r) => (
            <li key={r.id} className="px-3 py-2 text-[13px]">
              {editing?.id === r.id ? (
                <RateForm d={editing} onChange={(d) => setEditing({ ...editing, ...d })} saveLabel="Save" onCancel={() => setEditing(null)}
                  onSave={() => call(api.patch(`/commission/pay-rates/${editing.id}`, rateBody(editing)), 'Wage updated — wages for those dates were recalculated.', () => setEditing(null))} />
              ) : (
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-ink">{rateLabel(r)}</span>
                    <span className="text-stone"> · {r.effectiveFrom ? `from ${f(r.effectiveFrom)}` : 'from the beginning'}{r.effectiveTo ? ` to ${f(r.effectiveTo)}` : ' · current'}</span>
                  </span>
                  {editable && <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing({ id: r.id, payType: r.payType, hourly: str(r.hourlyRateCents), salary: str(r.salaryCents), period: r.salaryPeriod, from: r.effectiveFrom ?? '' })}>Edit</Button>}
                  {editable && <Button size="sm" variant="ghost" aria-label="Remove wage" icon={<Trash2 className="h-4 w-4" />} onClick={() => remove(r)} />}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (adding ? (
        <div className="mt-2 rounded-xl border border-dashed border-line-strong p-3 text-[13px]">
          <p className="mb-2 text-ink-soft">Add a wage — hours worked from its start date are paid at it, until the next wage starts. Give an end date for a wage that applied only for certain dates (e.g. an earlier rate); the wage before it carries on afterwards.</p>
          <RateForm d={adding} onChange={setAdding} saveLabel="Add wage" fromRequired withEnd onCancel={() => setAdding(null)}
            onSave={() => call(api.post('/commission/pay-rates', { staffId, ...rateBody(adding), effectiveTo: adding.to || null }), 'Wage added — wages for those dates were recalculated.', () => setAdding(null))} />
        </div>
      ) : (
        <Button size="sm" variant="ghost" className="mt-2" icon={<Plus className="h-4 w-4" />}
          onClick={() => setAdding({ payType: current?.payType && current.payType !== 'none' ? current.payType : 'hourly', hourly: str(current?.hourlyRateCents ?? null), salary: str(current?.salaryCents ?? null), period: current?.salaryPeriod ?? 'year', from: '' })}>Add a wage</Button>
      ))}
      <p className="mt-1 text-[12px] text-stone">Each wage pays the hours worked from its start date until the next wage starts — add past raises, or one coming up.</p>
    </div>
  );
}
