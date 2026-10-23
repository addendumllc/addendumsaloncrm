import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import { DEFAULT_ORDER_HAIR, hairParts, type OrderHairLayout } from '@addendum/shared';
import { api } from '../../api/client';
import { ErrorNote, PageLoading, Toggle, cx } from '../../components/ui';
import { Card, SaveBar } from './shared';

type Product = { sku: string; label: string; available: number };
type Section = { draft?: { orderHair?: OrderHairLayout }; set: (k: 'orderHair', v: OrderHairLayout) => void; dirty: boolean; saving: boolean; save: () => unknown; reset: () => void };

/**
 * Settings → Order Hair → Products (administrators): which Shopify products Order Hair offers, and in what order —
 * collections first (as stylists choose them), then the products within each. "Only chosen products" hides the rest
 * (the server refuses them too).
 */
export function OrderHairProducts({ inv, locked }: { inv: Section; locked: boolean }) {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['shopify-hair-products', 'all'], queryFn: () => api.get<{ connected: boolean; products: Product[] }>('/inventory/shopify-products?all=1') });
  const layout: OrderHairLayout = { ...DEFAULT_ORDER_HAIR, ...(inv.draft?.orderHair ?? {}) };
  const put = (patch: Partial<OrderHairLayout>) => inv.set('orderHair', { ...layout, ...patch });
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const items = useMemo(() => (data?.products ?? []).map((p) => ({ ...p, ...hairParts(p.label) })), [data]);
  const allCollections = [...new Set(items.map((i) => i.collection))];
  // Collections in the saved order, then any new ones.
  const collections = [...layout.collections.filter((c) => allCollections.includes(c)), ...allCollections.filter((c) => !layout.collections.includes(c))];
  const listedPos = new Map(layout.listed.map((s, i) => [s.toLowerCase(), i]));
  const isOn = (sku: string) => !layout.onlyListed || listedPos.has(sku.toLowerCase());
  const ordered = (c: string) => items.filter((i) => i.collection === c).sort((a, b) => (listedPos.get(a.sku.toLowerCase()) ?? 1e9) - (listedPos.get(b.sku.toLowerCase()) ?? 1e9) || a.label.localeCompare(b.label));
  const moveCollection = (c: string, d: -1 | 1) => { const l = [...collections]; const i = l.indexOf(c); if (i + d < 0 || i + d >= l.length) return; [l[i], l[i + d]] = [l[i + d], l[i]]; put({ collections: l }); };
  // Product order and inclusion are kept in one list of SKUs (all collections), so rewrite it from what's shown.
  const writeListed = (byCollection: Map<string, string[]>) => put({ listed: collections.flatMap((c) => byCollection.get(c) ?? []) });
  const currentListed = () => new Map(collections.map((c) => [c, ordered(c).filter((i) => isOn(i.sku)).map((i) => i.sku)]));
  const toggle = (c: string, sku: string, on: boolean) => {
    const m = layout.onlyListed ? currentListed() : new Map(collections.map((c2) => [c2, ordered(c2).map((i) => i.sku)]));
    const list = m.get(c) ?? [];
    m.set(c, on ? [...list.filter((x) => x !== sku), sku] : list.filter((x) => x !== sku));
    writeListed(m);
    if (!layout.onlyListed && !on) put({ onlyListed: true, listed: collections.flatMap((c2) => m.get(c2) ?? []) });
  };
  const moveProduct = (c: string, sku: string, d: -1 | 1) => {
    const m = new Map(collections.map((c2) => [c2, ordered(c2).filter((i) => isOn(i.sku)).map((i) => i.sku)]));
    const l = m.get(c) ?? []; const i = l.indexOf(sku);
    if (i < 0 || i + d < 0 || i + d >= l.length) return;
    [l[i], l[i + d]] = [l[i + d], l[i]];
    writeListed(m);
  };
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return (
    <Card title="Products in Order Hair" description="Which products stylists can order, and in what order. They choose a collection first, then the length, then the colour."
      footer={<SaveBar dirty={inv.dirty} saving={inv.saving} onSave={() => inv.save()} onReset={inv.reset} disabled={locked} />}>
      {isLoading ? <PageLoading /> : error || !data ? <ErrorNote error={error} onRetry={refetch} /> : !data.connected ? <p className="text-[13px] text-stone">Connect Shopify to choose products.</p> : (
        <div className="space-y-3">
          <Toggle checked={layout.onlyListed} disabled={locked} onChange={(v) => put(v ? { onlyListed: true, listed: collections.flatMap((c) => ordered(c).map((i) => i.sku)) } : { onlyListed: false })}
            label="Only chosen products" description="Off: every product with stock tracking is offered. On: only the ticked ones below." />
          <label className="relative block sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
            <input className="field h-10 pl-9" placeholder="Find a product" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a product" />
          </label>
          <ul className="divide-y divide-line border border-line">
            {collections.map((c, ci) => {
              const list = ordered(c).filter((i) => words.every((w) => `${i.label} ${i.sku}`.toLowerCase().includes(w)));
              if (words.length && !list.length) return null;
              const on = ordered(c).filter((i) => isOn(i.sku)).length;
              const expanded = open === c || words.length > 0;
              return (
                <li key={c}>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(expanded && !words.length ? null : c)} aria-expanded={expanded}>
                      <span className="text-[14px] font-medium text-ink">{c}</span>
                      <span className="ml-2 text-[12px] text-stone">{on} of {ordered(c).length} offered</span>
                    </button>
                    <button type="button" disabled={locked || ci === 0} onClick={() => moveCollection(c, -1)} className="p-1 text-stone hover:text-ink disabled:opacity-30" aria-label={`Move ${c} up`}><ArrowUp className="h-4 w-4" /></button>
                    <button type="button" disabled={locked || ci === collections.length - 1} onClick={() => moveCollection(c, 1)} className="p-1 text-stone hover:text-ink disabled:opacity-30" aria-label={`Move ${c} down`}><ArrowDown className="h-4 w-4" /></button>
                  </div>
                  {expanded && (
                    <ul className="border-t border-line bg-mist/30">
                      {list.map((i) => {
                        const included = isOn(i.sku);
                        return (
                          <li key={i.sku} className={cx('flex items-center gap-2 px-4 py-1.5 text-[13px]', !included && 'opacity-60')}>
                            <input type="checkbox" className="h-4 w-4 accent-plum" disabled={locked} checked={included} onChange={(e) => toggle(c, i.sku, e.target.checked)} aria-label={`Offer ${i.label}`} />
                            <span className="min-w-0 flex-1 truncate text-ink">{[i.length, i.color].filter(Boolean).join(' · ')}<span className="ml-2 font-mono text-[11px] text-stone">{i.sku}</span></span>
                            {included && layout.onlyListed && <>
                              <button type="button" disabled={locked} onClick={() => moveProduct(c, i.sku, -1)} className="p-0.5 text-stone hover:text-ink" aria-label={`Move ${i.label} up`}><ArrowUp className="h-3.5 w-3.5" /></button>
                              <button type="button" disabled={locked} onClick={() => moveProduct(c, i.sku, 1)} className="p-0.5 text-stone hover:text-ink" aria-label={`Move ${i.label} down`}><ArrowDown className="h-3.5 w-3.5" /></button>
                            </>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          {!layout.onlyListed && <p className="text-[12px] text-stone">Untick a product to start choosing (only the ticked ones are then offered); product order can be changed once “Only chosen products” is on.</p>}
        </div>
      )}
    </Card>
  );
}
