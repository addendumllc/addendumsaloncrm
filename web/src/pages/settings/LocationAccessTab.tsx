import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { approvedNetworks, type AccessSettings, type AccessStatusDTO } from '@addendum/shared';
import { AlertTriangle, CheckCircle2, Plus, ShieldCheck, Trash2, Wifi, WifiOff } from 'lucide-react';
import { api } from '../../api/client';
import { useSettings } from '../../api/hooks';
import { useAccessStatus } from '../../components/layout/NetworkBlocked';
import { Badge, Button, Field, Modal, Spinner, Toggle, cx, useToast } from '../../components/ui';
import { Card } from './shared';

/**
 * Settings → Location & Access: the salon's public IP address and "Allow Access Anywhere". Owners/Admins only; the
 * server checks every request and requires the Admin's password to save. Never changes anyone's permissions.
 */
export function LocationAccessSettings() {
  const { data: status, isLoading } = useAccessStatus();
  const { data: settings } = useSettings();
  const toast = useToast();
  const qc = useQueryClient();
  const raw = settings?.settings.access;
  // Unnamed IPs from earlier versions show as a network named "Salon".
  const saved = raw ? { allowAnywhere: raw.allowAnywhere, restrictMobile: raw.restrictMobile, networks: approvedNetworks(raw) } : undefined;
  const [draft, setDraft] = useState<Omit<AccessSettings, 'salonIps'> | null>(null);
  const [newIp, setNewIp] = useState('');
  const [newName, setNewName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (saved && !draft) setDraft(saved); }, [saved, draft]); // eslint-disable-line react-hooks/exhaustive-deps
  if (isLoading || !status || !draft || !saved) return <div className="flex justify-center py-10"><Spinner /></div>;

  const can = status.canManage;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const ips = draft.networks.map((n) => n.ip);
  const suggestedName = draft.networks.length === 0 ? 'Salon' : draft.networks.some((n) => n.name.toLowerCase() === 'office') ? '' : 'Office';
  const addNetwork = (ip: string) => {
    const v = ip.trim();
    const name = (newName.trim() || suggestedName || 'Network').slice(0, 40);
    if (!v || ips.includes(v)) return;
    setDraft({ ...draft, networks: [...draft.networks, { name, ip: v }] });
    setNewIp('');
    setNewName('');
  };
  const rename = (ip: string, name: string) => setDraft({ ...draft, networks: draft.networks.map((n) => (n.ip === ip ? { ...n, name } : n)) });
  // Saving with restrictions that would shut this computer out deserves a warning.
  const locksMeOut = !draft.allowAnywhere && ips.length > 0 && !ips.includes(status.ip) && (!status.mobile || draft.restrictMobile);
  const unnamed = draft.networks.some((n) => !n.name.trim());

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.put<{ access: AccessSettings; status: AccessStatusDTO }>('/access', { ...draft, password });
      qc.setQueryData(['access-status'], r.status);
      await qc.invalidateQueries({ queryKey: ['settings'] });
      setDraft({ allowAnywhere: r.access.allowAnywhere, restrictMobile: r.access.restrictMobile, networks: approvedNetworks(r.access) });
      setConfirming(false);
      setPassword('');
      toast('Location & Access saved — it applies straight away.');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <ConnectionStatus status={status} />
      {status.overridden && (
        <p className="flex items-start gap-2 rounded-xl2 border border-amber/30 bg-amber/10 px-4 py-3 text-[14px] text-ink-soft">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" />The server’s recovery switch (ACCESS_ALLOW_ANYWHERE) is on, so nothing is restricted right now. Remove it from the server settings once the salon IP is correct.
        </p>
      )}

      <Card title="Approved networks" description="The public internet addresses of your salon, office and any other approved locations. Computers on these connections can use the CRM when Allow Access Anywhere is off.">
        {draft.networks.length === 0 ? (
          <p className="rounded-lg bg-mist px-3 py-2 text-[14px] text-ink-soft">No approved network yet, so nothing is restricted. Add the salon (and office) from a device on that network.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {draft.networks.map((n) => (
              <li key={n.ip} className="flex min-h-[56px] flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap sm:gap-3">
                <input className="field h-10 min-w-0 flex-1 sm:max-w-[200px]" value={n.name} maxLength={40} disabled={!can} onChange={(e) => rename(n.ip, e.target.value)} aria-label={`Name for ${n.ip}`} placeholder="Name, e.g. Office" />
                <span className="flex-1 font-mono text-[14px] text-ink">{n.ip}</span>
                {n.ip === status.ip && <Badge tone="sage">This connection</Badge>}
                {can && <button type="button" className="rounded-lg p-2 text-stone hover:bg-mist hover:text-rose" aria-label={`Remove ${n.name || n.ip}`} onClick={() => setDraft({ ...draft, networks: draft.networks.filter((x) => x.ip !== n.ip) })}><Trash2 className="h-4 w-4" /></button>}
              </li>
            ))}
          </ul>
        )}
        {can && (
          <div className="mt-4 space-y-2 rounded-xl border border-dashed border-line-strong p-3">
            <p className="text-[14px] font-medium text-ink">Add a network</p>
            <Field label="Name"><input className="field h-11" value={newName} maxLength={40} onChange={(e) => setNewName(e.target.value)} placeholder={suggestedName ? `e.g. ${suggestedName}` : 'e.g. Back office'} /></Field>
            {!ips.includes(status.ip) && status.ip && (
              <Button variant="primary" className="h-11 w-full sm:w-auto" icon={<Wifi className="h-4 w-4" />} onClick={() => addNetwork(status.ip)}>Add this connection ({status.ip})</Button>
            )}
            <div className="flex gap-2">
              <input className="field h-11 font-mono" value={newIp} onChange={(e) => setNewIp(e.target.value)} placeholder="Or type its IP, e.g. 203.0.113.10" aria-label="Network IP address" onKeyDown={(e) => e.key === 'Enter' && addNetwork(newIp)} />
              <Button className="h-11" icon={<Plus className="h-4 w-4" />} disabled={!newIp.trim()} onClick={() => addNetwork(newIp)}>Add</Button>
            </div>
            <p className="text-[12px] text-stone">To add the office, open this page on a device connected to the office internet and tap “Add this connection” — or ask your provider for the office’s public IP and type it. If a provider changes an address, update it here (from a phone on that Wi-Fi if no computer can get in).</p>
          </div>
        )}
      </Card>

      <Card title="Access restrictions" footer={can && (
        <>
          {dirty && <span className="mr-auto text-[13px] text-amber">Unsaved changes</span>}
          {dirty && <Button variant="ghost" onClick={() => setDraft(saved)}>Discard</Button>}
          <Button variant="primary" disabled={!dirty || unnamed} onClick={() => setConfirming(true)}>Save</Button>
        </>
      )}>
        <div className="space-y-4">
          <div className="rounded-xl border border-line p-3">
            <Toggle checked={draft.allowAnywhere} disabled={!can} onChange={(v) => setDraft({ ...draft, allowAnywhere: v })} label={`Allow Access Anywhere: ${draft.allowAnywhere ? 'ON' : 'OFF'}`}
              description={draft.allowAnywhere ? 'ON: the CRM works from any network — salon, office, home or elsewhere — after signing in, within each person’s role.' : 'OFF: on a computer, the CRM only works on the approved networks above. Phones and tablets keep working as usual.'} />
          </div>
          <div className="rounded-xl border border-line p-3">
            <Toggle checked={draft.restrictMobile} disabled={!can || draft.allowAnywhere} onChange={(v) => setDraft({ ...draft, restrictMobile: v })} label="Restrict phones and tablets too"
              description="Off by default. When on, phones and tablets also need the salon network. Use it if you want the strictest control: the phone-or-computer check relies on what the browser reports." />
          </div>
          <div className="rounded-xl border border-line bg-mist/40 p-3 text-[13px] text-ink-soft">
            <p className="font-medium text-ink">Exceptions for some people</p>
            <p className="mt-1">While Allow Access Anywhere is off, you can still let chosen people or roles in from anywhere. In <b>Users &amp; Permissions</b> (one person) or <b>Role templates</b> (a whole role), under <b>Location and access</b>, turn on:</p>
            <ul className="mt-1 list-disc pl-5">
              <li><b>Use the app from anywhere</b>: the whole app, on any network.</li>
              <li><b>Away from the salon: …</b> (Dashboard, Appointments, Follow-Ups &amp; Tasks, Clients, Messages, Order Hair, Earnings & Goals): away from the approved networks they see only the sections you turn on.</li>
            </ul>
          </div>
          <p className="flex items-start gap-2 text-[13px] text-stone"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />These rules decide where the CRM can be used, never what someone can do. Everyone still signs in with their own login (no Square account needed), and their role decides their access — being at the salon adds nothing.</p>
          {!can && <p className="text-[13px] text-stone">Only an Owner or Admin can change these settings.</p>}
        </div>
      </Card>

      {confirming && (
        <Modal open onClose={() => setConfirming(false)} title="Confirm with your password" footer={<><Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!password} onClick={save}>Save</Button></>}>
          <div className="space-y-3">
            {locksMeOut && (
              <p className="flex items-start gap-2 rounded-lg bg-rose-tint px-3 py-2 text-[13px] text-ink-soft"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose" />This connection ({status.ip}) isn’t in the list, so this device will lose access as soon as you save.</p>
            )}
            <Field label="Your password"><input className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && password && save()} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ConnectionStatus({ status }: { status: AccessStatusDTO }) {
  const ok = status.onSalonNetwork;
  return (
    <div className={cx('flex items-start gap-3 rounded-xl2 border px-4 py-3', ok ? 'border-sage/30 bg-sage-tint' : 'border-line bg-white')}>
      {ok ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-sage" /> : <WifiOff className="mt-0.5 h-5 w-5 shrink-0 text-stone" />}
      <div className="min-w-0 text-[14px]">
        <p className="font-medium text-ink">{ok ? `Connected through ${status.networkName ? `the ${status.networkName} network` : 'an approved network'}` : status.configured ? 'Not on an approved network' : 'No approved network set up yet'}</p>
        <p className="text-stone">This {status.mobile ? 'phone or tablet' : 'computer'} · <span className="font-mono">{status.ip || 'unknown IP'}</span>{!ok && status.allowAnywhere ? ' · allowed: Access Anywhere is on' : ''}</p>
      </div>
    </div>
  );
}
