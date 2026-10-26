import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import type { StockForecastResponse, SupplierDTO } from '@addendum/shared';
import { api } from '../../api/client';
import { Badge, Button, EmptyState, Field, Modal, PageLoading, Segmented, Toggle, cx, useToast } from '../ui';

type Source = { kind: 'product' | 'collection' | 'supplier' | 'missing' | 'untracked'; label: string | null };
interface Rule { id: string; supplier: string; ref: string; label: string; productionDays: number; shippingDays: number | null; active: boolean; notes: string | null }
interface LeadTimes {
  supplier: { name: string; leadTimeDays: number | null; shippingDays: number | null; leadUntracked: boolean };
  rules: Rule[];
  products: { key: string; label: string; sku: string | null; collection: string | null; leadTimeDays: number | null; shippingDays: number | null; source: Source }[];
  collections: { ref: string; label: string }[];
}
type Draft = { kind: 'collection' | 'product'; id?: string; ref: string; label: string; production: string; shipping: string; active: boolean; notes: string };

const num = (v: string) => (v.trim() === '' ? null : Math.round(Number(v)));
const ok = (v: string, required: boolean) => (v.trim() === '' ? !required : Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 730);

/**
 * Suppliers → Lead times: one supplier's lead times — its default, rules for whole collections (Shopify's, by id, or
 * the salon's inventory collections) and products' own times. A product uses its own time, else its collections' rule
 * (the longest when it's in several, unless set to shortest), else the default; with none it's flagged.
 */
export function LeadTimesView({ suppliers }: { suppliers: SupplierDTO[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState(suppliers.find((s) => !s.leadUntracked)?.name ?? suppliers[0]?.name ?? '');
  const { data, isLoading, refetch } = useQuery({ queryKey: ['lead-times', name], enabled: !!name, queryFn: () => api.get<LeadTimes>(`/inventory-sync/stock/suppliers/lead-times?name=${encodeURIComponent(name)}`) });
  const { data: fc } = useQuery({ queryKey: ['stock-forecast'], queryFn: () => api.get<StockForecastResponse>('/inventory-sync/stock/forecast'), staleTime: 60_000 });
  const [def, setDef] = useState<{ production: string; shipping: string } | null>(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => { void refetch(); for (const k of ['stock-forecast', 'stock-products', 'stock-suppliers']) void qc.invalidateQueries({ queryKey: [k] }); };
  const run = async (p: Promise<unknown>, msg: string) => { setBusy(true); try { await p; toast(msg); refresh(); return true; } catch (e) { toast((e as Error).message, 'error'); return false; } finally { setBusy(false); } };

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = useMemo(() => {
    if (!data) return [];
    const r = [
      ...data.rules.map((x) => ({ kind: 'collection' as const, id: x.id, applies: x.label, sku: '', production: x.productionDays, shipping: x.shippingDays, active: x.active, notes: x.notes, rule: x, product: null })),
      ...data.products.filter((p) => p.leadTimeDays != null || p.shippingDays != null).map((p) => ({ kind: 'product' as const, id: p.key, applies: p.label, sku: p.sku ?? '', production: p.leadTimeDays, shipping: p.shippingDays, active: true, notes: p.collection ? `In ${p.collection}` : null, rule: null, product: p })),
    ];
    return r.filter((x) => words.every((w) => `${x.applies} ${x.sku} ${x.notes ?? ''}`.toLowerCase().includes(w)));
  }, [data, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const missing = data?.products.filter((p) => p.source.kind === 'missing') ?? [];

  const save = async (d: Draft) => {
    if (!ok(d.production, true) || !ok(d.shipping, false)) { toast('Enter whole days (0–730).', 'error'); return; }
    const done = d.kind === 'collection'
      ? await run(api.post('/inventory-sync/stock/suppliers/lead-rules', { id: d.id, supplier: name, ref: d.ref, label: d.label, productionDays: num(d.production), shippingDays: num(d.shipping), active: d.active, notes: d.notes.trim() || null }), 'Lead time saved')
      : await run(api.put('/inventory-sync/stock/products/settings', { rows: [{ key: d.ref, leadTimeDays: num(d.production), shippingDays: num(d.shipping) }] }), 'Lead time saved');
    if (done) setEditing(null);
  };
  const conflict = fc?.settings.collectionLeadConflict ?? 'longest';

  if (!suppliers.length) return <EmptyState title="No suppliers yet">Add a supplier first, then its lead times.</EmptyState>;
  return (
    <div className="space-y-4 text-[14px]">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Supplier">
          <select className="field w-auto min-w-[16rem]" value={name} onChange={(e) => { setName(e.target.value); setDef(null); }}>
            {suppliers.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </Field>
        {data && !data.supplier.leadUntracked && <>
          <Field label="Default production (days)" hint="For its products with no rule.">
            <input className="field num w-28" inputMode="numeric" value={def?.production ?? (data.supplier.leadTimeDays ?? '').toString()} onChange={(e) => setDef({ production: e.target.value, shipping: def?.shipping ?? (data.supplier.shippingDays ?? '').toString() })} />
          </Field>
          <Field label="Default shipping (days)">
            <input className="field num w-28" inputMode="numeric" value={def?.shipping ?? (data.supplier.shippingDays ?? '').toString()} onChange={(e) => setDef({ production: def?.production ?? (data.supplier.leadTimeDays ?? '').toString(), shipping: e.target.value })} />
          </Field>
          {def && <Button variant="primary" loading={busy} disabled={!ok(def.production, false) || !ok(def.shipping, false)}
            onClick={async () => { if (await run(api.put('/inventory-sync/stock/suppliers/lead-default', { name, leadTimeDays: num(def.production), shippingDays: num(def.shipping) }), 'Default saved')) setDef(null); }}>Save default</Button>}
        </>}
      </div>
      {isLoading || !data ? <PageLoading /> : data.supplier.leadUntracked ? (
        <p className="text-[13px] text-stone">{data.supplier.name}’s lead time isn’t tracked (Edit the supplier to change that), so its products are reordered on safety stock alone.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[14rem] flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
              <input className="field h-10 pl-9" placeholder="Search product, SKU or collection" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search lead times" />
            </label>
            <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} className="ml-auto" onClick={() => setEditing({ kind: 'collection', ref: '', label: '', production: '', shipping: '', active: true, notes: '' })}>Add lead time</Button>
          </div>
          <div className="overflow-x-auto rounded-xl2 border border-line bg-white">
            <table className="w-full min-w-[680px] text-left text-[13px]">
              <thead className="border-b border-line bg-mist/50 text-[11px] uppercase tracking-wide text-stone">
                <tr><th className="px-3 py-2">Applies to</th><th className="px-2 py-2 text-right">Production</th><th className="px-2 py-2 text-right">Shipping</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Notes</th><th className="w-20 px-2 py-2" /></tr>
              </thead>
              <tbody className="divide-y divide-line">
                <tr className="bg-mist/20">
                  <td className="px-3 py-2"><Badge>Default</Badge> <span className="ml-1 text-ink">Everything else from {data.supplier.name}</span></td>
                  <td className="num px-2 py-2 text-right">{data.supplier.leadTimeDays != null ? `${data.supplier.leadTimeDays} days` : <span className="text-amber">Not set</span>}</td>
                  <td className="num px-2 py-2 text-right">{data.supplier.shippingDays != null ? `${data.supplier.shippingDays} days` : '—'}</td>
                  <td className="px-2 py-2 text-stone">Active</td><td className="px-2 py-2" /><td />
                </tr>
                {rows.map((x) => (
                  <tr key={`${x.kind}-${x.id}`} className={cx(!x.active && 'opacity-60')}>
                    <td className="px-3 py-2"><Badge tone={x.kind === 'collection' ? 'plum' : 'neutral'}>{x.kind === 'collection' ? 'Collection' : 'Product'}</Badge> <span className="ml-1 text-ink">{x.applies}</span>{x.sku && <span className="ml-1 font-mono text-[11px] text-stone">{x.sku}</span>}</td>
                    <td className="num px-2 py-2 text-right">{x.production != null ? `${x.production} days` : <span className="text-stone">default</span>}</td>
                    <td className="num px-2 py-2 text-right">{x.shipping != null ? `${x.shipping} days` : <span className="text-stone">default</span>}</td>
                    <td className="px-2 py-2">{x.active ? 'Active' : 'Inactive'}</td>
                    <td className="px-2 py-2 text-ink-soft">{x.notes ?? ''}</td>
                    <td className="px-2 py-2 text-right">
                      <button type="button" className="p-1 text-stone hover:text-ink" aria-label={`Edit ${x.applies}`}
                        onClick={() => setEditing(x.rule
                          ? { kind: 'collection', id: x.rule.id, ref: x.rule.ref, label: x.rule.label, production: String(x.rule.productionDays), shipping: x.rule.shippingDays?.toString() ?? '', active: x.rule.active, notes: x.rule.notes ?? '' }
                          : { kind: 'product', ref: x.product!.key, label: x.product!.label, production: x.product!.leadTimeDays?.toString() ?? '', shipping: x.product!.shippingDays?.toString() ?? '', active: true, notes: '' })}><Pencil className="h-4 w-4" /></button>
                      <button type="button" className="p-1 text-stone hover:text-rose" aria-label={`Delete ${x.applies}`}
                        onClick={() => window.confirm(`Remove the lead time for ${x.applies}? ${x.kind === 'product' ? 'It will use its collection’s or the supplier’s.' : 'Its products will use their own or the supplier’s.'}`)
                          && run(x.rule ? api.del(`/inventory-sync/stock/suppliers/lead-rules/${x.rule.id}`) : api.put('/inventory-sync/stock/products/settings', { rows: [{ key: x.id, leadTimeDays: null, shippingDays: null }] }), 'Removed')}><Trash2 className="h-4 w-4" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <p className="px-3 py-3 text-[13px] text-stone">{q ? 'Nothing matches.' : 'No collection or product lead times yet — every product uses the default.'}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[13px] text-ink-soft">
            <span>A product in several collections with lead times uses the</span>
            <Segmented size="sm" value={conflict} onChange={(v) => fc && run(api.put('/inventory-sync/stock/forecast/settings', { ...fc.settings, collectionLeadConflict: v }), 'Saved')}
              options={[{ value: 'longest', label: 'Longest' }, { value: 'shortest', label: 'Shortest' }]} />
            <span className="text-stone">· A product’s own lead time always wins.</span>
          </div>
          {missing.length > 0 && (
            <p className="rounded-lg border border-amber/30 bg-amber-tint px-3 py-2 text-[13px] text-ink">
              <b className="font-medium">{missing.length} product{missing.length === 1 ? '' : 's'}</b> from {data.supplier.name} have no lead time (no default, rule or their own): {missing.slice(0, 6).map((m) => m.label).join(', ')}{missing.length > 6 ? '…' : ''}. Set a default or add a rule — until then To order uses the forecast default and flags them.
            </p>
          )}
        </>
      )}
      {editing && data && <RuleModal draft={editing} data={data} busy={busy} onChange={setEditing} onSave={save} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Add or change a lead time: for a whole collection, or for one product (from this supplier's products). */
function RuleModal({ draft: d, data, busy, onChange, onSave, onClose }: { draft: Draft; data: LeadTimes; busy: boolean; onChange: (d: Draft) => void; onSave: (d: Draft) => void; onClose: () => void }) {
  const [find, setFind] = useState('');
  const words = find.toLowerCase().split(/\s+/).filter(Boolean);
  const taken = new Set(data.rules.filter((r) => r.id !== d.id).map((r) => r.ref));
  const options = d.kind === 'collection'
    ? data.collections.filter((c) => !taken.has(c.ref)).map((c) => ({ value: c.ref, label: c.label }))
    : data.products.map((p) => ({ value: p.key, label: `${p.label}${p.sku ? ` · ${p.sku}` : ''}` }));
  const shown = options.filter((o) => o.value === d.ref || words.every((w) => o.label.toLowerCase().includes(w))).slice(0, 200);
  const valid = !!d.ref && ok(d.production, true) && ok(d.shipping, false);
  return (
    <Modal open onClose={onClose} title={d.id || (d.kind === 'product' && d.label) ? `Lead time · ${d.label}` : 'Add lead time'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!valid} onClick={() => onSave(d)}>Save</Button></>}>
      <div className="space-y-3 text-[14px]">
        {!d.id && <Segmented value={d.kind} onChange={(k) => onChange({ ...d, kind: k, ref: '', label: '' })} options={[{ value: 'collection', label: 'A collection' }, { value: 'product', label: 'One product' }]} />}
        <Field label={d.kind === 'collection' ? 'Collection' : 'Product'} hint={d.kind === 'collection' ? 'Shopify collections are kept by their id, so renaming one in Shopify keeps the rule.' : `${data.supplier.name}’s products. Give others to this supplier first (Suppliers → Add products).`}>
          <input className="field mb-1.5" placeholder="Search" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Search" />
          <select className="field" size={6} value={d.ref} onChange={(e) => onChange({ ...d, ref: e.target.value, label: options.find((o) => o.value === e.target.value)?.label.replace(/ \((Shopify|inventory collection)\)$/, '').replace(/ · [^·]+$/, '') ?? '' })}>
            {shown.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Production (calendar days)"><input className={cx('field num', !ok(d.production, true) && d.production !== '' && 'border-rose')} inputMode="numeric" value={d.production} onChange={(e) => onChange({ ...d, production: e.target.value })} /></Field>
          <Field label="Shipping (days, optional)" hint="Blank = the supplier’s."><input className={cx('field num', !ok(d.shipping, false) && 'border-rose')} inputMode="numeric" value={d.shipping} onChange={(e) => onChange({ ...d, shipping: e.target.value })} /></Field>
        </div>
        {d.kind === 'collection' && <>
          <Toggle checked={d.active} onChange={(v) => onChange({ ...d, active: v })} label="Active" description="Inactive rules are kept but not used." />
          <Field label="Notes (optional)"><input className="field" maxLength={500} value={d.notes} onChange={(e) => onChange({ ...d, notes: e.target.value })} /></Field>
        </>}
      </div>
    </Modal>
  );
}
