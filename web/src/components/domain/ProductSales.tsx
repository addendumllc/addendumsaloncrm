import { hairCompare } from '@addendum/shared';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ProductAnalyticsDTO } from '@addendum/shared';
import { BarChart3, Download, Table2 } from 'lucide-react';
import { api } from '../../api/client';
import { downloadCsv } from '../../lib/csv';
import { labelOfKey, money } from '../../lib/format';
import { ErrorNote, PageHeader, PageLoading, Segmented, SectionTitle, cx } from '../ui';
import { useStoreNames } from '../../lib/storeNames';

/**
 * Analytics → Product sales: what's being bought in every store (Square in the salon, Shopify online, or both): totals,
 * the trend, every product bought (searchable), monthly usage and what the stock on hand is worth.
 */

type Store = ProductAnalyticsDTO['store'];
// Same categorical order as the appointments chart (plum, ochre, teal). Never reorder.
type Ch = { key: 'square' | 'shopify' | 'shopify2'; label: string; color: string };
const BASE_CH: Ch[] = [
  { key: 'square', label: 'Square (salon)', color: '#93527A' },
  { key: 'shopify', label: 'Shopify (online)', color: '#B9822B' },
];
/** The stores to show: Square, Shopify, and the second Shopify store when there is one. */
const channelsOf = (d: ProductAnalyticsDTO, names?: { square: string; shopify: string }): Ch[] => {
  const base = names ? [{ ...BASE_CH[0], label: `${names.square} (salon)` }, { ...BASE_CH[1], label: `${names.shopify} (online)` }] : BASE_CH;
  return d.store2Name ? [...base, { key: 'shopify2', label: d.store2Name, color: '#1E86A8' }] : base;
};
const unitsOf = (t: ProductAnalyticsDTO['top'][number], k: Ch['key']) => (k === 'square' ? t.squareUnits : k === 'shopify' ? t.shopifyUnits : t.shopify2Units);
const AXIS = { fontSize: 12, fill: 'rgb(var(--stone))' };
const n0 = (v: number) => Math.round(v).toLocaleString('en-US');
const storeName = (d: ProductAnalyticsDTO) => (d.store === 'all' ? 'all stores' : d.store === 'online' ? 'online' : d.store === 'square' ? 'Square' : d.store === 'shopify' ? 'Shopify' : d.store2Name ?? 'Second store');

function change(now: number, before: number) {
  if (!before) return null;
  const p = Math.round(((now - before) / before) * 100);
  return { text: `${p > 0 ? '+' : ''}${p}% vs the period before`, up: p >= 0 };
}

/**
 * `scope` (Analytics → Salon / Online / Both): the salon's sales only, online (the Shopify stores) only, or every store.
 * Within Online and Both, a store can still be picked on its own.
 */
export function ProductSales({ scope = 'all' }: { scope?: 'salon' | 'online' | 'all' }) {
  const N = useStoreNames();
  const [period, setPeriod] = useState('30');
  const [store, setStore] = useState<Store>(scope === 'salon' ? 'square' : scope === 'online' ? 'online' : 'all');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['analytics-products', period, store],
    queryFn: () => api.get<ProductAnalyticsDTO>(`/analytics/products?period=${period}&store=${store}`),
    placeholderData: (prev) => prev,
  });
  const store2Name = data?.store2Name ?? null;
  return (
    <section className="mt-14">
      <PageHeader
        title={<span className="text-[26px]">Product sales</span>}
        subtitle={scope === 'salon' ? `What’s being bought in the salon (${N.square}).` : scope === 'online' ? `What’s being bought online (${N.shopify}${store2Name ? ` and ${store2Name}` : ''}).` : `What’s being bought in the salon (${N.square}) and online (${N.shopify}${store2Name ? ` and ${store2Name}` : ''}).`}
        actions={<Segmented value={period} onChange={setPeriod} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: 'year', label: 'This year' }, { value: '365', label: '12 months' }]} />}
      />
      {scope !== 'salon' && (scope === 'all' || store2Name) && (
        <div className="mb-4">
          <Segmented className="max-w-full overflow-x-auto" value={store} onChange={setStore} options={scope === 'online' ? [
            { value: 'online', label: `Both online` }, { value: 'shopify', label: N.shopify }, ...(store2Name ? [{ value: 'shopify2' as Store, label: store2Name }] : []),
          ] : [
            { value: 'all', label: 'All stores' }, { value: 'square', label: N.square }, { value: 'shopify', label: N.shopify },
            ...(store2Name ? [{ value: 'shopify2' as Store, label: store2Name }, { value: 'online' as Store, label: 'Online' }] : []),
          ]} />
        </div>
      )}
      {isLoading && <PageLoading />}
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {data && <Body d={data} />}
    </section>
  );
}

function Body({ d }: { d: ProductAnalyticsDTO }) {
  const N = useStoreNames();
  const u = change(d.totals.units, d.previous.units);
  const s = change(d.totals.salesCents, d.previous.salesCents);
  const tiles: { label: string; value: string; sub?: string; tone?: 'up' | 'down' }[] = [
    { label: 'Units sold', value: n0(d.totals.units), sub: u?.text, tone: u ? (u.up ? 'up' : 'down') : undefined },
    { label: 'Product sales', value: money(d.totals.salesCents), sub: s?.text ?? 'after discounts, before tax', tone: s ? (s.up ? 'up' : 'down') : undefined },
    { label: 'Products sold', value: n0(d.totals.products), sub: 'different products' },
    { label: 'Stock value', value: money(d.stock.atCostCents), sub: `at cost · ${money(d.stock.atRetailCents)} at retail${d.stock.missingCost ? ` · ${d.stock.missingCost} without a cost` : ''}` },
  ];
  const CH = channelsOf(d, N);
  const shown = d.store === 'all' ? CH : d.store === 'online' ? CH.filter((c) => c.key !== 'square') : CH.filter((c) => c.key === d.store);
  return (
    <>
      {d.salesFrom.shopifyNote && d.store !== 'square' && <p className="mb-3 rounded-xl2 border border-amber/30 bg-amber/10 px-4 py-2 text-[13px] text-ink-soft">{d.salesFrom.shopifyNote}</p>}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl2 border border-line bg-line sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="bg-white px-4 py-4 sm:px-5">
            <span className="block text-[13px] text-stone">{t.label}</span>
            <span className="num mt-1 block font-display text-[32px] font-medium leading-none text-ink">{t.value}</span>
            {t.sub && <span className={cx('mt-1.5 block text-xs', t.tone === 'up' ? 'text-sage' : t.tone === 'down' ? 'text-rose' : 'text-stone')}>{t.sub}</span>}
          </div>
        ))}
      </div>
      {d.store === 'all' && <Channels d={d} />}
      <div className="mt-10"><Trend d={d} shown={shown} /></div>
      <Products d={d} shown={shown} />
      <Monthly d={d} />
    </>
  );
}

function Channels({ d }: { d: ProductAnalyticsDTO }) {
  const CH = channelsOf(d);
  const total = d.totals.units || 1;
  return (
    <div className="mt-4 rounded-xl2 border border-line bg-white px-5 py-4">
      <div className="flex h-3 gap-[2px] overflow-hidden rounded-full" role="img" aria-label={CH.map((c) => `${c.label} ${d.totals[c.key].units} units`).join(', ')}>
        {CH.map((c) => d.totals[c.key].units > 0 && <span key={c.key} style={{ width: `${(d.totals[c.key].units / total) * 100}%`, background: c.color }} />)}
        {!d.totals.units && <span className="w-full bg-mist" />}
      </div>
      <div className={cx('mt-3 grid gap-4', CH.length > 2 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2')}>
        {CH.map((c) => (
          <div key={c.key}>
            <p className="flex items-center gap-1.5 text-[13px] text-stone"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: c.color }} />{c.label}</p>
            <p className="num text-[15px] text-ink">{n0(d.totals[c.key].units)} units · {money(d.totals[c.key].salesCents)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

const bucketLabel = (b: ProductAnalyticsDTO['bucket'], start: string) =>
  b === 'month' ? labelOfKey(start, { month: 'short', year: '2-digit' }) : labelOfKey(start, { month: 'short', day: 'numeric' });

function Trend({ d, shown }: { d: ProductAnalyticsDTO; shown: Ch[] }) {
  const [asTable, setAsTable] = useState(false);
  const empty = !d.trend.some((t) => t.square || t.shopify || t.shopify2);
  return (
    <section>
      <SectionTitle action={
        <button onClick={() => setAsTable((v) => !v)} className="inline-flex items-center gap-1.5 text-sm text-plum hover:underline">
          {asTable ? <><BarChart3 className="h-4 w-4" />Chart</> : <><Table2 className="h-4 w-4" />Table</>}
        </button>
      }>Units sold by {d.bucket}</SectionTitle>
      <div className="panel p-4">
        <div className="mb-3 flex flex-wrap gap-4 text-[13px] text-ink-soft" aria-label="Legend">
          {shown.map((c) => <span key={c.key} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: c.color }} />{c.label}</span>)}
        </div>
        {empty ? <p className="py-10 text-center text-sm text-stone">No product sales in this period.</p> : asTable ? (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line text-left text-[13px] text-stone"><th className="py-2 font-medium">{d.bucket === 'day' ? 'Day' : d.bucket === 'week' ? 'Week of' : 'Month'}</th>{shown.map((c) => <th key={c.key} className="py-2 text-right font-medium">{c.label}</th>)}<th className="py-2 text-right font-medium">Sales</th></tr></thead>
            <tbody>{d.trend.map((t) => <tr key={t.start} className="border-b border-line/60"><td className="py-1.5">{bucketLabel(d.bucket, t.start)}</td>{shown.map((c) => <td key={c.key} className="num py-1.5 text-right">{n0(t[c.key])}</td>)}<td className="num py-1.5 text-right">{money(t.salesCents)}</td></tr>)}</tbody>
          </table>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.trend} margin={{ top: 8, right: 4, left: -24, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="rgb(var(--line))" />
                <XAxis dataKey="start" tickFormatter={(v) => bucketLabel(d.bucket, v)} tick={AXIS} axisLine={false} tickLine={false} minTickGap={16} />
                <YAxis allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'rgb(var(--mist))' }} content={<Tip bucket={d.bucket} channels={channelsOf(d)} />} />
                {shown.map((c, i) => <Bar key={c.key} dataKey={c.key} stackId="a" fill={c.color} stroke="#fff" strokeWidth={2} maxBarSize={36} radius={i === shown.length - 1 ? [4, 4, 0, 0] : 0} />)}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </section>
  );
}

function Tip({ active, payload, label, bucket, channels }: { active?: boolean; payload?: { dataKey: string; value: number; fill?: string; payload?: { salesCents: number } }[]; label?: string; bucket: ProductAnalyticsDTO['bucket']; channels: Ch[] }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-white px-3 py-2 text-[13px] shadow-pop">
      <p className="mb-1 font-medium text-ink">{bucket === 'week' ? 'Week of ' : ''}{label ? bucketLabel(bucket, label) : ''}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2 text-ink-soft">
          <span className="h-2 w-2 rounded-sm" style={{ background: p.fill }} />{channels.find((c) => c.key === p.dataKey)?.label}<span className="num ml-auto pl-4 text-ink">{n0(p.value)}</span>
        </p>
      ))}
      {payload[0]?.payload && <p className="mt-1 flex text-ink-soft">Sales<span className="num ml-auto pl-4 text-ink">{money(payload[0].payload.salesCents)}</span></p>}
    </div>
  );
}

/** Every product bought in the period: search, sort, see the split by store, download. */
function Products({ d, shown }: { d: ProductAnalyticsDTO; shown: Ch[] }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'units' | 'sales' | 'name'>('units');
  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = d.top.filter((t) => words.every((w) => `${t.label} ${t.sku ?? ''} ${t.alsoSkus.join(' ')}`.toLowerCase().includes(w)));
    return [...list].sort((a, b) => sort === 'name' ? hairCompare(a, b) : sort === 'sales' ? b.salesCents - a.salesCents : b.units - a.units);
  }, [d, q, sort]);
  const max = Math.max(1, ...d.top.map((t) => t.units));
  const totalUnits = rows.reduce((a, t) => a + t.units, 0);
  const totalSales = rows.reduce((a, t) => a + t.salesCents, 0);
  const download = () => downloadCsv(`product-sales-${d.store}-${d.from}-to-${d.to}.csv`, ['Product', 'SKU', 'Units', ...shown.map((c) => `${c.label} units`), 'Sales'],
    rows.map((t) => [t.label, t.sku, t.units, ...shown.map((c) => unitsOf(t, c.key)), (t.salesCents / 100).toFixed(2)]));
  return (
    <section className="mt-10">
      <SectionTitle action={<button onClick={download} disabled={!rows.length} className="inline-flex items-center gap-1.5 text-sm text-plum hover:underline disabled:opacity-50"><Download className="h-4 w-4" />Download</button>}>
        Products bought · {storeName(d)}
      </SectionTitle>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input className="field w-72" placeholder="Search product or SKU (e.g. weft 1b)" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="field w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="units">Most units</option><option value="sales">Most sales</option><option value="name">A–Z</option>
        </select>
        {q && <span className="text-[13px] text-ink-soft">{rows.length} product{rows.length === 1 ? '' : 's'} · {n0(totalUnits)} units · {money(totalSales)}</span>}
      </div>
      <div className="overflow-x-auto rounded-xl2 border border-line bg-white">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="border-b border-line bg-mist/50 text-[11px] uppercase tracking-wide text-stone">
            <tr><th className="px-3 py-2">Product</th><th className="w-[30%] px-2 py-2" />{(d.store === 'all' || d.store === 'online') && shown.map((c) => <th key={c.key} className="px-2 py-2 text-right">{c.label.replace(/ \((salon|online)\)$/, '')}</th>)}<th className="px-2 py-2 text-right">Units</th><th className="px-3 py-2 text-right">Sales</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.slice(0, 500).map((t) => (
              <tr key={t.key}>
                <td className="max-w-[280px] px-3 py-1.5"><span className="block truncate text-ink" title={t.label}>{t.label}</span><span className="text-[11px] text-stone">{t.sku}{t.alsoSkus.length > 0 && <span title="Sales under these SKUs are included (same product name)"> · also sold as {t.alsoSkus.join(', ')}</span>}</span></td>
                <td className="px-2 py-1.5">
                  <div className="flex h-2 gap-[2px] overflow-hidden rounded-r" style={{ width: `${Math.max(2, (t.units / max) * 100)}%` }}>
                    {shown.map((c) => { const v = unitsOf(t, c.key); return v > 0 && <span key={c.key} style={{ flex: v, background: c.color }} />; })}
                  </div>
                </td>
                {(d.store === 'all' || d.store === 'online') && shown.map((c) => <td key={c.key} className="num px-2 py-1.5 text-right text-ink-soft">{n0(unitsOf(t, c.key))}</td>)}
                <td className="num px-2 py-1.5 text-right font-medium">{n0(t.units)}</td>
                <td className="num px-3 py-1.5 text-right">{money(t.salesCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="py-8 text-center text-sm text-stone">{q ? 'No products match.' : 'No product sales in this period.'}</p>}
      </div>
      {rows.length > 500 && <p className="mt-2 text-[12px] text-stone">Showing the first 500 — search to narrow it down.</p>}
    </section>
  );
}

function Monthly({ d }: { d: ProductAnalyticsDTO }) {
  const [q, setQ] = useState('');
  const [onlyUsed, setOnlyUsed] = useState(true);
  const [sort, setSort] = useState<'name' | 'avg' | 'total' | 'last'>('name');
  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = d.monthly.rows.filter((r) => (!onlyUsed || r.total !== 0) && words.every((w) => `${r.label} ${r.sku ?? ''}`.toLowerCase().includes(w)));
    const last = d.monthly.months.length - 2;
    return [...list].sort((a, b) => sort === 'avg' ? b.avgPerMonth - a.avgPerMonth : sort === 'total' ? b.total - a.total : sort === 'last' ? b.units[last] - a.units[last] : a.label.localeCompare(b.label));
  }, [d, q, onlyUsed, sort]);
  const month = (m: string) => labelOfKey(`${m}-15`, { month: 'short' });
  const download = () => downloadCsv(`monthly-sales-${d.store}.csv`, ['Product', 'SKU', ...d.monthly.months, 'Total', 'Average per month'], rows.map((r) => [r.label, r.sku, ...r.units, r.total, r.avgPerMonth]));
  return (
    <section className="mt-10">
      <SectionTitle action={<button onClick={download} className="inline-flex items-center gap-1.5 text-sm text-plum hover:underline"><Download className="h-4 w-4" />Download</button>}>Monthly sales · {storeName(d)}</SectionTitle>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input className="field w-64" placeholder="Search product or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="field w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="name">A–Z</option><option value="avg">Highest average</option><option value="total">Highest total</option><option value="last">Last month</option>
        </select>
        <label className="flex items-center gap-2 text-[13px] text-ink-soft"><input type="checkbox" checked={onlyUsed} onChange={(e) => setOnlyUsed(e.target.checked)} />Only products with sales</label>
      </div>
      <div className="overflow-x-auto rounded-xl2 border border-line bg-white">
        <table className="w-full min-w-[1000px] text-left text-[13px]">
          <thead className="border-b border-line bg-mist/50 text-[11px] uppercase tracking-wide text-stone">
            <tr><th className="px-3 py-2">Product</th>{d.monthly.months.map((m, i) => <th key={m} className={cx('px-1.5 py-2 text-right', i === d.monthly.months.length - 1 && 'italic')}>{month(m)}</th>)}<th className="px-2 py-2 text-right">Total</th><th className="px-3 py-2 text-right">Avg / month</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.slice(0, 400).map((r) => (
              <tr key={r.key}>
                <td className="max-w-[240px] px-3 py-1.5"><span className="block truncate text-ink" title={r.label}>{r.label}</span><span className="text-[11px] text-stone">{r.sku}</span></td>
                {r.units.map((x, i) => <td key={i} className={cx('num px-1.5 py-1.5 text-right', !x && 'text-stone-light', i === r.units.length - 1 && 'italic')}>{n0(x)}</td>)}
                <td className="num px-2 py-1.5 text-right font-medium">{n0(r.total)}</td>
                <td className="num px-3 py-1.5 text-right font-medium">{r.avgPerMonth}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="py-8 text-center text-sm text-stone">No products match.</p>}
      </div>
      <p className="mt-2 text-[12px] text-stone">Units bought per month (returns taken off). The last column is this month so far. The average counts complete months only, starting from each product’s first month with sales.</p>
    </section>
  );
}
