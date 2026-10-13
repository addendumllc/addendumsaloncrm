import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TASK_TYPE_LABELS, type TaskDTO } from '@addendum/shared';
import { CalendarPlus, Check, Clock, MessageSquare, MoreHorizontal, Phone, Star, Undo2 } from 'lucide-react';
import { api } from '../../api/client';
import { useRefreshAll, useSettings } from '../../api/hooks';
import { dueLabel, toInputValue } from '../../lib/format';
import { Badge, Button, Field, Menu, Modal, cx, useToast } from '../ui';
import { useActions } from './ActionsProvider';
import { ScheduleEditorLoader, dayLabel, weeksLabel } from './Rebooking';
import { useCanDo, useIntegrations } from '../../api/hooks';
import { openSquareBooking } from '../../lib/square';
import { HighLevelButton, HighLevelStatus } from './HighLevelButton';

export const PRIORITY_DOT: Record<string, string> = { high: 'bg-rose', medium: 'bg-amber', low: 'bg-sage' };
export const PRIORITY_LABEL: Record<string, string> = { high: 'High priority', medium: 'Medium priority', low: 'Low priority' };

function snoozeTimes() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 30, 0, 0);
  const nextWeek = new Date(now);
  nextWeek.setDate(now.getDate() + 7);
  nextWeek.setHours(9, 30, 0, 0);
  return [
    { label: 'In 1 hour', at: new Date(now.getTime() + 3600_000) },
    { label: 'In 3 hours', at: new Date(now.getTime() + 3 * 3600_000) },
    { label: 'Tomorrow morning', at: tomorrow },
    { label: 'Next week', at: nextWeek },
  ];
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
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {task.contactName && contactLink ? (
              <Link to={contactLink} className="font-display text-[22px] font-medium leading-tight text-ink hover:text-plum">{task.contactName}</Link>
            ) : (
              <span className="font-display text-[22px] font-medium leading-tight">{task.title}</span>
            )}
            <Badge tone={task.kind === 'task' ? 'neutral' : 'plum'}>{TASK_TYPE_LABELS[task.type]}</Badge>
            {task.leadId && !task.clientId && <Badge>Lead</Badge>}
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
              {task.status === 'completed' ? 'Completed' : task.status === 'cancelled' ? 'Cancelled' : dueLabel(task.dueAt)}
            </span>
            {task.assignedStaffName && <span className="text-stone">{task.assignedStaffName}</span>}
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
              <Button size="sm" variant="secondary" icon={<Check className="h-4 w-4" />} loading={busy === 'complete'} onClick={() => act('complete', `/tasks/${task.id}/complete`, {}, 'Follow-up completed')}>Complete</Button>
              <Menu
                trigger={(open) => <Button size="sm" variant="ghost" onClick={open} aria-label="More actions" icon={<MoreHorizontal className="h-4 w-4" />} />}
                items={[
                  ...snoozeTimes().map((s) => ({ label: `Snooze · ${s.label}`, onClick: () => act('snooze', `/tasks/${task.id}/snooze`, { until: s.at.toISOString() }, `Snoozed until ${s.label.toLowerCase()}`) })),
                  { label: 'Reschedule…', onClick: () => setReschedule(true) },
                  { label: 'Adjust rebooking schedule…', hidden: !(task.rebook && task.serviceId && task.clientId && canDo('rebooking:client')), onClick: () => setAdjust(true) },
                  { label: 'Not needed', onClick: () => act('nn', `/tasks/${task.id}/not-needed`, {}, 'Marked not needed') },
                  { label: `Not needed — stop ${task.serviceName ?? 'these'} follow-ups for this client`, hidden: !(task.rebook && task.serviceId && canDo('rebooking:client')), onClick: () => act('nn', `/tasks/${task.id}/not-needed`, { stopForService: true }, 'Follow-ups for this service turned off for this client') },
                  { label: 'Cancel follow-up', danger: true, onClick: () => act('cancel', `/tasks/${task.id}/cancel`, {}, 'Follow-up cancelled') },
                ]}
              />
            </div>
          )}
          {done && (
            <div className="mt-3"><Button size="sm" variant="ghost" icon={<Undo2 className="h-4 w-4" />} onClick={() => act('reopen', `/tasks/${task.id}/reopen`, {}, 'Reopened')}>Reopen</Button></div>
          )}
        </div>
      </div>
      {reschedule && <RescheduleModal task={task} onClose={() => setReschedule(false)} />}
      {adjust && task.clientId && task.serviceId && <ScheduleEditorLoader clientId={task.clientId} name={(task.contactName ?? 'Client').split(' ')[0]} serviceId={task.serviceId} onClose={() => setAdjust(false)} />}
    </article>
  );
}

function RescheduleModal({ task, onClose }: { task: TaskDTO; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshAll();
  const [due, setDue] = useState(toInputValue(new Date(Math.max(Date.now(), new Date(task.dueAt).getTime()) + 86400_000)));
  const [priority, setPriority] = useState(task.priority);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/tasks/${task.id}`, { dueAt: new Date(due).toISOString(), priority });
      toast('Follow-up rescheduled');
      refresh();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Reschedule follow-up" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={saving}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="New due time"><input type="datetime-local" className="field" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label="Priority">
          <select className="field" value={priority} onChange={(e) => setPriority(e.target.value as any)}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>
        </Field>
      </div>
      <p className="mt-3 text-xs text-stone">This only moves the follow-up. Square appointments are changed in Square.</p>
    </Modal>
  );
}
