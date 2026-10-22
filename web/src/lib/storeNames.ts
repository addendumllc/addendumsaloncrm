import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/** What each store is called in the CRM (Settings → API & Integrations → Name in the CRM), e.g. Salon / AH-PRO / AH. */
export type StoreNames = { square: string; shopify: string; shopify2: string | null };
const DEFAULTS: StoreNames = { square: 'Square', shopify: 'Shopify', shopify2: null };

export function useStoreNames(): StoreNames {
  const { data } = useQuery({ queryKey: ['store-names'], queryFn: () => api.get<StoreNames>('/inventory/store-names'), staleTime: 5 * 60_000 });
  return data ?? DEFAULTS;
}
