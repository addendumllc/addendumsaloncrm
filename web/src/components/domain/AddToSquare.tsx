import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { api } from '../../api/client';
import { Button, EmptyState, ErrorNote, Modal, PageLoading, cx, useToast } from '../ui';

interface Candidate { key: string; label: string; sku: string; onlineQty: number | null; itemName: string; variationName: string; categoryName: string | null; priceCents: number | null }
type Edit = { itemName: string; variationName: string; categoryName: string; price: string };

const dollars = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2));
const cents = (s: string) => { const n = Number(s.replace(/[$,\s]/g, '')); return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };

/** Inventory → Products: online products that aren't in Square yet, added to Square in one go (you check every line first). */
export function AddToSquareButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>Add online products to Square</Button>
      {open && <AddToSquare onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Pick online products (search e.g. “Clip-Ins”), check the Square names, category and price, then Create. Each one is
 * created with stock tracking, starts at the online count and is paired with its Shopify product right away.
 */
function AddToSquare({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['to-square'], gcTime: 0, queryFn: () => api.get<{ products: Candidate[] }>('/inventory-sync/stock/to-square').then((r) => r.products) });
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [allPrice, setAllPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(() => (data ?? []).filter((c) => words.every((w) => `${c.label} ${c.sku}`.toLowerCase().includes(w))), [data, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const editOf = (c: Candidate): Edit => edits[c.key] ?? { itemName: c.itemName, variationName: c.variationName, categoryName: c.categoryName ?? '', price: dollars(c.priceCents) };
  const set = (c: Candidate, patch: Partial<Edit>) => setEdits((e) => ({ ...e, [c.key]: { ...editOf(c), ...patch } }));
  const chosen = (data ?? []).filter((c) => picked.has(c.key));
  const bad = chosen.filter((c) => { const e = editOf(c); return !e.itemName.trim() || !e.variationName.trim() || cents(e.price) == null; });
  const allOn = shown.length > 0 && shown.every((c) => picked.has(c.key));

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ created: number; skipped: { label: string; reason: string }[] }>('/inventory-sync/stock/to-square', {
        items: chosen.map((c) => { const e = editOf(c); return { key: c.key, itemName: e.itemName, variationName: e.variationName, categoryName: e.categoryName.trim() || null, priceCents: cents(e.price)! }; }),
      });
      for (const k of ['stock-products', 'stock-prices', 'inventory-sync', 'square-inventory']) qc.invalidateQueries({ queryKey: [k] });
      toast(r.skipped.length ? `${r.created} added to Square · ${r.skipped.length} skipped (${r.skipped[0].label}: ${r.skipped[0].reason})` : `${r.created} product${r.created === 1 ? '' : 's'} added to Square and paired`, r.skipped.length ? 'error' : 'success');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open wide onClose={onClose} title="Add online products to Square" footer={<>
      <span className="mr-auto text-[13px] text-stone">{chosen.length ? `${chosen.length} selected` : 'Tick the products to add'}{bad.length ? ` · ${bad.length} need a name or price` : ''}</span>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={busy} disabled={!chosen.length || bad.length > 0} onClick={create}>{chosen.length ? `Add ${chosen.length} to Square` : 'Add to Square'}</Button>
    </>}>
      {isLoading ? <PageLoading /> : error || !data ? <ErrorNote error={error} onRetry={refetch} /> : !data.length ? (
        <EmptyState title="Everything is in Square">Every online product with a SKU is already in Square.</EmptyState>
      ) : (
        <div className="space-y-3 text-[14px]">
          <p className="text-[13px] text-ink-soft">Each product is created in Square with stock tracking, the same SKU (so it stays paired), and starts at the online count. Check the names, category and price — nothing is added until you press Add.</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="relative min-w-[14rem] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
              <input className="field h-10 pl-9" placeholder="Search, e.g. Clip-Ins" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search online products" autoFocus />
            </label>
            <label className="flex items-center gap-2 text-[13px] text-ink-soft">Price for all selected
              <span className="relative w-28"><span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone">$</span>
                <input className="field h-10 pl-6" inputMode="decimal" value={allPrice} onChange={(e) => setAllPrice(e.target.value)} aria-label="Price for all selected" /></span>
            </label>
            <Button size="sm" disabled={!chosen.length || cents(allPrice) == null} onClick={() => { for (const c of chosen) set(c, { price: allPrice }); }}>Apply</Button>
          </div>
          <div className="max-h-[55vh] overflow-auto border border-line">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-stone">
                  <th className="w-8 px-3 py-2"><input type="checkbox" className="h-4 w-4 accent-plum" checked={allOn} onChange={() => setPicked((p) => { const n = new Set(p); for (const c of shown) { if (allOn) n.delete(c.key); else n.add(c.key); } return n; })} aria-label="Select all shown" /></th>
                  <th className="px-3 py-2 font-medium">Online product</th>
                  <th className="px-3 py-2 font-medium">Square item</th>
                  <th className="px-3 py-2 font-medium">Variation</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Price</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const e = editOf(c);
                  const on = picked.has(c.key);
                  return (
                    <tr key={c.key} className={cx('border-b border-line/60 align-top last:border-0', on && 'bg-plum-tint/30')}>
                      <td className="px-3 py-2"><input type="checkbox" className="h-4 w-4 accent-plum" checked={on} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); return n; })} aria-label={`Select ${c.label}`} /></td>
                      <td className="px-3 py-2"><span className="block text-ink">{c.label}</span><span className="font-mono text-[11px] text-stone">{c.sku}</span><span className="block text-[11px] text-stone">{c.onlineQty ?? 0} in stock online</span></td>
                      <td className="px-3 py-2"><input className="field h-9 py-1 text-[13px]" value={e.itemName} onChange={(x) => set(c, { itemName: x.target.value })} aria-label={`Square item name for ${c.label}`} /></td>
                      <td className="px-3 py-2"><input className="field h-9 w-32 py-1 text-[13px]" value={e.variationName} onChange={(x) => set(c, { variationName: x.target.value })} aria-label={`Variation for ${c.label}`} /></td>
                      <td className="px-3 py-2"><input className="field h-9 py-1 text-[13px]" value={e.categoryName} onChange={(x) => set(c, { categoryName: x.target.value })} aria-label={`Category for ${c.label}`} /></td>
                      <td className="px-3 py-2"><span className="relative block w-24"><span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-stone">$</span>
                        <input className={cx('field h-9 py-1 pl-5 text-[13px]', on && cents(e.price) == null && 'border-rose')} inputMode="decimal" value={e.price} onChange={(x) => set(c, { price: x.target.value })} aria-label={`Price for ${c.label}`} /></span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
