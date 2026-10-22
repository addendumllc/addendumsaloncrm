import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { PRODUCT_KINDS, type ProductKind, type ShopifyPushResult, type SquareInventoryDTO, type SquareInventorySyncStatus } from '@addendum/shared';
import { AlertCircle, Check, CheckCircle2, Package, Pencil, RefreshCw, Search, UploadCloud, X } from 'lucide-react';
import { api, qs } from '../api/client';
import { relative } from '../lib/format';
import { useStoreNames } from '../lib/storeNames';
import { ProductThumb } from '../components/domain/ProductThumb';
import { Button, EmptyState, ErrorNote, Modal, PageLoading, cx, useToast } from '../components/ui';

interface ProductsResponse { products: SquareInventoryDTO[]; total: number; sync: SquareInventorySyncStatus; canPushToShopify: boolean; canChangeShopifySync: boolean }

/**
 * Square inventory, searchable by product name, size/colour, SKU or UPC. Square is the source of truth.
 * Administrators also get checkboxes and "Push to Shopify", which sets Shopify's stock to these counts.
 */
export function SquareInventoryView() {
  const toast = useToast();
  const N = useStoreNames();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [inStock, setInStock] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [result, setResult] = useState<ShopifyPushResult | null>(null);
  const [kind, setKind] = useState<string>('products');
  const [settingKind, setSettingKind] = useState(false);

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 200);
    return () => window.clearTimeout(t);
  }, [text]);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['square-inventory', q, inStock, kind],
    queryFn: () => api.get<ProductsResponse>(`/inventory/products${qs({ q: q || undefined, inStock: inStock || undefined, kind, limit: 200 })}`),
    placeholderData: keepPreviousData,
  });
  const admin = !!data?.canPushToShopify;
  const rows = data?.products ?? [];
  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.variationId));

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.post<{ sync: SquareInventorySyncStatus }>('/inventory/products/refresh');
      if (r.sync.status === 'failed') toast(r.sync.message ?? `${N.square} inventory could not be refreshed.`, 'error');
      else toast(r.sync.status === 'partial' ? r.sync.message ?? 'Refreshed without stock counts' : `Refreshed · ${r.sync.products} products from ${N.square}`, r.sync.status === 'partial' ? 'error' : 'success');
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

  const canType = !!data?.canChangeShopifySync;
  // Discontinued = stop tracking: skipped by the sync and hidden here (stored with the product's reorder details).
  const setDiscontinued = async (ids: string[], gone: boolean) => {
    setSettingKind(true);
    try {
      await api.put('/inventory-sync/stock/products/settings', { rows: ids.map((key) => ({ key, status: gone ? 'discontinued' : 'active' })) });
      toast(gone ? `${ids.length} product${ids.length === 1 ? '' : 's'} discontinued — no longer tracked or synced` : `${ids.length} product${ids.length === 1 ? '' : 's'} tracked again — the next sync picks ${ids.length === 1 ? 'it' : 'them'} up`);
      setSelected(new Set());
      for (const key of ['square-inventory', 'inventory-sync', 'inventory-sync-links', 'stock-products', 'stock-forecast']) qc.invalidateQueries({ queryKey: [key] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSettingKind(false);
    }
  };
  const saveKind = async (ids: string[], k: ProductKind) => {
    setSettingKind(true);
    try {
      await api.put('/inventory-sync/products/kind', { variationIds: ids, kind: k });
      toast(`${ids.length === 1 ? 'Saved' : `${ids.length} products set`}: ${PRODUCT_KINDS.find((x) => x.value === k)!.label}`);
      setSelected(new Set());
      for (const key of ['square-inventory', 'inventory-sync', 'inventory-sync-links', 'stock-products']) qc.invalidateQueries({ queryKey: [key] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSettingKind(false);
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
            placeholder="Search by name, size, colour, SKU or barcode" aria-label={`Search ${N.square} inventory`}
          />
        </label>
        <select className="field h-10 w-auto" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Show">
          <option value="products">All products</option>
          {PRODUCT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.value === 'service' ? 'Add-on services' : k.label}</option>)}
          <option value="unset">Type not set</option>
          <option value="discontinued">Discontinued</option>
          <option value="all">Everything (incl. services)</option>
        </select>
        <label className="inline-flex items-center gap-2 text-sm text-ink-soft">
          <input type="checkbox" className="h-4 w-4 accent-plum" checked={inStock} onChange={(e) => setInStock(e.target.checked)} />In stock only
        </label>
        <Button size="sm" icon={<RefreshCw className={cx('h-4 w-4', refreshing && 'animate-spin')} />} onClick={refresh} disabled={refreshing}>Refresh from {N.square}</Button>
      </div>
      {sync && (
        <p className={cx('mb-3 text-[13px]', sync.status === 'failed' || sync.status === 'partial' ? 'text-amber' : 'text-stone')}>
          {sync.status === 'never' ? `Not loaded from ${N.square} yet.` : `From ${N.square}${sync.lastSyncAt ? ` · updated ${relative(sync.lastSyncAt)}` : ''} · ${sync.products} products`}
          {sync.message ? ` · ${sync.message}` : ''}
        </p>
      )}

      {admin && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white px-3 py-2 text-sm">
          <span className="text-ink-soft">{selected.size ? `${selected.size} selected` : `Select products to set their type or push their stock to ${N.shopify}`}</span>
          {selected.size > 0 && <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>}
          {/* Phones have no table header, so select-all lives here. */}
          {rows.length > 0 && !allShownSelected && <Button size="sm" variant="ghost" className="sm:hidden" onClick={() => setSelected((cur) => new Set([...cur, ...rows.map((r) => r.variationId)]))}>Select all {rows.length}</Button>}
          {canType && (
            <select className="ml-auto rounded-lg border border-line-strong bg-white px-2 py-1.5 text-sm disabled:opacity-50" value="" disabled={!selected.size || settingKind} onChange={(e) => { const v = e.target.value; if (v === 'discontinued' || v === 'active') setDiscontinued([...selected], v === 'discontinued'); else if (v) saveKind([...selected], v as ProductKind); }} aria-label="Set type for selected">
              <option value="">Set type…</option>
              {PRODUCT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              <option disabled>──────────</option>
              <option value="discontinued">Discontinued — stop tracking</option>
              <option value="active">Active — track again</option>
            </select>
          )}
          <Button size="sm" variant="primary" className={canType ? '' : 'ml-auto'} icon={<UploadCloud className="h-4 w-4" />} disabled={!selected.size} onClick={() => setConfirming(true)}>Push to {N.shopify}</Button>
        </div>
      )}

      {isLoading && <PageLoading />}
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {data && rows.length === 0 && (
        <div className="panel"><EmptyState icon={<Package className="h-9 w-9" />} title={q ? 'No matches' : 'No products yet'}>{q ? 'Try part of the name, a size or colour, or the SKU.' : 'Retail products from Square appear here.'}</EmptyState></div>
      )}
      {/* Phones: one card per product (name, SKU, stock and type all visible, nothing cut off). */}
      {rows.length > 0 && (
        <ul className={cx('space-y-2 sm:hidden', isFetching && 'opacity-70')}>
          {rows.map((p) => (
            <li key={p.variationId} className={cx('rounded-xl2 border border-line bg-white p-3', p.discontinued && 'opacity-60')}>
              <div className="flex items-start gap-3">
                {admin && <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-plum" checked={selected.has(p.variationId)} onChange={() => toggle(p.variationId)} aria-label={`Select ${p.itemName}`} />}
                <ProductThumb src={p.imageUrl} alt={p.itemName} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-medium leading-snug text-ink">{p.itemName}</p>
                  {p.variationName && <p className="text-[13px] text-ink-soft">{p.variationName}</p>}
                  <div className="mt-1"><SkuCell p={p} canEdit={canType} /></div>
                </div>
                <div className="shrink-0 text-right">
                  {p.kind === 'service' ? <span className="text-stone">—</span> : p.quantity == null ? <span className="text-[13px] text-stone">Not tracked</span>
                    : <><span className={cx('num block text-[20px] font-medium leading-none', p.quantity <= 0 ? 'text-rose' : p.quantity < 3 ? 'text-amber' : 'text-ink')}>{p.quantity}</span><span className="text-[11px] text-stone">in stock</span></>}
                </div>
              </div>
              <div className="mt-2">{p.discontinued
                ? <span className="text-[12px] text-stone">Discontinued — not tracked or synced{canType && <> · <button type="button" className="text-plum underline" disabled={settingKind} onClick={() => setDiscontinued([p.variationId], false)}>Track again</button></>}</span>
                : <KindCell p={p} canChange={canType} busy={settingKind} onChange={(k) => saveKind([p.variationId], k)} />}</div>
              {admin && p.shopify.error && <p className="mt-1 text-[12px] text-rose">{p.shopify.error}</p>}
            </li>
          ))}
          {data && data.total > rows.length && <li className="px-1 text-[13px] text-stone">Showing {rows.length} of {data.total}. Search to narrow it down.</li>}
        </ul>
      )}
      {rows.length > 0 && (
        <div className={cx('panel hidden overflow-x-auto sm:block', isFetching && 'opacity-70')}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-stone">
                {admin && <th className="w-10 px-3 py-2"><input type="checkbox" className="h-4 w-4 accent-plum" aria-label="Select all shown" checked={allShownSelected} onChange={() => setSelected((s) => { const n = new Set(s); for (const r of rows) { if (allShownSelected) n.delete(r.variationId); else n.add(r.variationId); } return n; })} /></th>}
                <th className="px-3 py-2 font-medium">Product</th>
                <th className="px-3 py-2 font-medium">SKU</th>
                <th className="px-3 py-2 text-right font-medium">In stock</th>
                <th className="px-3 py-2 font-medium">Type</th>
                {admin && <th className="px-3 py-2 font-medium">Last push</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.variationId} className={cx('border-b border-line/60 last:border-0 align-top', p.discontinued && 'opacity-60')}>
                  {admin && <td className="px-3 py-2.5"><input type="checkbox" className="h-4 w-4 accent-plum" checked={selected.has(p.variationId)} onChange={() => toggle(p.variationId)} aria-label={`Select ${p.itemName}`} /></td>}
                  <td className="px-3 py-2.5"><span className="flex items-start gap-3"><ProductThumb src={p.imageUrl} alt={p.itemName} /><span><span className="font-medium text-ink">{p.itemName}</span>{p.variationName && <span className="block text-[13px] text-ink-soft">{p.variationName}</span>}{p.upc && <span className="block text-xs text-stone">UPC {p.upc}</span>}</span></span></td>
                  <td className="px-3 py-2.5"><SkuCell p={p} canEdit={canType} /></td>
                  <td className="num px-3 py-2.5 text-right">
                    {p.kind === 'service' ? <span className="text-stone">—</span> : p.quantity == null ? <span className="text-stone">Not tracked</span> : <span className={cx('font-medium', p.quantity <= 0 ? 'text-rose' : p.quantity < 3 ? 'text-amber' : 'text-ink')}>{p.quantity}</span>}
                  </td>
                  <td className="px-3 py-2.5">{p.discontinued
                    ? <div><span className="inline-block rounded-lg border border-line bg-mist px-2 py-0.5 text-[12px] font-medium text-stone">Discontinued</span>
                        <span className="mt-0.5 block text-[11px] text-stone">Not tracked or synced{canType && <> · <button type="button" className="text-plum underline" disabled={settingKind} onClick={() => setDiscontinued([p.variationId], false)}>Track again</button></>}</span></div>
                    : <KindCell p={p} canChange={canType} busy={settingKind} onChange={(k) => saveKind([p.variationId], k)} />}</td>
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
          open onClose={() => setConfirming(false)} title={`Push stock to ${N.shopify}`}
          footer={<><Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button><Button variant="primary" icon={<UploadCloud className="h-4 w-4" />} loading={pushing} onClick={push}>Push {selected.size} to {N.shopify}</Button></>}
        >
          <p className="text-sm text-ink-soft">{N.shopify}’s available stock for {selected.size} product{selected.size === 1 ? '' : 's'} will be <b>set to {N.square}’s count</b>, matched by SKU. Products with separate stock, without a SKU, or with no matching {N.shopify} product are skipped and listed afterwards.</p>
        </Modal>
      )}
      {result && <PushResult result={result} shopifyName={N.shopify} onClose={() => setResult(null)} />}
    </div>
  );
}

/** The SKU, editable in place for people who run the sync: Enter (or ✓) saves it to Square, Esc cancels. */
function SkuCell({ p, canEdit }: { p: SquareInventoryDTO; canEdit: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const N = useStoreNames();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(p.sku ?? '');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const next = v.trim();
    if (!next || next === (p.sku ?? '')) { setEditing(false); setV(p.sku ?? ''); return; }
    setSaving(true);
    try {
      await api.put(`/inventory-sync/products/${encodeURIComponent(p.variationId)}/square-sku`, { sku: next });
      toast(`SKU saved in ${N.square}: ${next}${p.shopifySync.linked ? '' : ` — it pairs at the next sync if a ${N.shopify} product has the same SKU`}`);
      setEditing(false);
      for (const k of ['square-inventory', 'stock-products', 'inventory-sync', 'inventory-sync-links']) qc.invalidateQueries({ queryKey: [k] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  if (!editing) {
    return (
      <span className="group inline-flex items-center gap-1.5">
        <span className={cx('font-mono text-[13px]', p.sku ? 'text-ink-soft' : 'text-stone')}>{p.sku ?? '—'}</span>
        {canEdit && (
          <button type="button" onClick={() => { setV(p.sku ?? ''); setEditing(true); }} className="rounded p-1 text-stone opacity-60 hover:bg-mist hover:text-ink group-hover:opacity-100" aria-label={`${p.sku ? 'Edit' : 'Add'} SKU for ${p.itemName}`} title={p.sku ? 'Edit SKU' : 'Add SKU'}>
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input autoFocus className="w-36 rounded-lg border border-plum bg-white px-2 py-1 font-mono text-[13px] focus:outline-none" value={v} maxLength={120} disabled={saving}
        onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setEditing(false); setV(p.sku ?? ''); } }} aria-label={`SKU for ${p.itemName}`} />
      <button type="button" onClick={save} disabled={saving} className="rounded p-1 text-sage hover:bg-sage-tint" aria-label="Save SKU"><Check className="h-4 w-4" /></button>
      <button type="button" onClick={() => { setEditing(false); setV(p.sku ?? ''); }} disabled={saving} className="rounded p-1 text-stone hover:bg-mist" aria-label="Cancel"><X className="h-4 w-4" /></button>
    </span>
  );
}

const KIND_TONE: Record<ProductKind, string> = {
  shared: 'border-sage/40 bg-sage-tint text-sage', separate: 'border-amber/40 bg-amber-tint text-amber', salon_only: 'border-plum/30 bg-plum/5 text-plum', service: 'border-line bg-mist text-ink-soft',
};

/** The product's type: a coloured picker for people who run the sync, a label for everyone else. */
function KindCell({ p, canChange, busy, onChange }: { p: SquareInventoryDTO; canChange: boolean; busy: boolean; onChange: (k: ProductKind) => void }) {
  const N = useStoreNames();
  const k = PRODUCT_KINDS.find((x) => x.value === p.kind);
  const note = p.kind === 'shared' && !p.shopifySync.linked ? `Not paired with ${N.shopify} yet — give both the same SKU`
    : p.kind === 'shared' && (p.shopifySync.linkStatus === 'needs_attention' || p.shopifySync.linkStatus === 'error') ? 'Needs attention in Sync'
    : k?.help;
  return (
    <div className="sm:max-w-[240px]">
      {canChange ? (
        <select className={cx('rounded-lg border px-2 py-1 text-[13px] font-medium', k ? KIND_TONE[k.value] : 'border-dashed border-line-strong bg-white text-stone')} value={p.kind ?? ''} disabled={busy}
          onChange={(e) => e.target.value && onChange(e.target.value as ProductKind)} aria-label={`Type for ${p.itemName}`}>
          {!k && <option value="">Choose type…</option>}
          {PRODUCT_KINDS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
      ) : <span className={cx('inline-block rounded-lg border px-2 py-0.5 text-[12px] font-medium', k ? KIND_TONE[k.value] : 'border-line text-stone')}>{k?.label ?? 'Not set'}</span>}
      {note && <span className={cx('mt-0.5 block text-[11px]', p.kind === 'shared' && note !== k?.help ? 'text-amber' : 'text-stone')}>{note}</span>}
    </div>
  );
}

function PushResult({ result, shopifyName, onClose }: { result: ShopifyPushResult; shopifyName: string; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={`${shopifyName} push finished`} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="space-y-4 text-sm">
        <p className="flex items-center gap-2 text-sage"><CheckCircle2 className="h-4 w-4" />{result.pushed.length} updated in {shopifyName}</p>
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
