import { useState } from 'react';
import { getAccentHex } from '../lib/theme';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, CalendarPlus, CloudUpload, Download, MessageSquare, MoreHorizontal, Pencil, Phone, Pin, Plus, StickyNote, Trash2, Archive,
} from 'lucide-react';
import type { AppointmentDTO } from '@addendum/shared';
import { api } from '../api/client';
import { useClient, useIntegrations, useMe, useRefreshAll, useSettings, useCanDo, useStaff } from '../api/hooks';
import { dateLong, dateShort, dateTime, phone, relative, time } from '../lib/format';
import { buttonClass, Avatar, Badge, Button, EmptyState, ErrorNote, Field, Menu, Modal, PageLoading, SectionTitle, cx, useToast } from '../components/ui';
import { useActions } from '../components/domain/ActionsProvider';
import { TaskCard } from '../components/domain/TaskCard';
import { ClientFormModal } from '../components/domain/ClientFormModal';
import { APPT_STYLE } from '../components/domain/appointmentStyles';
import { RebookingSchedulePanel } from '../components/domain/Rebooking';
import { openSquareBooking } from '../lib/square';
import { Tc } from '../lib/titleCase';

export function ClientProfilePage() {
  const { id } = useParams();
  const { data, isLoading, error, refetch } = useClient(id);
  const { data: me } = useMe();
  const { data: settings } = useSettings();
  const { data: integ } = useIntegrations();
  const { compose, newFollowUp } = useActions();
  const refresh = useRefreshAll();
  const toast = useToast();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canDo = useCanDo();

  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;
  const { client: c, rebooking } = data;
  // What this person may see (the server already left out anything they can't).
  const access = data.access ?? { history: true, contact: true, messages: true, tasks: true };
  const isOwner = canDo('clients:delete');
  const canManage = canDo('clients:archive');
  const next = data.appointments.filter((a) => ['confirmed', 'needs_attention'].includes(a.displayStatus)).sort((a, b) => +new Date(a.startAt) - +new Date(b.startAt))[0];
  const last = data.appointments.find((a) => a.displayStatus === 'completed');
  const openTasks = data.tasks.filter((t) => t.status === 'due' || t.status === 'snoozed');
  const doneTasks = data.tasks.filter((t) => t.status === 'completed' || t.status === 'cancelled');
  const contact = { kind: 'client' as const, id: c.id, name: c.name, phone: c.phone };

  const post = async (url: string, msg: string, after?: () => void) => {
    try {
      await api.post(url);
      toast(msg);
      refresh();
      after?.();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div>
      <Link to="/clients" className="mb-4 inline-flex items-center gap-1 text-sm text-stone hover:text-ink"><ArrowLeft className="h-4 w-4" />Clients</Link>

      {/* Header */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <Avatar name={c.name} size="lg" color={getAccentHex()} />
          <div>
            <h1 className="h-display text-[34px] leading-[1.05] sm:text-[40px]">{c.name}</h1>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[15px] text-ink-soft">
              {c.phone && <a href={`tel:${c.phone}`} className="hover:text-plum">{phone(c.phone)}</a>}
              {c.email && <a href={`mailto:${c.email}`} className="hover:text-plum">{c.email}</a>}
              {c.archived && <Badge tone="rose">Archived</Badge>}
              {c.smsOptedOut && <Badge tone="amber">Opted out of texts</Badge>}
            </p>
            {c.tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{c.tags.map((t) => <Badge key={t} tone={t === 'VIP' ? 'plum' : t === 'At Risk' ? 'rose' : 'neutral'}>{t}</Badge>)}</div>}
          </div>
        </div>
        <Menu
          trigger={(open) => <Button variant="ghost" onClick={open} icon={<MoreHorizontal className="h-4 w-4" />} aria-label="More">More</Button>}
          items={[
            { label: 'Edit client', icon: <Pencil className="h-4 w-4" />, onClick: () => setEditing(true) },
            { label: 'Export client data', icon: <Download className="h-4 w-4" />, hidden: !canManage, onClick: () => window.open(`/api/clients/${c.id}/export`, '_blank') },
            { label: c.archived ? 'Restore client' : 'Archive client', icon: <Archive className="h-4 w-4" />, hidden: !canManage, onClick: () => post(`/clients/${c.id}/${c.archived ? 'restore' : 'archive'}`, c.archived ? 'Client restored' : 'Client archived') },
            { label: 'Delete permanently', icon: <Trash2 className="h-4 w-4" />, danger: true, hidden: !isOwner, onClick: () => setConfirmDelete(true) },
          ]}
        />
      </div>

      {/* Quick actions */}
      <div className="mt-5 flex flex-wrap gap-2">
        <Button variant="primary" icon={<MessageSquare className="h-4 w-4" />} disabled={!c.phone || c.smsOptedOut} onClick={() => compose({ name: c.name, phone: c.phone, clientId: c.id, conversationId: data.conversationId })}>Text</Button>
        {c.phone && <a href={`tel:${c.phone}`} className={buttonClass('secondary', 'md')}><Phone className="h-4 w-4" />Call</a>}
        <Button icon={<CalendarPlus className="h-4 w-4" />} onClick={() => openSquareBooking(integ?.square.environment, c.name, toast)}>Book in Square</Button>
        <Button icon={<StickyNote className="h-4 w-4" />} onClick={() => setNoteOpen(true)}>Add note</Button>
        <Button icon={<Plus className="h-4 w-4" />} onClick={() => newFollowUp({ contact })}>Create follow-up</Button>
        {integ?.highlevel.connected && <Button icon={<CloudUpload className="h-4 w-4" />} onClick={() => newFollowUp({ contact, push: true })}>Push to HighLevel</Button>}
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-8">
          {/* Next / last */}
          <div className="grid gap-px overflow-hidden rounded-xl2 border border-line bg-line sm:grid-cols-2">
            <AppointmentSummary label="Next appointment" a={next} empty="Nothing booked" />
            <AppointmentSummary label="Last appointment" a={last} empty="No completed visits yet" />
          </div>

          {/* Rebooking: per service, with this client's own schedule where set */}
          <section>
            <SectionTitle>Rebooking schedule</SectionTitle>
            {access.history && rebooking.enough && <p className="-mt-1 mb-3 text-[13px] text-stone">Overall rhythm: {rebooking.message}</p>}
            <RebookingSchedulePanel clientId={c.id} firstName={c.firstName || 'Client'} />
          </section>

          {access.tasks && <section>
            <SectionTitle action={canDo('tasks:write') && <Button size="sm" variant="quiet" icon={<Plus className="h-4 w-4" />} onClick={() => newFollowUp({ contact })}>Follow-up</Button>}>Follow-ups</SectionTitle>
            {openTasks.length === 0 && <p className="rounded-xl2 border border-dashed border-line-strong px-4 py-5 text-center text-sm text-stone">No open follow-ups for {c.firstName}.</p>}
            <div className="space-y-3">{openTasks.map((t) => <TaskCard key={t.id} task={t} />)}</div>
            {doneTasks.length > 0 && (
              <div className="mt-3">
                <button className="text-sm text-plum hover:underline" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide' : 'Show'} {doneTasks.length} completed</button>
                {showDone && <div className="mt-3 space-y-3">{doneTasks.map((t) => <TaskCard key={t.id} task={t} compact />)}</div>}
              </div>
            )}
          </section>}

          {access.history && <section>
            <SectionTitle>Appointment history</SectionTitle>
            <p className="-mt-1 mb-3 text-[13px] text-stone">From Square. Changes to bookings are made in Square and sync here automatically.</p>
            {data.appointments.length === 0 ? (
              <div className="panel"><EmptyState title="No Square appointments yet" /></div>
            ) : (
              <ol className="relative space-y-0 border-l border-line pl-5">
                {data.appointments.map((a) => <HistoryRow key={a.id} a={a} demo={!!integ?.demoMode} />)}
              </ol>
            )}
          </section>}
        </div>

        <aside className="space-y-8">
          {access.messages && <section>
            <SectionTitle action={data.conversationId && <Link to={`/messages/${data.conversationId}`} className="text-sm text-plum hover:underline">Open</Link>}>Messages</SectionTitle>
            <div className="panel max-h-[360px] space-y-2 overflow-y-auto p-4">
              {data.messages.length === 0 && <p className="py-4 text-center text-sm text-stone">No texts yet.</p>}
              {data.messages.slice(-8).map((m) => (
                <div key={m.id} className={cx('max-w-[85%] rounded-2xl px-3 py-2 text-sm', m.direction === 'inbound' ? 'bg-mist text-ink' : 'ml-auto bg-plum text-white')}>
                  {m.body}
                  <span className={cx('mt-0.5 block text-[10px]', m.direction === 'inbound' ? 'text-stone' : 'text-white/60')}>{dateTime(m.createdAt)}</span>
                </div>
              ))}
            </div>
          </section>}

          {access.history && <section>
            <SectionTitle action={(canDo('clients:notes') || canDo('clients:write')) && <Button size="sm" variant="quiet" icon={<Plus className="h-4 w-4" />} onClick={() => setNoteOpen(true)}>Note</Button>}>Notes</SectionTitle>
            <p className="-mt-1 mb-2 text-[13px] text-stone">Internal only — never sent to the client.</p>
            <div className="space-y-2">
              {data.notes.length === 0 && <p className="text-sm text-stone-light">No notes yet.</p>}
              {data.notes.map((n) => <NoteItem key={n.id} n={n} editable={canDo('clients:notes') || canDo('clients:write')} onChanged={refresh} />)}
            </div>
          </section>}

          <ClientDetails
            c={c} services={data.services} assignments={data.staffAssignments} showHighLevel={!!integ?.highlevel.connected}
            canEditAll={canDo('clients:write')} canEditPrefs={canDo('clients:write') || canDo('clients:notes')} onSaved={refresh}
          />
        </aside>
      </div>

      {editing && (
        <ClientFormModal
          clientId={c.id}
          onClose={() => setEditing(false)}
          initial={{ firstName: c.firstName, lastName: c.lastName, phone: c.phone ?? '', email: c.email ?? '', birthday: c.birthday ?? '', preferredStaffId: c.preferredStaffId ?? '', leadSource: c.leadSource ?? '', tags: c.tags }}
        />
      )}
      {noteOpen && <NoteModal clientId={c.id} onClose={() => setNoteOpen(false)} />}
      {confirmDelete && (
        <Modal open onClose={() => setConfirmDelete(false)} title="Delete this client permanently?" footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep client</Button><Button variant="danger" onClick={() => api.del(`/clients/${c.id}`).then(() => { toast('Client deleted'); refresh(); nav('/clients'); }).catch((e) => toast(e.message, 'error'))}>Delete permanently</Button></>}>
          <p className="text-[15px] text-ink-soft">This removes {c.name}'s notes, texts and follow-ups from this app. It can't be undone. Their record in Square is not changed — delete it there too if required. Consider archiving instead.</p>
        </Modal>
      )}
    </div>
  );
}

function AppointmentSummary({ label, a, empty }: { label: string; a?: AppointmentDTO; empty: string }) {
  return (
    <div className="bg-white px-5 py-4">
      <p className="text-[13px] text-stone">{label}</p>
      {a ? (
        <>
          <p className="mt-1 font-display text-[26px] leading-tight">{dateLong(a.startAt)} — {a.serviceNames[0] ?? 'Appointment'}</p>
          <p className="mt-0.5 text-sm text-stone">{time(a.startAt)}{a.staffName ? ` with ${a.staffName}` : ''} · {relative(a.startAt)}</p>
        </>
      ) : <p className="mt-1 font-display text-[22px] text-stone-light">{empty}</p>}
    </div>
  );
}

function HistoryRow({ a, demo }: { a: AppointmentDTO; demo: boolean }) {
  const st = APPT_STYLE[a.displayStatus];
  const refresh = useRefreshAll();
  const toast = useToast();
  const sim = async (action: string) => {
    try {
      await api.post(`/demo/square/${a.id}/${action}`);
      toast('Simulated change received from Square');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const upcoming = ['confirmed', 'needs_attention'].includes(a.displayStatus);
  return (
    <li className="relative pb-5">
      <span className={cx('absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-paper', st.dot)} />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[15px] font-medium text-ink">{dateShort(a.startAt)} · {a.serviceNames.join(', ')}</span>
        <span className={cx('rounded-full px-2 py-0.5 text-xs', st.chip)}>{st.label}</span>
        <Badge>Square appointment</Badge>
      </div>
      <p className="mt-0.5 text-sm text-stone">
        {time(a.startAt)}–{time(a.endAt)}{a.staffName ? ` · ${a.staffName}` : ''}{a.locationName ? ` · ${a.locationName}` : ''}
        {a.rescheduledFrom && <span className="text-plum"> · moved from {dateShort(a.rescheduledFrom)} {time(a.rescheduledFrom)}</span>}
        {a.clientConfirmedAt && <span className="text-sage"> · confirmed by client</span>}
      </p>
      {(a.customerNote || a.sellerNote) && <p className="mt-1 text-sm text-ink-soft">{a.customerNote || a.sellerNote}</p>}
      <p className="mt-0.5 text-[11px] text-stone-light">Square ID {a.squareBookingId}</p>
      {demo && upcoming && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-stone">Demo — simulate in Square:</span>
          <button className="rounded border border-line px-2 py-0.5 hover:bg-mist" onClick={() => sim('cancel')}>Client cancels</button>
          <button className="rounded border border-line px-2 py-0.5 hover:bg-mist" onClick={() => sim('reschedule')}>Move +2 days</button>
          {a.displayStatus === 'needs_attention' && <button className="rounded border border-line px-2 py-0.5 hover:bg-mist" onClick={() => sim('accept')}>Accept</button>}
        </div>
      )}
      {demo && a.displayStatus === 'completed' && Date.now() - new Date(a.startAt).getTime() < 3 * 86400_000 && (
        <div className="mt-2 text-xs"><button className="rounded border border-line px-2 py-0.5 hover:bg-mist" onClick={() => sim('no-show')}>Demo: mark no-show in Square</button></div>
      )}
    </li>
  );
}

function Detail({ label, value, mono, multiline, alert }: { label: string; value: string | null; mono?: boolean; multiline?: boolean; alert?: boolean }) {
  return (
    <div className={cx('flex justify-between gap-4 px-4 py-2.5', alert && 'bg-rose-tint/60')}>
      <dt className={cx('shrink-0', alert ? 'font-medium text-rose' : 'text-stone')}>{label}</dt>
      <dd className={cx('min-w-0 text-right text-ink', mono && 'break-all font-mono text-xs', multiline && 'whitespace-pre-line', !value && 'text-stone-light')}>{value ?? '—'}</dd>
    </div>
  );
}

function NoteModal({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [saving, setSaving] = useState(false);
  const refresh = useRefreshAll();
  const toast = useToast();
  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/clients/${clientId}/notes`, { body, pinned });
      toast('Note added');
      refresh();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Add note" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={saving} disabled={!body.trim()}>Save note</Button></>}>
      <textarea className="field min-h-[140px]" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Formula, preferences, anything the team should know" />
      <label className="mt-3 flex items-center gap-2 text-sm text-ink-soft"><input type="checkbox" className="accent-plum" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />Pin to top</label>
      <p className="mt-2 text-xs text-stone">Notes are internal and never sent to the client.</p>
    </Modal>
  );
}

/** One internal note: pin, edit the text in place, or delete. Buttons stay visible on touch screens. */
function NoteItem({ n, editable, onChanged }: { n: { id: string; body: string; pinned: boolean; author: string | null; createdAt: string }; editable: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(n.body);
  const save = async () => {
    try {
      await api.patch(`/notes/${n.id}`, { body: body.trim() });
      setEditing(false);
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className={cx('group rounded-xl border px-3 py-2.5', n.pinned ? 'border-plum/20 bg-plum-tint/50' : 'border-line bg-white')}>
      {editing ? (
        <>
          <textarea className="field min-h-[80px]" value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} autoFocus />
          <div className="mt-2 flex gap-2"><Button size="sm" variant="primary" disabled={!body.trim()} onClick={save}>Save</Button><Button size="sm" variant="ghost" onClick={() => { setBody(n.body); setEditing(false); }}>Cancel</Button></div>
        </>
      ) : <p className="whitespace-pre-line text-sm text-ink">{n.body}</p>}
      <div className="mt-1 flex items-center justify-between text-[11px] text-stone">
        <span>{n.author ?? 'Team'} · {relative(n.createdAt)}</span>
        {editable && !editing && (
          <span className="flex gap-3 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
            <button onClick={() => setEditing(true)} aria-label="Edit note"><Pencil className="h-3.5 w-3.5" /></button>
            <button onClick={() => api.patch(`/notes/${n.id}`, { pinned: !n.pinned }).then(onChanged)} aria-label={n.pinned ? 'Unpin' : 'Pin'}><Pin className="h-3.5 w-3.5" /></button>
            <button onClick={() => api.del(`/notes/${n.id}`).then(onChanged)} aria-label="Delete note"><Trash2 className="h-3.5 w-3.5" /></button>
          </span>
        )}
      </div>
    </div>
  );
}

type ClientInfo = NonNullable<ReturnType<typeof useClient>['data']>['client'];

/**
 * Details: preferred stylist, who else they see, birthday, how they found us, and their preferences and allergies —
 * edited right here. Preferences and allergies can be kept up to date by anyone who adds notes.
 */
function ClientDetails({ c, services, assignments, showHighLevel, canEditAll, canEditPrefs, onSaved }: {
  c: ClientInfo; services: string[]; assignments: { id: string; name: string }[]; showHighLevel: boolean; canEditAll: boolean; canEditPrefs: boolean; onSaved: () => void;
}) {
  const toast = useToast();
  // The team list is only needed (and only allowed) for people who can change the stylists.
  const { data: staff } = useStaff(canEditAll);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const start = () => ({
    // "auto": kept up to date from their visits (their regular stylist for a service, else whoever they saw last).
    preferredStaffId: c.preferredStaffAuto ? 'auto' : c.preferredStaffId ?? '', staffIds: assignments.map((a) => a.id), birthday: c.birthday ?? '', leadSource: c.leadSource ?? '',
    preferences: c.preferences ?? '', allergies: c.allergies ?? '',
  });
  const [f, setF] = useState(start);
  const save = async () => {
    setSaving(true);
    try {
      if (canEditAll) {
        await api.patch(`/clients/${c.id}`, { ...(f.preferredStaffId === 'auto' ? { preferredStaffAuto: true } : { preferredStaffId: f.preferredStaffId || null }), staffIds: f.staffIds, birthday: f.birthday.trim() || null, leadSource: f.leadSource.trim() || null });
      }
      await api.patch(`/clients/${c.id}/preferences`, { preferences: f.preferences.trim() || null, allergies: f.allergies.trim() || null });
      toast('Details saved');
      setEditing(false);
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const active = (staff ?? []).filter((s) => s.active);
  return (
    <section>
      <SectionTitle action={canEditPrefs && !editing && <Button size="sm" variant="quiet" icon={<Pencil className="h-4 w-4" />} onClick={() => { setF(start()); setEditing(true); }}>Edit</Button>}>Details</SectionTitle>
      {editing ? (
        <div className="panel space-y-3 p-4 text-sm">
          {canEditAll && (
            <>
              <Field label="Preferred stylist" hint="Automatic: whoever they’ve seen 3+ times for the same service, else their last stylist (blank if that stylist has left). Choosing someone keeps that choice.">
                <select className="field" value={f.preferredStaffId} onChange={(e) => setF({ ...f, preferredStaffId: e.target.value })}>
                  <option value="auto">Automatic (from visits){c.preferredStaffAuto && c.preferredStaffName ? ` — ${c.preferredStaffName}` : ''}</option>
                  <option value="">None</option>
                  {active.filter((s) => s.stylist || s.id === f.preferredStaffId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <div>
                <span className="label">Also sees</span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {active.map((s) => {
                    const on = f.staffIds.includes(s.id);
                    return <button key={s.id} type="button" onClick={() => setF({ ...f, staffIds: on ? f.staffIds.filter((x) => x !== s.id) : [...f.staffIds, s.id] })}
                      className={cx('rounded-full px-2.5 py-1 text-[13px]', on ? 'bg-plum text-white' : 'bg-mist text-ink-soft')}>{s.name}</button>;
                  })}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Birthday" hint="MM-DD or YYYY-MM-DD"><input className="field" value={f.birthday} onChange={(e) => setF({ ...f, birthday: e.target.value })} placeholder="03-14" /></Field>
                <Field label="Found us via"><input className="field" maxLength={60} value={f.leadSource} onChange={(e) => setF({ ...f, leadSource: e.target.value })} placeholder="Instagram, referral…" /></Field>
              </div>
            </>
          )}
          <Field label="Preferences" hint="Drinks, products, how they like their appointment, conversation…">
            <textarea className="field min-h-[80px]" maxLength={2000} value={f.preferences} onChange={(e) => setF({ ...f, preferences: e.target.value })} placeholder="e.g. Oat latte · quiet appointment · prefers ash tones" />
          </Field>
          <Field label="Allergies / sensitivities">
            <textarea className="field min-h-[60px]" maxLength={1000} value={f.allergies} onChange={(e) => setF({ ...f, allergies: e.target.value })} placeholder="e.g. Sensitive scalp — patch test new color" />
          </Field>
          <div className="flex gap-2"><Button size="sm" variant="primary" loading={saving} onClick={save}>Save</Button><Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
        </div>
      ) : (
        <dl className="panel divide-y divide-line text-sm">
          {c.allergies && <Detail label="Allergies" value={c.allergies} alert />}
          <Detail label="Preferences" value={c.preferences} multiline />
          <Detail label="Preferred stylist" value={c.preferredStaffName ? `${c.preferredStaffName}${c.preferredStaffAuto ? ' (from visits)' : ''}` : null} />
          <Detail label="Also sees" value={assignments.map((s) => s.name).join(', ') || null} />
          <Detail label="Services" value={services.join(', ') || null} />
          <Detail label="Visits" value={String(c.visitCount)} />
          <Detail label="Birthday" value={c.birthday ? c.birthday.replace(/^0000-/, '') : null} />
          <Detail label="Found us via" value={c.leadSource} />
          <Detail label="Square customer ID" value={c.squareCustomerId} mono />
          {showHighLevel && <Detail label="HighLevel contact" value={c.highlevelContactId} mono />}
          <Detail label="Client since" value={c.createdAt ? dateLong(c.createdAt) : null} />
        </dl>
      )}
    </section>
  );
}
