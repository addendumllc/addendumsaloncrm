import { useState } from 'react';
import { TASK_BUSINESS_LABELS, TASK_TYPE_LABELS, type TaskBusiness, type TaskType } from '@addendum/shared';
import { api } from '../../api/client';
import { useIntegrations, useMe, useRefreshAll, useStaff } from '../../api/hooks';
import { dateTime, toInputValue } from '../../lib/format';
import { openSmsLink, smsLink } from '../../lib/sms';
import { Button, Field, Modal, Segmented, useToast } from '../ui';
import { ContactPicker, type PickedContact } from './ContactPicker';

export interface FollowUpPrefill { contact?: PickedContact; type?: TaskType; title?: string; internal?: boolean; push?: boolean; business?: TaskBusiness }

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
  // Follow-ups default to two hours from now; internal tasks have no due date unless one is chosen.
  const [due, setDue] = useState(prefill.internal ? '' : toInputValue(new Date(Date.now() + 2 * 3600_000)));
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [assigned, setAssigned] = useState('');
  const [notes, setNotes] = useState('');
  const [push, setPush] = useState(!!prefill.push);
  // Internal tasks: for Addendum Salon or Addendum Hair.
  const [business, setBusiness] = useState<TaskBusiness>(prefill.business ?? 'salon');
  const { data: me } = useMe();
  // Texting the person a task is sent to: from this device's Messages (the CRM never sends texts itself).
  const assignee = staff?.find((s) => s.id === assigned);
  const canText = kind === 'task' && !!assignee?.mobilePhone && assignee.id !== me?.id;
  const [textThem, setTextThem] = useState(true);
  const [saving, setSaving] = useState(false);

  const autoTitle = contact ? `${TASK_TYPE_LABELS[type]}: ${contact.name}` : '';
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.post<{ id: string; highlevel: { status: string; message: string } | null }>('/tasks', {
        kind, business: kind === 'task' ? business : 'salon', type: kind === 'task' ? 'internal' : type, title: title.trim() || autoTitle, notes: notes || null, priority,
        dueAt: due ? new Date(due).toISOString() : null, assignedStaffId: assigned || null,
        clientId: contact?.kind === 'client' ? contact.id : null, leadId: contact?.kind === 'lead' ? contact.id : null,
        pushToHighLevel: kind === 'follow_up' && push,
      });
      if (r.highlevel?.status === 'synced') toast('Follow-up created · ✓ Added to HighLevel');
      else if (r.highlevel) toast(`Follow-up saved. ${r.highlevel.message}`, 'info');
      else toast(kind === 'task' ? `Task created${assignee && assignee.id !== me?.id ? ` — ${assignee.name.split(' ')[0]} will see it in their notifications` : ''}` : 'Follow-up created');
      if (canText && textThem) {
        const body = [`New task from ${me?.name?.split(' ')[0] ?? 'the salon'}: ${title.trim()}`, `Due ${dateTime(new Date(due).toISOString())}`, notes.trim()].filter(Boolean).join('\n');
        const opened = await openSmsLink(smsLink(assignee!.mobilePhone!, body));
        if (!opened) toast(`Messages didn’t open on this device. Text ${assignee!.name.split(' ')[0]} at ${assignee!.mobilePhone}.`, 'info');
      }
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
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={saving} disabled={kind === 'follow_up' ? !contact || !due : !title.trim()}>{kind === 'task' ? 'Create task' : 'Create follow-up'}</Button></>}
    >
      <Segmented className="mb-4" value={kind} onChange={(k) => { setKind(k); if (k === 'follow_up' && !due) setDue(toInputValue(new Date(Date.now() + 2 * 3600_000))); }} options={[{ value: 'follow_up', label: 'Client or lead follow-up' }, { value: 'task', label: 'Internal task' }]} />
      {kind === 'task' && (
        <div className="mb-4">
          <span className="label">For</span>
          <Segmented value={business} onChange={setBusiness} options={(['salon', 'hair'] as const).map((b) => ({ value: b, label: TASK_BUSINESS_LABELS[b] }))} />
        </div>
      )}
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
        <Field label={kind === 'task' ? 'Due (optional)' : 'Due'} hint={kind === 'task' && !due ? 'No due date — just the priority.' : undefined}>
          <input className="field" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
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
        {kind === 'task' && assignee && assignee.id !== me?.id && (
          <div className="sm:col-span-2 text-[13px] text-ink-soft">
            {assignee.mobilePhone ? (
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4 accent-plum" checked={textThem} onChange={(e) => setTextThem(e.target.checked)} />
                Also text {assignee.name.split(' ')[0]} ({assignee.mobilePhone}) — opens Messages with the task filled in
              </label>
            ) : <p className="text-stone">{assignee.name.split(' ')[0]} gets it in their CRM notifications. Add their mobile in Users &amp; Permissions to text them too.</p>}
          </div>
        )}
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
