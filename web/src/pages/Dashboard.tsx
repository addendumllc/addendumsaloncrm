import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Bell, CalendarDays, CalendarX, Check, CircleDollarSign, Clock, Megaphone, MessageSquare, Package, RefreshCw, Repeat, Sparkles, Star, Wallet,
} from 'lucide-react';
import type { DashboardSummary } from '@addendum/shared';
import { useAppointments, useCanDo, useDashboard, useMe, useTasks, type DashboardWidgets } from '../api/hooks';
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
  const canDoTop = useCanDo();
  const { data, isLoading, error, refetch } = useDashboard();
  const w = data?.widgets;
  const canSchedule = !!w?.schedule && (canDoTop('appointments:read') || canDoTop('appointments:read_own'));
  const { data: today } = useAppointments({ range: 'today' }, canSchedule);
  const { data: top } = useTasks({ status: 'open', kind: 'follow_up', due: 'today', priority: 'high' }, !!w?.followups && (canDoTop('tasks:read_all') || canDoTop('tasks:read_own')));
  const nav = useNavigate();

  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;
  const { summary, actions } = data;
  const widgets = data.widgets;
  const nothingToDo = actions.length === 0;
  const tiles = TILES.filter((t) => summary[t.key] != null);
  const showWork = widgets.followups || widgets.clients;

  return (
    <div className="animate-rise">
      <p className="text-[15px] text-stone">{greeting()}, {firstName(me?.name)} — {weekdayDate(new Date())}</p>
      <h1 className="h-display mt-1 text-[40px] leading-[1.05] sm:text-[52px]">Today's Priorities</h1>

      {tiles.length > 0 && <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl2 border border-line bg-line sm:grid-cols-4">
        {tiles.map((t) => {
          const n = summary[t.key] as number;
          return (
            <Link key={t.key} to={t.link} className="group bg-white px-4 py-4 transition-colors hover:bg-plum-tint/40 sm:px-5">
              <span className={cx('num block font-display text-[38px] font-medium leading-none', t.alert && n > 0 ? 'text-plum' : 'text-ink', n === 0 && 'text-stone-light')}>{n}</span>
              <span className="mt-1.5 block text-[13px] text-stone group-hover:text-ink">{t.label}</span>
            </Link>
          );
        })}
      </div>}

      {widgets.projections && <ProjectionCards p={widgets.projections} />}
      <Widgets w={widgets} />

      {(showWork || canSchedule) && <div className={cx('mt-10 grid gap-10', showWork && canSchedule && 'lg:grid-cols-[minmax(0,1fr)_360px]')}>
        {showWork && <section>
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

          {widgets.followups && top && top.length > 0 && (
            <div className="mt-10">
              <SectionTitle action={<Link to="/follow-ups" className="text-sm text-plum hover:underline">See all follow-ups</Link>}>Start here</SectionTitle>
              <div className="space-y-3">{top.slice(0, 3).map((t) => <TaskCard key={t.id} task={t} compact />)}</div>
            </div>
          )}
        </section>}

        {canSchedule && <aside>
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
        </aside>}
      </div>}

      {widgets.analytics && <NewClientStats />}
    </div>
  );
}

/** Announcements, hair orders and commission — only those the server included for this person. */
function Widgets({ w }: { w: DashboardWidgets }) {
  const cards = [
    w.announcements && (
      <Link key="ann" to="/tasks" className="panel block p-4 hover:bg-plum-tint/30">
        <p className="flex items-center gap-2 text-[13px] font-medium uppercase tracking-wide text-stone"><Megaphone className="h-4 w-4" />Announcements{w.announcements.unread ? <span className="rounded-full bg-plum px-1.5 text-[11px] text-white">{w.announcements.unread} new</span> : null}</p>
        {w.announcements.latest.length === 0 ? <p className="mt-2 text-[14px] text-stone">Nothing new.</p> : (
          <ul className="mt-2 space-y-1.5">{w.announcements.latest.map((a) => <li key={a.id} className={cx('truncate text-[14px]', a.read ? 'text-ink-soft' : 'font-medium text-ink')}>{a.pinned ? 'Pinned · ' : ''}{a.title}</li>)}</ul>
        )}
      </Link>
    ),
    w.orders && (
      <Link key="orders" to="/inventory" className="panel block p-4 hover:bg-plum-tint/30">
        <p className="flex items-center gap-2 text-[13px] font-medium uppercase tracking-wide text-stone"><Package className="h-4 w-4" />{w.orders.scope === 'mine' ? 'My hair orders' : 'Hair orders'}</p>
        <p className="num mt-1 font-display text-[32px] leading-none text-ink">{w.orders.open}</p>
        <p className="text-[13px] text-stone">open</p>
        {w.orders.next.slice(0, 2).map((o) => <p key={o.id} className="mt-1 truncate text-[13px] text-ink-soft">#{o.number}{o.forName ? ` · ${o.forName}` : ''}{o.neededBy ? ` · needed ${o.neededBy.slice(5)}` : ''}</p>)}
      </Link>
    ),
    w.myCommission && (
      <Link key="mine" to="/my-commission" className="panel block p-4 hover:bg-plum-tint/30">
        <p className="flex items-center gap-2 text-[13px] font-medium uppercase tracking-wide text-stone"><Wallet className="h-4 w-4" />My commission</p>
        <p className="num mt-1 font-display text-[32px] leading-none text-ink">{usdWhole(w.myCommission.totalCents)}</p>
        <p className="text-[13px] text-stone">this week (estimated until finalized)</p>
      </Link>
    ),
    w.teamCommission && (
      <Link key="team" to="/commission" className="panel block p-4 hover:bg-plum-tint/30">
        <p className="flex items-center gap-2 text-[13px] font-medium uppercase tracking-wide text-stone"><CircleDollarSign className="h-4 w-4" />Team commission</p>
        <p className="num mt-1 font-display text-[32px] leading-none text-ink">{usdWhole(w.teamCommission.totalCents)}</p>
        <p className="text-[13px] text-stone">this week, everyone</p>
      </Link>
    ),
  ].filter(Boolean);
  if (!cards.length) return null;
  return <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{cards}</div>;
}

const usdWhole = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);

/** Admin-only: projected service revenue from booked appointments (not collected sales, not products or commission). */
function ProjectionCards({ p }: { p: NonNullable<DashboardWidgets['projections']> }) {
  const unestimated = p.week.unestimatedAppointments + p.month.unestimatedAppointments;
  const cards: [string, string, string][] = [
    ['Weekly projected revenue', usdWhole(p.week.revenueCents), 'This week'],
    ['Monthly projected revenue', usdWhole(p.month.revenueCents), 'This month'],
    ['Clients booked this week', String(p.week.clients), `${p.week.appointments} appointments`],
    ['Clients booked this month', String(p.month.clients), `${p.month.appointments} appointments`],
    ['Avg revenue per client', p.week.avgPerClientCents == null ? '—' : usdWhole(p.week.avgPerClientCents), 'This week'],
    ['Future booked revenue', usdWhole(p.future.revenueCents), 'Next 90 days'],
  ];
  return (
    <section className="mt-6">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] font-medium uppercase tracking-wide text-stone">Projected service revenue <span className="normal-case tracking-normal text-stone-light">· projections, not collected sales · admins only</span></p>
        <Link to="/analytics#projections" className="text-sm text-plum hover:underline">Details</Link>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {cards.map(([label, value, sub]) => (
          <Link key={label} to="/analytics#projections" className="panel block px-4 py-3 hover:bg-plum-tint/30">
            <span className="block text-[12px] text-stone">{label}</span>
            <span className="num mt-1 block font-display text-[26px] leading-none text-ink">{value}</span>
            <span className="mt-1 block text-[12px] text-stone">{sub}</span>
          </Link>
        ))}
      </div>
      {unestimated > 0 && <p className="mt-2 text-[12px] text-amber">Some booked appointments have no known price, so they aren’t in these totals.</p>}
    </section>
  );
}
