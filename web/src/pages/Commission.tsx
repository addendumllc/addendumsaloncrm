import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommissionEntryDTO, CommissionPeriodDTO, CommissionStatusDTO, CommissionSummaryDTO, CommissionTeamRowDTO, PaySummaryDTO, TaxEstimateDTO } from '@addendum/shared';
import { AlertTriangle, ArrowLeft, Download, Info, Lock, RefreshCw, UserCheck } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { useCanDo, useMe } from '../api/hooks';
import { addDaysKey, dayKey, labelOfKey, relative } from '../lib/format';
import { Badge, Button, EmptyState, ErrorNote, Field, Modal, PageHeader, PageLoading, Segmented, Spinner, cx, useToast } from '../components/ui';
import { DateRangeBar, EntriesList, SummaryCards, usd, useDateRange } from '../components/domain/Commission';
import { PayrollTimesheet } from '../components/domain/Payroll';
import { PayGate, PayLockBar } from '../components/domain/PayGate';
import { HoursWagesCard, TaxesPanel, YearTable } from '../components/domain/PayViews';
import { Tc } from '../lib/titleCase';
import { useSearchParams } from 'react-router-dom';
import { SectionPicker } from '../components/layout/subNav';
import { useStoreNames } from '../lib/storeNames';

function useStatus() {
  return useQuery({ queryKey: ['commission-status'], queryFn: () => api.get<{ status: CommissionStatusDTO }>('/commission/status').then((r) => r.status) });
}

type PayView = 'commission' | 'taxes' | 'year';
const PAY_VIEWS: { value: PayView; label: string }[] = [{ value: 'commission', label: 'Commission' }, { value: 'taxes', label: 'Taxes' }, { value: 'year', label: 'Year' }];

/** Earnings & Goals (formerly My Commission): the signed-in person's own earnings. The server only ever returns their records. */
/**
 * My Commission is locked until the person re-enters their password (or sign-in code), so pay isn't on show on a shared
 * salon screen. It stays open for a few minutes on this device, then locks again (checked on the server too).
 */
export function MyCommissionPage() {
  return (
    <PayGate title="Enter your password to see your pay">
      <MyCommissionContent />
    </PayGate>
  );
}

function MyCommissionContent() {
  const qc = useQueryClient();
  const dr = useDateRange('this_pay_period');
  const { data: status } = useStatus();
  // Commission / Taxes / Year are in the side menu (?view=); on phones, a dropdown.
  const [params] = useSearchParams();
  const view: PayView = params.get('view') === 'taxes' ? 'taxes' : params.get('view') === 'year' ? 'year' : 'commission';
  const canDo = useCanDo();
  const names = useStoreNames();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['commission-me', dr.range],
    queryFn: () => api.get<{ summary: CommissionSummaryDTO; entries: CommissionEntryDTO[]; squareLinked: boolean; pay: PaySummaryDTO | null; taxes: TaxEstimateDTO | null }>(`/commission/me?from=${dr.range.from}&to=${dr.range.to}`),
    enabled: !!dr.range.from && !!dr.range.to,
  });
  return (
    <div>
      <PageHeader title="Earnings & Goals" subtitle={status?.lastSuccessfulSyncAt ? `From Square sales · updated ${relative(status.lastSuccessfulSyncAt)}` : 'From Square sales'} />
      <SectionPicker path="/my-commission" names={names} can={canDo} className="mb-4" />
      {view === 'year' ? <YearTable url="/commission/me/year" showPaid={false} /> : <DateRangeBar {...dr} />}
      {status?.disclaimer && <p className="mb-4 flex items-start gap-2 rounded-xl2 border border-line bg-mist/50 px-4 py-3 text-[14px] text-ink-soft"><Info className="mt-0.5 h-4 w-4 shrink-0 text-stone" /><span className="whitespace-pre-line">{status.disclaimer}</span></p>}
      {status && !status.enabled && <Notice>Commission isn’t turned on yet. An administrator sets it up in Settings → Commission.</Notice>}
      {data && !data.squareLinked && <Notice>Your account isn’t linked to your Square team member yet, so your Square sales can’t be matched to you. Ask an administrator to link it in Settings → Users & Permissions.</Notice>}
      {isLoading && <PageLoading />}
      {error && (error instanceof ApiError && error.code === 'reauth_required'
        ? <Button className="mt-2" onClick={() => qc.invalidateQueries({ queryKey: ['pay-unlock'] })}>Locked again — enter your password</Button>
        : <ErrorNote error={error} onRetry={refetch} />)}
      {view === 'taxes' && data && <TaxesPanel taxes={data.taxes} />}
      {view === 'commission' && data && (
        <>
          {data.pay && <HoursWagesCard pay={data.pay} taxes={data.taxes} />}
          <SummaryCards s={data.summary} personal />
          <MyNewClients range={dr.range} />
          <p className="mb-3 mt-6 flex items-start gap-1.5 text-[13px] text-stone"><Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>Only you (and administrators) can see your earnings. <b className="font-medium text-ink-soft">Estimated</b> amounts can still change until the period is finalized.</span></p>
          <CategoryEntries entries={data.entries} emptyText="Sales appear here after they’re paid in Square and the CRM syncs." />
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

/** Team Payroll (formerly Team Commission): everyone's earnings, review queue, payroll hours and pay periods. */
export function TeamCommissionPage() {
  const canDo = useCanDo();
  const names = useStoreNames();
  // Team / Needs review / Payroll hours / Pay periods are in the side menu (?tab=); on phones, a dropdown.
  const [params] = useSearchParams();
  const tab = (['review', 'payroll', 'periods'] as const).find((t) => t === params.get('tab')) ?? 'team';
  const [staff, setStaff] = useState<string | null>(null);
  const dr = useDateRange('this_pay_period');
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
    ...(canDo('commission:team') || canDo('commission:manage') ? [{ value: 'payroll' as const, label: 'Payroll hours' }] : []),
    ...(canDo('commission:approve') || canDo('commission:team') ? [{ value: 'periods' as const, label: 'Pay periods' }] : []),
  ];
  return (
    <div>
      <PageHeader
        title={tab === 'review' ? 'Team Payroll · Needs review' : tab === 'payroll' ? 'Team Payroll · Hours' : tab === 'periods' ? 'Team Payroll · Pay periods' : 'Team Payroll'}
        subtitle={status ? <>Last Square sync: {status.lastSuccessfulSyncAt ? relative(status.lastSuccessfulSyncAt) : 'never'}{status.lastRun?.status === 'failed' && <span className="text-rose"> · last attempt failed: {status.lastRun.message}</span>}</> : undefined}
        actions={(canDo('commission:manage') || canDo('commission:approve')) && <Button icon={<RefreshCw className="h-4 w-4" />} loading={syncing} onClick={sync}>Sync from Square</Button>}
      />
      {status?.missing.map((m) => <Notice key={m}>{m}</Notice>)}
      {status?.hoursSyncError && <Notice>{status.hoursSyncError}</Notice>}
      {status && status.unlinkedTeamMembers.length > 0 && <Notice>Square team member{status.unlinkedTeamMembers.length > 1 ? 's' : ''} {status.unlinkedTeamMembers.join(', ')} {status.unlinkedTeamMembers.length > 1 ? 'aren’t' : 'isn’t'} linked to a CRM account, so their sales go to review. Link them in Settings → Users & Permissions.</Notice>}
      <PayLockBar />
      {tabs.length > 1 && <SectionPicker path="/commission" names={names} can={canDo} className="mb-5" />}
      {/* Team pay and payroll hours (wages) need the password check; Needs review and Pay periods don't show pay totals. */}
      {tab === 'team' && <PayGate title="Enter your password to see team pay">{staff ? <StaffDetail id={staff} dr={dr} onBack={() => setStaff(null)} /> : <TeamTable dr={dr} onOpen={setStaff} />}</PayGate>}
      {tab === 'review' && <ReviewQueue />}
      {tab === 'payroll' && <PayGate title="Enter your password to see payroll"><PayrollTimesheet /></PayGate>}
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
          <span className="flex flex-wrap gap-2">
            <a className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-white px-3 text-[13px] font-medium hover:bg-mist/60" href={`/api/commission/export/summary?from=${dr.range.from}&to=${dr.range.to}`}>
              <Download className="h-4 w-4" />Pay summary (CSV)
            </a>
            <a className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-white px-3 text-[13px] font-medium hover:bg-mist/60" href={`/api/commission/export?from=${dr.range.from}&to=${dr.range.to}`}>
              <Download className="h-4 w-4" />Every transaction (CSV)
            </a>
          </span>
        )}
      </div>
      {isLoading && <PageLoading />}
      {error && <ErrorNote error={error} />}
      {data && (
        <>
          <SummaryCards s={data.total} />
          {data.unassigned > 0 && <p className="mt-3 text-[13px] text-amber">{data.unassigned} record{data.unassigned === 1 ? '' : 's'} in these dates aren’t credited to anyone yet (see Needs review).</p>}
          {/* Phones: a card per person — gross, taxes and net up front, the parts underneath. Tap to open their detail. */}
          <ul className="mt-6 space-y-2 sm:hidden">
            {data.rows.map((r) => (
              <li key={r.staffId}>
                <button type="button" onClick={() => onOpen(r.staffId!)} className="w-full rounded-xl2 border border-line bg-white p-3 text-left active:bg-mist/40">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[15px] font-medium text-ink">{r.staffName}{!r.squareLinked && <Badge tone="amber" className="ml-2">Not linked</Badge>}</span>
                    <span className="num text-right text-[17px] font-medium text-ink">{usd(r.taxes.netCents)}<span className="block text-[11px] font-normal text-stone">est. net</span></span>
                  </div>
                  <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 text-[13px]">
                    <div><dt className="text-[11px] text-stone">Commission</dt><dd className="num">{usd(r.totalCommissionCents)}</dd></div>
                    <div><dt className="text-[11px] text-stone">Tips</dt><dd className="num">{r.tipEligible ? usd(r.tipsCents) : '—'}</dd></div>
                    <div><dt className="text-[11px] text-stone">Wages</dt><dd className="num">{r.pay.payType === 'none' ? '—' : usd(r.pay.wagesCents)}</dd></div>
                    <div><dt className="text-[11px] text-stone">Hours</dt><dd className="num">{r.pay.minutes ? (r.pay.minutes / 60).toFixed(2) : '—'}</dd></div>
                    <div><dt className="text-[11px] text-stone">Gross</dt><dd className="num font-medium">{usd(r.taxes.grossCents)}</dd></div>
                    <div><dt className="text-[11px] text-stone">Est. taxes</dt><dd className="num">{r.taxes.workerType === '1099' ? '1099' : usd(r.taxes.withheldCents)}</dd></div>
                  </dl>
                  <div className="mt-2 flex flex-wrap gap-1">{r.estimatedCents === 0 && r.finalizedCents !== 0 ? <Badge tone="sage">Finalized</Badge> : r.entries ? <Badge tone="amber">{r.finalizedCents ? 'Part finalized' : 'Estimated'}</Badge> : null}{r.needsReview > 0 && <Badge tone="rose">{r.needsReview} review</Badge>}</div>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-6 hidden overflow-x-auto rounded-xl2 border border-line bg-white sm:block">
            <table className="w-full min-w-[1280px] text-left text-[14px]">
              {/* Services and retail items earn on different plans, so each has its own sales and commission (after its refunds). */}
              <thead className="border-b border-line bg-mist/50 text-[12px] uppercase tracking-wide text-stone">
                <tr>
                  <th rowSpan={2} className="px-4 py-2 align-bottom font-medium">Stylist</th>
                  <th colSpan={2} className="border-l border-line px-3 pt-2 text-center font-medium text-ink-soft">Services</th>
                  <th colSpan={2} className="border-l border-line px-3 pt-2 text-center font-medium text-ink-soft">Retail items</th>
                  <th rowSpan={2} className="border-l border-line px-3 py-2 text-right align-bottom font-medium">Other & adj.</th>
                  <th rowSpan={2} className="px-3 py-2 text-right align-bottom font-medium">Total commission</th>
                  <th rowSpan={2} className="border-l border-line px-3 py-2 text-right align-bottom font-medium">Tips</th>
                  <th rowSpan={2} className="px-3 py-2 text-right align-bottom font-medium">Hours</th>
                  <th rowSpan={2} className="px-3 py-2 text-right align-bottom font-medium">Wages</th>
                  <th rowSpan={2} className="px-3 py-2 text-right align-bottom font-medium">Gross pay</th>
                  <th rowSpan={2} className="px-3 py-2 text-right align-bottom font-medium">Est. taxes</th>
                  <th rowSpan={2} className="px-3 py-2 text-right align-bottom font-medium">Est. net</th>
                  <th rowSpan={2} className="px-3 py-2 align-bottom font-medium">Status</th>
                </tr>
                <tr className="text-[11px]">
                  <th className="border-l border-line px-3 pb-2 text-right font-medium">Sales</th><th className="px-3 pb-2 text-right font-medium">Commission</th>
                  <th className="border-l border-line px-3 pb-2 text-right font-medium">Sales</th><th className="px-3 pb-2 text-right font-medium">Commission</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.rows.map((r) => (
                  <tr key={r.staffId} className="cursor-pointer hover:bg-mist/30" onClick={() => onOpen(r.staffId!)}>
                    <td className="px-4 py-2.5 font-medium text-ink">{r.staffName}{!r.squareLinked && <Badge tone="amber" className="ml-2">Not linked</Badge>}</td>
                    <td className="num border-l border-line px-3 py-2.5 text-right text-stone">{usd(r.serviceSalesCents)}</td>
                    <td className="num px-3 py-2.5 text-right">{usd(r.serviceCommissionCents + r.serviceRefundsCents)}</td>
                    <td className="num border-l border-line px-3 py-2.5 text-right text-stone">{usd(r.retailSalesCents)}</td>
                    <td className="num px-3 py-2.5 text-right">{usd(r.retailCommissionCents + r.retailRefundsCents)}</td>
                    <td className={cx('num border-l border-line px-3 py-2.5 text-right', otherOf(r) < 0 && 'text-rose')}>{usd(otherOf(r))}</td>
                    <td className="num px-3 py-2.5 text-right font-medium">{usd(r.totalCommissionCents)}</td>
                    <td className="num border-l border-line px-3 py-2.5 text-right text-stone">{r.tipEligible ? usd(r.tipsCents) : <Badge>No tips</Badge>}</td>
                    <td className="num px-3 py-2.5 text-right text-stone">{r.pay.minutes ? (r.pay.minutes / 60).toFixed(2) : '—'}</td>
                    <td className="num px-3 py-2.5 text-right" title={r.pay.basis}>{r.pay.payType === 'none' ? <span className="text-stone">—</span> : usd(r.pay.wagesCents)}</td>
                    <td className="num px-3 py-2.5 text-right font-medium">{usd(r.taxes.grossCents)}</td>
                    <td className="num px-3 py-2.5 text-right text-stone" title={r.taxes.workerType === '1099' ? '1099 contractor — nothing withheld' : 'Federal, state, local, Social Security and Medicare (estimate)'}>{r.taxes.workerType === '1099' ? '1099' : usd(r.taxes.withheldCents)}</td>
                    <td className="num px-3 py-2.5 text-right font-medium">{usd(r.taxes.netCents)}</td>
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

/** Commission that is neither services nor retail: adjustments, and refunds on lines without a category. */
const otherOf = (s: CommissionSummaryDTO) => s.adjustmentsCents + s.refundsCents - s.serviceRefundsCents - s.retailRefundsCents;

/** The transactions list with a Services / Retail items switch, since the two are paid on different plans. */
function CategoryEntries({ entries, emptyText }: { entries: CommissionEntryDTO[]; emptyText?: string }) {
  const [cat, setCat] = useState<'all' | 'service' | 'retail'>('all');
  const n = (c: string) => entries.filter((e) => e.category === c).length;
  return (
    <>
      <div className="mb-3"><Segmented value={cat} onChange={setCat} options={[{ value: 'all', label: 'All' }, { value: 'service', label: `Services (${n('service')})` }, { value: 'retail', label: `Retail items (${n('retail')})` }]} /></div>
      <EntriesList entries={cat === 'all' ? entries : entries.filter((e) => e.category === cat)} emptyText={emptyText} />
    </>
  );
}

function StaffDetail({ id, dr, onBack }: { id: string; dr: ReturnType<typeof useDateRange>; onBack: () => void }) {
  const canDo = useCanDo();
  const { data: me } = useMe();
  // Adding hours by pay period: administrators only.
  const adminPay = me?.role === 'admin' && canDo('commission:manage');
  const [adjust, setAdjust] = useState(false);
  const [view, setView] = useState<PayView>('commission');
  const { data, isLoading } = useQuery({
    queryKey: ['commission-staff', id, dr.range],
    queryFn: () => api.get<{ staff: { id: string; name: string; squareLinked: boolean }; summary: CommissionSummaryDTO; entries: CommissionEntryDTO[]; pay: PaySummaryDTO | null; taxes: TaxEstimateDTO | null }>(`/commission/staff/${id}?from=${dr.range.from}&to=${dr.range.to}`),
  });
  return (
    <div>
      <button onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm text-stone hover:text-ink"><ArrowLeft className="h-4 w-4" />Team</button>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="h-display flex-1 text-[28px]">{data?.staff.name ?? ''}</h2>
        {canDo('commission:approve') && <Button onClick={() => setAdjust(true)}>Add adjustment</Button>}
        {canDo('commission:export') && <a className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-white px-3 text-[13px] font-medium hover:bg-mist/60" href={`/api/commission/export?from=${dr.range.from}&to=${dr.range.to}&staffId=${id}`}><Download className="h-4 w-4" />CSV</a>}
      </div>
      <Segmented className="mb-4" value={view} onChange={setView} options={PAY_VIEWS} />
      {view === 'year' ? <YearTable url={`/commission/staff/${id}/year`} staffId={adminPay ? id : undefined} /> : <DateRangeBar {...dr} />}
      {view === 'taxes' && data && <TaxesPanel taxes={data.taxes} />}
      {view === 'commission' && (isLoading || !data ? <PageLoading /> : (
        <>
          {data.pay && <HoursWagesCard pay={data.pay} taxes={data.taxes} />}
          <SummaryCards s={data.summary} />
          <div className="mt-6"><CategoryEntries entries={data.entries} /></div>
        </>
      ))}
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
  // The current pay period unless other dates are chosen.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const rq = range ? `?from=${range.from}&to=${range.to}` : '';
  const { data: res, isLoading } = useQuery({ queryKey: ['commission-review', range], queryFn: () => api.get<{ entries: CommissionEntryDTO[]; from: string; to: string }>(`/commission/review${rq}`) });
  const data = res?.entries;
  const { data: options } = useQuery({ queryKey: ['commission-options'], queryFn: () => api.get<{ staff: { id: string; name: string; active: boolean }[] }>('/commission/options') });
  const [pick, setPick] = useState<Record<string, string>>({});
  // Several at once: tick them, then credit them all to one person (or accept them as they are).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPick, setBulkPick] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (url: string, body: object, msg: string | ((r: any) => string)) => {
    setBusy(true);
    try {
      const r = await api.post<{ entries: CommissionEntryDTO[] }>(`${url}${rq}`, body);
      qc.setQueryData(['commission-review', range], (old: any) => ({ ...old, entries: r.entries }));
      qc.invalidateQueries({ queryKey: ['commission-status'] });
      qc.invalidateQueries({ queryKey: ['commission-team'] });
      setSelected(new Set());
      toast(typeof msg === 'string' ? msg : msg(r));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const dates = res && (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Sales from"><input type="date" className="field h-9 py-1 text-sm" value={res.from} max={res.to} onChange={(e) => e.target.value && setRange({ from: e.target.value, to: res.to })} /></Field>
      <Field label="To"><input type="date" className="field h-9 py-1 text-sm" value={res.to} min={res.from} onChange={(e) => e.target.value && setRange({ from: res.from, to: e.target.value })} /></Field>
      {range ? <Button size="sm" variant="ghost" onClick={() => setRange(null)}>Back to this pay period</Button> : <span className="pb-2 text-[13px] text-stone">This pay period. Choose other dates to check older sales.</span>}
    </div>
  );
  if (isLoading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!data?.length) return <div className="space-y-3">{dates}<div className="panel"><EmptyState icon={<UserCheck className="h-9 w-9" />} title="Nothing to review">{range ? 'Nothing in these dates needs review.' : 'Nothing from the last month needs review. Choose earlier dates to check older sales.'}</EmptyState></div></div>;
  const approve = canDo('commission:approve');
  const ids = [...selected].filter((id) => data.some((e) => e.id === id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOn = ids.length === data.length;
  const staff = options?.staff.filter((s) => s.active) ?? [];
  return (
    <div className="space-y-3">
      {dates}
      <p className="text-[13px] text-stone">Square doesn’t say who performed each item, so the CRM matches sales to bookings, the time clock and the client’s stylist. These couldn’t be matched for sure — choose who gets credit, or accept them as they are. Settings → Commission chooses who gets sales Square didn’t record a checkout for.</p>
      {approve && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl2 border border-line bg-white p-3 backdrop-blur">
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" className="h-4 w-4 accent-plum" checked={allOn} onChange={() => setSelected(allOn ? new Set() : new Set(data.map((e) => e.id)))} />
            {ids.length ? `${ids.length} selected` : 'Select all'}
          </label>
          {ids.length > 0 && <>
            <select className="field h-9 w-auto py-1 text-sm" value={bulkPick} onChange={(x) => setBulkPick(x.target.value)} aria-label="Credit selected to">
              <option value="">Credit selected to…</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <Button size="sm" variant="primary" loading={busy} disabled={!bulkPick} onClick={() => act('/commission/entries/attribute', { entryIds: ids, staffIds: [bulkPick] }, (r) => `${r.credited} credited`)}>Credit</Button>
            {ids.some((id) => data.find((e) => e.id === id)?.staffId) && (
              <Button size="sm" variant="ghost" loading={busy} onClick={() => act('/commission/entries/accept', { entryIds: ids }, (r) => `${r.accepted} accepted`)}>Accept as is</Button>
            )}
          </>}
        </div>
      )}
      {data.map((e) => {
        const suggestions = (e.calc?.suggestions ?? []).filter((s) => s.staffId !== e.staffId);
        return (
          <div key={e.id} className={cx('rounded-xl2 border bg-white p-4', selected.has(e.id) ? 'border-plum' : 'border-line')}>
            <div className="flex items-start gap-3">
              {approve && <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-plum" checked={selected.has(e.id)} onChange={() => toggle(e.id)} aria-label={`Select ${e.itemName}`} />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <p className="font-medium text-ink">{e.itemName}</p>
                  <span className="num text-[14px] text-ink-soft">{e.kind === 'tip' ? `${usd(e.tipCents)} tip` : usd(e.netSalesCents)}</span>
                  <span className="text-[13px] text-stone">{labelOfKey(e.transactionDate, { month: 'short', day: 'numeric', year: 'numeric' })} · {new Date(e.transactionAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{e.staffName ? ` · ${e.staffName}` : ''}</span>
                  {e.onHold && <Badge tone="amber">On hold · not in pay yet</Badge>}
                </div>
                <p className="mt-1 text-[13px] text-rose">{e.reviewReason}</p>
                {approve && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {e.staffId && <Button size="sm" variant="primary" loading={busy} onClick={() => act(`/commission/entries/${e.id}/accept`, {}, `Accepted — ${e.staffName} gets credit`)}>Accept {e.staffName?.split(' ')[0]}</Button>}
                    {e.kind !== 'refund' && suggestions.map((s) => (
                      <Button key={s.staffId} size="sm" loading={busy} title={s.why} onClick={() => act(`/commission/entries/${e.id}/attribute`, { staffIds: [s.staffId] }, `Credited to ${s.name}`)}>
                        {s.name.split(' ')[0]} <span className="font-normal text-stone">· {s.why}</span>
                      </Button>
                    ))}
                    {e.kind !== 'refund' && (
                      <>
                        <select className="field h-9 w-auto py-1 text-sm" value={pick[e.id] ?? ''} onChange={(x) => setPick({ ...pick, [e.id]: x.target.value })} aria-label="Credit to">
                          <option value="">Someone else…</option>
                          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                        <Button size="sm" variant="secondary" disabled={!pick[e.id]} loading={busy} onClick={() => act(`/commission/entries/${e.id}/attribute`, { staffIds: [pick[e.id]] }, 'Credited')}>Credit</Button>
                        <Button size="sm" variant="ghost" loading={busy} onClick={() => act(`/commission/entries/${e.id}/attribute`, { staffIds: [] }, 'Marked as no commission')}>No commission</Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
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
          <h3 className="h-display text-[22px]"><Tc>Finalize a pay period</Tc></h3>
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
