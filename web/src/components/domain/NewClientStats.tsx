import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { REBOOK_STATUS_LABEL, type NewClientApptDTO, type NewClientRowDTO, type NewClientStatsDTO, type RebookStatus } from '@addendum/shared';
import { Search, UserPlus } from 'lucide-react';
import { api } from '../../api/client';
import { dateShort, time } from '../../lib/format';
import { Badge, EmptyState, ErrorNote, SectionTitle, Spinner, cx } from '../ui';
import { DateRangeBar, useDateRange } from './Commission';

/**
 * Owner/admin view of new-client acquisition and rebooking. Every count comes from the server, worked out from
 * Square appointments (see server/src/domain/newClients.ts for the counting rules).
 */
type Filter = 'all' | 'rebooked' | RebookStatus;
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All new clients' }, { value: 'rebooked', label: 'Rebooked' }, { value: 'future', label: 'Booked ahead' },
  { value: 'returned', label: 'Came back' }, { value: 'not_rebooked', label: 'Not rebooked' },
];
const STATUS_TONE: Record<RebookStatus, 'sage' | 'plum' | 'neutral'> = { future: 'sage', returned: 'plum', not_rebooked: 'neutral' };
const matches = (f: Filter, c: NewClientRowDTO) => f === 'all' || (f === 'rebooked' ? c.rebookStatus !== 'not_rebooked' : c.rebookStatus === f);

export function NewClientStats() {
  const dr = useDateRange('this_month');
  const [staffId, setStaffId] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['new-clients', dr.range, staffId],
    queryFn: () => api.get<NewClientStatsDTO>(`/analytics/new-clients?from=${dr.range.from}&to=${dr.range.to}${staffId ? `&staffId=${staffId}` : ''}`),
    enabled: !!dr.range.from && !!dr.range.to,
    refetchInterval: 60_000,
  });

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.clients ?? []).filter((c) => matches(filter, c) && (!needle
      || c.clientName.toLowerCase().includes(needle) || (c.first.staffName ?? '').toLowerCase().includes(needle) || (c.next?.staffName ?? '').toLowerCase().includes(needle)));
  }, [data, filter, q]);

  const drill = (f: Filter) => {
    setFilter(f);
    listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const s = data?.summary;
  const stylists = data?.byStylist.filter((b) => b.staffId) ?? [];

  return (
    <section className="mt-12">
      <SectionTitle>New clients & rebooking</SectionTitle>
      <DateRangeBar {...dr} />
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
      {data && s && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="New clients booked" value={s.newClients} active={filter === 'all'} onClick={() => drill('all')}
              sub={`First visit in these dates · ${s.returningClients} existing client${s.returningClients === 1 ? '' : 's'} also came in`} />
            <Stat label="New clients who rebooked" value={s.rebooked} active={filter === 'rebooked'} onClick={() => drill('rebooked')}
              sub={`${s.rebookedAppointments} later appointment${s.rebookedAppointments === 1 ? '' : 's'}`} />
            <Stat label="New clients booked ahead" value={s.withFuture} active={filter === 'future'} onClick={() => drill('future')}
              sub={`${s.futureAppointments} confirmed upcoming appointment${s.futureAppointments === 1 ? '' : 's'}`} />
          </div>

          {!staffId && stylists.length > 0 && (
            <div className="mt-5 overflow-x-auto rounded-xl2 border border-line bg-white">
              <table className="w-full min-w-[480px] text-left text-[14px]">
                <thead className="border-b border-line bg-mist/50 text-[12px] uppercase tracking-wide text-stone">
                  <tr><th className="px-4 py-2 font-medium">Stylist</th><th className="px-3 py-2 text-right font-medium">New clients</th><th className="px-3 py-2 text-right font-medium">Rebooked</th><th className="px-3 py-2 text-right font-medium">Booked ahead</th><th className="px-3 py-2 text-right font-medium">Rebook rate</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {stylists.map((b) => (
                    <tr key={b.staffId} className="cursor-pointer hover:bg-mist/30" onClick={() => setStaffId(b.staffId!)}>
                      <td className="px-4 py-2.5 font-medium text-ink">{b.staffName}</td>
                      <td className="num px-3 py-2.5 text-right">{b.newClients}</td>
                      <td className="num px-3 py-2.5 text-right">{b.rebooked}</td>
                      <td className="num px-3 py-2.5 text-right">{b.withFuture}</td>
                      <td className="num px-3 py-2.5 text-right text-stone">{b.newClients ? `${Math.round((b.rebooked / b.newClients) * 100)}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div ref={listRef} className="mt-5 flex scroll-mt-4 flex-wrap items-center gap-2">
            <label className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
              <input className="field h-9 pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client or stylist" aria-label="Search client or stylist" />
            </label>
            <select className="field h-9 w-auto py-1 text-sm" value={staffId} onChange={(e) => setStaffId(e.target.value)} aria-label="Stylist">
              <option value="">All stylists</option>
              {stylists.map((b) => <option key={b.staffId} value={b.staffId!}>{b.staffName}</option>)}
              {staffId && !stylists.some((b) => b.staffId === staffId) && <option value={staffId}>Selected stylist</option>}
            </select>
            <select className="field h-9 w-auto py-1 text-sm" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Rebooking status">
              {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>

          <div className="mt-3 overflow-x-auto rounded-xl2 border border-line bg-white">
            {rows.length === 0 ? (
              <EmptyState icon={<UserPlus className="h-8 w-8" />} title={data.clients.length ? 'No matches' : 'No new clients in these dates'}>
                {data.clients.length ? 'Try another search or status.' : 'A client counts as new on their first appointment in Square.'}
              </EmptyState>
            ) : (
              <table className="w-full min-w-[760px] text-left text-[14px]">
                <thead className="border-b border-line bg-mist/50 text-[12px] uppercase tracking-wide text-stone">
                  <tr><th className="px-4 py-2 font-medium">Client</th><th className="px-3 py-2 font-medium">First visit</th><th className="px-3 py-2 font-medium">Rebooking</th><th className="px-3 py-2 font-medium">Next appointment</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((c) => (
                    <tr key={c.clientId} className="align-top">
                      <td className="px-4 py-2.5"><Link to={`/clients/${c.clientId}`} className="font-medium text-ink hover:text-plum hover:underline">{c.clientName}</Link></td>
                      <td className="px-3 py-2.5">
                        <Appt a={c.first} />
                        {c.first.state === 'upcoming' && <Badge tone="amber" className="mt-1">Not in yet</Badge>}
                        {c.first.state === 'no_show' && <Badge tone="rose" className="mt-1">No-show</Badge>}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={STATUS_TONE[c.rebookStatus]}>{REBOOK_STATUS_LABEL[c.rebookStatus]}</Badge>
                        {c.rebookStatus !== 'not_rebooked' && (
                          <p className="mt-1 text-[12px] text-stone">
                            {[c.laterVisits && `${c.laterVisits} visit${c.laterVisits === 1 ? '' : 's'} since`, c.futureAppointments && `${c.futureAppointments} upcoming`].filter(Boolean).join(' · ')}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2.5">{c.next ? <Appt a={c.next} /> : <span className="text-stone">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="mt-2 text-[12px] text-stone">
            Rebooked and booked-ahead count only confirmed appointments after the first visit; cancelled and unconfirmed bookings are left out.
            {data.historyStart && <> Appointment history in the CRM starts {dateShort(data.historyStart)}, {new Date(data.historyStart).getFullYear()}; clients from before then count as existing.</>}
          </p>
        </>
      )}
    </section>
  );
}

function Stat({ label, value, sub, active, onClick }: { label: string; value: number; sub: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cx('rounded-xl2 border bg-white px-4 py-3 text-left transition-colors hover:bg-plum-tint/40', active ? 'border-plum/40' : 'border-line')}>
      <span className="block text-[12px] font-medium uppercase tracking-wide text-stone">{label}</span>
      <span className={cx('num mt-1 block font-display text-[34px] leading-none', value ? 'text-ink' : 'text-stone-light')}>{value}</span>
      <span className="mt-1 block text-[12px] text-stone">{sub}</span>
    </button>
  );
}

function Appt({ a }: { a: NewClientApptDTO }) {
  return (
    <>
      <p className="num text-ink">{dateShort(a.startAt)} · {time(a.startAt)}</p>
      <p className="text-[13px] text-ink-soft">{a.serviceNames.join(', ') || 'Service not recorded'}</p>
      {a.staffName && <p className="text-[12px] text-stone">with {a.staffName}</p>}
    </>
  );
}
