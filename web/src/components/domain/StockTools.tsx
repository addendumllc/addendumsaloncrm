import { Fragment, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  STOCK_REASONS, productSearchText, productSearchWords, type PurchaseOrderDTO, type StockApplyResultDTO, type SupplierDTO, type StockChangeInput, type StockForecastDTO, type StockForecastResponse,
  type StockProductDTO, type StockProductStatus, type StockTxnDTO,
} from '@addendum/shared';
import { AlertTriangle, ArrowLeftRight, Settings2, ChevronDown, ChevronRight, Download, FileUp, ListPlus, PackageCheck, Plus, Replace, Search, Trash2, Pencil, X } from 'lucide-react';
import { api } from '../../api/client';
import { useCanDo } from '../../api/hooks';
import { downloadCsv, parseCsv } from '../../lib/csv';
import { dateShort, dateTime, labelOfKey, relative } from '../../lib/format';
import { Badge, Button, EmptyState, ErrorNote, Field, Modal, PageLoading, Segmented, Toggle, cx, useToast } from '../ui';
import { useStoreNames } from '../../lib/storeNames';
import { ProductThumb } from './ProductThumb';

/**
 * Inventory tools from Addendum-Stockline, inside Inventory Sync: Products (edit all, update by SKU, spreadsheet),
 * Stock (counts, adjustments, history), Reorder (forecasts) and Purchase orders. Stock and SKU changes go to Square and
 * Shopify together.
 */

type ProductsResponse = { products: StockProductDTO[]; square: boolean; shopify: boolean; store2: string | null };
const useSuppliers = () => useQuery({ queryKey: ['stock-suppliers'], queryFn: () => api.get<{ suppliers: SupplierDTO[] }>('/inventory-sync/stock/suppliers').then((r) => r.suppliers), staleTime: 30_000 });
/** The default supplier's name — shown (and used) where a product or order doesn't name one. */
const useDefaultSupplier = () => useSuppliers().data?.find((s) => s.isDefault)?.name ?? null;
const useProducts = () => useQuery({ queryKey: ['stock-products'], queryFn: () => api.get<ProductsResponse>('/inventory-sync/stock/products'), staleTime: 20_000 });
const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const normName = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const cents = (v: string) => (v.trim() === '' ? null : Math.round(Number(v.replace(/[$,]/g, '')) * 100));
const intOr = (v: string) => (v.trim() === '' ? null : Math.round(Number(v)));
const usd = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2));
const STATUS_LABEL: Record<StockProductStatus, string> = { active: 'Active', discontinued: 'Discontinued', not_tracked: 'Not tracked' };

function useRefresh() {
  const qc = useQueryClient();
  return () => { for (const k of ['stock-products', 'stock-history', 'stock-forecast', 'stock-pos', 'stock-suppliers', 'analytics-products', 'inventory-sync', 'inventory-sync-links']) qc.invalidateQueries({ queryKey: [k] }); };
}

/** Shows what happened to each product after a batch (problems first). */
function useApplyReport() {
  const toast = useToast();
  const N = useStoreNames();
  return (r: StockApplyResultDTO) => {
    const bad = r.results.filter((x) => !x.ok);
    if (bad.length) toast(`${bad.length} not changed: ${bad.slice(0, 3).map((b) => `${b.label}: ${b.note}`).join(' · ')}${bad.length > 3 ? ' …' : ''}`, 'error');
    if (r.changed) toast(`Updated ${r.changed} product${r.changed === 1 ? '' : 's'} in ${N.square} and ${N.shopify}.`);
    else if (!bad.length) toast('Nothing needed changing.');
  };
}

/** A stock number; below zero online it's pre-orders (customers waiting), so it says so. */
function Qty({ q, cls }: { q: number | null; cls?: string }) {
  if (q == null) return <b className={cx('num', cls)}>—</b>;
  if (q < 0) return <span className="inline-flex items-baseline gap-1"><b className={cx('num', cls)}>0</b><span className="whitespace-nowrap bg-amber-tint px-1 text-[11px] font-medium text-amber" title="Ordered online before it was in stock">{-q} pre-order{q === -1 ? '' : 's'}</span></span>;
  return <b className={cx('num', cls)}>{q}</b>;
}

/** Stock per store. When every store agrees it's one number; otherwise each store is labelled and the mismatch is red. */
/**
 * The second store's listings of one product: its retail (direct-to-consumer) listing is "AH" and its Pro-pricing
 * listing "AH-Pro" (from "Pro" in the listing's name); numbered only when that can't be told apart.
 */
function store2Names(p: StockProductDTO, store2: string | null) {
  const base = (store2 ?? 'Store 2').replace(/\s+shopify$/i, '');
  const isPro = p.store2.map((e) => /\bpro\b/i.test(e.label));
  const clear = p.store2.length === 2 && isPro.filter(Boolean).length === 1;
  return p.store2.map((_e, n) => (p.store2.length < 2 ? (store2 ?? 'Store 2') : clear ? (isPro[n] ? `${base}-Pro` : base) : `${store2 ?? 'Store 2'} #${n + 1}`));
}

function StockCell({ p, store2 }: { p: StockProductDTO; store2: string | null }) {
  const N = useStoreNames();
  const parts = [
    p.squareVariationId && { name: N.square, qty: p.squareQty },
    p.shopifyInventoryItemId && { name: N.shopify, qty: p.shopifyQty },
    ...p.store2.map((e, n) => ({ name: store2Names(p, store2)[n], qty: e.qty })),
  ].filter(Boolean) as { name: string; qty: number | null }[];
  // Separate stock: the salon floor and online are different counts on purpose — shown side by side, not as a mismatch.
  if (p.kind === 'separate') {
    return (
      <span className="flex flex-wrap gap-1">
        {[[N.square, p.squareQty], [store2 && p.store2.length ? N.shopify : 'Online', p.shopifyQty], ...p.store2.map((e, i) => [store2Names(p, store2)[i], e.qty])].filter(([, q]) => q != null).map(([n, q]) => (
          <span key={n as string} className="inline-flex items-baseline gap-1 rounded-md bg-mist px-1.5 py-0.5 text-[11px] text-ink-soft">{n}<Qty q={q as number} cls="text-[12px] text-ink" /></span>
        ))}
      </span>
    );
  }
  const known = parts.filter((x) => x.qty != null);
  if (!known.length) return <span className="text-[12px] text-stone">Not tracked</span>;
  const agree = known.every((x) => x.qty === known[0].qty) && known.length === parts.length;
  if (agree) {
    return (
      <span className="inline-flex items-baseline gap-1.5">
        <Qty q={known[0].qty} cls={cx('text-[15px] font-medium', known[0].qty! <= 0 ? 'text-rose' : 'text-ink')} />
        {parts.length > 1 && <span className="text-[11px] text-stone">in {parts.length === 2 ? 'both stores' : `all ${parts.length} stores`}</span>}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1" title="The stores differ — the next sync settles it">
      {parts.map((x) => (
        <span key={x.name} className="inline-flex items-baseline gap-1 rounded-md bg-rose-tint px-1.5 py-0.5 text-[11px] text-ink-soft">
          {x.name}<Qty q={x.qty} cls="text-[12px] text-rose" />
        </span>
      ))}
    </span>
  );
}

const WHERE: Record<string, { label: string; tone: 'sage' | 'neutral' | 'plum' | 'amber' }> = {
  both: { label: 'Synced', tone: 'sage' }, square: { label: 'Square only', tone: 'neutral' }, shopify: { label: 'Shopify only', tone: 'plum' },
  separate: { label: 'Separate stock', tone: 'amber' }, salon_only: { label: 'Salon only', tone: 'neutral' },
};

/** Every word must match the name (colour, size…), a SKU, a collection or category, the supplier, or a listing name. */
function filterProducts(list: StockProductDTO[], q: string, status: string) {
  const words = productSearchWords(q);
  return list.filter((p) => (status === 'all' || p.status === status) && (!words.length || (() => {
    const text = productSearchText(p.label, p.sku, p.squareSku, p.shopifySku, p.supplier, ...p.collections, ...p.store2.map((e) => e.label));
    return words.every((w) => text.includes(w));
  })()));
}
const SEARCH_HINT = 'Search name, colour, collection or SKU (e.g. aperol 18")';

/** Collections/categories under a product's name. */
const Collections = ({ p }: { p: StockProductDTO }) => (p.collections.length ? <span className="block truncate text-[12px] text-stone">{p.collections.slice(0, 3).join(' · ')}</span> : null);

// ---------------- Products: edit all, update by SKU, spreadsheet ----------------
type Draft = { sku?: string; count?: string; online?: string; supplier?: string; cost?: string; lead?: string; safety?: string; moq?: string; caseSize?: string; status?: StockProductStatus };

/** `only="shopify"`: the products that aren't in Square (sold online only), synced between the Shopify stores. */
/** Products. `setup`: Inventory → Products, with the reorder details (supplier, cost, lead time…) shown; All inventory keeps them tucked away. */
export function ProductsView({ only, setup }: { only?: 'shopify'; setup?: boolean } = {}) {
  const N = useStoreNames();
  const fallbackSupplier = useDefaultSupplier();
  const { data, isLoading, error, refetch } = useProducts();
  const toast = useToast();
  const refresh = useRefresh();
  const report = useApplyReport();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [edits, setEdits] = useState<Record<string, Draft>>({});
  const [reason, setReason] = useState<string>('Correction');
  const [saving, setSaving] = useState(false);
  const [bySku, setBySku] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [replacing, setReplacing] = useState(false);
  // Reorder fields (supplier, cost, lead time…) are hidden until asked for, so the everyday view is just SKU and stock.
  const [details, setDetails] = useState(() => { if (setup) return true; try { return localStorage.getItem('stock-products-details') === '1'; } catch { return false; } });
  const showDetails = (v: boolean) => { setDetails(v); try { localStorage.setItem('stock-products-details', v ? '1' : '0'); } catch { /* private window */ } };
  // What didn't save last time (stays until dismissed; those cells keep their edits).
  const [problems, setProblems] = useState<StockApplyResultDTO['results']>([]);
  const scoped = useMemo(() => (data?.products ?? []).filter((p) => only !== 'shopify' || !p.squareVariationId), [data, only]);
  // Collections (from Square and Shopify) to narrow the list fast, and ticking products to change many at once.
  const [coll, setColl] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkSupplier, setBulkSupplier] = useState('');
  const collectionList = useMemo(() => [...new Set(scoped.flatMap((p) => p.collections))].sort((a, b) => a.localeCompare(b)), [scoped]);
  const shown = useMemo(() => filterProducts(scoped, q, status).filter((p) => !coll || p.collections.includes(coll)), [scoped, q, status, coll]);
  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;

  const set = (key: string, patch: Draft) => setEdits((e) => ({ ...e, [key]: { ...e[key], ...patch } }));
  const val = (p: StockProductDTO, k: keyof Draft, base: string) => (edits[p.key]?.[k] as string | undefined) ?? base;
  const changed = (p: StockProductDTO, k: keyof Draft, base: string) => edits[p.key]?.[k] !== undefined && edits[p.key]![k] !== base;
  const dirty = Object.keys(edits).length;

  const saveAll = async () => {
    const byKey = new Map(data.products.map((p) => [p.key, p]));
    const changes: StockChangeInput[] = [];
    const settings: any[] = [];
    for (const [key, d] of Object.entries(edits)) {
      const p = byKey.get(key);
      if (!p) continue;
      const c: StockChangeInput = { key };
      if (d.sku !== undefined && d.sku.trim() && d.sku.trim() !== (p.sku ?? '')) c.sku = d.sku.trim();
      if (d.count !== undefined && d.count.trim() !== '') {
        const n = Number(d.count);
        if (!Number.isInteger(n) || n < 0) { toast(`Stock for ${p.label} must be a whole number.`, 'error'); return; }
        // Separate stock: this box is the salon's count only.
        if (p.kind === 'separate' ? n !== p.squareQty : n !== p.squareQty || n !== p.shopifyQty) c.quantity = n;
      }
      if (d.online !== undefined && d.online.trim() !== '' && p.kind === 'separate') {
        const n = Number(d.online);
        if (!Number.isInteger(n) || n < 0) { toast(`Online stock for ${p.label} must be a whole number.`, 'error'); return; }
        if (n !== p.shopifyQty || p.store2.some((e) => e.qty !== n)) c.onlineQuantity = n;
      }
      if (c.sku !== undefined || c.quantity !== undefined || c.onlineQuantity !== undefined) changes.push(c);
      const s: any = { key };
      if (d.supplier !== undefined) s.supplier = d.supplier.trim() || null;
      if (d.cost !== undefined) s.costCents = cents(d.cost);
      if (d.lead !== undefined) s.leadTimeDays = intOr(d.lead);
      if (d.safety !== undefined) s.safetyDays = intOr(d.safety);
      if (d.moq !== undefined) s.moq = intOr(d.moq);
      if (d.caseSize !== undefined) s.caseSize = intOr(d.caseSize) || null;
      if (d.status !== undefined) s.status = d.status;
      if (Object.keys(s).length > 1) settings.push(s);
    }
    if (!changes.length && !settings.length) { setEdits({}); return; }
    setSaving(true);
    setProblems([]);
    try {
      if (settings.length) await api.put('/inventory-sync/stock/products/settings', { rows: settings });
      let failed = new Set<string>();
      if (changes.length) {
        const r = await api.post<StockApplyResultDTO>('/inventory-sync/stock/apply', { kind: 'count', reason, changes });
        report(r);
        const bad = r.results.filter((x) => !x.ok);
        setProblems(bad);
        failed = new Set(bad.map((x) => x.key));
      } else toast('Saved.');
      setEdits((e) => Object.fromEntries(Object.entries(e).filter(([k]) => failed.has(k))));
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const download = () => downloadCsv(`products-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Key', 'Product', 'SKU', `${N.square} stock`, `${N.shopify} stock`, 'New count', 'Supplier', 'Cost', 'Lead time days', 'Safety days', 'MOQ', 'Case size', 'Status'],
    scoped.map((p) => [p.key, p.label, p.sku ?? '', p.squareQty ?? '', p.shopifyQty ?? '', '', p.supplier ?? '', usd(p.costCents), p.leadTimeDays ?? '', p.safetyDays ?? '', p.moq ?? '', p.caseSize ?? '', STATUS_LABEL[p.status]]));

  const inp = 'w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-[14px] placeholder:text-stone/60 focus:border-plum focus:outline-none';
  const yellow = 'border-amber bg-amber-tint focus:border-amber';
  const badgeFor = (p: StockProductDTO) => {
    const where = WHERE[p.kind === 'separate' || p.kind === 'salon_only' ? p.kind : p.linkId ? 'both' : p.squareVariationId ? 'square' : 'shopify'];
    if (where.tone === 'sage' || only === 'shopify') return null;
    return <Badge tone={where.tone} className="mt-0.5 shrink-0">{where.label === 'Shopify only' ? (p.store2.length && data.store2 ? `${N.shopify} + ${data.store2}` : `${N.shopify} only`) : where.label === 'Square only' ? `${N.square} only` : where.label}</Badge>;
  };
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
          <input className="field h-11 pl-9 text-[16px] sm:text-[14px]" type="search" placeholder={SEARCH_HINT} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {collectionList.length > 0 && (
          <select className="field h-11 w-auto max-w-full py-1 text-[14px]" value={coll} onChange={(e) => setColl(e.target.value)} aria-label="Collection">
            <option value="">All collections</option>
            {collectionList.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <Segmented className="max-w-full overflow-x-auto" value={status} onChange={setStatus} options={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }, { value: 'discontinued', label: 'Discontinued' }, { value: 'not_tracked', label: 'Not tracked' }]} />
      </div>
      {/* Select all (what's shown), then change many at once; nothing is saved until Save. */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
        <label className="flex items-center gap-2 text-ink-soft">
          <input type="checkbox" className="h-4 w-4 accent-plum" checked={shown.length > 0 && shown.slice(0, 500).every((p) => picked.has(p.key))}
            onChange={(e) => setPicked(e.target.checked ? new Set(shown.slice(0, 500).map((p) => p.key)) : new Set())} aria-label="Select all shown" />
          {picked.size ? `${picked.size} selected` : `Select all ${Math.min(shown.length, 500)} shown`}
        </label>
        {picked.size > 0 && <>
          <select className="field h-9 w-auto py-1 text-[13px]" value="" onChange={(e) => { const v = e.target.value as StockProductStatus; if (v) for (const k of picked) set(k, { status: v }); }} aria-label="Set status for selected">
            <option value="">Set status…</option>
            {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {details && <>
            <input className="field h-9 w-40 py-1 text-[13px]" placeholder="Supplier for selected" value={bulkSupplier} onChange={(e) => setBulkSupplier(e.target.value)} aria-label="Supplier for selected" />
            <Button size="sm" disabled={!bulkSupplier.trim()} onClick={() => { for (const k of picked) set(k, { supplier: bulkSupplier.trim() }); }}>Set supplier</Button>
          </>}
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
        </>}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-x-1 gap-y-2 text-[13px]">
        <span className="mr-1 text-stone">Change many at once:</span>
        <Button size="sm" variant="ghost" icon={<ListPlus className="h-4 w-4" />} onClick={() => setBySku(true)}>Paste a list by SKU</Button>
        <Button size="sm" variant="ghost" icon={<Replace className="h-4 w-4" />} onClick={() => setReplacing(true)}>Find &amp; replace in SKUs</Button>
        <Button size="sm" variant="ghost" icon={<Download className="h-4 w-4" />} onClick={download}>Download spreadsheet</Button>
        <Button size="sm" variant="ghost" icon={<FileUp className="h-4 w-4" />} onClick={() => setSheet(true)}>Upload spreadsheet</Button>
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-ink-soft">
          <input type="checkbox" checked={details} onChange={(e) => showDetails(e.target.checked)} />Show reorder details
        </label>
      </div>
      {dirty > 0 && (
        <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl2 border border-amber/40 bg-amber-tint px-4 py-2 text-[13px]">
          <span className="font-medium text-ink">{dirty} product{dirty === 1 ? '' : 's'} edited — not saved yet</span>
          <span className="text-ink-soft">Reason for stock changes:</span>
          <select className="rounded-md border border-line bg-white px-2 py-1" value={reason} onChange={(e) => setReason(e.target.value)}>{STOCK_REASONS.map((r) => <option key={r}>{r}</option>)}</select>
          <span className="ml-auto flex gap-2"><Button size="sm" variant="ghost" onClick={() => setEdits({})}>Discard</Button><Button size="sm" variant="primary" loading={saving} onClick={saveAll}>Save to all stores</Button></span>
        </div>
      )}
      {problems.length > 0 && (
        <div className="mb-3 rounded-xl2 border border-rose/30 bg-rose-tint px-4 py-3 text-[13px]">
          <div className="mb-1 flex items-center"><span className="font-medium text-rose">{problems.length} product{problems.length === 1 ? '' : 's'} didn’t save — still marked in yellow below</span><button type="button" className="ml-auto text-ink-soft underline" onClick={() => setProblems([])}>Dismiss</button></div>
          <ul className="list-disc space-y-0.5 pl-5 text-ink-soft">{problems.slice(0, 20).map((x) => <li key={x.key}><b className="text-ink">{x.label}</b>: {x.note}</li>)}</ul>
        </div>
      )}
      {only === 'shopify' && (
        <p className="mb-3 rounded-xl2 border border-line bg-white px-4 py-3 text-[14px] text-ink-soft">
          Products sold online that aren’t in {N.square}{data.store2 ? <>. Their stock is shared by <b className="font-medium text-ink">{N.shopify}</b> and <b className="font-medium text-ink">{data.store2}</b> — a count set here goes to both, and each sync combines both stores’ sales</> : <> — a count set here goes to {N.shopify}</>}.
        </p>
      )}
      <p className="mb-2 text-[13px] text-stone">Type a new SKU or count and press <b className="font-medium text-ink-soft">Save</b> — it’s set in every store (separate-stock products have two boxes: {N.square}, and Online for {data.store2 ? `${N.shopify} + ${data.store2}` : N.shopify}).{details ? ' Reorder details stay in the CRM and are used for reorder suggestions.' : ''}</p>
      {/* Phones: one card per product, with big boxes for the SKU and count. */}
      <ul className="space-y-2 sm:hidden">
        {shown.slice(0, 200).map((p) => {
          const b = badgeFor(p);
          const big = 'h-11 w-full rounded-lg border border-line bg-white px-3 text-[16px] focus:border-plum focus:outline-none';
          return (
            <li key={p.key} className={cx('rounded-xl2 border bg-white p-3', edits[p.key] ? 'border-amber/50' : 'border-line')}>
              <div className="flex items-start gap-3">
                <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-plum" checked={picked.has(p.key)} onChange={() => setPicked((x) => { const n = new Set(x); if (n.has(p.key)) n.delete(p.key); else n.add(p.key); return n; })} aria-label={`Select ${p.label}`} />
                <ProductThumb src={p.imageUrl} alt={p.label} size="lg" />
                <div className="min-w-0 flex-1"><p className="text-[15px] font-medium leading-snug text-ink">{p.label}</p><Collections p={p} /></div>
                {b}
              </div>
              <div className="mt-2"><StockCell p={p} store2={data.store2} /></div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="col-span-2 block"><span className="mb-0.5 block text-[11px] uppercase tracking-wide text-stone">SKU</span>
                  <input className={cx(big, 'font-mono', changed(p, 'sku', p.sku ?? '') && yellow)} placeholder="No SKU" value={val(p, 'sku', p.sku ?? '')} onChange={(e) => set(p.key, { sku: e.target.value })} aria-label={`SKU for ${p.label}`} /></label>
                {p.kind === 'separate' ? (
                  <>
                    <label className="block"><span className="mb-0.5 block text-[11px] uppercase tracking-wide text-stone">New {N.square} count</span>
                      <input inputMode="numeric" className={cx(big, 'num', changed(p, 'count', '') && yellow)} placeholder={p.squareQty == null ? '—' : String(p.squareQty)} value={val(p, 'count', '')} onChange={(e) => set(p.key, { count: e.target.value })} /></label>
                    {p.shopifyQty != null && <label className="block"><span className="mb-0.5 block text-[11px] uppercase tracking-wide text-stone">New online count</span>
                      <input inputMode="numeric" className={cx(big, 'num', changed(p, 'online', '') && yellow)} placeholder={String(p.shopifyQty)} value={val(p, 'online', '')} onChange={(e) => set(p.key, { online: e.target.value })} /></label>}
                  </>
                ) : (
                  <label className="block"><span className="mb-0.5 block text-[11px] uppercase tracking-wide text-stone">New count</span>
                    <input inputMode="numeric" className={cx(big, 'num', changed(p, 'count', '') && yellow)} placeholder="Set…" value={val(p, 'count', '')} onChange={(e) => set(p.key, { count: e.target.value })} aria-label={`New count for ${p.label}`} /></label>
                )}
                <label className="block"><span className="mb-0.5 block text-[11px] uppercase tracking-wide text-stone">Status</span>
                  <select className={cx(big, edits[p.key]?.status && edits[p.key]!.status !== p.status && yellow)} value={edits[p.key]?.status ?? p.status} onChange={(e) => set(p.key, { status: e.target.value as StockProductStatus })}>
                    {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select></label>
              </div>
            </li>
          );
        })}
        {!shown.length && <li className="panel"><EmptyState title="No products match">Try a colour, a collection, a size (18") or part of the SKU.</EmptyState></li>}
        {shown.length > 200 && <li className="px-1 text-[12px] text-stone">Showing the first 200 — search to narrow it down.</li>}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl2 border border-line bg-white sm:block">
        <table className={cx('w-full text-left text-[14px]', details ? 'min-w-[1100px]' : 'min-w-[800px]')}>
          <thead className="border-b border-line bg-mist/50 text-[11px] uppercase tracking-wide text-stone">
            <tr>
              <th className="w-8 pl-4"><span className="sr-only">Select</span></th>
              <th className="px-4 py-2.5 font-medium">Product</th><th className="px-2 py-2.5 font-medium">SKU</th><th className="px-2 py-2.5 font-medium">In stock</th><th className="px-2 py-2.5 font-medium">New count</th>
              {details && <><th className="px-2 py-2.5 font-medium">Supplier</th><th className="px-2 py-2.5 font-medium">Cost $</th><th className="px-2 py-2.5 font-medium" title="Days from ordering to arriving">Lead days</th><th className="px-2 py-2.5 font-medium" title="Extra days of stock to keep">Safety days</th><th className="px-2 py-2.5 font-medium" title="Minimum order quantity">Min order</th><th className="px-2 py-2.5 font-medium">Case size</th></>}
              <th className="px-2 py-2.5 font-medium" title="Discontinued or Not tracked: left out of syncing and lists">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.slice(0, 500).map((p) => {
              const rowChanged = !!edits[p.key];
              return (
              <tr key={p.key} className={cx(rowChanged && 'bg-amber-tint/40')}>
                <td className="pl-4"><input type="checkbox" className="h-4 w-4 accent-plum" checked={picked.has(p.key)} onChange={() => setPicked((x) => { const n = new Set(x); if (n.has(p.key)) n.delete(p.key); else n.add(p.key); return n; })} aria-label={`Select ${p.label}`} /></td>
                <td className="max-w-[340px] px-4 py-2.5">
                  <span className="flex items-start gap-3">
                    <ProductThumb src={p.imageUrl} alt={p.label} />
                    <span className="min-w-0">
                      <span className="block truncate text-ink" title={p.label}>{p.label}</span>
                      <Collections p={p} />
                      {badgeFor(p)}
                    </span>
                  </span>
                </td>
                <td className="w-44 px-2 py-2"><input className={cx(inp, 'font-mono', changed(p, 'sku', p.sku ?? '') && yellow)} placeholder="No SKU" value={val(p, 'sku', p.sku ?? '')} onChange={(e) => set(p.key, { sku: e.target.value })} aria-label={`SKU for ${p.label}`} /></td>
                <td className="px-2 py-2"><StockCell p={p} store2={data.store2} /></td>
                <td className={cx('px-2 py-2', p.kind === 'separate' ? 'w-36' : 'w-28')}>
                  {p.kind === 'separate' ? (
                    // Separate stock: the salon floor and online are counted apart, so each gets its own box.
                    <div className="space-y-1">
                      <label className="flex items-center gap-1.5"><span className="w-11 shrink-0 text-[11px] text-stone">{N.square}</span>
                        <input inputMode="numeric" className={cx(inp, 'num', changed(p, 'count', '') && yellow)} placeholder={p.squareQty == null ? '—' : String(p.squareQty)} value={val(p, 'count', '')} onChange={(e) => set(p.key, { count: e.target.value })} aria-label={`New ${N.square} count for ${p.label}`} /></label>
                      {p.shopifyQty != null && <label className="flex items-center gap-1.5"><span className="w-11 shrink-0 text-[11px] text-stone" title={data.store2 ? `${N.shopify} and ${data.store2}` : N.shopify}>Online</span>
                        <input inputMode="numeric" className={cx(inp, 'num', changed(p, 'online', '') && yellow)} placeholder={String(p.shopifyQty)} value={val(p, 'online', '')} onChange={(e) => set(p.key, { online: e.target.value })} aria-label={`New online count for ${p.label}`} /></label>}
                    </div>
                  ) : <input inputMode="numeric" className={cx(inp, 'num', changed(p, 'count', '') && yellow)} placeholder="Set…" value={val(p, 'count', '')} onChange={(e) => set(p.key, { count: e.target.value })} aria-label={`New count for ${p.label}`} />}
                </td>
                {details && <>
                  <td className="w-36 px-2 py-2"><input className={cx(inp, changed(p, 'supplier', p.supplier ?? '') && yellow)} placeholder={fallbackSupplier ?? ''} value={val(p, 'supplier', p.supplier ?? '')} onChange={(e) => set(p.key, { supplier: e.target.value })} /></td>
                  <td className="w-24 px-2 py-2"><input inputMode="decimal" className={cx(inp, 'num', changed(p, 'cost', usd(p.costCents)) && yellow)} value={val(p, 'cost', usd(p.costCents))} onChange={(e) => set(p.key, { cost: e.target.value })} /></td>
                  {(['lead', 'safety', 'moq', 'caseSize'] as const).map((k) => {
                    const base = String({ lead: p.leadTimeDays, safety: p.safetyDays, moq: p.moq, caseSize: p.caseSize }[k] ?? '');
                    return <td key={k} className="w-20 px-2 py-2"><input inputMode="numeric" className={cx(inp, 'num', changed(p, k, base) && yellow)} value={val(p, k, base)} onChange={(e) => set(p.key, { [k]: e.target.value })} /></td>;
                  })}
                </>}
                <td className="w-36 px-2 py-2">
                  <select className={cx(inp, edits[p.key]?.status && edits[p.key]!.status !== p.status && yellow)} value={edits[p.key]?.status ?? p.status} onChange={(e) => set(p.key, { status: e.target.value as StockProductStatus })} aria-label={`Status of ${p.label}`}>
                    {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        {!shown.length && <EmptyState title="No products match" />}
      </div>
      {shown.length > 500 && <p className="mt-2 text-[12px] text-stone">Showing the first 500 — search to narrow it down.</p>}
      {bySku && <UpdateBySkuModal products={data.products} onClose={() => setBySku(false)} />}
      {sheet && <SpreadsheetModal products={data.products} onClose={() => setSheet(false)} />}
      {replacing && <ReplaceSkuModal products={data.products} initialSearch={q} onClose={() => setReplacing(false)} />}
    </div>
  );
}

type Plan = { p: StockProductDTO; sku?: string; quantity?: number; delta?: number; settings?: Record<string, unknown>; text: string };

function PlanTable({ plan, unknown }: { plan: Plan[]; unknown: string[] }) {
  return (
    <div className="space-y-2">
      <p className="text-[13px] text-ink"><b>{plan.length}</b> product{plan.length === 1 ? '' : 's'} will change{unknown.length ? <> · <span className="text-rose">{unknown.length} not found (left out)</span></> : null}</p>
      {plan.length > 0 && (
        <div className="max-h-[320px] overflow-auto rounded-lg border border-line">
          <table className="w-full text-[13px]"><tbody className="divide-y divide-line">
            {plan.map((x) => <tr key={x.p.key}><td className="px-3 py-1.5 text-ink">{x.p.label}<span className="block text-[11px] text-stone">{x.p.sku}</span></td><td className="px-3 py-1.5 text-ink-soft">{x.text}</td></tr>)}
          </tbody></table>
        </div>
      )}
      {unknown.length > 0 && <p className="text-[12px] text-rose">Not found: {unknown.slice(0, 20).join(', ')}{unknown.length > 20 ? ' …' : ''}</p>}
    </div>
  );
}

async function applyPlan(plan: Plan[], kind: 'count' | 'adjust' | 'import' | 'sku', reason: string, note: string) {
  const settings = plan.filter((x) => x.settings).map((x) => ({ key: x.p.key, ...x.settings }));
  if (settings.length) await api.put('/inventory-sync/stock/products/settings', { rows: settings });
  const changes = plan.filter((x) => x.sku !== undefined || x.quantity !== undefined || x.delta !== undefined)
    .map((x) => ({ key: x.p.key, ...(x.sku !== undefined ? { sku: x.sku } : {}), ...(x.quantity !== undefined ? { quantity: x.quantity } : {}), ...(x.delta !== undefined ? { delta: x.delta } : {}) }));
  return changes.length ? api.post<StockApplyResultDTO>('/inventory-sync/stock/apply', { kind, reason, note: note || null, changes }) : null;
}

/** Changes part of many SKUs at once (e.g. Redefined Weft: R2- → RW-), in Square and Shopify, after a preview. */
function ReplaceSkuModal({ products, initialSearch, onClose }: { products: StockProductDTO[]; initialSearch: string; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const report = useApplyReport();
  const [q, setQ] = useState(initialSearch);
  const [find, setFind] = useState('');
  const [repl, setRepl] = useState('');
  const [startOnly, setStartOnly] = useState(true);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const plan = useMemo(() => {
    if (!find) return [] as Plan[];
    const f = find.toLowerCase();
    const out: Plan[] = [];
    for (const p of filterProducts(products, q, 'all')) {
      // Both stores' SKUs are checked, so a product whose Square and Shopify SKUs differ still gets fixed.
      const cur = [p.sku, p.squareSku, p.shopifySku].find((x) => x && (startOnly ? x.toLowerCase().startsWith(f) : x.toLowerCase().includes(f)));
      if (!cur) continue;
      const next = startOnly ? repl + cur.slice(find.length) : cur.replace(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), repl);
      if (!next.trim() || next === p.sku) continue;
      out.push({ p, sku: next.trim(), text: `${cur} → ${next.trim()}` });
    }
    return out;
  }, [products, q, find, repl, startOnly]);
  const chosen = plan.filter((x) => !skip.has(x.p.key));
  const apply = async () => {
    setBusy(true);
    try {
      const r = await applyPlan(chosen, 'sku', 'SKU change', `Replaced “${find}” with “${repl}”`);
      if (r) report(r);
      refresh();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} wide title="Find & replace in SKUs" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!chosen.length} onClick={apply}>Change {chosen.length || ''} SKU{chosen.length === 1 ? '' : 's'}</Button></>}>
      <div className="space-y-3 text-[14px]">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Only products matching" hint="e.g. redefined weft (blank = all)"><input className="field" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          <Field label="Find"><input className="field font-mono" value={find} onChange={(e) => setFind(e.target.value)} placeholder="R2-" /></Field>
          <Field label="Replace with"><input className="field font-mono" value={repl} onChange={(e) => setRepl(e.target.value)} placeholder="RW-" /></Field>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-ink-soft"><input type="checkbox" checked={startOnly} onChange={(e) => setStartOnly(e.target.checked)} />Only at the start of the SKU (a prefix)</label>
        {find && !plan.length && <p className="text-stone">No SKUs {startOnly ? 'start with' : 'contain'} “{find}”{q ? ` among products matching “${q}”` : ''}.</p>}
        {plan.length > 0 && (
          <div className="max-h-[340px] overflow-auto rounded-lg border border-line">
            <table className="w-full text-[13px]"><tbody className="divide-y divide-line">
              {plan.map((x) => (
                <tr key={x.p.key}>
                  <td className="w-8 px-3 py-1.5"><input type="checkbox" checked={!skip.has(x.p.key)} onChange={() => setSkip((s) => { const n = new Set(s); if (n.has(x.p.key)) n.delete(x.p.key); else n.add(x.p.key); return n; })} aria-label={`Change ${x.p.label}`} /></td>
                  <td className="px-2 py-1.5 text-ink">{x.p.label}</td>
                  <td className="px-3 py-1.5 font-mono text-ink-soft">{x.text}</td>
                </tr>
              ))}
            </tbody></table>
          </div>
        )}
        <p className="text-[12px] text-stone">Each SKU is changed in Square and Shopify and logged in Stock history. A SKU another product already uses is skipped and listed.</p>
      </div>
    </Modal>
  );
}

/** Paste one line per product: SKU, then a count, an amount to add/remove, or a new SKU. */
function UpdateBySkuModal({ products, onClose }: { products: StockProductDTO[]; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const report = useApplyReport();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'count' | 'adjust' | 'sku'>('count');
  const [reason, setReason] = useState<string>('Stock count');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const bySku = useMemo(() => {
    const m = new Map<string, StockProductDTO>();
    for (const p of products) for (const s of [p.squareSku, p.shopifySku, p.sku]) if (s) m.set(norm(s), p);
    return m;
  }, [products]);
  const { plan, unknown, bad } = useMemo(() => {
    const plan: Plan[] = [];
    const unknown: string[] = [];
    const bad: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const [skuRaw, valRaw] = line.split(/\t|,/).map((x) => x?.trim() ?? '');
      if (!skuRaw) continue;
      const p = bySku.get(norm(skuRaw));
      if (!p) { unknown.push(skuRaw); continue; }
      if (mode === 'sku') {
        if (!valRaw) { bad.push(line); continue; }
        plan.push({ p, sku: valRaw, text: `SKU ${p.sku} → ${valRaw}` });
      } else {
        const n = Number(valRaw);
        if (valRaw === '' || !Number.isInteger(n) || (mode === 'count' && n < 0)) { bad.push(line); continue; }
        plan.push(mode === 'count' ? { p, quantity: n, text: `Count ${p.squareQty ?? '—'} / ${p.shopifyQty ?? '—'} → ${n}` } : { p, delta: n, text: `${n >= 0 ? '+' : ''}${n} (now ${p.squareQty ?? '—'} / ${p.shopifyQty ?? '—'})` });
      }
    }
    return { plan, unknown, bad };
  }, [text, mode, bySku]);
  const apply = async () => {
    setBusy(true);
    try {
      const r = await applyPlan(plan, mode === 'sku' ? 'sku' : mode === 'count' ? 'count' : 'adjust', reason, note);
      if (r) report(r);
      refresh();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} wide title="Update by SKU" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!plan.length || bad.length > 0} onClick={apply}>Apply {plan.length || ''} change{plan.length === 1 ? '' : 's'}</Button></>}>
      <div className="space-y-3">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'count', label: 'On-hand count' }, { value: 'adjust', label: 'Add or remove' }, { value: 'sku', label: 'New SKU' }]} />
        <Field label="One line per product" hint={mode === 'sku' ? 'Current SKU, new SKU — e.g. RW-1B-22, RWF-1B-22' : mode === 'count' ? 'SKU, count — e.g. RW-1B-22, 48. Lines can be pasted straight from a spreadsheet.' : 'SKU, units to add (or −units to remove) — e.g. RW-1B-22, -2'}>
          <textarea className="field num min-h-[150px] font-mono text-[13px]" value={text} onChange={(e) => setText(e.target.value)} placeholder={mode === 'sku' ? 'RW-1B-22, RWF-1B-22' : 'RW-1B-22, 48\nRW-4-22, 30'} />
        </Field>
        {mode !== 'sku' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Reason"><select className="field" value={reason} onChange={(e) => setReason(e.target.value)}>{STOCK_REASONS.map((r) => <option key={r}>{r}</option>)}</select></Field>
            <Field label="Note (optional)"><input className="field" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
        )}
        {bad.length > 0 && <p className="text-[13px] text-rose">These lines need a {mode === 'sku' ? 'new SKU' : 'whole number'}: {bad.slice(0, 5).join(' · ')}</p>}
        {(plan.length > 0 || unknown.length > 0) && <PlanTable plan={plan} unknown={unknown} />}
      </div>
    </Modal>
  );
}

/** A CSV from this page, a Shopify products export or any sheet with SKU and quantity columns: preview, then apply. */
function SpreadsheetModal({ products, onClose }: { products: StockProductDTO[]; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const report = useApplyReport();
  const [rows, setRows] = useState<string[][] | null>(null);
  const [name, setName] = useState('');
  const [reason, setReason] = useState<string>('Stock count');
  const [busy, setBusy] = useState(false);
  const read = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.(csv|tsv|txt)$/i.test(f.name)) { toast('Choose a CSV file. In Numbers or Excel use File → Export To → CSV.', 'error'); return; }
    setName(f.name);
    setRows(parseCsv(await f.text()));
  };
  const result = useMemo(() => {
    if (!rows || rows.length < 2) return null;
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h === n || (n.endsWith('*') && h.startsWith(n.slice(0, -1)))));
    const cKey = col('key');
    const cSku = col('sku', 'variant sku');
    const cNewSku = col('new sku');
    const cQty = col('new count', 'new quantity*', 'variant inventory qty', 'quantity', 'qty', 'on hand', 'stock', 'count', 'inventory', 'available');
    const cName = col('product', 'name', 'title', 'item name');
    const cOpt = col('option1 value', 'variation name');
    const cHandle = col('handle');
    const cSupplier = col('supplier');
    const cCost = col('cost', 'cost per item');
    const cLead = col('lead time days');
    const cSafety = col('safety days');
    const cMoq = col('moq');
    const cCase = col('case size');
    const cStatus = col('status');
    if (cKey < 0 && cSku < 0 && cName < 0) return { error: 'No SKU, Product or Title column found in the first row.' };
    const byKey = new Map(products.map((p) => [p.key, p]));
    const bySku = new Map<string, StockProductDTO>();
    for (const p of products) for (const s of [p.squareSku, p.shopifySku]) if (s) bySku.set(norm(s), p);
    const byName = new Map(products.map((p) => [normName(p.label), p]));
    const titles = new Map<string, string>();
    const plan: Plan[] = [];
    const unknown: string[] = [];
    const seen = new Set<string>();
    for (const r of rows.slice(1)) {
      const get = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
      // Shopify exports name the product on its first row only.
      if (cHandle >= 0 && get(cName)) titles.set(get(cHandle), get(cName));
      const title = get(cName) || (cHandle >= 0 ? titles.get(get(cHandle)) ?? '' : '');
      const opt = get(cOpt);
      const label = [title, opt && opt !== 'Default Title' ? opt : ''].filter(Boolean).join(' ');
      const sku = get(cSku);
      if (!sku && !label && !get(cKey)) continue;
      if (cHandle >= 0 && !sku && !get(cQty)) continue; // an image row
      let p = (get(cKey) && byKey.get(get(cKey))) || (sku && bySku.get(norm(sku))) || undefined;
      let skuChange: string | undefined;
      if (!p && label) {
        p = byName.get(normName(label)) ?? products.find((x) => normName(x.label).includes(normName(label)) && normName(label).length > 6);
        if (p && sku && norm(sku) !== norm(p.sku)) skuChange = sku; // matched by name, the sheet has a new SKU
      }
      if (!p) { unknown.push(sku || label); continue; }
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      if (get(cKey) && sku && norm(sku) !== norm(p.sku)) skuChange = sku;
      if (get(cNewSku) && norm(get(cNewSku)) !== norm(p.sku)) skuChange = get(cNewSku);
      const x: Plan = { p, text: '' };
      const parts: string[] = [];
      if (skuChange) { x.sku = skuChange; parts.push(`SKU ${p.sku ?? '—'} → ${skuChange}`); }
      const qRaw = get(cQty);
      if (qRaw !== '') {
        const n = Number(qRaw);
        if (Number.isInteger(n) && n >= 0 && (n !== p.squareQty || n !== p.shopifyQty) && (p.squareQty != null || p.shopifyQty != null)) {
          x.quantity = n;
          parts.push(`Stock ${p.squareQty ?? '—'} / ${p.shopifyQty ?? '—'} → ${n}`);
        }
      }
      const s: Record<string, unknown> = {};
      const setIf = (i: number, k: string, v: unknown, cur: unknown, label2: string) => { if (i >= 0 && v !== cur) { s[k] = v; parts.push(`${label2} → ${v ?? '—'}`); } };
      if (cKey >= 0) {
        setIf(cSupplier, 'supplier', get(cSupplier) || null, p.supplier, 'Supplier');
        setIf(cCost, 'costCents', cents(get(cCost)), p.costCents, 'Cost (¢)');
        setIf(cLead, 'leadTimeDays', intOr(get(cLead)), p.leadTimeDays, 'Lead time');
        setIf(cSafety, 'safetyDays', intOr(get(cSafety)), p.safetyDays, 'Safety days');
        setIf(cMoq, 'moq', intOr(get(cMoq)), p.moq, 'MOQ');
        setIf(cCase, 'caseSize', intOr(get(cCase)) || null, p.caseSize, 'Case size');
        const st = (Object.entries(STATUS_LABEL).find(([, l]) => l.toLowerCase() === get(cStatus).toLowerCase())?.[0] ?? null) as StockProductStatus | null;
        if (cStatus >= 0 && st && st !== p.status) { s.status = st; parts.push(`Status → ${STATUS_LABEL[st]}`); }
      } else if (cCost >= 0 && cents(get(cCost)) != null && cents(get(cCost)) !== p.costCents) { s.costCents = cents(get(cCost)); parts.push(`Cost → $${get(cCost)}`); }
      if (Object.keys(s).length) x.settings = s;
      if (!parts.length) continue;
      x.text = parts.join(' · ');
      plan.push(x);
    }
    return { plan, unknown };
  }, [rows, products]);
  const apply = async () => {
    if (!result || !('plan' in result) || !result.plan) return;
    setBusy(true);
    try {
      const r = await applyPlan(result.plan, 'import', reason, `From ${name}`);
      if (r) report(r); else toast('Saved.');
      refresh();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const plan = result && 'plan' in result ? result.plan ?? [] : [];
  return (
    <Modal open onClose={onClose} wide title="Upload a spreadsheet" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!plan.length} onClick={apply}>Apply {plan.length || ''} change{plan.length === 1 ? '' : 's'}</Button></>}>
      <div className="space-y-3 text-[14px]">
        <p className="text-ink-soft">Use <b>Download spreadsheet</b> on this page, a Shopify <b>Products export</b>, or any CSV with a SKU and a quantity column (Product/Title is used to find a product whose SKU you changed). You see every change before anything is saved; stock and SKU changes go to Square and Shopify.</p>
        <input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => read(e.target.files?.[0])} />
        <Field label="Stock changes are logged as"><select className="field" value={reason} onChange={(e) => setReason(e.target.value)}>{STOCK_REASONS.map((r) => <option key={r}>{r}</option>)}</select></Field>
        {result && 'error' in result && <p className="text-rose">{result.error}</p>}
        {result && 'plan' in result && <PlanTable plan={plan} unknown={result.unknown ?? []} />}
      </div>
    </Modal>
  );
}

// ---------------- Stock: counts, adjustments, history ----------------
/** `store`: every product, or only those the salon (Square) or Addendum Hair (online) sells. */
export function StockView({ store = 'all' }: { store?: 'all' | 'salon' | 'hair' } = {}) {
  const N = useStoreNames();
  const { data, isLoading, error, refetch } = useProducts();
  const toast = useToast();
  const refresh = useRefresh();
  const report = useApplyReport();
  const [mode, setMode] = useState<'count' | 'adjust'>('count');
  const [q, setQ] = useState('');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<string>('Stock count');
  const [note, setNote] = useState('');
  const [fill, setFill] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => filterProducts(data?.products ?? [], q, 'active').filter((p) => (p.squareQty != null || p.shopifyQty != null)
    && (store === 'all' || (store === 'salon' ? !!p.squareVariationId : !!p.shopifyInventoryItemId || p.store2.length > 0))), [data, q, store]);
  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;
  const entered = Object.entries(vals).filter(([, v]) => v.trim() !== '');
  const save = async () => {
    const changes: StockChangeInput[] = [];
    for (const [key, v] of entered) {
      const n = Number(v);
      if (!Number.isInteger(n) || (mode === 'count' && n < 0)) { toast('Enter whole numbers.', 'error'); return; }
      changes.push(mode === 'count' ? { key, quantity: n } : { key, delta: n });
    }
    setBusy(true);
    try {
      report(await api.post<StockApplyResultDTO>('/inventory-sync/stock/apply', { kind: mode, reason, note: note || null, changes }));
      setVals({});
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-6">
      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Segmented value={mode} onChange={(m) => { setMode(m); setVals({}); setReason(m === 'count' ? 'Stock count' : 'Damaged'); }} options={[{ value: 'count', label: 'Enter counts' }, { value: 'adjust', label: 'Add or remove' }]} />
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-stone" />
            <input className="field pl-8 text-[16px] sm:text-[14px]" type="search" placeholder={SEARCH_HINT} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <input className="field num w-20" placeholder={mode === 'count' ? '0' : '+6'} value={fill} onChange={(e) => setFill(e.target.value)} />
          <Button size="sm" disabled={fill.trim() === ''} onClick={() => setVals((v) => ({ ...v, ...Object.fromEntries(shown.map((p) => [p.key, fill.trim()])) }))}>Fill all shown</Button>
        </div>
        <ul className="space-y-2 sm:hidden">
          {shown.slice(0, 200).map((p) => (
            <li key={p.key} className={cx('flex items-center gap-3 rounded-xl2 border bg-white p-3', vals[p.key]?.trim() ? 'border-amber/50' : 'border-line')}>
              <ProductThumb src={p.imageUrl} alt={p.label} />
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium leading-snug text-ink">{p.label}</p>
                <p className="truncate font-mono text-[12px] text-stone">{p.sku ?? 'No SKU'}{p.collections.length ? <span className="font-sans"> · {p.collections.slice(0, 2).join(' · ')}</span> : null}</p>
                <div className="mt-1"><StockCell p={p} store2={data.store2} /></div>
              </div>
              <input inputMode="numeric" className={cx('h-12 w-20 shrink-0 rounded-lg border border-line bg-white px-2 text-center text-[18px] num focus:border-plum focus:outline-none', vals[p.key]?.trim() && 'border-amber bg-amber-tint')}
                placeholder={mode === 'count' ? 'Count' : '+/−'} value={vals[p.key] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [p.key]: e.target.value }))} aria-label={`${mode === 'count' ? 'Count' : 'Change'} for ${p.label}`} />
            </li>
          ))}
          {!shown.length && <li className="panel"><EmptyState title="No products match">Try a colour, a collection, a size (18") or part of the SKU.</EmptyState></li>}
        </ul>
        <div className="hidden max-h-[480px] overflow-auto rounded-xl2 border border-line bg-white sm:block">
          <table className="w-full text-left text-[13px]">
            <thead className="sticky top-0 border-b border-line bg-mist text-[11px] uppercase tracking-wide text-stone"><tr><th className="px-3 py-2">Product</th><th className="px-2 py-2">SKU</th><th className="px-2 py-2">In stock</th><th className="w-28 px-2 py-2">{mode === 'count' ? 'Count' : '+ / −'}</th></tr></thead>
            <tbody className="divide-y divide-line">
              {shown.slice(0, 400).map((p) => (
                <tr key={p.key}>
                  <td className="px-3 py-1.5 text-ink"><span className="flex items-center gap-2.5"><ProductThumb src={p.imageUrl} alt={p.label} size="sm" /><span>{p.label}<Collections p={p} /></span></span></td>
                  <td className="px-2 py-1.5 font-mono text-ink-soft">{p.sku}</td>
                  <td className="px-2 py-1.5"><StockCell p={p} store2={data.store2} /></td>
                  <td className="px-2 py-1.5"><input inputMode="numeric" className={cx('w-full rounded-md border border-line bg-white px-2 py-1 num', vals[p.key]?.trim() && 'border-amber bg-amber-tint')} value={vals[p.key] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [p.key]: e.target.value }))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Reason" className="w-48"><select className="field" value={reason} onChange={(e) => setReason(e.target.value)}>{STOCK_REASONS.map((r) => <option key={r}>{r}</option>)}</select></Field>
          <Field label="Note (optional)" className="min-w-[200px] flex-1"><input className="field" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <Button variant="primary" loading={busy} disabled={!entered.length} onClick={save}>{mode === 'count' ? 'Save counts' : 'Save changes'}{entered.length ? ` (${entered.length})` : ''}</Button>
        </div>
        <p className="mt-1 text-[12px] text-stone">{mode === 'count' ? `A count sets ${N.square} and ${N.shopify} to that number.` : 'Each store moves by the amount (e.g. −2 for two damaged).'} Every change is logged below.</p>
      </section>
      <StockHistory />
    </div>
  );
}

const KIND_LABEL: Record<StockTxnDTO['kind'], string> = { count: 'Count', adjust: 'Adjusted', import: 'Spreadsheet / list', receive: 'Received', sku: 'SKU', sync: 'Sync' };

function StockHistory() {
  const N = useStoreNames();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['stock-history', q, kind],
    queryFn: () => api.get<{ entries: StockTxnDTO[] }>(`/inventory-sync/stock/history?${new URLSearchParams({ ...(q ? { q } : {}), ...(kind ? { kind } : {}) })}`).then((r) => r.entries),
  });
  const n = (v: number | null) => (v == null ? '—' : String(v));
  const download = () => downloadCsv('stock-history.csv', ['When', 'Product', 'SKU', 'Type', 'Reason', 'Note', `${N.square} before`, `${N.square} after`, `${N.shopify} before`, `${N.shopify} after`, 'Old SKU', 'New SKU', 'By', 'Reference'],
    (data ?? []).map((t) => [t.createdAt, t.label, t.sku, KIND_LABEL[t.kind], t.reason, t.note, t.squareBefore, t.squareAfter, t.shopifyBefore, t.shopifyAfter, t.oldSku, t.newSku, t.staffName ?? (t.kind === 'sync' ? 'Sync' : ''), t.reference]));
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="h-display mr-auto text-[22px]">Stock history</h2>
        <input className="field w-56" placeholder="Search product, SKU or reason" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="field w-auto" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All changes</option>{Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <Button size="sm" icon={<Download className="h-4 w-4" />} disabled={!data?.length} onClick={download}>Download</Button>
      </div>
      {isLoading ? <PageLoading /> : !data?.length ? <p className="text-[14px] text-stone">No stock changes yet.</p> : (
        <div className="overflow-x-auto rounded-xl2 border border-line bg-white">
          <table className="w-full min-w-[860px] text-left text-[13px]">
            <thead className="border-b border-line bg-mist/50 text-[11px] uppercase tracking-wide text-stone"><tr><th className="px-3 py-2">When</th><th className="px-2 py-2">Product</th><th className="px-2 py-2">Change</th><th className="px-2 py-2 text-right">{N.square}</th><th className="px-2 py-2 text-right">{N.shopify}</th><th className="px-2 py-2">By</th></tr></thead>
            <tbody className="divide-y divide-line">
              {data.map((t) => (
                <tr key={t.id}>
                  <td className="whitespace-nowrap px-3 py-1.5 text-ink-soft">{dateTime(t.createdAt)}</td>
                  <td className="px-2 py-1.5 text-ink">{t.label}<span className="block text-[11px] text-stone">{t.sku}</span></td>
                  <td className="px-2 py-1.5"><Badge tone={t.kind === 'sync' ? 'neutral' : t.kind === 'receive' ? 'sage' : 'plum'}>{KIND_LABEL[t.kind]}</Badge> <span className="text-ink-soft">{t.kind === 'sku' ? `${t.oldSku ?? '—'} → ${t.newSku}` : t.reason}</span>{t.note && <span className="block text-[11px] text-stone">{t.note}</span>}{t.reference && <span className="block text-[11px] text-stone">{t.reference.startsWith('sync:') ? 'Inventory sync' : t.reference}</span>}</td>
                  <td className="num px-2 py-1.5 text-right">{t.kind === 'sku' ? '' : `${n(t.squareBefore)} → ${n(t.squareAfter)}`}</td>
                  <td className="num px-2 py-1.5 text-right">{t.kind === 'sku' ? '' : `${n(t.shopifyBefore)} → ${n(t.shopifyAfter)}`}</td>
                  <td className="px-2 py-1.5 text-ink-soft">{t.staffName ?? (t.kind === 'sync' ? 'Sync' : '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------- Reorder: forecasts and recommendations ----------------
const F_STATUS: Record<StockForecastDTO['status'], { label: string; tone: 'rose' | 'amber' | 'plum' | 'sage' | 'neutral' }> = {
  out: { label: 'Out of stock', tone: 'rose' }, order_now: { label: 'Order now', tone: 'rose' }, soon: { label: 'Reorder soon', tone: 'amber' },
  watch: { label: 'Watch', tone: 'plum' }, healthy: { label: 'Healthy', tone: 'sage' }, no_sales: { label: 'No recent sales', tone: 'neutral' }, discontinued: { label: 'Discontinued', tone: 'neutral' },
};

type SuggestedGroup = { collection: string; suppliers: string[]; lines: { productKey: string; label: string; sku: string | null; status: StockForecastDTO['status']; stock: number; quantity: number; costCents: number | null }[] };

/**
 * Draft suggested orders: a preview of the draft per collection — products, suggested amounts and suppliers. Untick
 * products or change amounts, then Create (earlier suggested drafts for this store are replaced; nothing is ordered).
 */
function SuggestedOrders({ store, onClose, onMade }: { store: 'all' | 'salon' | 'shopify'; onClose: () => void; onMade: () => void }) {
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['suggested-orders', store], gcTime: 0, queryFn: () => api.get<{ groups: SuggestedGroup[] }>(`/inventory-sync/stock/purchase-orders/suggest?store=${store}`).then((r) => r.groups) });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const q = (l: SuggestedGroup['lines'][number]) => (off.has(l.productKey) ? 0 : Math.max(0, Math.round(Number(qty[l.productKey] ?? l.quantity) || 0)));
  const groups = data ?? [];
  const kept = groups.filter((g) => g.lines.some((l) => q(l) > 0));
  const items = kept.reduce((n, g) => n + g.lines.filter((l) => q(l) > 0).length, 0);
  const total = groups.reduce((n, g) => n + g.lines.reduce((m, l) => m + (l.costCents ?? 0) * q(l), 0), 0);
  const toggle = (k: string) => setOff((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ orders: PurchaseOrderDTO[] }>('/inventory-sync/stock/purchase-orders/suggest', {
        store, groups: groups.map((g) => ({ collection: g.collection, lines: g.lines.map((l) => ({ productKey: l.productKey, quantity: q(l) })) })),
      });
      toast(`${r.orders.length} suggested draft${r.orders.length === 1 ? '' : 's'} made — review them in Purchase orders.`);
      onMade();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open wide onClose={onClose} title="Draft suggested orders" footer={<>
      <span className="mr-auto text-[13px] text-stone">{kept.length ? `${kept.length} draft${kept.length === 1 ? '' : 's'} · ${items} product${items === 1 ? '' : 's'}${total ? ` · about $${Math.round(total / 100).toLocaleString()}` : ''}` : 'Nothing selected'}</span>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={busy} disabled={!kept.length} onClick={create}>Create {kept.length || ''} draft{kept.length === 1 ? '' : 's'}</Button>
    </>}>
      {isLoading ? <PageLoading /> : error || !data ? <ErrorNote error={error} onRetry={refetch} /> : !groups.length ? (
        <EmptyState title="Nothing needs ordering right now">Nothing is out of stock, due to order now, or reorder soon.</EmptyState>
      ) : (
        <div className="space-y-4 text-[13px]">
          <p className="text-ink-soft">One draft per collection, at the suggested amounts. Untick anything you don’t want or change an amount. Earlier suggested drafts are replaced; nothing is ordered until you mark a draft ordered.</p>
          {groups.map((g) => (
            <section key={g.collection} className="rounded-xl2 border border-line">
              <header className="flex flex-wrap items-baseline gap-x-2 border-b border-line bg-mist/40 px-3 py-2">
                <span className="font-medium text-ink">Suggested · {g.collection}</span>
                <span className="text-stone">{g.suppliers.length ? g.suppliers.join(' + ') : 'No supplier set'}</span>
              </header>
              <ul className="divide-y divide-line">
                {g.lines.map((l) => (
                  <li key={l.productKey} className={cx('flex items-center gap-3 px-3 py-1.5', off.has(l.productKey) && 'opacity-50')}>
                    <input type="checkbox" className="h-4 w-4 accent-plum" checked={!off.has(l.productKey)} onChange={() => toggle(l.productKey)} aria-label={`Include ${l.label}`} />
                    <span className="min-w-0 flex-1"><span className="block truncate text-ink">{l.label}</span><span className="font-mono text-[11px] text-stone">{l.sku}</span></span>
                    <Badge tone={F_STATUS[l.status].tone}>{F_STATUS[l.status].label}</Badge>
                    <span className="num w-16 text-right text-stone">{l.stock} in stock</span>
                    <input inputMode="numeric" disabled={off.has(l.productKey)} className="w-16 rounded-md border border-line bg-white px-2 py-1 text-right num" value={qty[l.productKey] ?? String(l.quantity)} onChange={(e) => setQty((x) => ({ ...x, [l.productKey]: e.target.value }))} aria-label={`Amount of ${l.label}`} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** A number of days with its label and an explanation (Forecast settings). */
function DaysField({ label, hint, value, onChange, unit = 'days' }: { label: string; hint?: string; value: number; onChange: (v: number) => void; unit?: string }) {
  return (
    <Field label={label} hint={hint}>
      <span className="relative block"><input className="field num pr-12" inputMode="numeric" value={value} onChange={(e) => onChange(Number(e.target.value.replace(/\D/g, '')) || 0)} />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-stone">{unit}</span></span>
    </Field>
  );
}

/** `store`: all products, or only those the salon (Square) or Addendum Hair (online) sells. */
export function ReorderView({ onOrders, store = 'all', initialFilter = 'reorder' }: { onOrders: () => void; store?: 'all' | 'salon' | 'hair'; initialFilter?: 'reorder' | 'alerts' | 'all' }) {
  const toast = useToast();
  const fallbackSupplier = useDefaultSupplier();
  const refresh = useRefresh();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['stock-forecast'], queryFn: () => api.get<StockForecastResponse>('/inventory-sync/stock/forecast') });
  const [filter, setFilter] = useState<'reorder' | 'alerts' | 'all'>(initialFilter);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [defaults, setDefaults] = useState<StockForecastResponse['settings'] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [showMoq, setShowMoq] = useState(() => { try { return localStorage.getItem('reorder-moq') !== '0'; } catch { return true; } });
  // View by: one list of products, or grouped by collection or supplier (remembered on this device).
  const [by, setByState] = useState<'product' | 'collection' | 'supplier'>(() => { try { const v = localStorage.getItem('reorder-by'); return v === 'collection' || v === 'supplier' ? v : 'product'; } catch { return 'product'; } });
  const setBy = (v: typeof by) => { setByState(v); try { localStorage.setItem('reorder-by', v); } catch { /* private window */ } };
  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;
  const inStore = data.items.filter((i) => store === 'all' || (store === 'salon' ? i.stores.salon : i.stores.online));
  // Alerts: selling products that are out of stock, or will run out before a new order could arrive.
  const isOut = (i: StockForecastDTO) => i.status !== 'discontinued' && i.stock <= 0 && i.ratePerDay > 0;
  const outN = inStore.filter(isOut).length;
  const riskN = inStore.filter((i) => i.stockoutRisk).length;
  const items = inStore.filter((i) => filter === 'all' || (filter === 'alerts' ? isOut(i) || i.stockoutRisk : ['out', 'order_now', 'soon'].includes(i.status)));
  const counts = { out: 0, order_now: 0, soon: 0, watch: 0 } as Record<string, number>;
  for (const i of inStore) counts[i.status] = (counts[i.status] ?? 0) + 1;
  // A product in several collections is shown under its most specific one (the one with the fewest products).
  const collSize = new Map<string, number>();
  for (const i of inStore) for (const c of i.collections) collSize.set(c, (collSize.get(c) ?? 0) + 1);
  const groupOf = (i: StockForecastDTO) => by === 'supplier' ? i.supplier ?? fallbackSupplier ?? 'No supplier'
    : [...i.collections].sort((a, b) => (collSize.get(a) ?? 0) - (collSize.get(b) ?? 0) || a.localeCompare(b))[0] ?? 'No collection';
  const groups: [string | null, StockForecastDTO[]][] = by === 'product' ? [[null, items]]
    : [...items.reduce((m, i) => m.set(groupOf(i), [...(m.get(groupOf(i)) ?? []), i]), new Map<string, StockForecastDTO[]>())]
      .sort(([a], [b]) => (a.startsWith('No ') ? 1 : 0) - (b.startsWith('No ') ? 1 : 0) || a.localeCompare(b));
  const pickGroup = (list: StockForecastDTO[]) => setPicked((s) => { const n = new Set(s); const all = list.every((i) => n.has(i.key)); for (const i of list) { if (all) n.delete(i.key); else n.add(i.key); } return n; });
  const groupHead = (name: string, list: StockForecastDTO[]) => (
    <span className="flex items-center gap-2">
      <input type="checkbox" className="h-4 w-4 accent-plum" checked={list.every((i) => picked.has(i.key))} onChange={() => pickGroup(list)} aria-label={`Select all in ${name}`} />
      <span className="font-medium text-ink">{name}</span><span className="text-stone">{list.length}</span>
    </span>
  );
  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const qOf = (i: StockForecastDTO) => Number(qty[i.key] ?? i.suggestedQty);
  const createPOs = async () => {
    const lines = data.items.filter((i) => picked.has(i.key) && qOf(i) > 0).map((i) => ({ productKey: i.key, quantity: Math.round(qOf(i)) }));
    if (!lines.length) { toast('Pick products with a quantity to order.', 'error'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ orders: PurchaseOrderDTO[] }>('/inventory-sync/stock/purchase-orders', { lines });
      toast(`Made ${r.orders.length} draft purchase order${r.orders.length === 1 ? '' : 's'} (one per supplier).`);
      setPicked(new Set());
      refresh();
      onOrders();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const refreshSales = async () => {
    setBusy(true);
    try { await api.post('/inventory-sync/stock/sales/refresh'); refetch(); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const saveDefaults = async () => {
    if (!defaults) return;
    try { await api.put('/inventory-sync/stock/forecast/settings', defaults); setDefaults(null); refetch(); toast('Saved.'); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const d = defaults ?? data.settings;
  return (
    <div>
      {(outN > 0 || riskN > 0) && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl2 border border-rose/30 bg-rose/10 px-4 py-3 text-[14px] text-ink">
          <AlertTriangle className="h-4 w-4 shrink-0 text-rose" />
          <span>{[outN && <><b className="font-medium">{outN} selling product{outN === 1 ? '' : 's'}</b> out of stock</>, riskN && <><b className="font-medium">{riskN}</b> at risk of running out before a new order arrives</>].filter(Boolean).map((x, k) => <span key={k}>{k ? ' · ' : ''}{x}</span>)}</span>
          {filter !== 'alerts' && <button type="button" className="ml-auto text-[13px] font-medium text-plum hover:underline" onClick={() => setFilter('alerts')}>Show them</button>}
        </div>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([['Out of stock', counts.out, 'text-rose'], ['Order now', counts.order_now, 'text-rose'], ['Reorder soon', counts.soon, 'text-amber'], ['Watch', counts.watch, '']] as const).map(([l, n, c]) => (
          <div key={l} className="rounded-xl2 border border-line bg-white px-3 py-2"><p className="text-[12px] text-stone">{l}</p><p className={cx('num font-display text-[24px] leading-tight', n > 0 && c)}>{n}</p></div>
        ))}
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'reorder', label: 'To reorder' }, { value: 'alerts', label: `Alerts${outN + riskN ? ` (${outN + riskN})` : ''}` }, { value: 'all', label: 'All products' }]} />
        <select className="field h-9 w-auto py-1 text-sm" value={by} onChange={(e) => setBy(e.target.value as typeof by)} aria-label="View by">
          <option value="product">View by product</option><option value="collection">View by collection</option><option value="supplier">View by supplier</option>
        </select>
        <span className="ml-auto flex items-center gap-2">
          <Toggle checked={showMoq} onChange={(v) => { setShowMoq(v); try { localStorage.setItem('reorder-moq', v ? '1' : '0'); } catch { /* private window */ } }} label="MOQ timing" />
          <Button size="sm" icon={<ListPlus className="h-4 w-4" />} onClick={() => setSuggesting(true)}>Draft suggested orders</Button>
          <Button size="sm" icon={<Settings2 className="h-4 w-4" />} onClick={() => setDefaults(data.settings)}>Forecast settings</Button>
        </span>
      </div>
      <p className="mb-3 text-[12px] text-stone">
        Sales from {[data.salesFrom.square && 'Square', data.salesFrom.shopify && 'Shopify'].filter(Boolean).join(' and ') || 'nowhere yet'}
        {data.salesFrom.shopifyUpdatedAt ? ` · Shopify updated ${relative(data.salesFrom.shopifyUpdatedAt)}` : ''}
        {data.salesFrom.shopifyNote && <span className="text-amber"> · {data.salesFrom.shopifyNote}</span>}
        {' · '}<button type="button" className="text-plum hover:underline" onClick={refreshSales} disabled={busy}>Update now</button>
      </p>
      {suggesting && <SuggestedOrders store={store === 'hair' ? 'shopify' : store} onClose={() => setSuggesting(false)} onMade={() => { setSuggesting(false); refresh(); onOrders(); }} />}
      {defaults && (
        <Modal open onClose={() => setDefaults(null)} title="Forecast settings"
          footer={<><Button variant="ghost" onClick={() => setDefaults(null)}>Cancel</Button><Button variant="primary" onClick={saveDefaults}>Save</Button></>}>
          <div className="space-y-5 text-[14px]">
            <section>
              <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone">When to order</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <DaysField label="Lead time" hint="For products with no lead time of their own or from their supplier." value={d.leadTimeDays} onChange={(v) => setDefaults({ ...d, leadTimeDays: v })} />
                <DaysField label="Safety stock" hint="Extra days of stock kept as a cushion." value={d.safetyDays} onChange={(v) => setDefaults({ ...d, safetyDays: v })} />
                <DaysField label="Order enough for" hint="Days of sales each order should cover once it arrives." value={d.coverageDays} onChange={(v) => setDefaults({ ...d, coverageDays: v })} />
              </div>
            </section>
            <section>
              <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone">Status windows</h3>
              <p className="mb-2 text-[13px] text-ink-soft">Days until a product’s order-by date — worked out from how fast it sells, so fast sellers show up sooner.</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <DaysField label="Reorder soon within" value={d.soonDays} onChange={(v) => setDefaults({ ...d, soonDays: v })} />
                <DaysField label="Watch within" hint="After that it’s Healthy." value={d.watchDays} onChange={(v) => setDefaults({ ...d, watchDays: v })} />
              </div>
            </section>
            <section>
              <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone">Minimum orders</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Discontinued collections" hint="Never reordered or alerted. Separate with commas; matches the collection or product name." className="sm:col-span-3">
                  <input className="field" defaultValue={d.discontinuedCollections.join(', ')} placeholder="e.g. Classic"
                    onChange={(e) => setDefaults({ ...d, discontinuedCollections: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
                </Field>
                <DaysField label="Default minimum order" unit="units" hint="For products with no MOQ of their own or from their supplier. 0 = none." value={d.defaultMoq} onChange={(v) => setDefaults({ ...d, defaultMoq: v })} />
                <DaysField label="Slow to use after" hint="Flag a minimum order that takes longer than this to sell." value={d.slowToUseDays} onChange={(v) => setDefaults({ ...d, slowToUseDays: v })} />
              </div>
            </section>
          </div>
        </Modal>
      )}
      {picked.size > 0 && (
        <div className="sticky top-0 z-10 mb-3 flex items-center gap-2 rounded-xl2 border border-line bg-white px-4 py-2 text-[13px] shadow-sm">
          <span className="text-ink">{picked.size} selected</span>
          <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} loading={busy} onClick={createPOs} className="ml-auto">Create purchase orders</Button>
        </div>
      )}
      {/* Phones: a card per product — status, stock, when to order, and the amount to order. */}
      <ul className="space-y-2 sm:hidden">
        {groups.map(([name, list]) => <Fragment key={name ?? 'all'}>
        {name && <li className="px-1 pt-2 text-[14px]">{groupHead(name, list)}</li>}
        {list.map((i) => (
          <li key={i.key} className={cx('rounded-xl2 border bg-white p-3', picked.has(i.key) ? 'border-plum/40' : 'border-line')}>
            <div className="flex items-start gap-3">
              <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-plum" checked={picked.has(i.key)} onChange={() => toggle(i.key)} aria-label={`Select ${i.label}`} />
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium leading-snug text-ink">{i.label}</p>
                <p className="text-[12px] text-stone"><span className="font-mono">{i.sku}</span>{(i.supplier ?? fallbackSupplier) ? ` · ${i.supplier ?? fallbackSupplier}` : ''}</p>
              </div>
              <span className="flex flex-col items-end gap-1"><Badge tone={F_STATUS[i.status].tone}>{F_STATUS[i.status].label}</Badge>{i.stockoutRisk && <Badge tone="rose">Stock-out risk</Badge>}</span>
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 text-[13px]">
              <div><dt className="text-[11px] text-stone">In stock</dt><dd className="num">{i.stock}{i.incoming ? <span className="text-stone"> +{i.incoming}</span> : ''}</dd></div>
              <div><dt className="text-[11px] text-stone">Days left</dt><dd className="num">{i.daysOfStock ?? '—'}</dd></div>
              <div><dt className="text-[11px] text-stone">Order by</dt><dd>{i.orderBy ? labelOfKey(i.orderBy, { month: 'short', day: 'numeric' }) : '—'}</dd></div>
            </dl>
            <div className="mt-2 flex items-center gap-2">
              <label className="flex items-center gap-2 text-[13px] text-stone">Order
                <input inputMode="numeric" className="h-11 w-20 rounded-lg border border-line bg-white px-2 text-center text-[16px] num focus:border-plum focus:outline-none" value={qty[i.key] ?? (i.suggestedQty || '')} onChange={(e) => setQty((q) => ({ ...q, [i.key]: e.target.value }))} /></label>
              <button type="button" className="ml-auto text-[13px] text-plum" onClick={() => setOpen(open === i.key ? null : i.key)}>{open === i.key ? 'Hide why' : 'Why?'}</button>
            </div>
            {open === i.key && <ul className="mt-2 list-disc space-y-0.5 rounded-lg bg-mist/40 py-2 pl-6 pr-2 text-[12px] text-ink-soft">{i.why.map((w) => <li key={w}>{w}</li>)}</ul>}
          </li>
        ))}
        </Fragment>)}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl2 border border-line bg-white sm:block">
        <table className="w-full min-w-[980px] text-left text-[13px]">
          <thead className="border-b border-line bg-mist/50 text-[11px] uppercase tracking-wide text-stone">
            <tr><th className="w-8 px-3 py-2" /><th className="px-2 py-2">Product</th><th className="px-2 py-2">Status</th><th className="px-2 py-2 text-right">Stock</th><th className="px-2 py-2 text-right">On order</th><th className="px-2 py-2 text-right">Per day</th><th className="px-2 py-2 text-right">Days left</th><th className="px-2 py-2">Order by</th><th className="w-24 px-2 py-2">Order qty</th>{showMoq && <><th className="px-2 py-2 text-right">MOQ</th><th className="px-2 py-2">MOQ arrives</th><th className="px-2 py-2 text-right">MOQ lasts</th></>}<th className="px-2 py-2">Supplier</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {groups.map(([name, list]) => <Fragment key={name ?? 'all'}>
            {name && <tr className="bg-mist/40"><td colSpan={showMoq ? 13 : 10} className="px-3 py-2 text-[13px]">{groupHead(name, list)}</td></tr>}
            {list.map((i) => (
              <Fragment key={i.key}>
                <tr>
                  <td className="px-3 py-1.5"><input type="checkbox" checked={picked.has(i.key)} onChange={() => toggle(i.key)} aria-label={`Select ${i.label}`} /></td>
                  <td className="px-2 py-1.5"><button type="button" className="flex items-start gap-1 text-left text-ink" onClick={() => setOpen(open === i.key ? null : i.key)}>{open === i.key ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />}<span>{i.label}<span className="block text-[11px] text-stone">{i.sku}</span></span></button></td>
                  <td className="px-2 py-1.5"><Badge tone={F_STATUS[i.status].tone}>{F_STATUS[i.status].label}</Badge>{i.stockoutRisk && <span className="mt-1 block"><Badge tone="rose">Stock-out risk</Badge></span>}</td>
                  <td className="num px-2 py-1.5 text-right">{i.stock}</td>
                  <td className="num px-2 py-1.5 text-right">{i.incoming || ''}</td>
                  <td className="num px-2 py-1.5 text-right">{i.ratePerDay ? i.ratePerDay.toFixed(2) : '—'}</td>
                  <td className="num px-2 py-1.5 text-right">{i.daysOfStock ?? '—'}</td>
                  <td className="px-2 py-1.5">{i.orderBy ? labelOfKey(i.orderBy, { month: 'short', day: 'numeric' }) : '—'}</td>
                  <td className="px-2 py-1.5"><input inputMode="numeric" className="w-full rounded-md border border-line bg-white px-2 py-1 num" value={qty[i.key] ?? (i.suggestedQty || '')} onChange={(e) => setQty((q) => ({ ...q, [i.key]: e.target.value }))} /></td>
                  {showMoq && <>
                    <td className="num px-2 py-1.5 text-right">{i.moq ? <>{i.moq}{i.moqCostCents != null && <span className="block text-[11px] text-stone">${(i.moqCostCents / 100).toFixed(0)}</span>}</> : '—'}</td>
                    <td className="px-2 py-1.5">{i.moqArrivesOn ? <>{labelOfKey(i.moqArrivesOn, { month: 'short', day: 'numeric' })}<span className="block text-[11px] text-stone">{i.leadTimeDays} days</span></> : '—'}</td>
                    <td className="num px-2 py-1.5 text-right">{i.moqLastsDays != null ? <span className={cx(i.slowToUse && 'text-amber')} title={i.slowToUse ? 'Slow to use: the minimum order ties up cash' : undefined}>{i.moqLastsDays} days{i.slowToUse && <span className="block text-[11px]">Slow to use</span>}</span> : '—'}</td>
                  </>}
                  <td className="px-2 py-1.5 text-ink-soft">{i.supplier ?? fallbackSupplier ?? '—'}</td>
                </tr>
                {open === i.key && <tr><td /><td colSpan={showMoq ? 12 : 9} className="bg-mist/30 px-2 py-2 text-[12px] text-ink-soft"><ul className="list-disc space-y-0.5 pl-4">{i.why.map((w) => <li key={w}>{w}</li>)}</ul></td></tr>}
              </Fragment>
            ))}
            </Fragment>)}
          </tbody>
        </table>
        {!items.length && <EmptyState title={filter === 'reorder' ? 'Nothing needs reordering right now' : filter === 'alerts' ? 'No stock alerts' : 'No products'} />}
      </div>
      <p className="mt-2 text-[12px] text-stone">The sales rate blends the last 7 days (20%), 30 days (50%) and 90 days (30%). Ordered and shipped purchase orders count as incoming stock. Suggested amounts round up to practical numbers (7 → 10, 23 → 25), then to the minimum order and full cases. Lead time includes the supplier’s shipping days. Set each product’s supplier, cost, lead time, MOQ and case size on Products.</p>
    </div>
  );
}

// ---------------- Purchase orders ----------------
const PO_STATUS: Record<PurchaseOrderDTO['status'], { label: string; tone: 'neutral' | 'plum' | 'amber' | 'sage' | 'rose' }> = {
  draft: { label: 'Draft', tone: 'neutral' }, ordered: { label: 'Ordered', tone: 'plum' }, shipped: { label: 'Shipped', tone: 'amber' }, received: { label: 'Received', tone: 'sage' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** Purchase orders for one store: the salon (Square) or online (Shopify). Receiving adds stock to that store. */
/**
 * Move a purchase order to the other store (made in the wrong one). An open order receives into the new store from
 * now on; units already received can be moved too — taken out of the old store and added to the new one.
 */
function MovePoModal({ po, onClose }: { po: PurchaseOrderDTO; onClose: () => void }) {
  const N = useStoreNames();
  const toast = useToast();
  const refresh = useRefresh();
  const to = po.store === 'shopify' ? 'salon' : 'shopify';
  const received = po.lines.reduce((a, l) => a + l.received, 0);
  const [moveStock, setMoveStock] = useState(received > 0);
  const [busy, setBusy] = useState(false);
  const from = po.store === 'shopify' ? `Addendum Hair (${N.shopify})` : `Addendum Salon (${N.square})`;
  const target = to === 'shopify' ? `Addendum Hair (${N.shopify})` : `Addendum Salon (${N.square})`;
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ movedUnits: number; notMoved: string[] }>(`/inventory-sync/stock/purchase-orders/${po.id}/move`, { store: to, moveStock: received > 0 && moveStock });
      refresh();
      toast(`Moved to ${target}${r.movedUnits ? ` · ${r.movedUnits} received unit${r.movedUnits === 1 ? '' : 's'} moved` : ''}`);
      if (r.notMoved.length) toast(`Stock not moved for ${r.notMoved.length} item${r.notMoved.length === 1 ? '' : 's'} (not in ${target} yet): ${r.notMoved.slice(0, 3).join(', ')}${r.notMoved.length > 3 ? '…' : ''}`, 'error');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Move ${po.name ?? `PO #${po.number}`}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={go}>Move to {to === 'shopify' ? 'Addendum Hair' : 'Addendum Salon'}</Button></>}>
      <p className="text-[14px] text-ink-soft">From <b className="font-medium text-ink">{from}</b> to <b className="font-medium text-ink">{target}</b>. The order keeps its number, items, lots and notes.</p>
      {received > 0 ? (
        <div className="mt-4 space-y-2">
          <p className="text-[14px] text-ink-soft">{received} unit{received === 1 ? ' was' : 's were'} already received into {po.store === 'shopify' ? N.shopify : N.square}.</p>
          <label className="flex items-start gap-2 text-[14px] text-ink"><input type="radio" className="mt-1 accent-plum" checked={moveStock} onChange={() => setMoveStock(true)} />
            <span>Move the stock too<span className="block text-[13px] text-stone">Takes {received} out of {po.store === 'shopify' ? N.shopify : N.square} and adds them to {to === 'shopify' ? N.shopify : N.square}. Items not sold there yet are left where they are.</span></span></label>
          <label className="flex items-start gap-2 text-[14px] text-ink"><input type="radio" className="mt-1 accent-plum" checked={!moveStock} onChange={() => setMoveStock(false)} />
            <span>Only move the order<span className="block text-[13px] text-stone">Stock stays as it is (e.g. shared stock the sync already carried across).</span></span></label>
        </div>
      ) : <p className="mt-3 text-[13px] text-stone">Nothing has been received yet, so no stock changes; receiving will add to {to === 'shopify' ? N.shopify : N.square}.</p>}
    </Modal>
  );
}

export function PurchaseOrdersView({ store = 'salon' }: { store?: 'salon' | 'shopify' }) {
  const N = useStoreNames();
  const toast = useToast();
  const refresh = useRefresh();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['stock-pos'], queryFn: () => api.get<{ orders: PurchaseOrderDTO[] }>('/inventory-sync/stock/purchase-orders').then((r) => r.orders) });
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [receiving, setReceiving] = useState<PurchaseOrderDTO | null>(null);
  const [creating, setCreating] = useState(false);
  // The order being edited (quantities, costs, adding and removing items).
  const [editing, setEditing] = useState<string | null>(null);
  // Moving an order made in the wrong store.
  const [moving, setMoving] = useState<PurchaseOrderDTO | null>(null);
  const { data: suppliers } = useSuppliers();
  const fallbackSupplier = suppliers?.find((s) => s.isDefault)?.name ?? null;
  const patchLine = async (p: PurchaseOrderDTO, lineId: string, body: object) => {
    try { await api.patch(`/inventory-sync/stock/purchase-orders/${p.id}/lines/${lineId}`, body); refresh(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;
  const list = data.filter((p) => p.store === store && (show === 'all' || !['received', 'cancelled'].includes(p.status)));
  const patch = async (p: PurchaseOrderDTO, body: object) => {
    try { await api.patch(`/inventory-sync/stock/purchase-orders/${p.id}`, body); refresh(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const del = async (p: PurchaseOrderDTO) => {
    if (!window.confirm(`Delete draft PO #${p.number}?`)) return;
    try { await api.del(`/inventory-sync/stock/purchase-orders/${p.id}`); refresh(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented value={show} onChange={setShow} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]} />
        <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} className="ml-auto" onClick={() => setCreating(true)}>New purchase order</Button>
      </div>
      <p className="mb-3 text-[13px] text-stone">Orders for {store === 'salon' ? `the salon (${N.square})` : `online (${N.shopify})`}. Receiving adds the stock to {store === 'salon' ? N.square : N.shopify}; for products whose stock is shared, the next sync carries it across.</p>
      {!list.length && <EmptyState title="No purchase orders" >Make them from Inventory → To order, or with New purchase order.</EmptyState>}
      <div className="space-y-3">
        {list.map((p) => {
          const remaining = p.lines.reduce((a, l) => a + Math.max(0, l.quantity - l.received), 0);
          return (
            <section key={p.id} className="rounded-xl2 border border-line bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <input key={`${p.id}-${p.name}`} className="min-w-0 max-w-[16rem] rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[16px] font-medium text-ink hover:border-line focus:border-plum focus:bg-white focus:outline-none"
                  defaultValue={p.name ?? ''} placeholder={`PO #${p.number}`} maxLength={80} aria-label="Order name"
                  onBlur={(e) => { const v = e.target.value.trim(); if (v !== (p.name ?? '')) patch(p, { name: v || null }); }} />
                {p.name && <span className="text-[12px] text-stone">PO #{p.number}</span>}
                <Badge tone={PO_STATUS[p.status].tone}>{PO_STATUS[p.status].label}</Badge>
                <span className="text-[13px] text-ink-soft">{p.supplier ?? fallbackSupplier ?? 'Supplier not set'} · {p.lines.length} item{p.lines.length === 1 ? '' : 's'}{p.totalCents ? ` · $${(p.totalCents / 100).toFixed(2)}` : ''} · made {dateShort(p.createdAt)}{p.createdByName ? ` by ${p.createdByName}` : ''}</span>
                <span className="ml-auto flex flex-wrap gap-1.5">
                  <Button size="sm" variant={editing === p.id ? 'primary' : 'ghost'} icon={editing === p.id ? undefined : <Pencil className="h-4 w-4" />} onClick={() => setEditing(editing === p.id ? null : p.id)}>{editing === p.id ? 'Done' : ['received', 'cancelled'].includes(p.status) ? 'Edit lots' : 'Edit'}</Button>
                  {p.status === 'draft' && <Button size="sm" variant="primary" onClick={() => patch(p, { status: 'ordered' })}>Mark ordered</Button>}
                  {p.status === 'ordered' && <Button size="sm" onClick={() => patch(p, { status: 'shipped' })}>Mark shipped</Button>}
                  {(p.status === 'ordered' || p.status === 'shipped') && <Button size="sm" variant="primary" icon={<PackageCheck className="h-4 w-4" />} onClick={() => setReceiving(p)}>Receive</Button>}
                  <Button size="sm" variant="ghost" icon={<ArrowLeftRight className="h-4 w-4" />} onClick={() => setMoving(p)}>Move to {store === 'salon' ? 'Addendum Hair' : 'Addendum Salon'}</Button>
                  {p.status === 'draft' && <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => del(p)} aria-label="Delete draft" />}
                  {(p.status === 'ordered' || p.status === 'shipped') && <Button size="sm" variant="ghost" onClick={() => window.confirm(`Cancel PO #${p.number}?`) && patch(p, { status: 'cancelled' })}>Cancel</Button>}
                </span>
              </div>
              {/* The order note sits at the top. */}
              <textarea key={`${p.id}-${p.note}`} className="mt-2 min-h-[34px] w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-[13px] text-ink placeholder:text-stone-light" rows={1} maxLength={1000}
                defaultValue={p.note ?? ''} placeholder="Order note — delivery, invoice…" aria-label="Order note"
                onBlur={(e) => { const v = e.target.value.trim(); if (v !== (p.note ?? '')) patch(p, { note: v || null }); }} />
              {!['received', 'cancelled'].includes(p.status) && (
                <div className="mt-2 flex flex-wrap items-center gap-3 text-[13px] text-ink-soft">
                  <label className="flex items-center gap-1.5">Supplier
                    <select className="field h-9 w-auto py-1" value={p.supplier ?? ''} onChange={(e) => patch(p, { supplier: e.target.value || null })}>
                      <option value="">{fallbackSupplier ? `${fallbackSupplier} (default)` : 'Choose…'}</option>
                      {(suppliers ?? []).map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
                      {p.supplier && !(suppliers ?? []).some((x) => x.name === p.supplier) && <option value={p.supplier}>{p.supplier}</option>}
                    </select></label>
                  <label className="flex items-center gap-1.5" title="When the whole order should be here (the last item to arrive)">Expected <input type="date" className="field w-auto" defaultValue={p.expectedOn ?? ''} onChange={(e) => patch(p, { expectedOn: e.target.value || null })} /></label>
                  {remaining > 0 && p.status !== 'draft' && <span>{remaining} still to arrive</span>}
                </div>
              )}
              {/* One lot number for the order (usually the same for every item) — editable at any stage. */}
              <label className="mt-2 flex items-center gap-1.5 text-[13px] text-ink-soft">Lot number
                <input key={p.lotNumber ?? ''} className="field h-9 w-40 py-1 font-mono text-[13px]" maxLength={40} defaultValue={p.lotNumber ?? ''} placeholder="e.g. L0724" aria-label={`Lot number for ${p.name ?? `PO #${p.number}`}`}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v !== (p.lotNumber ?? '')) patch(p, { lotNumber: v || null }); }} /></label>
              {/* Item lines wrap on phones (name first, then quantity, lead time or arrival, cost). */}
              <ul className="mt-3 divide-y divide-line text-[13px]">
                {p.lines.map((l) => {
                  const open = !['received', 'cancelled'].includes(p.status) && l.received < l.quantity;
                  const edit = editing === p.id;
                  const small = 'rounded-md border border-line bg-white px-1.5 py-0.5 num';
                  return (
                    <li key={`${l.id}-${l.quantity}-${l.costCents}-${l.lotNote}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                      <span className="min-w-[min(100%,12rem)] flex-1 text-ink">
                        {l.label}<span className="ml-2 text-[11px] text-stone">{l.sku}{p.supplier?.includes(' + ') && l.supplier ? ` · ${l.supplier}` : ''}</span>
                      </span>
                      {/* A short note per item (e.g. a different lot, or "2 damaged"), at any stage. */}
                      <input className={cx(small, 'w-32 text-[12px]')} maxLength={40} defaultValue={l.lotNote ?? ''} placeholder="Note" aria-label={`Note for ${l.label}`}
                        onBlur={(e) => { const v = e.target.value.trim(); if (v !== (l.lotNote ?? '')) patchLine(p, l.id, { lotNote: v || null }); }} />
                      {edit && !['received', 'cancelled'].includes(p.status) ? (
                        <>
                          <label className="inline-flex items-center gap-1 text-[12px] text-stone" title={l.received ? `${l.received} already received` : undefined}>Qty
                            <input inputMode="numeric" className={cx(small, 'w-14 text-right')} defaultValue={l.quantity}
                              onBlur={(e) => { const n = Math.round(Number(e.target.value)); if (Number.isFinite(n) && n !== l.quantity) patchLine(p, l.id, { quantity: n }); }} /></label>
                          <label className="inline-flex items-center gap-1 text-[12px] text-stone">$ each
                            <input inputMode="decimal" className={cx(small, 'w-16 text-right')} defaultValue={l.costCents != null ? (l.costCents / 100).toFixed(2) : ''} placeholder="—"
                              onBlur={(e) => { const v = e.target.value.trim(); const c = v === '' ? null : Math.round(Number(v.replace(/[$,]/g, '')) * 100); if (c !== l.costCents && (c == null || Number.isFinite(c))) patchLine(p, l.id, { costCents: c }); }} /></label>
                        </>
                      ) : <span className="num">{l.received ? `${l.received} / ` : ''}{l.quantity}</span>}
                      {/* Each item's own lead time (draft) or arrival date (ordered) — products from one supplier can take different times. */}
                      <span className="text-[12px] text-ink-soft">
                        {p.status === 'draft' ? (
                          <label className="inline-flex items-center gap-1">Lead <input inputMode="numeric" className="w-14 rounded-md border border-line bg-white px-1.5 py-0.5 text-right num" defaultValue={l.leadTimeDays ?? ''} placeholder="—"
                            onBlur={(e) => { const v = e.target.value.trim(); const n = v === '' ? null : Math.round(Number(v)); if (n !== l.leadTimeDays && (n == null || Number.isFinite(n))) patchLine(p, l.id, { leadTimeDays: n }); }} /> days</label>
                        ) : open ? (
                          <label className="inline-flex items-center gap-1">Arrives <input type="date" className="rounded-md border border-line bg-white px-1 py-0.5" defaultValue={l.expectedOn ?? ''} onChange={(e) => patchLine(p, l.id, { expectedOn: e.target.value || null })} /></label>
                        ) : l.expectedOn ? `Due ${dateShort(`${l.expectedOn}T12:00:00Z`)}` : ''}
                      </span>
                      <span className="num w-20 text-right text-ink-soft">{l.costCents != null ? `$${((l.costCents * l.quantity) / 100).toFixed(2)}` : ''}</span>
                      {edit && !l.received && p.lines.length > 1 && !['received', 'cancelled'].includes(p.status) && (
                        <button type="button" className="rounded p-1 text-stone hover:bg-mist hover:text-rose" aria-label={`Remove ${l.label}`}
                          onClick={async () => { try { await api.del(`/inventory-sync/stock/purchase-orders/${p.id}/lines/${l.id}`); refresh(); } catch (e) { toast((e as Error).message, 'error'); } }}><Trash2 className="h-4 w-4" /></button>
                      )}

                    </li>
                  );
                })}
              </ul>
              {editing === p.id && !['received', 'cancelled'].includes(p.status) && <AddToOrder po={p} onAdded={refresh} />}

            </section>
          );
        })}
      </div>
      {moving && <MovePoModal po={moving} onClose={() => setMoving(null)} />}
      {receiving && <ReceiveModal po={receiving} onClose={() => setReceiving(null)} />}
      {creating && <NewPoModal store={store} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Add products to an open order: search by name, colour, collection or SKU. */
function AddToOrder({ po, onAdded }: { po: PurchaseOrderDTO; onAdded: () => void }) {
  const toast = useToast();
  const { data } = useProducts();
  const [q, setQ] = useState('');
  const found = q.trim() ? filterProducts(data?.products ?? [], q, 'all').filter((p) => (po.store === 'salon' ? !!p.squareVariationId : !!p.shopifyInventoryItemId) && !po.lines.some((l) => l.productKey === p.key)).slice(0, 8) : [];
  const add = async (p: StockProductDTO) => {
    try {
      await api.post(`/inventory-sync/stock/purchase-orders/${po.id}/lines`, { lines: [{ productKey: p.key, quantity: Math.max(p.moq ?? 0, 1) }] });
      setQ('');
      onAdded();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="relative mt-2">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
      <input className="field h-10 pl-9 text-[16px] sm:text-[14px]" placeholder="Add a product to this order" value={q} onChange={(e) => setQ(e.target.value)} />
      {found.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full rounded-lg border border-line bg-white shadow-pop">
          {found.map((p) => <li key={p.key}><button type="button" className="w-full px-3 py-2 text-left text-[13px] hover:bg-mist" onClick={() => add(p)}>{p.label} <span className="text-stone">{p.sku}</span></button></li>)}
        </ul>
      )}
    </div>
  );
}

function ReceiveModal({ po, onClose }: { po: PurchaseOrderDTO; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const report = useApplyReport();
  const [got, setGot] = useState<Record<string, string>>(Object.fromEntries(po.lines.map((l) => [l.id, String(Math.max(0, l.quantity - l.received))])));
  const [note, setNote] = useState('');
  // Lot numbers usually come with the delivery: entered here, saved on each item.
  const [lots, setLots] = useState<Record<string, string>>(Object.fromEntries(po.lines.map((l) => [l.id, l.lotNote ?? ''])));
  const [lot, setLot] = useState(po.lotNumber ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (lot.trim() !== (po.lotNumber ?? '')) await api.patch(`/inventory-sync/stock/purchase-orders/${po.id}`, { lotNumber: lot.trim() || null });
      for (const l of po.lines) {
        const v = (lots[l.id] ?? '').trim();
        if (v !== (l.lotNote ?? '')) await api.patch(`/inventory-sync/stock/purchase-orders/${po.id}/lines/${l.id}`, { lotNote: v || null });
      }
      const r = await api.post<{ result: StockApplyResultDTO }>(`/inventory-sync/stock/purchase-orders/${po.id}/receive`, { lines: po.lines.map((l) => ({ lineId: l.id, quantity: Math.max(0, Math.round(Number(got[l.id]) || 0)) })), note: note || null });
      report(r.result);
      refresh();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Receive PO #${po.number}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Add to stock</Button></>}>
      <p className="mb-3 text-[13px] text-ink-soft">Enter what arrived (leave out anything damaged or missing). It’s added to stock in Square and Shopify and logged with the order number.</p>
      <Field label="Lot number" hint="For the whole order." className="mb-3"><input className="field w-48 font-mono" maxLength={40} value={lot} onChange={(e) => setLot(e.target.value)} placeholder="e.g. L0724" /></Field>
      <table className="w-full text-[13px]"><tbody className="divide-y divide-line">
        {po.lines.map((l) => (
          <tr key={l.id}><td className="py-1.5 text-ink">{l.label}<span className="block text-[11px] text-stone">{l.received} of {l.quantity} received so far</span>
              <input className="mt-1 w-40 rounded-md border border-line bg-white px-2 py-1 text-[12px]" maxLength={40} placeholder="Note (optional)" value={lots[l.id] ?? ''} onChange={(e) => setLots((x) => ({ ...x, [l.id]: e.target.value }))} aria-label={`Note for ${l.label}`} /></td>
            <td className="w-24 py-1.5 pl-2 align-top"><input inputMode="numeric" className="field num" value={got[l.id] ?? ''} onChange={(e) => setGot((g) => ({ ...g, [l.id]: e.target.value }))} aria-label={`Received of ${l.label}`} /></td></tr>
        ))}
      </tbody></table>
      <Field label="Note (optional)" className="mt-3"><input className="field" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Modal>
  );
}

/**
 * New purchase order: pick the supplier, then their products (low ones first, with suggested amounts) or any product by
 * search. Each item keeps its own lead time — products from one supplier can take different times — and shows when it
 * would arrive if ordered today. Save as a draft, or place it straight away.
 */
function NewPoModal({ onClose, store = 'salon' }: { onClose: () => void; store?: 'salon' | 'shopify' }) {
  const N = useStoreNames();
  const toast = useToast();
  const refresh = useRefresh();
  const { data } = useProducts();
  const { data: suppliers } = useSuppliers();
  const { data: forecast } = useQuery({ queryKey: ['stock-forecast'], queryFn: () => api.get<StockForecastResponse>('/inventory-sync/stock/forecast'), staleTime: 60_000 });
  const fallback = suppliers?.find((x) => x.isDefault)?.name ?? null;
  // One or more suppliers (e.g. one company's product lines with different lead times); null = not picked yet (the default).
  const [picked, setPicked] = useState<string[] | null>(null);
  const chosenList = picked ?? (fallback ? [fallback] : []);
  const chosen = chosenList.join(' + ');
  const [q, setQ] = useState('');
  type Line = { p: StockProductDTO; qty: string; cost: string; lead: string };
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState<'draft' | 'order' | null>(null);
  const fc = useMemo(() => new Map((forecast?.items ?? []).map((i) => [i.key, i])), [forecast]);
  // Each product's lead time comes from its own supplier (plus shipping), whichever suppliers the order is for.
  const supOf = (p: StockProductDTO) => suppliers?.find((x) => x.name === (p.supplier ?? fallback)) ?? null;
  const leadOf = (p: StockProductDTO) => {
    const s = supOf(p);
    if (s?.leadUntracked) return null;
    const base = p.leadTimeDays ?? s?.leadTimeDays ?? null;
    return base == null ? null : base + (s?.shippingDays ?? 0);
  };
  const qtyOf = (p: StockProductDTO) => Math.max(fc.get(p.key)?.suggestedQty ?? 0, p.moq ?? 0, 1);
  const lineFor = (p: StockProductDTO): Line => ({ p, qty: String(qtyOf(p)), cost: p.costCents != null ? (p.costCents / 100).toFixed(2) : '', lead: leadOf(p) != null ? String(leadOf(p)) : '' });
  const add = (ps: StockProductDTO[]) => setLines((cur) => [...cur, ...ps.filter((p) => !cur.some((l) => l.p.key === p.key)).map(lineFor)]);
  const has = (k: string) => lines.some((l) => l.p.key === k);
  // The supplier's products: those that need ordering first.
  const rank = (p: StockProductDTO) => ({ out: 0, order_now: 1, soon: 2, watch: 3 } as Record<string, number>)[fc.get(p.key)?.status ?? ''] ?? 9;
  // Only products sold in this order's store.
  const inStore = (p: StockProductDTO) => (store === 'salon' ? !!p.squareVariationId : !!p.shopifyInventoryItemId);
  const theirs = chosenList.length ? (data?.products ?? []).filter((p) => p.status === 'active' && inStore(p) && chosenList.includes(p.supplier ?? fallback ?? '')).sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)) : [];
  const suggested = theirs.filter((p) => rank(p) <= 2 && !has(p.key));
  const found = q.trim() ? filterProducts(data?.products ?? [], q, 'all').filter((p) => inStore(p) && !has(p.key)).slice(0, 8) : [];
  const set = (i: number, patch: Partial<Line>) => setLines((x) => x.map((y, j) => (j === i ? { ...y, ...patch } : y)));
  const arrives = (lead: string) => { const n = Number(lead); if (lead.trim() === '' || !Number.isFinite(n)) return null; const d = new Date(); d.setDate(d.getDate() + Math.round(n)); return dateShort(d.toISOString()); };
  const total = lines.reduce((a, l) => a + (Number(l.cost) || 0) * (Math.round(Number(l.qty)) || 0), 0);
  const save = async (place: boolean) => {
    setBusy(place ? 'order' : 'draft');
    try {
      const r = await api.post<{ orders: PurchaseOrderDTO[] }>('/inventory-sync/stock/purchase-orders', {
        ...(chosenList.length > 1 ? { suppliers: chosenList } : { supplier: chosenList[0] ?? null }), store,
        lines: lines.map((l) => ({ productKey: l.p.key, quantity: Math.round(Number(l.qty) || 0), costCents: l.cost.trim() === '' ? null : Math.round(Number(l.cost) * 100), leadTimeDays: l.lead.trim() === '' ? null : Math.round(Number(l.lead)) }))
          .filter((l) => l.quantity > 0),
      });
      if (place) for (const o of r.orders) await api.patch(`/inventory-sync/stock/purchase-orders/${o.id}`, { status: 'ordered' });
      toast(`${r.orders.length > 1 ? `${r.orders.length} orders` : `PO #${r.orders[0]?.number}`} ${place ? 'placed — arrival dates set per item' : 'saved as a draft'}`);
      refresh();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const cell = 'rounded-lg border border-line bg-white px-2 py-1.5 text-[14px] num focus:border-plum focus:outline-none';
  return (
    <Modal open side wide onClose={onClose} title={store === 'salon' ? `New ${N.square} purchase order` : `New ${N.shopify} purchase order`}
      footer={<>
        {total > 0 && <span className="mr-auto text-[14px] text-ink-soft">Total <b className="num text-ink">${total.toFixed(2)}</b></span>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button loading={busy === 'draft'} disabled={!lines.length || !!busy} onClick={() => save(false)}>Save draft</Button>
        <Button variant="primary" loading={busy === 'order'} disabled={!lines.length || !!busy} onClick={() => save(true)}>Create &amp; mark ordered</Button>
      </>}>
      <div className="space-y-4">
        <Field label="Suppliers" hint={chosenList.length > 1 ? 'One order for all of them — each item keeps its own supplier’s lead time.' : chosenList.length ? 'Add more for one order across several (e.g. the same company’s product lines).' : 'Without one, each product’s own supplier is used (one order per supplier).'}>
          <div className="flex flex-wrap items-center gap-2">
            {chosenList.map((n) => (
              <span key={n} className="inline-flex items-center gap-1 rounded-full border border-line bg-white py-1 pl-3 pr-1 text-[13px] text-ink">
                {n}{(() => { const s = suppliers?.find((x) => x.name === n); return s?.leadUntracked ? <span className="text-stone"> · not tracked</span> : s?.leadTimeDays != null ? <span className="text-stone"> · {s.leadTimeDays + (s.shippingDays ?? 0)} days</span> : null; })()}
                <button type="button" className="rounded-full p-0.5 text-stone hover:bg-mist hover:text-ink" aria-label={`Remove ${n}`} onClick={() => setPicked(chosenList.filter((x) => x !== n))}><X className="h-3.5 w-3.5" /></button>
              </span>
            ))}
            <select className="field h-9 w-auto min-w-[12rem] py-1 text-sm" value="" onChange={(e) => e.target.value && setPicked([...chosenList, e.target.value])} aria-label="Add a supplier">
              <option value="">{chosenList.length ? '+ Add a supplier' : 'Choose a supplier'}</option>
              {(suppliers ?? []).filter((x) => !chosenList.includes(x.name)).map((x) => <option key={x.name} value={x.name}>{x.name}{x.isDefault ? ' (default)' : ''}{x.leadTimeDays != null ? ` · usually ${x.leadTimeDays} days` : ''}</option>)}
            </select>
          </div>
        </Field>

        {chosen && (
          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <h3 className="text-[13px] font-semibold uppercase tracking-wide text-stone">Products from {chosenList.length > 1 ? `${chosenList.length} suppliers` : chosen}</h3>
              {suggested.length > 0 && <Button size="sm" className="ml-auto" onClick={() => add(suggested)}>Add all suggested ({suggested.length})</Button>}
            </div>
            {theirs.length === 0 ? <p className="text-[13px] text-stone">No products have this supplier yet — search below, or give it products under Suppliers.</p> : (
              <ul className="max-h-56 divide-y divide-line overflow-auto rounded-xl border border-line bg-white">
                {theirs.map((p) => {
                  const f = fc.get(p.key);
                  const low = rank(p) <= 2;
                  return (
                    <li key={p.key}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[13px] hover:bg-mist/50">
                        <input type="checkbox" className="h-4 w-4 shrink-0 accent-plum" checked={has(p.key)} onChange={() => (has(p.key) ? setLines((x) => x.filter((l) => l.p.key !== p.key)) : add([p]))} />
                        <span className="min-w-0 flex-1"><span className="block truncate text-ink">{p.label}</span>
                          <span className="block text-[11px] text-stone"><span className="font-mono">{p.sku}</span> · {f ? `${f.stock} in stock` : ''}{leadOf(p) != null ? ` · ${leadOf(p)} day lead` : ''}{chosenList.length > 1 ? ` · ${p.supplier ?? fallback}` : ''}</span></span>
                        {low && f && <Badge tone={f.status === 'out' || f.status === 'order_now' ? 'rose' : 'amber'}>Suggest {f.suggestedQty}</Badge>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
          <input className="field h-11 pl-9 text-[16px] sm:text-[14px]" placeholder={chosen ? 'Add another product: name, colour, collection or SKU' : SEARCH_HINT} value={q} onChange={(e) => setQ(e.target.value)} />
          {found.length > 0 && (
            <ul className="absolute z-20 mt-1 w-full rounded-lg border border-line bg-white shadow-pop">
              {found.map((p) => <li key={p.key}><button type="button" className="w-full px-3 py-2 text-left text-[13px] hover:bg-mist" onClick={() => { add([p]); setQ(''); }}>{p.label} <span className="text-stone">{p.sku}{p.supplier && !chosenList.includes(p.supplier) ? ` · ${p.supplier}` : ''}</span></button></li>)}
            </ul>
          )}
        </div>

        {lines.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-[13px] font-semibold uppercase tracking-wide text-stone">On this order ({lines.length})</h3>
            <ul className="divide-y divide-line rounded-xl border border-line bg-white">
              {lines.map((l, i) => (
                <li key={l.p.key} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 px-3 py-2.5 text-[13px] sm:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto]">
                  <span className="min-w-0 self-center"><span className="block truncate text-ink">{l.p.label}</span><span className="font-mono text-[11px] text-stone">{l.p.sku}</span></span>
                  <Button size="sm" variant="ghost" className="sm:order-last" icon={<Trash2 className="h-4 w-4" />} aria-label={`Remove ${l.p.label}`} onClick={() => setLines((x) => x.filter((_, j) => j !== i))} />
                  <label className="flex items-center gap-1 text-stone">Qty <input inputMode="numeric" className={cx(cell, 'w-16')} value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></label>
                  <label className="flex items-center gap-1 text-stone">$ <input inputMode="decimal" className={cx(cell, 'w-20')} placeholder="Cost" value={l.cost} onChange={(e) => set(i, { cost: e.target.value })} /></label>
                  <label className="col-span-2 flex items-center gap-1 text-stone sm:col-span-1" title="This item’s own lead time">Lead <input inputMode="numeric" className={cx(cell, 'w-14')} placeholder="—" value={l.lead} onChange={(e) => set(i, { lead: e.target.value })} /> days
                    {arrives(l.lead) && <span className="ml-1 whitespace-nowrap text-ink-soft">· arrives ~{arrives(l.lead)}</span>}</label>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[12px] text-stone">Lead times start from each product’s own (or its supplier’s usual), plus shipping. Arrival dates are set per item when the order is placed.</p>
          </section>
        )}
      </div>
    </Modal>
  );
}


// ---------------- Suppliers ----------------
export function SuppliersView() {
  const toast = useToast();
  // Company names and contacts: only with "See supplier company names and contacts" (the server leaves them out otherwise).
  const details = useCanDo()('suppliers:details');
  const refresh = useRefresh();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['stock-suppliers'], queryFn: () => api.get<{ suppliers: SupplierDTO[] }>('/inventory-sync/stock/suppliers').then((r) => r.suppliers) });
  const [editing, setEditing] = useState<SupplierDTO | 'new' | null>(null);
  const [assigning, setAssigning] = useState<SupplierDTO | null>(null);
  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;
  const again = () => { refresh(); qc.invalidateQueries({ queryKey: ['stock-suppliers'] }); };
  const applyActual = async (s: SupplierDTO) => {
    try {
      const r = await api.put<{ products: number }>('/inventory-sync/stock/suppliers/lead-time', { name: s.name, days: s.actualLeadDays });
      toast(`${s.name}: lead time set to ${s.actualLeadDays} days on ${r.products} product${r.products === 1 ? '' : 's'}.`);
      again();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const makeDefault = async (s: SupplierDTO | null) => {
    try { await api.put('/inventory-sync/stock/suppliers/default', { name: s?.name ?? null }); toast(s ? `${s.name} is the default supplier` : 'No default supplier'); again(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const remove = async (s: SupplierDTO) => {
    if (!window.confirm(`Remove ${s.name}?${s.products ? ` Its ${s.products} product${s.products === 1 ? '' : 's'} will have no supplier (nothing else changes).` : ''}`)) return;
    try { await api.post('/inventory-sync/stock/suppliers/remove', { name: s.name }); toast(`${s.name} removed`); again(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="mr-auto text-[14px] text-ink-soft">{details ? 'Who you buy from, the name each is shown as, their contact details and how long they take.' : 'Who you buy from and how long they take.'} Give them products by store or one by one.</p>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>Add supplier</Button>
      </div>
      {!data.length ? (
        <div className="panel"><EmptyState title="No suppliers yet" action={<Button variant="primary" onClick={() => setEditing('new')}>Add supplier</Button>}>Add a supplier, then give it products — every product in a store at once, or chosen ones.</EmptyState></div>
      ) : (
        <ul className="space-y-2">
          {data.map((s) => {
            const late = !s.leadUntracked && s.actualLeadDays != null && s.statedLeadDays != null && s.actualLeadDays > s.statedLeadDays;
            return (
              <li key={s.name} className="rounded-xl2 border border-line bg-white p-4">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[16px] font-medium text-ink">{s.name}{s.isDefault && <Badge tone="plum">Default</Badge>}</p>
                    {details && s.companyName && s.companyName !== s.name && <p className="text-[13px] text-ink-soft">Company: <span className="text-ink">{s.companyName}</span> <span className="text-stone">(shown as {s.name})</span></p>}
                    {details && <p className="text-[13px] text-ink-soft">
                      {[s.email && <a key="e" className="text-plum hover:underline" href={`mailto:${s.email}`}>{s.email}</a>, s.phone && <a key="p" className="hover:underline" href={`tel:${s.phone}`}>{s.phone}</a>,
                        s.website && <a key="w" className="text-plum hover:underline" href={/^https?:/.test(s.website) ? s.website : `https://${s.website}`} target="_blank" rel="noreferrer">{s.website.replace(/^https?:\/\//, '')}</a>]
                        .filter(Boolean).flatMap((x, i) => (i ? [<span key={`s${i}`} className="text-stone"> · </span>, x] : [x]))}
                      {!s.email && !s.phone && !s.website && <span className="text-stone">No contact details</span>}
                    </p>}
                    {details && s.notes && <p className="mt-1 text-[13px] text-stone">{s.notes}</p>}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" icon={<ListPlus className="h-4 w-4" />} onClick={() => setAssigning(s)}>Add products</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>Edit</Button>
                    {s.isDefault
                      ? <Button size="sm" variant="ghost" onClick={() => makeDefault(null)}>Not default</Button>
                      : <Button size="sm" variant="ghost" title="Used for products and orders that don’t name a supplier" onClick={() => makeDefault(s)}>Make default</Button>}
                    <Button size="sm" variant="ghost" aria-label={`Remove ${s.name}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => remove(s)} />
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
                  <span><b className="num font-medium text-ink">{s.products}</b> <span className="text-stone">product{s.products === 1 ? '' : 's'}</span></span>
                  <span className="text-stone">Lead time <b className="num font-medium text-ink">{s.leadUntracked ? 'Not tracked' : s.statedLeadDays != null ? `${s.statedLeadDays} days` : '—'}</b>{!s.leadUntracked && s.shippingDays ? <> + <b className="num font-medium text-ink">{s.shippingDays}</b> shipping</> : null}</span>
                  {s.defaultMoq != null && <span className="text-stone">Default MOQ <b className="num font-medium text-ink">{s.defaultMoq}</b></span>}
                  {!s.leadUntracked && <span className={late ? 'text-rose' : 'text-stone'}>Actual <b className="num font-medium">{s.actualLeadDays != null ? `${s.actualLeadDays} days` : '—'}</b>{late && ` (${s.actualLeadDays! - s.statedLeadDays!} days late on average)`}</span>}
                  <span className="text-stone">Orders <b className="num font-medium text-ink">{s.receivedOrders}</b> received · <b className="num font-medium text-ink">{s.openOrders}</b> open</span>
                  {s.spentCents > 0 && <span className="text-stone">Spent <b className="num font-medium text-ink">${(s.spentCents / 100).toFixed(2)}</b></span>}
                  {!s.leadUntracked && s.actualLeadDays != null && s.actualLeadDays !== s.statedLeadDays && s.products > 0 && <Button size="sm" variant="ghost" onClick={() => applyActual(s)}>Use {s.actualLeadDays} days on its products</Button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing && <SupplierModal supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={again} />}
      {assigning && <AssignSupplierModal supplier={assigning} onClose={() => setAssigning(null)} onSaved={again} />}
    </div>
  );
}

/** Add a supplier, or change its name and details (a new name is used everywhere it appears). */
function SupplierModal({ supplier, onClose, onSaved }: { supplier: SupplierDTO | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const details = useCanDo()('suppliers:details');
  const [d, setD] = useState({ name: supplier?.name ?? '', company: supplier?.companyName ?? '', email: supplier?.email ?? '', phone: supplier?.phone ?? '', website: supplier?.website ?? '', notes: supplier?.notes ?? '', lead: supplier?.leadTimeDays != null ? String(supplier.leadTimeDays) : '', shipping: supplier?.shippingDays != null ? String(supplier.shippingDays) : '', moq: supplier?.defaultMoq != null ? String(supplier.defaultMoq) : '' });
  const [untracked, setUntracked] = useState(!!supplier?.leadUntracked);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const body = { name: d.name, ...(details ? { companyName: d.company || null } : {}), email: d.email || null, phone: d.phone || null, website: d.website || null, notes: d.notes || null, leadTimeDays: d.lead.trim() === '' ? null : Math.round(Number(d.lead)), leadUntracked: untracked,
        shippingDays: d.shipping.trim() === '' ? null : Math.round(Number(d.shipping)), defaultMoq: d.moq.trim() === '' ? null : Math.max(1, Math.round(Number(d.moq))) };
      if (supplier) await api.put('/inventory-sync/stock/suppliers/details', { ...body, previous: supplier.name });
      else await api.post('/inventory-sync/stock/suppliers', body);
      toast(supplier ? 'Saved' : `${d.name.trim()} added — now give it products`);
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const f = (k: keyof typeof d) => ({ value: d[k], onChange: (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value }) });
  return (
    <Modal open onClose={onClose} title={supplier ? `Edit ${supplier.name}` : 'Add supplier'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} disabled={!d.name.trim()} onClick={save}>{supplier ? 'Save' : 'Add supplier'}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Shown as" hint="The name used on products, purchase orders and reorder (e.g. Addendum Hair). Renaming it updates them all." className="sm:col-span-2"><input className="field" autoFocus {...f('name')} /></Field>
        {details && <>
          <Field label="Company name" hint="The real business behind it. Only people who may see supplier details see this." className="sm:col-span-2"><input className="field" placeholder="Same as shown name" {...f('company')} /></Field>
          <Field label="Email"><input className="field" type="email" {...f('email')} /></Field>
          <Field label="Phone"><input className="field" type="tel" {...f('phone')} /></Field>
          <Field label="Website"><input className="field" {...f('website')} /></Field>
        </>}
        <Field label="Usual lead time (days)" hint={untracked ? 'Not tracked for this supplier.' : 'Given to its products that don’t have their own.'}><input className="field num" inputMode="numeric" disabled={untracked} {...f('lead')} /></Field>
        <Field label="Shipping (days)" hint={untracked ? 'Not tracked for this supplier.' : 'Days in transit, added to the lead time.'}><input className="field num" inputMode="numeric" disabled={untracked} {...f('shipping')} /></Field>
        <Field label="Default MOQ" hint="Minimum order for its products that don’t have their own."><input className="field num" inputMode="numeric" {...f('moq')} /></Field>
        <div className="sm:col-span-2"><Toggle checked={untracked} onChange={setUntracked} label="Lead time not tracked"
          description="For suppliers you buy from as needed: To order times reorders on safety stock alone (no lead time), and its orders get no expected date." /></div>
        {details && <Field label="Notes" className="sm:col-span-2"><textarea className="field min-h-[72px]" {...f('notes')} /></Field>}
      </div>
    </Modal>
  );
}

/** Give a supplier products: every product in a store, or chosen ones (search by name, colour, collection or SKU). */
function AssignSupplierModal({ supplier, onClose, onSaved }: { supplier: SupplierDTO; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const N = useStoreNames();
  const { data } = useProducts();
  const [mode, setMode] = useState<'store' | 'products'>('store');
  const [store, setStore] = useState<'square' | 'shopify' | 'shopify2' | 'all'>('square');
  const [onlyWithout, setOnlyWithout] = useState(true);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const shown = useMemo(() => filterProducts(data?.products ?? [], q, 'active'), [data, q]);
  const inStore = (p: StockProductDTO) => store === 'all' || (store === 'square' && !!p.squareVariationId) || (store === 'shopify' && !!p.shopifyInventoryItemId) || (store === 'shopify2' && p.store2.length > 0);
  const storeCount = (data?.products ?? []).filter((p) => p.status === 'active' && inStore(p) && (!onlyWithout || !p.supplier)).length;
  const allShown = shown.length > 0 && shown.slice(0, 300).every((p) => picked.has(p.key));
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put<{ products: number }>('/inventory-sync/stock/suppliers/assign', mode === 'store' ? { supplier: supplier.name, store, onlyWithout } : { supplier: supplier.name, keys: [...picked] });
      toast(`${r.products} product${r.products === 1 ? '' : 's'} now from ${supplier.name}`);
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  type Store = 'square' | 'shopify' | 'shopify2' | 'all';
  const stores: { value: Store; label: string }[] = [{ value: 'square', label: N.square }, { value: 'shopify', label: N.shopify }, ...(data?.store2 ? [{ value: 'shopify2' as const, label: data.store2 }] : []), { value: 'all', label: 'All stores' }];
  return (
    <Modal open side onClose={onClose} title={`Products from ${supplier.name}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={saving} disabled={mode === 'store' ? !storeCount : !picked.size} onClick={save}>
          {mode === 'store' ? `Give ${storeCount} product${storeCount === 1 ? '' : 's'} to ${supplier.name}` : `Give ${picked.size} product${picked.size === 1 ? '' : 's'} to ${supplier.name}`}
        </Button></>}>
      <Segmented className="mb-4" value={mode} onChange={setMode} options={[{ value: 'store', label: 'By store' }, { value: 'products', label: 'Choose products' }]} />
      {!data ? <PageLoading /> : mode === 'store' ? (
        <div className="space-y-3 text-[14px]">
          <p className="text-ink-soft">Every active product sold in:</p>
          <div className="flex flex-wrap gap-2">
            {stores.map((x) => (
              <button key={x.value} type="button" onClick={() => setStore(x.value)} className={cx('rounded-lg border px-3 py-2', store === x.value ? 'border-plum bg-plum/5 font-medium text-plum' : 'border-line bg-white text-ink-soft hover:bg-mist')}>{x.label}</button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-ink-soft"><input type="checkbox" className="h-4 w-4 accent-plum" checked={onlyWithout} onChange={(e) => setOnlyWithout(e.target.checked)} />Only products without a supplier yet</label>
          <p className="text-stone">{storeCount} product{storeCount === 1 ? '' : 's'} will be from {supplier.name}{onlyWithout ? '' : ' (replacing any other supplier)'}.</p>
        </div>
      ) : (
        <div>
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
            <input className="field h-11 pl-9 text-[16px] sm:text-[14px]" type="search" autoFocus placeholder={SEARCH_HINT} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <label className="mb-2 flex items-center gap-2 text-[13px] text-ink-soft">
            <input type="checkbox" className="h-4 w-4 accent-plum" checked={allShown} onChange={() => setPicked((cur) => { const n = new Set(cur); for (const p of shown.slice(0, 300)) { if (allShown) n.delete(p.key); else n.add(p.key); } return n; })} />
            Select all {Math.min(shown.length, 300)} shown{picked.size ? ` · ${picked.size} selected` : ''}
          </label>
          <ul className="max-h-[55vh] divide-y divide-line overflow-auto rounded-xl border border-line bg-white">
            {shown.slice(0, 300).map((p) => (
              <li key={p.key}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-[14px] hover:bg-mist/50">
                  <input type="checkbox" className="h-4 w-4 shrink-0 accent-plum" checked={picked.has(p.key)} onChange={() => setPicked((cur) => { const n = new Set(cur); if (n.has(p.key)) n.delete(p.key); else n.add(p.key); return n; })} />
                  <span className="min-w-0 flex-1"><span className="block truncate text-ink">{p.label}</span>
                    <span className="block truncate text-[12px] text-stone"><span className="font-mono">{p.sku ?? 'No SKU'}</span>{p.supplier ? ` · now: ${p.supplier}` : ''}</span></span>
                </label>
              </li>
            ))}
            {!shown.length && <li className="px-3 py-6 text-center text-[14px] text-stone">No products match.</li>}
          </ul>
        </div>
      )}
    </Modal>
  );
}
