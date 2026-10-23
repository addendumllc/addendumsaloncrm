import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Ruler } from 'lucide-react';
import { api } from '../../api/client';
import { Button, Field, Modal, useToast } from '../ui';

interface Planned { store: 'pro' | 'retail' | 'square'; label: string; fromSku: string; sku: string; option: string; priceCents: number; pro?: boolean }
interface Plan { stores: { pro: string; retail: string | null; square: string }; plan: Planned[]; skipped: { store: string; label: string; reason: string }[] }

const cents = (s: string) => { const n = Number(s.replace(/[$,\s]/g, '')); return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Inventory → Products: a new length for products that come in another one (e.g. 22" Clip-Ins next to the 18"). */
export function AddLengthButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" icon={<Ruler className="h-4 w-4" />} onClick={() => setOpen(true)}>Add a length</Button>
      {open && <AddLength onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Which products, which length to copy and the new one, and a price per store (blank leaves that store out). Preview
 * lists every variant that would be made — same SKU with the length swapped (18-BMCI-120g → 22-BMCI-120g), stock 0 —
 * and nothing is created until Create.
 */
function AddLength({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ search: '', from: '', to: '', pro: '', retail: '', retailPro: '', square: '' });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setPlan(null); };
  const body = () => ({ search: f.search, from: f.from, to: f.to, prices: { pro: cents(f.pro), retail: cents(f.retail), retailPro: cents(f.retailPro), square: cents(f.square) } });
  const ready = f.search.trim() && /^\d+$/.test(f.from) && /^\d+$/.test(f.to) && f.from !== f.to && [f.pro, f.retail, f.retailPro, f.square].some((x) => cents(x) != null);

  const run = async (create: boolean) => {
    setBusy(true);
    try {
      if (!create) { setPlan(await api.post<Plan>('/inventory-sync/stock/new-length/preview', body())); return; }
      const r = await api.post<{ created: number; failed: { label: string; store: string; message: string }[] }>('/inventory-sync/stock/new-length', body());
      for (const k of ['stock-products', 'stock-prices', 'inventory-sync', 'square-inventory', 'shopify-hair-products']) qc.invalidateQueries({ queryKey: [k] });
      toast(r.failed.length ? `${r.created} added · ${r.failed.length} didn’t save (${r.failed[0].label}: ${r.failed[0].message})` : `${r.created} variations added — they pair on the next sync`, r.failed.length ? 'error' : 'success');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const storeName = (p: Planned) => (p.store === 'pro' ? plan!.stores.pro : p.store === 'square' ? plan!.stores.square : `${plan!.stores.retail}${p.pro ? '-Pro' : ''}`);
  const price = (k: 'pro' | 'retail' | 'retailPro' | 'square', label: string) => (
    <Field label={label}>
      <span className="relative block"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone">$</span>
        <input className="field pl-6" inputMode="decimal" value={f[k]} onChange={(e) => set(k, e.target.value)} placeholder="Leave out" /></span>
    </Field>
  );

  return (
    <Modal open wide onClose={onClose} title="Add a length" footer={<>
      <span className="mr-auto text-[13px] text-stone">{plan ? `${plan.plan.length} to create${plan.skipped.length ? ` · ${plan.skipped.length} left alone` : ''}` : 'Preview first — nothing changes until you press Create'}</span>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      {plan
        ? <Button variant="primary" loading={busy} disabled={!plan.plan.length} onClick={() => run(true)}>Create {plan.plan.length}</Button>
        : <Button variant="primary" loading={busy} disabled={!ready} onClick={() => run(false)}>Preview</Button>}
    </>}>
      <div className="space-y-4 text-[14px]">
        <p className="text-[13px] text-ink-soft">Adds a new length to products that already come in another one, in every store that sells them. The SKU stays the same with the length swapped (18-BMCI-120g → 22-BMCI-120g). Stock starts at 0.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Products named"><input className="field" value={f.search} onChange={(e) => set('search', e.target.value)} placeholder="e.g. Clip-Ins" autoFocus /></Field>
          <Field label="Copy length"><input className="field" inputMode="numeric" value={f.from} onChange={(e) => set('from', e.target.value)} placeholder="18" /></Field>
          <Field label="New length"><input className="field" inputMode="numeric" value={f.to} onChange={(e) => set('to', e.target.value)} placeholder="22" /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          {price('pro', 'Pro store price')}
          {price('retail', 'Retail (DTC) price')}
          {price('retailPro', 'Retail store’s Pro listing')}
          {price('square', 'Salon (Square) price')}
        </div>
        {plan && (plan.plan.length ? (
          <div className="max-h-[45vh] overflow-auto border border-line">
            <table className="w-full min-w-[620px] text-[13px]">
              <thead className="sticky top-0 bg-white"><tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-stone">
                <th className="px-3 py-2 font-medium">Store</th><th className="px-3 py-2 font-medium">Product</th><th className="px-3 py-2 font-medium">New variation</th><th className="px-3 py-2 font-medium">SKU</th><th className="px-3 py-2 text-right font-medium">Price</th>
              </tr></thead>
              <tbody>{plan.plan.map((p, i) => (
                <tr key={i} className="border-b border-line/60 last:border-0">
                  <td className="whitespace-nowrap px-3 py-1.5 text-stone">{storeName(p)}</td><td className="px-3 py-1.5 text-ink">{p.label}</td><td className="px-3 py-1.5">{p.option}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[12px] text-stone">{p.sku}</td><td className="num px-3 py-1.5 text-right font-medium">{money(p.priceCents)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="text-[13px] text-stone">Nothing to create — no product matches, or the new length is already there.</p>)}
        {plan && plan.skipped.length > 0 && (
          <details className="text-[13px] text-ink-soft"><summary className="cursor-pointer">{plan.skipped.length} left alone</summary>
            <ul className="mt-1 space-y-0.5">{plan.skipped.map((s, i) => <li key={i}>{s.store} · {s.label} — {s.reason}</li>)}</ul></details>
        )}
      </div>
    </Modal>
  );
}
