import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { INVENTORY_STATUS_LABELS, type InventoryItemDTO, type InventoryRequestDTO, type InventoryStatus, type SquareInventoryDTO } from '@addendum/shared';
import { AlertCircle, ArrowLeftRight, CheckCircle2, Clock, Mail, Minus, Package, PackageCheck, Plus, RotateCw, Search, Send, ShoppingBag, Trash2, Truck, X } from 'lucide-react';
import { api, qs } from '../api/client';
import { useCanDo, useInventory, useInventorySuggestions, useIntegrations, useMe, useRefreshAll, useSettings, useStaff } from '../api/hooks';
import { dateShort, dateTime, relative } from '../lib/format';
import { SquareInventoryView } from './SquareInventory';
import { Badge, Button, EmptyState, ErrorNote, Field, Modal, PageHeader, PageLoading, Segmented, cx, useToast } from '../components/ui';

/**
 * Order Hair: Addendum Hair order requests. Stylists list what they need (Size, Color, Collection, QTY,
 * Needed By); the app emails it to the ordering contact (Settings → Order Hair, default
 * gaby@addendumhair.com) and tracks it. The Square inventory tab searches Square's stock (the source of truth);
 * administrators can push those counts to Shopify from there.
 */
export function InventoryPage() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'stock' ? 'stock' : 'orders';
  const status = params.get('status') ?? 'open';
  const scope = params.get('scope') ?? 'all';
  const openId = params.get('open');
  const canDo = useCanDo();
  const { data, isLoading, error, refetch } = useInventory({ status: status === 'everything' ? undefined : status, scope }, canDo('inventory:order') || canDo('inventory:read_all'));
  const { data: settings } = useSettings();
  const [composing, setComposing] = useState(params.get('new') === '1');
  const to = settings?.settings.inventory?.orderEmail ?? 'gaby@addendumhair.com';
  // "New → Order hair" from the top bar works even when already on this page.
  useEffect(() => {
    if (params.get('new') === '1') setComposing(true);
  }, [params]);
  const set = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    setParams(p, { replace: true });
  };

  return (
    <div className="animate-rise">
      <PageHeader
        title="Order Hair"
        subtitle={<>Order from Addendum Hair — sent to <span className="text-ink">{to}</span></>}
        actions={<>
          {canDo('inventory:sync') && <Link to="/inventory-sync" className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line-strong bg-white px-3 text-sm font-medium hover:bg-mist/60"><ArrowLeftRight className="h-4 w-4" />Inventory Sync</Link>}
          {canDo('inventory:order') && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setComposing(true)}>New hair order</Button>}
        </>}
      />
      {canDo('inventory:view') && (canDo('inventory:order') || canDo('inventory:read_all')) && (
        <div className="mb-4">
          <Segmented value={view} onChange={(v) => set('view', v === 'stock' ? 'stock' : null)} options={[{ value: 'orders', label: 'Hair orders' }, { value: 'stock', label: 'Square inventory' }]} />
        </div>
      )}
      {view === 'stock' || !(canDo('inventory:order') || canDo('inventory:read_all')) ? <SquareInventoryView /> : (
      <>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Segmented value={status} onChange={(v) => set('status', v === 'open' ? null : v)} options={[
          { value: 'open', label: 'Open' }, { value: 'received', label: 'Received' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'everything', label: 'All' },
        ]} />
        {data?.seesAll && <Segmented value={scope} onChange={(v) => set('scope', v === 'all' ? null : v)} options={[{ value: 'all', label: 'Everyone' }, { value: 'mine', label: 'Mine' }]} />}
      </div>

      {isLoading && <PageLoading />}
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {data && data.requests.length === 0 && (
        <div className="panel">
          <EmptyState icon={<Package className="h-9 w-9" />} title={status === 'open' ? 'No open orders' : 'Nothing here'} action={<Button variant="primary" onClick={() => setComposing(true)}>New hair order</Button>}>
            Need hair for an install? Add it to an order and it goes straight to Addendum Hair.
          </EmptyState>
        </div>
      )}
      <ul className="space-y-3">
        {data?.requests.map((r) => <RequestCard key={r.id} r={r} canManage={data.canManage} onOpen={() => set('open', r.id)} />)}
      </ul>
      </>
      )}

      {composing && <ComposeRequest onClose={() => { setComposing(false); set('new', null); }} to={to} />}
      {openId && <RequestDetail id={openId} onClose={() => set('open', null)} canManage={!!data?.canManage} seesAll={!!data?.seesAll} />}
    </div>
  );
}

const STATUS_TONE: Record<InventoryStatus, 'plum' | 'amber' | 'sage' | 'neutral'> = { submitted: 'plum', ordered: 'amber', received: 'sage', cancelled: 'neutral' };
const STATUS_ICON: Record<InventoryStatus, typeof Clock> = { submitted: Clock, ordered: Truck, received: PackageCheck, cancelled: X };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const neededLabel = (d: string | null) => (d ? dateShort(`${d}T12:00:00Z`) : '—');

function EmailLine({ r }: { r: InventoryRequestDTO }) {
  const e = r.email;
  if (e.status === 'sent') return <span className="inline-flex items-center gap-1 text-sage"><CheckCircle2 className="h-3.5 w-3.5" />Emailed to {e.to}{e.sentAt ? ` · ${relative(e.sentAt)}` : ''}</span>;
  if (e.status === 'not_configured') return <span className="inline-flex items-center gap-1 text-amber"><AlertCircle className="h-3.5 w-3.5" />Saved — email isn't set up yet, so it hasn't been sent</span>;
  if (e.status === 'failed') return <span className="inline-flex items-center gap-1 text-rose"><AlertCircle className="h-3.5 w-3.5" />Email not sent yet — retrying automatically</span>;
  return <span className="inline-flex items-center gap-1 text-stone"><Mail className="h-3.5 w-3.5" />Sending…</span>;
}

function useActions(r: InventoryRequestDTO) {
  const refresh = useRefreshAll();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try {
      await fn();
      toast(msg);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  return {
    busy,
    status: (s: InventoryStatus, msg: string) => run(s, () => api.patch(`/inventory/requests/${r.id}`, { status: s }), msg),
    resend: () => run('resend', async () => {
      const res = await api.post<{ request: InventoryRequestDTO }>(`/inventory/requests/${r.id}/resend`);
      if (res.request.email.status !== 'sent') throw new Error(res.request.email.error ?? 'The email could not be sent.');
    }, `Emailed to ${r.email.to}`),
  };
}

const ITEM_GRID = 'grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,1.6fr)_2.75rem_minmax(0,1fr)] gap-x-3';

/** Size · Color · Collection · QTY · Needed By, in that order, for scanning at a glance. */
function ItemsGrid({ items, renderNeededBy }: {
  r: InventoryRequestDTO;
  items: InventoryItemDTO[];
  renderNeededBy?: (i: InventoryItemDTO) => React.ReactNode;
}) {
  return (
    <div className="text-[14px]">
      <div className={cx(ITEM_GRID, 'border-b border-line pb-1.5 text-[12px] font-medium uppercase tracking-wide text-stone')}>
        <span>Size</span><span>Color</span><span>Collection</span><span className="text-right">QTY</span><span>Needed By</span>
      </div>
      <ul>
        {items.map((i) => (
          <li key={i.id} className="border-b border-line/60 py-2 last:border-0">
            <div className={cx(ITEM_GRID, 'items-baseline')}>
              <span className="break-words text-ink">{i.size ?? '—'}</span>
              <span className="break-words text-ink">{i.color ?? '—'}</span>
              <span className="break-words font-medium text-ink">{i.collection}</span>
              <span className="num text-right font-medium text-ink">{i.quantity}</span>
              <span className="text-ink-soft">{renderNeededBy ? renderNeededBy(i) : neededLabel(i.neededBy)}</span>
            </div>
            {(i.legacyDetails || i.clientName || i.note) && (
              <p className="mt-0.5 text-xs text-stone">{[i.legacyDetails, i.clientName ? `For ${i.clientName}` : null, i.note].filter(Boolean).join(' · ')}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RequestCard({ r, canManage, onOpen }: { r: InventoryRequestDTO; canManage: boolean; onOpen: () => void }) {
  const { data: me } = useMe();
  const a = useActions(r);
  const Icon = STATUS_ICON[r.status];
  const own = r.forStaffId === me?.id || r.requestedById === me?.id;
  return (
    <li className="panel px-4 py-4 sm:px-5">
      <button onClick={onOpen} className="block w-full text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-[22px] leading-none text-ink">#{r.number} · {r.forStaffName ?? 'Stylist'}</span>
          <Badge tone={STATUS_TONE[r.status]}><Icon className="h-3 w-3" />{INVENTORY_STATUS_LABELS[r.status]}</Badge>
        </div>
        <div className="mt-3">
          <ItemsGrid r={r} items={r.items.slice(0, 4)} />
          {r.items.length > 4 && <p className="pt-1 text-[13px] text-stone">+ {r.items.length - 4} more</p>}
        </div>
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone">
          <span>Requested {relative(r.createdAt)}{r.requestedByName && r.requestedByName !== r.forStaffName ? ` by ${r.requestedByName}` : ''}</span>
          <EmailLine r={r} />
        </p>
      </button>
      <div className="mt-3 flex flex-wrap gap-2">
        {canManage && r.status === 'submitted' && <Button size="sm" variant="primary" icon={<Truck className="h-4 w-4" />} loading={a.busy === 'ordered'} disabled={!!a.busy} onClick={() => a.status('ordered', `#${r.number} marked ordered`)}>Mark ordered</Button>}
        {canManage && (r.status === 'submitted' || r.status === 'ordered') && <Button size="sm" icon={<PackageCheck className="h-4 w-4" />} loading={a.busy === 'received'} disabled={!!a.busy} onClick={() => a.status('received', `#${r.number} received`)}>Mark received</Button>}
        {(r.email.status === 'failed' || r.email.status === 'not_configured') && r.status !== 'cancelled' && (canManage || own) && <Button size="sm" icon={<RotateCw className="h-4 w-4" />} loading={a.busy === 'resend'} onClick={a.resend}>Send email now</Button>}
        {r.status === 'submitted' && (canManage || own) && <Button size="sm" variant="ghost" loading={a.busy === 'cancelled'} onClick={() => a.status('cancelled', `#${r.number} cancelled`)}>Cancel</Button>}
      </div>
    </li>
  );
}

/** `sku` is set when the line was picked from inventory; editing the line by hand clears it. */
interface Line { key: number; collection: string; size: string; color: string; quantity: number; neededBy: string; sku: string }
interface Pick { collection: string; size?: string | null; color?: string | null; sku?: string | null }
let lineKey = 0;
const blank = (neededBy = '', pick?: Partial<Pick>): Line => ({
  key: ++lineKey, collection: pick?.collection ?? '', size: pick?.size ?? '', color: pick?.color ?? '', quantity: 1, neededBy, sku: pick?.sku ?? '',
});

/** Square variation names read like `20" / #60 Platinum`: the length goes in Size, the rest in Color. */
function fromProduct(p: SquareInventoryDTO): Pick {
  const parts = (p.variationName ?? '').split(/\s+[/|·]\s+|\s*\|\s*/).map((x) => x.trim()).filter(Boolean);
  const size = parts.find((x) => /^\d+(\.\d+)?\s*("|”|''|in\b|inch)/i.test(x)) ?? '';
  return { collection: p.itemName, size, color: parts.filter((x) => x !== size).join(' / '), sku: p.sku };
}

function ComposeRequest({ onClose, to }: { onClose: () => void; to: string }) {
  const { data: me } = useMe();
  const canDo = useCanDo();
  // Only receptionists and admins can order for someone else; stylists always order for themselves.
  const forOthers = canDo('inventory:order_for_others');
  const { data: staff } = useStaff(forOthers);
  const { data: sugg } = useInventorySuggestions();
  const { data: integ } = useIntegrations(canDo('dashboard:view'));
  const refresh = useRefreshAll();
  const toast = useToast();
  const [forStaffId, setForStaffId] = useState<string>('');
  const [lines, setLines] = useState<Line[]>(() => [blank()]);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const who = forStaffId || me?.id || '';
  const filled = lines.filter((l) => l.collection.trim());
  const units = filled.reduce((a, l) => a + l.quantity, 0);

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  // A new line starts with the previous line's needed-by date, since orders are usually for one install.
  const addLine = (pick?: Pick) => setLines((ls) => {
    // Picking the same inventory product again adds one more instead of a second line.
    const same = pick?.sku && ls.find((l) => l.sku === pick.sku);
    if (same) return ls.map((l) => (l.key === same.key ? { ...l, quantity: Math.min(999, l.quantity + 1) } : l));
    const empty = pick && ls.find((l) => !l.collection.trim());
    if (empty) return ls.map((l) => (l.key === empty.key ? { ...l, collection: pick.collection, size: pick.size ?? '', color: pick.color ?? '', sku: pick.sku ?? '' } : l));
    return [...ls, blank(ls.at(-1)?.neededBy ?? '', pick)];
  });
  const quick = useMemo(() => ({
    recent: (sugg?.recent ?? []).slice(0, 6),
    collections: (sugg?.collections ?? []).slice(0, 10),
  }), [sugg]);

  const send = async () => {
    setSending(true);
    try {
      const r = await api.post<{ request: InventoryRequestDTO }>('/inventory/requests', {
        forStaffId: who || undefined, note: note || null,
        items: filled.map((l) => ({
          collection: l.collection, size: l.size || null, color: l.color || null, quantity: l.quantity, neededBy: l.neededBy || null,
          note: l.sku ? `SKU ${l.sku}` : null,
        })),
      });
      const e = r.request.email;
      if (e.status === 'sent') toast(`Order #${r.request.number} sent to ${e.to}`);
      else toast(e.status === 'not_configured' ? `Order #${r.request.number} saved — email isn't set up yet` : `Order #${r.request.number} saved — email will be retried`, 'error');
      refresh();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open side onClose={onClose} title="New hair order"
      footer={
        <>
          <span className="mr-auto text-[13px] text-stone">{filled.length ? `${plural(filled.length, 'item')} · ${plural(units, 'unit')}` : 'Add a collection to send'}</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Send className="h-4 w-4" />} loading={sending} disabled={!filled.length} onClick={send}>Send to Addendum Hair</Button>
        </>
      }
    >
      <p className="mb-4 flex items-start gap-2 rounded-lg bg-mist px-3 py-2 text-[13px] text-ink-soft"><Mail className="mt-0.5 h-4 w-4 shrink-0 text-stone" /><span>Emailed to <b className="break-all font-medium text-ink">{to}</b>{integ?.demoMode ? ' · Demo Mode, not actually sent' : ''}</span></p>

      {forOthers && (
        <Field label="For stylist">
          <select className="field" value={who} onChange={(e) => setForStaffId(e.target.value)}>
            {staff?.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === me?.id ? ' (me)' : ''}</option>)}
          </select>
        </Field>
      )}

      <HairSearch onPick={(p) => addLine(fromProduct(p))} added={new Map(lines.filter((l) => l.sku).map((l) => [l.sku, l.quantity]))} />

      {(quick.collections.length > 0 || quick.recent.length > 0) && (
        <div className="mt-4">
          <span className="label">Quick add</span>
          <div className="flex flex-wrap gap-1.5">
            {quick.recent.map((r) => <button key={`${r.collection}|${r.size}|${r.color}`} onClick={() => addLine(r)} className="rounded-full border border-line bg-white px-2.5 py-1 text-xs text-ink-soft hover:border-plum/40 hover:bg-plum-tint">{[r.size, r.color, r.collection].filter(Boolean).join(' · ')}</button>)}
            {quick.collections.map((c) => <button key={c} onClick={() => addLine({ collection: c })} className="rounded-full bg-mist px-2.5 py-1 text-xs text-ink-soft hover:bg-plum-tint">+ {c}</button>)}
          </div>
        </div>
      )}

      <div className="mt-4">
        <span className="label">Items</span>
        <datalist id="hair-collections">{sugg?.collections.map((p) => <option key={p} value={p} />)}</datalist>
        <datalist id="hair-sizes">{sugg?.sizes.map((p) => <option key={p} value={p} />)}</datalist>
        <datalist id="hair-colors">{sugg?.colors.map((p) => <option key={p} value={p} />)}</datalist>
        <ul className="space-y-2">
          {lines.map((l, idx) => (
            <li key={l.key} className="rounded-xl border border-line bg-white p-3">
              <div className="grid gap-2 sm:grid-cols-[0.8fr_1.2fr_1.6fr]">
                <label className="block"><span className="mb-1 block text-xs text-stone">Size</span><input className="field" list="hair-sizes" value={l.size} onChange={(e) => update(l.key, { size: e.target.value, sku: '' })} placeholder='20"' aria-label={`Item ${idx + 1} size`} maxLength={80} /></label>
                <label className="block"><span className="mb-1 block text-xs text-stone">Color</span><input className="field" list="hair-colors" value={l.color} onChange={(e) => update(l.key, { color: e.target.value, sku: '' })} placeholder="#60 Platinum" aria-label={`Item ${idx + 1} color`} maxLength={120} /></label>
                <label className="block"><span className="mb-1 block text-xs text-stone">Collection</span><input className="field" list="hair-collections" value={l.collection} onChange={(e) => update(l.key, { collection: e.target.value, sku: '' })} placeholder="Hand-Tied Weft" aria-label={`Item ${idx + 1} collection`} maxLength={160} /></label>
              </div>
              {l.sku && <p className="mt-1.5 text-[12px] text-stone">From inventory · SKU <span className="font-mono">{l.sku}</span></p>}
              <div className="mt-2 flex flex-wrap items-end gap-3">
                <div>
                  <span className="mb-1 block text-xs text-stone">QTY</span>
                  <div className="flex items-center gap-1" role="group" aria-label={`Item ${idx + 1} quantity`}>
                    <button className="flex h-9 w-9 items-center justify-center rounded-lg border border-line-strong text-ink-soft hover:bg-mist disabled:opacity-40" disabled={l.quantity <= 1} onClick={() => update(l.key, { quantity: l.quantity - 1 })} aria-label="Fewer"><Minus className="h-4 w-4" /></button>
                    <input className="field h-9 w-14 py-0 text-center num" inputMode="numeric" value={l.quantity} onChange={(e) => update(l.key, { quantity: Math.max(1, Math.min(999, Number(e.target.value.replace(/\D/g, '')) || 1)) })} aria-label="Quantity" />
                    <button className="flex h-9 w-9 items-center justify-center rounded-lg border border-line-strong text-ink-soft hover:bg-mist disabled:opacity-40" disabled={l.quantity >= 999} onClick={() => update(l.key, { quantity: Math.min(999, l.quantity + 1) })} aria-label="More"><Plus className="h-4 w-4" /></button>
                  </div>
                </div>
                <label className="block"><span className="mb-1 block text-xs text-stone">Needed By</span><input type="date" className="field h-9 py-0" value={l.neededBy} onChange={(e) => update(l.key, { neededBy: e.target.value })} aria-label={`Item ${idx + 1} needed by`} /></label>
                {lines.length > 1 && <button className="ml-auto rounded-lg p-1.5 text-stone hover:bg-mist hover:text-rose" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove item ${idx + 1}`}><Trash2 className="h-4 w-4" /></button>}
              </div>
            </li>
          ))}
        </ul>
        <Button size="sm" className="mt-2" icon={<Plus className="h-4 w-4" />} onClick={() => addLine()}>Add another item</Button>
      </div>

      <Field label="Note for Addendum Hair (optional)" className="mt-5">
        <textarea className="field min-h-[70px]" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="e.g. For Sarah's install on the 14th" />
      </Field>
    </Modal>
  );
}

/** Hair-normalised text, matching the server's search: curly quotes and '' read as an inch mark. */
const norm = (v: string) => v.toLowerCase().replace(/[“”″]|''|’’/g, '"').replace(/[‘’′]/g, "'");

/**
 * Search the salon's Square products (name, texture, length, colour, SKU) and add them to the order in one tap.
 * Read-only: uses the same product list as the Square inventory tab, limited to stocked products.
 */
function HairSearch({ onPick, added }: { onPick: (p: SquareInventoryDTO) => void; added: Map<string, number> }) {
  const [text, setText] = useState('');
  const [serverQ, setServerQ] = useState('');
  const all = useQuery({
    queryKey: ['order-hair-products'],
    queryFn: () => api.get<{ products: SquareInventoryDTO[]; total: number }>(`/inventory/products${qs({ orderable: true, limit: 500 })}`),
    staleTime: 60_000,
  });
  // Very large catalogs: the first 500 are filtered here; beyond that, ask the server too.
  const partial = !!all.data && all.data.total > all.data.products.length;
  useEffect(() => {
    if (!partial) return;
    const t = window.setTimeout(() => setServerQ(text.trim()), 200);
    return () => window.clearTimeout(t);
  }, [text, partial]);
  const remote = useQuery({
    queryKey: ['order-hair-products', serverQ],
    queryFn: () => api.get<{ products: SquareInventoryDTO[]; total: number }>(`/inventory/products${qs({ orderable: true, q: serverQ, limit: 100 })}`),
    enabled: partial && !!serverQ,
    placeholderData: keepPreviousData,
  });
  const words = norm(text).split(/\s+/).filter(Boolean);
  const results = (partial && serverQ ? remote.data?.products ?? [] : all.data?.products ?? [])
    .filter((p) => words.every((w) => norm([p.itemName, p.variationName, p.sku, p.upc].filter(Boolean).join(' ')).includes(w)));

  return (
    <div className="sticky top-0 z-10 -mx-5 mt-4 border-b border-line bg-white px-5 pb-3 pt-1">
      <span className="label">Find hair in inventory</span>
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
        <input
          className="field h-10 pl-9 pr-9" type="search" inputMode="search" value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Name, texture, length, colour or SKU" aria-label="Search hair inventory"
        />
        {text && (
          <button type="button" onClick={() => setText('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-stone hover:bg-mist hover:text-ink" aria-label="Clear search">
            <X className="h-4 w-4" />
          </button>
        )}
      </label>
      {all.error ? <p className="mt-2 text-[13px] text-rose">Inventory couldn’t be loaded. You can still type the item below.</p> : (
        <ul className="mt-2 max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {all.isLoading && <li className="px-3 py-3 text-[13px] text-stone">Loading inventory…</li>}
          {!all.isLoading && results.length === 0 && (
            <li className="px-3 py-3 text-[13px] text-stone">
              {text ? <>No products match “{text}”. <button type="button" className="text-plum hover:underline" onClick={() => setText('')}>Show all inventory</button>, or type the item below.</> : 'No stocked products in Square yet. Type the item below.'}
            </li>
          )}
          {results.map((p) => {
            const n = p.sku ? added.get(p.sku) : undefined;
            return (
              <li key={p.variationId}>
                <button type="button" onClick={() => onPick(p)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-plum-tint/40">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-ink">{p.itemName}</span>
                    <span className="block truncate text-[13px] text-ink-soft">{[p.variationName, p.sku && `SKU ${p.sku}`].filter(Boolean).join(' · ') || '—'}</span>
                  </span>
                  <span className={cx('shrink-0 text-[12px]', p.quantity != null && p.quantity <= 0 ? 'text-rose' : 'text-stone')}>{p.quantity == null ? '' : p.quantity <= 0 ? 'Out of stock' : `${p.quantity} in salon`}</span>
                  <span className={cx('inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] font-medium', n ? 'bg-plum-tint text-plum' : 'border border-line-strong text-ink-soft')}>
                    <Plus className="h-3.5 w-3.5" />{n ? `Added ×${n}` : 'Add'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {text && results.length > 0 && <p className="mt-1 text-[12px] text-stone">{results.length} match{results.length === 1 ? '' : 'es'} · tap to add, then set the quantity below</p>}
    </div>
  );
}

function RequestDetail({ id, onClose, canManage, seesAll }: { id: string; onClose: () => void; canManage: boolean; seesAll: boolean }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['inventory', 'one', id], queryFn: () => api.get<{ request: InventoryRequestDTO }>(`/inventory/requests/${id}`).then((r) => r.request) });
  return (
    <Modal open side onClose={onClose} title={data ? `Hair order #${data.number}` : 'Hair order'}>
      {isLoading && <PageLoading />}
      {error && <ErrorNote error={error} />}
      {data && <DetailBody r={data} canManage={canManage} seesAll={seesAll} />}
    </Modal>
  );
}

function DetailBody({ r, canManage, seesAll }: { r: InventoryRequestDTO; canManage: boolean; seesAll: boolean }) {
  const { data: me } = useMe();
  const a = useActions(r);
  const refresh = useRefreshAll();
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  const Icon = STATUS_ICON[r.status];
  const own = r.forStaffId === me?.id || r.requestedById === me?.id;
  const canEditDates = canManage || ((own || seesAll) && (r.status === 'submitted' || r.status === 'ordered'));

  const patchItem = async (i: InventoryItemDTO, body: { neededBy: string | null }, msg: string) => {
    setSaving(i.id);
    try {
      await api.patch(`/inventory/requests/${r.id}/items/${i.id}`, body);
      toast(msg);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[r.status]}><Icon className="h-3 w-3" />{INVENTORY_STATUS_LABELS[r.status]}</Badge>
        </div>
        <p className="mt-2 text-sm text-ink-soft">For <b className="font-medium text-ink">{r.forStaffName ?? 'stylist'}</b>{r.requestedByName && r.requestedByName !== r.forStaffName ? ` · submitted by ${r.requestedByName}` : ''} · {dateTime(r.createdAt)}</p>
        {r.statusChangedAt && r.status !== 'submitted' && <p className="text-sm text-stone">{INVENTORY_STATUS_LABELS[r.status]} {relative(r.statusChangedAt)}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {canManage && r.status === 'submitted' && <Button size="sm" variant="primary" icon={<Truck className="h-4 w-4" />} loading={a.busy === 'ordered'} disabled={!!a.busy} onClick={() => a.status('ordered', 'Marked ordered')}>Mark ordered</Button>}
          {canManage && (r.status === 'submitted' || r.status === 'ordered') && <Button size="sm" icon={<PackageCheck className="h-4 w-4" />} loading={a.busy === 'received'} disabled={!!a.busy} onClick={() => a.status('received', 'Marked received')}>Mark received</Button>}
          {r.status !== 'cancelled' && <Button size="sm" icon={<RotateCw className="h-4 w-4" />} loading={a.busy === 'resend'} onClick={a.resend}>{r.email.status === 'sent' ? 'Email again' : 'Send email now'}</Button>}
        </div>
      </div>

      <section>
        <h3 className="mb-2 font-display text-xl">Items</h3>
        <ItemsGrid
          r={r}
          items={r.items}
          renderNeededBy={canEditDates ? (i) => (
            <input
              type="date" className="field h-8 w-full min-w-0 px-1.5 py-0 text-[13px]" value={i.neededBy ?? ''} disabled={saving === i.id}
              onChange={(e) => patchItem(i, { neededBy: e.target.value || null }, e.target.value ? `Needed by ${neededLabel(e.target.value)}` : 'Needed-by date cleared')}
              aria-label={`Needed by for ${i.collection}`}
            />
          ) : undefined}
        />
        <p className="mt-2 text-[13px] text-stone">{plural(r.items.length, 'item')} · {plural(r.totalUnits, 'unit')}</p>
        {r.note && <p className="mt-3 rounded-xl bg-mist px-3 py-2 text-sm text-ink-soft">{r.note}</p>}
      </section>

      <section>
        <h3 className="mb-2 font-display text-xl">Email</h3>
        <p className="text-[13px]"><EmailLine r={r} /></p>
        {r.email.error && r.email.status !== 'sent' && <p className="mt-1 text-[13px] text-stone">{r.email.error}</p>}
        {r.email.text && (
          <div className={cx('mt-3 rounded-xl border border-line bg-white p-3')}>
            <p className="text-[13px] text-stone">To: {r.email.to}</p>
            {r.email.cc.length > 0 && <p className="text-[13px] text-stone">Cc: {r.email.cc.join(', ')}</p>}
            <p className="text-[13px] font-medium text-ink">{r.email.subject}</p>
            <pre className="mt-2 whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-ink-soft">{r.email.text}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
