import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScheduleDayDTO } from '@addendum/shared';
import { api } from '../../api/client';
import { useCanDo } from '../../api/hooks';
import { Button, Toggle, useToast } from '../../components/ui';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// `start`/`end` are kept while "Hours vary" is ticked, so unticking brings the last times back.
type Row = Omit<ScheduleDayDTO, 'start' | 'end'> & { on: boolean; varies: boolean; start: string; end: string };
const blank = (weekday: number): Row => ({ weekday, on: false, varies: false, start: '09:00', end: '17:30', lunchMinutes: 30, breakMinutes: 10 });

/**
 * A person's regular weekly schedule: which days, start and end, lunch (unpaid) and short break (paid). Shown on their
 * Time Clock (with late/early notes); the lunch and break lengths are what the time clock's buttons use.
 */
export function ScheduleSection({ staffId, staffName }: { staffId: string; staffName: string }) {
  const canDo = useCanDo();
  const editable = canDo('commission:manage') || canDo('users:manage');
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['schedule', staffId], queryFn: () => api.get<{ schedule: ScheduleDayDTO[] }>(`/timeclock/schedule/${staffId}`).then((r) => r.schedule) });
  const [rows, setRows] = useState<Row[]>(() => DAYS.map((_, i) => blank(i)));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data) setRows(DAYS.map((_, i) => { const d = data.find((x) => x.weekday === i); return d ? { ...blank(i), ...d, on: true, varies: d.start == null, start: d.start ?? '09:00', end: d.end ?? '17:30' } : blank(i); }));
  }, [data]);
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/timeclock/schedule/${staffId}`, { days: rows.filter((r) => r.on).map(({ on: _on, varies, ...d }) => ({ ...d, start: varies ? null : d.start, end: varies ? null : d.end })) });
      toast(`${staffName.split(' ')[0]}’s schedule saved`);
      qc.invalidateQueries({ queryKey: ['schedule', staffId] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const box = 'field h-10 w-auto px-2';
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-line rounded-xl border border-line">
        {rows.map((r, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
            <span className="w-32"><Toggle checked={r.on} disabled={!editable} onChange={(v) => set(i, { on: v })} label={DAYS[i]} /></span>
            {r.on ? (
              <>
                {r.varies ? <span className="text-ink-soft">Works this day · hours vary</span> : (
                  <>
                    <input type="time" className={box} disabled={!editable} value={r.start} onChange={(e) => set(i, { start: e.target.value })} aria-label={`${DAYS[i]} start`} />
                    <span className="text-stone">to</span>
                    <input type="time" className={box} disabled={!editable} value={r.end} onChange={(e) => set(i, { end: e.target.value })} aria-label={`${DAYS[i]} end`} />
                  </>
                )}
                <label className="ml-1 inline-flex items-center gap-1.5 text-ink-soft" title="No set times — e.g. their hours are booked by appointment">
                  <input type="checkbox" className="h-4 w-4 accent-plum" disabled={!editable} checked={r.varies} onChange={(e) => set(i, { varies: e.target.checked })} />Hours vary
                </label>
                <span className="ml-2 text-stone">Lunch</span>
                <input type="number" min={0} max={180} step={5} className={`${box} num w-16`} disabled={!editable} value={r.lunchMinutes} onChange={(e) => set(i, { lunchMinutes: Number(e.target.value) })} aria-label={`${DAYS[i]} lunch minutes`} />
                <span className="text-stone">min unpaid · Break</span>
                <input type="number" min={0} max={60} step={5} className={`${box} num w-16`} disabled={!editable} value={r.breakMinutes} onChange={(e) => set(i, { breakMinutes: Number(e.target.value) })} aria-label={`${DAYS[i]} break minutes`} />
                <span className="text-stone">min paid</span>
              </>
            ) : <span className="text-stone">Off</span>}
          </li>
        ))}
      </ul>
      {editable && <Button size="sm" variant="primary" loading={saving} onClick={save}>Save schedule</Button>}
      <p className="text-[12px] text-stone">Shown on their Time Clock, with a note if they clock in late. For days without set times (hours vary, or booked by appointment), tick “Hours vary” — it shows they work that day, with no late notes. Lunch is unpaid and taken off their hours; the short break is paid. Turn on “Use the time clock” in Role &amp; Permissions for people who clock in.</p>
    </div>
  );
}
