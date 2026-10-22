import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClientServiceScheduleDTO, RebookingStatus } from '@addendum/shared';
import { CalendarClock, Plus, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { api } from '../../api/client';
import { useCanDo, useRefreshAll } from '../../api/hooks';
import { labelOfKey } from '../../lib/format';
import { Badge, Button, EmptyState, Field, Modal, Spinner, Toggle, cx, useToast } from '../ui';

/** Shared pieces for per-service, per-client rebooking schedules (client profile, follow-ups, settings). */

export const STATUS_LABEL: Record<RebookingStatus, string> = {
  overdue: 'Overdue', due_soon: 'Due soon', upcoming: 'Upcoming', booked: 'Booked', off: 'Follow-ups off', not_needed: 'No follow-up needed', lapsed: 'Not seen in over a year', no_interval: 'No interval set', no_visit: 'No visit yet',
};
export const STATUS_TONE: Record<RebookingStatus, 'rose' | 'amber' | 'sage' | 'plum' | 'neutral'> = {
  overdue: 'rose', due_soon: 'amber', upcoming: 'neutral', booked: 'sage', off: 'neutral', not_needed: 'neutral', lapsed: 'neutral', no_interval: 'neutral', no_visit: 'neutral',
};

export const dayLabel = (key: string | null | undefined, withYear = false) =>
  key ? labelOfKey(key, withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' }) : '—';
export const weeksLabel = (d: number | null | undefined) => (d == null ? '—' : d % 7 === 0 ? `${d / 7} week${d === 7 ? '' : 's'}` : `${d} days`);

/** "Custom" vs "Default" marker so staff can see where each number comes from. */
export function SourceTag({ source }: { source: string | null }) {
  if (source === 'client' || source === 'preferred' || source === 'manual') return <Badge tone="plum">Custom</Badge>;
  if (source === 'service') return <Badge>Service default</Badge>;
  if (source === 'history') return <Badge>From visit history</Badge>;
  if (source === 'default' || source === 'square') return <Badge>Default</Badge>;
  return null;
}

export function useClientSchedules(clientId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['rebooking', clientId],
    queryFn: () => api.get<{ schedules: ClientServiceScheduleDTO[]; services: { id: string; name: string }[] }>(`/rebooking/clients/${clientId}`),
    enabled: !!clientId && enabled,
  });
}

/** Client profile → "Rebooking schedule": one row per service, with what's due and where the numbers come from. */
export function RebookingSchedulePanel({ clientId, firstName }: { clientId: string; firstName: string }) {
  const canDo = useCanDo();
  const { data, isLoading } = useClientSchedules(clientId);
  const [editing, setEditing] = useState<{ serviceId: string | null } | null>(null);
  const canEdit = canDo('rebooking:client');
  if (isLoading) return <div className="flex justify-center py-6"><Spinner /></div>;
  const rows = data?.schedules ?? [];
  return (
    <div>
      {rows.length === 0 ? (
        <div className="rounded-xl2 border border-line bg-white">
          <EmptyState icon={<CalendarClock className="h-8 w-8" />} title="No rebooking schedule yet">
            Schedules appear after a completed Square visit for a service{canEdit ? ', or add one now.' : '.'}
          </EmptyState>
        </div>
      ) : (
        <div className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-white">
          {rows.map((s) => (
            <div key={s.serviceId} className="flex flex-wrap items-start gap-3 px-4 py-3.5 sm:px-5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-ink">{s.serviceName}</p>
                  <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                  {s.override && <Badge tone="plum">Custom for {firstName}</Badge>}
                </div>
                <dl className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-x-4 gap-y-1 text-[13px] [&_dt]:whitespace-nowrap">
                  <div><dt className="text-stone">Last visit</dt><dd className="text-ink-soft">{dayLabel(s.lastVisitDate, true)}{s.lastVisitSource === 'manual' && ' (entered)'}</dd></div>
                  <div><dt className="text-stone">Every</dt><dd className="flex flex-wrap items-center gap-1 text-ink-soft">{weeksLabel(s.intervalDays)}</dd></div>
                  <div><dt className="text-stone">{s.status === 'booked' ? 'Booked for' : 'Recommended'}</dt><dd className="font-medium text-ink">{s.status === 'booked' ? dayLabel(s.nextBookedDate) : dayLabel(s.nextDate)}</dd></div>
                  <div><dt className="text-stone">Follow-up</dt><dd className="text-ink-soft">{!s.followUpsEnabled ? 'Off' : s.reminderDate ? dayLabel(s.reminderDate) : '—'}</dd></div>
                </dl>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-stone">
                  <span>Interval:</span><SourceTag source={s.intervalSource} />
                  {s.nextDateSource === 'preferred' && <><span>· Date:</span><Badge tone="plum">Preferred date</Badge></>}
                  {s.windowStart && s.windowEnd && <span>· Window {dayLabel(s.windowStart)}–{dayLabel(s.windowEnd)}</span>}
                  {s.otherBookingDate && s.status !== 'booked' && <span>· Has another visit {dayLabel(s.otherBookingDate)}: consider adding this service</span>}
                </div>
                {canEdit && (
                  <button type="button" onClick={() => setEditing({ serviceId: s.serviceId })}
                    className="mt-2 inline-flex items-center gap-1 rounded-md text-[12px] font-medium text-plum hover:underline">
                    <SlidersHorizontal className="h-3.5 w-3.5" />Adjust rebooking schedule
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {canEdit && (
        <button onClick={() => setEditing({ serviceId: null })} className="mt-2 inline-flex items-center gap-1 text-sm text-plum hover:underline"><Plus className="h-4 w-4" />Add a schedule for another service</button>
      )}
      {editing && data && (
        <ScheduleEditor clientId={clientId} firstName={firstName} schedules={rows} services={data.services} serviceId={editing.serviceId} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

/** Edits one client's custom schedule for one service. Blank fields use the service default. */
export function ScheduleEditor({ clientId, firstName, schedules, services, serviceId, onClose }: {
  clientId: string; firstName: string; schedules: ClientServiceScheduleDTO[]; services: { id: string; name: string }[]; serviceId: string | null; onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = useRefreshAll();
  const [svc, setSvc] = useState(serviceId ?? '');
  const current = schedules.find((s) => s.serviceId === svc);
  const o = current?.override;
  const initUnit: 'weeks' | 'days' = o?.intervalDays && o.intervalDays % 7 !== 0 ? 'days' : 'weeks';
  const [unit, setUnit] = useState<'weeks' | 'days'>(initUnit);
  const [interval, setIntervalValue] = useState<string>(o?.intervalDays ? String(initUnit === 'weeks' ? o.intervalDays / 7 : o.intervalDays) : '');
  const [preferred, setPreferred] = useState(o?.preferredNextDate ?? '');
  const [lastVisit, setLastVisit] = useState(o?.lastVisitDate ?? '');
  const [remind, setRemind] = useState<string>(o?.remindBeforeDays != null ? String(o.remindBeforeDays) : '');
  const [follow, setFollow] = useState<'default' | 'on' | 'off'>(o?.followUpsEnabled == null ? 'default' : o.followUpsEnabled ? 'on' : 'off');
  const [note, setNote] = useState(o?.note ?? '');
  const [saving, setSaving] = useState(false);
  const def = current?.serviceDefault;

  const pickService = (id: string) => {
    setSvc(id);
    const x = schedules.find((s) => s.serviceId === id)?.override;
    const u: 'weeks' | 'days' = x?.intervalDays && x.intervalDays % 7 !== 0 ? 'days' : 'weeks';
    setUnit(u);
    setIntervalValue(x?.intervalDays ? String(u === 'weeks' ? x.intervalDays / 7 : x.intervalDays) : '');
    setPreferred(x?.preferredNextDate ?? '');
    setLastVisit(x?.lastVisitDate ?? '');
    setRemind(x?.remindBeforeDays != null ? String(x.remindBeforeDays) : '');
    setFollow(x?.followUpsEnabled == null ? 'default' : x.followUpsEnabled ? 'on' : 'off');
    setNote(x?.note ?? '');
  };

  const done = async (p: Promise<unknown>, msg: string) => {
    setSaving(true);
    try {
      await p;
      toast(msg);
      qc.invalidateQueries({ queryKey: ['rebooking'] });
      qc.invalidateQueries({ queryKey: ['rebooking-schedule'] });
      refresh();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const days = interval ? Math.round(Number(interval) * (unit === 'weeks' ? 7 : 1)) : null;
  const save = () => {
    if (!svc) return toast('Choose a service', 'error');
    void done(api.put(`/rebooking/clients/${clientId}/services/${svc}`, {
      intervalDays: days, preferredNextDate: preferred || null, lastVisitDate: lastVisit || null,
      remindBeforeDays: remind === '' ? null : Number(remind), followUpsEnabled: follow === 'default' ? null : follow === 'on', note: note || null,
    }), `Saved ${firstName}’s schedule`);
  };
  const reset = () => void done(api.del(`/rebooking/clients/${clientId}/services/${svc}`), 'Back to the service defaults');

  return (
    <Modal open onClose={onClose} title={`${firstName}’s rebooking schedule`} footer={
      <>
        {o && <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={reset} loading={saving} className="mr-auto">Use defaults</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} loading={saving}>Save</Button>
      </>
    }>
      <div className="space-y-4">
        <Field label="Service">
          <select className="field" value={svc} onChange={(e) => pickService(e.target.value)} disabled={!!serviceId}>
            <option value="">Choose a service…</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        {svc && (
          <p className="rounded-lg bg-mist/70 px-3 py-2 text-[13px] text-ink-soft">
            {def
              ? <>Service default: every <b>{weeksLabel(def.targetDays)}</b>{def.minDays && def.maxDays ? ` (window ${weeksLabel(def.minDays)}–${weeksLabel(def.maxDays)})` : ''}, follow-up {def.remindBeforeDays} days before, follow-ups {def.autoFollowUp ? 'on' : 'off'}.</>
              : current?.historyIntervalDays ? <>No service default. {firstName}’s visit history suggests every <b>{weeksLabel(current.historyIntervalDays)}</b>.</>
                : <>No service default yet — set {firstName}’s own interval below (or add a default in Settings → Rebooking).</>}
            {' '}Changes here only affect {firstName}.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`${firstName}’s interval`} hint="Leave blank to use the default.">
            <div className="flex gap-2">
              <input type="number" min={1} max={unit === 'weeks' ? 104 : 730} className="field num w-24" placeholder={def ? String(unit === 'weeks' ? +(def.targetDays / 7).toFixed(1) : def.targetDays) : ''} value={interval} onChange={(e) => setIntervalValue(e.target.value)} />
              <select className="field w-auto" value={unit} onChange={(e) => setUnit(e.target.value as any)}><option value="weeks">weeks</option><option value="days">days</option></select>
            </div>
          </Field>
          <Field label="Preferred next date" hint="Overrides the calculated date until their next visit.">
            <input type="date" className="field" value={preferred} onChange={(e) => setPreferred(e.target.value)} />
          </Field>
          <Field label="Follow-up how many days before" hint="Leave blank to use the default.">
            <input type="number" min={0} max={120} className="field num w-24" placeholder={def ? String(def.remindBeforeDays) : '7'} value={remind} onChange={(e) => setRemind(e.target.value)} />
          </Field>
          <Field label="Last visit (if not in Square)" hint="Used when it’s newer than Square’s last visit.">
            <input type="date" className="field" value={lastVisit} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setLastVisit(e.target.value)} />
          </Field>
        </div>
        <Field label="Automatic follow-ups">
          <select className="field" value={follow} onChange={(e) => setFollow(e.target.value as any)}>
            <option value="default">Use the service default{def ? ` (${def.autoFollowUp ? 'on' : 'off'})` : ''}</option>
            <option value="on">On for {firstName}</option>
            <option value="off">Off for {firstName}</option>
          </select>
        </Field>
        <Field label="Note (optional)"><input className="field" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Prefers to come in every 9 weeks in winter" /></Field>
        {current?.suggestedNextDate && (
          <p className="text-[13px] text-stone">Currently: last visit {dayLabel(current.lastVisitDate, true)} → recommended {dayLabel(current.nextDate, true)}.</p>
        )}
      </div>
    </Modal>
  );
}

/** Settings → Rebooking: default schedule for each service. */
export function ServiceRulesEditor() {
  const canDo = useCanDo();
  const toast = useToast();
  const qc = useQueryClient();
  const editable = canDo('rebooking:defaults');
  const { data, isLoading } = useQuery({
    queryKey: ['rebooking-services'],
    queryFn: () => api.get<{ services: { serviceId: string; serviceName: string; notNeeded: boolean; rule: { minDays: number | null; maxDays: number | null; targetDays: number; remindBeforeDays: number; autoFollowUp: boolean } | null }[] }>('/rebooking/services'),
  });
  const [edit, setEdit] = useState<string | null>(null);
  const [draft, setDraft] = useState({ min: '', max: '', target: '', remind: '7', auto: true });
  const [saving, setSaving] = useState(false);
  const start = (s: NonNullable<typeof data>['services'][number]) => {
    setEdit(s.serviceId);
    const w = (d: number | null | undefined) => (d == null ? '' : String(+(d / 7).toFixed(1)));
    setDraft({ min: w(s.rule?.minDays), max: w(s.rule?.maxDays), target: w(s.rule?.targetDays), remind: String(s.rule?.remindBeforeDays ?? 7), auto: s.rule?.autoFollowUp ?? true });
  };
  const toDays = (w: string) => (w === '' ? null : Math.round(Number(w) * 7));
  const save = async (serviceId: string) => {
    setSaving(true);
    try {
      await api.put(`/rebooking/services/${serviceId}`, { minDays: toDays(draft.min), maxDays: toDays(draft.max), targetDays: toDays(draft.target), remindBeforeDays: Number(draft.remind), autoFollowUp: draft.auto });
      toast('Saved. Follow-ups were updated to match.');
      qc.invalidateQueries({ queryKey: ['rebooking-services'] });
      qc.invalidateQueries({ queryKey: ['rebooking'] });
      setEdit(null);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const setNotNeeded = async (serviceId: string, notNeeded: boolean) => {
    try {
      await api.put(`/rebooking/services/${serviceId}/not-needed`, { notNeeded });
      toast(notNeeded ? 'Marked “No follow-up needed”. It still shows on clients’ visits; open follow-ups for it were closed.' : 'Follow-ups are back on for this service.');
      qc.invalidateQueries({ queryKey: ['rebooking-services'] });
      qc.invalidateQueries({ queryKey: ['rebooking'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async (serviceId: string) => {
    try {
      await api.del(`/rebooking/services/${serviceId}`);
      toast('Default removed — this service falls back to each client’s visit history.');
      qc.invalidateQueries({ queryKey: ['rebooking-services'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  if (isLoading) return <div className="flex justify-center py-6"><Spinner /></div>;
  return (
    <div className="divide-y divide-line">
      {(data?.services ?? []).map((s) => (
        <div key={s.serviceId} className="py-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 font-medium text-ink">{s.serviceName}</p>
            {s.notNeeded
              ? <span className="text-[13px] text-ink-soft">No follow-up needed — still shows on clients’ visits for notes</span>
              : s.rule
              ? <span className="text-[13px] text-ink-soft">Every {weeksLabel(s.rule.targetDays)}{s.rule.minDays && s.rule.maxDays ? ` (${weeksLabel(s.rule.minDays)}–${weeksLabel(s.rule.maxDays)})` : ''} · follow-up {s.rule.remindBeforeDays}d before · {s.rule.autoFollowUp ? 'auto follow-ups on' : 'auto follow-ups off'}</span>
              : <span className="text-[13px] text-stone">No default — uses each client’s visit history</span>}
            {editable && edit !== s.serviceId && !s.notNeeded && <Button size="sm" variant="ghost" onClick={() => start(s)}>{s.rule ? 'Edit' : 'Set default'}</Button>}
            {editable && edit !== s.serviceId && (
              <Button size="sm" variant="ghost" className={s.notNeeded ? 'text-plum' : 'text-stone'} onClick={() => setNotNeeded(s.serviceId, !s.notNeeded)}>
                {s.notNeeded ? 'Needs follow-up' : 'No follow-up needed'}
              </Button>
            )}
          </div>
          {edit === s.serviceId && (
            <div className="mt-3 rounded-xl border border-line bg-mist/40 p-3">
              <div className="grid gap-3 sm:grid-cols-5">
                <Field label="Earliest (weeks)"><input type="number" min={0} step="0.5" className="field num" value={draft.min} onChange={(e) => setDraft({ ...draft, min: e.target.value })} placeholder="—" /></Field>
                <Field label="Preferred (weeks)"><input type="number" min={0.5} step="0.5" className="field num" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} /></Field>
                <Field label="Latest (weeks)"><input type="number" min={0} step="0.5" className="field num" value={draft.max} onChange={(e) => setDraft({ ...draft, max: e.target.value })} placeholder="—" /></Field>
                <Field label="Follow-up (days before)"><input type="number" min={0} max={120} className="field num" value={draft.remind} onChange={(e) => setDraft({ ...draft, remind: e.target.value })} /></Field>
                <div className="flex items-end pb-1"><Toggle checked={draft.auto} onChange={(v) => setDraft({ ...draft, auto: v })} label="Auto follow-ups" /></div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="primary" loading={saving} onClick={() => save(s.serviceId)}>Save default</Button>
                <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
                {s.rule && <Button size="sm" variant="ghost" className="ml-auto text-rose" onClick={() => remove(s.serviceId)}>Remove default</Button>}
              </div>
              <p className="mt-2 text-[12px] text-stone">Changing a default updates everyone who uses it. Clients with their own schedule keep theirs.</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Follow-Ups → "Rebooking schedule": everyone's upcoming recommended dates. */
export function RebookingScheduleList() {
  const [status, setStatus] = useState<'attention' | 'overdue' | 'due_soon' | 'upcoming' | 'booked' | 'off' | 'not_needed' | 'all'>('attention');
  const { data, isLoading } = useQuery({
    queryKey: ['rebooking-schedule', status],
    queryFn: () => api.get<{ rows: (ClientServiceScheduleDTO & { clientId: string; clientName: string })[] }>(`/rebooking/schedule?status=${status}&days=30`),
  });
  const [edit, setEdit] = useState<{ clientId: string; name: string; serviceId: string } | null>(null);
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {([['attention', 'Due in the next 30 days'], ['overdue', 'Overdue'], ['due_soon', 'Due soon'], ['upcoming', 'Upcoming'], ['booked', 'Booked'], ['off', 'Follow-ups off'], ['not_needed', 'No follow-up needed'], ['all', 'All']] as const).map(([v, l]) => (
          <button key={v} onClick={() => setStatus(v)} className={cx('rounded-full px-3 py-1.5 text-[13px] font-medium', status === v ? 'bg-plum text-white' : 'bg-mist text-ink-soft')}>{l}</button>
        ))}
      </div>
      {isLoading ? <div className="flex justify-center py-8"><Spinner /></div> : !data?.rows.length ? (
        <div className="panel"><EmptyState icon={<CalendarClock className="h-9 w-9" />} title="Nothing here">No client schedules match this view.</EmptyState></div>
      ) : (
        <div className="overflow-hidden rounded-xl2 border border-line bg-white">
          <table className="w-full text-left text-[14px]">
            <thead className="hidden border-b border-line bg-mist/50 text-[12px] uppercase tracking-wide text-stone sm:table-header-group">
              <tr><th className="px-4 py-2 font-medium">Client</th><th className="px-4 py-2 font-medium">Service</th><th className="px-4 py-2 font-medium">Last visit</th><th className="px-4 py-2 font-medium">Recommended</th><th className="px-4 py-2 font-medium">Status</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.rows.map((r) => (
                <tr key={`${r.clientId}-${r.serviceId}`} className="flex flex-wrap items-center gap-x-3 px-4 py-3 sm:table-row sm:px-0 sm:py-0">
                  <td className="w-full font-medium sm:w-auto sm:px-4 sm:py-2.5"><a href={`/clients/${r.clientId}`} className="hover:text-plum">{r.clientName}</a></td>
                  <td className="sm:px-4 sm:py-2.5">{r.serviceName} <span className="text-[12px] text-stone">· {weeksLabel(r.intervalDays)}</span> {r.override && <Badge tone="plum">Custom</Badge>}</td>
                  <td className="text-stone sm:px-4 sm:py-2.5">{dayLabel(r.lastVisitDate)}</td>
                  <td className="font-medium sm:px-4 sm:py-2.5">{r.status === 'booked' ? dayLabel(r.nextBookedDate) : dayLabel(r.nextDate)}</td>
                  <td className="sm:px-4 sm:py-2.5"><Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge></td>
                  <td className="ml-auto sm:px-4 sm:py-2.5 sm:text-right"><Button size="sm" variant="ghost" onClick={() => setEdit({ clientId: r.clientId, name: r.clientName.split(' ')[0], serviceId: r.serviceId })}>Adjust</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <ScheduleEditorLoader {...edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** Opens the editor for a client + service, loading that client's schedules first. */
export function ScheduleEditorLoader({ clientId, name, serviceId, onClose }: { clientId: string; name: string; serviceId: string; onClose: () => void }) {
  const canDo = useCanDo();
  const { data } = useClientSchedules(clientId);
  if (!canDo('rebooking:client')) return null;
  if (!data) return <Modal open onClose={onClose} title="Loading…"><div className="flex justify-center py-6"><Spinner /></div></Modal>;
  return <ScheduleEditor clientId={clientId} firstName={name} schedules={data.schedules} services={data.services} serviceId={serviceId} onClose={onClose} />;
}
