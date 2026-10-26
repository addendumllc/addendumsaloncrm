import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Search, X } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { downloadCsv } from '../lib/csv';
import { dayKey, relative } from '../lib/format';
import { Badge, Button, EmptyState, ErrorNote, Modal, PageHeader, PageLoading, cx, useToast } from '../components/ui';

type Store = 'square' | 'shopify' | 'shopify2';
interface Line { key: string | null; label: string; sku: string | null; quantity: number; unitCents: number | null; discountCents: number; totalCents: number }
interface Order { id: string; store: Store; storeName: string; source: string; at: string; number: string; customer: string | null; staff: string | null; status: string; lines: Line[]; units: number; totalCents: number; refundCents: number }
interface Result {
  orders: Order[]; total: number; itemMode: boolean; stores: Store[];
  summary: { orders: number; units: number; valueCents: number; averageCents: number | null };
  synced: { square?: string | null; shopify?: string | null };
}
type Item = { key: string; label: string; sku: string | null };

const usd = (c: number) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (s: string) => new Date(s).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const RANGES = [{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: 'all', label: 'All time' }, { value: 'custom', label: 'Custom range' }];
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n + 1); return dayKey(d); };

/**
 * Purchases & Transactions: completed orders from every store you can see — the salon (Square) and the Shopify stores —
 * newest first, each labelled with its store. Filter by store, dates, search or items; with items picked, the totals
 * are those items' lines only (not whole orders). Read only: nothing here changes an order or stock.
 */
export function PurchasesPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const store = params.get('store') ?? 'all';
  const range = params.get('range') ?? '30';
  const from = range === 'custom' ? params.get('from') ?? daysAgo(30) : range === 'all' ? undefined : daysAgo(Number(range));
  const to = range === 'custom' ? params.get('to') ?? dayKey(new Date()) : undefined;
  const sort = params.get('sort') === 'old' ? 'old' : 'new';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [items, setItems] = useState<Item[]>([]);
  const [limit, setLimit] = useState(50);
  const [open, setOpen] = useState<Order | null>(null);
  const set = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  // Search waits for a pause in typing.
  const [debounced, setDebounced] = useState(q);
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 300); return () => clearTimeout(t); }, [q]);
  const qs = (extra: Record<string, string> = {}) => new URLSearchParams({
    store, sort, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(debounced ? { q: debounced } : {}), ...(items.length ? { items: items.map((i) => i.key).join(',') } : {}), ...extra,
  }).toString();
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['purchases', qs({ limit: String(limit) })], queryFn: () => api.get<Result>(`/purchases?${qs({ limit: String(limit) })}`), placeholderData: (p) => p });
  // Item picker: products sold in these stores and dates.
  const [itemQ, setItemQ] = useState('');
  const { data: found } = useQuery({ queryKey: ['purchase-items', store, from, to, itemQ], enabled: itemQ.trim().length > 1,
    queryFn: () => api.get<{ items: (Item & { units: number })[] }>(`/purchases/items?${new URLSearchParams({ store, ...(from ? { from } : {}), ...(to ? { to } : {}), q: itemQ })}`).then((r) => r.items) });
  const storeOptions = useMemo(() => {
    const s = data?.stores ?? [];
    return [
      { value: 'all', label: 'All stores', show: s.length > 1 },
      { value: 'salon', label: 'Addendum Salon (Square)', show: s.includes('square') && s.length > 1 },
      { value: 'hair', label: 'Addendum Hair (Shopify)', show: s.includes('shopify') && s.length > 1 },
      { value: 'shopify', label: 'AH-PRO Shopify', show: s.includes('shopify') && s.includes('shopify2') },
      { value: 'shopify2', label: 'AH Shopify', show: s.includes('shopify2') },
    ].filter((o) => o.show);
  }, [data?.stores]);
  const pickItem = (i: Item) => { if (!items.some((x) => x.key === i.key)) setItems([...items, i]); setItemQ(''); setLimit(50); setOpen(null); };
  const filtered = store !== 'all' || range !== '30' || !!q || items.length > 0 || sort !== 'new';
  // Clears the filters only (inside Analytics the page's own ?scope= stays).
  const reset = () => { setParams((p) => { const n = new URLSearchParams(); if (p.get('scope')) n.set('scope', p.get('scope')!); return n; }, { replace: true }); setQ(''); setItems([]); setLimit(50); };
  const exportCsv = async () => {
    try {
      const all = await api.get<Result>(`/purchases?${qs({ limit: '5000' })}`);
      downloadCsv(`purchases-${dayKey(new Date())}.csv`,
        ['Date', 'Store', 'Source', 'Order', 'Customer', 'Staff', 'Status', 'Item', 'SKU', 'Quantity', 'Unit price (USD)', 'Discount (USD)', 'Line total (USD)', 'Order total (USD)'],
        all.orders.flatMap((o) => o.lines.map((l) => [o.at, o.storeName, o.source, o.number, o.customer ?? '', o.staff ?? '', o.status, l.label, l.sku ?? '', l.quantity,
          l.unitCents != null ? (l.unitCents / 100).toFixed(2) : '', (l.discountCents / 100).toFixed(2), (l.totalCents / 100).toFixed(2), (o.totalCents / 100).toFixed(2)])));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const s = data?.summary;

  return (
    <div>
      <PageHeader title="Purchases & Transactions" subtitle="Orders from every store you can see, newest first. Viewing never changes an order or stock."
        actions={<Button icon={<Download className="h-4 w-4" />} disabled={!data?.orders.length} onClick={exportCsv}>Export CSV</Button>} />

      {/* Filters: store, dates, search, items, sort — together, with Reset. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {storeOptions.length > 1 && (
          <select className="field h-10 w-auto" value={store} onChange={(e) => { set('store', e.target.value === 'all' ? null : e.target.value); setLimit(50); }} aria-label="Store">
            {storeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        <select className="field h-10 w-auto" value={range} onChange={(e) => { set('range', e.target.value === '30' ? null : e.target.value); setLimit(50); }} aria-label="Dates">
          {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        {range === 'custom' && <>
          <input type="date" className="field h-10 w-auto" value={from} max={to} onChange={(e) => e.target.value && set('from', e.target.value)} aria-label="From" />
          <input type="date" className="field h-10 w-auto" value={to} min={from} onChange={(e) => e.target.value && set('to', e.target.value)} aria-label="To" />
        </>}
        <label className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
          <input className="field h-10 pl-9" placeholder="Order #, customer, staff or product" value={q} onChange={(e) => { setQ(e.target.value); setLimit(50); }} aria-label="Search purchases" />
        </label>
        <select className="field h-10 w-auto" value={sort} onChange={(e) => set('sort', e.target.value === 'new' ? null : e.target.value)} aria-label="Sort">
          <option value="new">Newest first</option><option value="old">Oldest first</option>
        </select>
        {filtered && <Button variant="ghost" onClick={reset}>Reset filters</Button>}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative w-full sm:w-72">
          <input className="field h-10" placeholder="Filter by item: name or SKU" value={itemQ} onChange={(e) => setItemQ(e.target.value)} aria-label="Filter by item" />
          {!!found?.length && itemQ.trim().length > 1 && (
            <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-line bg-white shadow-pop">
              {found.map((i) => <li key={i.key}><button type="button" className="w-full px-3 py-2 text-left text-[13px] hover:bg-mist" onClick={() => pickItem(i)}>{i.label}<span className="ml-1 text-stone">{i.sku ? `${i.sku} · ` : ''}{i.units} sold</span></button></li>)}
            </ul>
          )}
        </label>
        {items.map((i) => (
          <span key={i.key} className="inline-flex items-center gap-1 rounded-full border border-plum/40 bg-plum-tint/40 py-1 pl-3 pr-1 text-[13px] text-ink">
            {i.label}<button type="button" className="rounded-full p-0.5 text-stone hover:text-ink" aria-label={`Remove ${i.label}`} onClick={() => setItems(items.filter((x) => x.key !== i.key))}><X className="h-3.5 w-3.5" /></button>
          </span>
        ))}
      </div>

      {isLoading ? <PageLoading /> : error || !data ? <ErrorNote error={error} onRetry={refetch} /> : (
        <>
          <div className="mb-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {([
              [data.itemMode ? 'Orders with these items' : 'Orders', String(s!.orders)],
              [data.itemMode ? 'Units of these items' : 'Units', String(s!.units)],
              [data.itemMode ? 'Item sales' : 'Order value', usd(s!.valueCents)],
              [data.itemMode ? 'Average price per unit' : 'Average order', s!.averageCents != null ? usd(s!.averageCents) : '—'],
            ] as const).map(([l, v]) => (
              <div key={l} className="rounded-xl2 border border-line bg-white px-3 py-2"><p className="text-[12px] text-stone">{l}</p><p className="num font-display text-[22px] leading-tight">{v}</p></div>
            ))}
          </div>
          <p className="mb-3 text-[12px] text-stone">
            {data.itemMode ? 'Totals are the chosen items’ lines only, not whole orders. ' : 'Order value is each order’s total as charged. '}Cancelled orders aren’t counted.
            {data.synced.square !== undefined && ` Square: ${data.synced.square ? `updated ${relative(data.synced.square)}` : 'not synced yet'}.`}
            {data.synced.shopify !== undefined && ` Shopify: ${data.synced.shopify ? `updated ${relative(data.synced.shopify)}` : 'not synced yet'}.`}
          </p>
          {!data.orders.length ? <EmptyState title="No purchases match">Try other dates or stores, or reset the filters.</EmptyState> : (
            <div className={cx('divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-white', isFetching && 'opacity-70')}>
              {data.orders.map((o) => (
                <button key={o.id} type="button" onClick={() => setOpen(o)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-mist/40">
                  <span className="min-w-0 flex-1 basis-56">
                    <span className="block text-[14px] font-medium text-ink">{o.number || o.source} <span className="font-normal text-stone">· {o.storeName}</span></span>
                    <span className="block truncate text-[12px] text-stone">{when(o.at)}{o.customer ? ` · ${o.customer}` : ''}{o.staff ? ` · ${o.staff}` : ''}</span>
                    <span className="block truncate text-[12px] text-ink-soft">{o.lines.map((l) => `${l.quantity}× ${l.label}`).join(', ')}</span>
                  </span>
                  {o.status !== 'Completed' && o.status !== 'Paid' && <Badge tone={o.status === 'Cancelled' ? 'neutral' : 'amber'}>{o.status}</Badge>}
                  <span className="num w-16 text-right text-[13px] text-ink-soft"><span className="block text-[11px] text-stone">Units</span>{o.lines.reduce((a, l) => a + l.quantity, 0)}</span>
                  <span className="num w-24 text-right text-[14px] font-medium text-ink"><span className="block text-[11px] font-normal text-stone">{data.itemMode ? 'Items' : 'Total'}</span>{usd(data.itemMode ? o.lines.reduce((a, l) => a + l.totalCents, 0) : o.totalCents)}</span>
                </button>
              ))}
            </div>
          )}
          {data.total > data.orders.length && <div className="mt-3 text-center"><Button loading={isFetching} onClick={() => setLimit(limit + 50)}>Load more ({data.total - data.orders.length} more)</Button></div>}
        </>
      )}

      {open && (
        <Modal open side onClose={() => setOpen(null)} title={`${open.number || open.source} · ${open.storeName}`}>
          <div className="space-y-4 text-[14px]">
            <dl className="divide-y divide-line">
              {([['Date', when(open.at)], ['Store', `${open.storeName} (${open.source})`], ['Status', open.status], ['Customer', open.customer ?? '—'], ['Staff', open.staff ?? '—'], ['Reference', open.id.split(':').slice(1).join(':')]] as const).map(([l, v]) => (
                <div key={l} className="flex justify-between gap-3 py-1"><dt className="text-stone">{l}</dt><dd className="break-all text-right text-ink">{v}</dd></div>
              ))}
            </dl>
            <section>
              <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-stone">{data?.itemMode ? 'Matching items' : 'Items'}</h3>
              <ul className="divide-y divide-line">
                {open.lines.map((l, i) => (
                  <li key={i} className="py-2">
                    <div className="flex justify-between gap-3"><span className="text-ink">{l.quantity}× {l.label}</span><span className="num font-medium">{usd(l.totalCents)}</span></div>
                    <div className="flex justify-between gap-3 text-[12px] text-stone">
                      <span>{l.sku ?? ''}{l.unitCents != null ? ` · ${usd(l.unitCents)} each` : ''}{l.discountCents ? ` · ${usd(l.discountCents)} off` : ''}</span>
                      {l.key && <button type="button" className="text-plum hover:underline" onClick={() => pickItem({ key: l.key!, label: l.label, sku: l.sku })}>This item’s history</button>}
                    </div>
                  </li>
                ))}
              </ul>
              {!data?.itemMode && <p className="mt-2 flex justify-between border-t border-line pt-2 font-medium"><span>Order total</span><span className="num">{usd(open.totalCents)}</span></p>}
              {open.refundCents > 0 && <p className="mt-1 text-[13px] text-amber">Refunded {usd(open.refundCents)}.</p>}
            </section>
          </div>
        </Modal>
      )}
    </div>
  );
}
