import { useState } from 'react';
import { LEAD_SOURCES } from '@addendum/shared';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useRefreshAll, useStaff } from '../../api/hooks';
import { Button, Field, Modal, useToast } from '../ui';

export function NewLeadModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshAll();
  const nav = useNavigate();
  const { data: staff } = useStaff();
  const [f, setF] = useState({ name: '', phone: '', email: '', source: 'Instagram', serviceInterest: '', assignedStaffId: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.post<{ id: string }>('/leads', { ...f, assignedStaffId: f.assignedStaffId || null });
      toast('Client added · follow-up created');
      refresh();
      onClose();
      nav(`/leads?open=${r.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="New client" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={saving} disabled={!f.name.trim()}>Add client</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2"><input className="field" value={f.name} onChange={set('name')} autoComplete="off" /></Field>
        <Field label="Mobile"><input className="field" value={f.phone} onChange={set('phone')} inputMode="tel" /></Field>
        <Field label="Email"><input className="field" value={f.email} onChange={set('email')} type="email" /></Field>
        <Field label="Interested in"><input className="field" value={f.serviceInterest} onChange={set('serviceInterest')} placeholder="e.g. Extensions" /></Field>
        <Field label="Source">
          <select className="field" value={f.source} onChange={set('source')}>{LEAD_SOURCES.map((s) => <option key={s}>{s}</option>)}</select>
        </Field>
        <Field label="Assign to" className="sm:col-span-2">
          <select className="field" value={f.assignedStaffId} onChange={set('assignedStaffId')}>
            <option value="">Unassigned (front desk)</option>
            {staff?.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Notes" className="sm:col-span-2"><textarea className="field min-h-[80px]" value={f.notes} onChange={set('notes')} /></Field>
      </div>
    </Modal>
  );
}
