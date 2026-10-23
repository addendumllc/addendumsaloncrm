import { useQuery } from '@tanstack/react-query';
import type { StockForecastResponse } from '@addendum/shared';
import { api } from '../../api/client';
import { CustomersWaiting, usePreorders } from './Preorders';

/**
 * Ordering → To order, above the forecast: customers who paid and are waiting for stock (pre-orders are online sales,
 * below zero in Shopify). For the salon, only products the salon also sells.
 */
export function WaitingForStock({ store }: { store: 'all' | 'salon' | 'hair' }) {
  const { data } = useQuery({ queryKey: ['stock-forecast'], queryFn: () => api.get<StockForecastResponse>('/inventory-sync/stock/forecast') });
  const { data: pre } = usePreorders();
  const items = (pre?.items ?? []).filter((p) => store !== 'salon' || data?.items.find((i) => i.key === p.key)?.stores?.salon);
  return <CustomersWaiting items={items} />;
}
