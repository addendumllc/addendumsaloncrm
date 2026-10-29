import { useEffect, useState } from 'react';
import { tc } from '../../lib/titleCase';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { payPeriodFor, type CommissionRuleDTO, type CommissionSettings, type CommissionTier } from '@addendum/shared';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import { useCanDo } from '../../api/hooks';
import { dayKey, labelOfKey } from '../../lib/format';
import { Badge, Button, Field, Modal, Spinner, Toggle, useToast } from '../../components/ui';
import { Card, NumberField } from './shared';

type Options = { staff: { id: string; name: string; active: boolean; squareLinked: boolean }[]; services: { id: string; name: string }[]; products: { id: string; name: string }[] };

/** Settings → Commission: how commission is worked out, and the rates. No code changes needed to change a plan. */
export function CommissionSettings() {
  const canDo = useCanDo();
  const editable = canDo('commission:manage');
  const { data, isLoading } = useQuery({ queryKey: ['commission-rules'], queryFn: () => api.get<{ rules: CommissionRuleDTO[]; settings: CommissionSettings }>('/commission/rules') });
  if (isLoading || !data) return <div className="flex justify-center py-10"><Spinner /></div>;
  return (
    <div className="space-y-6">
      <SettingsCard settings={data.settings} editable={editable} />
      <RulesCard rules={data.rules} editable={editable} />
    </div>
  );
}

function SettingsCard({ settings, editable }: { settings: CommissionSettings; editable: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [d, setD] = useState(settings);
  const [saving, setSaving] = useState(false);
  const { data: options } = useQuery({ queryKey: ['commission-options'], queryFn: () => api.get<Options>('/commission/options') });
  useEffect(() => setD(settings), [settings]);
  const uc = d.unrecordedCheckout ?? { clientStylist: true, onTheClock: true, fallbackStaffId: null, hold: true };
  const setUc = (p: Partial<typeof uc>) => set('unrecordedCheckout', { ...uc, ...p });
  const dirty = JSON.stringify(d) !== JSON.stringify(settings);
  const set = <K extends keyof CommissionSettings>(k: K, v: CommissionSettings[K]) => setD({ ...d, [k]: v });
  const save = async () => {
    setSaving(true);
    try {
      await api.put('/commission/settings', d);
      toast('Saved. Estimated commission was recalculated; finalized commission is unchanged.');
      for (const k of ['commission-rules', 'commission-status', 'commission-team', 'commission-me']) qc.invalidateQueries({ queryKey: [k] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const Choice = <K extends keyof CommissionSettings>({ k, label, options, hint }: { k: K; label: string; options: [CommissionSettings[K], string][]; hint?: string }) => (
    <Field label={label} hint={hint}>
      <select className="field" disabled={!editable} value={String(d[k])} onChange={(e) => set(k, options.find(([v]) => String(v) === e.target.value)![0])}>
        {options.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
      </select>
    </Field>
  );
  return (
    <Card title="How commission is calculated" description="Commission is worked out in the CRM from verified Square sales, because Square doesn’t provide commission through its API."
      footer={editable && <>{dirty && <span className="mr-auto text-[13px] text-amber">Unsaved changes</span>}<Button variant="primary" disabled={!dirty} loading={saving} onClick={save}>Save</Button></>}>
      <div className="space-y-4">
        <Toggle checked={d.enabled} disabled={!editable} onChange={(v) => set('enabled', v)} label="Commission is on" description="Syncs Square sales and shows Earnings &amp; Goals to the team. Needs Square’s ORDERS_READ and PAYMENTS_READ permissions." />
        <div className="grid gap-4 sm:grid-cols-2">
          <Toggle checked={d.autoSync} disabled={!editable} onChange={(v) => set('autoSync', v)} label="Sync automatically" />
          <NumberField label="Every" unit="minutes" min={15} max={1440} value={d.syncIntervalMinutes} disabled={!editable} onChange={(v) => set('syncIntervalMinutes', v)} />
          <Field label="Bring in sales from" hint="First sync starts here (default: last 90 days)."><input type="date" className="field" disabled={!editable} value={d.syncStartDate ?? ''} onChange={(e) => set('syncStartDate', e.target.value || null)} /></Field>
          <Choice k="basis" label="Commission is on the price" options={[['after_discounts', 'After discounts'], ['before_discounts', 'Before discounts']]} />
          <Choice k="refunds" label="Refunds" options={[['reverse', 'Take back the commission (same rate as the sale)'], ['ignore', 'Don’t affect commission']]} />
          <Choice k="zeroPriced" label="Packages, comps and 100% discounts" options={[['no_commission', 'No commission'], ['regular_price', 'Commission on the regular price'], ['review', 'Send to review']]} />
          {/* Each stylist's rates when none of their rules covers a sale; personal rules (below) still come first. */}
          <NumberField label="Default service commission" unit="%" min={0} max={100} value={(d.defaultServiceBps ?? 4000) / 100} disabled={!editable} onChange={(v) => set('defaultServiceBps', Math.round(v * 100))}
            hint="Used for any stylist and service no rule covers." />
          <NumberField label="Default product commission" unit="%" min={0} max={100} value={(d.defaultRetailBps ?? 1000) / 100} disabled={!editable} onChange={(v) => set('defaultRetailBps', Math.round(v * 100))}
            hint="Used for any product sale no rule covers." />
          <Choice k="multiProvider" label="Several providers on one service" options={[['split_evenly', 'Split evenly, on hold until confirmed'], ['review', 'Send to review']]} />
          <Choice k="productAttribution" label="Retail sold during a visit goes to" options={[['appointment_provider', 'The visit’s provider'], ['payment_team_member', 'Whoever took the payment in Square']]} />
          <Choice k="tips" label="Tips" options={[['separate', 'Show separately (never commission)'], ['exclude', 'Leave out of these reports']]} />
          <Choice k="tipAttribution" label="Tips go to" options={[['service_share', 'Service providers, by their share'], ['payment_team_member', 'Whoever took the payment']]} />
        </div>
        {/* A shared front-desk login (or a signed-out POS) leaves Square with nobody on the payment. */}
        <div className="rounded-xl border border-line p-3">
          <p className="text-[14px] font-medium text-ink">When Square doesn’t record who checked out</p>
          <p className="mb-2 text-[12px] text-stone">Product sales with nobody on the payment are credited to the first of these that fits. Anything left goes to Needs review with these people as one-click choices.</p>
          <div className="space-y-1">
            <Toggle checked={uc.clientStylist} disabled={!editable} onChange={(v) => setUc({ clientStylist: v })} label="1. The client’s preferred stylist" description="When a client is on the ticket." />
            <Toggle checked={uc.onTheClock} disabled={!editable} onChange={(v) => setUc({ onTheClock: v })} label="2. Whoever was on the clock" description="The front desk person clocked in at that moment, or the only person clocked in (people on lunch don’t count)." />
          </div>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="3. Backup person" hint="Credited when neither of the above fits.">
              <select className="field" disabled={!editable} value={uc.fallbackStaffId ?? ''} onChange={(e) => setUc({ fallbackStaffId: e.target.value || null })}>
                <option value="">Nobody — send to Needs review</option>
                {options?.staff.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="mt-2"><Toggle checked={uc.hold} disabled={!editable} onChange={(v) => setUc({ hold: v })} label="Hold until accepted" description="They show in Needs review and aren’t in pay until someone accepts them (or credits someone else). Off: counted straight away." /></div>
        </div>
        <div className="rounded-xl border border-line p-3">
          <p className="text-[14px] font-medium text-ink">Pay schedule</p>
          <p className="mb-2 text-[12px] text-stone">Earnings & Goals and Team Payroll open on the current pay period, with hours worked for it.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Pay periods">
              <select className="field" disabled={!editable} value={d.paySchedule.frequency} onChange={(e) => set('paySchedule', { ...d.paySchedule, frequency: e.target.value as CommissionSettings['paySchedule']['frequency'] })}>
                <option value="weekly">Every week</option><option value="biweekly">Every 2 weeks</option><option value="semimonthly">Twice a month (1st–15th, 16th–end)</option><option value="monthly">Every month</option>
              </select>
            </Field>
            {(d.paySchedule.frequency === 'weekly' || d.paySchedule.frequency === 'biweekly') && (
              <Field label="A pay period starts on" hint="Any one period’s first day; the rest follow from it.">
                <input type="date" className="field" disabled={!editable} value={d.paySchedule.anchorStart} onChange={(e) => e.target.value && set('paySchedule', { ...d.paySchedule, anchorStart: e.target.value })} />
              </Field>
            )}
            <NumberField label="Payday" unit="days after the period ends" min={0} max={31} value={d.paySchedule.payDayOffsetDays} disabled={!editable} onChange={(v) => set('paySchedule', { ...d.paySchedule, payDayOffsetDays: v })} />
          </div>
          {(() => {
            const p = payPeriodFor(dayKey(new Date()), d.paySchedule);
            const f = (k: string) => labelOfKey(k, { month: 'short', day: 'numeric', year: 'numeric' });
            return <p className="mt-1 text-[12px] text-stone">Current pay period: {f(p.from)} – {f(p.to)}, paid {f(p.payDate)}.</p>;
          })()}
          <Field label="Overtime (hourly pay)" className="mt-3 sm:w-96" hint="Workweeks start on the pay period’s first weekday. Payroll does the official calculation (including California’s 7th-day rule).">
            <select className="field" disabled={!editable} value={d.overtime ?? 'california'} onChange={(e) => set('overtime', e.target.value as NonNullable<CommissionSettings['overtime']>)}>
              <option value="california">California — over 8 hrs/day or 40 hrs/week at 1.5×, over 12 hrs/day at 2×</option>
              <option value="weekly">Over 40 hours a week at 1.5×</option>
              <option value="none">No overtime</option>
            </select>
          </Field>
        </div>
        <div className="rounded-xl border border-line p-3">
          <p className="text-[14px] font-medium text-ink">Payroll tax rates (for estimates)</p>
          <p className="mb-2 text-[12px] text-stone">Used to estimate withholding and employer taxes for W-2 employees on Team Payroll and in the pay summary. Your payroll provider calculates the real amounts (including wage-base limits).</p>
          <Field label="Work address (for payroll taxes)" hint="Where the team works — it decides which state and local taxes apply. Included in the pay summary.">
            <input className="field" maxLength={300} disabled={!editable} value={d.payrollTaxes.workAddress ?? ''} onChange={(e) => set('payrollTaxes', { ...d.payrollTaxes, workAddress: e.target.value })} />
          </Field>
          <div className="h-3" />
          <div className="grid gap-3 sm:grid-cols-4">
            {([['federalIncomeBps', 'Federal income tax (default)'], ['stateIncomeBps', 'CA state income tax (default)'], ['socialSecurityBps', 'Social Security'], ['medicareBps', 'Medicare'], ['sdiBps', 'CA disability insurance (SDI)'], ['futaBps', 'Federal unemployment (FUTA)'], ['sutaBps', 'State unemployment (SUTA)'], ['netCushionBps', 'Cushion off estimated net']] as const).map(([k, label]) => (
              <Field key={k} label={label}>
                <div className="flex items-center gap-1.5">
                  <input type="number" min={0} max={100} step="0.01" className="field num w-24" disabled={!editable} value={((d.payrollTaxes[k] ?? (k === 'federalIncomeBps' ? 1000 : k === 'netCushionBps' ? 200 : 0)) / 100).toString()}
                    onChange={(e) => set('payrollTaxes', { ...d.payrollTaxes, [k]: Math.max(0, Math.min(10000, Math.round(Number(e.target.value || 0) * 100))) })} />
                  <span className="text-stone">%</span>
                </div>
              </Field>
            ))}
          </div>
          <p className="mt-1 text-[12px] text-stone">The federal and CA defaults are used for anyone without their own rates — for exact estimates use Match a paystub on each person’s Taxes. The cushion comes off estimated net pay so it stays a little under the real paycheck. CA state income tax is used for anyone without their own state rate (Users &amp; Permissions → Pay → Taxes). Social Security and Medicare are withheld from the employee and also paid by the salon; CA SDI is withheld from employees working in California; FUTA and SUTA are paid by the salon only.</p>
        </div>
        <Field label="Note shown on Earnings & Goals" hint="Everyone sees this at the top of their commission page. Leave it empty to hide it.">
          <textarea className="field min-h-[72px]" maxLength={1000} disabled={!editable} value={d.disclaimer} onChange={(e) => set('disclaimer', e.target.value)} />
        </Field>
        <p className="text-[12px] text-stone">Changing these recalculates <b>estimated</b> commission only. Finalized pay periods never change.</p>
      </div>
    </Card>
  );
}

function useRuleActions() {
  const toast = useToast();
  const qc = useQueryClient();
  const reload = () => {
    for (const k of ['commission-rules', 'commission-team', 'commission-me', 'commission-staff', 'commission-review']) qc.invalidateQueries({ queryKey: [k] });
  };
  const del = async (r: CommissionRuleDTO) => {
    try {
      await api.del(`/commission/rules/${r.id}`);
      toast('Rule deleted');
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return { reload, del };
}

function RuleItem({ r, editable, onEdit, onEnd, onDelete }: { r: CommissionRuleDTO; editable: boolean; onEdit: () => void; onEnd: () => void; onDelete: () => void }) {
  const today = dayKey(new Date());
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5 text-[14px]">
          <b className="font-medium text-ink">{r.staffName ?? 'Everyone'}</b>
          <span className="text-ink-soft">· {r.category === 'service' ? 'Services' : 'Retail'}{r.targetName ? `: ${r.targetName}` : ''}</span>
          <Badge tone="plum">{r.label}</Badge>
          {r.active ? <Badge tone="sage">Active</Badge> : r.effectiveFrom > today ? <Badge tone="amber">Starts {labelOfKey(r.effectiveFrom, { month: 'short', day: 'numeric' })}</Badge> : <Badge>Ended</Badge>}
        </span>
        <span className="block text-[12px] text-stone">
          From {labelOfKey(r.effectiveFrom, { month: 'short', day: 'numeric', year: 'numeric' })}{r.effectiveTo ? ` to ${labelOfKey(r.effectiveTo, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
          {r.createdByName ? ` · added by ${r.createdByName}` : ''} · used on {r.usedCount} record{r.usedCount === 1 ? '' : 's'}{r.note ? ` · ${r.note}` : ''}
        </span>
      </span>
      {editable && <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={onEdit}>Edit</Button>}
      {editable && !r.effectiveTo && <Button size="sm" variant="ghost" onClick={onEnd}>End…</Button>}
      {editable && <Button size="sm" variant="ghost" aria-label="Delete rule" icon={<Trash2 className="h-4 w-4" />} onClick={onDelete} />}
    </li>
  );
}

/**
 * Users & Permissions → one person: their own service and product rates (same rules as Settings → Commission), and
 * the salon-wide rates that apply to them where they have none of their own.
 */
export function StaffCommissionRates({ staffId, staffName }: { staffId: string; staffName: string }) {
  const canDo = useCanDo();
  const editable = canDo('commission:manage');
  const { data } = useQuery({ queryKey: ['commission-rules'], queryFn: () => api.get<{ rules: CommissionRuleDTO[]; settings: CommissionSettings }>('/commission/rules') });
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState<CommissionRuleDTO | null>(null);
  const [editing, setEditing] = useState<CommissionRuleDTO | null>(null);
  const { reload, del } = useRuleActions();
  if (!data) return <div className="flex justify-center py-4"><Spinner /></div>;
  const today = dayKey(new Date());
  const current = (r: CommissionRuleDTO) => r.active || r.effectiveFrom > today;
  const own = data.rules.filter((r) => r.staffId === staffId && current(r));
  const everyone = data.rules.filter((r) => !r.staffId && r.active);
  const first = staffName.split(' ')[0];
  return (
    <div>
      {!data.settings.enabled && <p className="mb-2 text-[13px] text-amber">Commission is turned off (Settings → Commission), so these rates aren’t used yet.</p>}
      {own.length ? (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {own.map((r) => <RuleItem key={r.id} r={r} editable={editable} onEdit={() => setEditing(r)} onEnd={() => setEnding(r)} onDelete={() => del(r)} />)}
        </ul>
      ) : <p className="text-[14px] text-stone">{first} has no rates of their own.</p>}
      <p className="mt-2 text-[12px] text-stone">
        {everyone.length
          ? <>Where {first} has no rate of their own, the salon-wide rates apply: {everyone.map((r) => `${r.category === 'service' ? 'services' : 'retail'}${r.targetName ? ` (${r.targetName})` : ''} ${r.label}`).join(' · ')}.</>
          : <>There are no salon-wide rates, so anything without a rate of {first}’s own earns $0 (and goes to Needs review).</>}
      </p>
      {editable && <Button size="sm" className="mt-2" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add a rate for {first}</Button>}
      {adding && <RuleModal staffId={staffId} onClose={() => setAdding(false)} onSaved={reload} />}
      {editing && <RuleModal rule={editing} onClose={() => setEditing(null)} onSaved={reload} />}
      {ending && <EndRuleModal rule={ending} onClose={() => setEnding(null)} onSaved={reload} />}
    </div>
  );
}

function RulesCard({ rules, editable }: { rules: CommissionRuleDTO[]; editable: boolean }) {
  const [adding, setAdding] = useState(false);
  const [showOld, setShowOld] = useState(false);
  const [ending, setEnding] = useState<CommissionRuleDTO | null>(null);
  const [editing, setEditing] = useState<CommissionRuleDTO | null>(null);
  const today = dayKey(new Date());
  const visible = rules.filter((r) => showOld || r.active || r.effectiveFrom > today);
  const { reload, del } = useRuleActions();
  const groups: [string, (r: CommissionRuleDTO) => boolean][] = [['Everyone', (r) => !r.staffId], ['Individual stylists', (r) => !!r.staffId]];
  return (
    <Card title="Commission rates" description="The most specific rule wins: a stylist’s rule for an item, then their general rule, then everyone’s rule for that item, then everyone’s general rule."
      footer={<>
        <span className="mr-auto"><Toggle checked={showOld} onChange={setShowOld} label="Show ended rules" /></span>
        {editable && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add rate</Button>}
      </>}>
      {groups.map(([title, f]) => {
        const list = visible.filter(f);
        if (!list.length) return null;
        return (
          <div key={title} className="mb-4">
            <p className="mb-1 text-[13px] font-medium text-ink">{tc(title)}</p>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {list.map((r) => <RuleItem key={r.id} r={r} editable={editable} onEdit={() => setEditing(r)} onEnd={() => setEnding(r)} onDelete={() => del(r)} />)}
            </ul>
          </div>
        );
      })}
      {!visible.length && <p className="text-[14px] text-stone">No rates yet. Add the salon’s commission plan to start calculating.</p>}
      <p className="mt-2 text-[12px] text-stone">Edit a rate to fix or change it. Rates already used for finalized commission keep their history: editing one starts the new rate from a date you choose, and the old one ends the day before. Those can’t be deleted.</p>
      {adding && <RuleModal onClose={() => setAdding(false)} onSaved={reload} />}
      {editing && <RuleModal rule={editing} onClose={() => setEditing(null)} onSaved={reload} />}
      {ending && <EndRuleModal rule={ending} onClose={() => setEnding(null)} onSaved={reload} />}
    </Card>
  );
}

/** Adds a rate, or edits one. A rate used for finalized commission is replaced from a date rather than rewritten. */
function RuleModal({ rule, staffId, onClose, onSaved }: { rule?: CommissionRuleDTO; staffId?: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { data: options } = useQuery({ queryKey: ['commission-options'], queryFn: () => api.get<Options>('/commission/options') });
  const replacing = !!rule?.locked;
  const today = dayKey(new Date());
  const [r, setR] = useState(rule ? {
    staffId: rule.staffId ?? '', category: rule.category, targetType: rule.targetType, targetId: rule.targetId ?? '',
    method: rule.method, rate: rule.rateBps != null ? String(rule.rateBps / 100) : '40', flat: rule.flatCents != null ? String(rule.flatCents / 100) : '',
    tierPeriod: rule.tierPeriod,
    tiers: rule.tiers?.length ? rule.tiers.map((t) => ({ upTo: t.upToCents != null ? String(t.upToCents / 100) : '', rate: String(t.rateBps / 100) })) : [{ upTo: '5000', rate: '40' }, { upTo: '', rate: '45' }],
    effectiveFrom: replacing ? (today > rule.effectiveFrom ? today : dayAfter(rule.effectiveFrom)) : rule.effectiveFrom,
    effectiveTo: replacing ? '' : rule.effectiveTo ?? '', note: rule.note ?? '',
  } : {
    staffId: staffId ?? '', category: 'service' as 'service' | 'retail', targetType: 'all' as 'all' | 'service' | 'product', targetId: '',
    method: 'percent' as 'percent' | 'flat' | 'tiered', rate: '40', flat: '', tierPeriod: 'month' as 'month' | 'week',
    tiers: [{ upTo: '5000', rate: '40' }, { upTo: '', rate: '45' }], effectiveFrom: today, effectiveTo: '', note: '',
  });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const tiers: CommissionTier[] | null = r.method === 'tiered' ? r.tiers.map((t, i) => ({ upToCents: i === r.tiers.length - 1 ? null : Math.round(Number(t.upTo) * 100), rateBps: Math.round(Number(t.rate) * 100) })) : null;
      const body = {
        staffId: r.staffId || null, category: r.category, targetType: r.targetType, targetId: r.targetType === 'all' ? null : r.targetId || null,
        method: r.method, rateBps: r.method === 'percent' ? Math.round(Number(r.rate) * 100) : null, flatCents: r.method === 'flat' ? Math.round(Number(r.flat) * 100) : null,
        tiers, tierPeriod: r.tierPeriod, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo || null, note: r.note || null,
      };
      if (rule && !replacing) {
        await api.put(`/commission/rules/${rule.id}`, body);
        toast('Rate updated. Estimated commission was recalculated; finalized commission is unchanged.');
      } else {
        // For a replaced rate the server ends the old one the day before the new start date.
        await api.post('/commission/rules', body);
        toast(replacing ? 'Rate changed from that date. The old rate is kept in the history.' : 'Rate added. Estimated commission from that date was recalculated.');
      }
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const targets = r.category === 'service' ? options?.services ?? [] : options?.products ?? [];
  return (
    <Modal open onClose={onClose} title={rule ? 'Edit commission rate' : 'Add a commission rate'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={saving}>{rule ? 'Save' : 'Add rate'}</Button></>}>
      <div className="space-y-4">
        {replacing && <p className="rounded-xl bg-amber/10 px-3 py-2 text-[13px] text-ink-soft">This rate was used for finalized commission, so its history stays as it is. Your changes start on the date below, and the current rate ends the day before.</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Who">
            <select className="field" disabled={replacing || !!staffId} value={r.staffId} onChange={(e) => setR({ ...r, staffId: e.target.value })}>
              <option value="">Everyone (default)</option>
              {options?.staff.filter((s) => s.active || s.id === r.staffId).map((s) => <option key={s.id} value={s.id}>{s.name}{s.squareLinked ? '' : ' (not linked to Square)'}</option>)}
            </select>
          </Field>
          <Field label="Commission on">
            <select className="field" disabled={replacing} value={r.category} onChange={(e) => setR({ ...r, category: e.target.value as any, targetType: 'all', targetId: '' })}>
              <option value="service">Services</option><option value="retail">Retail products</option>
            </select>
          </Field>
          <Field label="Which">
            <select className="field" disabled={replacing} value={r.targetType === 'all' ? '' : r.targetId} onChange={(e) => setR({ ...r, targetType: e.target.value ? (r.category === 'service' ? 'service' : 'product') : 'all', targetId: e.target.value })}>
              <option value="">All {r.category === 'service' ? 'services' : 'products'}</option>
              {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select className="field" value={r.method} onChange={(e) => setR({ ...r, method: e.target.value as any })}>
              <option value="percent">Percentage of sales</option><option value="flat">Flat amount per item</option><option value="tiered">Tiered by sales in the period</option>
            </select>
          </Field>
        </div>
        {r.method === 'percent' && <Field label="Percentage"><div className="flex items-center gap-2"><input type="number" min={0} max={100} step="0.5" className="field num w-28" value={r.rate} onChange={(e) => setR({ ...r, rate: e.target.value })} /><span className="text-stone">%</span></div></Field>}
        {r.method === 'flat' && <Field label="Per item sold"><div className="flex items-center gap-2"><span className="text-stone">$</span><input type="number" min={0} step="0.01" className="field num w-28" value={r.flat} onChange={(e) => setR({ ...r, flat: e.target.value })} /></div></Field>}
        {r.method === 'tiered' && (
          <div className="rounded-xl border border-line p-3">
            <Field label="Tiers reset every">
              <select className="field w-auto" value={r.tierPeriod} onChange={(e) => setR({ ...r, tierPeriod: e.target.value as any })}><option value="month">Month</option><option value="week">Week (Mon–Sun)</option></select>
            </Field>
            <div className="mt-3 space-y-2">
              {r.tiers.map((t, i) => {
                const last = i === r.tiers.length - 1;
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2 text-[14px]">
                    <span className="w-24 text-stone">{i === 0 ? 'Sales up to' : last ? 'Above that' : 'Then up to'}</span>
                    {!last && <><span className="text-stone">$</span><input type="number" min={1} className="field num w-28" value={t.upTo} onChange={(e) => setR({ ...r, tiers: r.tiers.map((x, j) => (j === i ? { ...x, upTo: e.target.value } : x)) })} /></>}
                    <input type="number" min={0} max={100} step="0.5" className="field num w-20" value={t.rate} onChange={(e) => setR({ ...r, tiers: r.tiers.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)) })} /><span className="text-stone">%</span>
                    {r.tiers.length > 2 && !last && <button className="text-[12px] text-rose" onClick={() => setR({ ...r, tiers: r.tiers.filter((_, j) => j !== i) })}>Remove</button>}
                  </div>
                );
              })}
              {r.tiers.length < 6 && <button className="text-[13px] text-plum" onClick={() => setR({ ...r, tiers: [...r.tiers.slice(0, -1), { upTo: '', rate: '' }, r.tiers.at(-1)!] })}>+ Add a tier</button>}
            </div>
            <p className="mt-2 text-[12px] text-stone">Each part of a sale earns the rate of the tier it falls in, based on the stylist’s sales so far that {r.tierPeriod}.</p>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts on" hint="Sales from this date use this rate."><input type="date" className="field" value={r.effectiveFrom} min={replacing ? dayAfter(rule!.effectiveFrom) : undefined} onChange={(e) => setR({ ...r, effectiveFrom: e.target.value })} /></Field>
          <Field label="Ends on (optional)"><input type="date" className="field" value={r.effectiveTo} min={r.effectiveFrom} onChange={(e) => setR({ ...r, effectiveTo: e.target.value })} /></Field>
        </div>
        <Field label="Note (optional)"><input className="field" maxLength={300} value={r.note} onChange={(e) => setR({ ...r, note: e.target.value })} placeholder="e.g. 2027 plan" /></Field>
      </div>
    </Modal>
  );
}

function dayAfter(key: string) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function EndRuleModal({ rule, onClose, onSaved }: { rule: CommissionRuleDTO; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(dayKey(new Date()));
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/commission/rules/${rule.id}/end`, { endDate: date });
      toast('Rule ended');
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="End this rate" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>End rate</Button></>}>
      <p className="mb-3 text-[14px] text-ink-soft">{rule.staffName ?? 'Everyone'} · {rule.label}. It stays in the history; sales after the end date use the next most specific rule.</p>
      <Field label="Last day it applies"><input type="date" className="field" value={date} min={rule.effectiveFrom} onChange={(e) => setDate(e.target.value)} /></Field>
    </Modal>
  );
}
