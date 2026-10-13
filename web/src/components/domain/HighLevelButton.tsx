import { useState } from 'react';
import type { TaskDTO } from '@addendum/shared';
import { Check, CloudUpload, RefreshCw, UserPlus } from 'lucide-react';
import { api } from '../../api/client';
import { useIntegrations, useRefreshAll } from '../../api/hooks';
import { Button, Modal, useToast } from '../ui';

/**
 * "Push to HighLevel" with the full flow: match contact → (ask to create if missing) → create task.
 * Failed pushes stay saved here and show Retry.
 */
export function HighLevelButton({ task, size = 'sm' }: { task: TaskDTO; size?: 'sm' | 'md' }) {
  const toast = useToast();
  const refresh = useRefreshAll();
  const { data: integ } = useIntegrations();
  const [busy, setBusy] = useState(false);
  const [askCreate, setAskCreate] = useState<string | null>(null);
  if (!integ?.highlevel.connected || (!task.clientId && !task.leadId)) return null;

  const push = async (createContact = false) => {
    setBusy(true);
    try {
      const r = await api.post<{ result: { status: string; message: string } }>(`/tasks/${task.id}/highlevel`, { createContact });
      if (r.result.status === 'synced') toast('✓ Added to HighLevel');
      else if (r.result.status === 'needs_contact') setAskCreate(r.result.message);
      else toast(r.result.message, 'error');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const hl = task.highlevel;
  let button;
  if (hl.status === 'synced') {
    button = <Button size={size} variant="ghost" onClick={() => push()} loading={busy} icon={<Check className="h-4 w-4 text-sage" />} title="Already in HighLevel — click to update it">In HighLevel</Button>;
  } else if (hl.status === 'failed') {
    button = <Button size={size} variant="secondary" onClick={() => push()} loading={busy} icon={<RefreshCw className="h-4 w-4" />}>Retry HighLevel</Button>;
  } else if (hl.status === 'needs_contact') {
    button = <Button size={size} variant="secondary" onClick={() => setAskCreate(hl.error ?? 'No matching HighLevel contact.')} loading={busy} icon={<UserPlus className="h-4 w-4" />}>Create HighLevel contact</Button>;
  } else if (hl.status === 'pending') {
    button = <Button size={size} variant="ghost" loading disabled>Sending to HighLevel</Button>;
  } else {
    button = <Button size={size} variant="secondary" onClick={() => push()} loading={busy} icon={<CloudUpload className="h-4 w-4" />}>Push to HighLevel</Button>;
  }
  return (
    <>
      {button}
      {askCreate && (
        <Modal
          open
          onClose={() => setAskCreate(null)}
          title="Create contact in HighLevel?"
          footer={<><Button variant="ghost" onClick={() => setAskCreate(null)}>Not now</Button><Button variant="primary" loading={busy} onClick={async () => { setAskCreate(null); await push(true); }}>Create contact and task</Button></>}
        >
          <p className="text-[15px] text-ink-soft">{askCreate}</p>
          <p className="mt-2 text-sm text-stone">We checked HighLevel for this phone number and email first, so this won't create a duplicate.</p>
        </Modal>
      )}
    </>
  );
}

export function HighLevelStatus({ task }: { task: TaskDTO }) {
  const s = task.highlevel.status;
  if (s === 'not_pushed') return null;
  const map: Record<string, [string, string]> = {
    synced: ['text-sage', '✓ Added to HighLevel'],
    failed: ['text-rose', task.highlevel.error ?? 'HighLevel task could not be created. It will be retried.'],
    needs_contact: ['text-amber', 'Needs a HighLevel contact'],
    pending: ['text-stone', 'Sending to HighLevel…'],
  };
  const [cls, text] = map[s];
  return <p className={`text-xs ${cls}`}>{text}</p>;
}
