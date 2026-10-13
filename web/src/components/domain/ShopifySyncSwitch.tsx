import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { cx, useToast } from '../ui';

/**
 * Per-product "Sync to Shopify" ON/OFF. Read-only for people who can't change it. Changing it only saves the
 * choice; stock moves on the next sync, never because of the switch itself.
 */
export function ShopifySyncSwitch({ variationId, label, enabled, canChange }: { variationId: string; label: string; enabled: boolean; canChange: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState(enabled);
  const change = async () => {
    const next = !on;
    setBusy(true);
    setOn(next);
    try {
      await api.put('/inventory-sync/products/shopify-sync', { variationIds: [variationId], enabled: next });
      toast(next ? `${label}: syncs to Shopify from the next sync` : `${label}: Square only — no longer synced to Shopify`);
      for (const k of ['square-inventory', 'inventory-sync', 'inventory-sync-links']) qc.invalidateQueries({ queryKey: [k] });
    } catch (e) {
      setOn(!next);
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const text = on ? 'On' : 'Off';
  if (!canChange) return <span className={cx('text-[12px] font-medium', on ? 'text-sage' : 'text-stone')}>{text}</span>;
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={`Sync ${label} to Shopify`} disabled={busy} onClick={change}
      className="inline-flex items-center gap-2 text-[12px] font-medium disabled:opacity-60"
    >
      <span className={cx('relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors', on ? 'bg-sage' : 'bg-line-strong')}>
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', on ? 'left-[18px]' : 'left-0.5')} />
      </span>
      <span className={on ? 'text-sage' : 'text-stone'}>{text}</span>
    </button>
  );
}
