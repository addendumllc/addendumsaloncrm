import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { INVENTORY_STATUS_LABELS, hairParts, type OrderHairLayout, type InventoryItemDTO, type InventoryRequestDTO, type InventoryStatus } from '@addendum/shared';
import { AlertCircle, ArrowLeftRight, CheckCircle2, ChevronRight, Clock, Mail, Minus, Package, PackageCheck, Plus, RotateCw, Search, Send, ShoppingBag, Trash2, Truck, X } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { useCanDo, useInventory, useInventorySuggestions, useIntegrations, useMe, useRefreshAll, useStaff } from '../api/hooks';
import { addDaysKey, dateShort, dateTime, dayKey, relative } from '../lib/format';
import { SquareInventoryView } from './SquareInventory';
import { useWorkspace } from '../lib/workspace';
import { Badge, Button, EmptyState, ErrorNote, Field, Modal, PageHeader, PageLoading, Segmented, cx, useToast } from '../components/ui';
import { Tc } from '../lib/titleCase';

/**
 * Order Hair: Addendum Hair order requests. Stylists list what they need (Size, Color, Collection, QTY,
 * Needed By); the app emails it to the ordering contact (Settings → Order Hair, default
 * Addendum Hair's address) and tracks it. Staff see only “Addendum Hair”, never the address.
 * Square's stock (with the push to Shopify) is under Inventory Sync → Square inventory.
 */
export function InventoryPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'open';
  const scope = params.get('scope') ?? 'all';
  const openId = params.get('open');
  const canDo = useCanDo();
  const { data, isLoading, error, refetch } = useInventory({ status: status === 'everything' ? undefined : status, scope }, canDo('inventory:order') || canDo('inventory:read_all'));
  const [composing, setComposing] = useState(params.get('new') === '1');
  // "New → Order hair" from the top bar works even when already on this page.
  useEffect(() => {
    if (params.get('new') === '1') setComposing(true);
  }, [params]);
  const set = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    setParams(p, { replace: true });
  };

  const ws = useWorkspace();
  return (
    <div className="animate-rise">
      {/* A new order: a centred popup (collection → length → colour → quantity, with the order beside it). */}
      {composing && <ComposeRequest onClose={() => { setComposing(false); set('new', null); }} />}
      {/* Order Hair wears Addendum Hair's look, but it's the salon ordering: say so. */}
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone">{ws.names.salon.name} · ordering from {ws.names.hair.name}</p>
      <PageHeader
        title="Order Hair"
        subtitle={`Hair, tools and accessories from ${ws.names.hair.name}, sent from the salon`}
        actions={<>
          {canDo('inventory:sync') && <Link to="/inventory-sync" className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line-strong bg-white px-3 text-sm font-medium hover:bg-mist/60"><ArrowLeftRight className="h-4 w-4" />Inventory</Link>}
          {canDo('inventory:order') && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setComposing(true)}>New hair order</Button>}
        </>}
      />
      {/* Square inventory lives under Inventory Sync; people who can only view stock (no ordering, no sync) still see it here. */}
      {!(canDo('inventory:order') || canDo('inventory:read_all')) ? <SquareInventoryView /> : (
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
  if (e.status === 'sent') return <span className="inline-flex items-center gap-1 text-sage"><CheckCircle2 className="h-3.5 w-3.5" />Sent to Addendum Hair{e.sentAt ? ` · ${relative(e.sentAt)}` : ''}</span>;
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
    }, 'Sent to Addendum Hair'),
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
            {(i.sku || i.legacyDetails || i.clientName || i.note) && (
              <p className="mt-0.5 text-xs text-stone">{[i.sku ? `SKU ${i.sku} · from inventory` : null, i.legacyDetails, i.clientName ? `For ${i.clientName}` : null, i.note].filter(Boolean).join(' · ')}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Whether the order's picked items were taken out of Shopify stock. */
function InventoryBadge({ r }: { r: InventoryRequestDTO }) {
  if (r.inventoryStatus === 'reserved') return <Badge tone="sage">Taken from Shopify</Badge>;
  if (r.inventoryStatus === 'reserving') return <Badge tone="rose">Not finished — Shopify didn’t confirm</Badge>;
  return null;
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
          {r.customerName && <span className="text-[13px] text-ink-soft">for {r.customerName}</span>}
          <Badge tone={STATUS_TONE[r.status]}><Icon className="h-3 w-3" />{INVENTORY_STATUS_LABELS[r.status]}</Badge>
          <InventoryBadge r={r} />
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

interface ShopifyOption { sku: string; label: string; product: string; variant: string | null; size: string | null; color: string | null; available: number }
/** A line is either a Shopify product (taken out of inventory) or typed by hand (emailed only, inventory untouched). */
type Line =
  | { key: number; kind: 'inventory'; option: ShopifyOption; quantity: number }
  | { key: number; kind: 'typed'; collection: string; size: string; color: string; quantity: number };
let lineKey = 0;
const typedLine = (pick?: { collection?: string; size?: string | null; color?: string | null }): Line =>
  ({ key: ++lineKey, kind: 'typed', collection: pick?.collection ?? '', size: pick?.size ?? '', color: pick?.color ?? '', quantity: 1 });

/** Hair-normalised text for searching: curly quotes and '' read as an inch mark. */
const norm = (v: string) => v.toLowerCase().replace(/[“”″]|''|’’/g, '"').replace(/[‘’′]/g, "'");

function Stepper({ value, max, onChange, label }: { value: number; max: number; onChange: (n: number) => void; label: string }) {
  const clamp = (n: number) => Math.max(1, Math.min(max, n));
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      <button type="button" className="flex h-10 w-10 items-center justify-center rounded-lg border border-line-strong text-ink-soft hover:bg-mist disabled:opacity-40" disabled={value <= 1} onClick={() => onChange(clamp(value - 1))} aria-label="Fewer"><Minus className="h-4 w-4" /></button>
      <input className="field h-10 w-16 py-0 text-center num" inputMode="numeric" value={value} onChange={(e) => onChange(clamp(Number(e.target.value.replace(/\D/g, '')) || 1))} aria-label="Quantity" />
      <button type="button" className="flex h-10 w-10 items-center justify-center rounded-lg border border-line-strong text-ink-soft hover:bg-mist disabled:opacity-40" disabled={value >= max} onClick={() => onChange(clamp(value + 1))} aria-label="More"><Plus className="h-4 w-4" /></button>
    </div>
  );
}

/**
 * New hair order: an order request, not just an email. Needed By is required; hair is picked from Shopify inventory
 * (by SKU or name, or from the list) with quantities up to what's in stock — staff see only In Stock / Out of Stock, never counts. On Submit the server checks stock, records
 * the order, takes the items out of Shopify, then emails Addendum Hair — success is only shown once all that worked.
 */
function ComposeRequest({ onClose }: { onClose: () => void }) {
  const { data: me } = useMe();
  const canDo = useCanDo();
  // Only receptionists and admins can order for someone else; stylists always order for themselves.
  const forOthers = canDo('inventory:order_for_others');
  const { data: staff } = useStaff(forOthers);
  const { data: sugg } = useInventorySuggestions();
  const { data: integ } = useIntegrations(canDo('dashboard:view'));
  const shopify = useQuery({ queryKey: ['shopify-hair-products'], queryFn: () => api.get<{ connected: boolean; products: ShopifyOption[]; error?: string; layout?: OrderHairLayout }>('/inventory/shopify-products'), staleTime: 30_000 });
  const refresh = useRefreshAll();
  const toast = useToast();
  const [forStaffId, setForStaffId] = useState<string>('');
  const [neededBy, setNeededBy] = useState('');
  const [customer, setCustomer] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One id per order: sending again (double click, retry after a timeout) can never order or deduct twice.
  const [submissionId] = useState(() => crypto.randomUUID());
  const who = forStaffId || me?.id || '';
  const today = dayKey(new Date());
  const filled = lines.filter((l) => l.kind === 'inventory' || l.collection.trim());
  const units = filled.reduce((a, l) => a + l.quantity, 0);

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? ({ ...l, ...patch } as Line) : l)));
  const remove = (key: number) => setLines((ls) => ls.filter((l) => l.key !== key));
  /** Picking the same product again adds one more to its line (up to what's in stock). */
  const pick = (o: ShopifyOption, qty = 1) => setLines((ls) => {
    const same = ls.find((l) => l.kind === 'inventory' && l.option.sku === o.sku);
    if (same) return ls.map((l) => (l.key === same.key ? { ...l, quantity: Math.min(o.available, l.quantity + qty) } : l));
    return [...ls, { key: ++lineKey, kind: 'inventory', option: o, quantity: Math.min(o.available, qty) }];
  });
  const quick = useMemo(() => (sugg?.collections ?? []).slice(0, 8), [sugg]);
  const added = new Map(lines.flatMap((l) => (l.kind === 'inventory' ? [[l.option.sku, l.quantity] as const] : [])));
  const missingDate = !neededBy;
  // Never the same day: hair can't be turned around that fast (the server checks too).
  const tomorrow = addDaysKey(today, 1);

  const send = async () => {
    if (missingDate) { setError('Choose the Needed By date.'); return; }
    setSending(true);
    setError(null);
    try {
      const r = await api.post<{ request: InventoryRequestDTO; duplicate: boolean }>('/inventory/requests', {
        submissionId, forStaffId: who || undefined, neededBy, customerName: customer.trim() || null, note: note.trim() || null,
        items: filled.map((l) => (l.kind === 'inventory'
          ? { sku: l.option.sku, quantity: l.quantity }
          : { collection: l.collection, size: l.size || null, color: l.color || null, quantity: l.quantity })),
      });
      const o = r.request;
      const stockNote = o.inventoryStatus === 'reserved' ? ' Inventory reserved in Shopify.' : '';
      const e = o.email;
      if (e.status === 'sent') toast(`Order #${o.number} recorded.${stockNote} Sent to Addendum Hair.`);
      else toast(`Order #${o.number} recorded.${stockNote} ${e.status === 'not_configured' ? 'Email isn’t set up yet, so it will be sent once it is.' : 'The email will be retried automatically.'}`);
      refresh();
      void shopify.refetch();
      onClose();
    } catch (err) {
      // Stock short, Shopify unconfirmed, invalid input: nothing is shown as done; the form stays as it was.
      setError((err as Error).message);
      if ((err as ApiError).code === 'inventory_unavailable') void api.get('/inventory/shopify-products?fresh=true').then(() => shopify.refetch());
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal open xl onClose={onClose} title="New hair order" footer={<>
      <span className="mr-auto text-[13px] text-stone">{filled.length ? `${plural(filled.length, 'item')} · ${plural(units, 'unit')}` : 'Add hair to order'}</span>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon={<Send className="h-4 w-4" />} loading={sending} disabled={!filled.length || missingDate} onClick={send}>Submit order</Button>
    </>}>
      <p className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-stone"><Mail className="h-4 w-4" />Sent to Addendum Hair{integ?.demoMode ? ' · Demo Mode, not actually sent' : ''}</p>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        {/* Choose hair: collection → length → colour → quantity (or search). */}
        <section className="min-w-0 space-y-4">
          {shopify.data && !shopify.data.connected
            ? <p className="rounded-lg bg-amber-tint px-3 py-2 text-[13px] text-amber">Shopify isn’t connected, so hair can’t be taken from inventory. You can still add items by hand.</p>
            : <StepPicker products={shopify.data?.products ?? []} layout={shopify.data?.layout} loading={shopify.isLoading} added={added} onAdd={pick} />}
          {shopify.data?.error && <p className="text-[13px] text-rose">{shopify.data.error}</p>}
          <HairPicker shopify={shopify.data} loading={shopify.isLoading} onPick={pick} added={added} />
        </section>
        {/* The order: who it's for, when, the items, notes and Submit. */}
        <aside className="self-start border border-line bg-white p-4">
          <Field label="For stylist">
            {forOthers ? (
              <select className="field" value={who} onChange={(e) => setForStaffId(e.target.value)}>
                {me && <option value={me.id}>{me.name} (me)</option>}
                {staff?.filter((s) => s.active && s.id !== me?.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            ) : (
              <input className="field" value={me?.name ?? ''} readOnly aria-readonly="true" />
            )}
          </Field>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <Field label="Needed By (required)">
              <input type="date" className={cx('field h-11', error && missingDate && 'border-rose')} min={tomorrow} value={neededBy} onChange={(e) => { setNeededBy(e.target.value >= tomorrow ? e.target.value : ''); setError(null); }} required aria-required="true" />
            </Field>
            <Field label="Client (optional)">
              <input className="field h-11" value={customer} maxLength={120} onChange={(e) => setCustomer(e.target.value)} placeholder="Client name" autoComplete="off" />
            </Field>
          </div>
      <div className="mt-4">
        <span className="label">Items</span>
        {lines.length === 0 && <p className="rounded-lg border border-dashed border-line-strong px-3 py-3 text-[13px] text-stone">Search above or choose from the list to add hair.</p>}
        <ul className="space-y-2">
          {lines.map((l, idx) => (
            <li key={l.key} className="rounded-xl border border-line bg-white p-3">
              {l.kind === 'inventory' ? (
                <div>
                  <p className="text-[15px] font-medium text-ink">{l.option.product}</p>
                  <p className="text-[13px] text-ink-soft">{[l.option.size && `Length ${l.option.size}`, l.option.color && `Color ${l.option.color}`].filter(Boolean).join(' · ') || l.option.variant}</p>
                  <p className="text-[12px] text-stone">SKU <span className="font-mono">{l.option.sku}</span> · In Stock</p>
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-[0.8fr_1.2fr_1.6fr]">
                  <label className="block"><span className="mb-1 block text-xs text-stone">Size</span><input className="field" value={l.size} onChange={(e) => update(l.key, { size: e.target.value })} placeholder='20"' aria-label={`Item ${idx + 1} size`} maxLength={80} /></label>
                  <label className="block"><span className="mb-1 block text-xs text-stone">Color</span><input className="field" value={l.color} onChange={(e) => update(l.key, { color: e.target.value })} placeholder="#60 Platinum" aria-label={`Item ${idx + 1} color`} maxLength={120} /></label>
                  <label className="block"><span className="mb-1 block text-xs text-stone">Collection</span><input className="field" value={l.collection} onChange={(e) => update(l.key, { collection: e.target.value })} placeholder="Hand-Tied Weft" aria-label={`Item ${idx + 1} collection`} maxLength={160} /></label>
                  <p className="text-[12px] text-stone sm:col-span-3">Typed by hand: emailed to Addendum Hair.</p>
                </div>
              )}
              <div className="mt-2 flex items-end gap-3">
                <div>
                  <span className="mb-1 block text-xs text-stone">Quantity</span>
                  <Stepper value={l.quantity} max={l.kind === 'inventory' ? Math.max(1, l.option.available) : 999} onChange={(n) => update(l.key, { quantity: n })} label={`Item ${idx + 1} quantity`} />
                </div>
                <button type="button" className="ml-auto flex h-10 items-center gap-1 rounded-lg px-2 text-[13px] text-stone hover:bg-mist hover:text-rose" onClick={() => remove(l.key)} aria-label={`Remove item ${idx + 1}`}><Trash2 className="h-4 w-4" />Remove</button>
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setLines((ls) => [...ls, typedLine()])}>Add an item that isn’t in the list</Button>
          {quick.map((c) => <button key={c} type="button" onClick={() => setLines((ls) => [...ls, typedLine({ collection: c })])} className="rounded-full bg-mist px-2.5 py-1 text-xs text-ink-soft hover:bg-plum-tint">+ {c}</button>)}
        </div>
      </div>

      <Field label="Order notes (optional)" className="mt-5">
        <textarea className="field min-h-[70px]" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Special instructions, e.g. For Sarah's install on the 14th" />
      </Field>
      {error && <p className="mt-3 flex items-start gap-2 rounded-lg border border-rose/30 bg-rose-tint px-3 py-2 text-[14px] text-rose" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}
        </aside>
      </div>
    </Modal>
  );
}

/**
 * Choose hair step by step: the collection, then the length, then the colour (out of stock can't be chosen), then how
 * many. Collections and products follow the order an admin set (Settings → Order Hair).
 */
function StepPicker({ products, layout, loading, added, onAdd }: { products: ShopifyOption[]; layout?: OrderHairLayout; loading: boolean; added: Map<string, number>; onAdd: (o: ShopifyOption, qty: number) => void }) {
  const [collection, setCollection] = useState<string | null>(null);
  const [length, setLength] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ShopifyOption | null>(null);
  const [qty, setQty] = useState(1);
  const items = useMemo(() => products.map((p) => ({ p, ...hairParts(p.label) })), [products]);
  const collections = useMemo(() => {
    const seen = [...new Set(items.map((i) => i.collection))];
    const order = layout?.collections ?? [];
    const pos = (c: string) => { const i = order.findIndex((x) => x.toLowerCase() === c.toLowerCase()); return i < 0 ? 1e9 : i; };
    return seen.sort((a, b) => pos(a) - pos(b) || (a === 'Tools & accessories' ? 1 : b === 'Tools & accessories' ? -1 : 0));
  }, [items, layout]);
  const inCol = items.filter((i) => i.collection === collection);
  const lengths = [...new Set(inCol.map((i) => i.length))].sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0));
  const effLength = lengths.length === 1 ? lengths[0] : length;
  const colors = effLength != null ? inCol.filter((i) => i.length === effLength) : [];
  const step = !collection ? 1 : effLength == null ? 2 : 3;
  const reset = (to: 1 | 2) => { if (to === 1) { setCollection(null); setLength(null); } else setLength(null); setChosen(null); setQty(1); };
  const crumb = 'inline-flex items-center gap-1 text-[13px] text-plum hover:underline';
  if (loading) return <PageLoading />;
  if (!items.length) return <p className="text-[13px] text-stone">No hair is offered in Order Hair right now. Add an item by hand instead.</p>;
  return (
    <div className="border border-line bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <span className={cx('font-medium', step === 1 ? 'text-ink' : 'text-stone')}>1 · Collection</span>
        {collection && <button type="button" className={crumb} onClick={() => reset(1)}>{collection}</button>}
        <ChevronRight className="h-3.5 w-3.5 text-stone" />
        <span className={cx('font-medium', step === 2 ? 'text-ink' : 'text-stone')}>2 · Length</span>
        {effLength && lengths.length > 1 && <button type="button" className={crumb} onClick={() => reset(2)}>{effLength}</button>}
        <ChevronRight className="h-3.5 w-3.5 text-stone" />
        <span className={cx('font-medium', step === 3 ? 'text-ink' : 'text-stone')}>3 · Colour & quantity</span>
      </div>
      {step === 1 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {collections.map((c) => {
            const list = items.filter((i) => i.collection === c);
            const inStock = list.some((i) => i.p.available > 0);
            return (
              <button key={c} type="button" onClick={() => { setCollection(c); setLength(null); setChosen(null); }}
                className={cx('border border-line px-3 py-3 text-left hover:border-plum hover:bg-plum-tint/30', !inStock && 'opacity-50')}>
                <span className="block text-[15px] font-medium text-ink">{c}</span>
                <span className="text-[12px] text-stone">{inStock ? (() => { const n = new Set(list.map((i) => i.color)).size; return `${n} colour${n === 1 ? '' : 's'}`; })() : 'Out of stock'}</span>
              </button>
            );
          })}
        </div>
      )}
      {step === 2 && (
        <div className="flex flex-wrap gap-2">
          {lengths.map((l) => (
            <button key={l || 'one'} type="button" onClick={() => setLength(l)} className="min-w-[5.5rem] border border-line px-4 py-3 text-[15px] font-medium text-ink hover:border-plum hover:bg-plum-tint/30">{l || 'One size'}</button>
          ))}
        </div>
      )}
      {step === 3 && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {colors.map(({ p, color, detail }) => {
              const out = p.available <= 0;
              const n = added.get(p.sku) ?? 0;
              return (
                <button key={p.sku} type="button" disabled={out || n >= p.available} onClick={() => { setChosen(p); setQty(1); }}
                  className={cx('border px-3 py-2 text-left', chosen?.sku === p.sku ? 'border-plum bg-plum-tint/40' : 'border-line hover:border-plum', (out || n >= p.available) && 'opacity-45')}>
                  <span className="block text-[14px] font-medium text-ink">{color}</span>
                  <span className="block text-[12px] text-stone">{out ? 'Out of stock' : n ? `${n} in this order` : detail || 'In stock'}</span>
                </button>
              );
            })}
          </div>
          {chosen && (
            <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-line pt-3">
              <div className="min-w-0 flex-1"><p className="text-[14px] font-medium text-ink">{chosen.label}</p><p className="font-mono text-[12px] text-stone">{chosen.sku}</p></div>
              <div><span className="mb-1 block text-xs text-stone">Quantity</span>
                <Stepper value={qty} max={Math.max(1, chosen.available - (added.get(chosen.sku) ?? 0))} onChange={setQty} label="Quantity" /></div>
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => { onAdd(chosen, qty); setChosen(null); setQty(1); }}>Add to order</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Search Shopify hair inventory by SKU or name, or pick from the list. Read-only: stock changes only on Submit. */
function HairPicker({ shopify, loading, onPick, added }: { shopify?: { connected: boolean; products: ShopifyOption[]; error?: string }; loading: boolean; onPick: (o: ShopifyOption) => void; added: Map<string, number> }) {
  const [text, setText] = useState('');
  const products = shopify?.products ?? [];
  const words = norm(text).split(/\s+/).filter(Boolean);
  const results = products.filter((p) => words.every((w) => norm(`${p.sku} ${p.label}`).includes(w)));
  if (shopify && !shopify.connected) return <p className="mt-4 rounded-lg bg-amber-tint px-3 py-2 text-[13px] text-amber">Shopify isn’t connected, so hair can’t be taken from inventory. You can still add items by hand below.</p>;
  return (
    <div>
      <span className="label">Or search by SKU, name, length or colour</span>
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
        <input className="field h-11 pl-9 pr-9" type="search" inputMode="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="SKU, name, length or colour" aria-label="Search Shopify hair inventory" />
        {text && <button type="button" onClick={() => setText('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-stone hover:bg-mist hover:text-ink" aria-label="Clear search"><X className="h-4 w-4" /></button>}
      </label>
      {shopify?.error && <p className="mt-2 text-[13px] text-rose">{shopify.error}</p>}
      {text && (
        <ul className="mt-2 max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {results.length === 0 && <li className="px-3 py-3 text-[13px] text-stone">No products match “{text}”. <button type="button" className="text-plum hover:underline" onClick={() => setText('')}>Clear the search</button>, or add the item by hand below.</li>}
          {results.map((p) => {
            const n = added.get(p.sku);
            const out = p.available <= 0;
            return (
              <li key={p.sku}>
                <button type="button" disabled={out || (n ?? 0) >= p.available} onClick={() => onPick(p)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-plum-tint/40 disabled:opacity-50">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-ink">{p.product}</span>
                    <span className="block truncate text-[13px] text-ink-soft">{[p.variant, `SKU ${p.sku}`].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className={cx('shrink-0 text-[12px]', out ? 'text-rose' : 'text-stone')}>{out ? 'Out of Stock' : 'In Stock'}</span>
                  <span className={cx('inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] font-medium', n ? 'bg-plum-tint text-plum' : 'border border-line-strong text-ink-soft')}>
                    <Plus className="h-3.5 w-3.5" />{n ? `Added ×${n}` : 'Add'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RequestDetail({ id, onClose, canManage, seesAll }: { id: string; onClose: () => void; canManage: boolean; seesAll: boolean }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['inventory', 'one', id], queryFn: () => api.get<{ request: InventoryRequestDTO }>(`/inventory/requests/${id}`).then((r) => r.request) });
  return (
    <Modal open wide onClose={onClose} title={data ? `Hair order #${data.number}` : 'Hair order'}>
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
        <p className="mt-2 text-sm text-ink-soft">For <b className="font-medium text-ink">{r.forStaffName ?? 'stylist'}</b>{r.customerName ? <> · client <b className="font-medium text-ink">{r.customerName}</b></> : null}{r.requestedByName && r.requestedByName !== r.forStaffName ? ` · submitted by ${r.requestedByName}` : ''} · {dateTime(r.createdAt)}</p>
        {r.statusChangedAt && r.status !== 'submitted' && <p className="text-sm text-stone">{INVENTORY_STATUS_LABELS[r.status]} {relative(r.statusChangedAt)}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {canManage && r.status === 'submitted' && <Button size="sm" variant="primary" icon={<Truck className="h-4 w-4" />} loading={a.busy === 'ordered'} disabled={!!a.busy} onClick={() => a.status('ordered', 'Marked ordered')}>Mark ordered</Button>}
          {canManage && (r.status === 'submitted' || r.status === 'ordered') && <Button size="sm" icon={<PackageCheck className="h-4 w-4" />} loading={a.busy === 'received'} disabled={!!a.busy} onClick={() => a.status('received', 'Marked received')}>Mark received</Button>}
          {r.status !== 'cancelled' && <Button size="sm" icon={<RotateCw className="h-4 w-4" />} loading={a.busy === 'resend'} onClick={a.resend}>{r.email.status === 'sent' ? 'Email again' : 'Send email now'}</Button>}
        </div>
      </div>

      <section>
        <h3 className="mb-2 font-display text-xl"><Tc>Items</Tc></h3>
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
        <h3 className="mb-2 font-display text-xl"><Tc>Email</Tc></h3>
        <p className="text-[13px]"><EmailLine r={r} /></p>
        {r.email.error && r.email.status !== 'sent' && <p className="mt-1 text-[13px] text-stone">{r.email.error}</p>}
        {r.email.text && (
          <div className={cx('mt-3 rounded-xl border border-line bg-white p-3')}>
            <p className="text-[13px] text-stone">To: Addendum Hair</p>
            {r.email.cc.length > 0 && <p className="text-[13px] text-stone">Cc: {r.email.cc.join(', ')}</p>}
            <p className="text-[13px] font-medium text-ink">{r.email.subject}</p>
            <pre className="mt-2 whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-ink-soft">{r.email.text}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
