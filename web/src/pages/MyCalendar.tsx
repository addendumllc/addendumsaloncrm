import { useState } from 'react';
import { APPOINTMENT_STATUS_LABELS, type AppointmentDTO, type AppointmentDisplayStatus } from '@addendum/shared';
import { CalendarDays, ChevronLeft, ChevronRight, StickyNote } from 'lucide-react';
import { useAppointments, useMe } from '../api/hooks';
import { addDaysKey, dayKey, labelOfKey, startOfDayKey, time, weekdayOfKey } from '../lib/format';
import { Badge, Button, EmptyState, ErrorNote, PageHeader, PageLoading, cx } from '../components/ui';
import { Tc } from '../lib/titleCase';

/**
 * A stylist's own appointments, a week at a time. The server only ever returns the signed-in stylist's
 * bookings, whatever is asked for, so this page can't show anyone else's calendar.
 */
const TONE: Record<AppointmentDisplayStatus, 'sage' | 'amber' | 'neutral' | 'rose' | 'plum'> = {
  confirmed: 'plum', needs_attention: 'amber', completed: 'sage', cancelled: 'neutral', no_show: 'rose',
};

/** Monday of the week containing `key`. */
const weekStart = (key: string) => addDaysKey(key, -((weekdayOfKey(key) + 6) % 7));

export function MyCalendarPage() {
  const { data: me } = useMe();
  const today = dayKey(new Date());
  const [start, setStart] = useState(() => weekStart(today));
  const end = addDaysKey(start, 7);
  const { data, isLoading, error, refetch } = useAppointments({ from: startOfDayKey(start).toISOString(), to: startOfDayKey(end).toISOString() });
  const days = Array.from({ length: 7 }, (_, i) => addDaysKey(start, i));
  const byDay = new Map<string, AppointmentDTO[]>();
  for (const a of data ?? []) {
    const k = dayKey(a.startAt);
    byDay.set(k, [...(byDay.get(k) ?? []), a]);
  }
  const range = `${labelOfKey(start, { month: 'short', day: 'numeric' })} – ${labelOfKey(addDaysKey(end, -1), { month: 'short', day: 'numeric' })}`;
  const active = (data ?? []).filter((a) => a.displayStatus !== 'cancelled').length;

  return (
    <div className="animate-rise">
      <PageHeader title="My Calendar" subtitle={<>Your appointments{me?.name ? `, ${me.name}` : ''} · from Square</>} />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<ChevronLeft className="h-4 w-4" />} onClick={() => setStart(addDaysKey(start, -7))} aria-label="Previous week" />
        <Button size="sm" onClick={() => setStart(weekStart(today))} disabled={start === weekStart(today)}>This week</Button>
        <Button size="sm" icon={<ChevronRight className="h-4 w-4" />} onClick={() => setStart(addDaysKey(start, 7))} aria-label="Next week" />
        <span className="ml-1 text-sm text-ink-soft">{range}{data ? ` · ${active} appointment${active === 1 ? '' : 's'}` : ''}</span>
      </div>

      {isLoading && <PageLoading />}
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {data && data.length === 0 && (
        <div className="panel"><EmptyState icon={<CalendarDays className="h-9 w-9" />} title="No appointments this week">Bookings made in Square show up here.</EmptyState></div>
      )}
      {data && data.length > 0 && (
        <ul className="space-y-4">
          {days.filter((d) => byDay.has(d)).map((d) => (
            <li key={d} className="panel px-4 py-4 sm:px-5">
              <h2 className={cx('font-display text-xl', d === today ? 'text-plum' : 'text-ink')}><Tc>
                {labelOfKey(d, { weekday: 'long', month: 'short', day: 'numeric' })}{d === today ? ' · Today' : ''}
              </Tc></h2>
              <ul className="mt-2 divide-y divide-line/70">
                {byDay.get(d)!.map((a) => (
                  <li key={a.id} className={cx('flex gap-4 py-3', a.displayStatus === 'cancelled' && 'opacity-60')}>
                    <span className="num w-[74px] shrink-0 pt-0.5 text-sm font-medium text-ink">{time(a.startAt)}<span className="block text-xs font-normal text-stone">to {time(a.endAt)}</span></span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className={cx('font-medium text-ink', a.displayStatus === 'cancelled' && 'line-through')}>{a.clientName ?? 'Client'}</span>
                        <Badge tone={TONE[a.displayStatus]}>{APPOINTMENT_STATUS_LABELS[a.displayStatus]}</Badge>
                      </p>
                      {a.serviceNames.length > 0 && <p className="text-sm text-ink-soft">{a.serviceNames.join(' · ')}</p>}
                      {a.customerNote && <p className="mt-1 flex items-start gap-1.5 text-[13px] text-stone"><StickyNote className="mt-0.5 h-3.5 w-3.5 shrink-0" />{a.customerNote}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
