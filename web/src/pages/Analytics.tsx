import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Info, Table2, BarChart3 } from 'lucide-react';
import { api } from '../api/client';
import { useCanDo, useIntegrations } from '../api/hooks';
import { ProjectionsSection } from '../components/domain/Projections';
import { dateShort, money, pct } from '../lib/format';
import { ErrorNote, PageHeader, PageLoading, Segmented, SectionTitle, cx } from '../components/ui';

interface Analytics {
  days: number;
  newLeads: number; leadsConverted: number; conversionRate: number | null;
  appointments: number; completed: number; cancellations: number; noShows: number;
  rebookingRate: number | null; overdueForRebooking: number;
  followUpsCompleted: number; followUpsOverdue: number;
  bookedValueCents: number; bookedValueIncomplete: boolean;
  popularServices: { name: string; count: number }[];
  newClients: number; returningClients: number;
  weekly: { week: string; completed: number; cancelled: number; noShows: number; leads: number }[];
}

// Categorical order validated for colour-blind separation (plum → ochre → teal). Never reorder.
const SERIES = [
  { key: 'completed', label: 'Completed', color: '#93527A' },
  { key: 'cancelled', label: 'Cancelled', color: '#B9822B' },
  { key: 'noShows', label: 'No-show', color: '#1E86A8' },
] as const;
const AXIS = { fontSize: 12, fill: '#75716B' };

export function AnalyticsPage() {
  const canDo = useCanDo();
  // Each part shows only with its permission; the server checks both.
  return (
    <div className="animate-rise">
      {canDo('revenue:projections') && <><PageHeader title="Analytics" /><ProjectionsSection /></>}
      {canDo('analytics:read') && <BusinessAnalytics showTitle={!canDo('revenue:projections')} />}
    </div>
  );
}

function BusinessAnalytics({ showTitle }: { showTitle: boolean }) {
  const [days, setDays] = useState('30');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['analytics', days], queryFn: () => api.get<Analytics>(`/analytics?days=${days}`) });
  const { data: integ } = useIntegrations();

  return (
    <div>
      <PageHeader
        title={showTitle ? 'Analytics' : <span className="text-[26px]">Bookings & clients</span>}
        subtitle={integ?.demoMode ? 'Calculated from demo data.' : 'Calculated from Square appointments, leads and follow-ups.'}
        actions={<Segmented value={days} onChange={setDays} options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: '12 months' }]} />}
      />
      {isLoading && <PageLoading />}
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {data && <Body d={data} />}
    </div>
  );
}

function Body({ d }: { d: Analytics }) {
  const tiles: { label: string; value: string; sub?: string; warn?: boolean }[] = [
    { label: 'New leads', value: String(d.newLeads), sub: `${d.leadsConverted} converted` },
    { label: 'Lead conversion', value: pct(d.conversionRate), sub: 'booked or became a client' },
    { label: 'Appointments', value: String(d.appointments), sub: `${d.completed} completed` },
    { label: 'Rebooking rate', value: pct(d.rebookingRate), sub: 'visited and booked again' },
    { label: 'Cancellations', value: String(d.cancellations), sub: d.appointments ? `${Math.round((d.cancellations / d.appointments) * 100)}% of bookings` : undefined },
    { label: 'No-shows', value: String(d.noShows), sub: d.appointments ? `${Math.round((d.noShows / d.appointments) * 100)}% of bookings` : undefined },
    { label: 'Overdue to rebook', value: String(d.overdueForRebooking), sub: 'clients right now', warn: d.overdueForRebooking > 0 },
    { label: 'Follow-ups done', value: String(d.followUpsCompleted), sub: `${d.followUpsOverdue} overdue now`, warn: d.followUpsOverdue > 0 },
  ];
  return (
    <>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl2 border border-line bg-line sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="bg-white px-4 py-4 sm:px-5">
            <span className="block text-[13px] text-stone">{t.label}</span>
            <span className="num mt-1 block font-display text-[36px] font-medium leading-none text-ink">{t.value}</span>
            {t.sub && <span className={cx('mt-1.5 block text-xs', t.warn ? 'text-plum' : 'text-stone')}>{t.sub}</span>}
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl2 border border-line bg-white px-5 py-4">
        <span className="text-[13px] text-stone">Booked service value (completed)</span>
        <span className="num font-display text-[30px] font-medium leading-none">{money(d.bookedValueCents)}</span>
        <span className="flex items-center gap-1 text-xs text-stone"><Info className="h-3.5 w-3.5" />From Square service prices — not payments collected (excludes tips, discounts and retail){d.bookedValueIncomplete ? '; some services have no price in Square' : ''}.</span>
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <WeeklyChart weekly={d.weekly} />
        <section>
          <SectionTitle>New vs returning</SectionTitle>
          <NewVsReturning n={d.newClients} r={d.returningClients} />
          <SectionTitle className="mt-10">New leads by week</SectionTitle>
          <div className="panel p-4">
            {d.weekly.some((w) => w.leads > 0) ? (
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.weekly} margin={{ top: 16, right: 4, left: -28, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="#EFEDE9" />
                    <XAxis dataKey="week" tickFormatter={(w) => dateShort(w)} tick={AXIS} axisLine={false} tickLine={false} minTickGap={16} />
                    <YAxis allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: '#F2F1EE' }} content={<Tip names={{ leads: 'New leads' }} />} />
                    <Bar dataKey="leads" fill="#93527A" radius={[4, 4, 0, 0]} maxBarSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : <p className="py-8 text-center text-sm text-stone">No new leads in this period.</p>}
          </div>
        </section>
      </div>

      <section className="mt-10">
        <SectionTitle>Popular services</SectionTitle>
        <div className="panel p-5">
          {d.popularServices.length === 0 ? <p className="py-6 text-center text-sm text-stone">No completed services in this period.</p> : (
            <ul className="space-y-3">
              {d.popularServices.map((s) => {
                const max = d.popularServices[0].count || 1;
                return (
                  <li key={s.name} className="grid grid-cols-[minmax(0,180px)_1fr] items-center gap-3 sm:grid-cols-[220px_1fr]">
                    <span className="truncate text-sm text-ink-soft" title={s.name}>{s.name}</span>
                    <span className="flex items-center gap-2">
                      <span className="h-3 rounded-r" style={{ width: `${Math.max(2, (s.count / max) * 100)}%`, background: '#93527A' }} />
                      <span className="num text-[13px] text-ink">{s.count}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}

function WeeklyChart({ weekly }: { weekly: Analytics['weekly'] }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section>
      <SectionTitle action={
        <button onClick={() => setAsTable((v) => !v)} className="inline-flex items-center gap-1.5 text-sm text-plum hover:underline">
          {asTable ? <><BarChart3 className="h-4 w-4" />Chart</> : <><Table2 className="h-4 w-4" />Table</>}
        </button>
      }>Appointments by week</SectionTitle>
      <div className="panel p-4">
        <div className="mb-3 flex flex-wrap gap-4 text-[13px] text-ink-soft" aria-label="Legend">
          {SERIES.map((s) => <span key={s.key} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</span>)}
        </div>
        {weekly.length === 0 ? <p className="py-10 text-center text-sm text-stone">No appointments in this period.</p> : asTable ? (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line text-left text-[13px] text-stone"><th className="py-2 font-medium">Week of</th>{SERIES.map((s) => <th key={s.key} className="py-2 text-right font-medium">{s.label}</th>)}</tr></thead>
            <tbody>{weekly.map((w) => <tr key={w.week} className="border-b border-line/60"><td className="py-1.5">{dateShort(w.week)}</td>{SERIES.map((s) => <td key={s.key} className="num py-1.5 text-right">{w[s.key]}</td>)}</tr>)}</tbody>
          </table>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weekly} margin={{ top: 8, right: 4, left: -24, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#EFEDE9" />
                <XAxis dataKey="week" tickFormatter={(w) => dateShort(w)} tick={AXIS} axisLine={false} tickLine={false} minTickGap={16} />
                <YAxis allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: '#F2F1EE' }} content={<Tip names={Object.fromEntries(SERIES.map((s) => [s.key, s.label]))} />} />
                {SERIES.map((s, i) => (
                  <Bar key={s.key} dataKey={s.key} stackId="a" fill={s.color} stroke="#fff" strokeWidth={2} maxBarSize={36} radius={i === SERIES.length - 1 ? [4, 4, 0, 0] : 0}>
                    {i === 0 && weekly.length <= 8 && <LabelList dataKey="completed" position="insideBottom" fill="#fff" fontSize={11} formatter={(v: number) => (v > 1 ? v : '')} />}
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </section>
  );
}

function Tip({ active, payload, label, names }: { active?: boolean; payload?: { dataKey: string; value: number; color?: string; fill?: string }[]; label?: string; names: Record<string, string> }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-white px-3 py-2 text-[13px] shadow-pop">
      <p className="mb-1 font-medium text-ink">Week of {label ? dateShort(label) : ''}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2 text-ink-soft">
          <span className="h-2 w-2 rounded-sm" style={{ background: p.fill ?? p.color }} />
          {names[p.dataKey] ?? p.dataKey}<span className="num ml-auto pl-4 text-ink">{p.value}</span>
        </p>
      ))}
    </div>
  );
}

function NewVsReturning({ n, r }: { n: number; r: number }) {
  const total = n + r;
  if (!total) return <div className="panel px-5 py-8 text-center text-sm text-stone">No completed visits in this period.</div>;
  const np = (n / total) * 100;
  return (
    <div className="panel px-5 py-5">
      <div className="flex h-3 gap-[2px] overflow-hidden rounded-full" role="img" aria-label={`${n} new clients, ${r} returning clients`}>
        {n > 0 && <span style={{ width: `${np}%`, background: '#93527A' }} />}
        {r > 0 && <span style={{ width: `${100 - np}%`, background: '#B9822B' }} />}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div><p className="flex items-center gap-1.5 text-[13px] text-stone"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: '#93527A' }} />New clients</p><p className="num font-display text-[30px] leading-tight">{n}</p></div>
        <div><p className="flex items-center gap-1.5 text-[13px] text-stone"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: '#B9822B' }} />Returning</p><p className="num font-display text-[30px] leading-tight">{r}</p></div>
      </div>
    </div>
  );
}
