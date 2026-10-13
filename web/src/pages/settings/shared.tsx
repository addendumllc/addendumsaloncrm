import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AppSettings } from '@addendum/shared';
import { CheckCircle2, CircleDashed, AlertTriangle } from 'lucide-react';
import { api } from '../../api/client';
import { useMe, useSettings } from '../../api/hooks';
import { Button, cx, useToast } from '../../components/ui';

/** Local draft of one settings section with dirty tracking and a Save action. */
export function useSection<K extends keyof AppSettings>(key: K) {
  const { data } = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const server = data?.settings[key] as AppSettings[K] | undefined;
  const [draft, setDraft] = useState<AppSettings[K] | undefined>(server);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (server !== undefined && draft === undefined) setDraft(server);
  }, [server, draft]);
  const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(server);
  const set = <F extends keyof AppSettings[K]>(field: F, value: AppSettings[K][F]) => setDraft((d) => (d ? ({ ...(d as object), [field]: value } as unknown as AppSettings[K]) : d));
  const save = async (silent = false) => {
    if (draft === undefined) return;
    setSaving(true);
    try {
      const r = await api.patch<{ settings: AppSettings }>('/settings', { [key]: draft });
      qc.setQueryData(['settings'], { settings: r.settings });
      setDraft(r.settings[key]);
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      if (!silent) toast('Saved');
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };
  return { draft, set, setDraft, dirty, save, saving, reset: () => setDraft(server) };
}

export function useCan() {
  const { data: me } = useMe();
  return (p: string) => !!me && me.permissions.includes(p);
}

export function Card({ title, description, children, footer, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <section className={cx('panel', className)}>
      <div className="border-b border-line px-5 py-4">
        <h2 className="h-display text-[22px] leading-tight">{title}</h2>
        {description && <p className="mt-1 text-[13px] text-stone">{description}</p>}
      </div>
      <div className="px-5 py-4">{children}</div>
      {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
    </section>
  );
}

export function SaveBar({ dirty, saving, onSave, onReset, disabled }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void; disabled?: boolean }) {
  return (
    <>
      {dirty && <span className="mr-auto text-[13px] text-amber">Unsaved changes</span>}
      {dirty && <Button variant="ghost" onClick={onReset}>Discard</Button>}
      <Button variant="primary" onClick={onSave} loading={saving} disabled={!dirty || disabled}>Save changes</Button>
    </>
  );
}

/** Number input with a unit, e.g. "24 hours". */
export function NumberField({ label, value, onChange, unit, min = 0, max = 9999, hint, disabled }: { label: string; value: number; onChange: (n: number) => void; unit: string; min?: number; max?: number; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <span className="flex items-center gap-2">
        <input
          type="number" inputMode="numeric" min={min} max={max} disabled={disabled}
          className="field w-24 num"
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? min : Math.min(max, Math.max(min, Number(e.target.value))))}
        />
        <span className="text-sm text-stone">{unit}</span>
      </span>
      {hint && <span className="mt-1 block text-xs text-stone">{hint}</span>}
    </label>
  );
}

export function StatusLine({ state, children }: { state: 'ok' | 'off' | 'warn'; children: ReactNode }) {
  const Icon = state === 'ok' ? CheckCircle2 : state === 'warn' ? AlertTriangle : CircleDashed;
  return (
    <p className={cx('flex items-center gap-2 text-[15px] font-medium', state === 'ok' ? 'text-sage' : state === 'warn' ? 'text-amber' : 'text-stone')}>
      <Icon className="h-5 w-5" />{children}
    </p>
  );
}

/** Read-only value the owner may need to paste into another dashboard (redirect URL, webhook URL). */
export function CopyValue({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="mt-3">
      <span className="label">{label}</span>
      <div className="flex gap-2">
        <code className="flex-1 truncate rounded-lg border border-line bg-mist/60 px-3 py-2 text-[13px] text-ink-soft">{value}</code>
        <Button size="sm" className="h-auto" onClick={() => navigator.clipboard?.writeText(value).then(() => toast('Copied'), () => toast('Copy failed — select the text instead', 'error'))}>Copy</Button>
      </div>
    </div>
  );
}

export interface SetupInfo {
  demoMode: boolean;
  square: { environment: string; scopes: string[]; redirectUri: string; webhookUrl: string; webhookEvents: string[]; oauthConfigured: boolean; accessTokenConfigured: boolean; webhookKeyConfigured: boolean };
  sms: { provider: string; inboundWebhookUrl: string; statusWebhookUrl: string; configured: boolean };
  highlevel: { configured: boolean; scopes: string[] };
  ai: { configured: boolean; model: string };
  email: { configured: boolean; from: string | null; host: string | null };
  shopify: { configured: boolean; store: string | null; scopes: string[]; auth: 'admin_token' | 'client_credentials' | 'none'; locationConfigured: boolean };
}
