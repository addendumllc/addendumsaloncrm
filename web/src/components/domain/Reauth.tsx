import { useState, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { Button, Field, Modal } from '../ui';

/**
 * Sensitive actions (changing integration credentials) need the Owner/Admin to re-enter their password. When the
 * server answers "reauth_required", this asks for it once and then repeats the action. Usage:
 *   const reauth = useReauth();  …  catch (e) { if (reauth.handle(e, () => save())) return; … }  …  {reauth.modal}
 */
export function useReauth(): { handle: (e: unknown, retry: () => void) => boolean; modal: ReactNode } {
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const handle = (e: unknown, again: () => void) => {
    if (!(e instanceof ApiError) || e.code !== 'reauth_required') return false;
    setRetry(() => again);
    return true;
  };
  const modal = retry && <ConfirmPassword onClose={() => setRetry(null)} onConfirmed={() => { const r = retry; setRetry(null); r(); }} />;
  return { handle, modal };
}

function ConfirmPassword({ onClose, onConfirmed }: { onClose: () => void; onConfirmed: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/confirm-password', { password });
      onConfirmed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Confirm it’s you" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!password} onClick={confirm}>Continue</Button></>}>
      <p className="mb-3 flex items-start gap-2 text-[14px] text-ink-soft"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-stone" />Changing integration keys needs your password. You won’t be asked again for the next 10 minutes.</p>
      <Field label="Your password"><input className="field" type="password" autoComplete="current-password" value={password} autoFocus onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && password && confirm()} /></Field>
      {error && <p className="mt-2 text-sm text-rose" role="alert">{error}</p>}
    </Modal>
  );
}
