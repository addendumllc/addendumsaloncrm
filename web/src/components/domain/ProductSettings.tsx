import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import type { StockProductDTO, StockProductStatus, SupplierDTO } from '@addendum/shared';
import { api } from '../../api/client';
import { useCanDo } from '../../api/hooks';
import { Button, Field, Modal, PageLoading, cx, useToast } from '../ui';

type Plan = 'normal' | '30' | '60' | '90';
interface PrefsResponse {
  prefs: { typicalQty: number | null; preferredPlan: Plan | null; safetyUnits: number | null; notes: string | null };
  history: { quantity: number; orderedOn: string; number: number }[];
  usualFromHistory: number | null;
}

/** Who may change a product's ordering settings (lead times, minimum order, usual order). */
export const useCanEditProducts = () => useCanDo()('inventory:sync');

/**
 * The one place to change a product's ordering settings, opened from any product anywhere in the CRM: supplier and
 * cost, lead time and transit, minimum order and case size, and the usual order (typical quantity, plan, safety, notes).
 */
export function ProductSettingsModal({ productKey, onClose }: { productKey: string; onClose: () => void }) {
  const { data: products } = useQuery({ queryKey: ['stock-products'], queryFn: () => api.get<{ products: StockProductDTO[] }>('/inventory-sync/stock/products'), staleTime: 20_000 });
  const { data: prefs } = useQuery({ queryKey: ['reorder-prefs', productKey], queryFn: () => api.get<PrefsResponse>(`/inventory-sync/reorder-list/prefs?key=${encodeURIComponent(productKey)}`) });
  const p = products?.products.find((x) => x.key === productKey);
  if (!products || !prefs) return <Modal open onClose={onClose} title="Product settings"><PageLoading /></Modal>;
  if (!p) return <Modal open onClose={onClose} title="Product settings"><p className="text-[14px] text-stone">This product wasn’t found. Refresh and try again.</p></Modal>;
  return <Form p={p} prefs={prefs} onClose={onClose} />;
}

function Form({ p, prefs, onClose }: { p: StockProductDTO; prefs: PrefsResponse; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: suppliers } = useQuery({ queryKey: ['stock-suppliers'], queryFn: () => api.get<{ suppliers: SupplierDTO[] }>('/inventory-sync/stock/suppliers').then((r) => r.suppliers), staleTime: 30_000 });
  const str = (v: number | string | null | undefined) => (v == null ? '' : String(v));
  const [d, setD] = useState({
    collection: str(p.collection), supplier: str(p.supplier), supplierSku: str(p.supplierSku), cost: p.costCents != null ? (p.costCents / 100).toFixed(2) : '',
    lead: str(p.leadTimeDays), ship: str(p.shippingDays), moq: str(p.moq), caseSize: str(p.caseSize), safety: str(p.safetyDays), note: str(p.orderNote), status: p.status,
    typical: str(prefs.prefs.typicalQty), plan: prefs.prefs.preferredPlan ?? '', safetyUnits: str(prefs.prefs.safetyUnits), reorderNote: str(prefs.prefs.notes),
  });
  const [busy, setBusy] = useState(false);
  const sup = suppliers?.find((x) => x.name === (d.supplier || suppliers.find((y) => y.isDefault)?.name));
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const int = (v: string) => (num(v) == null ? null : Math.round(num(v)!));
  const bad = ['cost', 'lead', 'ship', 'moq', 'caseSize', 'safety', 'typical', 'safetyUnits'].filter((k) => { const n = num(d[k as keyof typeof d] as string); return n != null && !(n >= 0); });
  const f = (k: keyof typeof d) => ({ value: d[k] as string, onChange: (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value }) });
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/inventory-sync/stock/products/settings', { rows: [{
        key: p.key, collection: d.collection.trim() || null, supplier: d.supplier.trim() || null, supplierSku: d.supplierSku.trim() || null,
        costCents: num(d.cost) == null ? null : Math.round(num(d.cost)! * 100), leadTimeDays: int(d.lead), shippingDays: int(d.ship),
        moq: int(d.moq), caseSize: num(d.caseSize) ? int(d.caseSize) : null, safetyDays: int(d.safety), orderNote: d.note.trim() || null, status: d.status,
      }] });
      await api.put('/inventory-sync/reorder-list/prefs', { key: p.key, typicalQty: int(d.typical) || null, preferredPlan: d.plan || null, safetyUnits: int(d.safetyUnits), notes: d.reorderNote.trim() || null });
      for (const k of ['stock-products', 'stock-forecast', 'stock-prices', 'stock-suppliers', 'reorder-list', 'reorder-prefs']) void qc.invalidateQueries({ queryKey: [k] });
      toast('Saved');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const g = 'mb-1 mt-4 text-[12px] font-semibold uppercase tracking-wide text-stone first:mt-0';
  const usual = prefs.usualFromHistory;
  return (
    <Modal open wide onClose={onClose} title={p.label} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={bad.length > 0} onClick={save}>Save</Button></>}>
      <div className="text-[14px]">
        <p className={g}>Lead time</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Production (days)" hint={sup?.leadTimeDays != null ? `Blank = ${sup.name}’s ${sup.leadTimeDays}` : 'Blank = the default'}><input className="field num" inputMode="numeric" placeholder={str(sup?.leadTimeDays)} {...f('lead')} /></Field>
          <Field label="Transit (days)" hint={sup?.shippingDays != null ? `Blank = ${sup.name}’s ${sup.shippingDays}` : 'Blank = none'}><input className="field num" inputMode="numeric" placeholder={str(sup?.shippingDays)} {...f('ship')} /></Field>
          <Field label="Total"><p className="py-2 text-ink">{(num(d.lead) ?? sup?.leadTimeDays) == null ? <span className="text-stone">The forecast default</span> : `${(num(d.lead) ?? sup!.leadTimeDays!) + (num(d.ship) ?? sup?.shippingDays ?? 0)} days`}</p></Field>
        </div>

        <p className={g}>Minimum order</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="MOQ" hint={sup?.defaultMoq != null ? `Blank = ${sup.defaultMoq}` : 'Blank = none'}><input className="field num" inputMode="numeric" placeholder={str(sup?.defaultMoq)} {...f('moq')} /></Field>
          <Field label="Case size / order in" hint="Orders round up to full cases"><input className="field num" inputMode="numeric" {...f('caseSize')} /></Field>
          <Field label="Safety stock (days)"><input className="field num" inputMode="numeric" {...f('safety')} /></Field>
        </div>

        <p className={g}>Usual order</p>
        <p className="mb-2 text-[13px] text-stone">{prefs.history.length ? <>Past orders: {prefs.history.map((h) => `${h.quantity} (#${h.number}, ${h.orderedOn})`).join(', ')}.</> : 'No past orders of this product yet.'}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Suggested each time" hint={usual ? `Blank = ${usual} from past orders` : 'Reorder List: Suggested and Normal Order'}><input className="field num" inputMode="numeric" placeholder={str(usual)} {...f('typical')} /></Field>
          <Field label="Preferred plan" hint="Used under Normal Order">
            <select className="field" value={d.plan} onChange={(e) => setD({ ...d, plan: e.target.value })}><option value="">Typical quantity</option><option value="30">30-day coverage</option><option value="60">60-day coverage</option><option value="90">90-day coverage</option></select>
          </Field>
          <Field label="Safety stock (units)" hint="Blank = safety days × sales"><input className="field num" inputMode="numeric" {...f('safetyUnits')} /></Field>
        </div>
        <Field label="Reorder note" className="mt-3"><input className="field" maxLength={1000} {...f('reorderNote')} placeholder="e.g. Ask for the same dye lot" /></Field>

        <details className="mt-4 rounded-xl border border-line p-3">
          <summary className="cursor-pointer text-[13px] font-medium text-ink">Supplier, cost and status</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Supplier"><input className="field" list="ps-supplier-names" {...f('supplier')} placeholder={suppliers?.find((y) => y.isDefault)?.name ?? ''} /><datalist id="ps-supplier-names">{(suppliers ?? []).map((x) => <option key={x.name} value={x.name} />)}</datalist></Field>
            <Field label="Supplier SKU"><input className="field font-mono" {...f('supplierSku')} /></Field>
            <Field label="Our cost ($)" hint="What we pay. Never shown to customers."><input className="field num" inputMode="decimal" {...f('cost')} /></Field>
            <Field label="Purchasing collection" hint="Groups it in To order. Blank = the store collections."><input className="field" {...f('collection')} /></Field>
            <Field label="Ordering note"><input className="field" maxLength={500} {...f('note')} /></Field>
            <Field label="Status">
              <select className="field" value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as StockProductStatus })}>
                <option value="active">Active</option><option value="discontinued">Discontinued</option><option value="not_tracked">Not tracked</option>
              </select>
            </Field>
          </div>
        </details>
        {bad.length > 0 && <p className="mt-2 text-[13px] text-rose">Numbers can’t be negative.</p>}
      </div>
    </Modal>
  );
}

/** A small button next to a product (anywhere it's listed) that opens its settings — for people allowed to change them. */
export function ProductSettingsButton({ productKey, className, label }: { productKey: string; className?: string; label?: string }) {
  const allowed = useCanEditProducts();
  const [open, setOpen] = useState(false);
  if (!allowed || !productKey) return null;
  return (
    <>
      <button type="button" title="Lead time, MOQ & usual order" aria-label="Product settings: lead time, MOQ and usual order"
        className={cx('inline-flex shrink-0 items-center gap-1 rounded p-1 text-[12px] text-stone hover:bg-mist hover:text-plum', className)}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(true); }}>
        <SlidersHorizontal className="h-3.5 w-3.5" />{label}
      </button>
      {open && <ProductSettingsModal productKey={productKey} onClose={() => setOpen(false)} />}
    </>
  );
}
