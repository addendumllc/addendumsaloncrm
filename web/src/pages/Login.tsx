import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, UserPlus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { applyAppearance } from '../lib/theme';
import { BrandMark } from '../components/layout/Brand';
import { DEFAULT_APPEARANCE, type Appearance } from '@addendum/shared';
import { Button, Field } from '../components/ui';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cookiesBlocked, setCookiesBlocked] = useState(false);
  const [forgot, setForgot] = useState<'off' | 'form' | 'sent'>('off');
  const [forgotMsg, setForgotMsg] = useState('');
  const [requesting, setRequesting] = useState<'off' | 'form' | 'sent'>('off');
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data: cfg } = useQuery({ queryKey: ['auth-config'], queryFn: () => api.get<{ demoMode: boolean; accent?: string; appearance?: Appearance; allowAccessRequests?: boolean }>('/auth/config').then((c) => { applyAppearance(c.appearance ?? { accent: c.accent }); return c; }), staleTime: Infinity });
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
        <BrandMark a={{ ...DEFAULT_APPEARANCE, ...(cfg?.appearance ?? {}) }} size="login" />
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
        {cfg?.allowAccessRequests && requesting === 'off' && (
          <button type="button" className="mt-4 flex w-full items-center justify-center gap-1.5 text-[14px] text-plum hover:underline" onClick={() => setRequesting('form')}>
            <UserPlus className="h-4 w-4" />New here? Request access
          </button>
        )}
        {requesting !== 'off' && <RequestAccess sent={requesting === 'sent'} onSent={() => setRequesting('sent')} onCancel={() => setRequesting('off')} />}
        {cfg?.demoMode && <p className="mt-4 text-center text-xs text-stone">Demo Mode · owner@addendumsalon.com · addendum-demo</p>}
        {embedded && !cookiesBlocked && <p className="mt-2 text-center text-xs text-stone"><a href={window.location.href} target="_blank" rel="noopener" className="underline">Open in a new tab</a></p>}
      </div>
    </div>
  );
}

/** Ask for an account. It waits for an Admin's approval before it can be used. */
function RequestAccess({ sent, onSent, onCancel }: { sent: boolean; onSent: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [msg, setMsg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (sent) return <div className="panel mt-4 p-5 text-[14px] text-ink-soft" role="status">{msg}</div>;
  return (
    <form className="panel mt-4 space-y-3 p-5 text-[14px]" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const r = await api.post<{ message: string }>('/auth/request-access', f);
        setMsg(r.message);
        onSent();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    }}>
      <p className="font-medium text-ink">Request access</p>
      <p className="text-[13px] text-stone">Choose your sign-in details. An administrator approves new accounts before they can be used, and decides what you can see. No Square account needed.</p>
      <Field label="Full name"><input className="field" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
      <Field label="Email"><input className="field" type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
      <Field label="Password" hint="At least 10 characters, with letters and a number or symbol."><input className="field" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={10} /></Field>
      {error && <p className="text-sm text-rose" role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" className="flex-1" loading={busy}>Send request</Button>
      </div>
    </form>
  );
}
