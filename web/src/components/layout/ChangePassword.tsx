import { useState } from 'react';
import { api } from '../../api/client';
import { Button, Field, Modal, useToast } from '../ui';

/** Change your own password. Your current one is required; other devices are signed out. */
export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ current: '', password: '', again: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = f.again !== '' && f.again !== f.password;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/change-password', { current: f.current, password: f.password });
      toast('Password changed. Other devices were signed out.');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Change password" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!f.current || !f.password || mismatch || !f.again} onClick={save}>Change password</Button></>}>
      {/* Field names and autocomplete let the browser's password manager (iCloud Keychain, Google…) update the saved password. */}
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Field label="Current password"><input className="field" type="password" name="current-password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
        <Field label="New password" hint="At least 10 characters, with letters and a number or symbol."><input className="field" type="password" name="new-password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="New password again"><input className="field" type="password" name="new-password-again" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
        {mismatch && <p className="text-sm text-rose">The new passwords don’t match.</p>}
        {error && <p className="text-sm text-rose" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
