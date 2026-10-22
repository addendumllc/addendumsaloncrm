import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClockShiftDTO } from '@addendum/shared';
import { ChevronRight, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import { useCanDo, useMe, useStaff } from '../../api/hooks';
import { Badge, Button, Field, Modal, Spinner, cx, useToast } from '../ui';

const pad = (n: number) => String(n).padStart(2, '0');
const dateOf = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const timeOf = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const join = (date: string, time: string) => (time ? new Date(`${date}T${time}`).toISOString() : null);
const t = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const hm = (m: number) => `${Math.floor(m / 60)}h ${pad(m % 60)}m`;

/**
 * Time clock shifts for a date range (one person, or everyone): clock-in/out, lunch and breaks, paid time and whether
 * it's in Square. Owners/Admins can edit, add a forgotten shift, re-send to Square or delete — Square follows each change.
 */
export function ShiftsList({ from, to, staffId }: { from: string; to: string; staffId?: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const canDo = useCanDo();
  const { data: me } = useMe();
  const ownerAdmin = me?.role === 'admin' && canDo('commission:manage');
  const { data, isLoading } = useQuery({
    queryKey: ['shifts', from, to, staffId ?? 'all'],
    queryFn: () => api.get<{ shifts: ClockShiftDTO[] }>(`/timeclock/shifts?from=${from}&to=${to}${staffId ? `&staffId=${staffId}` : ''}`).then((r) => r.shifts),
  });
  const [editing, setEditing] = useState<ClockShiftDTO | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => { for (const k of ['shifts', 'timesheet', 'staff-pay', 'timeclock', 'timeclock-now', 'commission-team', 'commission-staff']) qc.invalidateQueries({ queryKey: [k] }); };
  const act = async (key: string, p: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try {
      await p();
      toast(msg);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  if (isLoading) return <div className="flex justify-center py-4"><Spinner /></div>;
  const shifts = data ?? [];
  return (
    <div>
      {shifts.length === 0 ? <p className="text-[14px] text-stone">No time clock shifts in these dates.</p> : (
        <ul className="divide-y divide-line rounded-xl2 border border-line bg-white">
          {shifts.map((s) => {
            const lunch = s.breaks.filter((b) => !b.paid);
            const rest = s.breaks.filter((b) => b.paid);
            const isOpen = open === s.id;
            const status = s.squareLive ? <Badge tone="sage">On Square now</Badge>
              : s.usesSquareHours ? <span title={s.squareError ?? ''}><Badge>Using Square’s hours</Badge></span>
              : s.squareRemoved ? <Badge tone="amber">Removed in Square</Badge>
              : s.squareSent ? <Badge tone="sage">In Square</Badge>
              : s.clockOutAt ? <Badge tone="amber">Saved here only</Badge> : null;
            return (
              <li key={s.id} className="text-[13px]">
                {/* One line: date, who, in–out, hours and status. Lunch, breaks and any Square message open on click. */}
                <div className="flex items-center gap-3 px-4 py-2.5">
                  <button type="button" onClick={() => setOpen(isOpen ? null : s.id)} aria-expanded={isOpen}
                    className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 text-left">
                    <ChevronRight className={cx('h-3.5 w-3.5 shrink-0 text-stone transition-transform', isOpen && 'rotate-90')} />
                    <span className="w-24 font-medium text-ink">{new Date(s.clockInAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                    {!staffId && <span className="w-36 truncate text-ink">{s.staffName}</span>}
                    <span className="text-ink-soft">{t(s.clockInAt)} – {s.clockOutAt ? t(s.clockOutAt) : 'clocked in'}</span>
                  </button>
                  <span className="num w-16 text-right font-medium text-ink">{hm(s.paidMinutes)}</span>
                  <span className="hidden w-36 justify-end sm:flex">{status}</span>
                  {ownerAdmin && (
                    <span className="flex shrink-0">
                      <button type="button" className="rounded-md p-1.5 text-stone hover:bg-mist hover:text-ink" aria-label="Edit shift" title="Edit" onClick={() => setEditing(s)}><Pencil className="h-3.5 w-3.5" /></button>
                      {/* Sending (again) makes this shift the day's only record in Square: that day's other timecards are replaced. */}
                      {s.clockOutAt && !s.squareLive && (
                        <button type="button" className="rounded-md p-1.5 text-stone hover:bg-mist hover:text-ink disabled:opacity-40" aria-label="Send to Square" title="Send to Square — replaces Square’s timecards for this person that day" disabled={busy === `sq${s.id}`}
                          onClick={() => act(`sq${s.id}`, () => api.post(`/timeclock/shifts/${s.id}/square`), 'Sent to Square')}><RefreshCw className={cx('h-3.5 w-3.5', busy === `sq${s.id}` && 'animate-spin')} /></button>
                      )}
                      <button type="button" className="rounded-md p-1.5 text-stone hover:bg-mist hover:text-rose disabled:opacity-40" aria-label="Delete shift" title="Delete" disabled={busy === `del${s.id}`}
                        onClick={() => { if (window.confirm('Delete this shift? Its hours and its Square timecards are removed too.')) void act(`del${s.id}`, () => api.del(`/timeclock/shifts/${s.id}`), 'Shift deleted (and removed from Square)'); }}><Trash2 className="h-3.5 w-3.5" /></button>
                    </span>
                  )}
                </div>
                {isOpen && (
                  <div className="space-y-1 border-t border-line bg-mist/30 px-10 py-2.5 text-[13px] text-ink-soft">
                    <p className="sm:hidden">{status}</p>
                    <p>Lunch (unpaid): {lunch.length ? lunch.map((b) => `${t(b.startedAt)}${b.endedAt ? ` – ${t(b.endedAt)}` : ' (on lunch now)'}`).join(', ') : 'none'}</p>
                    <p>Paid breaks: {rest.length ? rest.map((b) => `${t(b.startedAt)}${b.endedAt ? ` – ${t(b.endedAt)}` : ' (now)'}`).join(', ') : 'none'}</p>
                    {s.squareError && <p className="text-amber">{s.squareError}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {ownerAdmin && <Button size="sm" variant="ghost" className="mt-2" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>Add a shift</Button>}
      {editing && <ShiftModal shift={editing === 'new' ? null : editing} staffId={staffId} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}

/** Add or edit a shift by its times (clock in/out, lunch). `date` starts a new one on that day. Saving updates Payroll hours and Square. */
export function ShiftModal({ shift, staffId, date, onClose, onSaved }: { shift: ClockShiftDTO | null; staffId?: string; date?: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { data: staff } = useStaff(!staffId && !shift);
  const lunch = shift?.breaks.find((b) => b.kind === 'lunch');
  const rests = shift?.breaks.filter((b) => b.kind === 'rest') ?? [];
  const today = dateOf(new Date().toISOString());
  const [f, setF] = useState({
    who: staffId ?? shift?.staffId ?? '',
    date: shift ? dateOf(shift.clockInAt) : date ?? today,
    in: shift ? timeOf(shift.clockInAt) : '09:00',
    out: shift?.clockOutAt ? timeOf(shift.clockOutAt) : shift ? '' : '17:30',
    lunchStart: lunch ? timeOf(lunch.startedAt) : shift ? '' : '12:30',
    lunchEnd: lunch ? timeOf(lunch.endedAt) : shift ? '' : '13:00',
  });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      // Times are on the shift's date; a clock-out before clock-in means after midnight.
      const inAt = join(f.date, f.in)!;
      let outAt = join(f.date, f.out);
      if (outAt && outAt <= inAt) outAt = new Date(new Date(outAt).getTime() + 86400_000).toISOString();
      const breaks = [
        ...(f.lunchStart ? [{ kind: 'lunch' as const, startedAt: join(f.date, f.lunchStart)!, endedAt: join(f.date, f.lunchEnd) }] : []),
        // Paid breaks are kept as they were (they don't change the hours).
        ...rests.map((b) => ({ kind: 'rest' as const, startedAt: b.startedAt, endedAt: b.endedAt, plannedMinutes: b.plannedMinutes })),
      ];
      const body = { clockInAt: inAt, clockOutAt: outAt, breaks };
      if (shift) await api.put(`/timeclock/shifts/${shift.id}`, body);
      else await api.post('/timeclock/shifts', { ...body, staffId: f.who });
      toast(shift ? 'Shift updated — Payroll hours and Square updated to match' : 'Shift added — sent to Payroll hours and Square');
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const box = 'field h-10';
  return (
    <Modal open onClose={onClose} title={shift ? `Edit shift — ${shift.staffName ?? ''}` : 'Add a shift'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} disabled={!f.who || !f.in || (!shift && !f.out)} onClick={save}>{shift ? 'Save & update Square' : 'Add & send to Square'}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {!staffId && !shift && (
          <Field label="Who" className="sm:col-span-2">
            <select className="field" value={f.who} onChange={(e) => setF({ ...f, who: e.target.value })}>
              <option value="">Choose…</option>{staff?.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Date" className="sm:col-span-2"><input type="date" className={box} max={today} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Clock in"><input type="time" className={box} value={f.in} onChange={(e) => setF({ ...f, in: e.target.value })} /></Field>
        <Field label="Clock out" hint={shift && !shift.clockOutAt ? 'Leave empty while they’re still clocked in.' : undefined}><input type="time" className={box} value={f.out} onChange={(e) => setF({ ...f, out: e.target.value })} /></Field>
        <Field label="Lunch start (unpaid)" hint="Leave empty if no lunch."><input type="time" className={box} value={f.lunchStart} onChange={(e) => setF({ ...f, lunchStart: e.target.value })} /></Field>
        <Field label="Lunch end"><input type="time" className={box} value={f.lunchEnd} onChange={(e) => setF({ ...f, lunchEnd: e.target.value })} /></Field>
      </div>
      <p className="mt-3 text-[12px] text-stone">Saving replaces this shift’s timecards in Square (one before and one after an unpaid lunch), filed under their assigned job, and updates Payroll hours. Paid breaks don’t change the hours.</p>
    </Modal>
  );
}
