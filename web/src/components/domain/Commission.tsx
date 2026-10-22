import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { payPeriodFor, type CommissionEntryDTO, type CommissionStatusDTO, type CommissionSummaryDTO, type PaySchedule } from '@addendum/shared';
import { ChevronDown, ChevronRight, Info, Receipt } from 'lucide-react';
import { api } from '../../api/client';
import { addDaysKey, dayKey, labelOfKey, weekdayOfKey } from '../../lib/format';
import { Badge, EmptyState, Spinner, cx } from '../ui';

/** Shared pieces of My Commission and Team Commission. All numbers come from the server. */

export const usd = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(cents / 100);

export type Preset = 'this_pay_period' | 'last_pay_period' | 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'custom';
export const PRESETS: { value: Preset; label: string }[] = [
  { value: 'this_pay_period', label: 'This pay period' }, { value: 'last_pay_period', label: 'Last pay period' },
  { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'this_week', label: 'This week' },
  { value: 'last_week', label: 'Last week' }, { value: 'this_month', label: 'This month' }, { value: 'last_month', label: 'Last month' },
  { value: 'custom', label: 'Custom' },
];

/** Date ranges in the salon's time zone. Weeks run Monday–Sunday; pay periods follow the salon's pay schedule. */
export function presetRange(p: Preset, custom: { from: string; to: string }, schedule?: PaySchedule): { from: string; to: string; payDate?: string } {
  const today = dayKey(new Date());
  if ((p === 'this_pay_period' || p === 'last_pay_period') && schedule) return payPeriodFor(today, schedule, p === 'last_pay_period' ? -1 : 0);
  const monday = addDaysKey(today, -((weekdayOfKey(today) + 6) % 7));
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  switch (p) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const y = addDaysKey(today, -1); return { from: y, to: y }; }
    case 'this_week': return { from: monday, to: addDaysKey(monday, 6) };
    case 'last_week': return { from: addDaysKey(monday, -7), to: addDaysKey(monday, -1) };
    case 'this_month': { const next = addDaysKey(`${today.slice(0, 7)}-28`, 4); return { from: firstOfMonth, to: addDaysKey(`${next.slice(0, 7)}-01`, -1) }; }
    case 'last_month': { const end = addDaysKey(firstOfMonth, -1); return { from: `${end.slice(0, 7)}-01`, to: end }; }
    case 'this_pay_period': case 'last_pay_period': return { from: monday, to: addDaysKey(monday, 6) }; // until the schedule loads
    default: return custom;
  }
}

export function useDateRange(initial: Preset = 'this_pay_period', opts: { payPeriods?: boolean } = {}) {
  const payPeriods = opts.payPeriods ?? true;
  const [preset, setPreset] = useState<Preset>(initial);
  const [custom, setCustom] = useState(() => presetRange('this_month', { from: '', to: '' }));
  // Same query as the pages' status (cached): it carries the salon's pay schedule.
  const { data: status } = useQuery({ queryKey: ['commission-status'], queryFn: () => api.get<{ status: CommissionStatusDTO }>('/commission/status').then((r) => r.status) });
  const schedule = status?.paySchedule;
  const range = useMemo(() => presetRange(preset, custom, schedule), [preset, custom, schedule]);
  return { preset, setPreset, custom, setCustom, range, payPeriods };
}

export function DateRangeBar({ preset, setPreset, custom, setCustom, range, payPeriods }: ReturnType<typeof useDateRange>) {
  const fmt = (k: string) => labelOfKey(k, { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <div className="mb-5">
      <div className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        {PRESETS.filter((p) => payPeriods || !p.value.endsWith('pay_period')).map((p) => (
          <button key={p.value} onClick={() => setPreset(p.value)} className={cx('shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium', preset === p.value ? 'bg-plum text-white' : 'bg-mist text-ink-soft hover:bg-line')}>{p.label}</button>
        ))}
      </div>
      {preset === 'custom' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <input type="date" className="field h-9 w-auto" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="From" />
          <span className="text-stone">to</span>
          <input type="date" className="field h-9 w-auto" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="To" />
        </div>
      ) : (
        <p className="mt-2 text-[13px] text-stone">{range.from === range.to ? fmt(range.from) : `${fmt(range.from)} – ${fmt(range.to)}`}{range.payDate ? ` · paid ${fmt(range.payDate)}` : ''}</p>
      )}
    </div>
  );
}

/** `personal` (My Commission) leaves out the refunds and adjustments tiles. */
export function SummaryCards({ s, personal }: { s: CommissionSummaryDTO; personal?: boolean }) {
  const Stat = ({ label, value, sub, strong, tone }: { label: string; value: string; sub?: string; strong?: boolean; tone?: 'rose' }) => (
    <div className={cx('rounded-xl2 border border-line bg-white px-4 py-3', strong && 'border-ink/20 bg-mist/40')}>
      <p className="text-[12px] font-medium uppercase tracking-wide text-stone">{label}</p>
      <p className={cx('num mt-1 font-display leading-none text-ink', strong ? 'text-[34px]' : 'text-[24px]', tone === 'rose' && 'text-rose')}>{value}</p>
      {sub && <p className="mt-1 text-[12px] text-stone">{sub}</p>}
    </div>
  );
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div className="col-span-2"><Stat strong label="Total commission" value={usd(s.totalCommissionCents)} sub={`${usd(s.finalizedCents)} finalized · ${usd(s.estimatedCents)} estimated`} /></div>
      {/* Services and retail items are paid on different plans: each is shown after its own refunds. */}
      <Stat label="Services commission" value={usd(s.serviceCommissionCents + s.serviceRefundsCents)} sub={`on ${usd(s.serviceSalesCents)} service sales${s.serviceRefundsCents ? ` · after ${usd(-s.serviceRefundsCents)} refunded` : ''}`} />
      <Stat label="Retail items commission" value={usd(s.retailCommissionCents + s.retailRefundsCents)} sub={`on ${usd(s.retailSalesCents)} retail sales${s.retailRefundsCents ? ` · after ${usd(-s.retailRefundsCents)} refunded` : ''}`} />
      <Stat label="Tips (separate)" value={usd(s.tipsCents)} sub="Not part of commission" />
      {!personal && <Stat label="Refunds" value={usd(s.refundsCents)} sub="Taken back (already in the amounts above)" tone={s.refundsCents < 0 ? 'rose' : undefined} />}
      {!personal && <Stat label="Adjustments" value={usd(s.adjustmentsCents)} />}
      <Stat label="Total sales" value={usd(s.totalSalesCents)} sub="After discounts and refunds" />
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { sale: 'Sale', refund: 'Refund', tip: 'Tip', adjustment: 'Adjustment' };

/** Transactions grouped by Square sale, each line expandable to show exactly how it was worked out. */
export function EntriesList({ entries, showStaff, emptyText }: { entries: CommissionEntryDTO[]; showStaff?: boolean; emptyText?: string }) {
  const groups = useMemo(() => {
    const m = new Map<string, CommissionEntryDTO[]>();
    for (const e of entries) {
      const k = e.squareOrderId ? `${e.squareOrderId}|${showStaff ? '' : e.staffId}` : e.id;
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return [...m.values()];
  }, [entries, showStaff]);
  if (!entries.length) return <div className="panel"><EmptyState icon={<Receipt className="h-9 w-9" />} title="No transactions in these dates">{emptyText}</EmptyState></div>;
  return (
    <div className="space-y-3">
      {groups.map((g) => {
        const total = g.reduce((a, e) => a + e.commissionCents, 0);
        const tips = g.reduce((a, e) => a + e.tipCents, 0);
        const first = g[0];
        return (
          <div key={first.id} className="overflow-hidden rounded-xl2 border border-line bg-white">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line bg-mist/40 px-4 py-2 text-[13px]">
              <span className="font-medium text-ink">{labelOfKey(first.postedDate, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span>
              {first.postedDate !== first.transactionDate && <span className="text-stone">sale on {labelOfKey(first.transactionDate, { month: 'short', day: 'numeric' })}</span>}
              {first.serviceDate && first.serviceDate !== first.transactionDate && <span className="text-stone">service {labelOfKey(first.serviceDate, { month: 'short', day: 'numeric' })}</span>}
              {first.squareOrderId && <span className="font-mono text-[11px] text-stone-light">Square order {first.squareOrderId.slice(-8)}</span>}
              <span className="ml-auto num font-medium text-ink">{usd(total)}{tips ? <span className="ml-2 font-normal text-stone">+ {usd(tips)} tip</span> : null}</span>
            </div>
            <ul className="divide-y divide-line">{g.map((e) => <EntryRow key={e.id} e={e} showStaff={showStaff} />)}</ul>
          </div>
        );
      })}
    </div>
  );
}

function EntryRow({ e, showStaff }: { e: CommissionEntryDTO; showStaff?: boolean }) {
  const [open, setOpen] = useState(false);
  const rate = e.method === 'flat' && e.flatCents != null ? `${usd(e.flatCents)}/item` : e.rateBps != null ? `${(e.rateBps / 100).toFixed(e.rateBps % 100 ? 2 : 0)}%${e.method === 'tiered' ? ' (tier)' : ''}` : '—';
  return (
    <li>
      <button onClick={() => setOpen(!open)} className="grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-left hover:bg-mist/30 sm:grid-cols-[minmax(0,1fr)_90px_80px_100px_auto]">
        <span className="flex min-w-0 items-center gap-1.5">
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-stone" /> : <ChevronRight className="h-4 w-4 shrink-0 text-stone" />}
          <span className="truncate text-[14px] text-ink">{e.itemName}</span>
          {e.share < 1 && <Badge>{Math.round(e.share * 100)}% share</Badge>}
          {showStaff && <span className="truncate text-[12px] text-stone">· {e.staffName ?? 'Unassigned'}</span>}
        </span>
        <span className="num hidden text-right text-[13px] text-ink-soft sm:block">{e.kind === 'tip' ? '' : usd(e.netSalesCents)}</span>
        <span className="num hidden text-right text-[13px] text-stone sm:block">{e.kind === 'tip' ? '' : rate}</span>
        <span className={cx('num text-right text-[14px] font-medium', e.commissionCents < 0 ? 'text-rose' : 'text-ink')}>{e.kind === 'tip' ? `${usd(e.tipCents)} tip` : usd(e.commissionCents)}</span>
        <span className="col-span-2 flex flex-wrap justify-end gap-1 sm:col-span-1">
          {e.kind !== 'sale' && <Badge tone={e.kind === 'refund' ? 'rose' : 'neutral'}>{KIND_LABEL[e.kind]}</Badge>}
          <Badge tone={e.status === 'finalized' ? 'sage' : 'amber'}>{e.status === 'finalized' ? 'Finalized' : 'Estimated'}</Badge>
          {e.onHold ? <Badge tone="amber">On hold</Badge> : e.needsReview && <Badge tone="rose">Review</Badge>}
        </span>
      </button>
      {open && <EntryDetail e={e} />}
    </li>
  );
}

function EntryDetail({ e }: { e: CommissionEntryDTO }) {
  const { data, isLoading } = useQuery({ queryKey: ['commission-history', e.id], queryFn: () => api.get<{ history: { action: string; detail: any; at: string; by: string | null }[] }>(`/commission/entries/${e.id}/history`) });
  return (
    <div className="space-y-2 bg-mist/30 px-4 pb-3 pt-1 text-[13px] sm:pl-10">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
        <div><dt className="text-stone">Sale</dt><dd className="num">{usd(e.grossCents)}</dd></div>
        <div><dt className="text-stone">Discounts</dt><dd className="num">{usd(e.discountCents)}</dd></div>
        <div><dt className="text-stone">Commission is on</dt><dd className="num">{usd(e.eligibleCents)}</dd></div>
        <div><dt className="text-stone">Commission</dt><dd className="num font-medium">{usd(e.commissionCents)}</dd></div>
      </dl>
      <div className="rounded-lg border border-line bg-white px-3 py-2">
        <p className="mb-1 flex items-center gap-1 font-medium text-ink"><Info className="h-3.5 w-3.5" />How this was worked out</p>
        {e.calc.rule && <p className="text-ink-soft">Rule: {e.calc.rule}</p>}
        <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-ink-soft">{e.calc.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        {e.status === 'estimated' && <p className="mt-1 text-[12px] text-stone">Estimated: it follows the current rules until the period is finalized.</p>}
        {e.status === 'finalized' && <p className="mt-1 text-[12px] text-stone">Finalized: the rate and amount above are locked.</p>}
        {e.needsReview && e.reviewReason && <p className="mt-1 text-[12px] text-rose">Needs review: {e.reviewReason}</p>}
      </div>
      <p className="text-[12px] text-stone">
        {e.squareOrderId && <>Square order <span className="font-mono">{e.squareOrderId}</span>{e.squareLineItemUid && <> · line <span className="font-mono">{e.squareLineItemUid}</span></>}{e.squarePaymentIds.length > 0 && <> · payment <span className="font-mono">{e.squarePaymentIds.join(', ')}</span></>}</>}
      </p>
      {isLoading ? <Spinner /> : data?.history.length ? (
        <p className="text-[12px] text-stone">History: {data.history.map((h) => `${h.action}${h.by ? ` by ${h.by}` : ''} ${labelOfKey(dayKey(h.at), { month: 'short', day: 'numeric' })}`).join(' · ')}</p>
      ) : null}
    </div>
  );
}
