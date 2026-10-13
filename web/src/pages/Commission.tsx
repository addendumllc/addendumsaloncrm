import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommissionEntryDTO, CommissionPeriodDTO, CommissionStatusDTO, CommissionSummaryDTO, CommissionTeamRowDTO } from '@addendum/shared';
import { AlertTriangle, ArrowLeft, Download, Lock, RefreshCw, UserCheck } from 'lucide-react';
import { api } from '../api/client';
import { useCanDo } from '../api/hooks';
import { addDaysKey, dayKey, labelOfKey, relative } from '../lib/format';
import { Badge, Button, EmptyState, ErrorNote, Field, Modal, PageHeader, PageLoading, Segmented, Spinner, cx, useToast } from '../components/ui';
import { DateRangeBar, EntriesList, SummaryCards, usd, useDateRange } from '../components/domain/Commission';

function useStatus() {
  return useQuery({ queryKey: ['commission-status'], queryFn: () => api.get<{ status: CommissionStatusDTO }>('/commission/status').then((r) => r.status) });
}

/** My Commission: the signed-in person's own earnings. The server only ever returns their records. */
export function MyCommissionPage() {
  const dr = useDateRange('this_week');
  const { data: status } = useStatus();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['commission-me', dr.range],
    queryFn: () => api.get<{ summary: CommissionSummaryDTO; entries: CommissionEntryDTO[]; squareLinked: boolean }>(`/commission/me?from=${dr.range.from}&to=${dr.range.to}`),
    enabled: !!dr.range.from && !!dr.range.to,
  });
  return (
    <div>
      <PageHeader title="My Commission" subtitle={status?.lastSuccessfulSyncAt ? `From Square sales · updated ${relative(status.lastSuccessfulSyncAt)}` : 'From Square sales'} />
      <DateRangeBar {...dr} />
      {status && !status.enabled && <Notice>Commission isn’t turned on yet. An administrator sets it up in Settings → Commission.</Notice>}
      {data && !data.squareLinked && <Notice>Your account isn’t linked to your Square team member yet, so your Square sales can’t be matched to you. Ask an administrator to link it in Settings → Users & Permissions.</Notice>}
      {isLoading && <PageLoading />}
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {data && (
        <>
          <SummaryCards s={data.summary} />
          <MyNewClients range={dr.range} />
          <p className="mb-3 mt-6 flex items-start gap-1.5 text-[13px] text-stone"><Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>Only you (and administrators) can see your earnings. <b className="font-medium text-ink-soft">Estimated</b> amounts can still change until the period is finalized.</span></p>
          <EntriesList entries={data.entries} emptyText="Sales appear here after they’re paid in Square and the CRM syncs." />
        </>
      )}
    </div>
  );
}

/** Two plain counts for the signed-in stylist: new clients they saw first, and how many have a future booking. */
function MyNewClients({ range }: { range: { from: string; to: string } }) {
  const { data } = useQuery({
    queryKey: ['commission-me-new-clients', range],
    queryFn: () => api.get<{ newClients: number; rebookedFuture: number }>(`/commission/me/new-clients?from=${range.from}&to=${range.to}`),
    enabled: !!range.from && !!range.to,
    refetchInterval: 60_000,
  });
  if (!data) return null;
  const Stat = ({ label, value, sub }: { label: string; value: number; sub: string }) => (
    <div className="rounded-xl2 border border-line bg-white px-4 py-3">
      <p className="text-[12px] font-medium uppercase tracking-wide text-stone">{label}</p>
      <p className="num mt-1 font-display text-[24px] leading-none text-ink">{value}</p>
      <p className="mt-1 text-[12px] text-stone">{sub}</p>
    </div>
  );
  return (
    <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="New clients" value={data.newClients} sub="First-ever visit was with you" />
      <Stat label="Rebooked for future" value={data.rebookedFuture} sub="Have a confirmed upcoming appointment" />
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 flex items-start gap-2 rounded-xl2 border border-amber/30 bg-amber/10 px-4 py-3 text-[14px] text-ink-soft"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" />{children}</p>;
}

/** Team Commission: everyone's earnings, review queue and finalizing (for people with those permissions). */
export function TeamCommissionPage() {
  const canDo = useCanDo();
  const [tab, setTab] = useState<'team' | 'review' | 'periods'>('team');
  const [staff, setStaff] = useState<string | null>(null);
  const dr = useDateRange('this_month');
  const { data: status } = useStatus();
  const qc = useQueryClient();
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);
  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api.post<{ status: CommissionStatusDTO }>('/commission/sync');
      qc.setQueryData(['commission-status'], r.status);
      if (r.status.lastRun?.status === 'ok') toast(r.status.lastRun.message ?? 'Synced'); else toast(r.status.lastRun?.message ?? 'Sync failed', 'error');
      qc.invalidateQueries({ queryKey: ['commission-team'] });
      qc.invalidateQueries({ queryKey: ['commission-review'] });
      qc.invalidateQueries({ queryKey: ['commission-staff'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSyncing(false);
    }
  };
  const tabs = [
    { value: 'team' as const, label: 'Team' },
    ...(canDo('commission:approve') || canDo('commission:manage') ? [{ value: 'review' as const, label: `Needs review${status?.needsReview ? ` (${status.needsReview})` : ''}` }] : []),
    ...(canDo('commission:approve') || canDo('commission:team') ? [{ value: 'periods' as const, label: 'Pay periods' }] : []),
  ];
  return (
    <div>
      <PageHeader
        title="Team Commission"
        subtitle={status ? <>Last Square sync: {status.lastSuccessfulSyncAt ? relative(status.lastSuccessfulSyncAt) : 'never'}{status.lastRun?.status === 'failed' && <span className="text-rose"> · last attempt failed: {status.lastRun.message}</span>}</> : undefined}
        actions={(canDo('commission:manage') || canDo('commission:approve')) && <Button icon={<RefreshCw className="h-4 w-4" />} loading={syncing} onClick={sync}>Sync from Square</Button>}
      />
      {status?.missing.map((m) => <Notice key={m}>{m}</Notice>)}
      {status && status.unlinkedTeamMembers.length > 0 && <Notice>Square team member{status.unlinkedTeamMembers.length > 1 ? 's' : ''} {status.unlinkedTeamMembers.join(', ')} {status.unlinkedTeamMembers.length > 1 ? 'aren’t' : 'isn’t'} linked to a CRM account, so their sales go to review. Link them in Settings → Users & Permissions.</Notice>}
      {tabs.length > 1 && <Segmented className="mb-5" value={tab} onChange={(v) => { setTab(v); setStaff(null); }} options={tabs} />}
      {tab === 'team' && (staff ? <StaffDetail id={staff} dr={dr} onBack={() => setStaff(null)} /> : <TeamTable dr={dr} onOpen={setStaff} />)}
      {tab === 'review' && <ReviewQueue />}
      {tab === 'periods' && <Periods />}
    </div>
  );
}

function TeamTable({ dr, onOpen }: { dr: ReturnType<typeof useDateRange>; onOpen: (id: string) => void }) {
  const canDo = useCanDo();
  const { data, isLoading, error } = useQuery({
    queryKey: ['commission-team', dr.range],
    queryFn: () => api.get<{ rows: (CommissionTeamRowDTO & { active: boolean })[]; total: CommissionSummaryDTO; unassigned: number }>(`/commission/team?from=${dr.range.from}&to=${dr.range.to}`),
    enabled: !!dr.range.from && !!dr.range.to,
  });
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <DateRangeBar {...dr} />
        {canDo('commission:export') && (
          <a className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-white px-3 text-[13px] font-medium hover:bg-mist/60" href={`/api/commission/export?from=${dr.range.from}&to=${dr.range.to}`}>
            <Download className="h-4 w-4" />Export for payroll (CSV)
          </a>
        )}
      </div>
      {isLoading && <PageLoading />}
      {error && <ErrorNote error={error} />}
      {data && (
        <>
          <SummaryCards s={data.total} />
          {data.unassigned > 0 && <p className="mt-3 text-[13px] text-amber">{data.unassigned} record{data.unassigned === 1 ? '' : 's'} in these dates aren’t credited to anyone yet (see Needs review).</p>}
          <div className="mt-6 overflow-x-auto rounded-xl2 border border-line bg-white">
            <table className="w-full min-w-[640px] text-left text-[14px]">
              <thead className="border-b border-line bg-mist/50 text-[12px] uppercase tracking-wide text-stone">
                <tr><th className="px-4 py-2 font-medium">Stylist</th><th className="px-3 py-2 text-right font-medium">Sales</th><th className="px-3 py-2 text-right font-medium">Services</th><th className="px-3 py-2 text-right font-medium">Retail</th><th className="px-3 py-2 text-right font-medium">Refunds & adj.</th><th className="px-3 py-2 text-right font-medium">Total</th><th className="px-3 py-2 text-right font-medium">Tips</th><th className="px-3 py-2 font-medium">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.rows.map((r) => (
                  <tr key={r.staffId} className="cursor-pointer hover:bg-mist/30" onClick={() => onOpen(r.staffId!)}>
                    <td className="px-4 py-2.5 font-medium text-ink">{r.staffName}{!r.squareLinked && <Badge tone="amber" className="ml-2">Not linked</Badge>}</td>
                    <td className="num px-3 py-2.5 text-right">{usd(r.totalSalesCents)}</td>
                    <td className="num px-3 py-2.5 text-right">{usd(r.serviceCommissionCents)}</td>
                    <td className="num px-3 py-2.5 text-right">{usd(r.retailCommissionCents)}</td>
                    <td className={cx('num px-3 py-2.5 text-right', r.refundsCents + r.adjustmentsCents < 0 && 'text-rose')}>{usd(r.refundsCents + r.adjustmentsCents)}</td>
                    <td className="num px-3 py-2.5 text-right font-medium">{usd(r.totalCommissionCents)}</td>
                    <td className="num px-3 py-2.5 text-right text-stone">{usd(r.tipsCents)}</td>
                    <td className="px-3 py-2.5">{r.estimatedCents === 0 && r.finalizedCents !== 0 ? <Badge tone="sage">Finalized</Badge> : r.entries ? <Badge tone="amber">{r.finalizedCents ? 'Part finalized' : 'Estimated'}</Badge> : <span className="text-stone">—</span>}{r.needsReview > 0 && <Badge tone="rose" className="ml-1">{r.needsReview} review</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function StaffDetail({ id, dr, onBack }: { id: string; dr: ReturnType<typeof useDateRange>; onBack: () => void }) {
  const canDo = useCanDo();
  const [adjust, setAdjust] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['commission-staff', id, dr.range],
    queryFn: () => api.get<{ staff: { id: string; name: string; squareLinked: boolean }; summary: CommissionSummaryDTO; entries: CommissionEntryDTO[] }>(`/commission/staff/${id}?from=${dr.range.from}&to=${dr.range.to}`),
  });
  return (
    <div>
      <button onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm text-stone hover:text-ink"><ArrowLeft className="h-4 w-4" />Team</button>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="h-display flex-1 text-[28px]">{data?.staff.name ?? ''}</h2>
        {canDo('commission:approve') && <Button onClick={() => setAdjust(true)}>Add adjustment</Button>}
        {canDo('commission:export') && <a className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-white px-3 text-[13px] font-medium hover:bg-mist/60" href={`/api/commission/export?from=${dr.range.from}&to=${dr.range.to}&staffId=${id}`}><Download className="h-4 w-4" />CSV</a>}
      </div>
      <DateRangeBar {...dr} />
      {isLoading || !data ? <PageLoading /> : (
        <>
          <SummaryCards s={data.summary} />
          <div className="mt-6"><EntriesList entries={data.entries} /></div>
        </>
      )}
      {adjust && <AdjustmentModal staffId={id} name={data?.staff.name ?? ''} onClose={() => setAdjust(false)} />}
    </div>
  );
}

function AdjustmentModal({ staffId, name, onClose }: { staffId: string; name: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(dayKey(new Date()));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.post('/commission/adjustments', { staffId, amountCents: Math.round(Number(amount) * 100), date, note });
      toast('Adjustment added');
      qc.invalidateQueries({ queryKey: ['commission-staff'] });
      qc.invalidateQueries({ queryKey: ['commission-team'] });
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Adjustment for ${name}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={saving}>Add</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount (use − to deduct)"><input type="number" step="0.01" className="field num" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25.00" /></Field>
        <Field label="Counts on"><input type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <Field label="Reason (shown to the stylist)" className="mt-4"><input className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Product returned after payroll" /></Field>
      <p className="mt-2 text-[12px] text-stone">Adjustments are recorded with your name in the history and the activity log.</p>
    </Modal>
  );
}

function ReviewQueue() {
  const toast = useToast();
  const qc = useQueryClient();
  const canDo = useCanDo();
  const { data, isLoading } = useQuery({ queryKey: ['commission-review'], queryFn: () => api.get<{ entries: CommissionEntryDTO[] }>('/commission/review').then((r) => r.entries) });
  const { data: options } = useQuery({ queryKey: ['commission-options'], queryFn: () => api.get<{ staff: { id: string; name: string; active: boolean }[] }>('/commission/options') });
  const [pick, setPick] = useState<Record<string, string>>({});
  const act = async (url: string, body: object, msg: string) => {
    try {
      const r = await api.post<{ entries: CommissionEntryDTO[] }>(url, body);
      qc.setQueryData(['commission-review'], r.entries);
      qc.invalidateQueries({ queryKey: ['commission-status'] });
      qc.invalidateQueries({ queryKey: ['commission-team'] });
      toast(msg);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  if (isLoading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!data?.length) return <div className="panel"><EmptyState icon={<UserCheck className="h-9 w-9" />} title="Nothing to review">Everything from Square was matched to a stylist and a commission rule.</EmptyState></div>;
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-stone">Square doesn’t say who performed each item, so the CRM matches sales to bookings. These couldn’t be matched reliably — choose who gets credit, or accept them as they are.</p>
      {data.map((e) => (
        <div key={e.id} className="rounded-xl2 border border-line bg-white p-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="font-medium text-ink">{e.itemName}</p>
            <span className="num text-[14px] text-ink-soft">{e.kind === 'tip' ? `${usd(e.tipCents)} tip` : usd(e.netSalesCents)}</span>
            <span className="text-[13px] text-stone">{labelOfKey(e.transactionDate, { month: 'short', day: 'numeric', year: 'numeric' })}{e.staffName ? ` · ${e.staffName}` : ''}</span>
          </div>
          <p className="mt-1 text-[13px] text-rose">{e.reviewReason}</p>
          {canDo('commission:approve') && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {e.kind !== 'refund' && (
                <>
                  <select className="field h-9 w-auto py-1 text-sm" value={pick[e.id] ?? ''} onChange={(x) => setPick({ ...pick, [e.id]: x.target.value })}>
                    <option value="">Credit to…</option>
                    {options?.staff.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <Button size="sm" variant="primary" disabled={!pick[e.id]} onClick={() => act(`/commission/entries/${e.id}/attribute`, { staffIds: [pick[e.id]] }, 'Credited')}>Credit</Button>
                  <Button size="sm" variant="ghost" onClick={() => act(`/commission/entries/${e.id}/attribute`, { staffIds: [] }, 'Marked as no commission')}>No commission</Button>
                </>
              )}
              {e.staffId && <Button size="sm" variant="ghost" onClick={() => act(`/commission/entries/${e.id}/accept`, {}, 'Accepted as is')}>Accept as is</Button>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Periods() {
  const canDo = useCanDo();
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['commission-periods'], queryFn: () => api.get<{ periods: CommissionPeriodDTO[] }>('/commission/periods').then((r) => r.periods) });
  const yesterday = addDaysKey(dayKey(new Date()), -1);
  const [range, setRange] = useState({ startDate: data?.[0] ? addDaysKey(data[0].endDate, 1) : addDaysKey(yesterday, -13), endDate: yesterday });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const finalize = async (force = false) => {
    setBusy(true);
    try {
      const r = await api.post<{ finalized: number }>('/commission/periods/finalize', { ...range, confirm: true, force });
      toast(`${r.finalized} records finalized`);
      setConfirm(false);
      for (const k of ['commission-periods', 'commission-team', 'commission-staff', 'commission-status']) qc.invalidateQueries({ queryKey: [k] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (isLoading) return <div className="flex justify-center py-8"><Spinner /></div>;
  return (
    <div className="space-y-5">
      {canDo('commission:approve') && (
        <div className="panel p-5">
          <h3 className="h-display text-[22px]">Finalize a pay period</h3>
          <p className="mt-1 text-[13px] text-stone">Locks every record in these dates with the rate it used. Later refunds or corrections are counted on the day they happen, never by changing finalized amounts.</p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="From"><input type="date" className="field" value={range.startDate} onChange={(e) => setRange({ ...range, startDate: e.target.value })} /></Field>
            <Field label="To"><input type="date" className="field" value={range.endDate} max={yesterday} onChange={(e) => setRange({ ...range, endDate: e.target.value })} /></Field>
            <Button variant="primary" icon={<Lock className="h-4 w-4" />} onClick={() => setConfirm(true)}>Finalize…</Button>
          </div>
        </div>
      )}
      {!data?.length ? <p className="text-[14px] text-stone">No pay periods finalized yet.</p> : (
        <div className="space-y-3">
          {data.map((p) => (
            <div key={p.id} className="rounded-xl2 border border-line bg-white p-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <p className="font-medium text-ink">{labelOfKey(p.startDate, { month: 'short', day: 'numeric' })} – {labelOfKey(p.endDate, { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                <Badge tone="sage">Finalized</Badge>
                <span className="text-[13px] text-stone">{relative(p.finalizedAt)}{p.finalizedByName ? ` by ${p.finalizedByName}` : ''}</span>
              </div>
              <ul className="mt-2 grid gap-x-6 gap-y-0.5 text-[13px] sm:grid-cols-2">
                {Object.entries(p.totals).map(([id, t]) => <li key={id} className="flex justify-between"><span className="text-ink-soft">{t.name}</span><span className="num">{usd(t.commissionCents)} <span className="text-stone">+ {usd(t.tipsCents)} tips</span></span></li>)}
              </ul>
              {canDo('commission:export') && <a className="mt-2 inline-flex items-center gap-1 text-[13px] text-plum hover:underline" href={`/api/commission/export?from=${p.startDate}&to=${p.endDate}`}><Download className="h-3.5 w-3.5" />Export CSV</a>}
            </div>
          ))}
        </div>
      )}
      {confirm && (
        <Modal open onClose={() => setConfirm(false)} title="Finalize commission?" footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="primary" onClick={() => finalize(false)} loading={busy}>Finalize</Button></>}>
          <p className="text-[15px] text-ink-soft">Every commission record from {labelOfKey(range.startDate, { month: 'long', day: 'numeric' })} to {labelOfKey(range.endDate, { month: 'long', day: 'numeric', year: 'numeric' })} will be locked. This can’t be undone; corrections are made with adjustments.</p>
          <p className="mt-2 text-[13px] text-stone">If anything in these dates still needs review, you’ll be asked to resolve it first.</p>
        </Modal>
      )}
    </div>
  );
}
