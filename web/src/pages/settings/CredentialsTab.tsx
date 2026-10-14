import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleDashed, Eye, EyeOff, History, KeyRound, Lock, PlugZap, Power, PowerOff, Trash2, XCircle } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { useReauth } from '../../components/domain/Reauth';
import { relative } from '../../lib/format';
import { Badge, Button, Modal, Spinner, cx, useToast } from '../../components/ui';
import { Card } from './shared';

interface CredField {
  key: string; label: string; secret: boolean; group: string | null; required: boolean; placeholder: string | null; help: string | null;
  options: string[] | null; set: boolean; source: 'saved' | 'environment' | 'none'; value: string | null;
}
interface Integration {
  provider: string; label: string; requirement: string; status: 'connected' | 'not_configured' | 'error' | 'untested' | 'disabled'; disabled: boolean; missing: string[];
  unreadable: boolean; lastTestAt: string | null; lastTestOk: boolean | null; lastTestMessage: string | null; lastSuccessAt: string | null;
  updatedAt: string | null; fields: CredField[]; usedFor: string[];
}

const STATUS: Record<Integration['status'], { label: string; tone: 'sage' | 'neutral' | 'rose' | 'amber'; icon: typeof CheckCircle2 }> = {
  connected: { label: 'Connected', tone: 'sage', icon: CheckCircle2 },
  untested: { label: 'Saved — not tested yet', tone: 'amber', icon: CircleDashed },
  error: { label: 'Connection error', tone: 'rose', icon: XCircle },
  not_configured: { label: 'Not configured', tone: 'neutral', icon: CircleDashed },
  disabled: { label: 'Turned off', tone: 'neutral', icon: PowerOff },
};

/**
 * Settings → API & Integrations. Secrets are typed in, sent once to the server (encrypted there) and never shown
 * again: the server only says whether each is set. Leaving a secret box empty keeps the saved one.
 */
export function CredentialsSettings() {
  const { data, isLoading } = useQuery({ queryKey: ['credentials'], queryFn: () => api.get<{ integrations: Integration[]; demoMode: boolean }>('/admin/credentials') });
  if (isLoading || !data) return <div className="flex justify-center py-10"><Spinner /></div>;
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-xl2 border border-line bg-white px-4 py-3 text-[13px] text-ink-soft">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-stone" />
        <p>Keys and secrets are stored encrypted on the salon’s server. After saving, secrets are never shown again — not here, not in the browser, not in logs. To change one, type the new value. Values set in the server’s environment file are used unless you save one here.{data.demoMode && ' Demo Mode is on: the CRM uses demo data, but Test connection always checks the real service.'}</p>
      </div>
      {data.integrations.map((i) => <IntegrationCard key={i.provider} integration={i} />)}
      <ChangeHistory integrations={data.integrations} />
    </div>
  );
}

const ACTION: Record<string, string> = {
  'credentials.update': 'changed', 'credentials.update_rejected': 'tried to change (test failed — kept the working settings)',
  'credentials.remove': 'removed all saved keys for', 'credentials.disable': 'turned off', 'credentials.enable': 'turned on',
  'credentials.test': 'tested', 'integration.square_connected': 'connected', 'integration.square_disconnected': 'disconnected',
};

/** Who changed which integration, and when — names of fields only, never values. */
function ChangeHistory({ integrations }: { integrations: Integration[] }) {
  const { data } = useQuery({ queryKey: ['credentials-history'], queryFn: () => api.get<{ history: { action: string; provider: string | null; fields: string[]; at: string; by: string | null }[] }>('/admin/credentials/history').then((r) => r.history) });
  const rows = (data ?? []).filter((h) => h.action !== 'credentials.test').slice(0, 20);
  const labelOf = (p: string | null) => integrations.find((i) => i.provider === p)?.label ?? (p ? p : 'Square');
  const fieldLabel = (p: string | null, k: string) => integrations.find((i) => i.provider === p)?.fields.find((f) => f.key === k)?.label ?? k;
  return (
    <Card title={<span className="flex items-center gap-2"><History className="h-5 w-5 text-stone" />Recent changes</span>} description="Who changed which keys, and when. Values are never recorded.">
      {!rows.length ? <p className="text-[14px] text-stone">No changes yet.</p> : (
        <ul className="divide-y divide-line text-[14px]">
          {rows.map((h, n) => (
            <li key={n} className="py-2">
              <span className="text-ink">{h.by ?? 'Someone'}</span> <span className="text-ink-soft">{ACTION[h.action] ?? h.action}</span> <span className="text-ink">{labelOf(h.provider)}</span>
              {h.fields.length > 0 && <span className="text-ink-soft">: {h.fields.map((k) => fieldLabel(h.provider, k)).join(', ')}</span>}
              <span className="block text-[12px] text-stone">{relative(h.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function IntegrationCard({ integration: i }: { integration: Integration }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [clear, setClear] = useState<Set<string>>(new Set());
  const [reveal, setReveal] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [verifyFail, setVerifyFail] = useState<string | null>(null);
  const reauth = useReauth();
  const st = STATUS[i.status];
  const dirty = Object.values(values).some((v) => v.trim() !== '') || clear.size > 0;
  const update = (next: Integration) => {
    qc.setQueryData<{ integrations: Integration[]; demoMode: boolean }>(['credentials'], (old) => old && { ...old, integrations: old.integrations.map((x) => (x.provider === next.provider ? next : x)) });
    qc.invalidateQueries({ queryKey: ['integrations'] });
    qc.invalidateQueries({ queryKey: ['credentials-history'] });
  };

  const save = async (skipVerify = false) => {
    setBusy('save');
    setVerifyFail(null);
    try {
      const payload: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(values)) if (v.trim() !== '') payload[k] = v.trim();
      for (const k of clear) payload[k] = null;
      const r = await api.put<{ integration: Integration; changed: string[] }>(`/admin/credentials/${i.provider}`, { values: payload, skipVerify });
      update(r.integration);
      setValues({});
      setClear(new Set());
      // Confirm what changed by name only — never echo a value.
      toast(r.changed.length ? `Saved: ${r.changed.map((k) => i.fields.find((f) => f.key === k)?.label ?? k).join(', ')}. ${i.status === 'connected' && !skipVerify ? 'Tested and working.' : 'Now test the connection.'}` : 'Nothing changed');
    } catch (e) {
      if (reauth.handle(e, () => save(skipVerify))) return;
      // The new values didn't work: the server kept the working ones. Offer to save anyway.
      if (e instanceof ApiError && e.code === 'verification_failed') { setVerifyFail(e.message); return; }
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy('test');
    try {
      const r = await api.post<{ result: { ok: boolean; message: string; warnings?: string[] }; integration: Integration }>(`/admin/credentials/${i.provider}/test`);
      update(r.integration);
      toast(r.result.ok ? `${i.label}: ${r.result.message}` : r.result.message, r.result.ok ? undefined : 'error');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('remove');
    try {
      const r = await api.del<{ integration: Integration }>(`/admin/credentials/${i.provider}`);
      update(r.integration);
      setConfirmRemove(false);
      toast(`${i.label} credentials removed`);
    } catch (e) {
      if (reauth.handle(e, remove)) return;
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const toggle = async () => {
    setBusy('toggle');
    try {
      const r = await api.post<{ integration: Integration }>(`/admin/credentials/${i.provider}/${i.disabled ? 'enable' : 'disable'}`);
      update(r.integration);
      toast(i.disabled ? `${i.label} turned on` : `${i.label} turned off — its keys are kept, but not used`);
    } catch (e) {
      if (reauth.handle(e, toggle)) return;
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const hasSaved = i.fields.some((f) => f.source === 'saved');
  const groups = [...new Set(i.fields.map((f) => f.group).filter(Boolean))] as string[];

  return (
    <Card
      title={<span className="flex flex-wrap items-center gap-2">{i.label}<Badge tone={st.tone}><st.icon className="mr-1 inline h-3.5 w-3.5" />{st.label}</Badge></span>}
      description={i.requirement}
      footer={
        <>
          <span className="mr-auto text-[12px] text-stone">
            {i.lastTestAt ? <>Last checked {relative(i.lastTestAt)}{i.lastTestOk ? ' · OK' : ' · failed'}</> : 'Never tested'}
            {i.lastSuccessAt && !i.lastTestOk && <> · last worked {relative(i.lastSuccessAt)}</>}
          </span>
          {hasSaved && <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirmRemove(true)}>Remove</Button>}
          {(i.disabled || i.status !== 'not_configured') && <Button variant="ghost" icon={i.disabled ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />} loading={busy === 'toggle'} onClick={toggle}>{i.disabled ? 'Turn on' : 'Turn off'}</Button>}
          <Button icon={<PlugZap className="h-4 w-4" />} onClick={test} loading={busy === 'test'} disabled={dirty || i.status === 'not_configured' || i.disabled}>Test connection</Button>
          <Button variant="primary" onClick={() => save()} loading={busy === 'save'} disabled={!dirty}>Save</Button>
        </>
      }
    >
      {i.disabled && <p className="mb-3 rounded-lg bg-mist px-3 py-2 text-[13px] text-ink-soft">Turned off: the CRM doesn’t use {i.label} right now. Its keys are kept — turn it back on any time.</p>}
      {verifyFail && (
        <div className="mb-3 rounded-lg border border-rose/30 bg-rose/10 px-3 py-2 text-[13px] text-ink-soft" role="alert">
          <p className="text-rose">{verifyFail}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setVerifyFail(null); setValues({}); setClear(new Set()); }}>Keep the working settings</Button>
            <Button size="sm" variant="danger" loading={busy === 'save'} onClick={() => save(true)}>Save anyway</Button>
          </div>
        </div>
      )}
      {i.unreadable && (
        <p className="mb-3 flex items-start gap-2 rounded-lg bg-rose/10 px-3 py-2 text-[13px] text-rose"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />Saved credentials can’t be read — the server’s encryption key changed. Enter them again.</p>
      )}
      {i.missing.length > 0 && (
        <div className="mb-3 rounded-lg bg-amber/10 px-3 py-2 text-[13px] text-ink-soft">
          <p className="font-medium text-ink">Still needed</p>
          <ul className="mt-0.5 list-disc pl-5">{i.missing.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}
      {i.lastTestOk === false && i.lastTestMessage && <p className="mb-3 rounded-lg bg-rose/10 px-3 py-2 text-[13px] text-rose">{i.lastTestMessage}</p>}
      {i.lastTestOk && i.lastTestMessage && <p className="mb-3 text-[13px] text-sage">{i.lastTestMessage}</p>}
      {groups.length > 1 && <p className="mb-3 text-[12px] text-stone">Fill in one of the groups marked “Option A / Option B”.</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {i.fields.map((f) => {
          const groupIdx = f.group ? groups.indexOf(f.group) : -1;
          const willClear = clear.has(f.key);
          return (
            <div key={f.key} className={cx(f.secret && 'sm:col-span-2')}>
              <span className="label flex flex-wrap items-center gap-1.5">
                {f.secret ? <KeyRound className="h-3.5 w-3.5 text-stone" /> : null}
                {f.label}
                {f.required && <span className="text-rose">*</span>}
                {groupIdx >= 0 && groups.length > 1 && <Badge>{`Option ${String.fromCharCode(65 + groupIdx)}`}</Badge>}
                <Badge tone={f.secret ? 'plum' : 'neutral'}>{f.secret ? 'Secret' : 'Public ID'}</Badge>
                {f.set && !willClear && <Badge tone="sage">{f.source === 'saved' ? 'Saved' : 'From server environment'}</Badge>}
                {willClear && <Badge tone="rose">Will be removed</Badge>}
              </span>
              {f.options ? (
                <select className="field" value={values[f.key] ?? f.value ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                  {!f.value && <option value="">Default</option>}
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <div className="flex gap-2">
                  <input
                    type={f.secret && !reveal.has(f.key) ? 'password' : 'text'}
                    autoComplete="off" spellCheck={false}
                    className="field font-mono text-[13px]"
                    // Secrets are never prefilled: the box shows dots when one is saved, and stays empty to keep it.
                    placeholder={f.secret ? (f.set ? '•••••••••••• (saved — type to replace)' : f.placeholder ?? 'Paste here') : f.placeholder ?? ''}
                    value={values[f.key] ?? (f.secret ? '' : f.value ?? '')}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  />
                  {f.secret && (values[f.key] ?? '') !== '' && (
                    <button type="button" className="rounded-lg border border-line px-2 text-stone hover:text-ink" onClick={() => setReveal((r) => { const n = new Set(r); n.has(f.key) ? n.delete(f.key) : n.add(f.key); return n; })} aria-label={reveal.has(f.key) ? 'Hide what you typed' : 'Show what you typed'}>
                      {reveal.has(f.key) ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  )}
                </div>
              )}
              {f.help && <p className="mt-1 text-[12px] text-stone">{f.help}</p>}
              {f.source === 'saved' && !willClear && (
                <button type="button" className="mt-1 text-[12px] text-stone underline hover:text-rose" onClick={() => setClear((c) => new Set(c).add(f.key))}>Remove this saved value</button>
              )}
              {willClear && <button type="button" className="mt-1 text-[12px] text-plum underline" onClick={() => setClear((c) => { const n = new Set(c); n.delete(f.key); return n; })}>Keep it</button>}
            </div>
          );
        })}
      </div>

      {reauth.modal}
      {confirmRemove && (
        <Modal open onClose={() => setConfirmRemove(false)} title={`Remove ${i.label} credentials?`} footer={
          <><Button variant="ghost" onClick={() => setConfirmRemove(false)}>Cancel</Button><Button variant="danger" onClick={remove} loading={busy === 'remove'}>Remove</Button></>
        }>
          <p className="text-[15px] text-ink-soft">The saved {i.label} keys will be deleted from the CRM. Anything in the server’s environment file stays.</p>
          {i.usedFor.length > 0 && (
            <div className="mt-3 rounded-lg bg-amber/10 px-3 py-2 text-[13px] text-ink-soft">
              <p className="font-medium text-ink">{i.label} is in use:</p>
              <ul className="mt-1 list-disc pl-5">{i.usedFor.map((u) => <li key={u}>{u}</li>)}</ul>
              <p className="mt-1">These stop working until it’s connected again.</p>
            </div>
          )}
        </Modal>
      )}
    </Card>
  );
}
