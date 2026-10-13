import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ShopifyPushResult, SquareInventoryDTO, SquareInventorySyncStatus } from '@addendum/shared';
import { AlertCircle, CheckCircle2, Package, RefreshCw, Search, UploadCloud } from 'lucide-react';
import { api, qs } from '../api/client';
import { relative } from '../lib/format';
import { Button, EmptyState, ErrorNote, Modal, PageLoading, cx, useToast } from '../components/ui';
import { ShopifySyncSwitch } from '../components/domain/ShopifySyncSwitch';

interface ProductsResponse { products: SquareInventoryDTO[]; total: number; sync: SquareInventorySyncStatus; canPushToShopify: boolean; canChangeShopifySync: boolean }

/**
 * Square inventory, searchable by product name, size/colour, SKU or UPC. Square is the source of truth.
 * Administrators also get checkboxes and "Push to Shopify", which sets Shopify's stock to these counts.
 */
export function SquareInventoryView() {
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [inStock, setInStock] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [result, setResult] = useState<ShopifyPushResult | null>(null);

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 200);
    return () => window.clearTimeout(t);
  }, [text]);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['square-inventory', q, inStock],
    queryFn: () => api.get<ProductsResponse>(`/inventory/products${qs({ q: q || undefined, inStock: inStock || undefined, limit: 200 })}`),
    placeholderData: keepPreviousData,
  });
  const admin = !!data?.canPushToShopify;
  const rows = data?.products ?? [];
  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.variationId));

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.post<{ sync: SquareInventorySyncStatus }>('/inventory/products/refresh');
      if (r.sync.status === 'failed') toast(r.sync.message ?? 'Square inventory could not be refreshed.', 'error');
      else toast(r.sync.status === 'partial' ? r.sync.message ?? 'Refreshed without stock counts' : `Refreshed · ${r.sync.products} products from Square`, r.sync.status === 'partial' ? 'error' : 'success');
      await qc.invalidateQueries({ queryKey: ['square-inventory'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const push = async () => {
    setPushing(true);
    try {
      const r = await api.post<{ result: ShopifyPushResult }>('/inventory/products/shopify-push', { variationIds: [...selected] });
      setConfirming(false);
      setResult(r.result);
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ['square-inventory'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setPushing(false);
    }
  };

  const sync = data?.sync;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
          <input
            className="field h-10 pl-9" type="search" value={text} onChange={(e) => setText(e.target.value)} autoFocus
            placeholder="Search by name, size, colour, SKU or barcode" aria-label="Search Square inventory"
          />
        </label>
        <label className="inline-flex items-center gap-2 text-sm text-ink-soft">
          <input type="checkbox" className="h-4 w-4 accent-plum" checked={inStock} onChange={(e) => setInStock(e.target.checked)} />In stock only
        </label>
        <Button size="sm" icon={<RefreshCw className={cx('h-4 w-4', refreshing && 'animate-spin')} />} onClick={refresh} disabled={refreshing}>Refresh from Square</Button>
      </div>
      {sync && (
        <p className={cx('mb-3 text-[13px]', sync.status === 'failed' || sync.status === 'partial' ? 'text-amber' : 'text-stone')}>
          {sync.status === 'never' ? 'Not loaded from Square yet.' : `From Square${sync.lastSyncAt ? ` · updated ${relative(sync.lastSyncAt)}` : ''} · ${sync.products} products`}
          {sync.message ? ` · ${sync.message}` : ''}
        </p>
      )}

      {admin && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white px-3 py-2 text-sm">
          <span className="text-ink-soft">{selected.size ? `${selected.size} selected` : 'Admin: select products to push their Square stock to Shopify'}</span>
          {selected.size > 0 && <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>}
          <Button size="sm" variant="primary" className="ml-auto" icon={<UploadCloud className="h-4 w-4" />} disabled={!selected.size} onClick={() => setConfirming(true)}>Push to Shopify</Button>
        </div>
      )}

      {isLoading && <PageLoading />}
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {data && rows.length === 0 && (
        <div className="panel"><EmptyState icon={<Package className="h-9 w-9" />} title={q ? 'No matches' : 'No products yet'}>{q ? 'Try part of the name, a size or colour, or the SKU.' : 'Retail products from Square appear here.'}</EmptyState></div>
      )}
      {rows.length > 0 && (
        <div className={cx('panel overflow-x-auto', isFetching && 'opacity-70')}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-stone">
                {admin && <th className="w-10 px-3 py-2"><input type="checkbox" className="h-4 w-4 accent-plum" aria-label="Select all shown" checked={allShownSelected} onChange={() => setSelected((s) => { const n = new Set(s); for (const r of rows) { if (allShownSelected) n.delete(r.variationId); else n.add(r.variationId); } return n; })} /></th>}
                <th className="px-3 py-2 font-medium">Product</th>
                <th className="px-3 py-2 font-medium">SKU</th>
                <th className="px-3 py-2 text-right font-medium">In stock</th>
                <th className="px-3 py-2 font-medium">Sync to Shopify</th>
                {admin && <th className="px-3 py-2 font-medium">Last push</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.variationId} className="border-b border-line/60 last:border-0 align-top">
                  {admin && <td className="px-3 py-2.5"><input type="checkbox" className="h-4 w-4 accent-plum" checked={selected.has(p.variationId)} onChange={() => toggle(p.variationId)} aria-label={`Select ${p.itemName}`} /></td>}
                  <td className="px-3 py-2.5"><span className="font-medium text-ink">{p.itemName}</span>{p.variationName && <span className="block text-[13px] text-ink-soft">{p.variationName}</span>}{p.upc && <span className="block text-xs text-stone">UPC {p.upc}</span>}</td>
                  <td className="px-3 py-2.5 font-mono text-[13px] text-ink-soft">{p.sku ?? '—'}</td>
                  <td className="num px-3 py-2.5 text-right">
                    {p.quantity == null ? <span className="text-stone">Not tracked</span> : <span className={cx('font-medium', p.quantity <= 0 ? 'text-rose' : p.quantity < 3 ? 'text-amber' : 'text-ink')}>{p.quantity}</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    <ShopifySyncSwitch key={`${p.variationId}-${p.shopifySync.enabled}`} variationId={p.variationId} label={[p.itemName, p.variationName].filter(Boolean).join(' · ')} enabled={p.shopifySync.enabled} canChange={!!data?.canChangeShopifySync} />
                    <span className={cx('block text-[11px]', p.shopifySync.linked ? 'text-stone' : 'text-amber')}>
                      {!p.shopifySync.linked ? 'Not linked to Shopify' : p.shopifySync.linkStatus === 'needs_attention' || p.shopifySync.linkStatus === 'error' ? 'Linked · needs attention' : 'Linked'}
                    </span>
                  </td>
                  {admin && (
                    <td className="px-3 py-2.5 text-xs">
                      {p.shopify.error ? <span className="text-rose">{p.shopify.error}</span>
                        : p.shopify.pushedAt ? <span className="text-stone">Set to {p.shopify.pushedQuantity} {relative(p.shopify.pushedAt)}</span> : <span className="text-stone">—</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.total > rows.length && <p className="px-3 py-2 text-[13px] text-stone">Showing {rows.length} of {data.total}. Search to narrow it down.</p>}
        </div>
      )}

      {confirming && (
        <Modal
          open onClose={() => setConfirming(false)} title="Push stock to Shopify"
          footer={<><Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button><Button variant="primary" icon={<UploadCloud className="h-4 w-4" />} loading={pushing} onClick={push}>Push {selected.size} to Shopify</Button></>}
        >
          <p className="text-sm text-ink-soft">Shopify's available stock for {selected.size} product{selected.size === 1 ? '' : 's'} will be <b>set to Square's count</b>, matched by SKU. Products with Sync to Shopify off, without a SKU, or with no matching Shopify product are skipped and listed afterwards.</p>
        </Modal>
      )}
      {result && <PushResult result={result} onClose={() => setResult(null)} />}
    </div>
  );
}

function PushResult({ result, onClose }: { result: ShopifyPushResult; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Shopify push finished" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="space-y-4 text-sm">
        <p className="flex items-center gap-2 text-sage"><CheckCircle2 className="h-4 w-4" />{result.pushed.length} updated in Shopify</p>
        {result.pushed.length > 0 && <ul className="space-y-0.5 pl-6 text-ink-soft">{result.pushed.map((p) => <li key={p.variationId}>{p.label} → {p.quantity}</li>)}</ul>}
        {result.failed.length > 0 && (
          <div><p className="flex items-center gap-2 text-rose"><AlertCircle className="h-4 w-4" />{result.failed.length} failed — try again</p>
            <ul className="mt-1 space-y-0.5 pl-6 text-ink-soft">{result.failed.map((p) => <li key={p.variationId}>{p.label}: {p.error}</li>)}</ul></div>
        )}
        {result.skipped.length > 0 && (
          <div><p className="text-amber">{result.skipped.length} skipped</p>
            <ul className="mt-1 space-y-0.5 pl-6 text-ink-soft">{result.skipped.map((p) => <li key={p.variationId}>{p.label}: {p.reason}</li>)}</ul></div>
        )}
      </div>
    </Modal>
  );
}
