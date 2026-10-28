import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { LEAD_SOURCES, LEAD_STATUSES, type LeadDTO, type LeadStatus } from '@addendum/shared';
import { MessageSquare, Phone, Plus, Sparkles, UserCheck, Archive } from 'lucide-react';
import { api } from '../api/client';
import { useLead, useLeads, useRefreshAll, useStaff } from '../api/hooks';
import { dateTime, phone, relative } from '../lib/format';
import { buttonClass, Badge, Button, EmptyState, ErrorNote, Field, Modal, PageHeader, PageLoading, Segmented, cx, useToast } from '../components/ui';
import { useActions } from '../components/domain/ActionsProvider';
import { TaskCard } from '../components/domain/TaskCard';
import { Tc } from '../lib/titleCase';

const PIPELINE: LeadStatus[] = ['new', 'contacted', 'waiting', 'interested', 'consultation_scheduled', 'booked', 'follow_up_needed', 'won', 'lost'];
const label = (s: LeadStatus) => LEAD_STATUSES.find((x) => x.value === s)!.label;

/** New-client inquiries (leads). Shown inside Clients → New client inquiries (`embedded`). */
export function LeadsPage({ embedded = false }: { embedded?: boolean }) {
  const [params, setParams] = useSearchParams();
  // `layout`, not `view`: the page this sits in (Tasks) already uses ?view=.
  const view = params.get('layout') === 'list' || params.get('view') === 'list' ? 'list' : 'pipeline';
  const openId = params.get('open');
  const f = { status: params.get('status') ?? '', source: params.get('source') ?? '', staffId: params.get('staff') ?? '', q: params.get('q') ?? '' };
  const { data: leads, isLoading, error, refetch } = useLeads({ source: f.source || undefined, staffId: f.staffId || undefined, q: f.q || undefined, status: view === 'list' ? f.status || undefined : undefined });
  const { data: staff } = useStaff();
  const { newLead } = useActions();
  const refresh = useRefreshAll();
  const toast = useToast();
  const [dragging, setDragging] = useState<string | null>(null);

  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    setParams(p, { replace: true });
  };
  const move = async (id: string, status: LeadStatus) => {
    try {
      await api.patch(`/leads/${id}`, { status });
      toast(`Moved to ${label(status)}`);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div>
      {embedded
        ? null
        : <PageHeader title="New client inquiries" subtitle={leads ? `${leads.filter((l) => !['won', 'lost'].includes(l.status)).length} open` : undefined} actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={newLead}>New client</Button>} />}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Segmented value={view} onChange={(v) => set('layout', v === 'pipeline' ? '' : v)} options={[{ value: 'pipeline', label: 'Pipeline' }, { value: 'list', label: 'List' }]} />
        <input className="field h-9 w-full py-1 text-sm sm:w-56" placeholder="Search clients" value={f.q} onChange={(e) => set('q', e.target.value)} />
        <select className="field h-10 w-auto py-1 text-sm" value={f.source} onChange={(e) => set('source', e.target.value)} aria-label="Source"><option value="">All sources</option>{LEAD_SOURCES.map((s) => <option key={s}>{s}</option>)}</select>
        <select className="field h-10 w-auto py-1 text-sm" value={f.staffId} onChange={(e) => set('staff', e.target.value)} aria-label="Assigned to"><option value="">Anyone</option>{staff?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        {view === 'list' && <select className="field h-10 w-auto py-1 text-sm" value={f.status} onChange={(e) => set('status', e.target.value)} aria-label="Status"><option value="">All statuses</option>{LEAD_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>}
        {embedded && leads && <span className="ml-auto text-[13px] text-stone">{leads.filter((l) => !['won', 'lost'].includes(l.status)).length} open</span>}
      </div>

      {isLoading && <PageLoading />}
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {leads && leads.length === 0 && <div className="panel"><EmptyState icon={<Sparkles className="h-9 w-9" />} title="No new clients yet" action={<Button variant="primary" onClick={newLead}>Add a client</Button>}>New clients from texts are added automatically. Add Instagram or walk-in inquiries here.</EmptyState></div>}

      {leads && leads.length > 0 && view === 'pipeline' && (
        <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <div className="flex gap-3">
            {PIPELINE.map((s) => {
              const col = leads.filter((l) => l.status === s);
              return (
                <div
                  key={s}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => { if (dragging) move(dragging, s); setDragging(null); }}
                  className={cx('flex w-[260px] shrink-0 flex-col rounded-xl2 bg-mist/70 p-2', ['won', 'lost'].includes(s) && 'w-[220px] opacity-80')}
                >
                  <div className="flex items-center justify-between px-2 py-1.5">
                    <span className="text-sm font-medium text-ink">{label(s)}</span>
                    <span className="num text-xs text-stone">{col.length}</span>
                  </div>
                  <div className="min-h-[60px] space-y-2">
                    {col.map((l) => <LeadCard key={l.id} lead={l} onOpen={() => set('open', l.id)} onDragStart={() => setDragging(l.id)} onMove={(st) => move(l.id, st)} />)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {leads && leads.length > 0 && view === 'list' && (
        <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-white">
          {leads.map((l) => (
            <li key={l.id}>
              <button onClick={() => set('open', l.id)} className="grid w-full gap-1 px-4 py-3 text-left hover:bg-mist/50 sm:grid-cols-[1.5fr_1fr_1fr_1fr_1fr] sm:items-center sm:gap-4 sm:px-5">
                <span><span className="block font-medium">{l.name}</span><span className="text-[13px] text-stone">{phone(l.phone) || l.email}</span></span>
                <span className="text-sm text-ink-soft">{l.serviceInterest ?? '—'}</span>
                <span><Badge tone={l.status === 'new' ? 'plum' : l.status === 'lost' ? 'rose' : l.status === 'won' || l.status === 'booked' ? 'sage' : 'neutral'}>{label(l.status)}</Badge></span>
                <span className="text-sm text-stone">{l.source ?? '—'}</span>
                <span className="text-sm text-stone">Added {relative(l.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {openId && <LeadDrawer id={openId} onClose={() => set('open', '')} />}
    </div>
  );
}

function LeadCard({ lead, onOpen, onDragStart, onMove }: { lead: LeadDTO; onOpen: () => void; onDragStart: () => void; onMove: (s: LeadStatus) => void }) {
  return (
    <div draggable onDragStart={onDragStart} className="cursor-grab rounded-xl border border-line bg-white p-3 shadow-sm active:cursor-grabbing">
      <button onClick={onOpen} className="block w-full text-left">
        <span className="flex items-start justify-between gap-2">
          <span className="font-medium leading-snug text-ink">{lead.name}</span>
          {lead.unreadCount > 0 && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-plum" title="Unread text" />}
        </span>
        {lead.serviceInterest && <span className="mt-0.5 block text-[13px] text-ink-soft">{lead.serviceInterest}</span>}
        <span className="mt-1.5 block text-xs text-stone">{lead.source ?? 'Unknown source'} · {relative(lead.createdAt)}{lead.assignedStaffName ? ` · ${lead.assignedStaffName}` : ''}</span>
        {lead.nextFollowUpAt && <span className={cx('mt-1 block text-xs', new Date(lead.nextFollowUpAt) < new Date() ? 'text-rose' : 'text-stone')}>Follow up {relative(lead.nextFollowUpAt)}</span>}
      </button>
      {/* Touch-friendly alternative to drag-and-drop */}
      <select className="mt-2 w-full rounded-md border border-line bg-mist/50 px-2 py-1 text-xs text-ink-soft lg:hidden" value={lead.status} onChange={(e) => onMove(e.target.value as LeadStatus)} aria-label="Move to">
        {LEAD_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
    </div>
  );
}

function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading } = useLead(id);
  const { data: staff } = useStaff();
  const { compose, newFollowUp } = useActions();
  const refresh = useRefreshAll();
  const toast = useToast();
  const nav = useNavigate();
  const [note, setNote] = useState('');

  const patch = async (body: object, msg = 'Saved') => {
    try {
      await api.patch(`/leads/${id}`, body);
      toast(msg);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const lead = data?.lead;
  return (
    <Modal open side onClose={onClose} title={lead?.name ?? 'Client'}>
      {isLoading || !data || !lead ? <PageLoading /> : (
        <div className="space-y-6">
          <div>
            <p className="text-[15px] text-ink-soft">{[phone(lead.phone), lead.email].filter(Boolean).join('  ·  ')}</p>
            <p className="mt-1 text-sm text-stone">Added {relative(lead.createdAt)} from {lead.source ?? 'unknown source'}{lead.lastContactAt ? ` · last contacted ${relative(lead.lastContactAt)}` : ' · not contacted yet'}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {lead.phone && <Button size="sm" variant="primary" icon={<MessageSquare className="h-4 w-4" />} onClick={() => compose({ name: lead.name, phone: lead.phone, leadId: lead.id, conversationId: data.conversationId, autoDraft: data.messages.length === 0 })}>Text</Button>}
              {lead.phone && <a href={`tel:${lead.phone}`} className={buttonClass('secondary', 'sm')}><Phone className="h-4 w-4" />Call</a>}
              <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => newFollowUp({ contact: { kind: 'lead', id: lead.id, name: lead.name, phone: lead.phone } })}>Follow-up</Button>
              {lead.clientId ? (
                <Button size="sm" icon={<UserCheck className="h-4 w-4" />} onClick={() => nav(`/clients/${lead.clientId}`)}>View client</Button>
              ) : (
                <Button size="sm" icon={<UserCheck className="h-4 w-4" />} onClick={async () => { const r = await api.post<{ clientId: string }>(`/leads/${id}/convert`); toast('Converted to a client'); refresh(); nav(`/clients/${r.clientId}`); }}>Convert to client</Button>
              )}
              <Button size="sm" variant="ghost" icon={<Archive className="h-4 w-4" />} onClick={async () => { await api.post(`/leads/${id}/archive`); toast('Client archived'); refresh(); onClose(); }}>Archive</Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Status">
              <select className="field" value={lead.status} onChange={(e) => patch({ status: e.target.value }, `Moved to ${label(e.target.value as LeadStatus)}`)}>
                {LEAD_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="Assigned to">
              <select className="field" value={lead.assignedStaffId ?? ''} onChange={(e) => patch({ assignedStaffId: e.target.value || null }, 'Reassigned')}>
                <option value="">Unassigned</option>{staff?.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Interested in"><input className="field" defaultValue={lead.serviceInterest ?? ''} onBlur={(e) => e.target.value !== (lead.serviceInterest ?? '') && patch({ serviceInterest: e.target.value })} /></Field>
            <Field label="Source">
              <select className="field" value={lead.source ?? ''} onChange={(e) => patch({ source: e.target.value })}><option value="">Unknown</option>{LEAD_SOURCES.map((s) => <option key={s}>{s}</option>)}</select>
            </Field>
          </div>
          {lead.notes && <p className="rounded-xl bg-mist px-3 py-2 text-sm text-ink-soft">{lead.notes}</p>}

          <section>
            <h3 className="mb-2 font-display text-xl"><Tc>Follow-ups</Tc></h3>
            {data.tasks.filter((t) => t.status !== 'cancelled').length === 0 && <p className="text-sm text-stone">None yet.</p>}
            <div className="space-y-2">{data.tasks.filter((t) => t.status !== 'cancelled').map((t) => <TaskCard key={t.id} task={t} compact />)}</div>
          </section>

          <section>
            <h3 className="mb-2 font-display text-xl"><Tc>Conversation</Tc></h3>
            <div className="space-y-2 rounded-xl border border-line p-3">
              {data.messages.length === 0 && <p className="py-2 text-center text-sm text-stone">No texts yet.</p>}
              {data.messages.map((m) => (
                <div key={m.id} className={cx('max-w-[85%] rounded-2xl px-3 py-2 text-sm', m.direction === 'inbound' ? 'bg-mist' : 'ml-auto bg-plum text-white')}>
                  {m.body}<span className={cx('mt-0.5 block text-[10px]', m.direction === 'inbound' ? 'text-stone' : 'text-white/60')}>{dateTime(m.createdAt)}</span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 font-display text-xl"><Tc>Notes</Tc></h3>
            <div className="space-y-2">
              {data.notes.map((n) => <div key={n.id} className="rounded-xl border border-line px-3 py-2 text-sm">{n.body}<span className="mt-1 block text-[11px] text-stone">{n.author ?? 'Team'} · {relative(n.createdAt)}</span></div>)}
            </div>
            <div className="mt-2 flex gap-2">
              <input className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add an internal note" />
              <Button disabled={!note.trim()} onClick={async () => { await api.post(`/leads/${id}/notes`, { body: note }); setNote(''); refresh(); }}>Add</Button>
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
}
