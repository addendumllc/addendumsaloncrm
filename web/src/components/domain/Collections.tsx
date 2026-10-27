import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, CornerDownRight, FolderTree, Pencil, Plus, Trash2 } from 'lucide-react';
import type { StockProductDTO } from '@addendum/shared';
import { api } from '../../api/client';
import { Button, Field, Modal, PageLoading, Toggle, cx, useToast } from '../ui';

export type CollectionList = { collections: { name: string; products: number; total?: number }[]; withoutCollection: number };
/** Sub-collections are "Milbon / Shampoo": shown as "Milbon › Shampoo". */
export const SUB_SEP = ' / ';
export const parentOf = (name: string) => (name.includes(SUB_SEP) ? name.slice(0, name.indexOf(SUB_SEP)) : null);
export const collectionLabel = (name: string | null | undefined) => (name ?? '').split(SUB_SEP).join(' › ');
/** A product's collection is this one, or one of its sub-collections. */
export const inCollection = (productCollection: string | null | undefined, c: string) => !!productCollection && (productCollection === c || productCollection.startsWith(`${c}${SUB_SEP}`));
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
    // Sub-collections indented under their collection; picking a collection includes its sub-collections.
    options: [...own.map((c) => ({ value: c, label: parentOf(c) ? `\u00a0\u00a0› ${c.slice(c.indexOf(SUB_SEP) + SUB_SEP.length)}` : c })), { value: NO_COLLECTION, label: 'No collection' }],
    matches: (p: { collection?: string | null }, c: string) => (c === NO_COLLECTION ? !p.collection : inCollection(p.collection, c)),
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
  // Adding a sub-collection under this collection.
  const [addingSub, setAddingSub] = useState<{ parent: string; name: string } | null>(null);
  const [rule, setRule] = useState({ collection: '', storeCollection: '', nameContains: '', skuStarts: '', skuContains: '', onlyWithout: true });
  const [preview, setPreview] = useState<{ count: number; sample: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const storeCollections = [...new Set(products.flatMap((p) => p.collections.filter((c) => c !== p.collection)))].sort((a, b) => a.localeCompare(b));
  const names = data?.collections.map((c) => c.name) ?? [];
  const after = (d: CollectionList) => { qc.setQueryData(['stock-collections'], d); for (const k of ['stock-products', 'stock-forecast']) void qc.invalidateQueries({ queryKey: [k] }); };
  const call = async <T,>(p: Promise<T>, done?: (r: T) => void) => { setBusy(true); try { const r = await p; done?.(r); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); } };
  const saveOrder = (list: string[]) => call(api.put<CollectionList>('/inventory-sync/stock/collections', { names: list }), after);
  // Moving swaps with the next sibling: a collection moves with its sub-collections; a sub-collection within its collection.
  const siblingsOf = (n: string) => names.filter((x) => parentOf(x) === parentOf(n));
  const move = (n: string, d: -1 | 1) => {
    const sib = siblingsOf(n); const i = sib.indexOf(n); const other = sib[i + d];
    if (!other) return;
    const order = [...sib]; [order[i], order[i + d]] = [order[i + d], order[i]];
    const parent = parentOf(n);
    const flat = parent
      ? names.filter((x) => parentOf(x) !== parent).flatMap((x) => (x === parent ? [x, ...order] : [x]))
      : order.flatMap((p) => [p, ...names.filter((x) => parentOf(x) === p)]);
    void saveOrder(flat);
  };
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
              {data.collections.map((c) => {
                const parent = parentOf(c.name);
                const short = parent ? c.name.slice(parent.length + SUB_SEP.length) : c.name;
                const sib = siblingsOf(c.name);
                return (
                <li key={c.name} className={cx('px-3 py-2', parent && 'bg-mist/30 pl-8')}>
                  <div className="flex items-center gap-2">
                  {editing?.from === c.name ? (
                    <>
                      <input className="field h-9 flex-1" autoFocus value={editing.to} onChange={(e) => setEditing({ ...editing, to: e.target.value })} aria-label="New name" />
                      <Button size="sm" variant="primary" disabled={!editing.to.trim() || editing.to.includes('/')} onClick={() => call(api.post<CollectionList>('/inventory-sync/stock/collections/rename', { from: c.name, to: parent ? `${parent}${SUB_SEP}${editing.to.trim()}` : editing.to.trim() }), (d) => { after(d); setEditing(null); })}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                    </>
                  ) : (
                    <>
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-ink">{parent && <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-stone" />}{short}</span>
                      <span className="num text-[13px] text-stone" title={!parent && (c.total ?? 0) !== c.products ? 'Including its sub-collections' : undefined}>{!parent ? c.total ?? c.products : c.products} product{(!parent ? c.total ?? c.products : c.products) === 1 ? '' : 's'}</span>
                      {!parent && <button type="button" className="inline-flex items-center gap-0.5 rounded px-1.5 py-1 text-[12px] text-plum hover:bg-plum-tint" onClick={() => setAddingSub({ parent: c.name, name: '' })} aria-label={`Add a sub-collection to ${c.name}`}><Plus className="h-3.5 w-3.5" />Sub</button>}
                      <button type="button" className="p-1 text-stone hover:text-ink disabled:opacity-30" disabled={sib.indexOf(c.name) === 0 || busy} onClick={() => move(c.name, -1)} aria-label={`Move ${short} up`}><ArrowUp className="h-4 w-4" /></button>
                      <button type="button" className="p-1 text-stone hover:text-ink disabled:opacity-30" disabled={sib.indexOf(c.name) === sib.length - 1 || busy} onClick={() => move(c.name, 1)} aria-label={`Move ${short} down`}><ArrowDown className="h-4 w-4" /></button>
                      <button type="button" className="p-1 text-stone hover:text-ink" onClick={() => setEditing({ from: c.name, to: short })} aria-label={`Rename ${short}`}><Pencil className="h-4 w-4" /></button>
                      <button type="button" className="p-1 text-stone hover:text-rose" aria-label={`Remove ${short}`}
                        onClick={() => window.confirm(`Remove ${collectionLabel(c.name)}?${!parent && names.some((x) => parentOf(x) === c.name) ? ' Its sub-collections are removed too.' : ''} Its ${(!parent ? c.total : c.products) ?? c.products} product${((!parent ? c.total : c.products) ?? c.products) === 1 ? '' : 's'} will have no collection (nothing else changes).`) && call(api.post<CollectionList>('/inventory-sync/stock/collections/rename', { from: c.name, to: null }), after)}><Trash2 className="h-4 w-4" /></button>
                    </>
                  )}
                  </div>
                  {addingSub?.parent === c.name && (
                    <div className="mt-2 flex gap-2 pl-6">
                      <input className="field h-9 flex-1" autoFocus placeholder={`Sub-collection of ${c.name}, e.g. Shampoo`} value={addingSub.name} onChange={(e) => setAddingSub({ ...addingSub, name: e.target.value })} aria-label="Sub-collection name" />
                      <Button size="sm" variant="primary" disabled={!addingSub.name.trim() || addingSub.name.includes('/') || names.includes(`${c.name}${SUB_SEP}${addingSub.name.trim()}`)}
                        onClick={() => { const full = `${c.name}${SUB_SEP}${addingSub.name.trim()}`; void call(api.put<CollectionList>('/inventory-sync/stock/collections', { names: [...names, full] }), (d) => { after(d); setR({ collection: full }); setAddingSub(null); }); }}>Add</Button>
                      <Button size="sm" variant="ghost" onClick={() => setAddingSub(null)}>Cancel</Button>
                    </div>
                  )}
                </li>
                );
              })}
              {!data.collections.length && <li className="px-3 py-3 text-[13px] text-stone">No collections yet — add the first one below.</li>}
            </ul>
            <p className="mt-1 text-[12px] text-stone">{data.withoutCollection} product{data.withoutCollection === 1 ? '' : 's'} not in a collection yet.</p>
            <div className="mt-2 flex gap-2">
              <input className="field h-10 flex-1" placeholder="New collection, e.g. K-Tips (then + Sub for sub-collections)" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="New collection" />
              <Button disabled={!newName.trim() || newName.includes('/') || names.includes(newName.trim())} onClick={() => call(api.put<CollectionList>('/inventory-sync/stock/collections', { names: [...names, newName.trim()] }), (d) => { after(d); setR({ collection: newName.trim() }); setNewName(''); })}>Add</Button>
            </div>
          </section>

          <section className="rounded-xl border border-line p-3">
            <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone">Put products in a collection</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Collection">
                <select className="field" value={rule.collection} onChange={(e) => setR({ collection: e.target.value })}>
                  <option value="">— none (take them out) —</option>{names.map((n) => <option key={n} value={n}>{collectionLabel(n)}</option>)}
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
                onClick={() => call(api.post<{ count: number }>('/inventory-sync/stock/collections/assign', ruleBody()), (r) => { toast(`${r.count} product${r.count === 1 ? '' : 's'} ${rule.collection ? `put in ${collectionLabel(rule.collection)}` : 'taken out of their collection'}`); setPreview(null); void qc.invalidateQueries({ queryKey: ['stock-collections'] }); for (const k of ['stock-products', 'stock-forecast']) void qc.invalidateQueries({ queryKey: [k] }); })}>
                {rule.collection ? `Put ${preview.count} in ${collectionLabel(rule.collection)}` : `Take ${preview.count} out`}</Button>}
              {preview && <span className="text-[13px] text-stone">{preview.count ? `${preview.count} match${preview.count === 1 ? 'es' : ''}: ${preview.sample.join(', ')}${preview.count > preview.sample.length ? '…' : ''}` : 'Nothing matches.'}</span>}
            </div>
          </section>
          <p className="text-[12px] text-stone">One product at a time: open it from Inventory and use Edit settings, or tick products on Products and use Edit selected → Purchasing collection.</p>
        </div>
      )}
    </Modal>
  );
}
