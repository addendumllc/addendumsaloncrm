import { useState } from 'react';
import { TASK_TYPE_LABELS, type TaskType } from '@addendum/shared';
import { api } from '../../api/client';
import { useIntegrations, useRefreshAll, useStaff } from '../../api/hooks';
import { toInputValue } from '../../lib/format';
import { Button, Field, Modal, Segmented, useToast } from '../ui';
import { ContactPicker, type PickedContact } from './ContactPicker';

export interface FollowUpPrefill { contact?: PickedContact; type?: TaskType; title?: string; internal?: boolean; push?: boolean }

const FOLLOW_UP_TYPES: TaskType[] = ['follow_up', 'call', 'text', 'rebook', 'appointment_reminder', 'consultation', 'no_show', 'cancellation', 'review_request'];

/** Create a follow-up (for a client or lead) or an internal salon task. */
export function FollowUpModal({ prefill, onClose }: { prefill: FollowUpPrefill; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshAll();
  const { data: staff } = useStaff();
  const { data: integ } = useIntegrations();
  const [kind, setKind] = useState<'follow_up' | 'task'>(prefill.internal ? 'task' : 'follow_up');
  const [contact, setContact] = useState<PickedContact | null>(prefill.contact ?? null);
  const [type, setType] = useState<TaskType>(prefill.type ?? 'follow_up');
  const [title, setTitle] = useState(prefill.title ?? '');
  const [due, setDue] = useState(toInputValue(new Date(Date.now() + 2 * 3600_000)));
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [assigned, setAssigned] = useState('');
  const [notes, setNotes] = useState('');
  const [push, setPush] = useState(!!prefill.push);
  const [saving, setSaving] = useState(false);

  const autoTitle = contact ? `${TASK_TYPE_LABELS[type]}: ${contact.name}` : '';
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.post<{ id: string; highlevel: { status: string; message: string } | null }>('/tasks', {
        kind, type: kind === 'task' ? 'internal' : type, title: title.trim() || autoTitle, notes: notes || null, priority,
        dueAt: new Date(due).toISOString(), assignedStaffId: assigned || null,
        clientId: contact?.kind === 'client' ? contact.id : null, leadId: contact?.kind === 'lead' ? contact.id : null,
        pushToHighLevel: kind === 'follow_up' && push,
      });
      if (r.highlevel?.status === 'synced') toast('Follow-up created · ✓ Added to HighLevel');
      else if (r.highlevel) toast(`Follow-up saved. ${r.highlevel.message}`, 'info');
      else toast(kind === 'task' ? 'Task created' : 'Follow-up created');
      refresh();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={kind === 'task' ? 'New task' : 'New follow-up'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={saving} disabled={kind === 'follow_up' ? !contact : !title.trim()}>{kind === 'task' ? 'Create task' : 'Create follow-up'}</Button></>}
    >
      <Segmented className="mb-4" value={kind} onChange={setKind} options={[{ value: 'follow_up', label: 'Client or lead follow-up' }, { value: 'task', label: 'Internal task' }]} />
      <div className="grid gap-4 sm:grid-cols-2">
        {kind === 'follow_up' && (
          <>
            <div className="sm:col-span-2"><span className="label">Who</span><ContactPicker value={contact} onChange={setContact} /></div>
            <Field label="Type">
              <select className="field" value={type} onChange={(e) => setType(e.target.value as TaskType)}>
                {FOLLOW_UP_TYPES.map((t) => <option key={t} value={t}>{TASK_TYPE_LABELS[t]}</option>)}
              </select>
            </Field>
          </>
        )}
        <Field label="Title" className={kind === 'task' ? 'sm:col-span-2' : ''}><input className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={autoTitle || 'What needs doing?'} /></Field>
        <Field label="Due"><input className="field" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label="Priority">
          <select className="field" value={priority} onChange={(e) => setPriority(e.target.value as any)}>
            <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
          </select>
        </Field>
        <Field label="Assign to" className="sm:col-span-2">
          <select className="field" value={assigned} onChange={(e) => setAssigned(e.target.value)}>
            <option value="">Unassigned (front desk)</option>
            {staff?.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Notes" className="sm:col-span-2"><textarea className="field min-h-[80px]" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Context for whoever picks this up" /></Field>
        {kind === 'follow_up' && integ?.highlevel.connected && (
          <label className="flex items-center gap-2 text-sm text-ink-soft sm:col-span-2">
            <input type="checkbox" className="h-4 w-4 accent-plum" checked={push} onChange={(e) => setPush(e.target.checked)} /> Also add to HighLevel
          </label>
        )}
      </div>
    </Modal>
  );
}
