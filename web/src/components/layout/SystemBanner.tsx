import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../api/client';
import { useCanDo } from '../../api/hooks';

interface SystemStatus {
  storage: { durable: boolean; detail: string };
  production: boolean;
  encryptionKey: 'ok' | 'new' | 'rotated' | 'changed';
  recoveryPasswordSet: boolean;
}

/** Owners/Admins only: warns when accounts could be lost in an update, or saved keys can't be read. */
export function SystemBanner() {
  const canDo = useCanDo();
  const allowed = canDo('settings:write') || canDo('integrations:manage');
  const { data } = useQuery({
    queryKey: ['admin-system'],
    queryFn: () => api.get<{ system: SystemStatus }>('/admin/system').then((r) => r.system),
    enabled: allowed,
    staleTime: 10 * 60_000,
  });
  if (!allowed || !data) return null;
  const notes: string[] = [];
  if (data.production && !data.storage.durable) notes.push('Accounts and settings are stored inside the app folder, so an update could erase them. Connect a PostgreSQL database (DATABASE_URL) on the server.');
  if (data.encryptionKey === 'changed') notes.push('The server’s ENCRYPTION_KEY changed, so saved integration keys can’t be read. Restore the previous key, or re-enter the keys in Settings → API & Integrations.');
  if (data.recoveryPasswordSet) notes.push('OWNER_RECOVERY_PASSWORD is still set on the server. Remove it now that you can sign in.');
  if (!notes.length) return null;
  return (
    <div role="alert" className="flex items-start gap-2 bg-amber-tint px-4 py-2 text-[13px] text-ink-soft">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
      <div className="space-y-0.5">{notes.map((n) => <p key={n}>{n}</p>)}</div>
    </div>
  );
}
