import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, FolderTree, Pencil, Trash2 } from 'lucide-react';
import type { StockProductDTO } from '@addendum/shared';
import { api } from '../../api/client';
import { Button, Field, Modal, PageLoading, Toggle, useToast } from '../ui';

export type CollectionList = { collections: { name: string; products: number }[]; withoutCollection: number };
/** The salon's own inventory collections (with product counts). */
export const useInternalCollections = () => useQuery({ queryKey: ['stock-collections'], queryFn: () => api.get<CollectionList>('/inventory-sync/stock/collections'), staleTime: 30_000 });

/** "No collection" in the filters. */
export const NO_COLLECTION = '__none';
/**
 * Collection filter options: the salon's own collections when it has any (plus "No collection"), else the stores'.
 * `matches` is the filter to use with them.
 */
export function collectionFilter(internal: CollectionList | undefined, storeCollections: string[]) {
  const own = internal?.collections.map((c) => c.name) ?? [];
  if (!own.length) return { options: storeCollections.map((c) => ({ value: c, label: c })), matches: (p: { collections: string[] }, c: string) => p.collections.includes(c) };
  return {
    options: [...own.map((c) => ({ value: c, label: c })), { value: NO_COLLECTION, label: 'No collection' }],
    matches: (p: { collection?: string | null }, c: string) => (c === NO_COLLECTION ? !p.collection : p.collection === c),
  };
}

export function CollectionsButton({ products }: { products: StockProductDTO[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" icon={<FolderTree className="h-4 w-4" />} onClick={() => setOpen(true)}>Collections</Button>
      {open && <CollectionsModal products={products} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Inventory → Products → Collections: the salon's own collections for inventory (separate from the storefront
 * collections in Shopify and Square, which aren't changed). Add, order, rename or remove them, and put products in by
 * store collection, a word in the name, or how the SKU starts — with a count before anything changes.
 */
function CollectionsModal({ products, onClose }: { products: StockProductDTO[]; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useInternalCollections();
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ from: string; to: string } | null>(null);
  const [rule, setRule] = useState({ collection: '', storeCollection: '', nameContains: '', skuStarts: '', skuContains: '', onlyWithout: true });
  const [preview, setPreview] = useState<{ count: number; sample: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const storeCollections = [...new Set(products.flatMap((p) => p.collections.filter((c) => c !== p.collection)))].sort((a, b) => a.localeCompare(b));
  const names = data?.collections.map((c) => c.name) ?? [];
  const after = (d: CollectionList) => { qc.setQueryData(['stock-collections'], d); for (const k of ['stock-products', 'stock-forecast']) void qc.invalidateQueries({ queryKey: [k] }); };
  const call = async <T,>(p: Promise<T>, done?: (r: T) => void) => { setBusy(true); try { const r = await p; done?.(r); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); } };
  const saveOrder = (list: string[]) => call(api.put<CollectionList>('/inventory-sync/stock/collections', { names: list }), after);
  const move = (i: number, d: -1 | 1) => { const l = [...names]; if (i + d < 0 || i + d >= l.length) return; [l[i], l[i + d]] = [l[i + d], l[i]]; void saveOrder(l); };
  const ruleBody = () => ({
    collection: rule.collection.trim() || null, onlyWithout: rule.onlyWithout,
    ...(rule.storeCollection ? { storeCollection: rule.storeCollection } : {}), ...(rule.nameContains.trim() ? { nameContains: rule.nameContains.trim() } : {}),
    ...(rule.skuStarts.trim() ? { skuStarts: rule.skuStarts.trim() } : {}), ...(rule.skuContains.trim() ? { skuContains: rule.skuContains.trim() } : {}),
  });
  const hasRule = !!(rule.storeCollection || rule.nameContains.trim() || rule.skuStarts.trim() || rule.skuContains.trim());
  const setR = (p: Partial<typeof rule>) => { setRule({ ...rule, ...p }); setPreview(null); };

  return (
    <Modal open wide onClose={onClose} title="Inventory collections">
      {isLoading || !data ? <PageLoading /> : (
        <div className="space-y-5 text-[14px]">
          <p className="text-[13px] text-ink-soft">Your own collections for inventory — used for filters, To order, suggested orders and Analytics. The storefront collections in Shopify and Square stay as they are.</p>
          <section>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {data.collections.map((c, i) => (
                <li key={c.name} className="flex items-center gap-2 px-3 py-2">
                  {editing?.from === c.name ? (
                    <>
                      <input className="field h-9 flex-1" autoFocus value={editing.to} onChange={(e) => setEditing({ ...editing, to: e.target.value })} aria-label="New name" />
                      <Button size="sm" variant="primary" disabled={!editing.to.trim()} onClick={() => call(api.post<CollectionList>('/inventory-sync/stock/collections/rename', { from: c.name, to: editing.to }), (d) => { after(d); setEditing(null); })}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-ink">{c.name}</span>
                      <span className="num text-[13px] text-stone">{c.products} product{c.products === 1 ? '' : 's'}</span>
                      <button type="button" className="p-1 text-stone hover:text-ink disabled:opacity-30" disabled={i === 0 || busy} onClick={() => move(i, -1)} aria-label={`Move ${c.name} up`}><ArrowUp className="h-4 w-4" /></button>
                      <button type="button" className="p-1 text-stone hover:text-ink disabled:opacity-30" disabled={i === data.collections.length - 1 || busy} onClick={() => move(i, 1)} aria-label={`Move ${c.name} down`}><ArrowDown className="h-4 w-4" /></button>
                      <button type="button" className="p-1 text-stone hover:text-ink" onClick={() => setEditing({ from: c.name, to: c.name })} aria-label={`Rename ${c.name}`}><Pencil className="h-4 w-4" /></button>
                      <button type="button" className="p-1 text-stone hover:text-rose" aria-label={`Remove ${c.name}`}
                        onClick={() => window.confirm(`Remove ${c.name}? Its ${c.products} product${c.products === 1 ? '' : 's'} will have no collection (nothing else changes).`) && call(api.post<CollectionList>('/inventory-sync/stock/collections/rename', { from: c.name, to: null }), after)}><Trash2 className="h-4 w-4" /></button>
                    </>
                  )}
                </li>
              ))}
              {!data.collections.length && <li className="px-3 py-3 text-[13px] text-stone">No collections yet — add the first one below.</li>}
            </ul>
            <p className="mt-1 text-[12px] text-stone">{data.withoutCollection} product{data.withoutCollection === 1 ? '' : 's'} not in a collection yet.</p>
            <div className="mt-2 flex gap-2">
              <input className="field h-10 flex-1" placeholder="New collection, e.g. K-Tips" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="New collection" />
              <Button disabled={!newName.trim() || names.includes(newName.trim())} onClick={() => call(api.put<CollectionList>('/inventory-sync/stock/collections', { names: [...names, newName.trim()] }), (d) => { after(d); setR({ collection: newName.trim() }); setNewName(''); })}>Add</Button>
            </div>
          </section>

          <section className="rounded-xl border border-line p-3">
            <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone">Put products in a collection</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Collection">
                <select className="field" value={rule.collection} onChange={(e) => setR({ collection: e.target.value })}>
                  <option value="">— none (take them out) —</option>{names.map((n) => <option key={n}>{n}</option>)}
                </select>
              </Field>
              <Field label="Products in this store collection">
                <select className="field" value={rule.storeCollection} onChange={(e) => setR({ storeCollection: e.target.value })}>
                  <option value="">Any</option>{storeCollections.map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Name contains" hint="All the words, e.g. “clip-ins 22”."><input className="field" value={rule.nameContains} onChange={(e) => setR({ nameContains: e.target.value })} /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="SKU starts with"><input className="field font-mono" placeholder="18-" value={rule.skuStarts} onChange={(e) => setR({ skuStarts: e.target.value })} /></Field>
                <Field label="SKU contains"><input className="field font-mono" placeholder="CI" value={rule.skuContains} onChange={(e) => setR({ skuContains: e.target.value })} /></Field>
              </div>
            </div>
            <div className="mt-2"><Toggle checked={rule.onlyWithout} onChange={(v) => setR({ onlyWithout: v })} label="Only products not in a collection yet" /></div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button disabled={!hasRule || busy} onClick={() => call(api.post<{ count: number; sample: string[] }>('/inventory-sync/stock/collections/assign', { ...ruleBody(), preview: true }), setPreview)}>Preview</Button>
              {preview && <Button variant="primary" disabled={!preview.count || busy}
                onClick={() => call(api.post<{ count: number }>('/inventory-sync/stock/collections/assign', ruleBody()), (r) => { toast(`${r.count} product${r.count === 1 ? '' : 's'} ${rule.collection ? `put in ${rule.collection}` : 'taken out of their collection'}`); setPreview(null); void qc.invalidateQueries({ queryKey: ['stock-collections'] }); for (const k of ['stock-products', 'stock-forecast']) void qc.invalidateQueries({ queryKey: [k] }); })}>
                {rule.collection ? `Put ${preview.count} in ${rule.collection}` : `Take ${preview.count} out`}</Button>}
              {preview && <span className="text-[13px] text-stone">{preview.count ? `${preview.count} match${preview.count === 1 ? 'es' : ''}: ${preview.sample.join(', ')}${preview.count > preview.sample.length ? '…' : ''}` : 'Nothing matches.'}</span>}
            </div>
          </section>
          <p className="text-[12px] text-stone">One product at a time: open it from Inventory and use Edit settings, or tick products on Products and use Edit selected → Purchasing collection.</p>
        </div>
      )}
    </Modal>
  );
}
