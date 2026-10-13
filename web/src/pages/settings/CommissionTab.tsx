import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommissionRuleDTO, CommissionSettings, CommissionTier } from '@addendum/shared';
import { Plus, Trash2 } from 'lucide-react';
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
  useEffect(() => setD(settings), [settings]);
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
        <Toggle checked={d.enabled} disabled={!editable} onChange={(v) => set('enabled', v)} label="Commission is on" description="Syncs Square sales and shows My Commission to the team. Needs Square’s ORDERS_READ and PAYMENTS_READ permissions." />
        <div className="grid gap-4 sm:grid-cols-2">
          <Toggle checked={d.autoSync} disabled={!editable} onChange={(v) => set('autoSync', v)} label="Sync automatically" />
          <NumberField label="Every" unit="minutes" min={15} max={1440} value={d.syncIntervalMinutes} disabled={!editable} onChange={(v) => set('syncIntervalMinutes', v)} />
          <Field label="Bring in sales from" hint="First sync starts here (default: last 90 days)."><input type="date" className="field" disabled={!editable} value={d.syncStartDate ?? ''} onChange={(e) => set('syncStartDate', e.target.value || null)} /></Field>
          <Choice k="basis" label="Commission is on the price" options={[['after_discounts', 'After discounts'], ['before_discounts', 'Before discounts']]} />
          <Choice k="refunds" label="Refunds" options={[['reverse', 'Take back the commission (same rate as the sale)'], ['ignore', 'Don’t affect commission']]} />
          <Choice k="zeroPriced" label="Packages, comps and 100% discounts" options={[['no_commission', 'No commission'], ['regular_price', 'Commission on the regular price'], ['review', 'Send to review']]} />
          <Choice k="multiProvider" label="Several providers on one service" options={[['split_evenly', 'Split evenly'], ['review', 'Send to review']]} />
          <Choice k="productAttribution" label="Retail sold during a visit goes to" options={[['appointment_provider', 'The visit’s provider'], ['payment_team_member', 'Whoever took the payment in Square']]} />
          <Choice k="tips" label="Tips" options={[['separate', 'Show separately (never commission)'], ['exclude', 'Leave out of these reports']]} />
          <Choice k="tipAttribution" label="Tips go to" options={[['service_share', 'Service providers, by their share'], ['payment_team_member', 'Whoever took the payment']]} />
        </div>
        <p className="text-[12px] text-stone">Changing these recalculates <b>estimated</b> commission only. Finalized pay periods never change.</p>
      </div>
    </Card>
  );
}

function RulesCard({ rules, editable }: { rules: CommissionRuleDTO[]; editable: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [showOld, setShowOld] = useState(false);
  const [ending, setEnding] = useState<CommissionRuleDTO | null>(null);
  const today = dayKey(new Date());
  const visible = rules.filter((r) => showOld || r.active || r.effectiveFrom > today);
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
            <p className="mb-1 text-[13px] font-medium text-ink">{title}</p>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {list.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
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
                  {editable && !r.effectiveTo && <Button size="sm" variant="ghost" onClick={() => setEnding(r)}>End…</Button>}
                  {editable && <Button size="sm" variant="ghost" aria-label="Delete rule" icon={<Trash2 className="h-4 w-4" />} onClick={() => del(r)} />}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {!visible.length && <p className="text-[14px] text-stone">No rates yet. Add the salon’s commission plan to start calculating.</p>}
      <p className="mt-2 text-[12px] text-stone">To change a rate, add a new one with the date it starts — the old rate ends the day before and stays in the history. Rules used for finalized commission can’t be deleted.</p>
      {adding && <RuleModal onClose={() => setAdding(false)} onSaved={reload} />}
      {ending && <EndRuleModal rule={ending} onClose={() => setEnding(null)} onSaved={reload} />}
    </Card>
  );
}

function RuleModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { data: options } = useQuery({ queryKey: ['commission-options'], queryFn: () => api.get<Options>('/commission/options') });
  const [r, setR] = useState({
    staffId: '', category: 'service' as 'service' | 'retail', targetType: 'all' as 'all' | 'service' | 'product', targetId: '',
    method: 'percent' as 'percent' | 'flat' | 'tiered', rate: '40', flat: '', tierPeriod: 'month' as 'month' | 'week',
    tiers: [{ upTo: '5000', rate: '40' }, { upTo: '', rate: '45' }], effectiveFrom: dayKey(new Date()), effectiveTo: '', note: '',
  });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const tiers: CommissionTier[] | null = r.method === 'tiered' ? r.tiers.map((t, i) => ({ upToCents: i === r.tiers.length - 1 ? null : Math.round(Number(t.upTo) * 100), rateBps: Math.round(Number(t.rate) * 100) })) : null;
      await api.post('/commission/rules', {
        staffId: r.staffId || null, category: r.category, targetType: r.targetType, targetId: r.targetType === 'all' ? null : r.targetId || null,
        method: r.method, rateBps: r.method === 'percent' ? Math.round(Number(r.rate) * 100) : null, flatCents: r.method === 'flat' ? Math.round(Number(r.flat) * 100) : null,
        tiers, tierPeriod: r.tierPeriod, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo || null, note: r.note || null,
      });
      toast('Rate added. Estimated commission from that date was recalculated.');
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
    <Modal open onClose={onClose} title="Add a commission rate" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={saving}>Add rate</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Who">
            <select className="field" value={r.staffId} onChange={(e) => setR({ ...r, staffId: e.target.value })}>
              <option value="">Everyone (default)</option>
              {options?.staff.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}{s.squareLinked ? '' : ' (not linked to Square)'}</option>)}
            </select>
          </Field>
          <Field label="Commission on">
            <select className="field" value={r.category} onChange={(e) => setR({ ...r, category: e.target.value as any, targetType: 'all', targetId: '' })}>
              <option value="service">Services</option><option value="retail">Retail products</option>
            </select>
          </Field>
          <Field label="Which">
            <select className="field" value={r.targetType === 'all' ? '' : r.targetId} onChange={(e) => setR({ ...r, targetType: e.target.value ? (r.category === 'service' ? 'service' : 'product') : 'all', targetId: e.target.value })}>
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
          <Field label="Starts on" hint="Sales from this date use this rate."><input type="date" className="field" value={r.effectiveFrom} onChange={(e) => setR({ ...r, effectiveFrom: e.target.value })} /></Field>
          <Field label="Ends on (optional)"><input type="date" className="field" value={r.effectiveTo} min={r.effectiveFrom} onChange={(e) => setR({ ...r, effectiveTo: e.target.value })} /></Field>
        </div>
        <Field label="Note (optional)"><input className="field" maxLength={300} value={r.note} onChange={(e) => setR({ ...r, note: e.target.value })} placeholder="e.g. 2027 plan" /></Field>
      </div>
    </Modal>
  );
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
