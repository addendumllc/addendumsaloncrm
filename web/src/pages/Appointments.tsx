import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, RefreshCw, CalendarDays } from 'lucide-react';
import type { AppointmentDTO, AppointmentDisplayStatus } from '@addendum/shared';
import { api } from '../api/client';
import { useAppointments, useIntegrations, useMe, useRefreshAll, useStaff } from '../api/hooks';
import {
  addDaysKey, dateShort, dayKey, hourOfDay, labelOfKey, relative, startOfDayKey, time, weekdayOfKey,
} from '../lib/format';
import { Button, EmptyState, ErrorNote, PageHeader, PageLoading, Segmented, cx, useToast } from '../components/ui';
import { APPT_STYLE } from '../components/domain/appointmentStyles';
import { Tc } from '../lib/titleCase';

type View = 'day' | 'week' | 'month' | 'list';
const START_HOUR = 8;
const END_HOUR = 20;
const HOUR_PX = 64;

/** Square appointments (read-only — Square is the source of truth). Clicking opens the client. */
export function AppointmentsPage() {
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') ?? 'day') as View;
  const anchor = params.get('date') ?? dayKey(new Date());
  const staffId = params.get('staff') ?? '';
  const status = params.get('status') ?? '';
  const listRange = params.get('range') ?? 'upcoming';
  const { data: staff } = useStaff();
  const { data: me } = useMe();
  const { data: integ } = useIntegrations();
  const refresh = useRefreshAll();
  const toast = useToast();
  const nav = useNavigate();

  const set = (patch: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? p.set(k, v) : p.delete(k);
    setParams(p, { replace: true });
  };

  // Visible range for the current view.
  const range = useMemo(() => {
    if (view === 'day') return { from: anchor, days: 1 };
    if (view === 'week') return { from: addDaysKey(anchor, -weekdayOfKey(anchor)), days: 7 };
    if (view === 'month') {
      const first = `${anchor.slice(0, 7)}-01`;
      const start = addDaysKey(first, -weekdayOfKey(first));
      return { from: start, days: 42 };
    }
    return null;
  }, [view, anchor]);

  const query = range
    ? { from: startOfDayKey(range.from).toISOString(), to: startOfDayKey(addDaysKey(range.from, range.days)).toISOString(), staffId: staffId || undefined, status: status || undefined }
    : { range: listRange, staffId: staffId || undefined, status: status || undefined };
  const { data: appts, isLoading, error, refetch } = useAppointments(query);

  const step = (dir: number) => {
    const n = view === 'day' ? 1 : view === 'week' ? 7 : 0;
    if (view === 'month') {
      const [y, m] = anchor.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 + dir, 1));
      set({ date: d.toISOString().slice(0, 10) });
    } else set({ date: addDaysKey(anchor, dir * n) });
  };

  const syncNow = async () => {
    try {
      const r = await api.post<{ result: { ok: boolean; message: string } }>('/integrations/square/sync');
      toast(r.result.ok ? r.result.message : r.result.message, r.result.ok ? 'success' : 'error');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const title = view === 'day' ? labelOfKey(anchor, { weekday: 'long', month: 'long', day: 'numeric' })
    : view === 'week' && range ? `${labelOfKey(range.from, { month: 'short', day: 'numeric' })} – ${labelOfKey(addDaysKey(range.from, 6), { month: 'short', day: 'numeric' })}`
    : view === 'month' ? labelOfKey(anchor, { month: 'long', year: 'numeric' }) : 'All appointments';

  const open = (a: AppointmentDTO) => (a.clientId ? nav(`/clients/${a.clientId}`) : toast('This booking has no client attached in Square.', 'info'));

  return (
    <div>
      <PageHeader
        title="Appointments"
        subtitle={integ?.square.connected ? <>From Square · last synced {relative(integ.square.lastSyncAt)}</> : 'Connect Square in Settings to see real bookings.'}
        actions={<Button icon={<RefreshCw className="h-4 w-4" />} onClick={syncNow}>Sync now</Button>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented value={view} onChange={(v) => set({ view: v })} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'list', label: 'List' }]} />
        {view !== 'list' ? (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => step(-1)} aria-label="Previous" icon={<ChevronLeft className="h-4 w-4" />} />
            <Button size="sm" variant="secondary" onClick={() => set({ date: '' })}>Today</Button>
            <Button size="sm" variant="ghost" onClick={() => step(1)} aria-label="Next" icon={<ChevronRight className="h-4 w-4" />} />
            <span className="ml-2 font-display text-xl">{title}</span>
          </div>
        ) : (
          <select className="field h-9 w-auto py-1 text-sm" value={listRange} onChange={(e) => set({ range: e.target.value })} aria-label="Range">
            <option value="today">Today</option><option value="tomorrow">Tomorrow</option><option value="upcoming">Upcoming (90 days)</option><option value="past">Past (90 days)</option>
          </select>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <select className="field h-9 w-auto py-1 text-sm" value={staffId} onChange={(e) => set({ staff: e.target.value })} aria-label="Stylist">
            <option value="">{me?.calendarStaffIds ? 'Everyone I can see' : 'All stylists'}</option>{staff?.filter((s) => s.squareTeamMemberId && (s.stylist || s.id === staffId) && (!me?.calendarStaffIds || s.id === me.id || me.calendarStaffIds.includes(s.id))).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select className="field h-9 w-auto py-1 text-sm" value={status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
            <option value="">All statuses</option>{Object.entries(APPT_STYLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
      </div>

      <Legend />
      {isLoading && <PageLoading />}
      {error && <ErrorNote error={new Error('Unable to load appointments.')} onRetry={refetch} />}
      {appts && view === 'day' && <DayView appts={appts} dayKeyStr={anchor} staff={staff ?? []} onOpen={open} />}
      {appts && view === 'week' && range && <WeekView appts={appts} from={range.from} onOpen={open} onDay={(d) => set({ view: 'day', date: d })} />}
      {appts && view === 'month' && range && <MonthView appts={appts} from={range.from} month={anchor.slice(0, 7)} onDay={(d) => set({ view: 'day', date: d })} />}
      {appts && view === 'list' && <ListView appts={appts} onOpen={open} />}
    </div>
  );
}

function Legend() {
  return (
    <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone">
      {(Object.keys(APPT_STYLE) as AppointmentDisplayStatus[]).map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5"><span className={cx('h-2 w-2 rounded-full', APPT_STYLE[k].dot)} />{APPT_STYLE[k].label}</span>
      ))}
      <span className="text-stone-light">Square doesn't mark visits “completed”; past confirmed bookings show as completed.</span>
    </div>
  );
}

function Block({ a, onOpen, style }: { a: AppointmentDTO; onOpen: (a: AppointmentDTO) => void; style?: React.CSSProperties }) {
  const st = APPT_STYLE[a.displayStatus];
  return (
    <button
      onClick={() => onOpen(a)}
      style={style}
      className={cx('absolute overflow-hidden rounded-md border border-l-[3px] border-white px-1.5 py-1 text-left text-xs shadow-sm transition-shadow hover:z-20 hover:shadow-lift', st.block)}
      title={`${a.clientName ?? 'Client'} — ${a.serviceNames.join(', ')} (${st.label})`}
    >
      <span className="block truncate font-medium leading-tight text-ink">{a.clientName ?? 'Client'}</span>
      <span className="block truncate leading-tight text-ink-soft">{time(a.startAt)}</span>
      <span className="block truncate leading-tight text-stone">{a.serviceNames.join(', ')}</span>
      {a.rescheduledFrom && <span className="block truncate text-plum">Rescheduled</span>}
    </button>
  );
}

const span = (a: AppointmentDTO) => {
  const s = Math.max(hourOfDay(a.startAt), START_HOUR);
  const e = Math.max(Math.min(hourOfDay(a.endAt) || END_HOUR, END_HOUR), s + 0.25);
  return { s, e };
};

/**
 * Lays out one column's appointments so overlapping ones sit side by side instead of on top of each other:
 * each group of overlapping appointments is split into lanes, and every appointment gets its lane's share of the width.
 */
function layout(items: AppointmentDTO[]) {
  const sorted = [...items].sort((a, b) => span(a).s - span(b).s || span(b).e - span(a).e);
  const out = new Map<string, { lane: number; lanes: number }>();
  let group: { a: AppointmentDTO; lane: number }[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -1;
  const flush = () => { for (const g of group) out.set(g.a.id, { lane: g.lane, lanes: laneEnds.length }); group = []; laneEnds = []; };
  for (const a of sorted) {
    const { s, e } = span(a);
    if (group.length && s >= groupEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= s);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(e); } else laneEnds[lane] = e;
    group.push({ a, lane });
    groupEnd = Math.max(groupEnd, e);
  }
  flush();
  return { pos: (a: AppointmentDTO): React.CSSProperties => {
    const { s, e } = span(a);
    const { lane, lanes } = out.get(a.id) ?? { lane: 0, lanes: 1 };
    return { top: (s - START_HOUR) * HOUR_PX, height: Math.max((e - s) * HOUR_PX - 2, 30), left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` };
  }, maxLanes: Math.max(1, ...[...out.values()].map((v) => v.lanes)) };
}

function HourGutter() {
  return (
    <div className="w-14 shrink-0">
      {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => (
        <div key={i} style={{ height: HOUR_PX }} className="pr-2 text-right text-[11px] text-stone-light">
          {((START_HOUR + i + 11) % 12) + 1}{START_HOUR + i < 12 ? 'am' : 'pm'}
        </div>
      ))}
    </div>
  );
}

function NowLine({ dayKeyStr }: { dayKeyStr: string }) {
  if (dayKey(new Date()) !== dayKeyStr) return null;
  const h = hourOfDay(new Date());
  if (h < START_HOUR || h > END_HOUR) return null;
  return <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-plum" style={{ top: (h - START_HOUR) * HOUR_PX }} />;
}

/** Day view: one column per stylist — how a salon actually reads its book. */
function DayView({ appts, dayKeyStr, staff, onOpen }: { appts: AppointmentDTO[]; dayKeyStr: string; staff: { id: string; name: string; color: string; squareTeamMemberId: string | null }[]; onOpen: (a: AppointmentDTO) => void }) {
  const cols = staff.filter((s) => s.squareTeamMemberId && appts.some((a) => a.staffId === s.id));
  if (!appts.length) return <div className="panel"><EmptyState icon={<CalendarDays className="h-8 w-8" />} title="No appointments this day" /></div>;
  const unassigned = appts.filter((a) => !a.staffId);
  const columns = [...cols.map((s) => ({ key: s.id, name: s.name, color: s.color, items: appts.filter((a) => a.staffId === s.id) })),
    ...(unassigned.length ? [{ key: 'none', name: 'Unassigned', color: '#A29E97', items: unassigned }] : [])];
  return (
    <div className="panel overflow-x-auto">
      <div className="flex min-w-max">
        <div className="sticky left-0 z-10 bg-white"><div className="h-11 border-b border-line" /><HourGutter /></div>
        {columns.map((c) => { const lay = layout(c.items); return (
          <div key={c.key} className="border-l border-line" style={{ width: Math.max(180, lay.maxLanes * 120) }}>
            <div className="flex h-11 items-center gap-2 border-b border-line px-3 text-sm font-medium"><span className="h-2.5 w-2.5 rounded-full" style={{ background: c.color }} />{c.name}<span className="num text-xs font-normal text-stone">{c.items.length}</span></div>
            <div className="relative" style={{ height: (END_HOUR - START_HOUR) * HOUR_PX }}>
              {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => <div key={i} className="border-b border-line/60" style={{ height: HOUR_PX }} />)}
              <NowLine dayKeyStr={dayKeyStr} />
              {c.items.map((a) => <Block key={a.id} a={a} onOpen={onOpen} style={lay.pos(a)} />)}
            </div>
          </div>
        ); })}
      </div>
    </div>
  );
}

function WeekView({ appts, from, onOpen, onDay }: { appts: AppointmentDTO[]; from: string; onOpen: (a: AppointmentDTO) => void; onDay: (d: string) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => addDaysKey(from, i));
  const today = dayKey(new Date());
  return (
    <div className="panel overflow-x-auto">
      <div className="flex min-w-[860px]">
        <div className="sticky left-0 z-30 bg-white"><div className="h-12 border-b border-line" /><HourGutter /></div>
        {days.map((d) => {
          const items = appts.filter((a) => dayKey(a.startAt) === d);
          const lay = layout(items);
          // Busy days get wider (each overlapping appointment keeps a readable width); the week scrolls sideways.
          return (
            <div key={d} className="flex-1 border-l border-line" style={{ minWidth: Math.max(120, lay.maxLanes * 96) }}>
              <button onClick={() => onDay(d)} className={cx('flex h-12 w-full flex-col items-center justify-center border-b border-line text-xs hover:bg-mist', d === today && 'text-plum')}>
                <span>{labelOfKey(d, { weekday: 'short' })}</span>
                <span className="font-display text-lg leading-none">{labelOfKey(d, { day: 'numeric' })}</span>
              </button>
              <div className="relative" style={{ height: (END_HOUR - START_HOUR) * HOUR_PX }}>
                {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => <div key={i} className="border-b border-line/60" style={{ height: HOUR_PX }} />)}
                <NowLine dayKeyStr={d} />
                {items.map((a) => <Block key={a.id} a={a} onOpen={onOpen} style={lay.pos(a)} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MonthView({ appts, from, month, onDay }: { appts: AppointmentDTO[]; from: string; month: string; onDay: (d: string) => void }) {
  const days = Array.from({ length: 42 }, (_, i) => addDaysKey(from, i));
  const today = dayKey(new Date());
  const byDay = new Map<string, AppointmentDTO[]>();
  for (const a of appts) byDay.set(dayKey(a.startAt), [...(byDay.get(dayKey(a.startAt)) ?? []), a]);
  return (
    <div className="panel overflow-hidden">
      <div className="grid grid-cols-7 border-b border-line text-center text-xs text-stone">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="py-2">{d}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const items = byDay.get(d) ?? [];
          const counts = items.reduce<Record<string, number>>((acc, a) => ((acc[a.displayStatus] = (acc[a.displayStatus] ?? 0) + 1), acc), {});
          return (
            <button key={d} onClick={() => onDay(d)} className={cx('min-h-[88px] border-b border-r border-line p-1.5 text-left align-top hover:bg-mist/60 sm:min-h-[104px] sm:p-2', !d.startsWith(month) && 'bg-mist/40 text-stone-light')}>
              <span className={cx('inline-flex h-6 w-6 items-center justify-center rounded-full text-xs', d === today && 'bg-plum text-white')}>{Number(d.slice(8))}</span>
              {items.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  <p className="num text-[13px] font-medium text-ink">{items.length} <span className="font-normal text-stone">appt{items.length === 1 ? '' : 's'}</span></p>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(counts).map(([k, n]) => <span key={k} className={cx('inline-flex items-center gap-0.5 rounded px-1 text-[10px]', APPT_STYLE[k as AppointmentDisplayStatus].chip)}>{n}</span>)}
                  </div>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ListView({ appts, onOpen }: { appts: AppointmentDTO[]; onOpen: (a: AppointmentDTO) => void }) {
  if (!appts.length) return <div className="panel"><EmptyState icon={<CalendarDays className="h-8 w-8" />} title="No appointments match">Try another range or status.</EmptyState></div>;
  const groups: [string, AppointmentDTO[]][] = [];
  for (const a of appts) {
    const k = dayKey(a.startAt);
    const g = groups.find((x) => x[0] === k);
    g ? g[1].push(a) : groups.push([k, [a]]);
  }
  return (
    <div className="space-y-6">
      {groups.map(([k, items]) => (
        <section key={k}>
          <h2 className="mb-2 font-display text-xl"><Tc>{labelOfKey(k, { weekday: 'long', month: 'long', day: 'numeric' })}</Tc></h2>
          <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-white">
            {items.map((a) => {
              const st = APPT_STYLE[a.displayStatus];
              return (
                <li key={a.id}>
                  <button onClick={() => onOpen(a)} className="grid w-full grid-cols-[70px_1fr] gap-3 px-4 py-3 text-left hover:bg-mist/50 sm:grid-cols-[90px_1fr_160px_130px]">
                    <span className="num text-sm text-stone">{time(a.startAt)}<span className="block text-xs text-stone-light">to {time(a.endAt)}</span></span>
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-medium text-ink">{a.clientName ?? 'Client'}</span>
                      <span className="block truncate text-sm text-stone">{a.serviceNames.join(', ')}{a.rescheduledFrom && <span className="text-plum"> · moved from {dateShort(a.rescheduledFrom)} {time(a.rescheduledFrom)}</span>}</span>
                    </span>
                    <span className="hidden items-center gap-1.5 text-sm text-ink-soft sm:flex"><span className="h-2 w-2 rounded-full" style={{ background: a.staffColor ?? '#999' }} />{a.staffName ?? 'Any stylist'}</span>
                    <span className="col-start-2 sm:col-start-auto"><span className={cx('rounded-full px-2 py-0.5 text-xs', st.chip)}>{st.label}</span></span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
