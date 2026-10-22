import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../api/client';
import { dateShort } from '../../lib/format';
import { Badge } from '../ui';

export interface PreorderItem {
  key: string; label: string; sku: string | null; waiting: number; stores: { store: string; waiting: number }[];
  onOrder: number; due: string | null; purchaseOrders: string | null; toOrder: number; status: 'needs_order' | 'backordered';
  orders: { orderId: string; quantity: number; orderedAt: string; store: string; orderName?: string | null; customer?: string | null }[];
}
export interface PreorderReport { items: PreorderItem[]; waiting: number; toOrder: number }

export const usePreorders = (enabled = true) =>
  useQuery({ queryKey: ['stock-preorders'], enabled, refetchInterval: 120_000, queryFn: () => api.get<PreorderReport>('/inventory-sync/stock/preorders') });

/** Inventory banner: customers waiting on pre-orders, and how many still need ordering. Nothing when there are none. */
export function PreorderBanner() {
  const { data } = usePreorders();
  if (!data?.items.length) return null;
  return (
    <Link to="/inventory-sync?view=toorder&for=hair" className="mb-4 flex flex-wrap items-center gap-2 border border-amber/40 bg-amber-tint px-4 py-2.5 text-[14px] text-ink hover:border-amber">
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber" />
      <span><b className="font-medium">{data.waiting} pre-order{data.waiting === 1 ? '' : 's'}</b> waiting across {data.items.length} product{data.items.length === 1 ? '' : 's'}
        {data.toOrder ? <> · <b className="font-medium">{data.toOrder} still to order</b></> : ' · all on order'}</span>
      <span className="ml-auto text-[13px] text-plum">See who is waiting →</span>
    </Link>
  );
}

/**
 * Inventory → To order → Customers waiting: products customers paid for before they were in stock (below zero online),
 * needs-ordering first, each with who is waiting (order number and name), what's on order and when it's due.
 */
export function CustomersWaiting({ items }: { items: PreorderItem[] }) {
  if (!items.length) return null;
  const waiting = items.reduce((n, i) => n + i.waiting, 0);
  const toOrder = items.reduce((n, i) => n + i.toOrder, 0);
  return (
    <section className="mb-6">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
        <h2 className="h-display text-xl">Customers waiting</h2>
        <span className="text-[13px] text-stone">{waiting} paid unit{waiting === 1 ? '' : 's'} waiting for stock · {toOrder} still to order · order these first</span>
      </div>
      <ul className="space-y-3">
        {items.map((i) => (
          <li key={i.key} className="panel p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{i.label}</span>
              {i.sku && <span className="font-mono text-[12px] text-stone">{i.sku}</span>}
              {i.status === 'needs_order' ? <Badge tone="rose">Needs ordering</Badge> : <Badge tone="amber">On order</Badge>}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
              <div><span className="block text-[11px] uppercase tracking-wide text-stone">Customers waiting</span><b className="num text-[16px] text-ink">{i.waiting}</b>
</div>
              <div><span className="block text-[11px] uppercase tracking-wide text-stone">On order</span><b className="num text-[16px] text-ink">{i.onOrder || '—'}</b>
                {i.purchaseOrders && <span className="block text-[12px] text-stone">{i.purchaseOrders}</span>}</div>
              <div><span className="block text-[11px] uppercase tracking-wide text-stone">Due</span><b className="text-[14px] text-ink">{i.due ? dateShort(i.due) : '—'}</b></div>
              <div><span className="block text-[11px] uppercase tracking-wide text-stone">Still to order</span><b className={i.toOrder ? 'num text-[16px] text-rose' : 'num text-[16px] text-ink'}>{i.toOrder}</b></div>
            </div>
            {i.orders.length > 0 && (
              <div className="mt-3 border-t border-line pt-2">
                <p className="mb-1 text-[11px] uppercase tracking-wide text-stone">Who is waiting</p>
                <ul className="divide-y divide-line text-[13px]">
                  {i.orders.map((o) => (
                    <li key={`${o.store}-${o.orderId}`} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
                      <span className="font-medium text-ink">{o.customer ?? 'Customer'}</span>
                      <span className="text-ink-soft">Order {o.orderName ?? `…${o.orderId.slice(-6)}`}</span>
                      <span className="num text-ink-soft">×{o.quantity}</span>
                      <span className="text-stone">paid {dateShort(o.orderedAt)}</span>
                      {i.stores.length > 1 || o.store ? <span className="ml-auto text-[12px] text-stone">{o.store}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
