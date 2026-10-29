import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, UserPlus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { applyAppearance } from '../lib/theme';
import { BrandMark } from '../components/layout/Brand';
import { DEFAULT_APPEARANCE, DEFAULT_LOGIN, DEFAULT_WORKSPACES, type Appearance, type LoginSettings, type WorkspaceSettings } from '@addendum/shared';
import { Button, Field, Segmented, cx } from '../components/ui';

/** The Sign-in code tab on the sign-in screen (off for now). */
const SHOW_CODE_SIGN_IN = false;

/** How the sign-in sits over the photo on phones (Settings → Businesses → Sign-in page → Card on phones). */
const CARD: Record<'solid' | 'frosted' | 'clear' | 'none', { outer: string; form: string }> = {
  solid: { outer: 'rounded-2xl bg-paper px-5 py-7 shadow-pop', form: 'border-line bg-white' },
  frosted: { outer: 'rounded-2xl border border-white/50 bg-white/70 px-5 py-7 shadow-pop backdrop-blur-md', form: 'border-white/60 bg-white' },
  // See-through: the text on it is white (with a shadow) so it reads over the photo; the form stays solid to type in.
  clear: { outer: 'rounded-2xl border border-white/40 bg-black/25 px-5 py-7 shadow-pop backdrop-blur-[3px] [&>*:not(form):not(.panel)]:!text-white [&>*:not(form):not(.panel)_*]:!text-white', form: 'border-white bg-white' },
  // No card: the name and links sit on the photo (light, with a soft shadow); the form keeps a light box to type in.
  none: { outer: 'px-1 py-2 [&>*:not(form):not(.panel)]:!text-white [&>*:not(form):not(.panel)_*]:!text-white [&>*:not(form):not(.panel)]:[filter:drop-shadow(0_1px_6px_rgba(0,0,0,0.7))]', form: 'border-white bg-white text-ink shadow-pop' },
};

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'password' | 'code'>('password');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cookiesBlocked, setCookiesBlocked] = useState(false);
  const [forgot, setForgot] = useState<'off' | 'form' | 'sent'>('off');
  const [forgotMsg, setForgotMsg] = useState('');
  const [requesting, setRequesting] = useState<'off' | 'form' | 'sent'>('off');
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data: cfg } = useQuery({ queryKey: ['auth-config'], queryFn: () => api.get<{ demoMode: boolean; accent?: string; appearance?: Appearance; allowAccessRequests?: boolean; login?: LoginSettings; businesses?: WorkspaceSettings['businesses'] }>('/auth/config').then((c) => { applyAppearance(c.appearance ?? { accent: c.accent }, null); return c; }), staleTime: Infinity });
  const embedded = typeof window !== 'undefined' && window.self !== window.top;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'code') await api.post('/auth/login-code', { email, code });
      else await api.post('/auth/login', { email, password });
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
  const login = { ...DEFAULT_LOGIN, ...(cfg?.login ?? {}) };
  const biz = { ...DEFAULT_WORKSPACES.businesses, ...(cfg?.businesses ?? {}) };
  const photo = login.imageVersion ? `/brand/login-image?v=${encodeURIComponent(login.imageVersion)}` : null;
  return (
    <div className="relative grid min-h-[100dvh] bg-paper lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      {/* The editorial photo (Settings → Businesses): beside the form on large screens, behind it on phones. Decorative. */}
      <aside className="absolute inset-0 flex flex-col justify-between overflow-hidden bg-[#14110E] px-6 py-6 text-[#F3EEE7] sm:px-10 lg:relative lg:inset-auto lg:py-10" aria-hidden>
        {photo && <img src={photo} alt="" className="absolute inset-0 h-full w-full object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/15 to-black/30" />
        <p className="relative hidden text-[11px] font-medium uppercase tracking-[0.32em] text-[#F3EEE7]/80 lg:block">{biz.salon.name} · {biz.hair.name}</p>
        {/* The name shows once — above the form; the panel carries only an optional message. */}
        {login.message && <p className="relative hidden max-w-md text-[15px] text-[#F3EEE7]/85 lg:block">{login.message}</p>}
      </aside>
      <div className="relative z-10 flex items-center justify-center px-4 py-10 lg:px-5">
      <div className={cx('w-full max-w-[400px] lg:max-w-[380px] lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none lg:backdrop-blur-none', CARD[login.cardStyle ?? 'solid'].outer)}>
        <BrandMark a={{ ...DEFAULT_APPEARANCE, ...(cfg?.appearance ?? {}) }} size="login" />
        <p className="mt-2 text-center text-[15px] text-stone">Sign in to your workspace</p>
        <form onSubmit={submit} className={cx('mt-8 space-y-4 border p-6 lg:border-line lg:bg-white', CARD[login.cardStyle ?? 'solid'].form)}>
          {/* Sign-in codes are hidden for now (password only); turn this back on to offer them again. */}
          {SHOW_CODE_SIGN_IN && <Segmented className="w-full" value={mode} onChange={(v) => { setMode(v); setError(null); }} options={[{ value: 'password', label: 'Password' }, { value: 'code', label: 'Sign-in code' }]} />}
          <Field label="Email"><input className="field" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          {mode === 'password' ? (
            <Field label="Password"><input className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          ) : (
            <Field label="Sign-in code" hint="The code your salon owner gave you. It’s your CRM code — not a Square passcode.">
              <input className="field tracking-widest" type="password" name="crm-sign-in-code" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} required maxLength={64} />
            </Field>
          )}
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
