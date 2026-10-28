import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, FileText, Save, SlidersHorizontal } from 'lucide-react';
import { api } from '../../api/client';
import { Badge, Button, EmptyState, ErrorNote, Field, Modal, PageLoading, cx, useToast } from '../ui';

type Plan = 'normal' | '30' | '60' | '90';
interface Row {
  key: string; label: string; sku: string | null; length: string | null; type: 'weft' | 'ktip'; supplier: string | null; collection: string | null;
  available: number; committed: number; incoming: number; ratePerDay: number; units30: number; noSales: boolean; daysUntilStockout: number | null; stockoutOn: string | null;
  productionDays: number; shippingDays: number; leadDays: number; leadMissing: boolean; moq: number | null; moqMissing: boolean; caseSize: number | null; costCents: number | null;
  plan: Plan; planNote: string; calculatedNeed: number; netNeed: number; suggestedQty: number; minimumQty: number | null; explain: string; why: string[];
  tier: 1 | 2 | 3; urgent: boolean; badges: string[]; warning: string | null; flags: string[];
  prefs: { typicalQty: number | null; preferredPlan: Plan | null; safetyUnits: number | null; notes: string | null };
  history: { quantity: number; orderedOn: string; number: number }[];
}
interface ListResponse {
  plan: Plan; items: Row[]; filters: { collections: string[]; suppliers: string[] }; supplierRules: Record<string, { minOrderCents: number | null; minOrderUnits: number | null }>;
  urgentKtips: string[]; saved: { plan: Plan; lines: { key: string; include: boolean; qty: number }[]; savedBy: string | null; savedAt: string } | null;
}
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
  if (r.moq && qty < r.moq) return `Below MOQ ${r.moq}`;
  if (r.caseSize && r.caseSize > 1 && qty % r.caseSize) return `Not a full case of ${r.caseSize}`;
  return null;
};

/** Reorder List (Addendum Hair): wefts first, K-tips second — only what needs attention, with an amount for the chosen plan. */
export function ReorderList({ onOrders }: { onOrders: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [plan, setPlan] = useState<Plan>('normal');
  const [f, setF] = useState({ type: '', collection: '', supplier: '' });
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['reorder-list', plan, f],
    queryFn: () => api.get<ListResponse>(`/inventory-sync/reorder-list?${new URLSearchParams({ plan, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) })}`),
  });
  // Lisa's choices: included or not, and edited amounts (kept when the plan changes only where she typed one).
  const [include, setInclude] = useState<Record<string, boolean>>({});
  const [qty, setQty] = useState<Record<string, number>>({});
  const [loadedSaved, setLoadedSaved] = useState(false);
  useEffect(() => {
    if (!data?.saved || loadedSaved) return;
    setLoadedSaved(true);
    setPlan(data.saved.plan);
    setInclude(Object.fromEntries(data.saved.lines.map((l) => [l.key, l.include])));
    setQty(Object.fromEntries(data.saved.lines.map((l) => [l.key, l.qty])));
  }, [data?.saved, loadedSaved]);
  const [review, setReview] = useState<Review | null>(null);
  const [prefsFor, setPrefsFor] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);

  const items = data?.items ?? [];
  const qOf = (r: Row) => qty[r.key] ?? r.suggestedQty;
  const isIn = (r: Row) => include[r.key] ?? r.suggestedQty > 0;
  const chosen = items.filter((r) => isIn(r) && qOf(r) > 0);
  const estimate = chosen.reduce((n, r) => n + (r.costCents ?? 0) * qOf(r), 0);
  const costMissing = chosen.some((r) => r.costCents == null);
  const wefts = items.filter((r) => r.type === 'weft');
  const ktips = items.filter((r) => r.type === 'ktip');
  const urgentK = ktips.filter((r) => data?.urgentKtips.includes(r.key));
  const lines = () => chosen.map((r) => ({ key: r.key, qty: qOf(r) }));

  const save = async () => {
    try {
      await api.put('/inventory-sync/reorder-list/saved', { plan, lines: items.map((r) => ({ key: r.key, include: isIn(r), qty: qOf(r) })) });
      toast('List saved — it opens like this next time');
      void qc.invalidateQueries({ queryKey: ['reorder-list'] });
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const openReview = async () => {
    setBusy(true);
    try { setReview(await api.post<Review>('/inventory-sync/reorder-list/review', { plan, lines: lines() })); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const exportCsv = () => {
    const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['Type', 'Product', 'SKU', 'Supplier', 'Available', 'Incoming', 'Avg daily sales', 'Days to stockout', 'Lead time (days)', 'MOQ', 'Case size', 'Suggested', 'Order qty', 'Unit cost', 'Line cost', 'Reason'];
    const body = chosen.map((r) => [r.type === 'weft' ? 'Weft' : 'K-Tip', r.label, r.sku, r.supplier, r.available, r.incoming, r.ratePerDay, r.daysUntilStockout, r.leadDays, r.moq, r.caseSize, r.suggestedQty, qOf(r),
      r.costCents != null ? (r.costCents / 100).toFixed(2) : '', r.costCents != null ? ((r.costCents * qOf(r)) / 100).toFixed(2) : '', r.explain]);
    const blob = new Blob([[head, ...body].map((x) => x.map(esc).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Reorder_List_${PLANS.find((p) => p.value === plan)!.label.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Ordering Plan" className="w-full sm:w-64">
          <select className="field h-11 text-[16px] font-medium" value={plan} onChange={(e) => { setPlan(e.target.value as Plan); setQty({}); }}>{PLANS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
        </Field>
        <select className="field h-10 w-auto" aria-label="Product type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">Wefts & K-Tips</option><option value="weft">Wefts</option><option value="ktip">K-Tips</option></select>
        {(data?.filters.collections.length ?? 0) > 1 && <select className="field h-10 w-auto" aria-label="Collection" value={f.collection} onChange={(e) => setF({ ...f, collection: e.target.value })}><option value="">All collections</option>{data!.filters.collections.map((c) => <option key={c}>{c}</option>)}</select>}
        {(data?.filters.suppliers.length ?? 0) > 1 && <select className="field h-10 w-auto" aria-label="Supplier" value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })}><option value="">All suppliers</option>{data!.filters.suppliers.map((c) => <option key={c}>{c}</option>)}</select>}
        <span className="ml-auto flex flex-wrap gap-2">
          <Button icon={<Save className="h-4 w-4" />} onClick={save} disabled={!items.length}>Save List</Button>
          <Button icon={<Download className="h-4 w-4" />} onClick={exportCsv} disabled={!chosen.length}>Export List</Button>
          <Button variant="primary" icon={<FileText className="h-4 w-4" />} loading={busy} onClick={openReview} disabled={!chosen.length}>Create Purchase Order</Button>
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-stone">
        <span><b className="num font-medium text-ink">{chosen.length}</b> selected</span>
        <span>Estimated cost <b className="num font-medium text-ink">{money(estimate)}</b>{costMissing && ' (some costs missing)'}</span>
        {data?.saved && <span>Saved list from {new Date(data.saved.savedAt).toLocaleString()}{data.saved.savedBy ? ` by ${data.saved.savedBy}` : ''}</span>}
        <span>Shows products out of stock, under 5 available, or selling out within 14 days. Addendum Hair (Shopify) stock.</span>
      </div>

      {urgentK.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-xl2 border border-rose/30 bg-rose/5 px-4 py-3 text-[14px] text-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose" />
          <span><b className="font-medium">Don’t wait on these K-Tips:</b> {urgentK.map((r) => r.label).join(', ')} — {urgentK.length === 1 ? 'it runs' : 'they run'} out before a new order could arrive. Order {urgentK.length === 1 ? 'it' : 'them'} with the wefts.</span>
        </div>
      )}

      {error ? <ErrorNote error={error} onRetry={() => refetch()} /> : isLoading ? <PageLoading /> : !items.length ? (
        <div className="panel"><EmptyState title="Nothing needs ordering">No wefts or K-Tips are out of stock, under 5, or selling out within 14 days.</EmptyState></div>
      ) : (
        <>
          <Section title="Wefts — order first" rows={wefts} qOf={qOf} isIn={isIn} setInclude={(k, v) => setInclude({ ...include, [k]: v })} setQty={(k, v) => setQty({ ...qty, [k]: v })} onPrefs={setPrefsFor} />
          <Section title="K-Tips — order second" rows={ktips} qOf={qOf} isIn={isIn} setInclude={(k, v) => setInclude({ ...include, [k]: v })} setQty={(k, v) => setQty({ ...qty, [k]: v })} onPrefs={setPrefsFor} />
        </>
      )}

      {review && <ReviewModal plan={plan} review={review} rules={data?.supplierRules ?? {}} onFix={(k, v) => { setQty({ ...qty, [k]: v }); setReview(null); }}
        onExclude={(k) => { setInclude({ ...include, [k]: false }); setReview(null); }}
        onClose={() => setReview(null)} onDone={() => { setReview(null); void qc.invalidateQueries({ queryKey: ['reorder-list'] }); onOrders(); }} />}
      {prefsFor && <PrefsModal r={prefsFor} onClose={() => { setPrefsFor(null); void refetch(); }} />}
    </div>
  );
}

function Section({ title, rows, qOf, isIn, setInclude, setQty, onPrefs }: {
  title: string; rows: Row[]; qOf: (r: Row) => number; isIn: (r: Row) => boolean; setInclude: (k: string, v: boolean) => void; setQty: (k: string, v: number) => void; onPrefs: (r: Row) => void;
}) {
  if (!rows.length) return null;
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink">{title} <span className="font-normal text-stone">({rows.length})</span></h2>
      <div className="panel divide-y divide-line !p-0">
        {rows.map((r) => {
          const q = qOf(r);
          const bad = isIn(r) ? problemOf(q, r) : null;
          return (
            <div key={r.key} className={cx('grid gap-3 px-3 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-start', !isIn(r) && 'opacity-60')}>
              <label className="flex items-center gap-2 sm:pt-0.5">
                <input type="checkbox" className="h-5 w-5 accent-plum" checked={isIn(r)} onChange={(e) => setInclude(r.key, e.target.checked)} aria-label={`Include ${r.label}`} />
                <span className="text-[14px] font-medium text-ink sm:hidden">{r.label}</span>
              </label>
              <div className="min-w-0">
                <p className="hidden text-[14px] font-medium text-ink sm:block">{r.label}</p>
                <p className="text-[12px] text-stone">{[r.sku ?? 'No SKU', r.type === 'weft' ? 'Weft' : 'K-Tip', r.supplier ?? 'No supplier', r.collection].filter(Boolean).join(' · ')}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">{r.badges.map((b) => <Badge key={b} tone={BADGE_TONE[b] ?? 'neutral'}>{b}</Badge>)}</div>
                <dl className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-6">
                  <Stat k="Available" v={r.available} warn={r.available <= 0} />
                  <Stat k="Incoming" v={r.incoming} />
                  <Stat k="Sales / day" v={r.noSales ? '—' : r.ratePerDay.toFixed(2)} sub={`${r.units30} in 30d`} />
                  <Stat k="Stockout" v={r.daysUntilStockout == null ? '—' : r.daysUntilStockout <= 0 ? 'Now' : `${r.daysUntilStockout}d`} warn={r.daysUntilStockout != null && r.daysUntilStockout <= 14} />
                  <Stat k="Lead time" v={`${r.leadDays}d`} sub={r.shippingDays ? `${r.productionDays} + ${r.shippingDays} ship` : undefined} />
                  <Stat k="MOQ / case" v={`${r.moq ?? '—'} / ${r.caseSize ?? '—'}`} />
                </dl>
                {r.warning && <p className="mt-2 flex items-start gap-1.5 text-[13px] text-rose"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{r.warning}</p>}
                <p className="mt-1.5 text-[12px] text-ink-soft"><span className="text-stone">{r.planNote}:</span> {r.explain}</p>
                {r.flags.length > 0 && <p className="mt-1 text-[12px] text-amber">{r.flags.join(' · ')}</p>}
                {r.prefs.notes && <p className="mt-1 text-[12px] text-stone">Note: {r.prefs.notes}</p>}
              </div>
              <div className="flex items-start gap-2 sm:w-40 sm:flex-col sm:items-end">
                <label className="flex-1 sm:flex-none">
                  <span className="block text-[11px] text-stone sm:text-right">Order qty{r.suggestedQty !== q ? ` (suggested ${r.suggestedQty})` : ''}</span>
                  <input type="number" min={0} inputMode="numeric" className={cx('field num h-11 w-full text-right text-[16px] sm:w-28', bad && 'border-rose')} value={q}
                    onChange={(e) => setQty(r.key, Math.max(0, Math.round(Number(e.target.value) || 0)))} disabled={!isIn(r)} />
                  {bad && <span className="mt-0.5 block text-[11px] text-rose sm:text-right">{bad}</span>}
                  {!bad && r.minimumQty && q > 0 && <span className="mt-0.5 block text-[11px] text-stone sm:text-right">Minimum {r.minimumQty}{q > r.suggestedQty ? ` · +${q - r.suggestedQty} extra` : ''}</span>}
                </label>
                <Button size="sm" variant="ghost" icon={<SlidersHorizontal className="h-3.5 w-3.5" />} onClick={() => onPrefs(r)}>Usual order</Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
const Stat = ({ k, v, sub, warn }: { k: string; v: string | number; sub?: string; warn?: boolean }) => (
  <div><dt className="text-stone">{k}</dt><dd className={cx('num text-[14px] text-ink', warn && 'font-medium text-rose')}>{v}{sub && <span className="block text-[11px] text-stone">{sub}</span>}</dd></div>
);

function ReviewModal({ plan, review, rules, onFix, onExclude, onClose, onDone }: {
  plan: Plan; review: Review; rules: ListResponse['supplierRules']; onFix: (k: string, v: number) => void; onExclude: (k: string) => void; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const bad = new Set(review.problems.map((p) => p.key));
  const ready = review.suppliers.filter((s) => s.supplier !== 'Supplier needed').flatMap((s) => s.lines).filter((l) => !bad.has(l.key));
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ orders: { number: number; supplier: string | null }[] }>('/inventory-sync/reorder-list/purchase-orders', { plan, lines: ready.map((l) => ({ key: l.key, qty: l.qty })) });
      toast(`Draft purchase order${r.orders.length === 1 ? '' : 's'} ${r.orders.map((o) => `#${o.number}`).join(', ')} created — review and mark as ordered when you send ${r.orders.length === 1 ? 'it' : 'them'}`);
      onDone();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  void rules;
  return (
    <Modal open wide onClose={onClose} title="Review purchase order"
      footer={<><Button variant="ghost" onClick={onClose}>Back to list</Button><Button variant="primary" loading={busy} disabled={!ready.length} onClick={create}>
        {review.problems.length ? `Create draft for ${ready.length} valid item${ready.length === 1 ? '' : 's'}` : `Create draft purchase order${review.suppliers.length > 1 ? 's' : ''}`}
      </Button></>}>
      {review.problems.length > 0 && (
        <div className="mb-4 rounded-lg border border-rose/30 bg-rose/5 p-3 text-[14px]">
          <p className="mb-1.5 font-medium text-ink">Fix or leave out these first</p>
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
            <span className="text-[13px] text-stone">{s.units} units · {s.estCents != null ? money(s.estCents) : `about ${money(s.estPartialCents)} (some costs missing)`}</span>
          </div>
          {s.warnings.map((w) => <p key={w} className="mb-1.5 flex items-start gap-1.5 text-[13px] text-amber"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{w}</p>)}
          <div className="panel divide-y divide-line !p-0 text-[14px]">
            {s.lines.map((l) => (
              <div key={l.key} className={cx('flex items-center gap-3 px-3 py-2', bad.has(l.key) && 'opacity-50')}>
                <span className="min-w-0 flex-1"><span className="block truncate">{l.label}</span><span className="text-[12px] text-stone">{l.sku ?? 'No SKU'} · lead {l.leadDays} days</span></span>
                <span className="num w-14 text-right">{l.qty}</span>
                <span className="num w-24 text-right text-stone">{l.costCents != null ? money(l.costCents * l.qty) : '—'}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="text-[12px] text-stone">This creates draft purchase orders (one per supplier) in Purchase orders. Nothing is sent to a supplier — mark an order as ordered once you’ve placed it.</p>
    </Modal>
  );
}

function PrefsModal({ r, onClose }: { r: Row; onClose: () => void }) {
  const toast = useToast();
  const [d, setD] = useState({ typicalQty: r.prefs.typicalQty?.toString() ?? '', preferredPlan: r.prefs.preferredPlan ?? '', safetyUnits: r.prefs.safetyUnits?.toString() ?? '', notes: r.prefs.notes ?? '', moq: r.moq?.toString() ?? '', caseSize: r.caseSize?.toString() ?? '' });
  const n = (s: string) => (s.trim() === '' ? null : Math.max(0, Math.round(Number(s))) || null);
  const usual = useMemo(() => { const s = r.history.map((h) => h.quantity).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; }, [r.history]);
  const save = async () => {
    try {
      await api.put('/inventory-sync/reorder-list/prefs', { key: r.key, typicalQty: n(d.typicalQty), preferredPlan: d.preferredPlan || null, safetyUnits: d.safetyUnits.trim() === '' ? null : Math.max(0, Math.round(Number(d.safetyUnits))), notes: d.notes || null });
      if (n(d.moq) !== r.moq || n(d.caseSize) !== r.caseSize) await api.put('/inventory-sync/stock/products/settings', { rows: [{ key: r.key, moq: n(d.moq), caseSize: n(d.caseSize) }] });
      onClose();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const f = (k: keyof typeof d) => ({ value: d[k], onChange: (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value }) });
  return (
    <Modal open onClose={onClose} title={`Usual order · ${r.label}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="space-y-3 text-[14px]">
        <p className="text-[13px] text-stone">{r.history.length ? <>Past orders: {r.history.map((h) => `${h.quantity} (#${h.number}, ${h.orderedOn})`).join(', ')} — usual {usual}.</> : 'No past orders of this product yet.'}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Typical order quantity" hint={usual ? `Blank = ${usual} from past orders` : 'Used for Normal Order'}><input className="field num" inputMode="numeric" placeholder={usual?.toString()} {...f('typicalQty')} /></Field>
          <Field label="Preferred plan" hint="Used for this product under Normal Order"><select className="field" {...f('preferredPlan')}><option value="">Normal (typical quantity)</option><option value="30">30-day coverage</option><option value="60">60-day coverage</option><option value="90">90-day coverage</option></select></Field>
          <Field label="Safety stock (units)" hint={`Blank = ${r.ratePerDay > 0 ? 'safety days × sales' : 'none'}`}><input className="field num" inputMode="numeric" {...f('safetyUnits')} /></Field>
          <span />
          <Field label="Minimum order (MOQ)" hint="This product’s own; blank = its supplier’s default"><input className="field num" inputMode="numeric" {...f('moq')} /></Field>
          <Field label="Case size / order increment"><input className="field num" inputMode="numeric" {...f('caseSize')} /></Field>
        </div>
        <Field label="Reorder notes"><textarea className="field min-h-[64px]" {...f('notes')} placeholder="e.g. Ask for the same dye lot" /></Field>
      </div>
    </Modal>
  );
}
