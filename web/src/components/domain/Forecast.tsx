import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { labelOfKey } from '../../lib/format';
import { EmptyState, ErrorNote, PageLoading, Segmented, cx } from '../ui';

type Status = 'order_now' | 'soon' | 'watch' | 'healthy';
interface Item {
  key: string; label: string; sku: string | null; status: Status; stock: number; incoming: number; ratePerDay: number; daysOfStock: number | null;
  orderBy: string | null; suggestedQty: number; costCents: number | null; supplier: string | null; collections: string[]; stores: { salon: boolean; online: boolean };
}

const STATUSES: { value: Status; label: string; tone: string }[] = [
  { value: 'order_now', label: 'Order now', tone: 'text-rose' },
  { value: 'soon', label: 'Reorder soon', tone: 'text-amber' },
  { value: 'watch', label: 'Watch', tone: 'text-ink' },
  { value: 'healthy', label: 'Healthy', tone: 'text-sage' },
];

/**
 * Analytics → Forecast: what to order, by urgency, for a shop (the salon or online) and a collection. Products whose
 * supplier's lead time isn't tracked aren't included (the server leaves them out). The full tool is Inventory → To order.
 */
export function ForecastWidget({ scope }: { scope: 'all' | 'salon' | 'online' }) {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['analytics-forecast'], queryFn: () => api.get<{ items: Item[] }>('/analytics/forecast') });
  const [shop, setShop] = useState<'all' | 'salon' | 'online'>(scope);
  const [coll, setColl] = useState('');
  const [status, setStatus] = useState<Status>('order_now');
  // View by product (one list), or a what-to-order summary per collection or supplier; a group narrows the list.
  const [by, setBy] = useState<'product' | 'collection' | 'supplier'>('product');
  const [group, setGroup] = useState<string | null>(null);
  const inShop = useMemo(() => (data?.items ?? []).filter((i) => shop === 'all' || i.stores[shop]), [data, shop]);
  const collections = useMemo(() => [...new Set(inShop.flatMap((i) => i.collections))].sort((a, b) => a.localeCompare(b)), [inShop]);
  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;
  // A product in several collections counts once, under its most specific one (the one with the fewest products).
  const size = new Map<string, number>();
  for (const i of inShop) for (const c of i.collections) size.set(c, (size.get(c) ?? 0) + 1);
  const groupOf = (i: Item) => (by === 'supplier' ? i.supplier ?? 'No supplier' : [...i.collections].sort((a, b) => (size.get(a) ?? 0) - (size.get(b) ?? 0) || a.localeCompare(b))[0] ?? 'No collection');
  const inColl = inShop.filter((i) => !coll || i.collections.includes(coll));
  const groups = by === 'product' ? [] : [...inColl.reduce((m, i) => m.set(groupOf(i), [...(m.get(groupOf(i)) ?? []), i]), new Map<string, Item[]>())]
    .map(([name, list]) => {
      const toOrder = list.filter((i) => i.status === 'order_now' || i.status === 'soon');
      return { name, list, toOrder, units: toOrder.reduce((n, i) => n + i.suggestedQty, 0), cost: toOrder.reduce((n, i) => n + (i.costCents ?? 0) * i.suggestedQty, 0) };
    })
    .sort((a, b) => b.toOrder.length - a.toOrder.length || b.cost - a.cost || a.name.localeCompare(b.name));
  const shown = inColl.filter((i) => by === 'product' || !group || groupOf(i) === group);
  const of = (s: Status) => shown.filter((i) => i.status === s);
  const cost = (list: Item[]) => list.reduce((n, i) => n + (i.costCents ?? 0) * i.suggestedQty, 0);
  const list = of(status).sort((a, b) => (a.orderBy ?? '').localeCompare(b.orderBy ?? '') || a.label.localeCompare(b.label));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented size="sm" value={shop} onChange={(v) => { setShop(v); setColl(''); }} options={[{ value: 'all', label: 'All shops' }, { value: 'salon', label: 'Addendum Salon' }, { value: 'online', label: 'Addendum Hair' }]} />
        <select className="field h-9 w-auto py-1 text-sm" value={by} onChange={(e) => { setBy(e.target.value as typeof by); setGroup(null); }} aria-label="View by">
          <option value="product">View by product</option><option value="collection">View by collection</option><option value="supplier">View by supplier</option>
        </select>
        <select className="field h-9 w-auto max-w-full py-1 text-sm" value={coll} onChange={(e) => setColl(e.target.value)} aria-label="Collection">
          <option value="">All collections</option>{collections.map((c) => <option key={c}>{c}</option>)}
        </select>
        <Link to="/inventory-sync?view=reorder" className="ml-auto text-[13px] text-plum hover:underline">Open To order</Link>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STATUSES.map((s) => {
          const l = of(s.value);
          const c = s.value === 'order_now' || s.value === 'soon' ? cost(l) : 0;
          return (
            <button key={s.value} type="button" onClick={() => setStatus(s.value)} aria-pressed={status === s.value}
              className={cx('rounded-xl2 border bg-white px-3 py-2 text-left transition-colors', status === s.value ? 'border-plum ring-1 ring-plum/30' : 'border-line hover:border-line-strong')}>
              <p className="text-[12px] text-stone">{s.label}</p>
              <p className={cx('num font-display text-[24px] leading-tight', l.length > 0 && s.tone)}>{l.length}</p>
              {c > 0 && <p className="text-[11px] text-stone">about ${Math.round(c / 100).toLocaleString()} to order</p>}
            </button>
          );
        })}
      </div>
      {groups.length > 0 && (
        <div className="max-h-[360px] overflow-auto rounded-xl2 border border-line bg-white">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead className="sticky top-0 border-b border-line bg-mist text-[11px] uppercase tracking-wide text-stone">
              <tr><th className="px-3 py-2">{by === 'supplier' ? 'Supplier' : 'Collection'}</th>{STATUSES.map((s) => <th key={s.value} className="px-2 py-2 text-right">{s.label}</th>)}<th className="px-2 py-2 text-right">Units to order</th><th className="px-3 py-2 text-right">About</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {groups.map((g) => (
                <tr key={g.name} className={cx('cursor-pointer hover:bg-mist/40', group === g.name && 'bg-plum-tint/40')} onClick={() => setGroup(group === g.name ? null : g.name)}>
                  <td className="px-3 py-1.5 font-medium text-ink">{g.name}</td>
                  {STATUSES.map((s) => { const n = g.list.filter((i) => i.status === s.value).length; return <td key={s.value} className={cx('num px-2 py-1.5 text-right', n > 0 && s.tone)}>{n || '—'}</td>; })}
                  <td className="num px-2 py-1.5 text-right">{g.units || '—'}</td>
                  <td className="num px-3 py-1.5 text-right">{g.cost ? `$${Math.round(g.cost / 100).toLocaleString()}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {by !== 'product' && <p className="-mt-2 text-[12px] text-stone">{group ? <>Showing {group}. <button type="button" className="text-plum hover:underline" onClick={() => setGroup(null)}>Show all</button></> : 'Units and cost are for Order now and Reorder soon. Click a row to see its products.'}</p>}
      {!list.length ? <EmptyState title={`Nothing in ${STATUSES.find((s) => s.value === status)!.label.toLowerCase()}`} /> : (
        <div className="max-h-[420px] overflow-auto rounded-xl2 border border-line bg-white">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead className="sticky top-0 border-b border-line bg-mist text-[11px] uppercase tracking-wide text-stone">
              <tr><th className="px-3 py-2">Product</th><th className="px-2 py-2 text-right">Stock</th><th className="px-2 py-2 text-right">Per day</th><th className="px-2 py-2 text-right">Days left</th><th className="px-2 py-2">Order by</th><th className="px-2 py-2 text-right">Suggested</th><th className="px-3 py-2">Supplier</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((i) => (
                <tr key={i.key}>
                  <td className="px-3 py-1.5 text-ink">{i.label}{i.sku && <span className="block font-mono text-[11px] text-stone">{i.sku}</span>}</td>
                  <td className="num px-2 py-1.5 text-right">{i.stock}{i.incoming ? <span className="text-stone"> +{i.incoming}</span> : ''}</td>
                  <td className="num px-2 py-1.5 text-right">{i.ratePerDay.toFixed(2)}</td>
                  <td className="num px-2 py-1.5 text-right">{i.daysOfStock ?? '—'}</td>
                  <td className="px-2 py-1.5">{i.orderBy ? labelOfKey(i.orderBy, { month: 'short', day: 'numeric' }) : '—'}</td>
                  <td className="num px-2 py-1.5 text-right">{i.suggestedQty || '—'}</td>
                  <td className="px-3 py-1.5 text-ink-soft">{i.supplier ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[12px] text-stone">From the last 90 days of sales, lead times and safety stock. Products whose supplier’s lead time isn’t tracked, and products with no sales, aren’t included.</p>
    </div>
  );
}
