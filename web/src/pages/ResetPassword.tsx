import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { api } from '../api/client';
import { Button, Field, Spinner } from '../components/ui';

type TokenInfo = { valid: boolean; name?: string; purpose?: 'invite' | 'reset' };

/** Opened from a one-time link (new account or password reset). The link works once and expires. */
export function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const { data, isLoading } = useQuery({
    queryKey: ['reset-token', token],
    queryFn: () => api.get<TokenInfo>(`/auth/reset/${encodeURIComponent(token)}`).catch((): TokenInfo => ({ valid: false })),
    enabled: token.length > 20,
    retry: false,
  });
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pw !== pw2) return setError('The two passwords don’t match.');
    setBusy(true);
    try {
      await api.post('/auth/reset', { token, password: pw });
      setDone(true);
      // Clear the token from the address bar.
      window.history.replaceState(null, '', '/reset-password');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-paper px-5">
      <div className="w-full max-w-[380px]">
        <p className="text-center font-display text-[44px] font-semibold leading-none tracking-[0.02em]">Addendum</p>
        <div className="panel mt-8 p-6 shadow-lift">
          {done ? (
            <div className="text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-sage" />
              <p className="mt-3 text-[15px] text-ink">Your password is set.</p>
              <a href="/login" className="mt-4 inline-block text-plum underline">Sign in</a>
            </div>
          ) : isLoading ? <div className="flex justify-center py-6"><Spinner /></div> : !data?.valid ? (
            <div className="text-center text-[15px] text-ink-soft">
              <p>This link has expired or was already used.</p>
              <p className="mt-2 text-[13px] text-stone">Ask an administrator for a new link, or use “Forgot password?” on the sign-in page.</p>
              <a href="/login" className="mt-4 inline-block text-plum underline">Back to sign in</a>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <p className="text-[15px] text-ink">{data.purpose === 'invite' ? `Welcome${data.name ? `, ${data.name}` : ''}! Choose a password for your account.` : `Choose a new password${data.name ? `, ${data.name}` : ''}.`}</p>
              <Field label="New password" hint="At least 10 characters, with a number or symbol."><input className="field" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={10} /></Field>
              <Field label="Type it again"><input className="field" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></Field>
              {error && <p className="text-sm text-rose" role="alert">{error}</p>}
              <Button type="submit" variant="primary" className="w-full" loading={busy}>Set password</Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
