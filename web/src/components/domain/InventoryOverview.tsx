import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { PurchaseOrderDTO, StockForecastDTO, StockForecastResponse, StockProductDTO, StockProductStatus, StockTxnDTO, SupplierDTO } from '@addendum/shared';
import { api } from '../../api/client';
import { dateShort, labelOfKey } from '../../lib/format';
import { useStoreNames } from '../../lib/storeNames';
import { collectionFilter, useInternalCollections, collectionLabel } from './Collections';
import { Badge, Button, EmptyState, ErrorNote, Field, Modal, PageLoading, cx, useToast } from '../ui';

type Store = 'all' | 'salon' | 'hair';
type Sales = {
  hasSales: boolean; lastSaleOn: string | null; avgPerDay30: number; avgPerMonth: number;
  periods: Record<'d7' | 'd30' | 'd90' | 'd365', { units: number; revenueCents: number }>; previous30: { units: number; revenueCents: number };
  months: { month: string; square: number; shopify: number; shopify2: number; total: number; partial: boolean }[];
  byChannel: { channel: string; name: string; units: number; revenueCents: number }[];
};
const usd0 = (c: number) => `$${Math.round(c / 100).toLocaleString()}`;
type PriceListing = { variantId: string; label: string; priceCents: number | null; pro?: boolean };
type PriceRow = { key: string; costCents: number | null; costFrom: 'crm' | 'shopify' | null; square: { priceCents: number | null } | null; shopify: PriceListing[]; shopify2: PriceListing[] };
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
/** Gross margin on a selling price: only when both the price and our cost are known and the price is above zero. */
const marginOf = (price: number | null | undefined, cost: number | null) => (price != null && price > 0 && cost != null ? Math.round(((price - cost) / price) * 100) : null);
type Simple = 'out' | 'low' | 'watch' | 'ok' | 'discontinued' | 'skipped';
const SIMPLE: Record<Simple, { label: string; tone: 'rose' | 'amber' | 'neutral' | 'sage' | 'plum' }> = {
  out: { label: 'Out of stock', tone: 'rose' }, low: { label: 'Low stock', tone: 'amber' }, watch: { label: 'Watch', tone: 'neutral' },
  ok: { label: 'In stock', tone: 'sage' }, discontinued: { label: 'Discontinued', tone: 'neutral' }, skipped: { label: 'Skipped', tone: 'neutral' },
};
const PAGE = 50;

/** One simple stock status from the forecast: out, low (order now / reorder soon), watch, in stock — or discontinued / skipped. */
function simpleOf(p: StockProductDTO, f: StockForecastDTO | undefined): Simple {
  if (f?.skippedUntil) return 'skipped';
  if (p.status === 'discontinued' || f?.status === 'discontinued') return 'discontinued';
  const stock = Math.max(p.squareQty ?? -Infinity, p.shopifyQty ?? -Infinity);
  if (f?.status === 'out' || (!f && stock <= 0)) return 'out';
  if (f?.status === 'order_now' || f?.status === 'soon') return 'low';
  if (f?.status === 'watch') return 'watch';
  return 'ok';
}

/**
 * Inventory → Overview: a few counts (each opens its list), then every product — searchable, filterable and sortable —
 * with Square (salon) and Shopify (online) stock side by side, never added together. A product opens in a side panel.
 */
export function InventoryOverview({ store, onOpenTab }: { store: Store; onOpenTab: (view: string, params?: Record<string, string>) => void }) {
  const N = useStoreNames();
  const products = useQuery({ queryKey: ['stock-products'], queryFn: () => api.get<{ products: StockProductDTO[] }>('/inventory-sync/stock/products'), staleTime: 20_000 });
  const forecast = useQuery({ queryKey: ['stock-forecast'], queryFn: () => api.get<StockForecastResponse>('/inventory-sync/stock/forecast') });
  const pos = useQuery({ queryKey: ['stock-pos'], queryFn: () => api.get<{ orders: PurchaseOrderDTO[] }>('/inventory-sync/stock/purchase-orders').then((r) => r.orders) });
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | Simple>('');
  const [coll, setColl] = useState('');
  const [sort, setSort] = useState<'name' | 'stock' | 'status'>('name');
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  // Ticked products (any page of the list), to put in an inventory collection together.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [newName, setNewName] = useState('');
  const [moving, setMoving] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();

  // A product's forecast: by key, else by SKU (a SKU in both stores without being paired is forecast once).
  const fc = useMemo(() => {
    const byKey = new Map<string, StockForecastDTO>();
    const bySku = new Map<string, StockForecastDTO>();
    for (const i of forecast.data?.items ?? []) { byKey.set(i.key, i); if (i.sku) bySku.set(i.sku.toLowerCase(), i); }
    return (p: StockProductDTO) => byKey.get(p.key) ?? (p.sku ? bySku.get(p.sku.toLowerCase()) : undefined);
  }, [forecast.data]);
  const inStore = (p: StockProductDTO) => store === 'all' || (store === 'salon' ? !!p.squareVariationId : !!p.shopifyInventoryItemId || p.store2.length > 0);
  const all = useMemo(() => (products.data?.products ?? []).filter((p) => p.status !== 'not_tracked' && (p.squareQty != null || p.shopifyQty != null) && inStore(p)),
    [products.data, store]); // eslint-disable-line react-hooks/exhaustive-deps
  const statusOf = useMemo(() => new Map(all.map((p) => [p.key, simpleOf(p, fc(p))])), [all, fc]);
  const { data: internal } = useInternalCollections();
  const collFilter = useMemo(() => collectionFilter(internal, [...new Set(all.flatMap((p) => p.collections))].sort((a, b) => a.localeCompare(b))), [internal, all]);

  if (products.isLoading || forecast.isLoading) return <PageLoading />;
  if (products.error || !products.data) return <ErrorNote error={products.error} onRetry={products.refetch} />;

  const count = (s: Simple) => all.filter((p) => statusOf.get(p.key) === s).length;
  const openPos = (pos.data ?? []).filter((p) => !['received', 'cancelled'].includes(p.status) && (store === 'all' || p.store === (store === 'salon' ? 'salon' : 'shopify')));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const order: Simple[] = ['out', 'low', 'watch', 'ok', 'skipped', 'discontinued'];
  const stockOf = (p: StockProductDTO) => (store === 'salon' ? p.squareQty ?? 0 : store === 'hair' ? p.shopifyQty ?? 0 : Math.max(p.squareQty ?? 0, p.shopifyQty ?? 0));
  const rows = all
    .filter((p) => (!status || statusOf.get(p.key) === status) && (!coll || collFilter.matches(p, coll))
      && words.every((w) => `${p.label} ${p.sku ?? ''} ${p.collections.join(' ')}`.toLowerCase().includes(w)))
    .sort((a, b) => (sort === 'stock' ? stockOf(a) - stockOf(b) : sort === 'status' ? order.indexOf(statusOf.get(a.key)!) - order.indexOf(statusOf.get(b.key)!) : 0) || a.label.localeCompare(b.label));
  const tile = (label: string, n: number, active: boolean, onClick: () => void, tone?: string) => (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cx('rounded-xl2 border bg-white px-3 py-2 text-left transition-colors', active ? 'border-plum ring-1 ring-plum/30' : 'border-line hover:border-line-strong')}>
      <span className="block text-[12px] text-stone">{label}</span>
      <span className={cx('num font-display text-[24px] leading-tight', n > 0 && tone)}>{n}</span>
    </button>
  );
  const pick = (s: '' | Simple) => { setStatus(status === s ? '' : s); setShown(PAGE); };
  const togglePick = (k: string) => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const salonCol = store !== 'hair';
  const onlineCol = store !== 'salon';
  const opened = all.find((p) => p.key === open) ?? null;

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tile('Active products', all.filter((p) => !['discontinued'].includes(statusOf.get(p.key)!)).length, status === '', () => pick(''))}
        {tile('Low stock', count('low'), status === 'low', () => pick('low'), 'text-amber')}
        {tile('Out of stock', count('out'), status === 'out', () => pick('out'), 'text-rose')}
        {tile('Open purchase orders', openPos.length, false, () => onOpenTab('orders'))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[14rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
          <input className="field h-11 pl-9 text-[16px] sm:text-[14px]" placeholder="Search products, SKUs or collections" value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} aria-label="Search products" />
        </label>
        <select className="field h-11 w-auto" value={status} onChange={(e) => pick(e.target.value as '' | Simple)} aria-label="Stock status">
          <option value="">All statuses</option>{order.map((s) => <option key={s} value={s}>{SIMPLE[s].label}</option>)}
        </select>
        <select className="field h-11 w-auto max-w-[12rem]" value={coll} onChange={(e) => { setColl(e.target.value); setShown(PAGE); }} aria-label="Collection">
          <option value="">All collections</option>{collFilter.options.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select className="field h-11 w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
          <option value="name">Sort by name</option><option value="stock">Sort by stock (low first)</option><option value="status">Sort by status</option>
        </select>
      </div>
      {/* Select all (everything matching the search and filters), then put them in an inventory collection. */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
        <label className="flex items-center gap-2 text-ink-soft">
          <input type="checkbox" className="h-4 w-4 accent-plum" checked={rows.length > 0 && rows.every((p) => picked.has(p.key))}
            onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((p) => p.key)) : new Set())} aria-label="Select all shown" />
          {picked.size ? `${picked.size} selected` : `Select all ${rows.length}`}
        </label>
        {picked.size > 0 && <>
          <select className="field h-9 w-auto py-1 text-[13px]" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Inventory collection">
            <option value="">Put in collection…</option>
            {(internal?.collections ?? []).map((c) => <option key={c.name} value={c.name}>{collectionLabel(c.name)}</option>)}
            <option value="__new">New collection…</option>
            <option value="__none">No collection (take out)</option>
          </select>
          {target === '__new' && <input className="field h-9 w-48 py-1 text-[13px]" placeholder="Collection name" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="New collection name" />}
          <Button size="sm" variant="primary" loading={moving} disabled={!target || (target === '__new' && !newName.trim())} onClick={async () => {
            const collection = target === '__none' ? null : target === '__new' ? newName.trim() : target;
            setMoving(true);
            try {
              const r = await api.post<{ count: number }>('/inventory-sync/stock/collections/assign', { collection, keys: [...picked] });
              toast(`${r.count} product${r.count === 1 ? '' : 's'} ${collection ? `put in ${collection}` : 'taken out of their collection'}`);
              setPicked(new Set()); setTarget(''); setNewName('');
              for (const k of ['stock-products', 'stock-collections', 'stock-forecast']) void qc.invalidateQueries({ queryKey: [k] });
            } catch (e) { toast((e as Error).message, 'error'); } finally { setMoving(false); }
          }}>Apply to {picked.size}</Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
        </>}
      </div>
      <p className="mb-2 text-[12px] text-stone">{rows.length} product{rows.length === 1 ? '' : 's'}{salonCol && onlineCol ? ` · Salon = ${N.square}, Online = ${[N.shopify, N.shopify2].filter(Boolean).join(' + ')} (kept separate)` : ''}</p>

      {!rows.length ? <EmptyState title="No products match">Try another search or filter.</EmptyState> : (
        <>
          {/* Phones: one compact row per product. */}
          <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-white sm:hidden">
            {rows.slice(0, shown).map((p) => (
              <li key={p.key}>
                <div className="flex items-center gap-1 pl-3">
                <input type="checkbox" className="h-5 w-5 shrink-0 accent-plum" checked={picked.has(p.key)} onChange={() => togglePick(p.key)} aria-label={`Select ${p.label}`} />
                <button type="button" onClick={() => setOpen(p.key)} className="flex w-full items-center gap-3 px-3 py-3 text-left">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] leading-snug text-ink">{p.label}</span>
                    <span className="block font-mono text-[11px] text-stone">{p.sku ?? 'No SKU'}</span>
                  </span>
                  <span className="flex flex-col items-end gap-1">
                    <span className="num text-[15px] font-medium text-ink">{salonCol && onlineCol ? `${p.squareQty ?? '—'} · ${p.shopifyQty ?? '—'}` : stockOf(p)}</span>
                    <Badge tone={SIMPLE[statusOf.get(p.key)!].tone}>{SIMPLE[statusOf.get(p.key)!].label}</Badge>
                  </span>
                </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded-xl2 border border-line bg-white sm:block">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead className="border-b border-line bg-mist/50 text-[11px] uppercase tracking-wide text-stone">
                <tr>
                  <th className="w-8 pl-3" /><th className="px-3 py-2">Product</th><th className="px-2 py-2">SKU</th>
                  {salonCol && <th className="px-2 py-2 text-right">Salon</th>}{onlineCol && <th className="px-2 py-2 text-right">Online</th>}
                  <th className="px-2 py-2 text-right" title="Order when it's down to this">Reorder at</th><th className="px-2 py-2">Supplier</th><th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.slice(0, shown).map((p) => {
                  const f = fc(p);
                  const at = f && f.ratePerDay > 0 ? Math.ceil(f.ratePerDay * (f.leadTimeDays + f.safetyDays)) : null;
                  return (
                    <tr key={p.key} className="cursor-pointer hover:bg-mist/40" onClick={() => setOpen(p.key)}>
                      <td className="pl-3" onClick={(e) => e.stopPropagation()}><input type="checkbox" className="h-4 w-4 accent-plum" checked={picked.has(p.key)} onChange={() => togglePick(p.key)} aria-label={`Select ${p.label}`} /></td>
                      <td className="px-3 py-2 text-ink">{p.label}{p.collection && <span className="ml-2 text-[11px] text-stone">{p.collection}</span>}</td>
                      <td className="px-2 py-2 font-mono text-[12px] text-stone">{p.sku ?? '—'}</td>
                      {salonCol && <td className="num px-2 py-2 text-right">{p.squareQty ?? '—'}</td>}
                      {onlineCol && <td className="num px-2 py-2 text-right">{p.shopifyQty ?? '—'}</td>}
                      <td className="num px-2 py-2 text-right text-ink-soft">{at ?? '—'}</td>
                      <td className="px-2 py-2 text-ink-soft">{p.supplier ?? '—'}</td>
                      <td className="px-3 py-2"><Badge tone={SIMPLE[statusOf.get(p.key)!].tone}>{SIMPLE[statusOf.get(p.key)!].label}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > shown && <div className="mt-3 text-center"><Button onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}</Button></div>}
        </>
      )}
      {opened && <ProductPanel p={opened} f={fc(opened)} status={statusOf.get(opened.key)!} orders={(pos.data ?? []).filter((o) => o.lines.some((l) => l.productKey === opened.key))}
        onClose={() => setOpen(null)} onOpenTab={onOpenTab} />}
    </div>
  );
}

/** A product in full: stock in each store, reorder details, supplier, purchase orders it's on, and its stock activity. */
function ProductPanel({ p, f, status, orders, onClose, onOpenTab }: {
  p: StockProductDTO; f: StockForecastDTO | undefined; status: Simple; orders: PurchaseOrderDTO[]; onClose: () => void; onOpenTab: (view: string, params?: Record<string, string>) => void;
}) {
  const N = useStoreNames();
  const history = useQuery({ queryKey: ['stock-history', 'product', p.key], queryFn: () => api.get<{ entries: StockTxnDTO[] }>(`/inventory-sync/stock/history?key=${encodeURIComponent(p.key)}`).then((r) => r.entries) });
  const sales = useQuery({ queryKey: ['product-sales', p.key], queryFn: () => api.get<Sales>(`/inventory-sync/stock/products/${encodeURIComponent(p.key)}/sales`) });
  const [monthsOpen, setMonthsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  // Prices from each store (the same list as Inventory → Pricing).
  const prices = useQuery({ queryKey: ['stock-prices'], queryFn: () => api.get<{ rows: PriceRow[]; stores: { square: string; shopify: string; shopify2: string | null } }>('/inventory-sync/stock/prices'), staleTime: 60_000 });
  const pr = prices.data?.rows.find((r) => r.key === p.key) ?? null;
  const stockoutOn = f && f.daysOfStock != null && f.ratePerDay > 0 ? (() => { const d = new Date(); d.setDate(d.getDate() + f.daysOfStock); return dateShort(d.toISOString()); })() : null;
  const [why, setWhy] = useState(false);
  const row = (label: string, value: React.ReactNode) => <div className="flex justify-between gap-3 py-1"><dt className="text-stone">{label}</dt><dd className="text-right text-ink">{value}</dd></div>;
  const h = 'mb-1 text-[12px] font-semibold uppercase tracking-wide text-stone';
  return (
    <Modal open side onClose={onClose} title={p.label}>
      <div className="space-y-5 text-[14px]">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={SIMPLE[status].tone}>{SIMPLE[status].label}</Badge>
          <span className="font-mono text-[12px] text-stone">{p.sku ?? 'No SKU'}</span>
          {p.collections.length > 0 && <span className="text-[12px] text-stone">· {p.collections.slice(0, 3).join(', ')}</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={() => onOpenTab('stock', p.sku ? { q: p.sku } : {})}>Count or adjust stock</Button>
          <Button size="sm" onClick={() => setEditing(true)}>Edit settings</Button>
          <Button size="sm" variant="ghost" onClick={() => onOpenTab('reorder')}>Open in To order</Button>
        </div>
        {/* Performance first: what sold, how fast, when it runs out and what to order. */}
        <section>
          <h3 className={h}>Performance</h3>
          {sales.isLoading ? <PageLoading /> : !sales.data ? <p className="text-[13px] text-stone">Sales couldn’t be loaded.</p> : !sales.data.hasSales ? (
            <p className="text-[13px] text-stone">No sales recorded in the last 12 months — usage can’t be estimated yet (this isn’t the same as zero demand).</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {([['7 days', 'd7'], ['30 days', 'd30'], ['90 days', 'd90'], ['12 months', 'd365']] as const).map(([l, k]) => (
                  <div key={k} className="rounded-lg border border-line px-2.5 py-1.5">
                    <p className="text-[11px] text-stone">Sold · {l}</p>
                    <p className="num text-[18px] font-medium text-ink">{sales.data!.periods[k].units}</p>
                    <p className="num text-[11px] text-stone">{usd0(sales.data!.periods[k].revenueCents)}</p>
                  </div>
                ))}
              </div>
              <dl className="mt-2 divide-y divide-line">
                {row('Average', `${sales.data.avgPerDay30} a day (30 days) · ${sales.data.avgPerMonth} a month (12 full months)`)}
                {row('Last 30 days vs the 30 before', `${sales.data.periods.d30.units} vs ${sales.data.previous30.units}`)}
                {row('Last sale', sales.data.lastSaleOn ? labelOfKey(sales.data.lastSaleOn, { month: 'short', day: 'numeric', year: 'numeric' }) : '—')}
                {f && row('Runs out', stockoutOn ? `about ${stockoutOn}` : f.stock <= 0 ? 'Out of stock now' : '—')}
                {f && row('Suggested order', f.suggestedQty ? `${f.suggestedQty}${f.orderBy ? ` · order by ${labelOfKey(f.orderBy, { month: 'short', day: 'numeric' })}` : ''}` : 'Nothing to order now')}
              </dl>
              {sales.data.byChannel.length > 1 && (
                <ul className="mt-2 space-y-0.5 text-[13px]">{sales.data.byChannel.map((c) => <li key={c.channel} className="flex justify-between"><span className="text-stone">{c.name} · 12 months</span><span className="num text-ink">{c.units} sold · {usd0(c.revenueCents)}</span></li>)}</ul>
              )}
              <button type="button" className="mt-2 text-[13px] text-plum hover:underline" onClick={() => setMonthsOpen(!monthsOpen)}>{monthsOpen ? 'Hide sales by month' : 'Sales by month'}</button>
              {monthsOpen && (
                <table className="mt-1 w-full text-[13px]">
                  <thead className="text-[11px] uppercase tracking-wide text-stone"><tr><th className="py-1 text-left font-medium">Month</th><th className="py-1 text-right font-medium">Salon</th><th className="py-1 text-right font-medium">Online</th><th className="py-1 text-right font-medium">Total</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {[...sales.data.months].reverse().map((m) => (
                      <tr key={m.month}>
                        <td className="py-1">{labelOfKey(`${m.month}-01`, { month: 'short', year: 'numeric' })}{m.partial && <span className="text-stone"> · so far</span>}</td>
                        <td className="num py-1 text-right">{m.square}</td><td className="num py-1 text-right">{m.shopify + m.shopify2}</td><td className="num py-1 text-right font-medium">{m.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </section>
        <section>
          <h3 className={h}>Stock</h3>
          <dl className="divide-y divide-line">
            {p.squareVariationId && row(`Salon (${N.square})`, <span className="num">{p.squareQty ?? 'Not tracked'}</span>)}
            {p.shopifyInventoryItemId && row(`Online (${N.shopify})`, <span className="num">{p.shopifyQty ?? 'Not tracked'}</span>)}
            {p.store2.map((e) => row(`${N.shopify2 ?? 'Store 2'} · ${e.label.split(/\s+[–-]\s+/).pop()}`, <span className="num">{e.qty ?? '—'}</span>))}
            {f && f.incoming > 0 && row('On order', <span className="num">{f.incoming}</span>)}
          </dl>
          {p.squareVariationId && p.shopifyInventoryItemId && <p className="mt-1 text-[12px] text-stone">{p.kind === 'separate' ? 'Separate stock: the salon and online counts are kept apart.' : 'Shared stock: the sync keeps the stores the same.'}</p>}
        </section>
        {f && (
          <section>
            <h3 className={h}>Reorder</h3>
            <dl className="divide-y divide-line">
              {row('Selling', f.ratePerDay > 0 ? `${f.ratePerDay.toFixed(2)} a day` : 'No recent sales')}
              {row('Days of stock left', f.daysOfStock ?? '—')}
              {row('Order by', f.orderBy ? labelOfKey(f.orderBy, { month: 'short', day: 'numeric' }) : '—')}
              {row('Suggested order', f.suggestedQty || '—')}
              {row('Lead time', f.leadUntracked ? 'Not tracked' : f.leadSource?.kind === 'missing'
                ? <span className="text-amber">Needs a lead time · using the {f.productionDays}-day default</span>
                : <span>{f.productionDays} production{f.shippingDays ? ` + ${f.shippingDays} shipping` : ''}<span className="block text-[11px] text-stone">{f.leadSource?.kind === 'product' ? 'This product’s own' : f.leadSource?.kind === 'collection' ? `${f.leadSource.label} rule` : `${f.leadSource?.label ?? 'Supplier'} default`}</span></span>)}
              {row('Minimum order', f.moq ?? '—')}
              {p.caseSize != null && row('Case size', p.caseSize)}
            </dl>
            <button type="button" className="mt-1 text-[13px] text-plum hover:underline" onClick={() => setWhy(!why)}>{why ? 'Hide how this is worked out' : 'How this is worked out'}</button>
            {why && <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-ink-soft">{f.why.map((w) => <li key={w}>{w}</li>)}</ul>}
          </section>
        )}
        <section>
          <h3 className={h}>Pricing</h3>
          {prices.isLoading ? <PageLoading /> : !pr ? <p className="text-[13px] text-stone">Prices couldn’t be read from the stores.</p> : (() => {
            const cost = pr.costCents;
            const retail = pr.shopify2.find((l) => !l.pro) ?? null;
            const proListing = pr.shopify2.find((l) => l.pro) ?? null;
            const price = (label: string, c: number | null | undefined, where: string, listed: boolean) => row(label, !listed ? <span className="text-stone">Not sold there</span>
              : c == null ? <span className="text-amber">Price missing</span>
                : <span><span className="num">{money(c)}</span>{marginOf(c, cost) != null && <span className="ml-1.5 text-[12px] text-stone">{marginOf(c, cost)}% margin</span>}<span className="block text-[11px] text-stone">{where}</span></span>);
            return (
              <dl className="divide-y divide-line">
                {row('Our cost', cost != null ? <span><span className="num">{money(cost)}</span><span className="block text-[11px] text-stone">{pr.costFrom === 'shopify' ? 'From Shopify’s cost per item' : 'Set in the CRM'} · never shown to customers</span></span> : <span className="text-stone">Not set</span>)}
                {price('AH-PRO stylist price', pr.shopify[0]?.priceCents, `${prices.data!.stores.shopify}`, pr.shopify.length > 0)}
                {price('Retail (DTC) price', retail?.priceCents, `${prices.data!.stores.shopify2 ?? 'Retail store'}`, !!retail)}
                {proListing && price('Retail store’s Pro listing', proListing.priceCents, `${prices.data!.stores.shopify2}`, true)}
                {price('Salon price', pr.square?.priceCents, prices.data!.stores.square, !!pr.square)}
              </dl>
            );
          })()}
          <p className="mt-1 text-[12px] text-stone">Prices live in each store; change them under Pricing. A missing price is shown as missing, never as $0.</p>
        </section>
        <section>
          <h3 className={h}>Supplier &amp; ordering</h3>
          <dl className="divide-y divide-line">
            {row('Supplier', p.supplier ?? 'Not set')}
            {p.supplierSku && row('Supplier SKU', <span className="font-mono text-[12px]">{p.supplierSku}</span>)}
            {row('Purchasing collection', p.collection ?? <span className="text-stone">From the store collections</span>)}
            {row('Production lead time', p.leadTimeDays != null ? `${p.leadTimeDays} days` : <span className="text-stone">Supplier default</span>)}
            {row('Transit time', p.shippingDays != null ? `${p.shippingDays} days` : <span className="text-stone">Supplier default</span>)}
            {row('Minimum order / case', `${p.moq ?? '—'} / ${p.caseSize ?? '—'}`)}
            {p.orderNote && row('Ordering note', p.orderNote)}
          </dl>
        </section>
        <section>
          <h3 className={h}>Purchase orders</h3>
          {!orders.length ? <p className="text-[13px] text-stone">Not on any purchase order.</p> : (
            <ul className="divide-y divide-line">
              {orders.slice(0, 8).map((o) => {
                const l = o.lines.find((x) => x.productKey === p.key)!;
                return (
                  <li key={o.id} className="flex items-center justify-between gap-2 py-1.5 text-[13px]">
                    <button type="button" className="min-w-0 truncate text-left text-plum hover:underline" onClick={() => onOpenTab('orders', { for: o.store === 'shopify' ? 'hair' : 'salon' })}>{o.name ?? `PO #${o.number}`}</button>
                    <span className="shrink-0 text-stone">{o.status} · {l.received ? `${l.received}/` : ''}{l.quantity}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section>
          <h3 className={h}>Activity</h3>
          {history.isLoading ? <PageLoading /> : !history.data?.length ? <p className="text-[13px] text-stone">No stock changes yet.</p> : (
            <ul className="divide-y divide-line text-[13px]">
              {history.data.slice(0, 10).map((t) => (
                <li key={t.id} className="py-1.5">
                  <span className="text-ink">{t.reason ?? t.kind}</span>
                  <span className="text-stone"> · {dateShort(t.createdAt)}{t.staffName ? ` · ${t.staffName}` : ''}</span>
                  {(t.squareAfter != null || t.shopifyAfter != null) && <span className="block text-[12px] text-ink-soft">{t.squareAfter != null ? `Salon ${t.squareBefore ?? '—'} → ${t.squareAfter}` : ''}{t.squareAfter != null && t.shopifyAfter != null ? ' · ' : ''}{t.shopifyAfter != null ? `Online ${t.shopifyBefore ?? '—'} → ${t.shopifyAfter}` : ''}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {editing && <EditSettings p={p} onClose={() => setEditing(false)} />}
    </Modal>
  );
}

/**
 * A product's purchasing settings, kept in the CRM (the stores' own data — name, SKU, prices, stock — isn't changed here).
 * Blank lead and transit times use the supplier's defaults, so a change to the supplier carries through.
 */
function EditSettings({ p, onClose }: { p: StockProductDTO; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: suppliers } = useQuery({ queryKey: ['stock-suppliers'], queryFn: () => api.get<{ suppliers: SupplierDTO[] }>('/inventory-sync/stock/suppliers').then((r) => r.suppliers), staleTime: 30_000 });
  const str = (v: number | string | null | undefined) => (v == null ? '' : String(v));
  const [d, setD] = useState({
    collection: str(p.collection), supplier: str(p.supplier), supplierSku: str(p.supplierSku), cost: p.costCents != null ? (p.costCents / 100).toFixed(2) : '',
    lead: str(p.leadTimeDays), ship: str(p.shippingDays), moq: str(p.moq), caseSize: str(p.caseSize), safety: str(p.safetyDays), note: str(p.orderNote), status: p.status,
  });
  const [busy, setBusy] = useState(false);
  const sup = suppliers?.find((x) => x.name === (d.supplier || suppliers.find((y) => y.isDefault)?.name));
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const bad = ['cost', 'lead', 'ship', 'moq', 'caseSize', 'safety'].filter((k) => { const n = num(d[k as keyof typeof d] as string); return n != null && !(n >= 0); });
  const f = (k: keyof typeof d) => ({ value: d[k] as string, onChange: (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value }) });
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/inventory-sync/stock/products/settings', { rows: [{
        key: p.key, collection: d.collection.trim() || null, supplier: d.supplier.trim() || null, supplierSku: d.supplierSku.trim() || null,
        costCents: num(d.cost) == null ? null : Math.round(num(d.cost)! * 100), leadTimeDays: num(d.lead) == null ? null : Math.round(num(d.lead)!), shippingDays: num(d.ship) == null ? null : Math.round(num(d.ship)!),
        moq: num(d.moq) == null ? null : Math.round(num(d.moq)!), caseSize: num(d.caseSize) ? Math.round(num(d.caseSize)!) : null, safetyDays: num(d.safety) == null ? null : Math.round(num(d.safety)!),
        orderNote: d.note.trim() || null, status: d.status,
      }] });
      for (const k of ['stock-products', 'stock-forecast', 'stock-prices', 'stock-suppliers']) void qc.invalidateQueries({ queryKey: [k] });
      toast('Saved');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const g = 'mb-1 mt-3 text-[12px] font-semibold uppercase tracking-wide text-stone first:mt-0';
  return (
    <Modal open onClose={onClose} title={`Settings · ${p.label}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={bad.length > 0} onClick={save}>Save</Button></>}>
      <div className="text-[14px]">
        <p className={g}>Collection &amp; supplier</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Purchasing collection" hint="Groups it in To order and suggested orders. Blank = the store collections."><input className="field" {...f('collection')} /></Field>
          <Field label="Supplier"><input className="field" list="edit-supplier-names" {...f('supplier')} placeholder={suppliers?.find((y) => y.isDefault)?.name ?? ''} /><datalist id="edit-supplier-names">{(suppliers ?? []).map((x) => <option key={x.name} value={x.name} />)}</datalist></Field>
          <Field label="Supplier SKU"><input className="field font-mono" {...f('supplierSku')} /></Field>
          <Field label="Our cost ($)" hint="What we pay. Never shown to customers."><input className="field num" inputMode="decimal" {...f('cost')} /></Field>
        </div>
        <p className={g}>Lead times</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Production (days)" hint={sup?.leadTimeDays != null ? `Blank = ${sup.name}’s ${sup.leadTimeDays}` : 'Blank = the default'}><input className="field num" inputMode="numeric" placeholder={str(sup?.leadTimeDays)} {...f('lead')} /></Field>
          <Field label="Transit (days)" hint={sup?.shippingDays != null ? `Blank = ${sup.name}’s ${sup.shippingDays}` : 'Blank = none'}><input className="field num" inputMode="numeric" placeholder={str(sup?.shippingDays)} {...f('ship')} /></Field>
          <Field label="Total lead time"><p className="py-2 text-ink">{(num(d.lead) ?? sup?.leadTimeDays) == null ? <span className="text-stone">The forecast default (Forecast settings){(num(d.ship) ?? sup?.shippingDays) ? ` + ${num(d.ship) ?? sup?.shippingDays} transit` : ''}</span> : `${(num(d.lead) ?? sup!.leadTimeDays!) + (num(d.ship) ?? sup?.shippingDays ?? 0)} days`}</p></Field>
        </div>
        <p className={g}>Ordering</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Minimum order" hint={sup?.defaultMoq != null ? `Blank = ${sup.defaultMoq}` : undefined}><input className="field num" inputMode="numeric" placeholder={str(sup?.defaultMoq)} {...f('moq')} /></Field>
          <Field label="Case size"><input className="field num" inputMode="numeric" {...f('caseSize')} /></Field>
          <Field label="Safety stock (days)"><input className="field num" inputMode="numeric" {...f('safety')} /></Field>
        </div>
        <Field label="Ordering note" className="mt-3"><input className="field" maxLength={500} {...f('note')} /></Field>
        <Field label="Status" className="mt-3">
          <select className="field w-auto" value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as StockProductStatus })}>
            <option value="active">Active</option><option value="discontinued">Discontinued</option><option value="not_tracked">Not tracked</option>
          </select>
        </Field>
        {bad.length > 0 && <p className="mt-2 text-[13px] text-rose">Numbers can’t be negative.</p>}
      </div>
    </Modal>
  );
}
