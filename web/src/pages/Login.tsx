import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { applyAccent } from '../lib/theme';
import { Button, Field } from '../components/ui';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cookiesBlocked, setCookiesBlocked] = useState(false);
  const [forgot, setForgot] = useState<'off' | 'form' | 'sent'>('off');
  const [forgotMsg, setForgotMsg] = useState('');
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data: cfg } = useQuery({ queryKey: ['auth-config'], queryFn: () => api.get<{ demoMode: boolean; accent?: string }>('/auth/config').then((c) => { applyAccent(c.accent); return c; }), staleTime: Infinity });
  const embedded = typeof window !== 'undefined' && window.self !== window.top;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { email, password });
      // Some browsers block sign-in cookies inside a website embed (third-party cookies).
      const ok = await api.get('/auth/me').then(() => true, () => false);
      if (!ok) {
        setCookiesBlocked(true);
        return;
      }
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav('/');
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
        <p className="mt-2 text-center text-[15px] text-stone">Sign in to the salon command center</p>
        <form onSubmit={submit} className="panel mt-8 space-y-4 p-6 shadow-lift">
          <Field label="Email"><input className="field" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label="Password"><input className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          {error && <p className="text-sm text-rose" role="alert">{error}</p>}
          {cookiesBlocked && (
            <div className="rounded-lg bg-amber-tint px-3 py-2 text-sm text-amber" role="alert">
              {embedded ? 'Your browser blocked sign-in inside the website.' : 'Your browser blocked the sign-in cookie. Allow cookies for this site and try again.'}
              {embedded && <a href={window.location.href} target="_blank" rel="noopener" className="mt-1 flex items-center gap-1 font-medium underline">Open the app in its own tab <ExternalLink className="h-3.5 w-3.5" /></a>}
            </div>
          )}
          <Button type="submit" variant="primary" className="w-full" loading={busy}>Sign in</Button>
          <button type="button" className="block w-full text-center text-[13px] text-stone hover:text-ink" onClick={() => setForgot('form')}>Forgot password?</button>
        </form>
        {forgot !== 'off' && (
          <div className="panel mt-4 p-5 text-[14px]">
            {forgot === 'sent' ? <p className="text-ink-soft">{forgotMsg}</p> : (
              <form className="space-y-3" onSubmit={async (e) => {
                e.preventDefault();
                const r = await api.post<{ message: string }>('/auth/forgot', { email }).catch((err) => ({ message: (err as Error).message }));
                setForgotMsg(r.message);
                setForgot('sent');
              }}>
                <p className="text-ink-soft">Enter your email and we’ll send a link to choose a new password.</p>
                <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@addendumsalon.com" required />
                <Button type="submit" className="w-full">Send reset link</Button>
              </form>
            )}
          </div>
        )}
        {cfg?.demoMode && <p className="mt-4 text-center text-xs text-stone">Demo Mode · owner@addendumsalon.com · addendum-demo</p>}
        {embedded && !cookiesBlocked && <p className="mt-2 text-center text-xs text-stone"><a href={window.location.href} target="_blank" rel="noopener" className="underline">Open in a new tab</a></p>}
      </div>
    </div>
  );
}
