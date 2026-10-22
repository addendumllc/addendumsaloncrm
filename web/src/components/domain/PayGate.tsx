import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { api } from '../../api/client';
import { Button, Field, PageLoading } from '../ui';

/** Is pay unlocked on this device (password or sign-in code confirmed in the last few minutes)? Re-checked every minute. */
export function usePayUnlock() {
  return useQuery({
    queryKey: ['pay-unlock'],
    queryFn: () => api.get<{ unlocked: boolean; minutes: number; until: string | null; canKeepUnlocked: boolean; sessionHours: number }>('/auth/reauth-status'),
    refetchInterval: 60_000,
  });
}

/** Everything that shows pay after a password check: commission, team commission, wages, taxes and dashboard amounts. */
const PAY_QUERIES = ['pay-unlock', 'commission-me', 'commission-team', 'commission-staff', 'pay-year', 'staff-pay', 'timesheet', 'dashboard'];

/**
 * Pay stays private on shared salon screens: children show only after the person re-enters their password (or sign-in
 * code). One unlock covers every pay screen for a few minutes on this device; the server checks it on every request.
 */
export function PayGate({ title = 'Enter your password to see pay', children }: { title?: string; children: ReactNode }) {
  const { data, isLoading } = usePayUnlock();
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keep, setKeep] = useState(true);
  if (isLoading || !data) return <PageLoading />;
  if (data.unlocked) return <>{children}</>;
  const unlock = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/confirm-password', { password, keepPayUnlocked: data.canKeepUnlocked && keep });
      setPassword('');
      for (const k of PAY_QUERIES) await qc.invalidateQueries({ queryKey: [k] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel mx-auto mt-6 max-w-md p-6 text-center">
      <Lock className="mx-auto h-8 w-8 text-stone" />
      <h2 className="h-display mt-2 text-[24px]">{title}</h2>
      <p className="mt-1 text-[14px] text-stone">Pay stays private on shared screens. It stays open for {data.canKeepUnlocked && keep ? `${data.sessionHours} hours` : `${data.minutes} minutes`} on this device. If you sign in with a code, use your code.</p>
      <form className="mt-4 text-left" onSubmit={(e) => { e.preventDefault(); if (password) void unlock(); }}>
        <Field label="Password or sign-in code"><input className="field" type="password" autoComplete="current-password" value={password} autoFocus onChange={(e) => setPassword(e.target.value)} /></Field>
        {data.canKeepUnlocked && (
          <label className="mt-3 flex items-start gap-2 text-[13px] text-ink-soft">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-plum" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            <span>Keep pay unlocked on this device for {data.sessionHours} hours (payroll and commission). Locks again after that, or when you press Lock now.</span>
          </label>
        )}
        {error && <p className="mt-2 text-sm text-rose" role="alert">{error}</p>}
        <Button type="submit" variant="primary" className="mt-3 w-full" loading={busy} disabled={!password}>Unlock</Button>
      </form>
    </div>
  );
}

/** "Pay unlocked until 3:45 PM · Lock now" while an Admin has kept pay unlocked for the session. */
export function PayLockBar() {
  const { data } = usePayUnlock();
  const qc = useQueryClient();
  if (!data?.unlocked || !data.until) return null;
  const lock = async () => {
    await api.post('/auth/lock-pay');
    for (const k of PAY_QUERIES) await qc.invalidateQueries({ queryKey: [k] });
  };
  return (
    <p className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-stone">
      <Lock className="h-3.5 w-3.5" />Pay unlocked on this device until {new Date(data.until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
      <button type="button" className="font-medium text-plum hover:underline" onClick={() => void lock()}>Lock now</button>
    </p>
  );
}
