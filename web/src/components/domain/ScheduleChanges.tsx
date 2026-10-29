import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useStaff } from '../../api/hooks';
import { addDaysKey, dateTime, dayKey, relative } from '../../lib/format';
import { Badge, EmptyState, ErrorNote, PageLoading, chipClass } from '../ui';

interface Change {
  id: string; kind: 'cancelled' | 'rescheduled' | 'staff_changed' | 'created' | 'no_show'; at: string; appointmentId: string;
  clientId: string | null; clientName: string | null; staffName: string | null; fromStaffName: string | null; services: string | null;
  startAt: string; fromStartAt: string | null; by: 'salon' | 'client' | null; hoursBefore: number; lastMinute: boolean;
}
const KIND: Record<Change['kind'], { label: string; tone: 'rose' | 'amber' | 'plum' | 'sage' | 'neutral' }> = {
  cancelled: { label: 'Cancelled', tone: 'rose' }, rescheduled: { label: 'Rescheduled', tone: 'amber' }, staff_changed: { label: 'Stylist changed', tone: 'plum' },
  created: { label: 'Booked', tone: 'sage' }, no_show: { label: 'No-show', tone: 'neutral' },
};
const KINDS = ['', 'cancelled', 'rescheduled', 'staff_changed', 'no_show', 'created'] as const;

/**
 * Appointments → Changes (admins): the history of appointment changes made in Square — who cancelled (the salon or the
 * client), reschedules, stylist changes, no-shows and new bookings. Changes within 48 hours of the appointment are flagged.
 */
export function ScheduleChanges() {
  const today = dayKey(new Date());
  const [from, setFrom] = useState(addDaysKey(today, -30));
  const [to, setTo] = useState(today);
  const [kind, setKind] = useState<(typeof KINDS)[number]>('');
  const [staffId, setStaffId] = useState('');
  const [lastMinute, setLastMinute] = useState(false);
  const { data: staff } = useStaff();
  const qs = new URLSearchParams({ from, to, ...(kind ? { kind } : {}), ...(staffId ? { staffId } : {}), ...(lastMinute ? { lastMinute: 'true' } : {}) });
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['schedule-changes', qs.toString()], queryFn: () => api.get<{ changes: Change[]; lastMinuteHours: number }>(`/appointments/changes?${qs}`) });
  const salonCancels = (data?.changes ?? []).filter((c) => c.kind === 'cancelled' && c.by === 'salon').length;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input type="date" className="field h-10 w-auto" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <span className="text-stone">to</span>
        <input type="date" className="field h-10 w-auto" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <select className="field h-10 w-auto py-1 text-sm" value={staffId} onChange={(e) => setStaffId(e.target.value)} aria-label="Stylist">
          <option value="">All stylists</option>{staff?.filter((s) => s.squareTeamMemberId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="field h-10 w-auto py-1 text-sm" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Change">
          {KINDS.map((k) => <option key={k} value={k}>{k ? KIND[k].label : 'All changes'}</option>)}
        </select>
        <button type="button" className={chipClass(lastMinute)} aria-pressed={lastMinute} onClick={() => setLastMinute(!lastMinute)}>Last minute only</button>
      </div>
      <p className="mb-3 text-[13px] text-stone">
        Changes made in Square, newest first. <b className="font-medium text-ink-soft">Last minute</b> = within {data?.lastMinuteHours ?? 48} hours of the appointment.
        {salonCancels > 0 && <> · <b className="font-medium text-rose">{salonCancels}</b> cancelled by the salon in these dates.</>}
        {' '}Blocked-off time isn’t shared by Square, so it can’t be listed here.
      </p>
      {error ? <ErrorNote error={error} onRetry={refetch} /> : isLoading ? <PageLoading /> : !data?.changes.length ? (
        <div className="panel"><EmptyState title="No changes">Nothing changed in Square for these dates and filters.</EmptyState></div>
      ) : (
        <ul className="panel divide-y divide-line !p-0">
          {data.changes.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
              <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:min-w-[11rem]">
                <Badge tone={KIND[c.kind].tone}>{KIND[c.kind].label}</Badge>
                {c.lastMinute && <Badge tone="rose">Last minute</Badge>}
              </div>
              <div className="min-w-0 flex-1 text-[14px]">
                <p className="text-ink">
                  {c.clientId ? <Link className="font-medium hover:underline" to={`/clients/${c.clientId}`}>{c.clientName || 'Client'}</Link> : <span className="font-medium">{c.clientName || 'No client'}</span>}
                  {c.staffName && <> with {c.kind === 'staff_changed' && c.fromStaffName ? <>{c.fromStaffName} → <b className="font-medium">{c.staffName}</b></> : c.staffName}</>}
                  {c.services && <span className="text-stone"> · {c.services}</span>}
                </p>
                <p className="text-[13px] text-ink-soft">
                  {c.kind === 'rescheduled' && c.fromStartAt ? <>{dateTime(c.fromStartAt)} → <b className="font-medium">{dateTime(c.startAt)}</b></> : <>Appointment {dateTime(c.fromStartAt ?? c.startAt)}</>}
                  {c.by && <> · cancelled by {c.by === 'salon' ? <b className="font-medium text-rose">the salon (in Square)</b> : 'the client'}</>}
                </p>
              </div>
              <p className="w-full text-[12px] text-stone sm:w-auto sm:text-right" title={dateTime(c.at)}>
                Changed {relative(c.at)}{c.kind !== 'created' && c.hoursBefore >= 0 ? <span className="block">{c.hoursBefore < 24 ? `${Math.round(c.hoursBefore)}h` : `${Math.round(c.hoursBefore / 24)}d`} before</span> : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
