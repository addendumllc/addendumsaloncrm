import { useState } from 'react';
import { DEFAULT_TAGS } from '@addendum/shared';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useRefreshAll, useStaff, useTags } from '../../api/hooks';
import { Button, Field, Modal, useToast } from '../ui';
import { TagPicker } from './TagPicker';

export interface ClientFormValues {
  firstName: string; lastName: string; phone: string; email: string; birthday: string; preferredStaffId: string; leadSource: string; tags: string[];
}

/** Add or edit a client. Clients who book in Square are created automatically by the sync. */
export function ClientFormModal({ onClose, clientId, initial }: { onClose: () => void; clientId?: string; initial?: Partial<ClientFormValues> }) {
  const toast = useToast();
  const refresh = useRefreshAll();
  const nav = useNavigate();
  const { data: staff } = useStaff();
  const { data: tags } = useTags();
  const [f, setF] = useState<ClientFormValues>({ firstName: '', lastName: '', phone: '', email: '', birthday: '', preferredStaffId: '', leadSource: '', tags: [], ...initial });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof ClientFormValues) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    setSaving(true);
    try {
      const payload = { ...f, preferredStaffId: f.preferredStaffId || null, birthday: f.birthday || null };
      if (clientId) {
        await api.patch(`/clients/${clientId}`, payload);
        toast('Client updated');
      } else {
        const r = await api.post<{ id: string }>('/clients', payload);
        toast('Client added');
        nav(`/clients/${r.id}`);
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
    <Modal open onClose={onClose} title={clientId ? 'Edit client' : 'Add client'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={saving} disabled={!f.firstName.trim()}>{clientId ? 'Save changes' : 'Add client'}</Button></>}>
      {!clientId && <p className="mb-4 text-sm text-stone">Clients who book through Square are added automatically. Use this for walk-ins or people who haven't booked yet.</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name"><input className="field" value={f.firstName} onChange={set('firstName')} /></Field>
        <Field label="Last name"><input className="field" value={f.lastName} onChange={set('lastName')} /></Field>
        <Field label="Mobile"><input className="field" value={f.phone} onChange={set('phone')} inputMode="tel" /></Field>
        <Field label="Email"><input className="field" value={f.email} onChange={set('email')} type="email" /></Field>
        <Field label="Birthday" hint="MM-DD or YYYY-MM-DD"><input className="field" value={f.birthday} onChange={set('birthday')} placeholder="03-14" /></Field>
        <Field label="Preferred stylist">
          <select className="field" value={f.preferredStaffId} onChange={set('preferredStaffId')}>
            <option value="">No preference</option>
            {staff?.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="How they found us" className="sm:col-span-2"><input className="field" value={f.leadSource} onChange={set('leadSource')} placeholder="Instagram, referral…" /></Field>
        <div className="sm:col-span-2">
          <span className="label">Tags</span>
          <TagPicker value={f.tags} onChange={(tags) => setF({ ...f, tags })} options={tags?.map((t) => t.name) ?? DEFAULT_TAGS} />
        </div>
      </div>
    </Modal>
  );
}
