import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Bell, CalendarDays, CalendarX, Check, Clock, MessageSquare, RefreshCw, Repeat, Sparkles, Star,
} from 'lucide-react';
import type { DashboardSummary } from '@addendum/shared';
import { useAppointments, useCanDo, useDashboard, useMe, useTasks } from '../api/hooks';
import { firstName, time, weekdayDate } from '../lib/format';
import { Button, EmptyState, ErrorNote, PageLoading, SectionTitle, cx } from '../components/ui';
import { TaskCard } from '../components/domain/TaskCard';
import { APPT_STYLE } from '../components/domain/appointmentStyles';
import { NewClientStats } from '../components/domain/NewClientStats';

const ICONS: Record<string, typeof Bell> = {
  message: MessageSquare, sparkles: Sparkles, alert: AlertTriangle, clock: Clock, 'calendar-x': CalendarX, repeat: Repeat,
  calendar: CalendarDays, check: Check, bell: Bell, star: Star, refresh: RefreshCw,
};

const TILES: { key: keyof DashboardSummary; label: string; link: string; alert?: boolean }[] = [
  { key: 'appointmentsToday', label: 'Appointments today', link: '/appointments?view=day' },
  { key: 'newLeads', label: 'New leads', link: '/leads?status=new' },
  { key: 'followUpsDue', label: 'Follow-ups due', link: '/follow-ups' },
  { key: 'overdueFollowUps', label: 'Overdue follow-ups', link: '/follow-ups?due=overdue', alert: true },
  { key: 'unreadMessages', label: 'Unread messages', link: '/messages?filter=unread', alert: true },
  { key: 'readyToRebook', label: 'Ready to rebook', link: '/follow-ups?type=rebook' },
  { key: 'cancellations', label: 'Cancellations this week', link: '/appointments?view=list&range=past&status=cancelled' },
  { key: 'noShows', label: 'No-shows this week', link: '/appointments?view=list&range=past&status=no_show' },
];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function DashboardPage() {
  const { data: me } = useMe();
  const { data, isLoading, error, refetch } = useDashboard();
  const { data: today } = useAppointments({ range: 'today' });
  const { data: top } = useTasks({ status: 'open', kind: 'follow_up', due: 'today', priority: 'high' });
  const nav = useNavigate();
  const canDo = useCanDo();

  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;
  const { summary, actions } = data;
  const nothingToDo = actions.length === 0;

  return (
    <div className="animate-rise">
      <p className="text-[15px] text-stone">{greeting()}, {firstName(me?.name)} — {weekdayDate(new Date())}</p>
      <h1 className="h-display mt-1 text-[40px] leading-[1.05] sm:text-[52px]">Today's Priorities</h1>

      <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl2 border border-line bg-line sm:grid-cols-4">
        {TILES.filter((t) => summary[t.key] != null).map((t) => {
          const n = summary[t.key] as number;
          return (
            <Link key={t.key} to={t.link} className="group bg-white px-4 py-4 transition-colors hover:bg-plum-tint/40 sm:px-5">
              <span className={cx('num block font-display text-[38px] font-medium leading-none', t.alert && n > 0 ? 'text-plum' : 'text-ink', n === 0 && 'text-stone-light')}>{n}</span>
              <span className="mt-1.5 block text-[13px] text-stone group-hover:text-ink">{t.label}</span>
            </Link>
          );
        })}
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section>
          <SectionTitle>Recommended actions</SectionTitle>
          {nothingToDo ? (
            <div className="panel"><EmptyState icon={<Check className="h-8 w-8" />} title="You're all caught up">No follow-ups need attention right now. New leads, texts and Square changes will appear here.</EmptyState></div>
          ) : (
            <ol className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-white">
              {actions.map((a) => {
                const Icon = ICONS[a.icon] ?? Bell;
                return (
                  <li key={a.key} className="flex items-center gap-4 px-4 py-4 sm:px-5">
                    <span className={cx('num w-10 shrink-0 text-right font-display text-[34px] font-medium leading-none', a.priority === 'high' ? 'text-plum' : 'text-ink')}>{a.count}</span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-[15px] font-medium text-ink"><Icon className="h-4 w-4 shrink-0 text-stone" />{a.title}</p>
                      <p className="mt-0.5 text-[13px] text-stone">{a.description}</p>
                    </div>
                    <Button size="sm" variant={a.priority === 'high' ? 'primary' : 'secondary'} onClick={() => nav(a.link)}>{a.actionLabel}</Button>
                  </li>
                );
              })}
            </ol>
          )}

          {top && top.length > 0 && (
            <div className="mt-10">
              <SectionTitle action={<Link to="/follow-ups" className="text-sm text-plum hover:underline">See all follow-ups</Link>}>Start here</SectionTitle>
              <div className="space-y-3">{top.slice(0, 3).map((t) => <TaskCard key={t.id} task={t} compact />)}</div>
            </div>
          )}
        </section>

        <aside>
          <SectionTitle action={<Link to="/appointments?view=day" className="text-sm text-plum hover:underline">Calendar</Link>}>In the salon today</SectionTitle>
          <div className="panel overflow-hidden">
            {!today?.length && <EmptyState title="No appointments today">Square bookings for today will show here.</EmptyState>}
            <ul className="divide-y divide-line">
              {today?.map((a) => {
                const st = APPT_STYLE[a.displayStatus];
                return (
                  <li key={a.id}>
                    <button onClick={() => a.clientId && nav(`/clients/${a.clientId}`)} className="flex w-full gap-3 px-4 py-3 text-left hover:bg-mist/50">
                      <span className="num w-16 shrink-0 pt-0.5 text-[13px] text-stone">{time(a.startAt)}</span>
                      <span className="min-w-0 flex-1">
                        <span className={cx('block truncate text-[15px] text-ink', a.displayStatus === 'cancelled' && 'line-through')}>{a.clientName ?? 'Walk-in'}</span>
                        <span className="block truncate text-[13px] text-stone">{a.serviceNames.join(', ')}</span>
                        <span className="mt-1 flex items-center gap-2 text-xs">
                          {a.staffName && <span className="inline-flex items-center gap-1 text-ink-soft"><span className="h-2 w-2 rounded-full" style={{ background: a.staffColor ?? '#999' }} />{a.staffName}</span>}
                          <span className={cx('rounded-full px-1.5 py-px', st.chip)}>{st.label}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {summary.pendingConfirmations > 0 && (
            <p className="mt-3 text-[13px] text-stone">{summary.pendingConfirmations} booking request{summary.pendingConfirmations === 1 ? ' is' : 's are'} waiting to be accepted in Square.</p>
          )}
        </aside>
      </div>

      {canDo('analytics:read') && <NewClientStats />}
    </div>
  );
}
