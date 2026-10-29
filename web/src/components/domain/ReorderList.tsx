import { productName } from '@addendum/shared';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ClipboardList, FileText, Save, SlidersHorizontal } from 'lucide-react';
import { api } from '../../api/client';
import { Badge, Button, EmptyState, ErrorNote, Field, Modal, PageLoading, cx, useToast } from '../ui';
import { ProductSettingsButton } from './ProductSettings';

type Plan = 'normal' | '30' | '60' | '90';
interface Row {
  key: string; label: string; shade: string; group: string; sku: string | null; length: string | null; type: 'weft' | 'ktip' | 'tape' | 'clipin'; supplier: string | null;
  available: number; committed: number; incoming: number; ratePerDay: number; units30: number; noSales: boolean; daysUntilStockout: number | null;
  productionDays: number; shippingDays: number; leadDays: number; moq: number | null; caseSize: number | null; costCents: number | null;
  planNote: string; suggestedQty: number; forecastQty: number; minimumQty: number | null; explain: string; why: string[];
  tier: 1 | 2 | 3; urgent: boolean; badges: string[]; warning: string | null; flags: string[];
}
interface ListResponse {
  plan: Plan; items: Row[]; groups: string[]; urgentKtips: string[];
  saved: { plan: Plan; lines: { key: string; include: boolean; qty: number }[]; savedBy: string | null; savedAt: string } | null;
  amounts: Amounts;
}
/** Order amounts per section ("Tapes") or section and length ("Redefined Wefts 24\""): always this many, at least this many. */
type Amounts = Record<string, { fixed: number | null; min: number | null }>;
interface Review {
  problems: { key: string; label: string; message: string; suggest: number }[];
  suppliers: { supplier: string; units: number; estCents: number | null; estPartialCents: number; warnings: string[]; lines: { key: string; label: string; sku: string | null; qty: number; costCents: number | null; leadDays: number }[] }[];
}
const PLANS: { value: Plan; label: string }[] = [{ value: 'normal', label: 'Normal Order' }, { value: '30', label: '30-Day Coverage' }, { value: '60', label: '60-Day Coverage' }, { value: '90', label: '90-Day Coverage' }];
const money = (c: number) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const BADGE_TONE: Record<string, 'rose' | 'amber' | 'plum' | 'neutral' | 'sage'> = {
  'OUT OF STOCK': 'rose', 'ORDER NOW': 'rose', 'STOCKOUT WITHIN 14 DAYS': 'amber', 'LONG PRODUCTION LEAD': 'plum', 'INCOMING STOCK': 'sage',
};
/** Same rule as the server: 0, or at least the minimum and in full cases. */
const problemOf = (qty: number, r: Row) => {
  if (qty <= 0) return null;
  if (r.moq && qty < r.moq) return `Min ${r.moq}`;
  if (r.caseSize && r.caseSize > 1 && qty % r.caseSize) return `Cases of ${r.caseSize}`;
  return null;
};
/** Length by the colour ("18\" Aperol Spritz"); the section is the collection. */
const nameOf = (r: Row) => (r.length ? `${r.length.replace(/[”″]/g, '"')} ${r.shade}` : r.shade);
/** One short status: what's left and the most important flag. */
const statusOf = (r: Row) => (r.available <= 0 ? 'Out of stock' : `${r.available} left`) + (r.incoming ? ` · ${r.incoming} coming` : '')
  + (r.available > 0 && r.daysUntilStockout != null && r.daysUntilStockout <= 14 ? ` · runs out in ~${r.daysUntilStockout}d` : '');

/**
 * Reorder List (Addendum Hair): Lisa's sections in her order — 18" / 22" / 24" Redefined Wefts, 18" / 22" K-Tips,
 * 22" / 18" Tapes, Clip-Ins — each a short list of colours with the amount to order. Details open per row.
 */
export function ReorderList({ onOrders }: { onOrders: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [plan, setPlan] = useState<Plan>('normal');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['reorder-list', plan],
    queryFn: () => api.get<ListResponse>(`/inventory-sync/reorder-list?plan=${plan}`),
  });
  const [include, setInclude] = useState<Record<string, boolean>>({});
  const [qty, setQty] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [loadedSaved, setLoadedSaved] = useState(false);
  useEffect(() => {
    if (!data?.saved || loadedSaved) return;
    setLoadedSaved(true);
    setPlan(data.saved.plan);
    setInclude(Object.fromEntries(data.saved.lines.map((l) => [l.key, l.include])));
    setQty(Object.fromEntries(data.saved.lines.filter((l) => l.qty > 0).map((l) => [l.key, l.qty]))); // 0s start at the amount shown
  }, [data?.saved, loadedSaved]);
  const [review, setReview] = useState<Review | null>(null);
  const [editAmounts, setEditAmounts] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const items = data?.items ?? [];
  const qOf = (r: Row) => qty[r.key] ?? r.suggestedQty;
  const isIn = (r: Row) => include[r.key] ?? r.suggestedQty > 0;
  const chosen = (rows: Row[]) => rows.filter((r) => isIn(r) && qOf(r) > 0);
  const all = chosen(items);
  const estimate = all.reduce((n, r) => n + (r.costCents ?? 0) * qOf(r), 0);
  const groups = (data?.groups ?? []).map((g) => ({ name: g, rows: items.filter((r) => r.group === g) })).filter((g) => g.rows.length);
  const urgentK = items.filter((r) => data?.urgentKtips.includes(r.key));

  const save = async () => {
    try {
      await api.put('/inventory-sync/reorder-list/saved', { plan, lines: items.map((r) => ({ key: r.key, include: isIn(r), qty: qOf(r) })) });
      toast('List saved');
      void qc.invalidateQueries({ queryKey: ['reorder-list'] });
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const openReview = async (rows: Row[], label: string) => {
    setBusy(label);
    try { setReview(await api.post<Review>('/inventory-sync/reorder-list/review', { plan, lines: chosen(rows).map((r) => ({ key: r.key, qty: qOf(r) })) })); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  };
  const [listText, setListText] = useState<string | null>(null);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Ordering Plan" className="w-full sm:w-60">
          <select className="field h-10" value={plan} onChange={(e) => { setPlan(e.target.value as Plan); setQty({}); }}>{PLANS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
        </Field>
        <span className="pb-2 text-[13px] text-stone"><b className="num font-medium text-ink">{all.length}</b> to order{estimate > 0 && <> · about <b className="num font-medium text-ink">{money(estimate)}</b></>}</span>
        <span className="ml-auto flex flex-wrap gap-2">
          <Button icon={<SlidersHorizontal className="h-4 w-4" />} onClick={() => setEditAmounts(true)} disabled={!data}>Order amounts</Button>
          <Button icon={<Save className="h-4 w-4" />} onClick={save} disabled={!items.length}>Save List</Button>
          <Button icon={<ClipboardList className="h-4 w-4" />} onClick={() => setListText(noteText(groups.map((g) => ({ name: g.name, rows: chosen(g.rows).map((r) => ({ r, qty: qOf(r) })) }))))} disabled={!all.length}>Copy list</Button>
          <Button variant="primary" icon={<FileText className="h-4 w-4" />} loading={busy === 'all'} onClick={() => openReview(items, 'all')} disabled={!all.length}>Create order</Button>
        </span>
      </div>

      {listText != null && <CopyListModal text={listText} onClose={() => setListText(null)} />}
      {editAmounts && data && <AmountsModal amounts={data.amounts} items={items} onClose={() => setEditAmounts(false)} onSaved={() => { setEditAmounts(false); setQty({}); void qc.invalidateQueries({ queryKey: ['reorder-list'] }); }} />}
      {urgentK.length > 0 && (
        <p className="mb-4 flex items-start gap-2 rounded-xl2 border border-rose/30 bg-rose/5 px-4 py-3 text-[14px] text-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose" />
          <span>Don’t wait on these K-Tips — they run out before a new order arrives: {urgentK.map(nameOf).join(', ')}.</span>
        </p>
      )}

      {error ? <ErrorNote error={error} onRetry={() => refetch()} /> : isLoading ? <PageLoading /> : !groups.length ? (
        <div className="panel"><EmptyState title="Nothing needs ordering">Nothing is out of stock, under 5, or selling out within 14 days.</EmptyState></div>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => {
            const picked = chosen(g.rows);
            return (
              <section key={g.name}>
                <div className="mb-1.5 flex items-center gap-3">
                  <h2 className="text-[15px] font-semibold text-ink">{g.name}</h2>
                  <span className="text-[13px] text-stone">{picked.reduce((n, r) => n + qOf(r), 0)} to order</span>
                  <Button size="sm" className="ml-auto" loading={busy === g.name} disabled={!picked.length} onClick={() => openReview(g.rows, g.name)}>Create order</Button>
                </div>
                <div className="panel divide-y divide-line !p-0">
                  {g.rows.map((r) => {
                    const q = qOf(r);
                    const bad = isIn(r) ? problemOf(q, r) : null;
                    const expanded = open === r.key;
                    return (
                      <div key={r.key}>
                        <div className={cx('flex items-center gap-3 px-3 py-2', !isIn(r) && 'opacity-60')}>
                          <input type="checkbox" className="h-5 w-5 shrink-0 accent-plum" checked={isIn(r)} onChange={(e) => setInclude({ ...include, [r.key]: e.target.checked })} aria-label={`Order ${r.label}`} />
                          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(expanded ? null : r.key)} aria-expanded={expanded}>
                            <span className="block truncate text-[15px] text-ink">{nameOf(r)}</span>
                            <span className={cx('block truncate text-[12px]', r.available <= 0 || r.urgent ? 'text-rose' : 'text-stone')}>{statusOf(r)}</span>
                          </button>
                          <ChevronDown className={cx('h-4 w-4 shrink-0 text-stone transition-transform', expanded && 'rotate-180')} aria-hidden />
                          <ProductSettingsButton productKey={r.key} />
                          {/* Suggested from sales, beside the usual amount; tap to use it. */}
                          <button type="button" className="shrink-0 text-center leading-tight disabled:opacity-60" disabled={q === r.forecastQty}
                            onClick={() => { setQty({ ...qty, [r.key]: r.forecastQty }); if (r.forecastQty > 0 && !isIn(r)) setInclude({ ...include, [r.key]: true }); }}
                            title="Suggested from sales: lead time + 30 days, safety stock and pre-orders, less stock and what’s on order. Tap to use it." aria-label={`Use the suggested ${r.forecastQty} for ${r.label}`}>
                            <span className="block text-[10px] uppercase tracking-wide text-stone">Suggested</span>
                            <span className={cx('block num text-[16px]', q === r.forecastQty ? 'text-stone' : 'text-plum underline decoration-dotted underline-offset-2')}>{r.forecastQty}</span>
                          </button>
                          <label className="shrink-0 text-right">
                            <input type="number" min={0} inputMode="numeric" className={cx('field num h-10 w-20 text-right text-[16px]', bad && 'border-rose')} value={q} disabled={!isIn(r)}
                              onChange={(e) => { const v = Math.max(0, Math.round(Number(e.target.value) || 0)); setQty({ ...qty, [r.key]: v }); if (v > 0 && !isIn(r)) setInclude({ ...include, [r.key]: true }); }}
                              aria-label={`Quantity of ${r.label}`} />
                            {bad && <span className="block text-[11px] text-rose">{bad}</span>}
                          </label>
                        </div>
                        {expanded && (
                          <div className="space-y-1.5 bg-mist/40 px-3 pb-3 pl-11 pt-1 text-[13px]">
                            <p className="text-stone">{productName(r.label, r.sku)}{r.sku ? ` · ${r.sku}` : ''}</p>
                            {r.badges.length > 0 && <div className="flex flex-wrap gap-1">{r.badges.map((b) => <Badge key={b} tone={BADGE_TONE[b] ?? 'neutral'}>{b}</Badge>)}</div>}
                            {r.warning && <p className="text-rose">{r.warning}</p>}
                            <p className="text-ink-soft"><span className="text-stone">{r.planNote}:</span> {r.explain}</p>
                            <p className="text-stone">Sells {r.noSales ? 'nothing lately' : `${r.ratePerDay.toFixed(2)} a day (${r.units30} in 30 days)`} · lead time {r.leadDays} days · MOQ {r.moq ?? '—'}{r.caseSize ? ` · cases of ${r.caseSize}` : ''}</p>
                            {r.flags.length > 0 && <p className="text-amber">{r.flags.join(' · ')}</p>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {review && <ReviewModal plan={plan} review={review} onFix={(k, v) => { setQty({ ...qty, [k]: v }); setReview(null); }}
        onExclude={(k) => { setInclude({ ...include, [k]: false }); setReview(null); }}
        onClose={() => setReview(null)} onDone={() => { setReview(null); void qc.invalidateQueries({ queryKey: ['reorder-list'] }); onOrders(); }} />}
    </div>
  );
}

function ReviewModal({ plan, review, onFix, onExclude, onClose, onDone }: {
  plan: Plan; review: Review; onFix: (k: string, v: number) => void; onExclude: (k: string) => void; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const bad = new Set(review.problems.map((p) => p.key));
  const ready = review.suppliers.filter((s) => s.supplier !== 'Supplier needed').flatMap((s) => s.lines).filter((l) => !bad.has(l.key));
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ orders: { number: number }[] }>('/inventory-sync/reorder-list/purchase-orders', { plan, lines: ready.map((l) => ({ key: l.key, qty: l.qty })) });
      toast(`Draft purchase order${r.orders.length === 1 ? '' : 's'} ${r.orders.map((o) => `#${o.number}`).join(', ')} created — mark as ordered when you send ${r.orders.length === 1 ? 'it' : 'them'}`);
      onDone();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open wide onClose={onClose} title="Review order"
      footer={<><Button variant="ghost" onClick={onClose}>Back</Button><Button variant="primary" loading={busy} disabled={!ready.length} onClick={create}>
        {review.problems.length ? `Create for ${ready.length} item${ready.length === 1 ? '' : 's'}` : 'Create purchase order'}
      </Button></>}>
      {review.problems.length > 0 && (
        <div className="mb-4 rounded-lg border border-rose/30 bg-rose/5 p-3 text-[14px]">
          <p className="mb-1.5 font-medium text-ink">Fix or leave out</p>
          <ul className="space-y-1.5">{review.problems.map((p) => (
            <li key={p.key} className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1">{p.label} — <span className="text-rose">{p.message}</span></span>
              {p.suggest > 0 && <Button size="sm" onClick={() => onFix(p.key, p.suggest)}>Use {p.suggest}</Button>}
              <Button size="sm" variant="ghost" onClick={() => onExclude(p.key)}>Leave out</Button></li>))}</ul>
        </div>
      )}
      {review.suppliers.map((s) => (
        <div key={s.supplier} className="mb-4">
          <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[15px] font-medium text-ink">{s.supplier}</h3>
            <span className="text-[13px] text-stone">{s.units} units{s.estCents != null ? ` · ${money(s.estCents)}` : s.estPartialCents ? ` · about ${money(s.estPartialCents)}` : ''}</span>
          </div>
          {s.warnings.map((w) => <p key={w} className="mb-1.5 flex items-start gap-1.5 text-[13px] text-amber"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{w}</p>)}
          <div className="panel divide-y divide-line !p-0 text-[14px]">
            {s.lines.map((l) => (
              <div key={l.key} className={cx('flex items-center gap-3 px-3 py-2', bad.has(l.key) && 'opacity-50')}>
                <span className="min-w-0 flex-1 truncate">{productName(l.label, l.sku)}</span>
                <span className="num w-14 text-right font-medium">{l.qty}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="text-[12px] text-stone">Creates draft purchase orders (one per supplier). Nothing is sent to a supplier.</p>
    </Modal>
  );
}

/** What each section's products are called in the list ("18\" Aperol Spritz Redefined - 10"). */
const NOTE_SUFFIX: Record<string, string> = { 'Redefined Wefts': 'Redefined', Wefts: 'Wefts', 'K-Tips': 'K-Tips', Tapes: 'Tapes', 'Clip-Ins': 'Clip-Ins' };
/**
 * The order as plain text for a note: each section in capitals, a blank line between lengths.
 *   REDEFINED WEFTS
 *   18" Aperol Spritz Redefined - 10
 *
 *   22" Margarita Redefined - 20
 */
function noteText(groups: { name: string; rows: { r: Row; qty: number }[] }[]) {
  return groups.filter((g) => g.rows.length).map((g) => {
    const lines: string[] = [g.name.toUpperCase()];
    let len: string | null | undefined;
    for (const { r, qty } of g.rows) {
      if (len !== undefined && r.length !== len) lines.push('');
      len = r.length;
      lines.push(`${[nameOf(r), NOTE_SUFFIX[g.name] ?? ''].filter(Boolean).join(' ')} - ${qty}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

/** The list to copy into a note; it can also be selected by hand (phones that block copying). */
function CopyListModal({ text, onClose }: { text: string; onClose: () => void }) {
  const toast = useToast();
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast('Copied — paste it into your note'); onClose(); } catch { toast('Couldn’t copy — select the text and copy it', 'error'); }
  };
  return (
    <Modal open onClose={onClose} title="Order list" footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" icon={<ClipboardList className="h-4 w-4" />} onClick={copy}>Copy</Button></>}>
      <p className="mb-2 text-[13px] text-stone">The ticked products and amounts, ready to paste into a note.</p>
      <textarea readOnly className="field h-80 w-full font-mono text-[14px] leading-relaxed" value={text} onFocus={(e) => e.currentTarget.select()} aria-label="Order list" />
    </Modal>
  );
}

/** Order amounts: for a section (all lengths) or one length of it — always order this many, or at least this many. */
function AmountsModal({ amounts, items, onClose, onSaved }: { amounts: Amounts; items: Row[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, { fixed: string; min: string }>>(() =>
    Object.fromEntries(Object.entries(amounts).map(([k, r]) => [k, { fixed: r.fixed ? String(r.fixed) : '', min: r.min ? String(r.min) : '' }])));
  const [busy, setBusy] = useState(false);
  // Each section on the list, then each of its lengths (plus any saved rule for one that isn't on the list today).
  const sections = [...new Set(items.map((r) => r.group))];
  const keys = sections.flatMap((g) => [g, ...[...new Set(items.filter((r) => r.group === g && r.length).map((r) => `${g} ${r.length!.replace(/[”″]/g, '"')}`))]
    .sort((a, b) => Number.parseInt(a.slice(g.length), 10) - Number.parseInt(b.slice(g.length), 10))]);
  for (const k of Object.keys(amounts)) if (!keys.includes(k)) keys.push(k);
  const val = (k: string, f: 'fixed' | 'min') => draft[k]?.[f] ?? '';
  const set = (k: string, f: 'fixed' | 'min', v: string) => setDraft((d) => ({ ...d, [k]: { ...(d[k] ?? { fixed: '', min: '' }), [f]: v.replace(/\D/g, '') } }));
  const save = async () => {
    setBusy(true);
    try {
      const rules = Object.fromEntries(Object.entries(draft).map(([k, r]) => [k, { fixed: Number(r.fixed) || null, min: Number(r.min) || null }]));
      await api.put('/inventory-sync/reorder-list/amounts', { rules });
      toast('Order amounts saved');
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Order amounts" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <p className="mb-3 text-[13px] text-stone"><b className="font-medium text-ink-soft">Always</b> orders exactly that many. <b className="font-medium text-ink-soft">At least</b> is the minimum order. A length’s amounts win over its section’s. Anything else rounds up to the next 5 (or full cases).</p>
      <div className="divide-y divide-line rounded-xl2 border border-line">
        <div className="flex items-center gap-2 bg-mist px-3 py-1.5 text-[11px] uppercase tracking-wide text-stone"><span className="flex-1">Section</span><span className="w-20 text-center">Always</span><span className="w-20 text-center">At least</span></div>
        {keys.map((k) => {
          const section = sections.find((g) => k === g);
          return (
            <div key={k} className="flex items-center gap-2 px-3 py-1.5">
              <span className={cx('min-w-0 flex-1 text-[14px]', section ? 'font-medium text-ink' : 'pl-3 text-ink-soft')}>{section ? `${k} (all lengths)` : k}</span>
              <input inputMode="numeric" className="field num h-9 w-20 text-center" placeholder="—" value={val(k, 'fixed')} onChange={(e) => set(k, 'fixed', e.target.value)} aria-label={`Always order for ${k}`} />
              <input inputMode="numeric" className="field num h-9 w-20 text-center" placeholder="—" value={val(k, 'min')} onChange={(e) => set(k, 'min', e.target.value)} aria-label={`Minimum order for ${k}`} />
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
