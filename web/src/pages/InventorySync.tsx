import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { StockProductDTO, InventorySeparateDTO, InventorySyncLinkDTO, InventorySyncOverviewDTO, InventorySyncRunDTO } from '@addendum/shared';
import { AlertTriangle, ArrowLeftRight, CheckCircle2, CircleDashed, Link2, Pencil, RefreshCw, RotateCcw, Search, Tag, Unlink, X, XCircle } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { ProductsView, PurchaseOrdersView, ReorderView, StockHistory, StockView, SuppliersView } from '../components/domain/StockTools';
import { InventoryOverview } from '../components/domain/InventoryOverview';
import { CollectionsButton } from '../components/domain/Collections';
import { api } from '../api/client';
import { ShopifySyncSwitch } from '../components/domain/ShopifySyncSwitch';
import { relative } from '../lib/format';
import { SquareInventoryView } from './SquareInventory';
import { WaitingForStock } from '../components/domain/ToOrder';
import { PreorderBanner } from '../components/domain/Preorders';
import { PricingView } from '../components/domain/Pricing';
import { AddToSquareButton } from '../components/domain/AddToSquare';
import { AddLengthButton } from '../components/domain/AddLength';
import { pageBusiness, useWorkspace } from '../lib/workspace';
import { Badge, Button, EmptyState, ErrorNote, Field, Menu, Modal, PageHeader, PageLoading, PageTabs, Segmented, Spinner, Toggle, cx, useToast } from '../components/ui';
import { NumberField } from './settings/shared';
import { Tc } from '../lib/titleCase';
import { useStoreNames, type StoreNames } from '../lib/storeNames';

const result = (N: StoreNames): Record<InventorySyncRunDTO['details'][number]['result'], { label: string; tone: 'sage' | 'neutral' | 'rose' | 'amber' | 'plum' }> => ({
  updated_square: { label: `${N.square} updated`, tone: 'sage' }, updated_shopify: { label: `${N.shopify} updated`, tone: 'sage' }, updated_both: { label: 'Both updated', tone: 'sage' },
  unchanged: { label: 'No change', tone: 'neutral' }, failed: { label: 'Failed', tone: 'rose' }, attention: { label: 'Needs attention', tone: 'amber' }, retry: { label: 'Will retry', tone: 'plum' },
});

/**
 * Inventory's pages, in one tab bar: an overview, the product lists, counts and prices, then ordering (what to order,
 * purchase orders, suppliers) and the stock activity log. The Square ↔ Shopify sync is under More.
 */
const TABS = [
  // Inventory: the products with their stock — searchable by product, SKU or collection, counted or adjusted in place.
  { value: 'stock', label: 'Inventory' }, { value: 'reorder', label: 'To order' }, { value: 'orders', label: 'Purchase orders' }, { value: 'items', label: 'Products' },
  { value: 'pricing', label: 'Pricing' }, { value: 'suppliers', label: 'Suppliers' }, { value: 'activity', label: 'Activity' },
];
const ABOUT: Record<string, string> = {
  overview: 'Stock in the salon (Square) and online (Shopify), kept separate. Open a product for its details.',
  items: 'Each store’s products. All stores: pair products, set SKUs and types, and add products.',
  stock: 'Every product’s stock — search by product, SKU or collection, then count or adjust it. Every change is logged under Activity.',
  pricing: 'Unit cost and each store’s price.',
  reorder: 'What needs ordering, from sales, lead times and what’s on order.',
  orders: 'Orders to suppliers. Receiving adds the stock.',
  suppliers: 'Who you order from, their lead times and minimum orders.',
  activity: 'Every count, adjustment, delivery, SKU change and sync.',
  sync: 'The Square ↔ Shopify stock sync and product matching.',
};
const STORES = [{ value: 'all', label: 'All stores' }, { value: 'salon', label: 'Addendum Salon' }, { value: 'hair', label: 'Addendum Hair' }];

export function InventorySyncPage() {
  const N = useStoreNames();
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['inventory-sync'],
    queryFn: () => api.get<InventorySyncOverviewDTO>('/inventory-sync'),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : 30_000),
  });
  const [tab, setTab] = useState<'attention' | 'all' | 'unmatched' | 'last'>('attention');
  // The products (for Collections: the store collections to pick from).
  const { data: productList } = useQuery({ queryKey: ['stock-products'], queryFn: () => api.get<{ products: StockProductDTO[] }>('/inventory-sync/stock/products'), staleTime: 20_000 }); // same shape as Inventory's other lists (shared cache)
  // Sections (the side menu): the stores' inventory first, then the sync and the stock tools. Salon inventory opens first.
  const [params, setParams] = useSearchParams();
  // Inventory opens first. Per-store pages pick the store with ?for=hair (Addendum Hair = Shopify); older links
  // (?view=square / shopify / orders-online / all / reorder) still land in the right place.
  const raw = params.get('view') ?? '';
  // Older links still land in the right place (?view=square / shopify / all / inventory = a store's products, etc.).
  const view = raw === 'stock' && params.get('part') === 'reorder' ? 'reorder'
    : ({ all: 'items', square: 'items', shopify: 'items', inventory: 'items', 'orders-online': 'orders', preorders: 'reorder', toorder: 'reorder' } as Record<string, string>)[raw]
    ?? (['overview', 'items', 'pricing', 'orders', 'stock', 'reorder', 'products', 'suppliers', 'activity', 'sync'].includes(raw) ? raw : 'stock');
  // The page's own choice (?for=), else the business workspace they're in.
  const ws = useWorkspace();
  const forHair = raw === 'shopify' || raw === 'orders-online' || raw === 'preorders' || pageBusiness(params, 'for', ws.current?.id ?? 'salon') === 'hair';
  const setView = (v: string, extra: Record<string, string> = {}) => setParams((p) => {
    const n = new URLSearchParams(p); n.delete('part'); n.delete('q'); n.delete('show');
    if (v === 'stock') n.delete('view'); else n.set('view', v);
    for (const [k, x] of Object.entries(extra)) n.set(k, x);
    return n;
  });
  const setStore = (hair: boolean) => setParams((p) => { const n = new URLSearchParams(p); if (n.get('view') === 'orders-online') n.set('view', 'orders'); n.set('for', hair ? 'hair' : 'salon'); return n; });
  // Overview, Stock counts, Pricing and To order: every store unless one is picked (older ?view=preorders links are Addendum Hair's).
  const storePick = (['salon', 'hair'] as const).find((s) => s === params.get('for')) ?? (raw === 'preorders' ? 'hair' : 'all');
  const pickStore = (v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v === 'all') n.delete('for'); else n.set('for', v); return n; });
  // Products: a store's own list, or every product across the stores (pairing, SKUs, Add to Square).
  const productsStore = view === 'products' ? 'all' : forHair ? 'hair' : 'salon';
  const setProductsStore = (v: string) => (v === 'all' ? setView('products') : setView('items', { for: v }));
  const [starting, setStarting] = useState(false);
  const [linking, setLinking] = useState(false);
  const [copyingSku, setCopyingSku] = useState(false);
  const run = data?.lastRun;
  useEffect(() => {
    if (data && !data.running) qc.invalidateQueries({ queryKey: ['inventory-sync-links'] });
  }, [data?.running, data?.lastRun?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (onlyFailed = false) => {
    setStarting(true);
    try {
      await api.post('/inventory-sync/run', { onlyFailed });
      await refetch();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setStarting(false);
    }
  };
  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;
  const bothConnected = data.square.connected && data.shopify.connected;

  return (
    <div>
      <PageHeader
        title="Inventory"
        subtitle={<>{ABOUT[view === 'products' ? 'items' : view]}{' '}<span className="text-stone-light">· {data.lastSuccessfulSyncAt ? `Synced ${relative(data.lastSuccessfulSyncAt)}` : 'Never synced'}{data.running ? ' · syncing now' : ''}</span></>}
        actions={<>
          {view === 'items' || view === 'products'
            ? <Segmented size="sm" value={productsStore} onChange={setProductsStore} options={STORES} />
            : ['overview', 'reorder', 'stock', 'pricing'].includes(view)
              ? <Segmented size="sm" value={storePick} onChange={pickStore} options={STORES} />
              : view === 'orders' && <Segmented size="sm" value={forHair ? 'hair' : 'salon'} onChange={(v) => setStore(v === 'hair')} options={STORES.slice(1)} />}
          <Menu align="right" trigger={(open) => <Button icon={<RefreshCw className={cx('h-4 w-4', data.running && 'animate-spin')} />} onClick={open}>More</Button>}
          items={[
            { label: data.running ? 'Syncing…' : 'Sync inventory now', onClick: () => { if (!data.running && bothConnected && !starting) void start(); } },
            { label: 'Sync & product matching', onClick: () => setView('sync') },
          ]} />
        </>}
      />
      {/* Inventory's pages (a dropdown on phones); the store switch sits with the header's actions. */}
      {/* On larger screens the sidebar lists Inventory's sub-tabs; phones get the page dropdown here. */}
      <PageTabs className="lg:hidden" value={view === 'products' ? 'items' : view} onChange={(v) => setView(v)} options={TABS} />
      {data.demoMode && view === 'sync' && <p className="mb-4 rounded-xl2 border border-line bg-mist/50 px-4 py-2 text-[13px] text-ink-soft">Demo Mode: this syncs the demo Square and Shopify catalogs. Nothing is sent to a real store.</p>}
      {['overview', 'items', 'stock'].includes(view) && <PreorderBanner />}
      {view === 'overview' && <InventoryOverview store={storePick} onOpenTab={setView} />}
      {view === 'items' && (forHair ? <ProductsView key="online" only="shopify" /> : <SquareInventoryView />)}
      {view === 'pricing' && <PricingView store={storePick} />}
      {view === 'products' && <div className="mb-3 flex flex-wrap justify-end gap-2"><CollectionsButton products={productList?.products ?? []} /><AddLengthButton /><AddToSquareButton /></div>}
      {view === 'products' && <ProductsView setup />}
      {view === 'stock' && <StockView key={params.get('q') ?? ''} store={storePick} initialQuery={params.get('q') ?? ''} />}
      {view === 'reorder' && <WaitingForStock store={storePick} />}
      {view === 'reorder' && <ReorderView key={storePick} store={storePick} initialFilter={params.get('show') === 'alerts' ? 'alerts' : 'reorder'} onOrders={() => setView('orders')} />}
      {view === 'orders' && (forHair ? <PurchaseOrdersView key="shopify" store="shopify" /> : <PurchaseOrdersView key="salon" store="salon" />)}
      {view === 'suppliers' && <SuppliersView />}
      {view === 'activity' && <StockHistory />}
      {view === 'sync' && <>

      <div className={cx('grid gap-3', data.shopify2?.connected ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
        <Connection name={N.square} c={data.square} />
        <Connection name={N.shopify} c={data.shopify} />
        {data.shopify2?.connected && <Connection name={data.shopify2.name} c={data.shopify2} />}
      </div>
      {!bothConnected && (
        <p className="mt-3 flex items-start gap-2 rounded-xl2 border border-amber/30 bg-amber/10 px-4 py-3 text-[14px] text-ink-soft">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
          <span>Both systems must be connected before syncing. Add the credentials in <Link className="text-plum underline" to="/settings?tab=api">Settings → API &amp; Integrations</Link> and use Test connection.</span>
        </p>
      )}

      {run && <RunPanel run={run} running={data.running} onRetry={() => start(true)} />}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {([['Linked products', data.counts.linked], ['In sync', data.counts.inSync], ['Need attention', data.counts.attention], ['Errors', data.counts.errors], ['Waiting', data.counts.pending], ['Sync off', data.counts.syncOff]] as const).map(([l, n]) => (
          <div key={l} className="rounded-xl2 border border-line bg-white px-3 py-2"><p className="text-[12px] text-stone">{l}</p><p className={cx('num font-display text-[24px] leading-tight', (l === 'Need attention' || l === 'Errors') && n > 0 && 'text-rose')}>{n}</p></div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <Segmented value={tab} onChange={setTab} options={[
          { value: 'attention', label: `Needs attention${data.counts.attention + data.counts.errors ? ` (${data.counts.attention + data.counts.errors})` : ''}` },
          { value: 'all', label: 'All linked' },
          { value: 'unmatched', label: `Not matched (${data.unmatched.squareOnly.length + data.unmatched.shopifyOnly.length})` },
          { value: 'last', label: 'Last run' },
        ]} />
        <Button size="sm" icon={<Link2 className="h-4 w-4" />} onClick={() => setLinking(true)}>Link by SKU</Button>
        <Button size="sm" icon={<Tag className="h-4 w-4" />} onClick={() => setCopyingSku(true)}>Use {N.shopify} SKU in {N.square}</Button>
      </div>
      <div className="mt-4">
        {tab === 'attention' && <Links status="problems" />}
        {tab === 'all' && <Links />}
        {tab === 'unmatched' && <Unmatched u={data.unmatched} separate={data.separate} />}
        {tab === 'last' && (run ? <RunDetails run={run} /> : <p className="text-sm text-stone">No sync has run yet.</p>)}
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <section className="panel p-5">
          <h2 className="h-display flex items-center gap-2 text-[22px]"><Tc><ArrowLeftRight className="h-5 w-5" />How conflicts are handled</Tc></h2>
          <p className="mt-2 whitespace-pre-line text-[14px] text-ink-soft">{data.rule}</p>
        </section>
        <AutoSettings s={data.settings} />
      </div>
      </>}
      {linking && <LinkModal onClose={() => setLinking(false)} />}
      {copyingSku && <SkuFromShopifyModal onClose={() => setCopyingSku(false)} />}
    </div>
  );
}

/** Just whether each side is connected; details (permissions, store) live in Settings → API & Integrations. */
function Connection({ name, c }: { name: string; c: InventorySyncOverviewDTO['square'] }) {
  const error = c.connected && c.status === 'error';
  const Icon = c.connected ? (error ? XCircle : CheckCircle2) : CircleDashed;
  return (
    <div className="rounded-xl2 border border-line bg-white px-4 py-3">
      <p className="flex items-center gap-2 font-medium text-ink"><Icon className={cx('h-5 w-5', c.connected ? (error ? 'text-rose' : 'text-sage') : 'text-stone')} />{name}
        <Badge tone={!c.connected ? 'neutral' : error ? 'rose' : 'sage'}>{!c.connected ? 'Not connected' : error ? 'Connection error' : 'Connected'}</Badge>
      </p>
      {error && c.message && <p className="mt-1 text-[13px] text-stone">{c.message}</p>}
    </div>
  );
}

function RunPanel({ run, running, onRetry }: { run: InventorySyncRunDTO; running: boolean; onRetry: () => void }) {
  const N = useStoreNames();
  const pctDone = run.total ? Math.round((run.processed / run.total) * 100) : running ? 5 : 100;
  return (
    <div className={cx('mt-4 rounded-xl2 border px-4 py-3', run.status === 'failed' ? 'border-rose/30 bg-rose/5' : run.status === 'partial' ? 'border-amber/30 bg-amber/5' : 'border-line bg-white')}>
      <div className="flex flex-wrap items-center gap-2 text-[14px]">
        <span className="font-medium text-ink">{running ? 'Sync in progress' : run.status === 'ok' ? 'Last sync finished' : run.status === 'partial' ? 'Last sync finished with problems' : 'Last sync failed'}</span>
        <span className="text-stone">{relative(run.startedAt)}{run.startedBy ? ` · ${run.startedBy}` : ` · ${run.trigger}`}</span>
        {!running && run.failed > 0 && <Button size="sm" className="ml-auto" icon={<RotateCcw className="h-4 w-4" />} onClick={onRetry}>Retry failed</Button>}
      </div>
      {running && (
        <div className="mt-2">
          <div className="h-2 overflow-hidden rounded-full bg-mist"><div className="h-full rounded-full bg-plum transition-all" style={{ width: `${pctDone}%` }} /></div>
          <p className="mt-1 text-[12px] text-stone">{run.stage ?? 'Working…'} {run.total ? `· ${run.processed} of ${run.total}` : ''}</p>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        <span className="text-sage">{run.updatedSquare} {N.square} updates</span>
        <span className="text-sage">{run.updatedShopify} {N.shopify} updates</span>
        <span className="text-stone">{run.unchanged} unchanged</span>
        <span className={run.failed ? 'text-rose' : 'text-stone'}>{run.failed} failed</span>
        <span className={run.attention ? 'text-amber' : 'text-stone'}>{run.attention} need attention</span>
      </div>
      {run.message && <p className="mt-1 text-[13px] text-ink-soft">{run.message}</p>}
    </div>
  );
}

function RunDetails({ run }: { run: InventorySyncRunDTO }) {
  const N = useStoreNames();
  if (!run.details.length) return <p className="text-sm text-stone">No product changes in this run.</p>;
  return (
    <ul className="divide-y divide-line rounded-xl2 border border-line bg-white">
      {run.details.map((d, i) => (
        <li key={i} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[14px]">
          <span className="min-w-0 flex-1"><span className="text-ink">{d.label}</span>{d.sku && <span className="ml-2 font-mono text-[12px] text-stone">{d.sku}</span>}<span className="block text-[12px] text-stone">{d.note}</span></span>
          <Badge tone={result(N)[d.result].tone}>{result(N)[d.result].label}</Badge>
        </li>
      ))}
    </ul>
  );
}

function Links({ status }: { status?: 'problems' }) {
  const N = useStoreNames();
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['inventory-sync-links', status ?? 'all'],
    queryFn: async () => {
      if (status !== 'problems') return (await api.get<{ links: InventorySyncLinkDTO[] }>('/inventory-sync/links')).links;
      const [a, b] = await Promise.all(['needs_attention', 'error'].map((s) => api.get<{ links: InventorySyncLinkDTO[] }>(`/inventory-sync/links?status=${s}`)));
      return [...a.links, ...b.links];
    },
  });
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<InventorySyncLinkDTO | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<'square' | 'shopify' | null>(null);
  const act = async (p: Promise<unknown>, msg: string) => {
    try {
      await p;
      toast(msg);
      qc.invalidateQueries({ queryKey: ['inventory-sync'] });
      qc.invalidateQueries({ queryKey: ['inventory-sync-links'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  if (isLoading) return <PageLoading />;
  const shown = (data ?? []).filter((l) => matches(q, l.label, l.sku));
  const resolvable = (l: InventorySyncLinkDTO) => l.shopifySyncEnabled && (l.status === 'needs_attention' || l.status === 'error');
  const canPick = shown.filter(resolvable);
  const selected = canPick.filter((l) => picked.has(l.id));
  const allPicked = canPick.length > 0 && selected.length === canPick.length;
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(canPick.map((l) => l.id)));
  // One at a time, so each product's own check (e.g. a product missing from a store) applies; failures are listed.
  const resolveSelected = async (use: 'square' | 'shopify') => {
    setBulk(use);
    const failed: string[] = [];
    for (const l of selected) {
      try { await api.post(`/inventory-sync/links/${l.id}/resolve`, { use }); } catch (e) { failed.push(`${l.label}: ${(e as Error).message}`); }
    }
    setBulk(null);
    setPicked(new Set());
    const done = selected.length - failed.length;
    if (done) toast(`${done} product${done === 1 ? '' : 's'} set to ${use === 'square' ? N.square : N.shopify}’s count`);
    if (failed.length) toast(`${failed.length} not updated — ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? '…' : ''}`, 'error');
    qc.invalidateQueries({ queryKey: ['inventory-sync'] });
    qc.invalidateQueries({ queryKey: ['inventory-sync-links'] });
  };
  if (!data?.length) return <div className="panel"><EmptyState icon={<CheckCircle2 className="h-9 w-9" />} title={status ? 'Nothing needs attention' : 'No linked products yet'}>{status ? 'Every linked product is in sync or waiting for the next run.' : 'Run a sync to pair products by SKU.'}</EmptyState></div>;
  return (
    <div className="space-y-3">
    <label className="relative block">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
      <input className="field h-11 pl-9 pr-9" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search linked products by name or SKU" aria-label="Search linked products" />
      {q && <button type="button" onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-stone hover:bg-mist hover:text-ink" aria-label="Clear search"><X className="h-4 w-4" /></button>}
    </label>
    {shown.length === 0 && <p className="text-[14px] text-stone">Nothing matches “{q}”.</p>}
    {canPick.length > 0 && (
      <div className="flex flex-wrap items-center gap-2 rounded-xl2 border border-line bg-white px-4 py-2.5 text-[14px]">
        <label className="mr-auto flex items-center gap-2 text-ink-soft">
          <input type="checkbox" checked={allPicked} onChange={toggleAll} aria-label="Select all products that need a decision" />
          {selected.length ? `${selected.length} selected` : `Select all ${canPick.length}${q ? ' shown' : ''} needing a decision`}
        </label>
        <Button size="sm" variant="secondary" disabled={!selected.length || !!bulk} loading={bulk === 'square'} onClick={() => resolveSelected('square')}>Use {N.square} for selected</Button>
        <Button size="sm" variant="secondary" disabled={!selected.length || !!bulk} loading={bulk === 'shopify'} onClick={() => resolveSelected('shopify')}>Use {N.shopify} for selected</Button>
      </div>
    )}
    {/* Phones: a card per product with its counts and the buttons to settle it. */}
    <ul className="space-y-2 sm:hidden">
      {shown.map((l) => {
        const badge = !l.shopifySyncEnabled ? <Badge>Separate stock</Badge> : <Badge tone={l.status === 'in_sync' ? 'sage' : l.status === 'needs_attention' ? 'amber' : l.status === 'error' ? 'rose' : 'neutral'}>{l.status === 'in_sync' ? 'In sync' : l.status === 'needs_attention' ? 'Needs attention' : l.status === 'error' ? 'Error' : 'Waiting'}</Badge>;
        return (
          <li key={l.id} className={cx('rounded-xl2 border bg-white p-3', picked.has(l.id) && resolvable(l) ? 'border-plum/40' : 'border-line')}>
            <div className="flex items-start gap-3">
              {resolvable(l) && <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-plum" checked={picked.has(l.id)} onChange={() => toggle(l.id)} aria-label={`Select ${l.label}`} />}
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium leading-snug text-ink">{l.label}</p>
                {l.sku && <p className="font-mono text-[12px] text-stone">{l.sku}</p>}
              </div>
              {badge}
            </div>
            {(l.issue || l.lastChange) && <p className={cx('mt-1.5 text-[13px]', l.issue ? 'text-rose' : 'text-stone')}>{l.issue ?? l.lastChange}</p>}
            <div className="mt-2 grid grid-cols-3 gap-2 text-center text-[12px] text-stone">
              <div className="rounded-lg bg-mist/60 py-1.5">{N.square}<b className="num block text-[16px] text-ink">{l.squareQuantity ?? '—'}</b></div>
              <div className="rounded-lg bg-mist/60 py-1.5">{N.shopify}<b className="num block text-[16px] text-ink">{l.shopifyQuantity ?? '—'}</b></div>
              <div className="rounded-lg bg-mist/60 py-1.5">Agreed<b className="num block text-[16px] text-ink-soft">{l.baselineQuantity ?? '—'}</b></div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {l.shopifySyncEnabled && (l.status === 'needs_attention' || l.status === 'error') && (
                <>
                  <Button size="sm" onClick={() => act(api.post(`/inventory-sync/links/${l.id}/resolve`, { use: 'square' }), `${N.shopify} set to ${N.square}’s count`)}>Use {N.square}</Button>
                  <Button size="sm" onClick={() => act(api.post(`/inventory-sync/links/${l.id}/resolve`, { use: 'shopify' }), `${N.square} set to ${N.shopify}’s count`)}>Use {N.shopify}</Button>
                </>
              )}
              <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(l)}>Edit</Button>
              <Button size="sm" variant="ghost" aria-label="Unlink" icon={<Unlink className="h-4 w-4" />} onClick={() => act(api.del(`/inventory-sync/links/${l.id}`), 'Unlinked — it won’t be synced')} />
            </div>
            <div className="mt-1"><ShopifySyncSwitch key={`${l.id}-${l.shopifySyncEnabled}`} variationId={l.squareVariationId} label={l.label} enabled={l.shopifySyncEnabled} canChange /></div>
          </li>
        );
      })}
    </ul>
    <div className="hidden overflow-x-auto rounded-xl2 border border-line bg-white sm:block">
      <table className="w-full min-w-[760px] text-left text-[14px]">
        <thead className="border-b border-line bg-mist/50 text-[12px] uppercase tracking-wide text-stone">
          <tr>{canPick.length > 0 && <th className="w-10 pl-4 pr-0 py-2"><input type="checkbox" checked={allPicked} onChange={toggleAll} aria-label="Select all" /></th>}<th className="px-4 py-2 font-medium">Product</th><th className="px-3 py-2 text-right font-medium">{N.square}</th><th className="px-3 py-2 text-right font-medium">{N.shopify}</th><th className="px-3 py-2 text-right font-medium">Agreed</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Sync to {N.shopify}</th><th /></tr>
        </thead>
        <tbody className="divide-y divide-line">
          {shown.map((l) => (
            <tr key={l.id} className={cx(picked.has(l.id) && resolvable(l) && 'bg-mist/40')}>
              {canPick.length > 0 && <td className="w-10 pl-4 pr-0 py-2.5">{resolvable(l) && <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} aria-label={`Select ${l.label}`} />}</td>}
              <td className="px-4 py-2.5"><span className="text-ink">{l.label}</span>{l.sku && <span className="ml-2 font-mono text-[12px] text-stone">{l.sku}</span>}{l.matchMethod === 'manual' && <Badge className="ml-1">Linked by hand</Badge>}
                {(l.issue || l.lastChange) && <span className={cx('block text-[12px]', l.issue ? 'text-rose' : 'text-stone')}>{l.issue ?? l.lastChange}</span>}</td>
              <td className="num px-3 py-2.5 text-right">{l.squareQuantity ?? '—'}</td>
              <td className="num px-3 py-2.5 text-right">{l.shopifyQuantity ?? '—'}</td>
              <td className="num px-3 py-2.5 text-right text-stone">{l.baselineQuantity ?? '—'}</td>
              <td className="px-3 py-2.5">{!l.shopifySyncEnabled ? <Badge>Separate stock</Badge> : <Badge tone={l.status === 'in_sync' ? 'sage' : l.status === 'needs_attention' ? 'amber' : l.status === 'error' ? 'rose' : 'neutral'}>{l.status === 'in_sync' ? 'In sync' : l.status === 'needs_attention' ? 'Needs attention' : l.status === 'error' ? 'Error' : 'Waiting'}</Badge>}</td>
              <td className="px-3 py-2.5"><ShopifySyncSwitch key={`${l.id}-${l.shopifySyncEnabled}`} variationId={l.squareVariationId} label={l.label} enabled={l.shopifySyncEnabled} canChange /></td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right">
                {l.shopifySyncEnabled && (l.status === 'needs_attention' || l.status === 'error') && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => act(api.post(`/inventory-sync/links/${l.id}/resolve`, { use: 'square' }), `${N.shopify} set to ${N.square}’s count`)}>Use {N.square}</Button>
                    <Button size="sm" variant="ghost" onClick={() => act(api.post(`/inventory-sync/links/${l.id}/resolve`, { use: 'shopify' }), `${N.square} set to ${N.shopify}’s count`)}>Use {N.shopify}</Button>
                  </>
                )}
                <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(l)}>Edit</Button>
                <Button size="sm" variant="ghost" aria-label="Unlink" icon={<Unlink className="h-4 w-4" />} onClick={() => act(api.del(`/inventory-sync/links/${l.id}`), 'Unlinked — it won’t be synced')} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {editing && <EditProductModal link={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Changes a linked product's SKU and/or stock count in both Square and Shopify at once. */
function EditProductModal({ link, onClose }: { link: InventorySyncLinkDTO; onClose: () => void }) {
  const N = useStoreNames();
  const toast = useToast();
  const qc = useQueryClient();
  const [sku, setSku] = useState(link.sku ?? '');
  const startQty = link.baselineQuantity ?? link.squareQuantity ?? link.shopifyQuantity;
  const [qty, setQty] = useState(startQty == null ? '' : String(startQty));
  const [saving, setSaving] = useState(false);
  const skuChanged = sku.trim() !== '' && sku.trim() !== (link.sku ?? '');
  const qtyChanged = qty !== '' && Number(qty) !== startQty;
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.patch<{ changed: string[] }>(`/inventory-sync/links/${link.id}/product`, {
        ...(skuChanged ? { sku: sku.trim() } : {}), ...(qtyChanged ? { quantity: Math.round(Number(qty)) } : {}),
      });
      toast(r.changed.length ? `Updated ${r.changed.join(', ')}.` : 'Both stores already had these values.');
      for (const k of ['inventory-sync', 'inventory-sync-links', 'square-inventory']) qc.invalidateQueries({ queryKey: [k] });
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Edit ${link.label}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} disabled={!skuChanged && !qtyChanged} onClick={save}>Save to both stores</Button></>}>
      <div className="space-y-4">
        <Field label="SKU" hint={`Written to ${N.square} and ${N.shopify}. It can’t be one another product already uses in either store.`}>
          <input className="field font-mono" value={sku} maxLength={120} onChange={(e) => setSku(e.target.value)} />
        </Field>
        <Field label="Stock count" hint={`Now: ${N.square} ${link.squareQuantity ?? '—'} · ${N.shopify} ${link.shopifyQuantity ?? '—'} (as of the last sync). Both are set to this and it becomes the agreed count.`}>
          <input type="number" min={0} step={1} className="field num w-32" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        {!link.shopifySyncEnabled && <p className="text-[13px] text-amber">Separate stock (not synced); saving still updates {N.shopify} this once.</p>}
      </div>
    </Modal>
  );
}

type UnmatchedItem = { id?: string; label: string; sku: string | null };
const matches = (q: string, ...fields: (string | null | undefined)[]) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
};

function Unmatched({ u, separate }: { u: InventorySyncOverviewDTO['unmatched']; separate: InventorySeparateDTO[] }) {
  const N = useStoreNames();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  // One product picked on each side → link them.
  const [pickSq, setPickSq] = useState<UnmatchedItem | null>(null);
  const [pickSh, setPickSh] = useState<UnmatchedItem | null>(null);
  const [showSeparate, setShowSeparate] = useState(false);
  const act = async (p: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await p();
      toast(msg);
      for (const k of ['inventory-sync', 'inventory-sync-links', 'sku-candidates']) qc.invalidateQueries({ queryKey: [k] });
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const mark = (store: 'square' | 'shopify', items: UnmatchedItem[]) => {
    const list = items.filter((i) => i.id).map((i) => ({ store, itemId: i.id!, label: i.label, sku: i.sku }));
    if (!list.length) return toast('Run a sync first, then try again.', 'error');
    const where = store === 'square' ? N.square : N.shopify;
    if (list.some((i) => i.itemId === pickSq?.id)) setPickSq(null);
    if (list.some((i) => i.itemId === pickSh?.id)) setPickSh(null);
    void act(() => api.post('/inventory-sync/separate', { items: list }), list.length === 1 ? `${list[0].label}: only in ${where}, not synced` : `${list.length} products marked only in ${where}`);
  };
  const link = async (copySku: boolean) => {
    if (!pickSq?.id || !pickSh?.id) return;
    const body = { squareVariationId: pickSq.id, shopifyInventoryItemId: pickSh.id };
    const ok = await act(
      () => api.post(copySku ? '/inventory-sync/links/from-shopify-sku' : '/inventory-sync/links/by-id', body),
      copySku ? `Square SKU set to ${pickSh.sku} and linked. The next sync matches their stock.` : `Linked: ${pickSq.label} ↔ ${pickSh.label}. The next sync matches their stock.`,
    );
    if (ok) { setPickSq(null); setPickSh(null); }
  };
  const sq = u.squareOnly.filter((i) => matches(q, i.label, i.sku));
  const sh = u.shopifyOnly.filter((i) => matches(q, i.label, i.sku));
  const sep = separate.filter((x) => matches(q, x.label, x.sku));

  const list = (title: string, store: 'square' | 'shopify', all: UnmatchedItem[], items: UnmatchedItem[], picked: UnmatchedItem | null, setPicked: (i: UnmatchedItem | null) => void) => (
    <section className="panel p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium text-ink"><Tc>{title} <span className="num text-stone">{q ? `${items.length} of ${all.length}` : all.length}</span></Tc></h3>
        {items.length > 1 && <Button size="sm" variant="ghost" disabled={busy} onClick={() => mark(store, items)}>{q ? 'Mark these only here' : 'Mark all only here'}</Button>}
      </div>
      <p className="mb-2 text-[12px] text-stone">Tap a product to pick it for linking.</p>
      <ul className="max-h-80 space-y-0.5 overflow-y-auto text-[13px]">
        {items.length === 0 && <li className="py-2 text-stone">{q ? 'Nothing matches the search.' : 'None.'}</li>}
        {items.map((i, n) => {
          const on = !!picked && picked.id === i.id;
          return (
            <li key={i.id ?? n} className={cx('flex items-center gap-2 rounded-lg px-2 py-1', on ? 'bg-plum-tint ring-1 ring-plum/40' : 'hover:bg-mist/60')}>
              <button type="button" disabled={!i.id} onClick={() => setPicked(on ? null : i)} className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default">
                <span className={cx('h-3.5 w-3.5 shrink-0 rounded-full border', on ? 'border-plum bg-plum' : 'border-line-strong')} />
                <span className="min-w-0 flex-1 truncate">{i.label}</span>
                <span className="font-mono text-stone">{i.sku ?? 'no SKU'}</span>
              </button>
              {i.id && <Button size="sm" variant="ghost" disabled={busy} title={`Sold only in ${store === 'square' ? N.square : N.shopify} — don’t sync`} onClick={() => mark(store, [i])}>Only here</Button>}
            </li>
          );
        })}
      </ul>
    </section>
  );

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-stone">These products exist in only one store (by SKU), so they aren’t synced. To link two, pick one on each side. If a product is sold in one store only, press <b>Only here</b>. A product still pairs and syncs if it ever gets a SKU matching the other store. Nothing is created in either store automatically.</p>
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
        <input className="field h-11 pl-9 pr-9" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search both stores by name or SKU" aria-label="Search unmatched products" />
        {q && <button type="button" onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-stone hover:bg-mist hover:text-ink" aria-label="Clear search"><X className="h-4 w-4" /></button>}
      </label>
      {(pickSq || pickSh) && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl2 border border-plum/30 bg-white px-4 py-3 text-[14px] shadow-lift">
          <span className="min-w-0 flex-1">
            <span className="block truncate"><span className="text-stone">{N.square}:</span> {pickSq ? <>{pickSq.label} <span className="font-mono text-[12px] text-stone">{pickSq.sku}</span></> : <i className="text-stone">pick one on the left</i>}</span>
            <span className="block truncate"><span className="text-stone">{N.shopify}:</span> {pickSh ? <>{pickSh.label} <span className="font-mono text-[12px] text-stone">{pickSh.sku}</span></> : <i className="text-stone">pick one on the right</i>}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => { setPickSq(null); setPickSh(null); }}>Clear</Button>
          {pickSq && pickSh?.sku && pickSq.sku !== pickSh.sku && <Button size="sm" disabled={busy} icon={<Tag className="h-4 w-4" />} onClick={() => link(true)}>Use {N.shopify} SKU in {N.square} &amp; link</Button>}
          <Button size="sm" variant="primary" disabled={busy || !pickSq || !pickSh} icon={<Link2 className="h-4 w-4" />} onClick={() => link(false)}>Link</Button>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {list(`Only in ${N.square}`, 'square', u.squareOnly, sq, pickSq, setPickSq)}
        {list(`Only in ${N.shopify}`, 'shopify', u.shopifyOnly, sh, pickSh, setPickSh)}
      </div>
      {(u.duplicates.length > 0 || u.noSku > 0) && (
        <p className="flex items-start gap-2 rounded-xl2 border border-amber/30 bg-amber/10 px-4 py-3 text-[13px] text-ink-soft"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
          {u.duplicates.length > 0 && <>Duplicate SKUs (skipped so nothing is overwritten): {u.duplicates.map((d) => `${d.sku} (${d.where} ×${d.count})`).join(', ')}. </>}
          {u.noSku > 0 && <>{u.noSku} product{u.noSku === 1 ? ' has' : 's have'} no SKU and can only be linked by hand.</>}
        </p>
      )}
      {separate.length > 0 && (
        <section className="panel p-4">
          <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setShowSeparate((v) => !v)}>
            <h3 className="font-medium text-ink"><Tc>Sold in one store only — not synced <span className="num text-stone">{q ? `${sep.length} of ${separate.length}` : separate.length}</span></Tc></h3>
            <span className="text-[13px] text-plum">{showSeparate || q ? 'Hide' : 'Show'}</span>
          </button>
          {(showSeparate || (q && sep.length > 0)) && (
            <ul className="mt-2 max-h-80 divide-y divide-line overflow-y-auto text-[13px]">
              {sep.map((x) => (
                <li key={`${x.store}-${x.itemId}`} className="flex items-center gap-2 py-1.5">
                  <Badge>{x.store === 'square' ? `${N.square} only` : `${N.shopify} only`}</Badge>
                  <span className="min-w-0 flex-1 truncate">{x.label}</span>
                  <span className="font-mono text-stone">{x.sku ?? 'no SKU'}</span>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.del(`/inventory-sync/separate/${x.store}/${encodeURIComponent(x.itemId)}`), `${x.label} is back under Not matched`)}>Undo</Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function AutoSettings({ s }: { s: InventorySyncOverviewDTO['settings'] }) {
  const N = useStoreNames();
  const toast = useToast();
  const qc = useQueryClient();
  const [d, setD] = useState(s);
  const [saving, setSaving] = useState(false);
  useEffect(() => setD(s), [s]);
  const dirty = JSON.stringify(d) !== JSON.stringify(s);
  const save = async () => {
    setSaving(true);
    try {
      await api.patch('/settings', { inventorySync: d });
      toast('Saved');
      qc.invalidateQueries({ queryKey: ['inventory-sync'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="panel p-5">
      <h2 className="h-display text-[22px]"><Tc>Automatic sync</Tc></h2>
      <div className="mt-3 space-y-4">
        <Toggle checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label="Sync automatically" description="On a schedule, and shortly after Square reports a stock change (webhook)." />
        <NumberField label="Every" unit="minutes" min={5} max={1440} value={d.intervalMinutes} onChange={(v) => setD({ ...d, intervalMinutes: v })} />
        <Field label="First time a product is paired and the counts differ, keep">
          <select className="field" value={d.firstSyncSource} onChange={(e) => setD({ ...d, firstSyncSource: e.target.value as any })}><option value="square">{N.square}’s count</option><option value="shopify">{N.shopify}’s count</option></select>
        </Field>
        <NumberField label="Hold changes bigger than" unit="units for review (0 = no limit)" min={0} max={10000} value={d.holdChangesOver} onChange={(v) => setD({ ...d, holdChangesOver: v })} />
        <Button variant="primary" disabled={!dirty} loading={saving} onClick={save}>Save</Button>
      </div>
    </section>
  );
}

function LinkModal({ onClose }: { onClose: () => void }) {
  const N = useStoreNames();
  const toast = useToast();
  const qc = useQueryClient();
  const [sq, setSq] = useState('');
  const [sh, setSh] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.post('/inventory-sync/links', { squareSku: sq, shopifySku: sh });
      toast('Linked. The next sync keeps them matched.');
      qc.invalidateQueries({ queryKey: ['inventory-sync'] });
      qc.invalidateQueries({ queryKey: ['inventory-sync-links'] });
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Link two products by SKU" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Link</Button></>}>
      <p className="mb-3 text-[14px] text-ink-soft">For the same product with different SKUs in {N.square} and {N.shopify}. Each product can only be linked once, so nothing is duplicated.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={`${N.square} SKU`}><input className="field font-mono" value={sq} onChange={(e) => setSq(e.target.value)} /></Field>
        <Field label={`${N.shopify} SKU`}><input className="field font-mono" value={sh} onChange={(e) => setSh(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

interface SkuCandidates { square: { variationId: string; label: string; sku: string | null }[]; shopify: { inventoryItemId: string; label: string; sku: string }[] }
const words = (v: string) => new Set(v.toLowerCase().replace(/[“”″]/g, '"').split(/[^a-z0-9#"]+/).filter((w) => w.length > 1));

/**
 * Sets a Square product's SKU to its Shopify product's SKU (in Square — nothing else changes) and pairs them, so the
 * stock sync handles them. The server refuses anything that would create duplicate SKUs.
 */
function SkuFromShopifyModal({ onClose }: { onClose: () => void }) {
  const N = useStoreNames();
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['sku-candidates'], queryFn: () => api.get<SkuCandidates>('/inventory-sync/sku-candidates') });
  const [sq, setSq] = useState('');
  const [sh, setSh] = useState('');
  const [saving, setSaving] = useState(false);
  const square = data?.square.find((p) => p.variationId === sq);
  const shopify = data?.shopify.find((p) => p.inventoryItemId === sh);
  // Shopify products whose names share the most words with the chosen Square product come first.
  const shopifyOptions = useMemo(() => {
    const list = data?.shopify ?? [];
    if (!square) return list;
    const mine = words(square.label);
    const score = (l: string) => [...words(l)].filter((w) => mine.has(w)).length;
    return [...list].sort((a, b) => score(b.label) - score(a.label));
  }, [data, square]);
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.post<{ sku: string; previousSku: string | null; changedInSquare: boolean }>('/inventory-sync/links/from-shopify-sku', { squareVariationId: sq, shopifyInventoryItemId: sh });
      toast(r.changedInSquare ? `Square SKU updated to ${r.sku} and paired. The next sync keeps their stock matched.` : `Paired (Square already had ${r.sku}).`);
      for (const k of ['inventory-sync', 'inventory-sync-links', 'sku-candidates', 'square-inventory']) qc.invalidateQueries({ queryKey: [k] });
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open side onClose={onClose} title={`Use ${N.shopify}’s SKU in ${N.square}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!square || !shopify} loading={saving} onClick={save}>{square && shopify && square.sku !== shopify.sku ? 'Update SKU in Square and pair' : 'Pair'}</Button></>}>
      <p className="mb-4 text-[14px] text-ink-soft">For the same product in both stores: the Square product gets the Shopify product’s SKU (only its SKU changes in Square), and the two are paired so the stock sync handles them. Needs Square’s ITEMS_WRITE permission.</p>
      {isLoading && <div className="flex justify-center py-6"><Spinner /></div>}
      {error && <p className="text-[14px] text-rose">{(error as Error).message}</p>}
      {data && (
        <div className="space-y-4">
          <Field label={`${N.square} product (not paired yet)`}>
            <select className="field h-11" value={sq} onChange={(e) => { setSq(e.target.value); setSh(''); }}>
              <option value="">Choose…</option>
              {data.square.map((p) => <option key={p.variationId} value={p.variationId}>{p.label} — {p.sku ? `SKU ${p.sku}` : 'no SKU'}</option>)}
            </select>
          </Field>
          <Field label={`${N.shopify} product to copy the SKU from`} hint={square ? 'Closest names first.' : undefined}>
            <select className="field h-11" value={sh} disabled={!square} onChange={(e) => setSh(e.target.value)}>
              <option value="">Choose…</option>
              {shopifyOptions.map((p) => <option key={p.inventoryItemId} value={p.inventoryItemId}>{p.label} — SKU {p.sku}</option>)}
            </select>
          </Field>
          {square && shopify && (
            <div className="rounded-xl border border-line bg-mist/50 p-3 text-[14px]">
              <p className="font-medium text-ink">{square.label}</p>
              <p className="mt-1 text-ink-soft">Square SKU: <span className="font-mono">{square.sku ?? '(none)'}</span> → <span className="font-mono font-medium text-ink">{shopify.sku}</span></p>
              {square.sku === shopify.sku && <p className="mt-1 text-[13px] text-stone">Already the same — they’ll just be paired.</p>}
            </div>
          )}
          {data.square.length === 0 && <p className="text-[14px] text-stone">Every {N.square} product is already paired.</p>}
        </div>
      )}
    </Modal>
  );
}
