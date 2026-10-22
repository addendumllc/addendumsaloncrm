import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Search } from 'lucide-react';
import { api } from '../../api/client';
import { Button, EmptyState, ErrorNote, Field, PageLoading, cx, useToast } from '../ui';

interface Listing { variantId: string; productId: string; inventoryItemId: string; label: string; priceCents: number | null }
interface Row { key: string; label: string; sku: string | null; costCents: number | null; square: { variationId: string; priceCents: number | null } | null; shopify: Listing[]; shopify2: Listing[] }
interface PriceData { rows: Row[]; stores: { square: string; shopify: string; shopify2: string | null }; errors: string[] }
type Col = 'square' | 'shopify' | 'shopify2';
type Draft = { cost?: string; square?: string; shopify?: Record<string, string>; shopify2?: Record<string, string> };

const toCents = (s: string) => { const n = Number(s.replace(/[$,\s]/g, '')); return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
const dollars = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));
/** Margin on the unit cost: (price − cost) ÷ price. */
const margin = (price: number | null, cost: number | null) => (price && cost != null && price > 0 ? Math.round(((price - cost) / price) * 100) : null);

/**
 * Inventory → Pricing: each product's unit cost and its price in every store — the salon (Square), and each Shopify
 * store (e.g. stylist pricing on the pro store, retail on the other) — side by side, with margins. Change any of them
 * here (one by one, or many at once) and Save sends them to the stores.
 */
export function PricingView() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['stock-prices'], queryFn: () => api.get<PriceData>('/inventory-sync/stock/prices') });
  const [q, setQ] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ col: Col; how: 'markup' | 'percent' | 'set'; value: string }>({ col: 'shopify', how: 'markup', value: '2' });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<{ key: string; store: string; message: string }[]>([]);
  const cols = useMemo(() => {
    if (!data) return [] as { col: Col; name: string }[];
    return [
      { col: 'square' as const, name: data.stores.square },
      { col: 'shopify' as const, name: data.stores.shopify },
      ...(data.stores.shopify2 ? [{ col: 'shopify2' as const, name: data.stores.shopify2 }] : []),
    ];
  }, [data]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = (data?.rows ?? []).filter((r) => words.every((w) => `${r.label} ${r.sku ?? ''}`.toLowerCase().includes(w)));
  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;

  const set = (key: string, patch: Draft) => setDrafts((d) => ({ ...d, [key]: { ...d[key], ...patch, shopify: { ...d[key]?.shopify, ...patch.shopify }, shopify2: { ...d[key]?.shopify2, ...patch.shopify2 } } }));
  const costOf = (r: Row) => (drafts[r.key]?.cost !== undefined ? toCents(drafts[r.key].cost!) : r.costCents);
  const priceOf = (r: Row, col: Col, l?: Listing) =>
    col === 'square' ? (drafts[r.key]?.square !== undefined ? toCents(drafts[r.key].square!) : r.square?.priceCents ?? null)
      : drafts[r.key]?.[col]?.[l!.variantId] !== undefined ? toCents(drafts[r.key][col]![l!.variantId]) : l!.priceCents;

  // What changed (only real changes are sent).
  const changes = Object.entries(drafts).flatMap(([key, d]) => {
    const r = data.rows.find((x) => x.key === key);
    if (!r) return [];
    const c: Record<string, unknown> = { key };
    if (d.cost !== undefined && toCents(d.cost) !== r.costCents && (d.cost.trim() === '' || toCents(d.cost) != null)) c.costCents = d.cost.trim() === '' ? null : toCents(d.cost);
    if (d.square !== undefined && toCents(d.square) != null && toCents(d.square) !== r.square?.priceCents) c.square = toCents(d.square);
    for (const col of ['shopify', 'shopify2'] as const) {
      const list = r[col].filter((l) => d[col]?.[l.variantId] !== undefined && toCents(d[col]![l.variantId]) != null && toCents(d[col]![l.variantId]) !== l.priceCents)
        .map((l) => ({ variantId: l.variantId, productId: l.productId, priceCents: toCents(d[col]![l.variantId])! }));
      if (list.length) c[col] = list;
    }
    return Object.keys(c).length > 1 ? [c] : [];
  });
  const invalid = Object.values(drafts).some((d) => [d.square, ...Object.values(d.shopify ?? {}), ...Object.values(d.shopify2 ?? {})].some((v) => v !== undefined && v.trim() !== '' && toCents(v) == null));

  const applyBulk = () => {
    const v = Number(bulk.value);
    if (!Number.isFinite(v)) return toast('Enter a number.', 'error');
    let n = 0;
    for (const r of data.rows.filter((x) => selected.has(x.key))) {
      const calc = (current: number | null) => {
        const cost = costOf(r);
        const cents = bulk.how === 'markup' ? (cost != null ? Math.round(cost * v) : null)
          : bulk.how === 'percent' ? (current != null ? Math.round(current * (1 + v / 100)) : null)
            : Math.round(v * 100);
        return cents == null ? null : dollars(cents);
      };
      if (bulk.col === 'square' && r.square) { const p = calc(priceOf(r, 'square')); if (p != null) { set(r.key, { square: p }); n++; } }
      if (bulk.col !== 'square') for (const l of r[bulk.col]) { const p = calc(priceOf(r, bulk.col, l)); if (p != null) { set(r.key, { [bulk.col]: { [l.variantId]: p } }); n++; } }
    }
    toast(n ? `${n} price${n === 1 ? '' : 's'} filled in — review, then Save` : bulk.how === 'markup' ? 'Those products need a unit cost first.' : 'Nothing to change for those products.', n ? 'success' : 'error');
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put<{ saved: number; failed: { key: string; store: string; message: string }[] }>('/inventory-sync/stock/prices', { changes });
      setFailed(r.failed);
      // Keep the edits that didn't save so they can be retried.
      const keep = new Set(r.failed.map((f) => f.key));
      setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => keep.has(k))));
      await qc.invalidateQueries({ queryKey: ['stock-prices'] });
      qc.invalidateQueries({ queryKey: ['stock-products'] });
      toast(r.failed.length ? `${r.saved} saved · ${r.failed.length} didn’t save (listed above)` : `Saved · ${r.saved} change${r.saved === 1 ? '' : 's'} sent to the stores`, r.failed.length ? 'error' : 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.key));
  const priceCell = (r: Row, col: Col) => {
    const cost = costOf(r);
    if (col === 'square') {
      if (!r.square) return <span className="text-[12px] text-stone">Not in the salon</span>;
      const p = priceOf(r, 'square');
      return <PriceInput value={drafts[r.key]?.square ?? dollars(r.square.priceCents)} changed={drafts[r.key]?.square !== undefined && toCents(drafts[r.key].square!) !== r.square.priceCents} onChange={(v) => set(r.key, { square: v })} margin={margin(p, cost)} label={`${r.label} — ${data.stores.square} price`} />;
    }
    if (!r[col].length) return <span className="text-[12px] text-stone">Not listed</span>;
    return (
      <div className="space-y-1.5">
        {r[col].map((l) => {
          const p = priceOf(r, col, l);
          const val = drafts[r.key]?.[col]?.[l.variantId];
          // A store can list one SKU twice (e.g. stylist and salon prices): show which listing.
          const tag = r[col].length > 1 ? (l.label.match(/\(([^)]+)\)\s*$/)?.[1] ?? l.label.split(/\s+[-–/]\s+/).pop()) : null;
          return <PriceInput key={l.variantId} tag={tag} value={val ?? dollars(l.priceCents)} changed={val !== undefined && toCents(val) !== l.priceCents} onChange={(v) => set(r.key, { [col]: { [l.variantId]: v } })} margin={margin(p, cost)} label={`${r.label} — ${col === 'shopify' ? data.stores.shopify : data.stores.shopify2} price${tag ? ` (${tag})` : ''}`} />;
        })}
      </div>
    );
  };

  return (
    <div>
      <p className="mb-3 text-[13px] text-stone">Unit cost and each store’s price in one place: {cols.map((c) => c.name).join(', ')}. Stylists pay the pro store’s price and retail customers the other — each is set separately. Margins are on the unit cost. Save sends changes to the stores; unit cost is also set on each Shopify listing.</p>
      {data.errors.map((e) => <p key={e} className="mb-2 flex items-start gap-2 border border-amber/40 bg-amber-tint px-3 py-2 text-[13px] text-amber"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{e}</p>)}
      {failed.length > 0 && (
        <div className="mb-3 border border-rose/40 bg-rose-tint px-3 py-2 text-[13px] text-rose" role="alert">
          <p className="font-medium">These didn’t save (your edits are kept — fix and Save again):</p>
          <ul className="mt-1 list-disc pl-5">{failed.map((f, i) => <li key={i}>{data.rows.find((r) => r.key === f.key)?.label ?? f.key} · {f.store}: {f.message}</li>)}</ul>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="relative min-w-[14rem] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
          <input className="field h-10 pl-9" placeholder="Search name or SKU" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search products" />
        </label>
        <span className="ml-auto text-[13px] text-stone">{changes.length ? `${changes.length} product${changes.length === 1 ? '' : 's'} changed` : 'No changes yet'}</span>
        {changes.length > 0 && <Button variant="ghost" onClick={() => { setDrafts({}); setFailed([]); }}>Discard</Button>}
        <Button variant="primary" loading={saving} disabled={!changes.length || invalid} onClick={save}>Save to stores</Button>
      </div>

      {/* Many at once: tick products, then a markup on cost, a % change, or one price for a store. */}
      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-end gap-2 border border-line bg-white p-3">
          <span className="pb-2 text-[13px] font-medium text-ink">{selected.size} selected</span>
          <Field label="Store">
            <select className="field h-9 w-auto py-1 text-sm" value={bulk.col} onChange={(e) => setBulk({ ...bulk, col: e.target.value as Col })}>
              {cols.map((c) => <option key={c.col} value={c.col}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="How">
            <select className="field h-9 w-auto py-1 text-sm" value={bulk.how} onChange={(e) => setBulk({ ...bulk, how: e.target.value as typeof bulk.how, value: e.target.value === 'markup' ? '2' : e.target.value === 'percent' ? '5' : '' })}>
              <option value="markup">Unit cost × markup</option><option value="percent">Change by %</option><option value="set">Set one price</option>
            </select>
          </Field>
          <Field label={bulk.how === 'markup' ? 'Markup (×)' : bulk.how === 'percent' ? '% (− to lower)' : 'Price ($)'}>
            <input className="field h-9 w-28 py-1 text-sm" inputMode="decimal" value={bulk.value} onChange={(e) => setBulk({ ...bulk, value: e.target.value })} />
          </Field>
          <Button size="sm" onClick={applyBulk}>Fill in</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>
      )}

      {!rows.length ? <div className="panel"><EmptyState title="No products">{q ? 'Nothing matches that search.' : 'No products in the stores yet.'}</EmptyState></div> : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-stone">
                <th className="w-8 px-3 py-2"><input type="checkbox" className="h-4 w-4 accent-plum" checked={allOn} onChange={() => setSelected(allOn ? new Set() : new Set(rows.map((r) => r.key)))} aria-label="Select all" /></th>
                <th className="px-3 py-2 font-medium">Product</th>
                <th className="px-3 py-2 font-medium">Unit cost</th>
                {cols.map((c) => <th key={c.col} className="px-3 py-2 font-medium">{c.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={cx('border-b border-line/70 align-top last:border-0', selected.has(r.key) && 'bg-plum-tint/30')}>
                  <td className="px-3 py-3"><input type="checkbox" className="h-4 w-4 accent-plum" checked={selected.has(r.key)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })} aria-label={`Select ${r.label}`} /></td>
                  <td className="px-3 py-3"><span className="block text-ink">{r.label}</span>{r.sku && <span className="font-mono text-[12px] text-stone">{r.sku}</span>}</td>
                  <td className="px-3 py-3"><PriceInput value={drafts[r.key]?.cost ?? dollars(r.costCents)} changed={drafts[r.key]?.cost !== undefined && toCents(drafts[r.key].cost!) !== r.costCents} onChange={(v) => set(r.key, { cost: v })} label={`${r.label} — unit cost`} /></td>
                  {cols.map((c) => <td key={c.col} className="px-3 py-3">{priceCell(r, c.col)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PriceInput({ value, onChange, changed, margin: m, label, tag }: { value: string; onChange: (v: string) => void; changed: boolean; margin?: number | null; label: string; tag?: string | null }) {
  const bad = value.trim() !== '' && toCents(value) == null;
  return (
    <div>
      {tag && <span className="block text-[11px] text-stone">{tag}</span>}
      <label className="relative block w-28">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone">$</span>
        <input className={cx('field h-9 py-1 pl-6 text-sm num', changed && 'border-plum bg-plum-tint/40', bad && 'border-rose')} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} aria-invalid={bad} />
      </label>
      {m != null && <span className={cx('mt-0.5 block text-[11px]', m < 30 ? 'text-rose' : 'text-stone')}>{m}% margin</span>}
    </div>
  );
}
