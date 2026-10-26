import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Info, Table2, BarChart3 } from 'lucide-react';
import { api } from '../api/client';
import { useCanDo, useIntegrations } from '../api/hooks';
import { ProjectionsSection } from '../components/domain/Projections';
import { ProductSales } from '../components/domain/ProductSales';
import { ForecastWidget } from '../components/domain/Forecast';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { InventoryOverview } from '../components/domain/InventoryOverview';
import { PurchasesPage } from './Purchases';
import { SectionPicker } from '../components/layout/subNav';
import { useStoreNames } from '../lib/storeNames';
import { dateShort, money, pct } from '../lib/format';
import { ErrorNote, PageHeader, PageLoading, Segmented, SectionTitle, cx } from '../components/ui';
import { WidgetGrid, type WidgetDef } from '../components/domain/WidgetGrid';

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
const AXIS = { fontSize: 12, fill: 'rgb(var(--stone))' };

/**
 * Analytics, by store (side menu): the salon (projections, bookings & clients, salon product sales), online (the Shopify
 * stores' product sales), or both. Each part is a widget the person can move, resize or hide (Customize), like the
 * Dashboard; what they may see is still decided by their permissions (the server checks both).
 */
export function AnalyticsPage() {
  const canDo = useCanDo();
  const N = useStoreNames();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  // Sub-tabs: Addendum Salon · Addendum Hair · Both, then What to order, Inventory & Replenishment and Purchases.
  const page = (['order', 'inventory', 'purchases'] as const).find((p) => p === params.get('scope')) ?? null;
  const scope = params.get('scope') === 'salon' ? 'salon' : params.get('scope') === 'online' ? 'online' : 'all';
  const online = [N.shopify, N.shopify2].filter(Boolean).join(' + ');
  const title = scope === 'salon' ? 'Analytics · Addendum Salon' : scope === 'online' ? 'Analytics · Addendum Hair' : 'Analytics';
  const salon = scope !== 'online';
  const bookings = salon && canDo('analytics:read');
  // One period for the bookings & clients widgets.
  const [days, setDays] = useState('30');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['analytics', days], queryFn: () => api.get<Analytics>(`/analytics?days=${days}`), enabled: bookings });
  const { data: integ } = useIntegrations();
  const pending = isLoading ? <PageLoading /> : error ? <ErrorNote error={error} onRetry={refetch} /> : null;
  const w = (node: (d: Analytics) => ReactNode) => (data ? node(data) : pending);

  const defs: WidgetDef[] = [];
  if (salon && canDo('revenue:projections')) defs.push({ id: 'projections', title: 'Projected service revenue', size: 'full', ownHeading: true, node: <div className="[&>section]:mb-0"><ProjectionsSection /></div> });
  if (bookings) {
    defs.push({ id: 'at_a_glance', title: 'Bookings & clients at a glance', size: 'full', node: w((d) => <Tiles d={d} />) });
    defs.push({ id: 'booked_value', title: 'Booked service value', size: 'full', node: w((d) => <BookedValue d={d} />) });
    defs.push({ id: 'weekly', title: 'Appointments by week', size: 'l', ownHeading: true, node: w((d) => <WeeklyChart weekly={d.weekly} />) });
    defs.push({ id: 'new_vs_returning', title: 'New vs returning', size: 's', node: w((d) => <NewVsReturning n={d.newClients} r={d.returningClients} />) });
    defs.push({ id: 'leads_by_week', title: 'New clients by week', size: 'm', node: w((d) => <LeadsByWeek weekly={d.weekly} />) });
    defs.push({ id: 'popular_services', title: 'Popular services', size: 'm', node: w((d) => <PopularServices d={d} />) });
  }
  if (canDo('analytics:read')) defs.push({ id: 'forecast', title: 'Forecast: what to order', size: 'full', node: <ForecastWidget key={scope} scope={scope} /> });
  if (canDo('analytics:read')) defs.push({ id: 'product_sales', title: 'Product sales', size: 'full', ownHeading: true, node: <div className="[&>section]:mt-0"><ProductSales key={scope} scope={scope} /></div> });

  if (page === 'purchases') return <div className="animate-rise"><SectionPicker path="/analytics" names={N} can={canDo} className="mb-4" /><PurchasesPage /></div>;
  if (page) {
    const store = (['salon', 'hair'] as const).find((s) => s === params.get('for')) ?? 'all';
    const pick = (v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v === 'all') n.delete('for'); else n.set('for', v); return n; });
    return (
      <div className="animate-rise">
        <PageHeader title={page === 'order' ? 'What to order' : 'Inventory & Replenishment'}
          subtitle={page === 'order' ? 'By urgency, collection or supplier — from sales, lead times and what’s on order.' : 'Stock in the salon (Square) and online (Shopify), kept separate. Open a product for its sales, pricing and reorder details.'}
          actions={page === 'inventory' && <Segmented size="sm" value={store} onChange={pick} options={[{ value: 'all', label: 'All stores' }, { value: 'salon', label: 'Addendum Salon' }, { value: 'hair', label: 'Addendum Hair' }]} />} />
        <SectionPicker path="/analytics" names={N} can={canDo} className="mb-4" />
        {page === 'order'
          ? <ForecastWidget scope={store === 'salon' ? 'salon' : store === 'hair' ? 'online' : 'all'} />
          : <InventoryOverview store={store} onOpenTab={(view, extra = {}) => nav(`/inventory-sync?${new URLSearchParams({ ...(view === 'overview' ? {} : { view }), ...extra })}`)} />}
      </div>
    );
  }
  return (
    <div className="animate-rise">
      <PageHeader
        title={title}
        subtitle={scope === 'salon' ? 'Addendum Salon: revenue, bookings, clients and salon product sales.' : scope === 'online' ? `Addendum Hair: online sales (${online}).` : `Addendum Salon and Addendum Hair (${online}) together.`}
        actions={bookings && <Segmented value={days} onChange={setDays} options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: '12 months' }]} />}
      />
      <SectionPicker path="/analytics" names={N} can={canDo} className="mb-4" />
      {bookings && <p className="text-[13px] text-stone">Bookings & clients: {integ?.demoMode ? 'calculated from demo data' : 'calculated from Square appointments, new clients and follow-ups'}, for the last {days === '365' ? '12 months' : `${days} days`}.</p>}
      <WidgetGrid page="analytics" defs={defs} />
    </div>
  );
}

function Tiles({ d }: { d: Analytics }) {
  const tiles: { label: string; value: string; sub?: string; warn?: boolean }[] = [
    { label: 'New clients', value: String(d.newLeads), sub: `${d.leadsConverted} converted` },
    { label: 'New client conversion', value: pct(d.conversionRate), sub: 'booked or became a client' },
    { label: 'Appointments', value: String(d.appointments), sub: `${d.completed} completed` },
    { label: 'Rebooking rate', value: pct(d.rebookingRate), sub: 'visited and booked again' },
    { label: 'Cancellations', value: String(d.cancellations), sub: d.appointments ? `${Math.round((d.cancellations / d.appointments) * 100)}% of bookings` : undefined },
    { label: 'No-shows', value: String(d.noShows), sub: d.appointments ? `${Math.round((d.noShows / d.appointments) * 100)}% of bookings` : undefined },
    { label: 'Overdue to rebook', value: String(d.overdueForRebooking), sub: 'clients right now', warn: d.overdueForRebooking > 0 },
    { label: 'Follow-ups done', value: String(d.followUpsCompleted), sub: `${d.followUpsOverdue} overdue now`, warn: d.followUpsOverdue > 0 },
  ];
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl2 border border-line bg-line sm:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="bg-white px-4 py-4 sm:px-5">
          <span className="block text-[13px] text-stone">{t.label}</span>
          <span className="num mt-1 block font-display text-[36px] font-medium leading-none text-ink">{t.value}</span>
          {t.sub && <span className={cx('mt-1.5 block text-xs', t.warn ? 'text-plum' : 'text-stone')}>{t.sub}</span>}
        </div>
      ))}
    </div>
  );
}

function BookedValue({ d }: { d: Analytics }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl2 border border-line bg-white px-5 py-4">
      <span className="num font-display text-[30px] font-medium leading-none">{money(d.bookedValueCents)}</span>
      <span className="text-[13px] text-stone">completed services</span>
      <span className="flex items-center gap-1 text-xs text-stone"><Info className="h-3.5 w-3.5" />From Square service prices — not payments collected (excludes tips, discounts and retail){d.bookedValueIncomplete ? '; some services have no price in Square' : ''}.</span>
    </div>
  );
}

function LeadsByWeek({ weekly }: { weekly: Analytics['weekly'] }) {
  return (
    <div className="panel p-4">
      {weekly.some((w) => w.leads > 0) ? (
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={weekly} margin={{ top: 16, right: 4, left: -28, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="rgb(var(--line))" />
              <XAxis dataKey="week" tickFormatter={(w) => dateShort(w)} tick={AXIS} axisLine={false} tickLine={false} minTickGap={16} />
              <YAxis allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: 'rgb(var(--mist))' }} content={<Tip names={{ leads: 'New clients' }} />} />
              <Bar dataKey="leads" fill="#93527A" radius={[4, 4, 0, 0]} maxBarSize={28} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : <p className="py-8 text-center text-sm text-stone">No new clients in this period.</p>}
    </div>
  );
}

function PopularServices({ d }: { d: Analytics }) {
  return (
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
                <CartesianGrid vertical={false} stroke="rgb(var(--line))" />
                <XAxis dataKey="week" tickFormatter={(w) => dateShort(w)} tick={AXIS} axisLine={false} tickLine={false} minTickGap={16} />
                <YAxis allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'rgb(var(--mist))' }} content={<Tip names={Object.fromEntries(SERIES.map((s) => [s.key, s.label]))} />} />
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
