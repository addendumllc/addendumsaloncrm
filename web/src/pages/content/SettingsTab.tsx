import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CONTENT_PLATFORMS, type ContentAccount, type ContentPlatform, type ContentSettings } from '@addendum/shared';
import { api } from '../../api/client';
import { Badge, Button, Field, Toggle, useToast } from '../../components/ui';
import type { Basics } from './common';

/** Administrators: the accounts (name, handle, colour, CTA, voice, pillars), approval, weekly goals, who works on each account and connections. */
export function SettingsTab({ b }: { b: Basics }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [accounts, setAccounts] = useState(b.accounts.map((a) => ({ ...a, pillarsText: a.pillars.join('\n') })));
  const [s, setS] = useState<ContentSettings>(b.settings ?? { requireApproval: true, goals: {}, access: {} });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/content/accounts', { accounts: accounts.map((a) => ({ id: a.id, name: a.name, handle: a.handle, color: a.color, cta: a.cta, voice: a.voice, pillars: a.pillarsText.split('\n').map((x) => x.trim()).filter(Boolean) })) });
      await api.put('/content/settings', s);
      for (const k of ['content-accounts', 'content-settings', 'content-planning']) void qc.invalidateQueries({ queryKey: [k] });
      toast('Saved');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const upd = (i: number, p: Partial<(typeof accounts)[number]>) => setAccounts(accounts.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const goal = (a: ContentAccount['id'], pl: ContentPlatform, v: number) => setS({ ...s, goals: { ...s.goals, [a]: { ...(s.goals[a] ?? {}), [pl]: v } } });
  return (
    <div className="space-y-6 text-[14px]">
      <section className="panel space-y-3 p-4">
        <h2 className="text-[15px] font-medium text-ink">Approval</h2>
        <Toggle checked={s.requireApproval} onChange={(v) => setS({ ...s, requireApproval: v })} label="Posts need approval before they’re scheduled" description="Approvers (Approve content) approve or request changes; publishers (Schedule and publish content) schedule and confirm. Give these in Users & Roles." />
      </section>
      {accounts.map((a, i) => (
        <section key={a.id} className="panel space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2"><input type="color" className="color-circle h-8 w-8 cursor-pointer overflow-hidden rounded-full border border-line-strong p-0" value={a.color} onChange={(e) => upd(i, { color: e.target.value })} aria-label="Colour" />
            <h2 className="text-[15px] font-medium text-ink">{a.name}</h2>{a.connected ? <Badge tone="sage">Instagram connected</Badge> : <Badge>Instagram not connected — manual publishing</Badge>}</div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name"><input className="field" value={a.name} onChange={(e) => upd(i, { name: e.target.value })} /></Field>
            <Field label="Handle"><input className="field" value={a.handle} onChange={(e) => upd(i, { handle: e.target.value })} /></Field>
            <Field label="Primary call to action"><input className="field" value={a.cta} onChange={(e) => upd(i, { cta: e.target.value })} /></Field>
            <Field label="Voice (used for AI drafts)" className="sm:col-span-3"><textarea className="field min-h-[60px]" value={a.voice} onChange={(e) => upd(i, { voice: e.target.value })} /></Field>
            <Field label="Content pillars" hint="One per line." className="sm:col-span-2"><textarea className="field min-h-[120px]" value={a.pillarsText} onChange={(e) => upd(i, { pillarsText: e.target.value })} /></Field>
            <div className="space-y-2">
              <span className="label">Weekly goals</span>
              {CONTENT_PLATFORMS.map((p) => <label key={p.value} className="flex items-center justify-between gap-2 text-[13px]">{p.label}<input className="field h-8 w-16 py-0 text-right num" inputMode="numeric" value={s.goals[a.id]?.[p.value] ?? ''} onChange={(e) => goal(a.id, p.value, Number(e.target.value.replace(/\D/g, '')) || 0)} /></label>)}
            </div>
          </div>
          <Field label="Who works on this account" hint="None ticked = everyone with Content calendar. Administrators always can.">
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">{b.staff.map((st) => (
              <label key={st.id} className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" className="h-4 w-4 accent-plum" checked={(s.access[a.id] ?? []).includes(st.id)}
                onChange={(e) => setS({ ...s, access: { ...s.access, [a.id]: e.target.checked ? [...(s.access[a.id] ?? []), st.id] : (s.access[a.id] ?? []).filter((x) => x !== st.id) } })} />{st.name}</label>
            ))}</div>
          </Field>
        </section>
      ))}
      <section className="panel p-4 text-[13px] text-ink-soft">
        <h2 className="mb-1 text-[15px] font-medium text-ink">Connections</h2>
        <p>Instagram auto-posting and metric import: <Link className="text-plum hover:underline" to="/settings?tab=api">Settings → API & Integrations → Instagram</Link> (accounts 1, 2 and 3 are the accounts above, in order). Facebook, TikTok, Pinterest and email are planned and confirmed by hand, with numbers entered on each post — their direct publishing isn’t connected.</p>
      </section>
      <div className="flex justify-end"><Button variant="primary" loading={busy} onClick={save}>Save settings</Button></div>
    </div>
  );
}
