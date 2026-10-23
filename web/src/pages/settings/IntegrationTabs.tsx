import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { HIGHLEVEL_AUTOMATION_LABELS, type HighLevelAutomationKey } from '@addendum/shared';
import { RefreshCw, Link2, Unplug, Send, ShieldCheck } from 'lucide-react';
import { api } from '../../api/client';
import { useReauth } from '../../components/domain/Reauth';
import { useIntegrations, useRefreshAll, useStaff } from '../../api/hooks';
import { dateTime, phone as fmtPhone, relative } from '../../lib/format';
import { Badge, Button, Field, Modal, Toggle, useToast } from '../../components/ui';
import { Card, CopyValue, SaveBar, StatusLine, useCan, useSection, type SetupInfo } from './shared';

export function useSetupInfo(enabled = true) {
  return useQuery({ queryKey: ['setup-info'], queryFn: () => api.get<SetupInfo>('/integrations/setup-info'), enabled, staleTime: 300_000 });
}

// ---------------------------------------------------------------- Square
export function SquareSettings({ compact }: { compact?: boolean }) {
  const { data: integ } = useIntegrations();
  const can = useCan();
  const { data: info } = useSetupInfo(can('settings:read'));
  const toast = useToast();
  const refresh = useRefreshAll();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  // Result of the Square OAuth redirect.
  useEffect(() => {
    const r = params.get('square');
    if (!r) return;
    if (r === 'connected') toast('Square connected ✓ Importing appointments now…');
    if (r === 'denied') toast('Square connection was cancelled.', 'error');
    if (r === 'failed') toast('Square could not be connected. Please try again.', 'error');
    const p = new URLSearchParams(params);
    p.delete('square');
    setParams(p, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!integ) return null;
  const sq = integ.square;
  const sync = async (full = false) => {
    setBusy(full ? 'full' : 'sync');
    try {
      const r = await api.post<{ result: { ok: boolean; message?: string; created?: number; updated?: number; cancelled?: number } }>('/integrations/square/sync', { full });
      if (r.result.ok) toast(`Synced with Square${r.result.created || r.result.updated ? ` · ${r.result.created ?? 0} new, ${r.result.updated ?? 0} changed` : ''}`);
      else toast(r.result.message ?? 'Sync failed. Your existing data is safe.', 'error');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const reauth = useReauth();
  const connect = async () => {
    setBusy('connect');
    try {
      const { url } = await api.get<{ url: string }>('/integrations/square/connect');
      // Square's authorization page can't load inside an iframe, so open it in a new tab when embedded.
      if (window.self !== window.top) {
        window.open(url, '_blank', 'noopener');
        setBusy(null);
      } else window.location.href = url;
    } catch (e) {
      setBusy(null);
      if (reauth.handle(e, connect)) return;
      toast((e as Error).message, 'error');
    }
  };
  const disconnect = async () => {
    setBusy('off');
    try {
      await api.post('/integrations/square/disconnect');
      toast('Square disconnected. Existing appointments are kept.');
      qc.invalidateQueries({ queryKey: ['integrations'] });
      setConfirmOff(false);
    } catch (e) {
      if (reauth.handle(e, disconnect)) return;
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const statusState = sq.needsReconnect ? 'warn' : sq.connected ? (sq.lastSyncStatus === 'failed' ? 'warn' : 'ok') : 'off';
  return (
    <Card
      title="Square"
      description="Square is the source of truth for appointments. This app only reads from Square — it never changes bookings."
    >
      <StatusLine state={statusState}>
        {sq.needsReconnect ? 'Square connection expired. Please reconnect.' : sq.connected ? `Square Connected ✓${sq.merchantName ? ` · ${sq.merchantName}` : ''}` : 'Square not connected'}
      </StatusLine>
      {integ.demoMode && <p className="mt-1 text-[13px] text-plum">Demo Mode — connected to a simulated Square account. No real salon data.</p>}
      {sq.connected && (
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt className="inline text-stone">Last sync: </dt><dd className="inline">{sq.lastSyncAt ? `${relative(sq.lastSyncAt)} (${dateTime(sq.lastSyncAt)})` : 'Never'}</dd></div>
          <div><dt className="inline text-stone">Environment: </dt><dd className="inline capitalize">{sq.environment}</dd></div>
          <div><dt className="inline text-stone">Live updates: </dt><dd className="inline">{sq.webhooksConfigured ? 'Webhooks on' : 'Checks every few minutes'}</dd></div>
          {sq.lastSyncStatus === 'failed' && <div className="sm:col-span-2 text-amber">{sq.lastSyncMessage ?? 'Sync failed. Your existing data is safe.'}</div>}
        </dl>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {sq.connected && can('square:sync') && <Button variant="primary" icon={<RefreshCw className="h-4 w-4" />} loading={busy === 'sync'} onClick={() => sync(false)}>Sync now</Button>}
        {sq.connected && can('integrations:manage') && !compact && <Button loading={busy === 'full'} onClick={() => sync(true)}>Re-import history</Button>}
        {can('integrations:manage') && !integ.demoMode && sq.mode !== 'access_token' && (
          <Button variant={sq.connected && !sq.needsReconnect ? 'secondary' : 'primary'} icon={<Link2 className="h-4 w-4" />} loading={busy === 'connect'} onClick={connect}>
            {sq.connected ? 'Reconnect' : 'Connect Square'}
          </Button>
        )}
        {sq.connected && sq.mode === 'oauth' && can('integrations:manage') && !compact && <Button variant="ghost" icon={<Unplug className="h-4 w-4" />} onClick={() => setConfirmOff(true)}>Disconnect</Button>}
      </div>
      {!integ.demoMode && sq.mode === 'access_token' && <p className="mt-3 text-[13px] text-stone">Connected with a server access token (SQUARE_ACCESS_TOKEN). To switch to OAuth, remove that variable on the server.</p>}

      {info && !compact && (
        <details className="mt-5 rounded-xl border border-line px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium text-ink">Developer setup details</summary>
          <p className="mt-3 text-stone">Create an app at developer.squareup.com, then add these values to the app's OAuth and Webhooks pages. Secrets live only in the server's environment variables.</p>
          <CopyValue label="OAuth redirect URL" value={info.square.redirectUri} />
          <CopyValue label="Webhook URL" value={info.square.webhookUrl} />
          <p className="mt-3 text-[13px] text-stone">Webhook events: {info.square.webhookEvents.join(', ')}</p>
          <p className="mt-1 text-[13px] text-stone">Permissions requested (read-only): {info.square.scopes.join(', ')}</p>
          <ul className="mt-3 space-y-1 text-[13px]">
            <EnvRow ok={info.square.oauthConfigured} name="SQUARE_APPLICATION_ID + SQUARE_APPLICATION_SECRET" />
            <EnvRow ok={info.square.webhookKeyConfigured} name="SQUARE_WEBHOOK_SIGNATURE_KEY" />
            <EnvRow ok={info.square.accessTokenConfigured} name="SQUARE_ACCESS_TOKEN (optional, single salon)" optional />
          </ul>
        </details>
      )}

      <Modal open={confirmOff} onClose={() => setConfirmOff(false)} title="Disconnect Square?" footer={<><Button variant="ghost" onClick={() => setConfirmOff(false)}>Keep connected</Button><Button variant="danger" loading={busy === 'off'} onClick={disconnect}>Disconnect</Button></>}>
        <p className="text-sm text-ink-soft">New bookings, cancellations and changes will stop coming in. Appointments already imported stay in the app, and you can reconnect any time.</p>
      </Modal>
      {reauth.modal}
    </Card>
  );
}

export function EnvRow({ ok, name, optional }: { ok: boolean; name: string; optional?: boolean }) {
  return <li className="flex items-center gap-2"><span className={ok ? 'text-sage' : optional ? 'text-stone-light' : 'text-amber'}>{ok ? '✓' : optional ? '–' : '!'}</span><code className="text-ink-soft">{name}</code><span className="text-stone">{ok ? 'set' : 'not set'}</span></li>;
}

// ---------------------------------------------------------------- Texting
export function SmsSettings({ compact }: { compact?: boolean }) {
  const { data: integ } = useIntegrations();
  const msg = useSection('messaging');
  if (!integ) return null;
  return (
    <div className="space-y-6">
      <Card title="Texting" description="Texts are sent from Apple Messages on your own Mac or iPhone — no texting service or subscription needed.">
        <StatusLine state="ok">Ready · uses Apple Messages on this device</StatusLine>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-ink-soft">
          <li>Click <b>Text</b> on a client or follow-up. Write the message or let the CRM draft it.</li>
          <li><b>Open in Messages</b> opens a conversation with the number and text filled in. Edit it if you like, and send it there.</li>
          <li>Come back and tap <b>I sent it</b> (or <b>I didn't send it</b>). The CRM can't see Messages, so it only records what you tell it.</li>
        </ol>
        {!compact && (
          <details className="mt-5 rounded-xl border border-line px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium text-ink">Setting up a Mac</summary>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-ink-soft">
              <li>Open the Messages app and sign in with the salon's Apple Account (Messages → Settings → iMessage).</li>
              <li>To text Android phones (green bubbles), also turn on <b>Text Message Forwarding</b> for this Mac on the salon iPhone: Settings → Apps → Messages → Text Message Forwarding.</li>
              <li>The first time, the browser asks whether to open Messages. Choose to always allow it.</li>
              <li>Replies arrive in Messages on the Mac and phone, not in the CRM.</li>
            </ul>
          </details>
        )}
      </Card>
      {msg.draft && !compact && (
        <Card title="Texting preferences" footer={<SaveBar dirty={msg.dirty} saving={msg.saving} onSave={() => msg.save()} onReset={msg.reset} />}>
          <Field label="Sign texts as" hint="Added to drafts." className="sm:w-80"><input className="field" value={msg.draft.signature} maxLength={80} onChange={(e) => msg.set('signature', e.target.value)} placeholder="— Addendum Salon" /></Field>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- HighLevel
export function HighLevelSettings({ compact }: { compact?: boolean }) {
  const { data: integ } = useIntegrations();
  const can = useCan();
  const { data: info } = useSetupInfo(can('settings:read'));
  const hl = useSection('highlevel');
  const { data: staff } = useStaff();
  const { data: hlUsers } = useQuery({ queryKey: ['hl-users'], queryFn: () => api.get<{ users: { id: string; name: string; email: string | null }[]; error?: string }>('/integrations/highlevel/users'), enabled: !!integ?.highlevel.connected });
  const toast = useToast();
  const qc = useQueryClient();
  const [testing, setTesting] = useState(false);
  if (!integ) return null;
  const users = hlUsers?.users ?? [];
  const test = async () => {
    setTesting(true);
    const r = await api.post<{ ok: boolean; message: string }>('/integrations/highlevel/test').catch((e) => ({ ok: false, message: (e as Error).message }));
    toast(r.message, r.ok ? 'success' : 'error');
    setTesting(false);
  };
  const mapStaff = async (id: string, highlevelUserId: string | null) => {
    try {
      await api.patch(`/staff/${id}`, { highlevelUserId });
      qc.invalidateQueries({ queryKey: ['staff'] });
      toast('Mapping saved');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="space-y-6">
      <Card title="GoHighLevel" description="Optional. Push follow-ups into HighLevel as tasks. Your follow-ups keep working here even if HighLevel is down.">
        <StatusLine state={integ.highlevel.connected ? (integ.highlevel.simulateOutage ? 'warn' : 'ok') : 'off'}>
          {integ.highlevel.connected ? (integ.highlevel.simulateOutage ? 'HighLevel unavailable (simulated outage)' : 'HighLevel connected ✓') : 'HighLevel not connected'}
        </StatusLine>
        {integ.highlevel.locationId && <p className="mt-1 text-sm text-ink-soft">Location: <code className="text-[13px]">{integ.highlevel.locationId}</code></p>}
        {integ.highlevel.pendingRetries > 0 && <p className="mt-1 text-sm text-amber">{integ.highlevel.pendingRetries} task{integ.highlevel.pendingRetries === 1 ? '' : 's'} waiting to retry. They'll go through automatically when HighLevel is reachable.</p>}
        {integ.demoMode && <p className="mt-1 text-[13px] text-plum">Demo Mode — a simulated HighLevel account. Toggle an outage in Settings → Demo tools to see retries.</p>}
        {integ.highlevel.connected && can('integrations:manage') && <Button className="mt-4" loading={testing} onClick={test}>Test connection</Button>}
        {!integ.highlevel.connected && !compact && <p className="mt-3 text-sm text-stone">To connect, your developer adds a HighLevel Private Integration token and Location ID to the server settings (see setup details below).</p>}
        {info && !compact && (
          <details className="mt-5 rounded-xl border border-line px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium text-ink">Developer setup details</summary>
            <p className="mt-3 text-stone">In HighLevel: Sub-account Settings → Private Integrations → Create. Grant these scopes, then set HIGHLEVEL_PRIVATE_TOKEN and HIGHLEVEL_LOCATION_ID on the server.</p>
            <p className="mt-2 text-[13px] text-ink-soft">{info.highlevel.scopes.join(', ')}</p>
            <ul className="mt-3 space-y-1 text-[13px]"><EnvRow ok={info.highlevel.configured} name="HIGHLEVEL_PRIVATE_TOKEN + HIGHLEVEL_LOCATION_ID" /></ul>
          </details>
        )}
      </Card>

      {integ.highlevel.connected && hl.draft && (
        <>
          <Card title="Who gets HighLevel tasks" description="Match each team member to their HighLevel user. Unmatched follow-ups go to the default assignee.">
            {hlUsers?.error && <p className="mb-3 text-sm text-amber">{hlUsers.error}</p>}
            <ul className="divide-y divide-line">
              {staff?.filter((s) => s.active).map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span className="flex items-center gap-2 text-sm"><span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />{s.name}</span>
                  <select className="field h-9 w-full py-1 text-sm sm:w-64" value={s.highlevelUserId ?? ''} onChange={(e) => mapStaff(s.id, e.target.value || null)} disabled={!can('settings:read')} aria-label={`HighLevel user for ${s.name}`}>
                    <option value="">Not matched — use default</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.name}{u.email ? ` (${u.email})` : ''}</option>)}
                  </select>
                </li>
              ))}
            </ul>
            <div className="mt-4 border-t border-line pt-4">
              <Field label="Default HighLevel assignee">
                <select className="field sm:w-72" value={hl.draft.defaultAssigneeUserId ?? ''} onChange={(e) => hl.set('defaultAssigneeUserId', e.target.value || null)}>
                  <option value="">Unassigned</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </Field>
              <Toggle label="Create missing contacts automatically" description="If no HighLevel contact matches by ID, phone or email, create one instead of asking first." checked={hl.draft.autoCreateContacts} onChange={(v) => hl.set('autoCreateContacts', v)} />
            </div>
            <div className="mt-2 flex justify-end gap-2"><SaveBar dirty={hl.dirty} saving={hl.saving} onSave={() => hl.save()} onReset={hl.reset} disabled={!can('integrations:manage')} /></div>
          </Card>

          {!compact && (
            <Card title="Automatic HighLevel tasks" description="Choose which events create a HighLevel task on their own. Everything else can still be pushed with one click." footer={<SaveBar dirty={hl.dirty} saving={hl.saving} onSave={() => hl.save()} onReset={hl.reset} disabled={!can('integrations:manage')} />}>
              <div className="divide-y divide-line">
                {(Object.keys(HIGHLEVEL_AUTOMATION_LABELS) as HighLevelAutomationKey[]).map((k) => (
                  <Toggle key={k} label={HIGHLEVEL_AUTOMATION_LABELS[k]} checked={!!hl.draft!.automations[k]} onChange={(v) => hl.set('automations', { ...hl.draft!.automations, [k]: v })} />
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- AI
export function AiSettings() {
  const { data: integ } = useIntegrations();
  const ai = useSection('ai');
  if (!ai.draft || !integ) return null;
  return (
    <Card
      title="AI assistance"
      description={integ.ai.provider === 'anthropic' ? 'Drafts are written by Claude on the server. Client details are sent only when you ask for a draft.' : 'Using built-in reply templates. Add ANTHROPIC_API_KEY on the server for AI-written drafts.'}
      footer={<SaveBar dirty={ai.dirty} saving={ai.saving} onSave={() => ai.save()} onReset={ai.reset} />}
    >
      <Toggle label="Turn on AI drafting" description="Recognises what a text is about (service, timeframe) and offers “Generate reply”." checked={ai.draft.enabled} onChange={(v) => ai.set('enabled', v)} />
      <Field label="Voice and tone" className="mt-2" hint="How drafts should sound.">
        <textarea className="field min-h-[70px]" value={ai.draft.tone} maxLength={300} onChange={(e) => ai.set('tone', e.target.value)} />
      </Field>
      <p className="mt-3 flex items-center gap-2 text-[13px] text-stone">Provider: <Badge>{integ.ai.provider === 'anthropic' ? 'Claude (Anthropic)' : 'Built-in templates'}</Badge></p>
    </Card>
  );
}
