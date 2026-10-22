import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ClockShiftDTO, ScheduleDayDTO, TimeClockStatusDTO } from '@addendum/shared';
import { Coffee, LogIn, LogOut, Utensils, Wifi, WifiOff } from 'lucide-react';
import { api } from '../api/client';
import { Badge, Button, PageHeader, PageLoading, cx, useToast } from '../components/ui';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const t12 = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const hm = (min: number) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
/** Just the hours, e.g. "10:00 AM – 5:00 PM". */
export const scheduleHours = (d: ScheduleDayDTO) => (d.start && d.end ? `${t12(d.start)} – ${t12(d.end)}` : 'Working · hours vary');
export const scheduleLine = (d: ScheduleDayDTO) => `${scheduleHours(d)}${d.lunchMinutes ? ` · lunch ${d.lunchMinutes} min (unpaid)` : ''}${d.breakMinutes ? ` · break ${d.breakMinutes} min (paid)` : ''}`;

/** Minutes between two times today (HH:MM) and a moment, for late/early notes. */
const vsSchedule = (iso: string, hhmm: string) => {
  const d = new Date(iso);
  const [h, m] = hhmm.split(':').map(Number);
  return Math.round((d.getHours() * 60 + d.getMinutes()) - (h * 60 + m));
};

/** Time Clock: clock in and out, and take lunch (unpaid) and short breaks (paid). Hours go to Payroll and Square. */
export function TimeClockPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  // Opened first thing today (see FirstOpenOfDay): clocking in goes on to the Dashboard.
  const [params] = useSearchParams();
  const first = params.get('first') === '1';
  const { data, isLoading } = useQuery({ queryKey: ['timeclock'], queryFn: () => api.get<TimeClockStatusDTO>('/timeclock/me'), refetchInterval: 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 15_000); return () => window.clearInterval(t); }, []);
  if (isLoading || !data) return <PageLoading />;

  const act = async (key: string, url: string, body: object = {}, msg?: (s: ClockShiftDTO) => string) => {
    setBusy(key);
    try {
      const r = await api.post<{ shift: ClockShiftDTO }>(url, body);
      if (msg) toast(msg(r.shift));
      qc.invalidateQueries({ queryKey: ['timeclock'] });
      if (first && key === 'in') nav('/', { replace: true });
      for (const k of ['timesheet', 'staff-pay', 'commission-me']) qc.invalidateQueries({ queryKey: [k] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const s = data.shift;
  const onBreak = s?.breaks.find((b) => !b.endedAt) ?? null;
  const blocked = data.needsSalonNetwork && !data.onSalonNetwork;
  const tookLunch = !!s?.breaks.some((b) => b.kind === 'lunch');
  const late = s && data.today?.start ? vsSchedule(s.clockInAt, data.today.start) : 0;
  const breakLeft = onBreak ? onBreak.plannedMinutes - Math.round((Date.now() - new Date(onBreak.startedAt).getTime()) / 60_000) : 0;

  return (
    <div>
      <PageHeader title="Time Clock" subtitle={data.today ? `Today: ${scheduleHours(data.today)}` : 'Not on the schedule today.'}
        actions={first && !s ? <Button variant="ghost" onClick={() => nav('/', { replace: true })}>Not now — go to Dashboard</Button> : undefined} />

      <div className={cx('panel mx-auto max-w-xl p-6 text-center', onBreak && 'border-amber/40')}>
        {data.needsSalonNetwork && (
          <p className={cx('mb-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px]', data.onSalonNetwork ? 'bg-sage-tint text-sage' : 'bg-rose-tint text-rose')}>
            {data.onSalonNetwork ? <><Wifi className="h-4 w-4" />On the salon network</> : <><WifiOff className="h-4 w-4" />Connect to the salon’s Wi-Fi to clock in or out</>}
          </p>
        )}
        {!s ? (
          <>
            <p className="text-[15px] text-stone">You’re clocked out.</p>
            <Button variant="primary" className="mt-4 h-14 w-full text-[18px]" icon={<LogIn className="h-5 w-5" />} disabled={blocked} loading={busy === 'in'}
              onClick={() => act('in', '/timeclock/in', {}, (x) => `Clocked in at ${time(x.clockInAt)}`)}>Clock in</Button>
          </>
        ) : (
          <>
            <p className="text-[15px] text-stone">Clocked in at <b className="font-medium text-ink">{time(s.clockInAt)}</b>{data.today?.start && late > 5 ? <span className="text-amber"> · {late} min after your {t12(data.today.start)} start</span> : null}</p>
            <p className="num mt-2 font-display text-[44px] leading-none text-ink">{hm(s.paidMinutes)}</p>
            <p className="text-[13px] text-stone">paid time so far (lunch isn’t counted)</p>
            {s.squareLive ? <p className="mt-1 text-[12px] text-sage">✓ Clocked in on Square too</p>
              : onBreak?.kind === 'lunch' && s.squareSent ? <p className="mt-1 text-[12px] text-stone">Clocked out on Square for lunch</p>
              : s.squareError ? <p className="mt-1 text-[12px] text-amber">{s.squareError}</p> : null}
            {onBreak ? (
              <div className="mt-5 rounded-xl bg-amber-tint p-4">
                <p className="font-medium text-ink">{onBreak.kind === 'lunch' ? 'On lunch (unpaid)' : 'On a break (paid)'} since {time(onBreak.startedAt)}</p>
                <p className="text-[13px] text-ink-soft">{breakLeft > 0 ? `${breakLeft} min left of ${onBreak.plannedMinutes}` : `${-breakLeft} min over the ${onBreak.plannedMinutes} min`}</p>
                <Button variant="primary" className="mt-3 w-full" disabled={blocked} loading={busy === 'end'} onClick={() => act('end', '/timeclock/break/end', {}, () => 'Welcome back — break ended')}>
                  End {onBreak.kind === 'lunch' ? 'lunch' : 'break'}
                </Button>
              </div>
            ) : (
              <div className="mt-5 grid gap-2 sm:grid-cols-2">
                <Button className="h-12" icon={<Utensils className="h-4 w-4" />} disabled={blocked || tookLunch} loading={busy === 'lunch'}
                  onClick={() => act('lunch', '/timeclock/break', { kind: 'lunch' }, () => 'Lunch started — unpaid')}>
                  {tookLunch ? 'Lunch taken' : `Start lunch (${data.today?.lunchMinutes ?? 30} min, unpaid)`}
                </Button>
                <Button className="h-12" icon={<Coffee className="h-4 w-4" />} disabled={blocked} loading={busy === 'rest'}
                  onClick={() => act('rest', '/timeclock/break', { kind: 'rest' }, () => 'Break started — paid')}>
                  Start break ({data.today?.breakMinutes ?? 10} min, paid)
                </Button>
              </div>
            )}
            <Button variant="secondary" className="mt-3 h-12 w-full" icon={<LogOut className="h-4 w-4" />} disabled={blocked} loading={busy === 'out'}
              onClick={() => act('out', '/timeclock/out', {}, (x) => `Clocked out — ${hm(x.paidMinutes)} paid${x.squareSent ? ', sent to Square' : ''}`)}>Clock out</Button>
          </>
        )}
      </div>

      <div className="mx-auto mt-6 grid max-w-xl gap-6">
        <section>
          <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone">Your schedule</h2>
          {data.schedule.length === 0 ? <p className="text-[14px] text-stone">No regular schedule yet — an administrator sets it in Users &amp; Permissions → Pay.</p> : (
            <ul className="divide-y divide-line rounded-xl2 border border-line bg-white">
              {data.schedule.map((d) => <li key={d.weekday} className="flex gap-3 px-4 py-2.5 text-[14px]"><span className="w-10 font-medium text-ink">{DAYS[d.weekday]}</span><span className="text-ink-soft">{scheduleHours(d)}</span></li>)}
            </ul>
          )}
        </section>
        <section>
          <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone">Last two weeks</h2>
          {data.recent.filter((x) => x.clockOutAt).length === 0 ? <p className="text-[14px] text-stone">No finished shifts yet.</p> : (
            <ul className="divide-y divide-line rounded-xl2 border border-line bg-white">
              {data.recent.filter((x) => x.clockOutAt).map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[14px]">
                  <span className="w-28 font-medium text-ink">{new Date(x.clockInAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                  <span className="text-ink-soft">{time(x.clockInAt)} – {time(x.clockOutAt!)}</span>
                  <span className="num ml-auto font-medium text-ink">{hm(x.paidMinutes)}</span>
                  {x.squareSent ? <Badge tone="sage">In Square</Badge> : x.squareError ? <span title={x.squareError}><Badge tone="amber">Saved here</Badge></span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
