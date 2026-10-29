import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import { Badge, Button, Field, Modal, PageLoading, Toggle, buttonClass, chipClass, useToast } from '../../components/ui';
import type { Basics } from './common';

interface ShareLink { id: string; name: string; url: string; accounts: string[]; expiresOn: string | null; active: boolean; allowNotes: boolean; createdAt: string; lastViewedAt: string | null }

/**
 * Share links for creators (no CRM account needed): each opens a read-only calendar of the shared posts only — approved
 * posts, and any set to "Always share" — never drafts set to share once approved. Turn a link off any time.
 */
export function ShareLinks({ b, onClose }: { b: Basics; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['content-share-links'], queryFn: () => api.get<{ links: ShareLink[] }>('/content/share-links').then((r) => r.links) });
  const [d, setD] = useState({ name: '', accounts: [] as string[], expiresOn: '', allowNotes: true });
  const [busy, setBusy] = useState(false);
  const set = (links: ShareLink[]) => qc.setQueryData(['content-share-links'], links);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ links: ShareLink[] }>('/content/share-links', { name: d.name, accounts: d.accounts, expiresOn: d.expiresOn || null, allowNotes: d.allowNotes });
      set(r.links);
      setD({ name: '', accounts: [], expiresOn: '', allowNotes: true });
      void copy(r.links[0]);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const patch = async (l: ShareLink, body: Partial<ShareLink>) => { try { set((await api.patch<{ links: ShareLink[] }>(`/content/share-links/${l.id}`, body)).links); } catch (e) { toast((e as Error).message, 'error'); } };
  const del = async (l: ShareLink) => { if (!window.confirm(`Delete ${l.name}’s link? It stops working straight away.`)) return; try { set((await api.del<{ links: ShareLink[] }>(`/content/share-links/${l.id}`)).links); } catch (e) { toast((e as Error).message, 'error'); } };
  const copy = async (l: ShareLink) => { try { await navigator.clipboard.writeText(l.url); toast(`Link for ${l.name} copied — send it to them`); } catch { window.prompt('Copy this link', l.url); } };
  const toggleAccount = (id: string) => setD({ ...d, accounts: d.accounts.includes(id) ? d.accounts.filter((x) => x !== id) : [...d.accounts, id] });
  return (
    <Modal open wide onClose={onClose} title="Share with creators" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <p className="mb-4 text-[13px] text-stone">A private link shows only shared posts: approved ones (and any set to <b className="font-medium text-ink-soft">Always share</b>). Drafts and unfinished posts stay hidden — set each post’s sharing at the top of the post. Creators can copy captions, download photos and leave notes; they can’t change anything.</p>
      <div className="mb-5 rounded-xl border border-line p-3">
        <p className="label">New link</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Who it’s for"><input className="field" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. Maya (photographer)" /></Field>
          <Field label="Stops working on (optional)"><input type="date" className="field" value={d.expiresOn} onChange={(e) => setD({ ...d, expiresOn: e.target.value })} /></Field>
        </div>
        <Field label="Accounts" hint="None chosen = every account" className="mt-3">
          <div className="flex flex-wrap gap-1.5">{b.mine.map((a) => <button key={a.id} type="button" aria-pressed={d.accounts.includes(a.id)} className={chipClass(d.accounts.includes(a.id))} onClick={() => toggleAccount(a.id)}>{a.name}</button>)}</div>
        </Field>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Toggle checked={d.allowNotes} onChange={(v) => setD({ ...d, allowNotes: v })} label="They can leave notes" />
          <Button variant="primary" className="ml-auto" icon={<Plus className="h-4 w-4" />} loading={busy} disabled={!d.name.trim()} onClick={create}>Create link</Button>
        </div>
      </div>
      {!data ? <PageLoading /> : !data.length ? <p className="text-[13px] text-stone">No links yet.</p> : (
        <ul className="space-y-2">{data.map((l) => (
          <li key={l.id} className="panel space-y-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 text-[15px] font-medium text-ink">{l.name}</span>
              <Badge tone={l.active ? 'sage' : 'neutral'}>{l.active ? 'On' : 'Off'}</Badge>
            </div>
            <p className="text-[12px] text-stone">{[l.accounts.length ? l.accounts.map((a) => b.accountOf(a as never)?.name ?? a).join(', ') : 'All accounts', l.expiresOn ? `until ${new Date(`${l.expiresOn}T12:00`).toLocaleDateString()}` : 'no end date', l.allowNotes ? 'notes on' : 'notes off', l.lastViewedAt ? `last opened ${new Date(l.lastViewedAt).toLocaleDateString()}` : 'not opened yet'].join(' · ')}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy(l)}>Copy link</Button>
              <a className={buttonClass('secondary', 'sm')} href={l.url} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /><span className="btn-label">See what they see</span></a>
              <Button size="sm" variant="ghost" onClick={() => patch(l, { active: !l.active })}>{l.active ? 'Turn off' : 'Turn on'}</Button>
              <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => del(l)}>Delete</Button>
            </div>
          </li>
        ))}</ul>
      )}
    </Modal>
  );
}
