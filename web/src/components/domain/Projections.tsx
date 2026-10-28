import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, ChevronLeft, ChevronRight, Info, Lock } from 'lucide-react';
import { api } from '../../api/client';
import { addDaysKey, dayKey, labelOfKey, time, weekdayOfKey } from '../../lib/format';
import { Badge, Button, ErrorNote, SectionTitle, Segmented, Spinner, cx } from '../ui';

/**
 * Projected SERVICE revenue (Admins/Owners by default — the server checks "revenue:projections" on every request).
 * From confirmed salon appointments and their booked service prices; never product/retail sales or commission,
 * and never collected money. Appointments without a known price are counted and flagged, not added.
 */
export interface PeriodTotals {
  from: string; to: string; label: string; revenueCents: number; appointments: number; clients: number;
  estimatedAppointments: number; unestimatedAppointments: number; pricedClients: number;
  avgPerClientCents: number | null; avgPerAppointmentCents: number | null;
}
interface Projection { from: string; to: string; total: PeriodTotals; buckets: PeriodTotals[]; awaitingConfirmation: { appointments: number; revenueCents: number; unestimated: number }; timezone: string }
interface ProjectedAppointment {
  id: string; startAt: string; day: string; clientName: string; staffName: string | null; services: { name: string; priceCents: number | null }[];
  expectedCents: number | null; status: 'confirmed' | 'awaiting confirmation'; counted: boolean;
}

export const usd = (cents: number | null | undefined) => (cents == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100));
const mondayOf = (k: string) => addDaysKey(k, -((weekdayOfKey(k) + 6) % 7));
const monthStart = (k: string) => `${k.slice(0, 7)}-01`;
const monthEnd = (k: string) => addDaysKey(`${addDaysKey(`${k.slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1);
const shiftMonth = (k: string, n: number) => {
  const [y, m] = k.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
};
const fmt = (k: string, o: Intl.DateTimeFormatOptions) => labelOfKey(k, o);

type Mode = 'week' | 'month' | 'future' | 'custom';
type Future = '7' | '30' | '90';

export function ProjectionsSection() {
  const today = dayKey(new Date());
  const [mode, setMode] = useState<Mode>('week');
  const [week, setWeek] = useState(mondayOf(today));
  const [month, setMonth] = useState(monthStart(today));
  const [future, setFuture] = useState<Future>('30');
  // Custom dates can be in the past too (what was booked then), up to two years at a time.
  const [custom, setCustom] = useState({ from: addDaysKey(today, -30), to: today });

  const range = useMemo(() => {
    if (mode === 'week') return { from: week, to: addDaysKey(week, 6), by: 'day' as const, label: `${fmt(week, { month: 'short', day: 'numeric' })} – ${fmt(addDaysKey(week, 6), { month: 'short', day: 'numeric', year: 'numeric' })}` };
    if (mode === 'month') return { from: month, to: monthEnd(month), by: 'week' as const, label: fmt(month, { month: 'long', year: 'numeric' }) };
    const r = mode === 'custom' ? custom : { from: today, to: addDaysKey(today, Number(future) - 1) };
    const days = (Date.parse(`${r.to}T12:00:00Z`) - Date.parse(`${r.from}T12:00:00Z`)) / 86400_000 + 1;
    return { ...r, by: (days <= 14 ? 'day' : days <= 92 ? 'week' : 'month') as 'day' | 'week' | 'month', label: `${fmt(r.from, { month: 'short', day: 'numeric' })} – ${fmt(r.to, { month: 'short', day: 'numeric', year: 'numeric' })}` };
  }, [mode, week, month, future, custom, today]);

  const valid = range.from <= range.to;
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['projections', range.from, range.to, range.by],
    queryFn: () => api.get<Projection>(`/projections?from=${range.from}&to=${range.to}&by=${range.by}`),
    enabled: valid, refetchInterval: 120_000,
  });
  const [showAppts, setShowAppts] = useState(false);

  const nav = (dir: -1 | 1) => (mode === 'week' ? setWeek(addDaysKey(week, 7 * dir)) : setMonth(shiftMonth(month, dir)));
  const isCurrent = mode === 'week' ? week === mondayOf(today) : month === monthStart(today);

  return (
    <section id="projections" className="mb-12">
      <SectionTitle>Projected service revenue</SectionTitle>
      <p className="-mt-1 mb-4 flex items-start gap-2 text-[13px] text-stone">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>Projections from booked salon appointments at their service prices — <b className="font-medium text-ink-soft">not collected sales</b>, and separate from hair product, retail and commission figures. Visible to administrators only.</span>
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented value={mode} onChange={(v) => { setMode(v); setShowAppts(false); }} options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'future', label: 'Future' }, { value: 'custom', label: 'Custom dates' }]} />
        {mode === 'custom' ? (
          <span className="flex flex-wrap items-center gap-1.5 text-sm">
            <input type="date" className="field h-10 w-auto" value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} aria-label="From" />
            <span className="text-stone">to</span>
            <input type="date" className="field h-10 w-auto" value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} aria-label="To" />
          </span>
        ) : mode !== 'future' ? (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" icon={<ChevronLeft className="h-4 w-4" />} onClick={() => nav(-1)} aria-label={`Previous ${mode}`} />
            <span className="min-w-0 text-center text-[14px] font-medium text-ink sm:min-w-[180px]">{range.label}</span>
            <Button size="sm" variant="ghost" icon={<ChevronRight className="h-4 w-4" />} onClick={() => nav(1)} aria-label={`Next ${mode}`} />
            {!isCurrent && <Button size="sm" variant="ghost" onClick={() => (mode === 'week' ? setWeek(mondayOf(today)) : setMonth(monthStart(today)))}>This {mode}</Button>}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Segmented className="max-w-full overflow-x-auto" value={future} onChange={setFuture} options={[{ value: '7', label: 'Next 7 days' }, { value: '30', label: 'Next 30 days' }, { value: '90', label: 'Next 90 days' }]} />
          </div>
        )}
      </div>

      {!valid && <p className="text-[13px] text-rose">The start date must be before the end date.</p>}
      {valid && range.from < today && <p className="mb-3 flex items-start gap-1.5 text-[13px] text-stone"><Info className="mt-0.5 h-4 w-4 shrink-0" />Past dates show what was booked at service prices (cancellations and no-shows left out), not what was actually paid.</p>}
      {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {data && (
        <>
          <Cards t={data.total} />
          {(data.total.unestimatedAppointments > 0 || data.awaitingConfirmation.appointments > 0) && (
            <div className="mt-3 space-y-1 text-[13px]">
              {data.total.unestimatedAppointments > 0 && <p className="flex items-start gap-1.5 text-amber"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{data.total.unestimatedAppointments} booked appointment{data.total.unestimatedAppointments === 1 ? ' has' : 's have'} no known price (Unestimated) — counted in bookings, not in revenue or averages. Add prices to those services in Square.</p>}
              {data.awaitingConfirmation.appointments > 0 && <p className="flex items-start gap-1.5 text-stone"><Info className="mt-0.5 h-4 w-4 shrink-0" />Also {data.awaitingConfirmation.appointments} booking request{data.awaitingConfirmation.appointments === 1 ? '' : 's'} awaiting confirmation in Square ({usd(data.awaitingConfirmation.revenueCents)}{data.awaitingConfirmation.unestimated ? ' + unestimated' : ''}) — not included until accepted.</p>}
            </div>
          )}
          <Breakdown p={data} />
          <div className="mt-4">
            <Button size="sm" onClick={() => setShowAppts(!showAppts)}>{showAppts ? 'Hide appointments' : 'Show the appointments behind these figures'}</Button>
          </div>
          {showAppts && <AppointmentList from={range.from} to={range.to} />}
        </>
      )}
    </section>
  );
}

function Cards({ t }: { t: PeriodTotals }) {
  const Card = ({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) => (
    <div className={cx('rounded-xl2 border bg-white px-4 py-3', strong ? 'border-ink/20 bg-mist/40' : 'border-line')}>
      <p className="text-[12px] font-medium uppercase tracking-wide text-stone">{label}</p>
      <p className={cx('num mt-1 font-display leading-none text-ink', strong ? 'text-[34px]' : 'text-[26px]')}>{value}</p>
      {sub && <p className="mt-1 text-[12px] text-stone">{sub}</p>}
    </div>
  );
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <div className="col-span-2 lg:col-span-1"><Card strong label="Projected service revenue" value={usd(t.revenueCents)} sub="Projection — not collected" /></div>
      <Card label="Clients booked" value={String(t.clients)} sub="Unique clients" />
      <Card label="Appointments booked" value={String(t.appointments)} sub={t.unestimatedAppointments ? `${t.unestimatedAppointments} unestimated` : 'All priced'} />
      <Card label="Avg per client" value={usd(t.avgPerClientCents)} sub="Projected" />
      <Card label="Avg per appointment" value={usd(t.avgPerAppointmentCents)} sub="Projected" />
    </div>
  );
}

function Breakdown({ p }: { p: Projection }) {
  const data = p.buckets.map((b) => ({ name: b.label.replace(/^Week of /, ''), revenue: b.revenueCents / 100 }));
  return (
    <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="panel p-4">
        <p className="mb-2 text-[13px] font-medium text-ink-soft">Projected service revenue</p>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="rgb(var(--line))" />
              {/* Labels thin out on narrow screens instead of running into each other. */}
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'rgb(var(--stone))' }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={12} />
              <YAxis tick={{ fontSize: 11, fill: 'rgb(var(--stone))' }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${Math.round(Number(v)).toLocaleString()}`} width={60} />
              <Tooltip formatter={(v: number) => [`$${Math.round(v).toLocaleString()}`, 'Projected']} cursor={{ fill: 'rgb(var(--mist))' }} />
              <Bar dataKey="revenue" fill="#93527A" radius={[4, 4, 0, 0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl2 border border-line bg-white">
        <table className="w-full min-w-[560px] text-left text-[14px]">
          <thead className="border-b border-line bg-mist/50 text-[12px] uppercase tracking-wide text-stone">
            <tr><th className="px-3 py-2 font-medium">Period</th><th className="px-2 py-2 text-right font-medium">Clients</th><th className="px-2 py-2 text-right font-medium">Appts</th><th className="px-2 py-2 text-right font-medium">Projected</th><th className="px-2 py-2 text-right font-medium">Avg / client</th><th className="px-3 py-2 text-right font-medium">Avg / appt</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {[...p.buckets, p.total].map((b, i) => {
              const total = i === p.buckets.length;
              return (
                <tr key={`${b.from}-${i}`} className={cx(total && 'bg-mist/40 font-medium')}>
                  <td className="px-3 py-2">{total ? 'Total' : b.label}{!total && b.from !== b.to && <span className="block text-[11px] text-stone">{fmt(b.from, { month: 'short', day: 'numeric' })} – {fmt(b.to, { month: 'short', day: 'numeric' })}</span>}{b.unestimatedAppointments > 0 && <Badge tone="amber" className="ml-1">{b.unestimatedAppointments} unestimated</Badge>}</td>
                  <td className="num px-2 py-2 text-right">{b.clients}</td>
                  <td className="num px-2 py-2 text-right">{b.appointments}</td>
                  <td className="num px-2 py-2 text-right">{usd(b.revenueCents)}</td>
                  <td className="num px-2 py-2 text-right text-ink-soft">{usd(b.avgPerClientCents)}</td>
                  <td className="num px-3 py-2 text-right text-ink-soft">{usd(b.avgPerAppointmentCents)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="border-t border-line px-3 py-2 text-[11px] text-stone">The total counts each client once across the whole range, so it can be less than the sum of the rows.</p>
      </div>
    </div>
  );
}

function AppointmentList({ from, to }: { from: string; to: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['projection-appointments', from, to], queryFn: () => api.get<{ appointments: ProjectedAppointment[] }>(`/projections/appointments?from=${from}&to=${to}`).then((r) => r.appointments) });
  if (isLoading) return <div className="flex justify-center py-6"><Spinner /></div>;
  if (!data?.length) return <p className="mt-3 text-[14px] text-stone">No booked appointments in these dates.</p>;
  return (
    <div className="mt-3 overflow-x-auto rounded-xl2 border border-line bg-white">
      <table className="w-full min-w-[760px] text-left text-[14px]">
        <thead className="border-b border-line bg-mist/50 text-[12px] uppercase tracking-wide text-stone">
          <tr><th className="px-3 py-2 font-medium">Date & time</th><th className="px-2 py-2 font-medium">Client</th><th className="px-2 py-2 font-medium">Stylist</th><th className="px-2 py-2 font-medium">Services (expected price)</th><th className="px-2 py-2 text-right font-medium">Expected total</th><th className="px-3 py-2 font-medium">Status</th></tr>
        </thead>
        <tbody className="divide-y divide-line">
          {data.map((a) => (
            <tr key={a.id} className="align-top">
              <td className="whitespace-nowrap px-3 py-2">{fmt(a.day, { weekday: 'short', month: 'short', day: 'numeric' })}<span className="block text-[12px] text-stone">{time(a.startAt)}</span></td>
              <td className="px-2 py-2">{a.clientName}</td>
              <td className="px-2 py-2 text-ink-soft">{a.staffName ?? '—'}</td>
              <td className="px-2 py-2 text-[13px] text-ink-soft">{a.services.map((s, i) => <span key={i} className="block">{s.name} · {s.priceCents == null ? <span className="text-amber">no price</span> : usd(s.priceCents)}</span>)}</td>
              <td className="num px-2 py-2 text-right">{a.expectedCents == null ? <Badge tone="amber">Unestimated</Badge> : usd(a.expectedCents)}</td>
              <td className="px-3 py-2">{a.status === 'confirmed' ? <Badge tone="sage">Confirmed</Badge> : <Badge>Awaiting confirmation</Badge>}{!a.counted && <span className="block text-[11px] text-stone">not in the projection</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
