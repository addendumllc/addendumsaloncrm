import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { PurchaseOrderDTO, StockForecastDTO, StockForecastResponse, StockProductDTO, StockTxnDTO } from '@addendum/shared';
import { api } from '../../api/client';
import { dateShort, labelOfKey } from '../../lib/format';
import { useStoreNames } from '../../lib/storeNames';
import { Badge, Button, EmptyState, ErrorNote, Modal, PageLoading, cx } from '../ui';

type Store = 'all' | 'salon' | 'hair';
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
  const collections = useMemo(() => [...new Set(all.flatMap((p) => p.collections))].sort((a, b) => a.localeCompare(b)), [all]);

  if (products.isLoading || forecast.isLoading) return <PageLoading />;
  if (products.error || !products.data) return <ErrorNote error={products.error} onRetry={products.refetch} />;

  const count = (s: Simple) => all.filter((p) => statusOf.get(p.key) === s).length;
  const openPos = (pos.data ?? []).filter((p) => !['received', 'cancelled'].includes(p.status) && (store === 'all' || p.store === (store === 'salon' ? 'salon' : 'shopify')));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const order: Simple[] = ['out', 'low', 'watch', 'ok', 'skipped', 'discontinued'];
  const stockOf = (p: StockProductDTO) => (store === 'salon' ? p.squareQty ?? 0 : store === 'hair' ? p.shopifyQty ?? 0 : Math.max(p.squareQty ?? 0, p.shopifyQty ?? 0));
  const rows = all
    .filter((p) => (!status || statusOf.get(p.key) === status) && (!coll || p.collections.includes(coll))
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
          <option value="">All collections</option>{collections.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select className="field h-11 w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
          <option value="name">Sort by name</option><option value="stock">Sort by stock (low first)</option><option value="status">Sort by status</option>
        </select>
      </div>
      <p className="mb-2 text-[12px] text-stone">{rows.length} product{rows.length === 1 ? '' : 's'}{salonCol && onlineCol ? ` · Salon = ${N.square}, Online = ${[N.shopify, N.shopify2].filter(Boolean).join(' + ')} (kept separate)` : ''}</p>

      {!rows.length ? <EmptyState title="No products match">Try another search or filter.</EmptyState> : (
        <>
          {/* Phones: one compact row per product. */}
          <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-white sm:hidden">
            {rows.slice(0, shown).map((p) => (
              <li key={p.key}>
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
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded-xl2 border border-line bg-white sm:block">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead className="border-b border-line bg-mist/50 text-[11px] uppercase tracking-wide text-stone">
                <tr>
                  <th className="px-3 py-2">Product</th><th className="px-2 py-2">SKU</th>
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
                      <td className="px-3 py-2 text-ink">{p.label}</td>
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
          <Button size="sm" onClick={() => onOpenTab('products')}>Edit product details</Button>
        </div>
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
              {row('Lead time', f.leadUntracked ? 'Not tracked' : `${f.leadTimeDays} days${f.shippingDays ? ` (incl. ${f.shippingDays} shipping)` : ''}`)}
              {row('Minimum order', f.moq ?? '—')}
              {p.caseSize != null && row('Case size', p.caseSize)}
            </dl>
            <button type="button" className="mt-1 text-[13px] text-plum hover:underline" onClick={() => setWhy(!why)}>{why ? 'Hide how this is worked out' : 'How this is worked out'}</button>
            {why && <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-ink-soft">{f.why.map((w) => <li key={w}>{w}</li>)}</ul>}
          </section>
        )}
        <section>
          <h3 className={h}>Supplier</h3>
          <dl className="divide-y divide-line">
            {row('Supplier', p.supplier ?? 'Not set')}
            {row('Unit cost', p.costCents != null ? `$${(p.costCents / 100).toFixed(2)}` : '—')}
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
    </Modal>
  );
}
