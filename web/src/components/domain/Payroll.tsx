import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClockShiftDTO, TimesheetRowDTO } from '@addendum/shared';
import { ArrowDownToLine, ArrowUpFromLine, ChevronLeft, ChevronRight, Clock3, RefreshCw } from 'lucide-react';
import { api } from '../../api/client';
import { useCanDo, useMe } from '../../api/hooks';
import { addDaysKey, dayKey, labelOfKey, weekdayOfKey } from '../../lib/format';
import { Button, Modal, PageLoading, Segmented, cx, useToast, chipClass } from '../ui';
import { ShiftModal, ShiftsList } from './Shifts';

const ymdLocal = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const mondayOf = (k: string) => addDaysKey(k, -((weekdayOfKey(k) + 6) % 7));
const usd = (c: number) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Hours always with 2 decimals (8.00, 9.25). */
const h = (m: number) => (m / 60).toFixed(2);

/**
 * Team Commission → Payroll: a weekly timesheet. A number in a day's box is that day's hours for pay (in place of
 * Square's); an empty box means Square timecards (and hours added in Users & Permissions) count. "Use Sq" copies
 * Square's hours into the box to confirm or adjust them. Wages follow each person's wage history.
 */
export function PayrollTimesheet() {
  const canDo = useCanDo();
  const editable = canDo('commission:manage');
  const toast = useToast();
  const qc = useQueryClient();
  const today = dayKey(new Date());
  const [week, setWeek] = useState(mondayOf(today));
  const days = Array.from({ length: 7 }, (_, i) => addDaysKey(week, i));
  const to = days[6];
  const { data, isLoading } = useQuery({
    queryKey: ['timesheet', week],
    queryFn: () => api.get<{ rows: TimesheetRowDTO[] }>(`/commission/timesheet?from=${week}&to=${to}`).then((r) => r.rows),
  });
  const [onlyHourly, setOnlyHourly] = useState(false); // everyone, so commission-only hours show too
  // Person tabs: work through one person at a time (null = everyone).
  const [person, setPerson] = useState<string | null>(null);
  // Editing a day by its times (clock in/out, lunch): that day's shift, or a new one. Owners/Admins; saved to Square.
  const { data: weekShifts } = useQuery({
    queryKey: ['shifts', week, to, 'all'],
    queryFn: () => api.get<{ shifts: ClockShiftDTO[] }>(`/timeclock/shifts?from=${week}&to=${to}`).then((r) => r.shifts),
  });
  const [timesFor, setTimesFor] = useState<{ staffId: string; date: string; shift: ClockShiftDTO | null } | null>(null);
  const shiftOn = (staffId: string, d: string) => (weekShifts ?? []).find((x) => x.staffId === staffId && ymdLocal(x.clockInAt) === d) ?? null;
  // Who's on the time clock right now.
  const { data: clockedIn } = useQuery({ queryKey: ['timeclock-now'], queryFn: () => api.get<{ shifts: ClockShiftDTO[] }>('/timeclock/now').then((r) => r.shifts), refetchInterval: 60_000 });
  const refresh = () => { for (const k of ['timesheet', 'commission-team', 'commission-staff', 'commission-me', 'staff-pay', 'pay-year', 'shifts', 'timeclock']) qc.invalidateQueries({ queryKey: [k] }); };
  // Owners/Admins: Square is updated to match (the server replaces that day's timecards).
  const put = (r: TimesheetRowDTO, date: string, hours: number | null) =>
    api.put<{ square: { updated: boolean; error: string | null } | null }>('/commission/timesheet', { staffId: r.staffId, date, hours });
  const save = async (r: TimesheetRowDTO, date: string, value: string) => {
    const hours = value.trim() === '' ? null : Number(value);
    if (hours != null && (!Number.isFinite(hours) || hours < 0 || hours > 24)) { toast('Enter hours between 0 and 24.', 'error'); return; }
    if ((hours == null ? null : Math.round(hours * 60)) === (r.timesheet[date] ?? null)) return;
    try {
      const res = await put(r, date, hours);
      if (res.square?.error) toast(`Saved here, but Square wasn’t updated: ${res.square.error}`, 'error');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  /** Someone entered "By week": one total for the whole week (null clears it). */
  const saveWeek = async (r: TimesheetRowDTO, value: string) => {
    const hours = value.trim() === '' ? null : Number(value);
    if (hours != null && (!Number.isFinite(hours) || hours < 0 || hours > 168)) { toast('Enter hours between 0 and 168.', 'error'); return; }
    if ((hours == null ? null : Math.round(hours * 60)) === r.weekTotal) return;
    try {
      await api.put('/commission/timesheet/week', { staffId: r.staffId, weekStart: week, hours });
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const setMode = async (r: TimesheetRowDTO, mode: 'day' | 'week') => {
    try {
      await api.put('/commission/timesheet/mode', { staffId: r.staffId, mode });
      toast(mode === 'week' ? `${r.name.split(' ')[0]}’s hours are now entered by week` : `${r.name.split(' ')[0]}’s hours are now entered by day`);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  /** Square's hours for the day (plus any added in Users & Permissions) — what counts while the box is empty. */
  const fromSquare = (r: TimesheetRowDTO, d: string) => (r.square[d] ?? 0) + (r.manual[d] ?? 0);
  const [copying, setCopying] = useState(false);
  // Owner/Admin only: send hours entered here to Square as timecards (days without a Square timecard yet).
  const { data: me } = useMe();
  const ownerAdmin = me?.role === 'admin' && canDo('commission:manage');
  const [sending, setSending] = useState<string | null>(null);
  const toSquare = async (body: object, key: string) => {
    setSending(key);
    try {
      const r = await api.post<{ sent: number; failed: string[] }>('/commission/timesheet/to-square', body);
      if (r.sent) toast(`Updated ${r.sent} day${r.sent === 1 ? '' : 's'} in Square.`);
      if (r.failed.length) toast(r.failed.join(' '), 'error');
      else if (!r.sent) toast('Nothing to send — Square already matches the hours entered.');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSending(null);
    }
  };
  /** Days counted twice in Square (overlapping timecards): the latest version of each day is kept. */
  const fixDoubles = async () => {
    if (!window.confirm(`Check ${person ? `${rows[0]?.name.split(' ')[0] ?? 'this person'}’s` : 'everyone’s'} Square timecards for this year so far and remove doubled hours? (This can take a minute.) Days with a time clock shift are re-sent from the shift; otherwise the most recently changed timecard is kept.`)) return;
    setSending('fix');
    try {
      const r = await api.post<{ days: number; removed: number; failed: string[] }>('/timeclock/shifts/fix-doubles', { from: `${today.slice(0, 4)}-01-01`, to: today, ...(person ? { staffId: person } : {}) });
      toast(r.days ? `Fixed ${r.days} doubled day${r.days === 1 ? '' : 's'} in Square.` : 'No doubled hours found in Square this year. Hours were re-read from Square.');
      if (r.failed.length) toast(r.failed.join(' '), 'error');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSending(null);
    }
  };
  // Clear & start over (one person): their hours for the week or the year are deleted, then re-read from Square.
  const [clearFor, setClearFor] = useState<TimesheetRowDTO | null>(null);
  const [clearScope, setClearScope] = useState<'week' | 'year'>('week');
  const clearHours = async () => {
    if (!clearFor) return;
    setSending(`clear${clearFor.staffId}`);
    try {
      const range = clearScope === 'week' ? { from: week, to } : { from: `${today.slice(0, 4)}-01-01`, to: today };
      const r = await api.post<{ removed: number; reloaded: boolean }>('/commission/timesheet/clear', { staffId: clearFor.staffId, ...range });
      toast(r.reloaded ? `${clearFor.name.split(' ')[0]}’s hours were cleared and reloaded from Square.` : `${clearFor.name.split(' ')[0]}’s hours were cleared. Square’s hours couldn’t be read right now — they’ll come back on the next sync.`);
      setClearFor(null);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSending(null);
    }
  };
  const canSend = (r: TimesheetRowDTO, d: string) => ownerAdmin && d <= today && ((r.timesheet[d] ?? 0) > 0 || (!r.square[d] && (r.manual[d] ?? 0) > 0));
  const copyWeek = async () => {
    setCopying(true);
    let n = 0;
    try {
      for (const r of rows.filter((x) => x.mode !== 'week')) for (const d of days) if (r.timesheet[d] == null && fromSquare(r, d) > 0 && d <= today) { await put(r, d, fromSquare(r, d) / 60); n++; }
      toast(n ? `Copied Square hours into ${n} day${n === 1 ? '' : 's'}.` : 'Nothing to copy — every day with Square hours is already filled in.');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setCopying(false);
    }
  };
  const listed = (data ?? []).filter((r) => !onlyHourly || r.payType === 'hourly' || Object.keys(r.square).length || Object.keys(r.manual).length);
  const rows = person ? listed.filter((r) => r.staffId === person) : listed;
  const total = (r: TimesheetRowDTO) => r.pay.minutes;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" icon={<ChevronLeft className="h-4 w-4" />} onClick={() => setWeek(addDaysKey(week, -7))} aria-label="Previous week" />
        <span className="min-w-[200px] text-center text-[14px] font-medium text-ink">{labelOfKey(week, { month: 'short', day: 'numeric' })} – {labelOfKey(to, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
        <Button size="sm" variant="ghost" icon={<ChevronRight className="h-4 w-4" />} onClick={() => setWeek(addDaysKey(week, 7))} aria-label="Next week" />
        {week !== mondayOf(today) && <Button size="sm" variant="ghost" onClick={() => setWeek(mondayOf(today))}>This week</Button>}
        {editable && <Button size="sm" icon={<ArrowDownToLine className="h-4 w-4" />} loading={copying} onClick={copyWeek}>Use Square hours for empty days</Button>}
        {ownerAdmin && <Button size="sm" icon={<ArrowUpFromLine className="h-4 w-4" />} loading={sending === 'week'} onClick={() => toSquare({ from: week, to: to < today ? to : today, ...(person ? { staffId: person } : {}) }, 'week')} title="Updates Square to the hours entered this week (replacing those days’ timecards)">{person ? `Send ${rows[0]?.name.split(' ')[0] ?? ''}’s hours to Square` : 'Send hours to Square'}</Button>}
        {ownerAdmin && <Button size="sm" icon={<RefreshCw className="h-4 w-4" />} loading={sending === 'fix'} onClick={fixDoubles} title="Checks this year’s Square timecards, removes overlapping ones (keeping the latest version of each day) and re-reads everyone’s hours">Fix doubled hours in Square</Button>}
        <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-soft">
          <input type="checkbox" checked={onlyHourly} onChange={(e) => setOnlyHourly(e.target.checked)} />Only hourly staff and anyone with hours
        </label>
      </div>
      {!!clockedIn?.length && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl2 border border-line bg-white px-4 py-2.5 text-[13px]">
          <span className="font-medium text-ink">Clocked in now:</span>
          {clockedIn.map((c) => {
            const br = c.breaks.find((b) => !b.endedAt);
            return <span key={c.id} className="rounded-full bg-mist px-2.5 py-1 text-ink-soft">{c.staffName} · since {new Date(c.clockInAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}{br ? ` · on ${br.kind === 'lunch' ? 'lunch' : 'a break'}` : ''}</span>;
          })}
        </div>
      )}
      {listed.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="People">
          {[{ staffId: null as string | null, name: 'Everyone' }, ...listed].map((p) => (
            <button key={p.staffId ?? 'all'} type="button" role="tab" aria-selected={person === p.staffId}
              className={chipClass(person === p.staffId)}
              onClick={() => setPerson(p.staffId)}>{p.name}</button>
          ))}
        </div>
      )}
      {isLoading && <PageLoading />}
      {data && (
        <div className="overflow-x-auto rounded-xl2 border border-line bg-white">
          <table className="w-full min-w-[900px] text-left text-[14px]">
            <thead className="border-b border-line bg-mist/50 text-[12px] uppercase tracking-wide text-stone">
              <tr>
                <th className="px-4 py-2 font-medium">Person</th>
                {days.map((d) => <th key={d} className={cx('px-2 py-2 text-center font-medium', d === today && 'text-ink')}>{labelOfKey(d, { weekday: 'short' })}<span className="block text-[11px] normal-case">{labelOfKey(d, { month: 'short', day: 'numeric' })}</span></th>)}
                <th className="px-3 py-2 text-right font-medium">Hours</th>
                <th className="px-3 py-2 text-right font-medium">Wages</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.staffId}>
                  <td className="px-4 py-2">
                    <span className="font-medium text-ink">{r.name}</span>
                    <span className="block text-[12px] text-stone">{r.payType === 'hourly' && r.hourlyRateCents != null ? `${usd(r.hourlyRateCents)}/hour` : r.payType === 'salary' ? 'Salary' : 'No wage set'}</span>
                    {editable && (
                      <button type="button" className="mt-0.5 text-[11px] text-plum hover:underline" onClick={() => setMode(r, r.mode === 'week' ? 'day' : 'week')}>
                        {r.mode === 'week' ? 'Enter by day' : 'Enter by week'}
                      </button>
                    )}
                    {ownerAdmin && (
                      <button type="button" className="mt-0.5 block text-[11px] text-rose hover:underline" onClick={() => { setClearScope('week'); setClearFor(r); }}>
                        Clear &amp; start over
                      </button>
                    )}
                    {ownerAdmin && r.mode !== 'week' && days.some((d) => canSend(r, d)) && (
                      <button type="button" className="mt-0.5 block text-[11px] text-plum hover:underline disabled:opacity-50" disabled={!!sending}
                        onClick={() => toSquare({ staffId: r.staffId, from: week, to: to < today ? to : today }, `week${r.staffId}`)}>
                        {sending === `week${r.staffId}` ? 'Sending…' : 'Send week to Square'}
                      </button>
                    )}
                  </td>
                  {r.mode === 'week' ? (
                    <td colSpan={7} className="px-3 py-2 align-middle">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] text-ink-soft">Hours this week</span>
                        <input key={`w-${r.weekTotal ?? 'x'}`} type="number" min={0} max={168} step={0.25} inputMode="decimal" disabled={!editable}
                          defaultValue={r.weekTotal != null ? h(r.weekTotal) : ''} placeholder="–" className="field num h-9 w-24 px-2 text-center" aria-label={`Hours this week for ${r.name}`}
                          onBlur={(e) => saveWeek(r, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
                        {Object.keys(r.square).length > 0 && <span className="text-[12px] text-stone">+ {h(Object.values(r.square).reduce((a, m) => a + m, 0))} from Square timecards</span>}
                        <span className="text-[12px] text-stone">Weekly totals stay in the CRM (Square needs times per day).</span>
                      </div>
                    </td>
                  ) : days.map((d) => (
                    <td key={d} className="px-1.5 py-2 align-top">
                      {/* Square's hours sit above the box (a fixed-height row, so every box lines up). */}
                      <div className="flex flex-col items-center gap-1">
                        <div className="flex h-5 items-center">
                          {fromSquare(r, d) > 0 && (
                            r.timesheet[d] == null && editable && d <= today ? (
                              <button type="button" onClick={() => save(r, d, String(fromSquare(r, d) / 60))} title="Copy Square’s hours into the box"
                                className="inline-flex items-center gap-0.5 whitespace-nowrap rounded-full bg-mist px-2 py-0.5 text-[11px] font-medium text-ink-soft hover:bg-plum/10 hover:text-plum">
                                <ArrowDownToLine className="h-3 w-3" />{h(fromSquare(r, d))} Sq
                              </button>
                            ) : (
                              <span className={cx('whitespace-nowrap text-[11px]', r.timesheet[d] != null ? 'text-stone line-through' : 'text-ink-soft')} title={r.timesheet[d] != null ? 'Square’s hours — replaced by the number in the box' : 'From Square timecards'}>{h(fromSquare(r, d))} Sq</span>
                            )
                          )}
                        </div>
                        <input
                          key={`${d}-${r.timesheet[d] ?? 'x'}`}
                          type="number" min={0} max={24} step={0.25} inputMode="decimal" disabled={!editable || d > today}
                          defaultValue={r.timesheet[d] != null ? h(r.timesheet[d]) : ''} placeholder="–"
                          onBlur={(e) => save(r, d, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                          className={cx('field num h-9 w-16 px-1.5 text-center', r.timesheet[d] != null && 'border-plum/50')} aria-label={`Hours for ${r.name} on ${d}`}
                        />
                        {ownerAdmin && d <= today && (
                          <button type="button" onClick={() => setTimesFor({ staffId: r.staffId, date: d, shift: shiftOn(r.staffId, d) })} title={shiftOn(r.staffId, d) ? 'Edit this day’s times (clock in/out, lunch) — updates Square' : 'Enter this day by times (clock in/out, lunch) — sent to Square'}
                            className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] text-ink-soft hover:bg-mist">
                            <Clock3 className="h-3 w-3" />{shiftOn(r.staffId, d) ? 'Times' : 'Add times'}
                          </button>
                        )}
                        {canSend(r, d) && (
                          <button type="button" disabled={!!sending} onClick={() => toSquare({ staffId: r.staffId, date: d }, `${r.staffId}${d}`)} title="Update this day in Square to the hours entered here"
                            className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] text-plum hover:bg-plum-tint disabled:opacity-50">
                            <ArrowUpFromLine className="h-3 w-3" />{sending === `${r.staffId}${d}` ? '…' : 'Square'}
                          </button>
                        )}
                      </div>
                    </td>
                  ))}
                  <td className="num px-3 py-2 text-right font-medium">{h(total(r))}</td>
                  <td className="num px-3 py-2 text-right" title={r.pay.basis}>{r.payType === 'none' ? <span className="text-stone">—</span> : usd(r.pay.wagesCents)}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={10} className="px-4 py-6 text-center text-stone">Nobody hourly yet. Set someone’s pay to Hourly in Settings → Users &amp; Permissions → Wages &amp; tips.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!clearFor} onClose={() => setClearFor(null)} title={`Clear ${clearFor?.name ?? ''}’s hours`}
        footer={<>
          <Button variant="ghost" onClick={() => setClearFor(null)}>Cancel</Button>
          <Button variant="danger" loading={!!clearFor && sending === `clear${clearFor.staffId}`} onClick={clearHours}>Clear and reload from Square</Button>
        </>}>
        <div className="space-y-3 text-[14px] text-ink-soft">
          <Segmented value={clearScope} onChange={setClearScope} options={[
            { value: 'week', label: `This week (${labelOfKey(week, { month: 'short', day: 'numeric' })} – ${labelOfKey(to, { month: 'short', day: 'numeric' })})` },
            { value: 'year', label: `This year so far (${today.slice(0, 4)})` },
          ]} />
          <p>Every hour saved here for {clearFor?.name.split(' ')[0]} in these dates is deleted: hours typed into the boxes, weekly totals, hours added by hand, time clock hours kept only here, and the saved copies of Square’s timecards.</p>
          <p>Then their hours are read fresh from Square’s timecards, so each day counts once. Nothing is deleted in Square, and time clock shifts stay in the list.</p>
        </div>
      </Modal>
      {timesFor && <ShiftModal shift={timesFor.shift} staffId={timesFor.staffId} date={timesFor.date} onClose={() => setTimesFor(null)} onSaved={refresh} />}
      <section className="mt-6">
        <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone">Time clock shifts this week</h3>
        <ShiftsList from={week} to={to} staffId={person ?? undefined} />
      </section>
      {ownerAdmin && <p className="mt-2 text-[12px] text-stone">Owner/Admin: hours you type into a day update Square right away — that day’s Square timecards are replaced by one timecard of those hours (starting when they first clocked in that day, or their scheduled start), under their assigned job. “Send hours to Square” / “Send week to Square” does the same for every day this week with hours entered.</p>}
      <p className="mt-2 text-[12px] text-stone">A number in a box is that day’s hours for pay (e.g. 7.5), saved when you leave the box. While a box is empty, the Square timecard hours under it count. Tap “Sq” to copy Square’s hours into the box and adjust them; clear the box to go back to Square’s. Future days can’t be filled in.</p>
    </div>
  );
}
