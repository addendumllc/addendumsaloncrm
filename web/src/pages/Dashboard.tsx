import { TransformationsDue } from '../components/domain/TransformationsDue';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bell, CalendarDays, CalendarX, Check, CircleDollarSign, Clock, ListTodo, Lock, MessageSquare, Package, Plus, RefreshCw, Repeat, Sparkles, Star, Wallet } from 'lucide-react';
import type { DashboardSummary, TaskDTO, TimeClockStatusDTO } from '@addendum/shared';
import { api } from '../api/client';
import { useAppointments, useCanDo, useDashboard, useMe, useTasks, type DashboardWidgets } from '../api/hooks';
import { firstName, time, weekdayDate } from '../lib/format';
import { Badge, Button, EmptyState, ErrorNote, PageLoading, SectionTitle, cx } from '../components/ui';
import { useActions } from '../components/domain/ActionsProvider';
import { TaskCard } from '../components/domain/TaskCard';
import { APPT_STYLE } from '../components/domain/appointmentStyles';
import { NewClientStats } from '../components/domain/NewClientStats';
import { AnnouncementsSection } from '../components/domain/Announcements';
import { Tc } from '../lib/titleCase';
import { WidgetGrid, type WidgetDef } from '../components/domain/WidgetGrid';

const ICONS: Record<string, typeof Bell> = {
  message: MessageSquare, sparkles: Sparkles, alert: AlertTriangle, clock: Clock, 'calendar-x': CalendarX, repeat: Repeat,
  calendar: CalendarDays, check: Check, bell: Bell, star: Star, refresh: RefreshCw,
};

const TILES: { key: keyof DashboardSummary; label: string; link: string; alert?: boolean }[] = [
  { key: 'appointmentsToday', label: 'Appointments today', link: '/appointments?view=day' },
  { key: 'newLeads', label: 'New clients', link: '/leads?status=new' },
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
  const canPublish = canDoTop('announcements:publish') || canDoTop('announcements:manage');
  // Internal tasks sent to this person, and their own personal tasks (ones they added and left unassigned), show first.
  // Open internal tasks, refreshed every minute so ones the team adds show up without reloading. The server already
  // limits what each person may see (their own and unassigned ones, or everyone's with "See all tasks").
  const seesTasks = canDoTop('tasks:read_all') || canDoTop('tasks:read_own');
  const { data: taskList } = useTasks({ status: 'open', kind: 'task' }, !!me && seesTasks, 60_000);
  const internal = taskList ?? [];
  const taskGroups = {
    mine: internal.filter((t) => t.assignedStaffId === me?.id),
    open: internal.filter((t) => !t.assignedStaffId),
    others: internal.filter((t) => t.assignedStaffId && t.assignedStaffId !== me?.id),
  };
  const { newFollowUp } = useActions();

  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;
  const { summary, actions } = data;
  const widgets = data.widgets;
  const nothingToDo = actions.length === 0;
  const tiles = TILES.filter((t) => summary[t.key] != null);
  const showWork = widgets.followups || widgets.clients;

  // Each section is a widget: what this person may see is decided by the server; where it goes and how wide it is,
  // by them (Customize).
  const defs: WidgetDef[] = [];
  if (seesTasks) defs.push({ id: 'my_tasks', title: 'Tasks', size: 'full',
    heading: <span className="flex items-center gap-2"><ListTodo className="h-5 w-5 text-plum" />Tasks{internal.length > 0 && <span className="rounded-full bg-plum px-2 py-0.5 font-sans text-[12px] text-white">{internal.length}</span>}</span>,
    action: (
      <span className="flex items-center gap-3">
        {canDoTop('tasks:write') && <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => newFollowUp({ internal: true })}>New task</Button>}
        <Link to="/tasks?kind=task" className="text-sm text-plum hover:underline">See all tasks</Link>
      </span>
    ),
    node: <TaskGroups groups={taskGroups} />,
  });
  if (tiles.length > 0) defs.push({ id: 'counts', title: 'Today at a glance', size: 'full', node: <CountTiles tiles={tiles} summary={summary} /> });
  if (widgets.announcements || canPublish) defs.push({ id: 'announcements', title: 'Announcements', size: 'full', ownHeading: true, node: <AnnouncementsSection className="h-full" /> });
  if (widgets.projections) defs.push({ id: 'projections', title: 'Projected service revenue', size: 'full', action: <Link to="/analytics#projections" className="text-sm text-plum hover:underline">Details</Link>, node: <ProjectionCards p={widgets.projections} /> });
  if (widgets.orders) defs.push({ id: 'orders', title: widgets.orders.scope === 'mine' ? 'My hair orders' : 'Hair orders', size: 's', node: <OrdersCard o={widgets.orders} /> });
  if (canDoTop('timeclock:use')) defs.push({ id: 'my_hours', title: 'My hours', size: 's', action: <Link to="/time-clock" className="text-sm text-plum hover:underline">Time Clock</Link>, node: <MyHoursCard /> });
  if (widgets.myCommission) defs.push({ id: 'my_commission', title: 'My earnings', size: 's', node: (
    <Link to="/my-commission" className="panel block h-full p-4 hover:bg-plum-tint/30">
      {widgets.myCommission.totalCents == null
        ? <p className="flex items-center gap-2 text-[15px] text-ink-soft"><Lock className="h-4 w-4 text-stone" />Private — open to see it</p>
        : <p className="num font-display text-[32px] leading-none text-ink">{usdWhole(widgets.myCommission.totalCents)}</p>}
      <p className="text-[13px] text-stone">this week (estimated until finalized)</p>
    </Link>
  ) });
  if (widgets.teamCommission) defs.push({ id: 'team_commission', title: 'Team payroll', size: 's', node: (
    <Link to="/commission" className="panel block h-full p-4 hover:bg-plum-tint/30">
      {widgets.teamCommission.totalCents == null
        ? <p className="flex items-center gap-2 text-[15px] text-ink-soft"><Lock className="h-4 w-4 text-stone" />Private — open to see it</p>
        : <p className="num font-display text-[32px] leading-none text-ink">{usdWhole(widgets.teamCommission.totalCents)}</p>}
      <p className="text-[13px] text-stone">this week, everyone</p>
    </Link>
  ) });
  if (showWork) defs.push({ id: 'actions', title: 'Recommended actions', size: canSchedule ? 'l' : 'full', node: (
    <div className="flex flex-col">
      {nothingToDo ? (
        <div className="panel flex flex-1 items-center justify-center"><EmptyState icon={<Check className="h-8 w-8" />} title="You're all caught up">No follow-ups need attention right now. New clients, texts and Square changes will appear here.</EmptyState></div>
      ) : (
        <ol className="flex-1 divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-white">
          {actions.map((a) => {
            const Icon = ICONS[a.icon] ?? Bell;
            return (
              <li key={a.key} className="flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5">
                <span className={cx('num min-w-10 shrink-0 text-right font-display font-medium leading-none', a.count >= 1000 ? 'text-[24px] sm:text-[30px]' : a.count >= 100 ? 'text-[28px] sm:text-[34px]' : 'text-[34px]', a.priority === 'high' ? 'text-plum' : 'text-ink')}>{a.count}</span>
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
    </div>
  ) });
  if (canSchedule) defs.push({ id: 'schedule', title: 'In the salon today', size: showWork ? 's' : 'full', action: <Link to="/appointments?view=day" className="text-sm text-plum hover:underline">Calendar</Link>, node: (
    <div className="flex flex-col">
      <div className="panel flex-1 overflow-hidden">
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
    </div>
  ) });
  if (widgets.analytics) defs.push({ id: 'new_clients', title: 'New clients', size: 'full', ownHeading: true, node: <NewClientStats className="" /> });

  return (
    <div className="animate-rise">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[15px] text-stone">{greeting()}, {firstName(me?.name)} — {weekdayDate(new Date())}</p>
          {widgets.priorities && <h1 className="h-display mt-1 text-[40px] leading-[1.05] sm:text-[52px]"><Tc>Today's Priorities</Tc></h1>}
        </div>
      </div>
      <TransformationsDue className="mt-4" />
      <WidgetGrid page="dashboard" defs={defs} />
    </div>
  );
}

/** heading/action: the widget's title row (same height for every widget, so a row lines up); ownHeading = it draws its own. */
/**
 * The counts, always in even rows: one line when there's room (about 130px per tile), otherwise two equal rows, and
 * 2 across on phones. Spare cells are blank tiles, so there's never a grey gap. Follows the widget's own width.
 */
function CountTiles({ tiles, summary }: { tiles: typeof TILES; summary: DashboardSummary }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Measured before the first paint (no jump from 2 columns to the real layout), then kept up to date.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = tiles.length;
  const half = Math.ceil(n / 2);
  const cols = width >= n * 130 ? n : width >= half * 130 ? half : Math.min(2, n);
  const blanks = (cols - (n % cols)) % cols;
  return (
    <div ref={ref} className="grid gap-px overflow-hidden rounded-xl2 border border-line bg-line" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {tiles.map((t) => {
        const v = summary[t.key] as number;
        return (
          <Link key={t.key} to={t.link} className="group bg-white px-4 py-4 transition-colors hover:bg-plum-tint/40">
            <span className={cx('num block font-display text-[34px] font-medium leading-none', t.alert && v > 0 ? 'text-plum' : 'text-ink', v === 0 && 'text-stone-light')}>{v}</span>
            <span className="mt-1.5 block text-[13px] leading-snug text-stone group-hover:text-ink">{t.label}</span>
          </Link>
        );
      })}
      {Array.from({ length: blanks }, (_, i) => <span key={`blank-${i}`} className="bg-white" aria-hidden />)}
    </div>
  );
}

/** Internal tasks on the Dashboard: assigned to you, unassigned (anyone can take), and — for managers — everyone else's. */
function TaskGroups({ groups }: { groups: { mine: TaskDTO[]; open: TaskDTO[]; others: TaskDTO[] } }) {
  const sections: [string, TaskDTO[]][] = [['Assigned to you', groups.mine], ['Unassigned — anyone can take', groups.open], ['Assigned to others', groups.others]];
  const shown = sections.filter(([, list]) => list.length > 0);
  if (!shown.length) return <div className="panel flex items-center justify-center"><EmptyState icon={<Check className="h-8 w-8" />} title="No open tasks">New internal tasks show here as soon as they’re added.</EmptyState></div>;
  const isNew = (t: TaskDTO) => Date.now() - new Date(t.createdAt).getTime() < 24 * 3600_000;
  return (
    <div className="space-y-5">
      {shown.map(([title, list]) => (
        <div key={title}>
          <p className="mb-2 text-[13px] font-medium uppercase tracking-wide text-stone">{title} <span className="normal-case tracking-normal">({list.length})</span></p>
          <div className="space-y-3">
            {list.slice(0, 5).map((t) => (
              <div key={t.id} className="relative">
                {isNew(t) && <Badge tone="plum" className="absolute -top-2 right-3 z-10">New</Badge>}
                <TaskCard task={t} compact />
              </div>
            ))}
          </div>
          {list.length > 5 && <Link to="/tasks?kind=task" className="mt-2 inline-block text-sm text-plum hover:underline">{list.length - 5} more</Link>}
        </div>
      ))}
    </div>
  );
}

/** Time clock at a glance: today's scheduled hours, clocked in or not, and hours worked this week. */
function MyHoursCard() {
  const { data } = useQuery({ queryKey: ['timeclock'], queryFn: () => api.get<TimeClockStatusDTO>('/timeclock/me'), refetchInterval: 60_000 });
  if (!data) return <div className="panel h-full p-4" />;
  const t12 = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const week = [...data.recent.filter((x) => x.clockOutAt && new Date(x.clockInAt) >= monday && x.id !== data.shift?.id), ...(data.shift ? [data.shift] : [])]
    .reduce((a, x) => a + x.paidMinutes, 0);
  const hm = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  return (
    <Link to="/time-clock" className="panel block h-full p-4 hover:bg-plum-tint/30">
      <p className="text-[13px] text-stone">Today</p>
      <p className="text-[16px] font-medium text-ink">{data.today ? (data.today.start && data.today.end ? `${t12(data.today.start)} – ${t12(data.today.end)}` : 'Working · hours vary') : 'Not scheduled'}</p>
      <p className={cx('mt-1 text-[13px]', data.shift ? 'text-sage' : 'text-stone')}>
        {data.shift ? `Clocked in since ${new Date(data.shift.clockInAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}${data.shift.breaks.some((b) => !b.endedAt) ? ' · on a break' : ''}` : 'Clocked out'}
      </p>
      <p className="num mt-2 font-display text-[28px] leading-none text-ink">{hm(week)}</p>
      <p className="text-[12px] text-stone">worked this week</p>
    </Link>
  );
}

function OrdersCard({ o }: { o: NonNullable<DashboardWidgets['orders']> }) {
  return (
    <Link to="/inventory" className="panel block h-full p-4 hover:bg-plum-tint/30">
      <p className="num font-display text-[32px] leading-none text-ink">{o.open}</p>
      <p className="text-[13px] text-stone">open</p>
      {o.next.slice(0, 2).map((x) => <p key={x.id} className="mt-1 truncate text-[13px] text-ink-soft">#{x.number}{x.forName ? ` · ${x.forName}` : ''}{x.neededBy ? ` · needed ${x.neededBy.slice(5)}` : ''}</p>)}
    </Link>
  );
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
    <section>
      <p className="-mt-1 mb-2 text-[12px] text-stone-light">Projections, not collected sales · admins only</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
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
