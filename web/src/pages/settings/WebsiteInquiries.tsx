import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Link2, RefreshCw, ShieldCheck, Unplug, X } from 'lucide-react';
import { api } from '../../api/client';
import { useReauth } from '../../components/domain/Reauth';
import { relative } from '../../lib/format';
import { Badge, Button, EmptyState, Field, PageLoading, Toggle, cx, useToast } from '../../components/ui';
import { Card } from './shared';

interface Settings { account: string; label: string; senders: string[]; extensionAssigneeId: string | null; frontDeskAssigneeId: string | null; enabled: boolean; since: string | null }
export interface Item {
  gmailId: string; receivedAt: string; sender: string; subject: string | null; status: 'processed' | 'review' | 'failed' | 'duplicate' | 'ignored'; kind: 'extension' | 'general' | null;
  contact: { name: string | null; email: string | null; phone: string | null; instagram: string | null }; fields: { label: string; value: string }[]; page: string | null; reason: string | null; leadId: string | null; leadName: string | null;
}
interface Overview {
  connection: { connected: boolean; email: string | null; connectedAt: string | null }; settings: Settings; lastRun: { at: string; ok: boolean; message: string } | null;
  history: Item[]; staff: { id: string; name: string; role: string }[];
}
interface Candidate { id: string; from: string; sender: string; subject: string; date: string; fields: { label: string; value: string }[]; contact: Item['contact']; classification: { kind: string | null; reason: string | null } }

export const STATUS: Record<Item['status'], { label: string; tone: 'sage' | 'amber' | 'rose' | 'neutral' }> = {
  processed: { label: 'Filed', tone: 'sage' }, review: { label: 'Needs review', tone: 'amber' }, failed: { label: 'Failed', tone: 'rose' }, duplicate: { label: 'Duplicate', tone: 'neutral' }, ignored: { label: 'Ignored', tone: 'neutral' },
};

/**
 * Settings → Website Inquiries (administrators): Showit form notifications in the salon's Gmail become new-client
 * inquiries. Connect the mailbox with Google's sign-in, check real notifications and verify the sender, choose who gets
 * extension consultations and general inquiries, and see what was filed, what needs review and what failed.
 */
export function WebsiteInquiriesSettings() {
  const toast = useToast();
  const qc = useQueryClient();
  const reauth = useReauth();
  const [params, setParams] = useSearchParams();
  const { data, isLoading, refetch } = useQuery({ queryKey: ['showit'], queryFn: () => api.get<Overview>('/integrations/showit') });
  const [checking, setChecking] = useState(false);
  const [looking, setLooking] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [newSender, setNewSender] = useState('');

  // Coming back from Google's sign-in.
  useEffect(() => {
    const g = params.get('gmail');
    if (!g) return;
    if (g === 'connected') toast('Gmail connected');
    else toast(g === 'denied' ? 'Gmail wasn’t connected (access wasn’t allowed).' : params.get('reason') ?? 'The connection didn’t complete.', 'error');
    const n = new URLSearchParams(params); n.delete('gmail'); n.delete('reason'); setParams(n, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading || !data) return <PageLoading />;
  const s = data.settings;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['showit'] }); void refetch(); };
  const save = async (patch: Partial<Settings>) => {
    try { await api.put('/integrations/showit/settings', patch); refresh(); toast('Saved'); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const connect = async () => {
    try {
      const { url } = await api.get<{ url: string }>('/integrations/gmail/connect');
      if (window.self !== window.top) window.open(url, '_blank', 'noopener'); else window.location.href = url;
    } catch (e) {
      if (reauth.handle(e, connect)) return;
      toast((e as Error).message, 'error');
    }
  };
  const disconnect = async () => {
    if (!window.confirm(`Disconnect ${data.connection.email}? The CRM stops reading website inquiries and Google’s access is removed. Inquiries already filed stay.`)) return;
    try { await api.post('/integrations/gmail/disconnect'); refresh(); toast('Disconnected'); } catch (e) { if (reauth.handle(e, disconnect)) return; toast((e as Error).message, 'error'); }
  };
  const check = async () => {
    setChecking(true);
    try { const r = await api.post<{ result: { skipped: string; read: number; processed: number; review: number } }>('/integrations/showit/check'); toast(r.result.skipped || `${r.result.read} read · ${r.result.processed} filed · ${r.result.review} to review`); refresh(); } catch (e) { toast((e as Error).message, 'error'); } finally { setChecking(false); }
  };
  const look = async () => {
    setLooking(true);
    try { setCandidates((await api.get<{ candidates: Candidate[] }>('/integrations/showit/candidates')).candidates); } catch (e) { toast((e as Error).message, 'error'); } finally { setLooking(false); }
  };
  const resolve = async (it: Item, action: 'extension' | 'general' | 'ignore', contact: { name?: string; email?: string; phone?: string } = {}) => {
    try { await api.post(`/integrations/showit/${encodeURIComponent(it.gmailId)}/resolve`, { action, ...contact }); refresh(); toast(action === 'ignore' ? 'Ignored' : 'Filed as a new-client inquiry'); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const review = data.history.filter((h) => h.status === 'review' || h.status === 'failed');

  return (
    <div className="space-y-5">
      {reauth.modal}
      <Card title="Gmail connection" description={`Showit sends each website form to ${s.account}. The CRM reads only verified Showit notifications there — never the rest of the inbox — labels them “${s.label}”, and leaves them in the inbox, so the emails keep arriving as before.`}>
        {data.connection.connected ? (
          <div className="flex flex-wrap items-center gap-3 text-[14px]">
            <ShieldCheck className="h-5 w-5 text-sage" />
            <span>Connected as <b className="font-medium">{data.connection.email}</b>{data.connection.connectedAt && <span className="text-stone"> · since {relative(data.connection.connectedAt)}</span>}</span>
            <Button size="sm" variant="ghost" icon={<Unplug className="h-4 w-4" />} className="ml-auto" onClick={disconnect}>Disconnect</Button>
          </div>
        ) : (
          <div className="space-y-2 text-[14px]">
            <p className="text-ink-soft">Not connected. Connecting opens Google’s own sign-in for <b className="font-medium text-ink">{s.account}</b> — the CRM never asks for the password. Only that mailbox is accepted.</p>
            <Button variant="primary" icon={<Link2 className="h-4 w-4" />} onClick={connect}>Connect Gmail</Button>
            <p className="text-[12px] text-stone">First time: add the Google OAuth client under <Link className="text-plum underline" to="/settings?tab=api">API &amp; Integrations</Link>.</p>
          </div>
        )}
      </Card>

      <Card title="Showit notifications" description="Look at real notifications first, then verify the sender. Nothing is filed until a sender is verified, and only notifications that arrive after that are brought in.">
        <div className="space-y-3 text-[14px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-stone">Verified senders:</span>
            {s.senders.length ? s.senders.map((x) => (
              <span key={x} className="inline-flex items-center gap-1 rounded-full border border-line bg-white py-1 pl-3 pr-1 font-mono text-[12px]">{x}
                <button type="button" className="rounded-full p-0.5 text-stone hover:text-ink" aria-label={`Remove ${x}`} onClick={() => save({ senders: s.senders.filter((y) => y !== x) })}><X className="h-3.5 w-3.5" /></button></span>
            )) : <span className="text-amber">None yet — nothing is read.</span>}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Add a sender"><input className="field w-64 font-mono" placeholder="the address Showit sends from" value={newSender} onChange={(e) => setNewSender(e.target.value)} /></Field>
            <Button disabled={!/^\S+@\S+\.\S+$/.test(newSender.trim())} onClick={() => { void save({ senders: [...s.senders, newSender.trim().toLowerCase()] }); setNewSender(''); }}>Verify sender</Button>
            <Button variant="ghost" loading={looking} disabled={!data.connection.connected} onClick={look}>Look at recent notifications</Button>
          </div>
          {candidates && (candidates.length ? (
            <ul className="space-y-2">
              {candidates.map((c) => (
                <li key={c.id} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{c.subject || '(no subject)'}</span>
                    <span className="font-mono text-[12px] text-stone">{c.from}</span>
                    <span className="text-[12px] text-stone">{relative(c.date)}</span>
                    {!s.senders.includes(c.sender) && <Button size="sm" className="ml-auto" onClick={() => save({ senders: [...s.senders, c.sender] })}>This is Showit — verify {c.sender}</Button>}
                  </div>
                  <p className="mt-1 text-[12px] text-stone">Reads as: {c.classification.kind ? (c.classification.kind === 'extension' ? 'Extension consultation' : 'General inquiry') : `Review — ${c.classification.reason}`}</p>
                  <dl className="mt-1 grid gap-x-3 text-[12px] sm:grid-cols-[minmax(0,14rem)_1fr]">
                    {c.fields.map((f, i) => <div key={i} className="contents"><dt className="truncate text-stone">{f.label}</dt><dd className="text-ink">{f.value}</dd></div>)}
                  </dl>
                </li>
              ))}
            </ul>
          ) : <p className="text-[13px] text-stone">No Showit-looking notifications in the last 120 days. If Showit sends from another address, add it above once you’ve checked one of its emails.</p>)}
          <Field label="Gmail label" hint="Created in the mailbox if it isn’t there.">
            <input className="field w-72" defaultValue={s.label} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== s.label && save({ label: e.target.value.trim() })} />
          </Field>
        </div>
      </Card>

      <Card title="Routing" description="The contact page’s form is the extension consultation form (checked Oct 2026: experience, goals, maintenance and pricing questions), so its submissions are extension consultations. Anything else is a general inquiry; anything unclear waits for review. Each submission gets one follow-up.">
        <div className="grid gap-3 text-[14px] sm:grid-cols-2">
          <Field label="Extension consultations go to" hint={s.extensionAssigneeId ? undefined : 'No one chosen: the front desk, flagged as an extension consultation.'}>
            <select className="field" value={s.extensionAssigneeId ?? ''} onChange={(e) => save({ extensionAssigneeId: e.target.value || null })}>
              <option value="">Front desk (flagged)</option>{data.staff.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </Field>
          <Field label="General inquiries go to (front desk)">
            <select className="field" value={s.frontDeskAssigneeId ?? ''} onChange={(e) => save({ frontDeskAssigneeId: e.target.value || null })}>
              <option value="">Unassigned (everyone who sees new clients)</option>{data.staff.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[13px]">
          <Toggle checked={s.enabled} onChange={(v) => save({ enabled: v })} label="Bring in new inquiries" description="Checked every few minutes while connected." />
          <Button size="sm" icon={<RefreshCw className={cx('h-4 w-4', checking && 'animate-spin')} />} loading={checking} disabled={!data.connection.connected} className="ml-auto" onClick={check}>Check now</Button>
        </div>
        {data.lastRun && <p className={cx('mt-2 text-[12px]', data.lastRun.ok ? 'text-stone' : 'text-rose')}>Last checked {relative(data.lastRun.at)}: {data.lastRun.message}</p>}
      </Card>

      <Card title="Submissions" description="What came in, and anything that needs review, is under Follow-Ups → Website inquiries.">
        <Link className="text-[14px] text-plum hover:underline" to="/follow-ups?view=inquiries">Open website inquiries{review.length ? ` (${review.length} to review)` : ''}</Link>
      </Card>
    </div>
  );
}

/** One notification waiting for review: its fields, contact details to fill in if missing, and how to file it. */
export function ReviewItem({ it, onResolve }: { it: Item; onResolve: (it: Item, action: 'extension' | 'general' | 'ignore', contact?: { name?: string; email?: string; phone?: string }) => void }) {
  const [c, setC] = useState({ name: it.contact.name ?? '', email: it.contact.email ?? '', phone: it.contact.phone ?? '' });
  return (
    <li className="rounded-lg border border-line p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS[it.status].tone}>{STATUS[it.status].label}</Badge>
        <span className="font-medium text-ink">{it.subject ?? '(no subject)'}</span>
        <span className="text-stone">{relative(it.receivedAt)}</span>
      </div>
      {it.reason && <p className="mt-1 text-amber">{it.reason}</p>}
      <dl className="mt-1 grid gap-x-3 text-[12px] sm:grid-cols-[minmax(0,14rem)_1fr]">
        {it.fields.map((f, i) => <div key={i} className="contents"><dt className="truncate text-stone">{f.label}</dt><dd className="text-ink">{f.value}</dd></div>)}
      </dl>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <input className="field h-9" placeholder="Name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} aria-label="Name" />
        <input className="field h-9" placeholder="Email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} aria-label="Email" />
        <input className="field h-9" placeholder="Phone" value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} aria-label="Phone" />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={() => onResolve(it, 'extension', c)}>File as extension consultation</Button>
        <Button size="sm" onClick={() => onResolve(it, 'general', c)}>File as general inquiry</Button>
        <Button size="sm" variant="ghost" onClick={() => onResolve(it, 'ignore')}>Ignore</Button>
      </div>
    </li>
  );
}
