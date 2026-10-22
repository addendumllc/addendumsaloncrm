import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { TASK_BUSINESS_LABELS, TASK_TYPE_LABELS, type TaskBusiness, type TaskDTO, type TaskType } from '@addendum/shared';
import { CalendarPlus, Check, Clock, MessageSquare, MoreHorizontal, Pencil, Phone, Send, Star, Undo2, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import { useMe, useRefreshAll, useSettings, useStaff } from '../../api/hooks';
import { dueLabel, toInputValue } from '../../lib/format';
import { Badge, Button, Field, Menu, Modal, Segmented, cx, useToast } from '../ui';
import { useActions } from './ActionsProvider';
import { ScheduleEditorLoader, dayLabel, weeksLabel } from './Rebooking';
import { useCanDo, useIntegrations } from '../../api/hooks';
import { openSquareBooking } from '../../lib/square';
import { HighLevelButton, HighLevelStatus } from './HighLevelButton';

export const PRIORITY_DOT: Record<string, string> = { high: 'bg-rose', medium: 'bg-amber', low: 'bg-sage' };
export const PRIORITY_LABEL: Record<string, string> = { high: 'High priority', medium: 'Medium priority', low: 'Low priority' };

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayName = (key: string) => (key === ymd(new Date()) ? 'today' : new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }));

const tiny = 'inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-[12px] font-medium text-ink-soft hover:bg-mist hover:text-ink disabled:opacity-50';

/** A button that opens a small panel of quick choices below it (instead of a long menu). `small`: the compact status style. */
function Popover({ label, icon, loading, small, children }: { label: string; icon: React.ReactNode; loading?: boolean; small?: boolean; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {small
        ? <button type="button" className={tiny} disabled={loading} onClick={() => setOpen(!open)} aria-expanded={open}>{icon}{label}</button>
        : <Button size="sm" variant="secondary" icon={icon} loading={loading} onClick={() => setOpen(!open)} aria-expanded={open}>{label}</Button>}
      {open && <div className="absolute right-0 top-full z-40 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-xl border border-line bg-white p-3 shadow-pop">{children(() => setOpen(false))}</div>}
    </div>
  );
}

const chip = 'rounded-full bg-mist px-3 py-1.5 text-[13px] text-ink-soft hover:bg-plum-tint hover:text-ink';

/** Snooze for: quick choices, or any date and time. */
function SnoozePanel({ onPick }: { onPick: (at: Date, label: string) => void }) {
  const now = new Date();
  const morning = (days: number) => { const d = new Date(now); d.setDate(now.getDate() + days); d.setHours(9, 30, 0, 0); return d; };
  const [custom, setCustom] = useState(toInputValue(morning(2)));
  const quick: [string, Date][] = [
    ['1 hour', new Date(now.getTime() + 3600_000)], ['3 hours', new Date(now.getTime() + 3 * 3600_000)],
    ['Tomorrow morning', morning(1)], ['Next week', morning(7)],
  ];
  return (
    <div>
      <p className="mb-2 text-[12px] font-medium uppercase tracking-wide text-stone">Snooze for</p>
      <div className="flex flex-wrap gap-1.5">{quick.map(([l, at]) => <button key={l} type="button" className={chip} onClick={() => onPick(at, l.toLowerCase())}>{l}</button>)}</div>
      <div className="mt-3 flex items-end gap-2">
        <Field label="Or until" className="flex-1"><input type="datetime-local" className="field h-9" value={custom} onChange={(e) => setCustom(e.target.value)} /></Field>
        <Button size="sm" variant="primary" disabled={!custom || new Date(custom) <= now} onClick={() => onPick(new Date(custom), new Date(custom).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}>Snooze</Button>
      </div>
    </div>
  );
}

/** Reached out on (a day, today by default) — then when to check back if they haven't replied. */
function ReachedOutPanel({ onPick }: { onPick: (on: string, days: number, label: string) => void }) {
  const today = ymd(new Date());
  const [on, setOn] = useState(today);
  const backs: [number, string][] = [[1, 'tomorrow'], [2, 'in 2 days'], [3, 'in 3 days'], [7, 'in a week']];
  return (
    <div>
      <Field label="Reached out on"><input type="date" className="field h-9" max={today} value={on} onChange={(e) => setOn(e.target.value || today)} /></Field>
      <p className="mb-2 mt-3 text-[12px] font-medium uppercase tracking-wide text-stone">No reply yet? Check back</p>
      <div className="flex flex-wrap gap-1.5">{backs.map(([d, l]) => <button key={d} type="button" className={chip} onClick={() => onPick(on, d, l)}>{l[0].toUpperCase() + l.slice(1)}</button>)}</div>
      <p className="mt-2 text-[12px] text-stone">It stays open, and comes back sooner if they reply.</p>
    </div>
  );
}

/**
 * One follow-up with every action needed to finish it in a click or two.
 * The primary action adapts to the follow-up type (text a lead, send a review request…).
 */
export function TaskCard({ task, compact }: { task: TaskDTO; compact?: boolean }) {
  const toast = useToast();
  const refresh = useRefreshAll();
  const { compose } = useActions();
  const { data: settings } = useSettings();
  const [busy, setBusy] = useState<string | null>(null);
  const [reschedule, setReschedule] = useState(false);
  const [editing, setEditing] = useState(false);
  const [adjust, setAdjust] = useState(false);
  const canDo = useCanDo();
  const done = task.status === 'completed' || task.status === 'cancelled';

  const act = async (name: string, url: string, body: object = {}, msg?: string) => {
    setBusy(name);
    try {
      await api.post(url, body);
      if (msg) toast(msg);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  /** Internal tasks: switch between Addendum Salon and Addendum Hair. */
  const moveTo = async (business: 'salon' | 'hair') => {
    try {
      await api.patch(`/tasks/${task.id}`, { business });
      toast(`Moved to ${TASK_BUSINESS_LABELS[business]}`);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete “${task.title}”? This can’t be undone.`)) return;
    setBusy('delete');
    try {
      await api.del(`/tasks/${task.id}`);
      toast('Deleted');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const contactLink = task.clientId ? `/clients/${task.clientId}` : task.leadId ? `/leads?open=${task.leadId}` : null;
  const target = { name: task.contactName ?? 'client', phone: task.contactPhone, clientId: task.clientId, leadId: task.leadId, taskId: task.id, autoDraft: true };
  const { data: integ } = useIntegrations();
  const isReview = task.type === 'review_request';
  const isRebook = ['rebook', 'cancellation', 'no_show', 'consultation'].includes(task.type);

  return (
    <article className={cx('group rounded-xl2 border bg-white p-4 transition-shadow hover:shadow-lift sm:p-5', task.isOverdue ? 'border-rose/25' : 'border-line', done && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <span className={cx('mt-2 h-2.5 w-2.5 shrink-0 rounded-full', PRIORITY_DOT[task.priority])} title={PRIORITY_LABEL[task.priority]} aria-label={PRIORITY_LABEL[task.priority]} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          {/* The name keeps at least ~14rem, so on a phone the quick actions wrap onto their own line instead of covering it. */}
          <div className="flex min-w-[min(100%,14rem)] flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
            {task.contactName && contactLink ? (
              <Link to={contactLink} className="font-display text-[22px] font-medium leading-tight text-ink hover:text-plum">{task.contactName}</Link>
            ) : (
              <span className="font-display text-[22px] font-medium leading-tight">{task.title}</span>
            )}
            <Badge tone={task.kind === 'task' ? 'neutral' : 'plum'}>{TASK_TYPE_LABELS[task.type]}</Badge>
            {task.kind === 'task' && <Badge tone={task.business === 'hair' ? 'amber' : 'neutral'}>{TASK_BUSINESS_LABELS[task.business ?? 'salon']}</Badge>}
            {task.leadId && !task.clientId && <Badge>Lead</Badge>}
          </div>
          {/* Quick status updates, small and out of the way at the top right. */}
          {!done && (
            <div className="flex shrink-0 flex-wrap items-center gap-1">
              {(task.clientId || task.leadId) && (
                <Popover small label="Reached out" icon={<Send className="h-3.5 w-3.5" />} loading={busy === 'reached'}>
                  {(close) => <ReachedOutPanel onPick={(on, days, label) => { close(); void act('reached', `/tasks/${task.id}/reached-out`, { on, checkBackDays: days }, `Reached out ${dayName(on)} — it comes back ${label}, or as soon as they reply.`); }} />}
                </Popover>
              )}
              <Popover small label="Snooze" icon={<Clock className="h-3.5 w-3.5" />} loading={busy === 'snooze'}>
                {(close) => <SnoozePanel onPick={(at, label) => { close(); void act('snooze', `/tasks/${task.id}/snooze`, { until: at.toISOString() }, `Snoozed until ${label}`); }} />}
              </Popover>
              <button type="button" disabled={busy === 'complete'} onClick={() => act('complete', `/tasks/${task.id}/complete`, {}, 'Follow-up completed')} className={tiny}><Check className="h-3.5 w-3.5" />Complete</button>
              <Menu
                trigger={(open) => <button type="button" onClick={open} aria-label="More actions" className="rounded-md p-1 text-stone hover:bg-mist hover:text-ink"><MoreHorizontal className="h-4 w-4" /></button>}
                items={[
                  { label: 'Edit…', onClick: () => setEditing(true) },
                  { label: task.kind === 'task' ? 'Due date & priority…' : 'Reschedule…', onClick: () => setReschedule(true) },
                  { label: `Move to ${TASK_BUSINESS_LABELS[task.business === 'hair' ? 'salon' : 'hair']}`, hidden: task.kind !== 'task', onClick: () => moveTo(task.business === 'hair' ? 'salon' : 'hair') },
                  { label: 'Adjust rebooking schedule…', hidden: !(task.rebook && task.serviceId && task.clientId && canDo('rebooking:client')), onClick: () => setAdjust(true) },
                  { label: 'Not needed', onClick: () => act('nn', `/tasks/${task.id}/not-needed`, {}, 'Marked not needed') },
                  { label: 'Stop these follow-ups for this client', hidden: !(task.rebook && task.serviceId && canDo('rebooking:client')), onClick: () => act('nn', `/tasks/${task.id}/not-needed`, { stopForService: true }, 'Follow-ups for this service turned off for this client') },
                  { label: 'Cancel follow-up', danger: true, onClick: () => act('cancel', `/tasks/${task.id}/cancel`, {}, 'Follow-up cancelled') },
                  { label: 'Delete', danger: true, hidden: !canDo('tasks:delete'), onClick: remove },
                ]}
              />
            </div>
          )}
          </div>
          {task.contactName && <p className="mt-0.5 text-[15px] text-ink-soft">{task.title}</p>}
          {task.rebook && task.serviceName ? (
            <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
              <div><dt className="inline text-stone">Service </dt><dd className="inline font-medium text-ink">{task.serviceName}</dd></div>
              <div><dt className="inline text-stone">Last visit </dt><dd className="inline text-ink-soft">{dayLabel(task.rebook.lastVisitDate, true)}</dd></div>
              <div><dt className="inline text-stone">Recommended </dt><dd className="inline font-medium text-ink">{dayLabel(task.rebook.recommendedDate, true)}</dd></div>
              <div><dt className="inline text-stone">Schedule </dt><dd className="inline text-ink-soft">{task.rebook.source === 'preferred' ? 'their preferred date' : `every ${weeksLabel(task.rebook.intervalDays)}`}{task.rebook.source === 'client' || task.rebook.source === 'preferred' ? ' (custom)' : task.rebook.source === 'service' ? ' (service default)' : ' (from history)'}</dd></div>
            </dl>
          ) : task.reason && <p className="mt-1 text-sm text-stone">{task.reason}</p>}
          {task.notes && !compact && <p className="mt-1 whitespace-pre-line text-sm text-stone">{task.notes}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className={cx('inline-flex items-center gap-1', task.isOverdue ? 'font-medium text-rose' : 'text-stone')}>
              <Clock className="h-3.5 w-3.5" />
              {task.status === 'completed' ? 'Completed' : task.status === 'cancelled' ? 'Cancelled' : task.dueAt ? dueLabel(task.dueAt) : 'No due date'}
            </span>
            {task.assignedStaffName && <span className="text-stone">{task.assignedStaffName}</span>}
            {task.reachedOutAt && !done && (
              <span className="inline-flex items-center gap-1 text-plum"><Send className="h-3.5 w-3.5" />Reached out {new Date(task.reachedOutAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}{task.reachOutCount > 1 ? ` (${task.reachOutCount} times)` : ''} · waiting for reply</span>
            )}
            <HighLevelStatus task={task} />
          </div>

          {!done && (
            <div className="mt-3 flex flex-wrap gap-2">
              {task.contactPhone && (task.clientId || task.leadId) && (
                <Button size="sm" variant="primary" icon={isReview ? <Star className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />} onClick={() => compose(target)}>
                  {isReview ? 'Send review request' : 'Text'}
                </Button>
              )}
              {task.contactPhone && <a href={`tel:${task.contactPhone}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-white px-2.5 text-[13px] font-medium hover:bg-mist/60"><Phone className="h-4 w-4" />Call</a>}
              {isRebook && (
                <Button size="sm" icon={<CalendarPlus className="h-4 w-4" />} onClick={() => openSquareBooking(integ?.square.environment, task.contactName, toast)}>Book in Square</Button>
              )}
              <HighLevelButton task={task} />
              {canDo('tasks:write') && <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit</Button>}
            </div>
          )}
          {done && (
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="ghost" icon={<Undo2 className="h-4 w-4" />} onClick={() => act('reopen', `/tasks/${task.id}/reopen`, {}, 'Reopened')}>Reopen</Button>
              {canDo('tasks:write') && <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit</Button>}
              {canDo('tasks:delete') && <Button size="sm" variant="ghost" loading={busy === 'delete'} icon={<Trash2 className="h-4 w-4" />} onClick={remove}>Delete</Button>}
            </div>
          )}
        </div>
      </div>
      {reschedule && <RescheduleModal task={task} onClose={() => setReschedule(false)} />}
      {editing && <EditTaskModal task={task} onClose={() => setEditing(false)} />}
      {adjust && task.clientId && task.serviceId && <ScheduleEditorLoader clientId={task.clientId} name={(task.contactName ?? 'Client').split(' ')[0]} serviceId={task.serviceId} onClose={() => setAdjust(false)} />}
    </article>
  );
}

const FOLLOW_UP_TYPES: TaskType[] = ['follow_up', 'call', 'text', 'rebook', 'appointment_reminder', 'consultation', 'no_show', 'cancellation', 'review_request', 'new_lead', 'reply'];

/** Edit a task or follow-up: title, notes, type, priority, due date, who it's for and (internal tasks) the business. */
function EditTaskModal({ task, onClose }: { task: TaskDTO; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshAll();
  const canDo = useCanDo();
  const { data: staff } = useStaff();
  const { data: me } = useMe();
  const internal = task.kind === 'task';
  const [f, setF] = useState({
    title: task.title, notes: task.notes ?? '', type: task.type, priority: task.priority,
    due: task.dueAt ? toInputValue(new Date(task.dueAt)) : '', assigned: task.assignedStaffId ?? '', business: (task.business ?? 'salon') as TaskBusiness,
  });
  const up = (p: Partial<typeof f>) => setF((v) => ({ ...v, ...p }));
  // Giving it to someone else needs "Assign tasks"; anyone can take it themselves.
  const canAssign = canDo('tasks:assign');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/tasks/${task.id}`, {
        title: f.title.trim(), notes: f.notes.trim() || null, priority: f.priority,
        ...(internal ? { business: f.business } : { type: f.type }),
        // Follow-ups always keep a due date; internal tasks can have none.
        dueAt: f.due ? new Date(f.due).toISOString() : internal ? null : undefined,
        ...(f.assigned !== (task.assignedStaffId ?? '') ? { assignedStaffId: f.assigned || null } : {}),
      });
      toast(internal ? 'Task saved' : 'Follow-up saved');
      refresh();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={internal ? 'Edit task' : 'Edit follow-up'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={saving} disabled={!f.title.trim() || (!internal && !f.due)}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {internal && (
          <div className="sm:col-span-2">
            <span className="label">For</span>
            <Segmented value={f.business} onChange={(b) => up({ business: b })} options={(['salon', 'hair'] as const).map((b) => ({ value: b, label: TASK_BUSINESS_LABELS[b] }))} />
          </div>
        )}
        <Field label="Title" className="sm:col-span-2"><input className="field" value={f.title} onChange={(e) => up({ title: e.target.value })} maxLength={200} /></Field>
        {!internal && (
          <Field label="Type">
            <select className="field" value={f.type} onChange={(e) => up({ type: e.target.value as TaskType })}>
              {[...new Set([f.type, ...FOLLOW_UP_TYPES])].map((t) => <option key={t} value={t}>{TASK_TYPE_LABELS[t]}</option>)}
            </select>
          </Field>
        )}
        <Field label="Priority">
          <select className="field" value={f.priority} onChange={(e) => up({ priority: e.target.value as TaskDTO['priority'] })}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>
        </Field>
        <Field label={internal ? 'Due (optional)' : 'Due'}>
          <input type="datetime-local" className="field" value={f.due} onChange={(e) => up({ due: e.target.value })} />
          {internal && f.due && <button type="button" className="mt-1 text-[12px] text-plum hover:underline" onClick={() => up({ due: '' })}>No due date</button>}
        </Field>
        <Field label="Assigned to" className={internal ? '' : 'sm:col-span-2'}>
          <select className="field" value={f.assigned} onChange={(e) => up({ assigned: e.target.value })}>
            <option value="">Unassigned (front desk)</option>
            {(canAssign ? staff?.filter((s) => s.active || s.id === f.assigned) : staff?.filter((s) => s.id === me?.id || s.id === f.assigned))?.map((s) => <option key={s.id} value={s.id}>{s.id === me?.id ? `${s.name} (me)` : s.name}</option>)}
          </select>
        </Field>
        <Field label="Notes" className="sm:col-span-2"><textarea className="field min-h-[90px]" value={f.notes} onChange={(e) => up({ notes: e.target.value })} maxLength={4000} /></Field>
      </div>
    </Modal>
  );
}

function RescheduleModal({ task, onClose }: { task: TaskDTO; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshAll();
  const internal = task.kind === 'task';
  // Internal tasks may have no due date: start empty for those that don't have one.
  const [due, setDue] = useState(task.dueAt ? toInputValue(new Date(Math.max(Date.now(), new Date(task.dueAt).getTime()) + 86400_000)) : internal ? '' : toInputValue(new Date(Date.now() + 86400_000)));
  const [priority, setPriority] = useState(task.priority);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/tasks/${task.id}`, { dueAt: due ? new Date(due).toISOString() : internal ? null : undefined, priority });
      toast(internal ? 'Task updated' : 'Follow-up rescheduled');
      refresh();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={internal ? 'Due date & priority' : 'Reschedule follow-up'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={saving}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={internal ? 'Due (optional)' : 'New due time'} hint={internal ? 'Leave empty for no due date — just the priority.' : undefined}>
          <input type="datetime-local" className="field" value={due} onChange={(e) => setDue(e.target.value)} />
          {internal && due && <button type="button" className="mt-1 text-[12px] text-plum hover:underline" onClick={() => setDue('')}>No due date</button>}
        </Field>
        <Field label="Priority">
          <select className="field" value={priority} onChange={(e) => setPriority(e.target.value as any)}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>
        </Field>
      </div>
      <p className="mt-3 text-xs text-stone">This only moves the follow-up. Square appointments are changed in Square.</p>
    </Modal>
  );
}
