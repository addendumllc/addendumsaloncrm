import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AccessStatusDTO } from '@addendum/shared';
import { RefreshCw, Wifi } from 'lucide-react';
import { api } from '../../api/client';
import { Button } from '../ui';
import { BrandMark, useAppearance } from './Brand';

/** Location & Access status for this connection. Re-checked when the server refuses a request for this reason. */
export function useAccessStatus() {
  const qc = useQueryClient();
  useEffect(() => {
    const again = () => void qc.invalidateQueries({ queryKey: ['access-status'] });
    window.addEventListener('addendum:network', again);
    return () => window.removeEventListener('addendum:network', again);
  }, [qc]);
  return useQuery({
    queryKey: ['access-status'],
    queryFn: () => api.get<{ status: AccessStatusDTO }>('/access/status').then((r) => r.status),
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });
}

/** Shown on a computer that isn't on the salon's internet while "Allow Access Anywhere" is off. */
export function NetworkBlocked({ status }: { status: AccessStatusDTO }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const a = useAppearance();
  const signOut = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    qc.clear();
    nav('/login');
  };
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-paper px-5">
      <div className="w-full max-w-[440px] text-center">
        <BrandMark a={a} size="login" />
        <div className="panel mt-8 p-6 text-left shadow-lift">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-amber-tint text-amber"><Wifi className="h-5 w-5" /></span>
          <h1 className="h-display mt-3 text-[26px] leading-tight">Connect to the salon or office network</h1>
          <p className="mt-2 text-[15px] text-ink-soft">
            On a computer, the CRM works on the salon’s or office’s internet connection. Connect this computer to one of those networks, then check again.
          </p>
          <p className="mt-2 text-[14px] text-stone">Working away from the salon? Ask an Owner or Admin to turn on <b className="font-medium text-ink-soft">Allow Access Anywhere</b> in Settings → Location & Access. Your phone keeps working as usual.</p>
          <p className="mt-3 text-[12px] text-stone">This connection: <span className="font-mono">{status.ip || 'unknown'}</span></p>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <Button variant="primary" className="h-11 flex-1" icon={<RefreshCw className="h-4 w-4" />} onClick={() => qc.invalidateQueries()}>Check again</Button>
            <Button variant="ghost" className="h-11" onClick={signOut}>Sign out</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
