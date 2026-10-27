import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, CalendarPlus, Heart, Mail, Plus, Search, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import { CONTENT_FORMATS, CONTENT_PLATFORMS, type ContentAccountId, type ContentIdeaDTO, type ContentPlatform, type ContentPostType } from '@addendum/shared';
import { api } from '../../api/client';
import { Badge, Button, EmptyState, Field, Modal, PageLoading, Segmented, cx, useToast } from '../../components/ui';
import { AccountTag, formatLabel, platformLabel, type Basics } from './common';
import type { Prefill } from './PostEditor';

const EFFORT = { low: 'Quick', medium: 'Some work', high: 'Production' } as const;

/** Post ideas: the built-in library and the team's own, by account — favourite them, add to the calendar, or draft with AI. */
export function IdeasTab({ b, onUse }: { b: Basics; onUse: (p: Prefill) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['content-ideas'], queryFn: () => api.get<{ ideas: ContentIdeaDTO[] }>('/content/ideas').then((r) => r.ideas) });
  const [f, setF] = useState({ q: '', account: '', pillar: '', format: '', favorites: false, channel: 'all' as 'all' | 'social' | 'email' });
  const [editing, setEditing] = useState<ContentIdeaDTO | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const fresh = (data ?? []).filter((i) => i.suggested && (f.channel === 'all' || (f.channel === 'email') === (i.platform === 'email')) && (!f.account || i.accounts.includes(f.account as ContentAccountId)));
  const suggestMore = async () => {
    setSuggesting(true);
    try {
      const r = await api.post<{ added: number; ideas: ContentIdeaDTO[] }>('/content/ideas/suggest', { accounts: f.account ? [f.account] : undefined });
      qc.setQueryData(['content-ideas'], r.ideas);
      toast(r.added ? `${r.added} new idea${r.added === 1 ? '' : 's'} — save the ones you like` : 'No new ideas this time — try again');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setSuggesting(false); }
  };
  const keep = async (i: ContentIdeaDTO) => { qc.setQueryData(['content-ideas'], (await api.put<{ ideas: ContentIdeaDTO[] }>(`/content/ideas/${i.id}/keep`)).ideas); toast('Saved to the library'); };
  const dismiss = async (i: ContentIdeaDTO) => { qc.setQueryData(['content-ideas'], (await api.del<{ ideas: ContentIdeaDTO[] }>(`/content/ideas/${i.id}`)).ideas); };
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = (data ?? []).filter((i) => !i.suggested && (f.channel === 'all' || (f.channel === 'email') === (i.platform === 'email')) && (!f.account || i.accounts.includes(f.account as ContentAccountId)) && (!f.pillar || i.pillar === f.pillar) && (!f.format || i.format === f.format) && (!f.favorites || i.favorite)
    && words.every((w) => `${i.title} ${i.pillar} ${i.hook ?? ''} ${i.caption ?? ''} ${i.season ?? ''} ${i.subject ?? ''}`.toLowerCase().includes(w)))
    .sort((a, x) => Number(x.favorite) - Number(a.favorite));
  const pillars = [...new Set((data ?? []).map((i) => i.pillar))].sort();
  const fav = async (i: ContentIdeaDTO) => { await api.put(`/content/ideas/${i.id}/favorite`, { on: !i.favorite }); void qc.invalidateQueries({ queryKey: ['content-ideas'] }); };
  // An idea for several accounts is cross-posted: all its accounts ticked, each on its own day.
  const toCalendar = (i: ContentIdeaDTO, extra: Partial<Prefill> = {}) => onUse({
    accounts: f.account ? [f.account as ContentAccountId] : i.accounts, title: i.title, platform: i.platform, type: i.format, headline: i.hook,
    caption: i.platform === 'email' ? [i.previewText, i.shotList].filter(Boolean).join('\n\n') : i.caption ?? '', cta: i.cta, hashtags: i.hashtags, pillar: i.pillar, ideaId: i.id,
    notes: [i.visual && `Visual: ${i.visual}`, i.platform !== 'email' && i.shotList && `Shot list:\n${i.shotList}`, i.sendTiming && `Send: ${i.sendTiming}`].filter(Boolean).join('\n\n'),
    ...(i.platform === 'email' ? { email: { subject: i.subject, previewText: i.previewText } } : {}), ...extra,
  });
  const draft = async (i: ContentIdeaDTO) => {
    const account = (f.account as ContentAccountId) || i.accounts[0];
    setBusy(i.id);
    try {
      const g = (await api.post<{ draft: { title: string; headline: string | null; caption: string; cta: string | null; hashtags: string | null; extra: string | null; ai: boolean; subjects?: string[]; previewText?: string | null } }>('/content/generate', {
        account, platform: i.platform, format: i.format, pillar: i.pillar, brief: [`Idea: ${i.title}`, i.hook && `Hook: ${i.hook}`, i.visual && `Visual: ${i.visual}`, i.caption && `Starting caption: ${i.caption}`, i.audience && `Audience: ${i.audience}`].filter(Boolean).join('\n'),
      })).draft;
      if (!g.ai) toast('Built-in draft (add an Anthropic key for AI writing) — edit before saving.');
      toCalendar(i, { accounts: [account], headline: g.headline ?? i.hook, caption: g.caption, cta: g.cta ?? i.cta, hashtags: i.platform === 'email' ? null : g.hashtags ?? i.hashtags,
        notes: [g.extra, i.platform !== 'email' && i.shotList && `Shot list:\n${i.shotList}`, g.subjects && g.subjects.length > 1 && `Other subject lines:\n${g.subjects.slice(1).join('\n')}`].filter(Boolean).join('\n\n'),
        ...(i.platform === 'email' ? { email: { subject: g.subjects?.[0] ?? g.headline ?? i.subject, previewText: g.previewText ?? i.previewText } } : {}) });
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  };
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[12rem] flex-1 sm:max-w-xs"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" /><input className="field h-10 pl-9" placeholder="Search ideas" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></label>
        <select className="field h-10 w-auto" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} aria-label="Account"><option value="">All accounts</option>{b.mine.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <select className="field h-10 w-auto" value={f.pillar} onChange={(e) => setF({ ...f, pillar: e.target.value })} aria-label="Pillar"><option value="">All pillars</option>{pillars.map((p) => <option key={p}>{p}</option>)}</select>
        <select className="field h-10 w-auto" value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })} aria-label="Format"><option value="">All formats</option>{CONTENT_FORMATS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
        <Segmented size="sm" value={f.channel} onChange={(v) => setF({ ...f, channel: v })} options={[{ value: 'all', label: 'All' }, { value: 'social', label: 'Social' }, { value: 'email', label: 'Email' }]} />
        <label className="flex items-center gap-1.5 text-[13px] text-ink-soft"><input type="checkbox" className="h-4 w-4 accent-plum" checked={f.favorites} onChange={(e) => setF({ ...f, favorites: e.target.checked })} />Favourites</label>
        <span className="ml-auto flex gap-2">
          <Button icon={<Wand2 className="h-4 w-4" />} loading={suggesting} onClick={suggestMore}>Suggest more</Button>
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>New idea</Button>
        </span>
      </div>
      {fresh.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-1 text-[15px] font-medium text-ink">New this week <span className="num text-stone">{fresh.length}</span></h2>
          <p className="mb-2 text-[13px] text-stone">Drafted for you each week. Save the ones you like — the rest are replaced next week.</p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {fresh.map((i) => (
              <article key={i.id} className="panel flex flex-col border-dashed p-4 text-[13px]">
                <div className="mb-1 flex items-start gap-2"><h3 className="min-w-0 flex-1 text-[15px] font-medium text-ink">{i.title}</h3>
                  <button type="button" className="p-0.5 text-stone hover:text-ink" aria-label="Dismiss" onClick={() => dismiss(i)}><X className="h-4 w-4" /></button></div>
                <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">{i.accounts.map((a) => <AccountTag key={a} a={b.accountOf(a)} small />)}<Badge>{i.pillar}</Badge><span className="text-[11px] text-stone">{formatLabel(i.format)}{i.alsoStory ? ' + Story' : ''}</span></div>
                {i.hook && <p className="mb-1 italic text-ink">“{i.hook}”</p>}
                {i.caption && <p className="text-ink-soft">{i.caption}</p>}
                <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
                  <Button size="sm" variant="primary" icon={<Bookmark className="h-4 w-4" />} onClick={() => keep(i)}>Save</Button>
                  <Button size="sm" icon={<CalendarPlus className="h-4 w-4" />} onClick={() => toCalendar(i)}>Add to calendar</Button>
                  {i.alsoStory && <Button size="sm" variant="ghost" onClick={() => toCalendar(i, { type: 'story', title: `${i.title} (Story)` })}>Add as Story</Button>}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {isLoading ? <PageLoading /> : !list.length ? <div className="panel"><EmptyState title="No ideas match">Try another account or pillar.</EmptyState></div> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((i) => (
            <article key={i.id} className="panel flex flex-col p-4 text-[13px]">
              <div className="mb-1 flex items-start gap-2">
                <h3 className="min-w-0 flex-1 text-[15px] font-medium text-ink">{i.title}</h3>
                <button type="button" onClick={() => fav(i)} aria-label={i.favorite ? 'Remove favourite' : 'Favourite'} className={cx('p-0.5', i.favorite ? 'text-rose' : 'text-stone hover:text-ink')}><Heart className="h-4 w-4" fill={i.favorite ? 'currentColor' : 'none'} /></button>
              </div>
              <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">{i.accounts.map((a) => <AccountTag key={a} a={b.accountOf(a)} small />)}<Badge>{i.pillar}</Badge><span className="text-[11px] text-stone">{platformLabel(i.platform)} · {formatLabel(i.format)}{i.alsoStory ? ' + Story' : ''}{i.accounts.length > 1 ? ' · Cross-post' : ''} · {EFFORT[i.effort]}{i.season && i.season !== 'any' ? ` · ${i.season}` : ''}</span></div>
              {i.platform === 'email' ? <>
                <p className="mb-0.5 flex items-start gap-1.5 text-ink"><Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone" /><span><b className="font-medium">{i.subject}</b></span></p>
                {i.previewText && <p className="text-ink-soft">{i.previewText}</p>}
                {i.sendTiming && <p className="text-stone">Send: {i.sendTiming}</p>}
              </> : i.hook && <p className="mb-1 italic text-ink">“{i.hook}”</p>}
              {i.audience && <p className="text-stone">For: {i.audience}</p>}
              <details className="mt-1 text-ink-soft"><summary className="cursor-pointer text-[12px] text-plum">{i.platform === 'email' ? 'Outline, visuals and CTA' : 'Visual, shots and caption'}</summary>
                {i.visual && <p className="mt-1"><b className="font-medium">Visual:</b> {i.visual}</p>}
                {i.shotList && <p className="mt-1 whitespace-pre-line"><b className="font-medium">Shots:</b>{'\n'}{i.shotList}</p>}
                {i.caption && <p className="mt-1">{i.caption}</p>}{i.cta && <p className="mt-1"><b className="font-medium">CTA:</b> {i.cta}</p>}{i.hashtags && <p className="mt-1 text-stone">{i.hashtags}</p>}
              </details>
              <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
                <Button size="sm" icon={<CalendarPlus className="h-4 w-4" />} onClick={() => toCalendar(i)}>Add to calendar</Button>
                {i.alsoStory && <Button size="sm" variant="ghost" onClick={() => toCalendar(i, { type: 'story', title: `${i.title} (Story)` })}>Add as Story</Button>}
                <Button size="sm" variant="ghost" icon={<Sparkles className="h-4 w-4" />} loading={busy === i.id} onClick={() => draft(i)}>Draft with AI</Button>
                {!i.builtin && <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>Edit</Button>}
              </div>
            </article>
          ))}
        </div>
      )}
      {editing && <IdeaEditor idea={editing === 'new' ? null : editing} b={b} onClose={() => setEditing(null)} />}
    </div>
  );
}

function IdeaEditor({ idea, b, onClose }: { idea: ContentIdeaDTO | null; b: Basics; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [d, setD] = useState({ accounts: idea?.accounts ?? ([] as ContentAccountId[]), title: idea?.title ?? '', pillar: idea?.pillar ?? '', audience: idea?.audience ?? '', platform: idea?.platform ?? ('instagram' as ContentPlatform), format: idea?.format ?? ('feed' as ContentPostType),
    hook: idea?.hook ?? '', visual: idea?.visual ?? '', shotList: idea?.shotList ?? '', caption: idea?.caption ?? '', cta: idea?.cta ?? '', hashtags: idea?.hashtags ?? '', season: idea?.season ?? '', effort: idea?.effort ?? 'medium', alsoStory: idea?.alsoStory ?? false });
  const set = (p: Partial<typeof d>) => setD({ ...d, ...p });
  const pillars = [...new Set(d.accounts.flatMap((a) => b.accountOf(a)?.pillars ?? []))];
  const save = async () => {
    try { await api.post('/content/ideas', { ...d, id: idea?.id, ...Object.fromEntries(['audience', 'hook', 'visual', 'shotList', 'caption', 'cta', 'hashtags', 'season'].map((k) => [k, (d as any)[k] || null])) }); void qc.invalidateQueries({ queryKey: ['content-ideas'] }); onClose(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const del = async () => { if (!idea || !window.confirm('Delete this idea?')) return; await api.del(`/content/ideas/${idea.id}`); void qc.invalidateQueries({ queryKey: ['content-ideas'] }); onClose(); };
  const t = (k: keyof typeof d, label: string, area = false) => <Field label={label}>{area ? <textarea className="field min-h-[70px]" value={d[k] as string} onChange={(e) => set({ [k]: e.target.value })} /> : <input className="field" value={d[k] as string} onChange={(e) => set({ [k]: e.target.value })} />}</Field>;
  return (
    <Modal open xl onClose={onClose} title={idea ? 'Edit idea' : 'New idea'} footer={<>{idea && <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} className="mr-auto" onClick={del}>Delete</Button>}<Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!d.title.trim() || !d.pillar.trim() || !d.accounts.length} onClick={save}>Save</Button></>}>
      <div className="grid gap-3 text-[14px] sm:grid-cols-2">
        <Field label="Accounts" className="sm:col-span-2"><div className="flex flex-wrap gap-3">{b.mine.map((a) => <label key={a.id} className="flex items-center gap-1.5"><input type="checkbox" className="h-4 w-4 accent-plum" checked={d.accounts.includes(a.id)} onChange={(e) => set({ accounts: e.target.checked ? [...d.accounts, a.id] : d.accounts.filter((x) => x !== a.id) })} /><AccountTag a={a} /></label>)}</div></Field>
        {t('title', 'Title')}
        <Field label="Pillar"><input className="field" list="idea-pillars" value={d.pillar} onChange={(e) => set({ pillar: e.target.value })} /><datalist id="idea-pillars">{pillars.map((p) => <option key={p} value={p} />)}</datalist></Field>
        <Field label="Platform"><select className="field" value={d.platform} onChange={(e) => set({ platform: e.target.value as ContentPlatform })}>{CONTENT_PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>
        <Field label="Format"><select className="field" value={d.format} onChange={(e) => set({ format: e.target.value as ContentPostType })}>{CONTENT_FORMATS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>
        {t('audience', 'Audience')}{t('hook', 'Hook / opening line')}{t('visual', 'Visual direction', true)}{t('shotList', 'Shot list', true)}{t('caption', 'Draft caption', true)}
        <div className="space-y-3">{t('cta', 'Call to action')}{t('hashtags', 'Hashtags')}</div>
        <Field label="Season or campaign"><input className="field" value={d.season} onChange={(e) => set({ season: e.target.value })} placeholder="holiday, summer, any…" /></Field>
        <Field label="Effort"><select className="field" value={d.effort} onChange={(e) => set({ effort: e.target.value as 'low' })}><option value="low">Quick</option><option value="medium">Some work</option><option value="high">Production</option></select></Field>
        <label className="flex items-center gap-2 text-[13px] text-ink-soft"><input type="checkbox" className="h-4 w-4 accent-plum" checked={d.alsoStory} onChange={(e) => set({ alsoStory: e.target.checked })} />Reel that also works as a Story</label>
      </div>
    </Modal>
  );
}
