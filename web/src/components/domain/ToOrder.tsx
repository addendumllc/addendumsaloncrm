import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PackageCheck } from 'lucide-react';
import type { StockForecastDTO, StockForecastResponse } from '@addendum/shared';
import { api } from '../../api/client';
import { dateShort, dayKey } from '../../lib/format';
import { Badge, EmptyState, ErrorNote, PageLoading, Segmented, cx } from '../ui';
import { CustomersWaiting, usePreorders } from './Preorders';

const NEEDS: StockForecastDTO['status'][] = ['out', 'order_now', 'soon'];

/**
 * Inventory → To order: what one store needs ordered, out of stock first, then by the day it sells out. "Coming up"
 * adds the ones to watch (about three weeks out). Purchase orders are made from Inventory → Reorder.
 */
export function ToOrderView({ store }: { store: 'salon' | 'online' }) {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['stock-forecast'], queryFn: () => api.get<StockForecastResponse>('/inventory-sync/stock/forecast') });
  // Customers who paid and are waiting for stock come first (pre-orders are online sales, below zero in Shopify).
  const { data: pre } = usePreorders();
  const waitingItems = (pre?.items ?? []).filter((p) => store === 'online' || data?.items.find((i) => i.key === p.key)?.stores?.salon);
  const waitingKeys = new Set(waitingItems.map((p) => p.key));
  const [range, setRange] = useState<'now' | 'soon'>('now');
  const today = dayKey(new Date());
  const items = useMemo(() => (data?.items ?? [])
    .filter((i) => i.stores?.[store] && !waitingKeys.has(i.key) && (NEEDS.includes(i.status) || (range === 'soon' && i.status === 'watch')))
    .sort((a, b) => (b.preorders ?? 0) - (a.preorders ?? 0) || Number(b.status === 'out') - Number(a.status === 'out') || (a.sellOutOn ?? '9').localeCompare(b.sellOutOn ?? '9') || a.label.localeCompare(b.label)),
  [data, store, range, pre]); // eslint-disable-line react-hooks/exhaustive-deps
  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;
  const out = items.filter((i) => i.status === 'out').length;
  const waiting = items.reduce((n, i) => n + (i.preorders ?? 0), 0);
  return (
    <div>
      <CustomersWaiting items={waitingItems} />
      {waitingItems.length > 0 && <h2 className="h-display mb-2 text-xl">Running low</h2>}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented value={range} onChange={setRange} options={[{ value: 'now', label: 'Order now' }, { value: 'soon', label: 'Include coming up' }]} />
        <span className="text-[13px] text-stone">{items.length} product{items.length === 1 ? '' : 's'}{out ? ` · ${out} out of stock` : ''}{waiting ? ` · ${waiting} pre-order${waiting === 1 ? '' : 's'} waiting` : ''} · by when they sell out</span>
        <Link to="/inventory-sync?view=reorder" className="ml-auto text-sm text-plum hover:underline">Make a purchase order</Link>
      </div>
      {!items.length ? (
        <div className="panel"><EmptyState icon={<PackageCheck className="h-8 w-8" />} title="Nothing to order">Nothing is out of stock or due to sell out before more could arrive.</EmptyState></div>
      ) : (
        <ul className="panel divide-y divide-line">
          {items.map((i) => {
            const isOut = i.status === 'out';
            const days = i.sellOutOn ? Math.round((Date.parse(`${i.sellOutOn}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400_000) : null;
            return (
              <li key={i.key} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{i.label}</span>
                    {i.preorders > 0 && <Badge tone="amber">{i.preorders} pre-order{i.preorders === 1 ? '' : 's'}</Badge>}
                    {isOut ? <Badge tone="rose">Out of stock</Badge> : i.status === 'order_now' ? <Badge tone="amber">Order now</Badge> : i.status === 'soon' ? <Badge tone="amber">Order this week</Badge> : <Badge>Coming up</Badge>}
                  </div>
                  <p className="text-[13px] text-stone">{[i.sku && `SKU ${i.sku}`, i.supplier].filter(Boolean).join(' · ') || '—'}</p>
                </div>
                <div className="grid grid-cols-4 gap-3 text-[13px] sm:w-[30rem]">
                  <Cell label="Sells out" value={isOut ? 'Now' : i.sellOutOn ? `${dateShort(i.sellOutOn)}${days != null ? ` (${days}d)` : ''}` : '—'} warn={isOut || (days != null && days <= 7)} />
                  <Cell label="In stock" value={String(i.stock)} />
                  <Cell label="On order" value={i.incoming ? String(i.incoming) : '—'} />
                  <Cell label="Suggested" value={i.suggestedQty ? String(i.suggestedQty) : '—'} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Cell({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <span className="block text-[11px] uppercase tracking-wide text-stone">{label}</span>
      <span className={cx('num block', warn ? 'font-medium text-rose' : 'text-ink')}>{value}</span>
    </div>
  );
}
