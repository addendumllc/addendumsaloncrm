import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Film, ImagePlus, Library, Link2, Repeat, Sparkles, Trash2, X } from 'lucide-react';
import {
  CONTENT_FORMATS, CONTENT_PLATFORMS, type ContentAccountId, type ContentCommentDTO, type ContentMediaDTO, type ContentMetrics, type ContentPlatform, type ContentPostDTO, type ContentPostType, type ContentStatus,
} from '@addendum/shared';
import { api } from '../../api/client';
import { Badge, Button, Field, Modal, PageTabs, Toggle, cx, useToast } from '../../components/ui';
import { AccountTag, STATUS_TONE, fromLocal, statusLabel, toLocal, type Basics } from './common';
import { AssetPicker } from './Assets';

export type Prefill = Partial<Pick<ContentPostDTO, 'title' | 'platform' | 'type' | 'headline' | 'caption' | 'cta' | 'hashtags' | 'pillar' | 'notes' | 'ideaId' | 'campaignId'>> & { accounts?: ContentAccountId[]; date?: string };
type Draft = {
  accounts: ContentAccountId[]; platform: ContentPlatform; type: ContentPostType; title: string; when: string; due: string; headline: string; caption: string; cta: string; hashtags: string;
  pillar: string; campaignId: string; media: ContentMediaDTO[]; externalLinks: string[]; link: ContentPostDTO['link']; assignedStaffId: string; reviewerStaffId: string; publisherStaffId: string; notes: string; autoPost: boolean; ideaId: string | null;
};
const fromPost = (p: ContentPostDTO): Draft => ({
  accounts: [p.account], platform: p.platform, type: p.type, title: p.title, when: toLocal(p.scheduledAt), due: p.dueAt ? p.dueAt.slice(0, 10) : '', headline: p.headline ?? '', caption: p.caption, cta: p.cta ?? '', hashtags: p.hashtags ?? '',
  pillar: p.pillar ?? '', campaignId: p.campaignId ?? '', media: p.media, externalLinks: p.externalLinks, link: p.link, assignedStaffId: p.assignedStaffId ?? '', reviewerStaffId: p.reviewerStaffId ?? '', publisherStaffId: p.publisherStaffId ?? '', notes: p.notes ?? '', autoPost: p.autoPost, ideaId: p.ideaId,
});
const KINDS = [['caption', 'Caption'], ['reel', 'Reels script + shot list'], ['story', 'Story sequence'], ['carousel', 'Carousel outline + slide copy'], ['tiktok', 'TikTok concept'], ['pinterest', 'Pinterest description'], ['promo', 'Promotional post'], ['product', 'Product spotlight'], ['email', 'Email campaign']] as const;

/** One post: content, workflow (review, approval, publishing) and performance. A new one can go to several accounts — one entry each. */
export function PostEditor({ post, prefill, b, onClose }: { post: ContentPostDTO | null; prefill?: Prefill; b: Basics; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'content' | 'workflow' | 'performance'>('content');
  const [d, setD] = useState<Draft>(() => post ? fromPost(post) : {
    accounts: prefill?.accounts ?? (b.mine.length === 1 ? [b.mine[0].id] : []), platform: prefill?.platform ?? 'instagram', type: prefill?.type ?? 'feed', title: prefill?.title ?? '',
    when: prefill?.date ? `${prefill.date}T10:00` : '', due: '', headline: prefill?.headline ?? '', caption: prefill?.caption ?? '', cta: prefill?.cta ?? '', hashtags: prefill?.hashtags ?? '', pillar: prefill?.pillar ?? '',
    campaignId: prefill?.campaignId ?? '', media: [], externalLinks: [], link: null, assignedStaffId: '', reviewerStaffId: '', publisherStaffId: '', notes: prefill?.notes ?? '', autoPost: false, ideaId: prefill?.ideaId ?? null,
  });
  const [current, setCurrent] = useState(post);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [picking, setPicking] = useState(false);
  const [repurposing, setRepurposing] = useState(false);
  const [linkQ, setLinkQ] = useState('');
  const [newLink, setNewLink] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const acc = b.accountOf(d.accounts[0] ?? '');
  const pillars = [...new Set(d.accounts.flatMap((a) => b.accountOf(a)?.pillars ?? []))];
  const igLength = [d.caption, d.cta, d.hashtags].filter((x) => x.trim()).join('\n\n').length;
  const { data: linkOpts } = useQuery({ queryKey: ['content-links', linkQ], enabled: linkQ.trim().length >= 2, queryFn: () => api.get<{ options: NonNullable<ContentPostDTO['link']>[] }>(`/content/links?q=${encodeURIComponent(linkQ)}`).then((r) => r.options) });
  const refresh = () => { for (const k of ['content-posts', 'content-planning', 'content-analytics', 'content-campaigns']) void qc.invalidateQueries({ queryKey: [k] }); };
  const body = () => ({
    platform: d.platform, type: d.type, title: d.title.trim(), scheduledAt: fromLocal(d.when), dueAt: d.due ? new Date(`${d.due}T17:00`).toISOString() : null, headline: d.headline.trim() || null, caption: d.caption,
    cta: d.cta.trim() || null, hashtags: d.hashtags.trim() || null, pillar: d.pillar || null, autoPost: d.autoPost, mediaIds: d.media.map((m) => m.id), externalLinks: d.externalLinks, link: d.link,
    campaignId: d.campaignId || null, assignedStaffId: d.assignedStaffId || null, reviewerStaffId: d.reviewerStaffId || null, publisherStaffId: d.publisherStaffId || null, notes: d.notes.trim() || null, ideaId: d.ideaId,
  });
  const save = async (status?: 'idea' | 'draft') => {
    if (!d.title.trim()) { toast('Give the post a title.', 'error'); return; }
    if (!post && !d.accounts.length) { toast('Choose at least one account.', 'error'); return; }
    setBusy(true);
    try {
      if (post) { const r = await api.put<{ post: ContentPostDTO }>(`/content/posts/${post.id}`, body()); setCurrent(r.post); toast('Saved'); }
      else { const r = await api.post<{ posts: ContentPostDTO[] }>('/content/posts', { ...body(), accounts: d.accounts, status: status ?? 'draft' }); toast(r.posts.length > 1 ? `${r.posts.length} posts added — one per account` : 'Added to the calendar'); onClose(); }
      refresh();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!post || !window.confirm('Delete this post?')) return;
    try { await api.del(`/content/posts/${post.id}`); refresh(); onClose(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const addFiles = async (files: FileList | null) => {
    for (const f of [...(files ?? [])]) {
      setUploading((n) => n + 1);
      try {
        const r = await api.upload<{ media: ContentMediaDTO }>('/content/media', f);
        setD((x) => ({ ...x, media: [...x.media, r.media] }));
      } catch (e) { toast(`${f.name}: ${(e as Error).message}`, 'error'); } finally { setUploading((n) => n - 1); }
    }
  };
  const move = (i: number, dir: -1 | 1) => setD((x) => { const m = [...x.media]; if (!m[i + dir]) return x; [m[i], m[i + dir]] = [m[i + dir], m[i]]; return { ...x, media: m }; });
  const published = current?.status === 'published';
  return (
    <Modal open xl onClose={onClose} title={post ? d.title || 'Post' : 'New post'} footer={<>
      {post && <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={del}>Delete</Button>}
      {post && <Button variant="ghost" icon={<Repeat className="h-4 w-4" />} className="mr-auto" onClick={() => setRepurposing(true)}>Repurpose…</Button>}
      {!post && <Button variant="ghost" className="mr-auto" loading={busy} onClick={() => save('idea')}>Save as idea</Button>}
      <Button variant="ghost" onClick={onClose}>{post ? 'Close' : 'Cancel'}</Button>
      {(tab === 'content' || !post) && !published && <Button variant="primary" loading={busy} disabled={uploading > 0} onClick={() => save()}>{post ? 'Save' : 'Add as draft'}</Button>}
    </>}>
      {post && current && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
          <AccountTag a={b.accountOf(current.account)} /><Badge tone={STATUS_TONE[current.status]}>{statusLabel(current.status)}</Badge>
          {current.revision > 1 && <span className="text-stone">Revision {current.revision}</span>}
          {current.sourcePostId && <span className="text-stone">· Repurposed</span>}{current.groupId && <span className="text-stone">· Part of a multi-account post</span>}
          {current.permalink && <a className="ml-auto inline-flex items-center gap-1 text-plum hover:underline" href={current.permalink} target="_blank" rel="noreferrer">View post <ExternalLink className="h-3.5 w-3.5" /></a>}
        </div>
      )}
      {post && <PageTabs value={tab} onChange={setTab} options={[{ value: 'content', label: 'Content' }, { value: 'workflow', label: 'Workflow & comments' }, { value: 'performance', label: 'Performance' }]} />}
      {tab === 'content' && (
        <div className="grid gap-5 text-[14px] lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            {!post ? (
              <Field label="Social account" hint="Each ticked account gets its own entry to edit, approve and schedule. Only tick accounts whose audience it really suits.">
                <div className="flex flex-wrap gap-3">{b.mine.map((a) => (
                  <label key={a.id} className="flex items-center gap-1.5"><input type="checkbox" className="h-4 w-4 accent-plum" checked={d.accounts.includes(a.id)} onChange={(e) => set({ accounts: e.target.checked ? [...d.accounts, a.id] : d.accounts.filter((x) => x !== a.id) })} /><AccountTag a={a} /></label>
                ))}</div>
              </Field>
            ) : null}
            <Field label="Title"><input className="field" maxLength={200} value={d.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Balayage reveal — Jessie" /></Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Platform"><select className="field" value={d.platform} onChange={(e) => set({ platform: e.target.value as ContentPlatform, autoPost: e.target.value === 'instagram' && d.autoPost })}>{CONTENT_PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>
              <Field label="Format"><select className="field" value={d.type} onChange={(e) => set({ type: e.target.value as ContentPostType })}>{CONTENT_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></Field>
              <Field label="Content pillar"><select className="field" value={d.pillar} onChange={(e) => set({ pillar: e.target.value })}><option value="">—</option>{[...new Set([...pillars, d.pillar].filter(Boolean))].map((p) => <option key={p}>{p}</option>)}</select></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Scheduled" hint="Empty = not scheduled yet."><input type="datetime-local" className="field" value={d.when} onChange={(e) => set({ when: e.target.value })} /></Field>
              <Field label="Due for review"><input type="date" className="field" value={d.due} onChange={(e) => set({ due: e.target.value })} /></Field>
              <Field label="Campaign"><select className="field" value={d.campaignId} onChange={(e) => set({ campaignId: e.target.value })}><option value="">None</option>{b.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            </div>
            <AiPanel d={d} b={b} onUse={(g) => set({ title: d.title || g.title, headline: g.headline ?? d.headline, caption: g.caption, cta: g.cta ?? d.cta, hashtags: g.hashtags ?? d.hashtags, notes: g.extra ? [d.notes, g.extra].filter(Boolean).join('\n\n') : d.notes })} />
            <Field label="Headline / hook"><input className="field" maxLength={300} value={d.headline} onChange={(e) => set({ headline: e.target.value })} /></Field>
            <Field label="Caption" hint={d.platform === 'instagram' ? `${igLength} / 2,200 with the CTA and hashtags` : undefined}><textarea className={cx('field min-h-[140px]', d.platform === 'instagram' && igLength > 2200 && 'border-rose')} value={d.caption} onChange={(e) => set({ caption: e.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Call to action"><input className="field" maxLength={300} value={d.cta} onChange={(e) => set({ cta: e.target.value })} placeholder={acc?.cta} /></Field>
              <Field label="Hashtags"><input className="field" maxLength={1000} value={d.hashtags} onChange={(e) => set({ hashtags: e.target.value })} placeholder="#addendumsalon …" /></Field>
            </div>
            <Field label="Notes (internal)"><textarea className="field min-h-[70px]" value={d.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Shot list, music, who’s modelling…" /></Field>
          </div>
          <div className="space-y-4">
            <div>
              <span className="label">Photos and videos</span>
              <div className="grid grid-cols-3 gap-2">
                {d.media.map((m, i) => (
                  <div key={m.id} className="group relative aspect-square overflow-hidden rounded-lg border border-line bg-mist">
                    {m.mime.startsWith('video/') ? <video src={m.url} className="h-full w-full object-cover" muted /> : <img src={m.url} alt="" className="h-full w-full object-cover" />}
                    {m.mime.startsWith('video/') && <Film className="absolute left-1.5 top-1.5 h-4 w-4 text-white drop-shadow" />}
                    <span className="absolute bottom-1 left-1 rounded bg-black/50 px-1 text-[10px] text-white">{i + 1}</span>
                    <span className="absolute right-1 top-1 flex gap-0.5 opacity-0 group-hover:opacity-100">
                      {i > 0 && <button type="button" className="rounded bg-white/90 px-1 text-[11px]" onClick={() => move(i, -1)} aria-label="Earlier">←</button>}
                      {i < d.media.length - 1 && <button type="button" className="rounded bg-white/90 px-1 text-[11px]" onClick={() => move(i, 1)} aria-label="Later">→</button>}
                      <button type="button" className="rounded bg-white/90 p-0.5" onClick={() => set({ media: d.media.filter((x) => x.id !== m.id) })} aria-label="Remove"><X className="h-3.5 w-3.5" /></button>
                    </span>
                  </div>
                ))}
                <button type="button" onClick={() => file.current?.click()} className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line-strong text-[12px] text-stone hover:border-ink/40 hover:text-ink"><ImagePlus className="h-5 w-5" />{uploading ? `Uploading ${uploading}…` : 'Upload'}</button>
                <button type="button" onClick={() => setPicking(true)} className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line-strong text-[12px] text-stone hover:border-ink/40 hover:text-ink"><Library className="h-5 w-5" />From library</button>
              </div>
              <input ref={file} type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime" className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
            </div>
            <div>
              <span className="label">Canva and other links</span>
              <ul className="space-y-1">{d.externalLinks.map((l) => <li key={l} className="flex items-center gap-2 text-[13px]"><a className="min-w-0 flex-1 truncate text-plum hover:underline" href={l} target="_blank" rel="noreferrer">{l}</a><button type="button" className="text-stone hover:text-ink" onClick={() => set({ externalLinks: d.externalLinks.filter((x) => x !== l) })} aria-label="Remove"><X className="h-3.5 w-3.5" /></button></li>)}</ul>
              <div className="mt-1 flex gap-2"><input className="field h-9 flex-1" placeholder="https://www.canva.com/design/…" value={newLink} onChange={(e) => setNewLink(e.target.value)} />
                <Button size="sm" disabled={!/^https?:\/\/\S+$/.test(newLink.trim())} onClick={() => { set({ externalLinks: [...d.externalLinks, newLink.trim()] }); setNewLink(''); }}>Add</Button></div>
            </div>
            <div>
              <span className="label">Promotes</span>
              {d.link ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white py-1 pl-3 pr-1 text-[13px]"><Link2 className="h-3.5 w-3.5 text-stone" />{d.link.label}<span className="text-stone">· {d.link.kind}</span>
                  <button type="button" className="rounded-full p-0.5 text-stone hover:text-ink" onClick={() => set({ link: null })} aria-label="Remove"><X className="h-3.5 w-3.5" /></button></span>
              ) : (
                <div className="relative">
                  <input className="field" placeholder="Search a product or service" value={linkQ} onChange={(e) => setLinkQ(e.target.value)} />
                  {!!linkOpts?.length && linkQ.trim().length >= 2 && <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line bg-white shadow-pop">{linkOpts.map((o) => <li key={`${o.kind}-${o.ref}`}><button type="button" className="w-full px-3 py-2 text-left text-[13px] hover:bg-mist" onClick={() => { set({ link: o }); setLinkQ(''); }}>{o.label} <span className="text-stone">· {o.kind}</span></button></li>)}</ul>}
                </div>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {([['assignedStaffId', 'Creator'], ['reviewerStaffId', 'Reviewer'], ['publisherStaffId', 'Publishing owner']] as const).map(([k, label]) => (
                <Field key={k} label={label}><select className="field" value={d[k]} onChange={(e) => set({ [k]: e.target.value })}><option value="">—</option>{b.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
              ))}
            </div>
            {d.platform === 'instagram' && (
              <div className="rounded-xl border border-line p-3">
                <Toggle checked={d.autoPost} disabled={!b.canPublish} onChange={(v) => set({ autoPost: v })} label="Post to Instagram automatically"
                  description={!b.canPublish ? 'Only people who publish content can turn this on.' : d.accounts.every((a) => b.accountOf(a)?.connected) ? 'Posted at the scheduled time once the post is Scheduled.' : 'This account isn’t connected yet (Settings → API & Integrations → Instagram) — schedule it and confirm it as published by hand.'} />
                {current?.error && <p className="mt-2 text-[13px] text-rose">{current.error}</p>}
              </div>
            )}
          </div>
        </div>
      )}
      {tab === 'workflow' && current && <Workflow post={current} b={b} onChanged={(p) => { setCurrent(p); refresh(); }} />}
      {tab === 'performance' && current && <Performance post={current} onChanged={(p) => { setCurrent(p); refresh(); }} />}
      {picking && <AssetPicker account={d.accounts[0]} onPick={(m) => { set({ media: [...d.media, ...m.filter((x) => !d.media.some((y) => y.id === x.id))] }); setPicking(false); }} onClose={() => setPicking(false)} />}
      {repurposing && current && <Repurpose post={current} b={b} onClose={() => setRepurposing(false)} onDone={() => { setRepurposing(false); refresh(); }} />}
    </Modal>
  );
}

type Generated = { title: string; headline: string | null; caption: string; cta: string | null; hashtags: string | null; extra: string | null; ai: boolean };
/** Write with AI: a draft for the account's voice, audience and CTA — shown first, then used only if chosen. */
function AiPanel({ d, b, onUse }: { d: Draft; b: Basics; onUse: (g: Generated) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ kind: '', tone: '', objective: '', brief: '' });
  const [out, setOut] = useState<Generated | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!d.accounts[0]) { toast('Choose an account first.', 'error'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ draft: Generated }>('/content/generate', { account: d.accounts[0], platform: d.platform, format: d.type, pillar: d.pillar || null, tone: f.tone || null, objective: f.objective || null,
        campaign: b.campaigns.find((c) => c.id === d.campaignId)?.name ?? null, brief: [f.brief, d.title && `Working title: ${d.title}`, d.caption && `Current caption: ${d.caption}`].filter(Boolean).join('\n') || null, kind: f.kind || null });
      setOut(r.draft);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  if (!open) return <Button size="sm" variant="ghost" icon={<Sparkles className="h-4 w-4" />} onClick={() => setOpen(true)}>Write with AI</Button>;
  return (
    <div className="rounded-xl border border-plum/30 bg-plum-tint/30 p-3 text-[13px]">
      <div className="grid gap-2 sm:grid-cols-3">
        <select className="field h-9 py-1 text-[13px]" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label="What to write"><option value="">For this format</option>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input className="field h-9 text-[13px]" placeholder="Tone (e.g. playful)" value={f.tone} onChange={(e) => setF({ ...f, tone: e.target.value })} />
        <input className="field h-9 text-[13px]" placeholder="Objective (e.g. fill Tuesday)" value={f.objective} onChange={(e) => setF({ ...f, objective: e.target.value })} />
      </div>
      <textarea className="field mt-2 min-h-[60px] text-[13px]" placeholder="What’s it about? Details, product, offer…" value={f.brief} onChange={(e) => setF({ ...f, brief: e.target.value })} />
      <div className="mt-2 flex items-center gap-2"><Button size="sm" variant="primary" icon={<Sparkles className="h-4 w-4" />} loading={busy} onClick={run}>Generate</Button><Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Close</Button></div>
      {out && (
        <div className="mt-3 space-y-1.5 rounded-lg border border-line bg-white p-3">
          {!out.ai && <p className="text-[12px] text-stone">Built-in template (add an Anthropic key in API & Integrations for AI writing).</p>}
          {out.headline && <p className="font-medium text-ink">{out.headline}</p>}
          <p className="whitespace-pre-line text-ink">{out.caption}</p>
          {out.cta && <p className="text-ink-soft">{out.cta}</p>}{out.hashtags && <p className="text-stone">{out.hashtags}</p>}
          {out.extra && <p className="whitespace-pre-line text-[12px] text-stone">{out.extra}</p>}
          <div className="pt-1"><Button size="sm" onClick={() => { onUse(out); setOut(null); setOpen(false); }}>Use this</Button> <span className="text-[12px] text-stone">You can edit everything after.</span></div>
        </div>
      )}
    </div>
  );
}

/** Status actions (by permission), comments and the approval / revision history. */
function Workflow({ post, b, onChanged }: { post: ContentPostDTO; b: Basics; onChanged: (p: ContentPostDTO) => void }) {
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ['content-post', post.id, post.updatedAt], queryFn: () => api.get<{ comments: ContentCommentDTO[] }>(`/content/posts/${post.id}`).then((r) => r.comments) });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const req = b.settings?.requireApproval ?? true;
  const move = async (status: ContentStatus, needsNote = false) => {
    if (needsNote && !note.trim()) { toast('Add a comment saying what needs changing.', 'error'); return; }
    if (status === 'published' && !window.confirm(post.autoPost && post.status === 'scheduled' ? 'Mark it published now? (It won’t be posted automatically.)' : 'Confirm it has been published on the platform?')) return;
    setBusy(true);
    try { const r = await api.post<{ post: ContentPostDTO }>(`/content/posts/${post.id}/status`, { status, comment: note.trim() || null }); setNote(''); onChanged(r.post); void refetch(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const comment = async () => {
    if (!note.trim()) return;
    try { await api.post(`/content/posts/${post.id}/comments`, { body: note }); setNote(''); void refetch(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const s = post.status;
  const actions: [string, ContentStatus, boolean, boolean?][] = [
    ['Move to draft', 'draft', ['idea', 'changes_requested', 'in_review', 'failed'].includes(s)],
    ['Send for review', 'in_review', ['idea', 'draft', 'changes_requested'].includes(s)],
    ['Request changes', 'changes_requested', b.canApprove && ['in_review', 'approved', 'scheduled'].includes(s), true],
    ['Approve', 'approved', b.canApprove && ['in_review', 'changes_requested', 'failed'].includes(s)],
    ['Schedule', 'scheduled', b.canPublish && (s === 'approved' || (!req && ['draft', 'in_review'].includes(s)) || s === 'failed')],
    ['Confirm published', 'published', b.canPublish && ['approved', 'scheduled', 'failed'].includes(s)],
  ];
  return (
    <div className="grid gap-5 text-[14px] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-3">
        <p className="text-[13px] text-ink-soft">Creator: <b className="font-medium text-ink">{post.assignedName ?? '—'}</b> · Reviewer: <b className="font-medium text-ink">{post.reviewerName ?? '—'}</b> · Publishing: <b className="font-medium text-ink">{post.publisherName ?? '—'}</b></p>
        {req && <p className="text-[12px] text-stone">Posts need approval before they’re scheduled. Only people who publish can schedule or confirm a post as published.</p>}
        <textarea className="field min-h-[80px]" placeholder="Comment (needed when requesting changes)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!note.trim()} onClick={comment}>Add comment</Button>
          {actions.filter(([, , show]) => show).map(([label, to, , needs]) => <Button key={to} size="sm" variant={to === 'approved' || to === 'scheduled' ? 'primary' : 'ghost'} loading={busy} onClick={() => move(to, needs)}>{label}</Button>)}
        </div>
      </div>
      <div>
        <span className="label">History</span>
        <ul className="max-h-[50vh] space-y-2 overflow-auto">{(data ?? []).slice().reverse().map((c) => (
          <li key={c.id} className="rounded-lg border border-line bg-white px-3 py-2 text-[13px]">
            <div className="flex items-center gap-2 text-[12px] text-stone"><span className="font-medium text-ink-soft">{c.staffName ?? 'CRM'}</span><span>{new Date(c.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span></div>
            {c.kind === 'status' && <p className="text-ink">{c.fromStatus ? `${statusLabel(c.fromStatus as ContentStatus)} → ` : 'Created as '}<b className="font-medium">{statusLabel(c.toStatus as ContentStatus)}</b>{c.body ? ` — ${c.body}` : ''}</p>}
            {c.kind === 'comment' && <p className="whitespace-pre-line text-ink">{c.body}</p>}
            {c.kind === 'revision' && (() => { const r = JSON.parse(c.body ?? '{}'); return <details><summary className="cursor-pointer text-ink">Edited the copy (revision {r.revision} kept)</summary><p className="mt-1 whitespace-pre-line text-stone">{[r.headline, r.caption, r.cta, r.hashtags].filter(Boolean).join('\n\n')}</p></details>; })()}
          </li>
        ))}</ul>
      </div>
    </div>
  );
}

const METRICS: [keyof ContentMetrics, string][] = [['reach', 'Reach'], ['impressions', 'Impressions'], ['views', 'Views'], ['likes', 'Likes'], ['comments', 'Comments'], ['saves', 'Saves'], ['shares', 'Shares'], ['clicks', 'Link clicks'], ['bookingInquiries', 'Booking inquiries'], ['productClicks', 'Shopify product clicks'], ['salesCents', 'Attributed sales ($)']];
/** Numbers for the post: imported (Instagram, posts the CRM published) or entered by hand — always labelled which. */
function Performance({ post, onChanged }: { post: ContentPostDTO; onChanged: (p: ContentPostDTO) => void }) {
  const toast = useToast();
  const [m, setM] = useState<Record<string, string>>(() => Object.fromEntries(METRICS.map(([k]) => [k, post.metrics[k] != null ? String(k === 'salesCents' ? post.metrics[k]! / 100 : post.metrics[k]) : ''])));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = Object.fromEntries(METRICS.filter(([k]) => m[k].trim() !== '').map(([k]) => [k, k === 'salesCents' ? Math.round(Number(m[k]) * 100) : Math.round(Number(m[k]))]));
      onChanged((await api.put<{ post: ContentPostDTO }>(`/content/posts/${post.id}/metrics`, body)).post); toast('Saved (entered by hand)');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const importNow = async () => {
    setBusy(true);
    try { onChanged((await api.post<{ post: ContentPostDTO }>(`/content/posts/${post.id}/metrics/import`)).post); toast('Imported from Instagram'); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3 text-[14px]">
      <p className="text-[13px] text-ink-soft">{post.metricsSource ? <>Numbers {post.metricsSource === 'imported' ? 'imported from Instagram' : 'entered by hand'}{post.metricsUpdatedAt ? ` · ${new Date(post.metricsUpdatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ''}.</> : 'No numbers yet.'} Posts the CRM published to Instagram import their numbers daily; enter others by hand.</p>
      <div className="grid gap-3 sm:grid-cols-4">{METRICS.map(([k, label]) => <Field key={k} label={label}><input className="field num" inputMode="decimal" value={m[k]} onChange={(e) => setM({ ...m, [k]: e.target.value })} /></Field>)}</div>
      <div className="flex gap-2"><Button variant="primary" loading={busy} onClick={save}>Save numbers</Button>{post.platform === 'instagram' && post.permalink && <Button loading={busy} onClick={importNow}>Import from Instagram</Button>}</div>
    </div>
  );
}

/** New drafts for other accounts or platforms from this post — the original stays as it is. */
function Repurpose({ post, b, onClose, onDone }: { post: ContentPostDTO; b: Basics; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<{ account: ContentAccountId; platform: ContentPlatform; type: ContentPostType }[]>(() => [{ account: b.mine.find((a) => a.id !== post.account)?.id ?? post.account, platform: post.platform, type: post.type }]);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { const r = await api.post<{ posts: ContentPostDTO[] }>(`/content/posts/${post.id}/repurpose`, { targets: rows }); toast(`${r.posts.length} new draft${r.posts.length === 1 ? '' : 's'} — adapted for each account`); onDone(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open wide onClose={onClose} title="Repurpose" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={go}>Create {rows.length} draft{rows.length === 1 ? '' : 's'}</Button></>}>
      <div className="space-y-3 text-[14px]">
        <p className="text-[13px] text-ink-soft">Each becomes its own draft, rewritten for that account’s audience and call to action, linked to this post. Only repurpose where it suits the audience.</p>
        {rows.map((r, i) => (
          <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <Field label="Account"><select className="field" value={r.account} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, account: e.target.value as ContentAccountId } : x)))}>{b.mine.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
            <Field label="Platform"><select className="field" value={r.platform} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, platform: e.target.value as ContentPlatform } : x)))}>{CONTENT_PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>
            <Field label="Format"><select className="field" value={r.type} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, type: e.target.value as ContentPostType } : x)))}>{CONTENT_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></Field>
            <Button variant="ghost" icon={<X className="h-4 w-4" />} aria-label="Remove" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setRows([...rows, { account: post.account, platform: 'tiktok', type: 'video' }])}>+ Another</Button>
      </div>
    </Modal>
  );
}
