import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Download, ExternalLink, Info, Link2, Share2, CalendarDays, ChevronLeft, ChevronRight, Copy, Film, Grid3x3, ImagePlus, Instagram, LayoutList, Lock, Play, Plus, Send, Trash2, Upload, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useCanDo } from '../api/hooks';
import { TransformationsDue } from '../components/domain/TransformationsDue';
import { Badge, Button, EmptyState, ErrorNote, Field, Modal, PageHeader, PageLoading, Segmented, Spinner, buttonClass, chipClass, cx, useToast } from '../components/ui';

type Format = 'post' | 'reel' | 'story' | 'carousel';
/** A new post, possibly started from one of the salon's ideas. */
interface Draft { date: string | null; title?: string; caption?: string; hashtags?: string; notes?: string; format?: Format }
type Status = 'idea' | 'draft' | 'ready' | 'posted';
interface Media { id: string; thumbUrl: string; originalUrl: string; mime: string; fromTransformation: boolean }
interface Post { id: string; date: string | null; time: string | null; format: Format; status: Status; title: string; caption: string | null; hashtags: string | null; notes: string | null; media: Media[]; updatedAt: string }
const FORMATS: { value: Format; label: string }[] = [{ value: 'post', label: 'Post' }, { value: 'carousel', label: 'Carousel' }, { value: 'reel', label: 'Reel' }, { value: 'story', label: 'Story' }];
const STATUSES: { value: Status; label: string; tone: 'neutral' | 'amber' | 'plum' | 'sage' }[] = [
  { value: 'idea', label: 'Idea', tone: 'neutral' }, { value: 'draft', label: 'Draft', tone: 'amber' }, { value: 'ready', label: 'Ready', tone: 'plum' }, { value: 'posted', label: 'Posted', tone: 'sage' },
];
const statusOf = (s: Status) => STATUSES.find((x) => x.value === s)!;
const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = key(new Date());
const fmtDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const isVideo = (m: Media) => m.mime.startsWith('video/');
const captionOf = (p: Post) => [p.caption, p.hashtags].filter(Boolean).join('\n\n');

function useMonth(month: Date) {
  // The month shown, a week either side (for the calendar's edges and the grid).
  const from = key(new Date(month.getFullYear(), month.getMonth() - 1, 20));
  const to = key(new Date(month.getFullYear(), month.getMonth() + 2, 10));
  return useQuery({ queryKey: ['my-content', from, to], queryFn: () => api.get<{ posts: Post[]; instagram: string | null }>(`/my-content?from=${from}&to=${to}`) });
}

/** My Content: a stylist's own Instagram plan — calendar, list and a feed grid. Private: only they can see it. */
export function MyContentPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [view, setView] = useState<'month' | 'list' | 'grid'>(() => {
    try { const v = localStorage.getItem('mc-view'); if (v === 'month' || v === 'list' || v === 'grid') return v; } catch { /* private window */ }
    return window.matchMedia?.('(max-width: 639px)').matches ? 'list' : 'month';
  });
  useEffect(() => { try { localStorage.setItem('mc-view', view); } catch { /* private window */ } }, [view]);
  const { data, isLoading, error, refetch } = useMonth(month);
  const [edit, setEdit] = useState<Post | Draft | null>(null);
  const [handleOpen, setHandleOpen] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['my-content'] });
  const posts = data?.posts ?? [];
  const ideas = posts.filter((p) => !p.date);
  const dated = posts.filter((p) => p.date);
  const handle = data?.instagram ?? null;

  const swapDates = async (a: Post, b: Post) => {
    try {
      await api.patch(`/my-content/${a.id}`, { date: b.date, time: b.time });
      await api.patch(`/my-content/${b.id}`, { date: a.date, time: a.time });
      refresh();
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div>
      <PageHeader title="My Content" subtitle={<span className="inline-flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" />Your own Instagram plan — only you can see it.</span>}
        actions={<>
          {handle ? <a className={buttonClass('secondary')} href={`https://www.instagram.com/${handle}/`} target="_blank" rel="noreferrer noopener"><Instagram className="h-4 w-4" /><span className="btn-label">@{handle}</span></a>
            : <Button icon={<Instagram className="h-4 w-4" />} onClick={() => setHandleOpen(true)}>Add your Instagram</Button>}
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ date: null })}>New post</Button>
        </>} />

      <p className="mb-5 flex items-start gap-2 rounded-xl2 border border-line bg-mist/50 px-4 py-3 text-[13px] text-ink-soft">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-stone" />
        <span><b className="font-medium text-ink">For planning purposes only.</b> Nothing here is posted to Instagram for you — you post it yourself. Follow the salon’s guidelines and only share clients’ photos they’ve agreed to.</span>
      </p>

      <MyWork />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {view !== 'grid' && <>
          <Button size="icon" icon={<ChevronLeft className="h-4 w-4" />} aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} />
          <span className="min-w-[9rem] text-center text-[15px] font-medium text-ink">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
          <Button size="icon" icon={<ChevronRight className="h-4 w-4" />} aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} />
        </>}
        {handle && <button type="button" className="text-[12px] text-stone underline" onClick={() => setHandleOpen(true)}>Change Instagram</button>}
        <Segmented className="ml-auto" value={view} onChange={setView} options={[
          { value: 'month', label: <span className="flex items-center gap-1"><CalendarDays className="h-4 w-4" /><span className="hidden sm:inline">Month</span></span> },
          { value: 'list', label: <span className="flex items-center gap-1"><LayoutList className="h-4 w-4" /><span className="hidden sm:inline">List</span></span> },
          { value: 'grid', label: <span className="flex items-center gap-1"><Grid3x3 className="h-4 w-4" /><span className="hidden sm:inline">Grid</span></span> },
        ]} />
      </div>

      {error ? <ErrorNote error={error} onRetry={() => refetch()} /> : isLoading ? <PageLoading /> : (
        <>
          {view === 'month' && <MonthView month={month} posts={dated} onOpen={setEdit} onNew={(d) => setEdit({ date: d })} />}
          {view === 'list' && <ListView month={month} posts={dated} onOpen={setEdit} />}
          {view === 'grid' && <GridView posts={dated} handle={handle} onOpen={setEdit} onSwap={swapDates} />}
          <section className="mt-6">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="h-display text-[20px]">Ideas</h2><span className="text-[13px] text-stone">No date yet</span>
              <Button size="sm" className="ml-auto" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEdit({ date: null })}>Idea</Button>
            </div>
            {ideas.length ? (
              <div className="panel divide-y divide-line !p-0">{ideas.map((p) => <PostRow key={p.id} p={p} onOpen={() => setEdit(p)} />)}</div>
            ) : <p className="text-[13px] text-stone">Jot down post ideas here and give them a date when you’re ready.</p>}
          </section>
        </>
      )}

      <SalonIdeas onUse={(d) => setEdit(d)} />

      <SalonDownloads />

      {edit && <PostEditor initial={edit} handle={handle} onClose={() => { setEdit(null); refresh(); }} />}
      {handleOpen && <HandleModal handle={handle} onClose={() => { setHandleOpen(false); refresh(); }} />}
    </div>
  );
}

function Thumb({ p, className }: { p: Post; className?: string }) {
  const m = p.media[0];
  const [broken, setBroken] = useState(false);
  return (
    <span className={cx('relative block overflow-hidden bg-mist', className)}>
      {m && !broken ? <img src={m.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setBroken(true)} />
        : <span className="flex h-full w-full items-center justify-center p-1 text-center text-[10px] leading-tight text-stone">{m && isVideo(m) ? <Film className="h-4 w-4" /> : p.title || 'No photo'}</span>}
      {(p.format === 'reel' || (m && isVideo(m))) && <Play className="absolute right-1 top-1 h-3.5 w-3.5 fill-white text-white drop-shadow" />}
    </span>
  );
}
function PostRow({ p, onOpen }: { p: Post; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-mist/60">
      <Thumb p={p} className="h-14 w-14 shrink-0 rounded-lg" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] text-ink">{p.title || p.caption?.slice(0, 60) || 'Untitled'}</span>
        <span className="block truncate text-[12px] text-stone">{FORMATS.find((f) => f.value === p.format)?.label}{p.time ? ` · ${p.time}` : ''}</span>
      </span>
      <Badge tone={statusOf(p.status).tone}>{statusOf(p.status).label}</Badge>
    </button>
  );
}

function MonthView({ month, posts, onOpen, onNew }: { month: Date; posts: Post[]; onOpen: (p: Post) => void; onNew: (d: string) => void }) {
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - ((month.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const by = useMemo(() => { const m = new Map<string, Post[]>(); for (const p of posts) m.set(p.date!, [...(m.get(p.date!) ?? []), p]); return m; }, [posts]);
  return (
    <div className="panel overflow-hidden !p-0">
      <div className="grid grid-cols-7 border-b border-line bg-mist/50 text-[11px] uppercase tracking-wide text-stone">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="px-2 py-1.5">{d}</div>)}</div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const k = key(d);
          const list = by.get(k) ?? [];
          return (
            <div key={k} className={cx('min-h-[96px] border-b border-r border-line p-1', d.getMonth() !== month.getMonth() && 'bg-mist/30')}>
              <button type="button" onClick={() => onNew(k)} className={cx('mb-1 flex h-6 w-6 items-center justify-center rounded-full text-[12px]', k === today ? 'bg-plum text-white' : 'text-stone hover:bg-mist')} aria-label={`New post on ${fmtDay(k)}`}>{d.getDate()}</button>
              <div className="space-y-1">{list.map((p) => (
                <button key={p.id} type="button" onClick={() => onOpen(p)} className="flex w-full items-center gap-1 rounded border border-line bg-white p-0.5 text-left text-[11px] hover:border-plum/40">
                  <Thumb p={p} className="h-7 w-7 shrink-0 rounded" />
                  <span className="min-w-0 flex-1 truncate text-ink">{p.title || p.caption || FORMATS.find((f) => f.value === p.format)?.label}</span>
                  <span className={cx('h-2 w-2 shrink-0 rounded-full', { idea: 'bg-stone-light', draft: 'bg-amber', ready: 'bg-plum', posted: 'bg-sage' }[p.status])} />
                </button>
              ))}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ListView({ month, posts, onOpen }: { month: Date; posts: Post[]; onOpen: (p: Post) => void }) {
  const inMonth = posts.filter((p) => p.date!.startsWith(key(month).slice(0, 7)));
  const days = [...new Set(inMonth.map((p) => p.date!))].sort();
  if (!days.length) return <div className="panel"><EmptyState icon={<CalendarDays className="h-6 w-6" />} title="Nothing planned this month">Tap New post to plan one.</EmptyState></div>;
  return (
    <div className="space-y-4">{days.map((d) => (
      <section key={d}>
        <h3 className={cx('mb-1 text-[13px] font-medium', d === today ? 'text-plum' : 'text-stone')}>{fmtDay(d)}{d === today ? ' · Today' : ''}</h3>
        <div className="panel divide-y divide-line !p-0">{inMonth.filter((p) => p.date === d).map((p) => <PostRow key={p.id} p={p} onOpen={() => onOpen(p)} />)}</div>
      </section>
    ))}</div>
  );
}

/** How the planned posts will sit on the profile: newest first, three across (Stories aren't on the grid). Drag one onto another to swap their days. */
function GridView({ posts, handle, onOpen, onSwap }: { posts: Post[]; handle: string | null; onOpen: (p: Post) => void; onSwap: (a: Post, b: Post) => void }) {
  const feed = posts.filter((p) => p.format !== 'story').sort((a, b) => `${b.date} ${b.time ?? ''}`.localeCompare(`${a.date} ${a.time ?? ''}`));
  const [drag, setDrag] = useState<string | null>(null);
  if (!feed.length) return <div className="panel"><EmptyState icon={<Grid3x3 className="h-6 w-6" />} title="Your grid is empty">Plan posts with photos to see how your profile will look.</EmptyState></div>;
  return (
    <div className="mx-auto max-w-[480px]">
      <p className="mb-2 flex items-center gap-2 text-[14px] text-ink"><Instagram className="h-4 w-4" />{handle ? `@${handle}` : 'Your profile'} <span className="text-[12px] text-stone">· drag to swap days</span></p>
      <div className="grid grid-cols-3 gap-0.5 bg-line">
        {feed.map((p) => (
          <button key={p.id} type="button" draggable onDragStart={(e) => { setDrag(p.id); e.dataTransfer.setData('text/x-mc', p.id); }} onDragEnd={() => setDrag(null)}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/x-mc') || drag; const a = feed.find((x) => x.id === id); if (a && a.id !== p.id) onSwap(a, p); }}
            onClick={() => onOpen(p)} className={cx('relative bg-white', drag === p.id && 'opacity-50')}>
            <Thumb p={p} className="aspect-[3/4] w-full" />
            {p.status !== 'posted' && <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1 text-[10px] text-white">{fmtDay(p.date!).replace(/^\w+, /, '')}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------- the post ----------------
async function makeThumb(file: File): Promise<Blob | null> {
  try {
    if (file.type.startsWith('video/')) return null;
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return await new Promise((r) => c.toBlob((b) => r(b), 'image/jpeg', 0.82));
  } catch { return null; }
}
async function sendFile(url: string, body: Blob, method = 'POST') {
  const r = await fetch(`/api${url}`, { method, body, credentials: 'same-origin', headers: { 'X-Requested-With': 'addendum-crm', 'Content-Type': body.type || 'application/octet-stream' } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message ?? (r.status === 413 ? 'That file is too large.' : 'The upload didn’t go through.'));
  return d;
}

function PostEditor({ initial, handle, onClose }: { initial: Post | Draft; handle: string | null; onClose: () => void }) {
  const toast = useToast();
  const existing = 'id' in initial ? initial : null;
  const [post, setPost] = useState<Post | null>(existing);
  const [d, setD] = useState({
    date: existing?.date ?? initial.date ?? '', time: existing?.time ?? '', format: existing?.format ?? (initial as Draft).format ?? 'post' as Format, status: existing?.status ?? (initial.date ? 'draft' : 'idea') as Status,
    title: existing?.title ?? (initial as Draft).title ?? '', caption: existing?.caption ?? (initial as Draft).caption ?? '', hashtags: existing?.hashtags ?? (initial as Draft).hashtags ?? '', notes: existing?.notes ?? (initial as Draft).notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [picking, setPicking] = useState(false);
  const [sharing, setSharing] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const body = () => ({ date: d.date || null, time: d.time || null, format: d.format, status: d.status, title: d.title, caption: d.caption || null, hashtags: d.hashtags || null, notes: d.notes || null });
  /** Saves (creating it the first time) and returns the post. */
  const save = async (): Promise<Post> => {
    const r = post ? await api.patch<{ post: Post }>(`/my-content/${post.id}`, body()) : await api.post<{ post: Post }>('/my-content', body());
    setPost(r.post);
    return r.post;
  };
  const saveAndClose = async () => { setBusy(true); try { await save(); onClose(); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); } };
  const upload = async (files: FileList | null) => {
    const list = [...(files ?? [])];
    if (!list.length) return;
    try {
      const p = post ?? await save();
      for (const f of list) {
        setUploading((n) => n + 1);
        try {
          const r = await sendFile(`/my-content/${p.id}/media`, f);
          const th = await makeThumb(f);
          if (th) await sendFile(`/my-content/media/${r.mediaId}/thumb`, th, 'PUT').catch(() => null);
          setPost((await api.get<{ post: Post }>(`/my-content/${p.id}`)).post);
        } catch (e) { toast(`${f.name}: ${(e as Error).message}`, 'error'); } finally { setUploading((n) => n - 1); }
      }
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const remove = async (m: Media) => { try { setPost((await api.del<{ post: Post }>(`/my-content/media/${m.id}`)).post); } catch (e) { toast((e as Error).message, 'error'); } };
  const del = async () => { if (!post || !window.confirm('Delete this post from your plan?')) return; await api.del(`/my-content/${post.id}`); onClose(); };
  const copyCaption = async () => { try { await navigator.clipboard.writeText([d.caption, d.hashtags].filter(Boolean).join('\n\n')); toast('Caption copied'); } catch { toast('Couldn’t copy — select the text instead.', 'error'); } };
  const media = post?.media ?? [];
  const count = d.caption.length + (d.hashtags ? d.hashtags.length + 2 : 0);

  return (
    <Modal open wide onClose={onClose} title={post ? (d.title || 'Post') : 'New post'}
      footer={<>
        {post && <Button variant="ghost" className="mr-auto" icon={<Trash2 className="h-4 w-4" />} onClick={del}>Delete</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={saveAndClose}>Save</Button>
      </>}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">{FORMATS.map((f) => <button key={f.value} type="button" aria-pressed={d.format === f.value} className={chipClass(d.format === f.value, 'min-h-[40px] px-3.5 text-[14px]')} onClick={() => setD({ ...d, format: f.value })}>{f.label}</button>)}</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Day"><input type="date" className="field" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value, status: d.status === 'idea' && e.target.value ? 'draft' : d.status })} /></Field>
          <Field label="Time (optional)"><input type="time" className="field" value={d.time} onChange={(e) => setD({ ...d, time: e.target.value })} /></Field>
        </div>
        <Field label="Photos & videos">
          <div className="flex flex-wrap gap-2">
            {media.map((m) => (
              <span key={m.id} className="relative h-20 w-20 overflow-hidden rounded-lg border border-line bg-mist">
                {isVideo(m) && !m.fromTransformation ? <video src={m.originalUrl} muted playsInline preload="metadata" className="h-full w-full object-cover" /> : <img src={m.thumbUrl} alt="" className="h-full w-full object-cover" />}
                <button type="button" onClick={() => remove(m)} className="absolute right-0.5 top-0.5 rounded-full bg-black/55 p-1 text-white" aria-label="Remove"><X className="h-3 w-3" /></button>
              </span>
            ))}
            <button type="button" onClick={() => file.current?.click()} className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-line text-[11px] text-stone hover:border-plum/40">
              {uploading ? <Spinner /> : <Upload className="h-4 w-4" />}Upload
            </button>
            <button type="button" onClick={() => setPicking(true)} className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-line px-1 text-center text-[11px] leading-tight text-stone hover:border-plum/40">
              <ImagePlus className="h-4 w-4" />From my work
            </button>
            <input ref={file} type="file" multiple accept="image/*,video/*,.heic,.mov" className="hidden" onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
          </div>
        </Field>
        <Field label="Caption" hint={`${count} / 2,200`}><textarea className="field min-h-[110px]" value={d.caption} maxLength={2200} onChange={(e) => setD({ ...d, caption: e.target.value })} /></Field>
        <Field label="Hashtags"><input className="field" value={d.hashtags} onChange={(e) => setD({ ...d, hashtags: e.target.value })} placeholder="#addendumsalon #copperhair" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name (for your calendar)"><input className="field" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="e.g. Copper melt reveal" /></Field>
          <Field label="Status"><select className="field" value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as Status })}>{STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
        </div>
        <Field label="Notes"><textarea className="field min-h-[56px]" value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} placeholder="Song, cover photo, who to tag…" /></Field>

        <div className="flex flex-wrap gap-2 rounded-xl border border-line bg-mist/40 p-3">
          <Button variant="primary" icon={<Send className="h-4 w-4" />} disabled={!media.length} onClick={() => setSharing(true)}>Post to Instagram</Button>
          <Button icon={<Copy className="h-4 w-4" />} disabled={!d.caption && !d.hashtags} onClick={copyCaption}>Copy caption</Button>
          {!media.length && <p className="w-full text-[12px] text-stone">Add a photo or video to post it.</p>}
        </div>
      </div>
      {picking && post && <PickFromWork postId={post.id} onClose={(p) => { setPicking(false); if (p) setPost(p); }} />}
      {picking && !post && <SaveFirst onSave={async () => { try { await save(); } catch (e) { toast((e as Error).message, 'error'); setPicking(false); } }} />}
      {sharing && post && <ShareToInstagram post={{ ...post, caption: d.caption, hashtags: d.hashtags }} handle={handle}
        onClose={async (posted) => { setSharing(false); if (posted) { setD((x) => ({ ...x, status: 'posted', date: x.date || today })); await api.patch(`/my-content/${post.id}`, { ...body(), status: 'posted', date: d.date || today }); toast('Marked as posted'); } }} />}
    </Modal>
  );
}
function SaveFirst({ onSave }: { onSave: () => void }) { useEffect(() => { onSave(); }, []); return null; } // eslint-disable-line react-hooks/exhaustive-deps

/** Their own transformation photos to add (linked, not copied). */
function PickFromWork({ postId, onClose }: { postId: string; onClose: (p: Post | null) => void }) {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['my-content-work'], queryFn: () => api.get<{ photos: { id: string; title: string; service_date: string; mime: string }[] }>('/my-content/transformation-photos').then((r) => r.photos) });
  const [picked, setPicked] = useState<string[]>([]);
  const add = async () => {
    try {
      let p: Post | null = null;
      for (const id of picked) p = (await api.post<{ post: Post }>(`/my-content/${postId}/media/transformation`, { mediaId: id })).post;
      onClose(p);
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <Modal open wide onClose={() => onClose(null)} title="From my work" footer={<><Button variant="ghost" onClick={() => onClose(null)}>Cancel</Button><Button variant="primary" disabled={!picked.length} onClick={add}>Add {picked.length || ''}</Button></>}>
      {!data ? <PageLoading /> : !data.length ? <p className="text-[14px] text-stone">Your transformation photos show here once you’ve added some.</p> : (
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
          {data.map((m) => {
            const on = picked.includes(m.id);
            return (
              <button key={m.id} type="button" onClick={() => setPicked(on ? picked.filter((x) => x !== m.id) : [...picked, m.id])} className={cx('relative overflow-hidden rounded-lg border-2', on ? 'border-plum' : 'border-transparent')}>
                <img src={`/api/transformations/media/${m.id}/thumb`} alt={m.title} loading="lazy" className="aspect-square w-full bg-mist object-cover" />
                {m.mime.startsWith('video/') && <Play className="absolute left-1 top-1 h-3.5 w-3.5 fill-white text-white drop-shadow" />}
                {on && <span className="absolute right-1 top-1 rounded-full bg-plum px-1.5 text-[11px] text-white">{picked.indexOf(m.id) + 1}</span>}
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

/**
 * Posting: the caption is copied, then the phone's share sheet opens with the photos and videos — pick Instagram, paste
 * the caption and post. On a computer (no share sheet), the files download and their profile opens.
 */
function ShareToInstagram({ post, handle, onClose }: { post: Post; handle: string | null; onClose: (posted: boolean) => void }) {
  const toast = useToast();
  const [step, setStep] = useState<'ready' | 'working' | 'done'>('ready');
  const go = async () => {
    setStep('working');
    try { await navigator.clipboard.writeText(captionOf(post)); } catch { /* shown below to copy by hand */ }
    try {
      const files = await Promise.all(post.media.map(async (m, i) => {
        const b = await (await fetch(m.originalUrl, { credentials: 'same-origin' })).blob();
        const ext = (b.type.split('/')[1] ?? 'jpg').replace('quicktime', 'mov').replace('jpeg', 'jpg');
        return new File([b], `post-${i + 1}.${ext}`, { type: b.type });
      }));
      if (navigator.canShare?.({ files })) {
        await navigator.share({ files }).catch((e) => { if ((e as Error).name !== 'AbortError') throw e; });
      } else {
        for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
        window.open(handle ? `https://www.instagram.com/${handle}/` : 'https://www.instagram.com/', '_blank', 'noopener');
      }
      setStep('done');
    } catch (e) { toast((e as Error).message || 'Couldn’t open sharing.', 'error'); setStep('ready'); }
  };
  return (
    <Modal open onClose={() => onClose(false)} title="Post to Instagram" footer={step === 'done'
      ? <><Button variant="ghost" onClick={() => onClose(false)}>Not yet</Button><Button variant="primary" onClick={() => onClose(true)}>I posted it</Button></>
      : <><Button variant="ghost" onClick={() => onClose(false)}>Cancel</Button><Button variant="primary" loading={step === 'working'} icon={<Send className="h-4 w-4" />} onClick={go}>Copy caption & share</Button></>}>
      <ol className="list-decimal space-y-1.5 pl-5 text-[14px] text-ink">
        <li>The caption is copied.</li>
        <li>On your phone, the share sheet opens with the {post.media.length > 1 ? `${post.media.length} photos/videos` : 'photo'} — choose <b>Instagram</b> (Feed, Reels or Story).</li>
        <li>Paste the caption and post. On a computer, the files download and your profile opens.</li>
      </ol>
      {captionOf(post) && <textarea readOnly className="field mt-3 min-h-[80px] text-[13px]" value={captionOf(post)} onFocus={(e) => e.target.select()} />}
      {step === 'done' && <p className="mt-3 text-[14px] text-ink">Posted? Mark it as posted to keep your plan up to date.</p>}
    </Modal>
  );
}

function HandleModal({ handle, onClose }: { handle: string | null; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState(handle ? `@${handle}` : '');
  const save = async () => { try { await api.put('/my-content/instagram', { handle: v || null }); onClose(); } catch (e) { toast((e as Error).message, 'error'); } };
  return (
    <Modal open onClose={onClose} title="Your Instagram" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <Field label="Instagram username or link" hint="e.g. @addendum.salon or https://www.instagram.com/addendum.salon">
        <input className="field" value={v} onChange={(e) => setV(e.target.value)} placeholder="@yourname" autoFocus />
      </Field>
    </Modal>
  );
}

/** Their transformations: what still needs their details, and adding one — from here. */
function MyWork() {
  const go = useNavigate();
  return (
    <section className="mb-6">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="h-display text-[20px]">My transformations</h2>
        <span className="ml-auto flex gap-2">
          <Button size="sm" onClick={() => go('/transformations')}>Open</Button>
          <Button size="sm" variant="primary" icon={<Camera className="h-3.5 w-3.5" />} onClick={() => go('/transformations?new=1')}>Add a transformation</Button>
        </span>
      </div>
      <TransformationsDue className="!mb-0" />
    </section>
  );
}

interface SalonFile { id: string; kind: 'post' | 'story'; title: string | null; mime: string; size: number; url: string; createdAt: string }
/** Posts and stories the salon provides, to download (or share straight to Instagram from a phone). */
function SalonDownloads() {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['my-content-downloads'], queryFn: () => api.get<{ downloads: SalonFile[] }>('/my-content/downloads').then((r) => r.downloads), staleTime: 5 * 60_000 });
  const [kind, setKind] = useState<'post' | 'story'>('post');
  const list = (data ?? []).filter((x) => x.kind === kind);
  const qc = useQueryClient();
  const canManage = useCanDo()('content:manage');
  const { data: links } = useQuery({ queryKey: ['my-content-links'], queryFn: () => api.get<{ links: SharedLink[] }>('/my-content/links').then((r) => r.links), staleTime: 5 * 60_000 });
  const shownLinks = (links ?? []).filter((l) => l.kind === 'both' || l.kind === kind);
  const [adding, setAdding] = useState(false);
  const removeLink = async (l: SharedLink) => {
    if (!window.confirm(`Remove “${l.title}” for every stylist?`)) return;
    try { await api.del(`/my-content/links/${l.id}`); void qc.invalidateQueries({ queryKey: ['my-content-links'] }); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const share = async (f: SalonFile) => {
    try {
      const b = await (await fetch(f.url, { credentials: 'same-origin' })).blob();
      const file = new File([b], `${(f.title || 'addendum').replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'addendum'}.${(b.type.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg').replace('quicktime', 'mov')}`, { type: b.type });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] }).catch((e) => { if ((e as Error).name !== 'AbortError') throw e; });
      else window.location.href = `${f.url}?download`;
    } catch (e) { toast((e as Error).message || 'Couldn’t share it.', 'error'); }
  };
  return (
    <section className="mt-8">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="h-display text-[20px]">Salon downloads</h2>
        <span className="text-[13px] text-stone">Posts and stories from the salon to share</span>
        <Segmented size="sm" className="ml-auto" value={kind} onChange={setKind} options={[{ value: 'post', label: `Posts (${(data ?? []).filter((x) => x.kind === 'post').length})` }, { value: 'story', label: `Stories (${(data ?? []).filter((x) => x.kind === 'story').length})` }]} />
      </div>
      {/* Links the salon shares — Canva designs and templates to open, edit and download there. */}
      {(shownLinks.length > 0 || canManage) && (
        <div className="mb-3 space-y-2">
          {shownLinks.map((l) => (
            <div key={l.id} className="panel flex items-center gap-3 px-3 py-2.5">
              <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[12px] font-semibold', isCanva(l.url) ? 'bg-[#7d2ae8] text-white' : 'bg-mist text-stone')}>{isCanva(l.url) ? 'C' : <Link2 className="h-4 w-4" />}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-[14px] text-ink">{l.title}</span><span className="block truncate text-[12px] text-stone">{isCanva(l.url) ? 'Canva' : new URL(l.url).hostname} · {l.kind === 'both' ? 'Posts & stories' : l.kind === 'story' ? 'Stories' : 'Posts'}</span></span>
              <a className={buttonClass('secondary', 'sm')} href={l.url} target="_blank" rel="noreferrer noopener"><ExternalLink className="h-3.5 w-3.5" /><span className="btn-label">{isCanva(l.url) ? 'Open in Canva' : 'Open'}</span></a>
              {canManage && <button type="button" className="rounded p-2 text-stone hover:bg-mist hover:text-rose sm:p-1.5" aria-label={`Remove ${l.title}`} onClick={() => removeLink(l)}><Trash2 className="h-4 w-4" /></button>}
            </div>
          ))}
          {canManage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>Add a Canva link</Button>}
        </div>
      )}
      {adding && <AddLink kind={kind} onClose={() => { setAdding(false); void qc.invalidateQueries({ queryKey: ['my-content-links'] }); }} />}
      {!data ? <PageLoading /> : !list.length ? (!shownLinks.length && <p className="text-[13px] text-stone">Nothing here yet — the salon adds {kind === 'post' ? 'posts' : 'stories'} for you to share.</p>) : (
        <div className={cx('grid gap-3', kind === 'story' ? 'grid-cols-3 sm:grid-cols-5 lg:grid-cols-6' : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-5')}>
          {list.map((f) => (
            <div key={f.id} className="panel overflow-hidden !p-0">
              {f.mime.startsWith('video/')
                ? <video src={f.url} muted playsInline preload="metadata" controls className={cx('w-full bg-black object-cover', kind === 'story' ? 'aspect-[9/16]' : 'aspect-[4/5]')} />
                : <img src={f.url} alt={f.title ?? ''} loading="lazy" className={cx('w-full bg-mist object-cover', kind === 'story' ? 'aspect-[9/16]' : 'aspect-[4/5]')} />}
              <div className="space-y-1.5 p-2">
                {f.title && <p className="truncate text-[13px] text-ink">{f.title}</p>}
                <div className="flex gap-1.5">
                  <a className={buttonClass('secondary', 'sm', 'flex-1')} href={`${f.url}?download`}><Download className="h-3.5 w-3.5" /><span className="btn-label">Download</span></a>
                  <Button size="sm" icon={<Share2 className="h-3.5 w-3.5" />} aria-label="Share" onClick={() => share(f)} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface SalonIdea { id: string; title: string; pillar: string; format: Format; hook: string | null; visual: string | null; shotList: string | null; caption: string | null; cta: string | null; hashtags: string | null; alsoStory: boolean; effort: string }
/** The Content Calendar's ideas, for stylists to use in their own plan ("Use this idea" starts a post with it). */
function SalonIdeas({ onUse }: { onUse: (d: Draft) => void }) {
  const { data } = useQuery({ queryKey: ['my-content-ideas'], queryFn: () => api.get<{ ideas: SalonIdea[] }>('/my-content/ideas').then((r) => r.ideas), staleTime: 5 * 60_000 });
  const [q, setQ] = useState('');
  const [format, setFormat] = useState<'' | Format>('');
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = (data ?? []).filter((i) => (!format || i.format === format || (format === 'story' && i.alsoStory))
    && words.every((w) => [i.title, i.pillar, i.hook, i.caption].join(' ').toLowerCase().includes(w)));
  const use = (i: SalonIdea) => onUse({
    date: null, title: i.title, format: i.format,
    caption: [i.caption, i.cta].filter(Boolean).join('\n\n'), hashtags: i.hashtags ?? '',
    notes: [i.hook && `Hook: ${i.hook}`, i.visual && `Visual: ${i.visual}`, i.shotList && `Shots: ${i.shotList}`].filter(Boolean).join('\n'),
  });
  if (data && !data.length) return null;
  return (
    <section className="mt-8">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="h-display text-[20px]">Ideas from the salon</h2>
        <span className="text-[13px] text-stone">Use one to start a post of your own</span>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input className="field h-10 min-w-[10rem] flex-1 sm:max-w-xs" placeholder="Search ideas" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex flex-wrap gap-1.5">{([['', 'All'], ['post', 'Posts'], ['carousel', 'Carousels'], ['reel', 'Reels'], ['story', 'Stories']] as const).map(([v, l]) => (
          <button key={v} type="button" aria-pressed={format === v} className={chipClass(format === v)} onClick={() => setFormat(v)}>{l}</button>
        ))}</div>
      </div>
      {!data ? <PageLoading /> : !list.length ? <p className="text-[13px] text-stone">No ideas match.</p> : (
        <div className="panel divide-y divide-line !p-0">
          {(all ? list : list.slice(0, 12)).map((i) => (
            <div key={i.id}>
              <div className="flex items-center gap-3 px-3 py-2.5">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === i.id ? null : i.id)} aria-expanded={open === i.id}>
                  <span className="block text-[15px] text-ink">{i.title}</span>
                  <span className="block truncate text-[12px] text-stone">{FORMATS.find((f) => f.value === i.format)?.label}{i.alsoStory ? ' · also a Story' : ''} · {i.pillar}</span>
                </button>
                <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => use(i)}>Use this idea</Button>
              </div>
              {open === i.id && (
                <div className="space-y-1 bg-mist/40 px-3 pb-3 pt-1 text-[13px] text-ink-soft">
                  {i.hook && <p><span className="text-stone">Hook:</span> {i.hook}</p>}
                  {i.visual && <p><span className="text-stone">Visual:</span> {i.visual}</p>}
                  {i.shotList && <p className="whitespace-pre-wrap"><span className="text-stone">Shots:</span> {i.shotList}</p>}
                  {i.caption && <p className="whitespace-pre-wrap"><span className="text-stone">Caption:</span> {i.caption}</p>}
                  {i.hashtags && <p className="text-plum">{i.hashtags}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {list.length > 12 && !all && <div className="mt-2 flex justify-center"><Button size="sm" onClick={() => setAll(true)}>Show all {list.length}</Button></div>}
    </section>
  );
}

interface SharedLink { id: string; title: string; url: string; kind: 'post' | 'story' | 'both'; addedAt: string }
const isCanva = (url: string) => { try { return /(^|\.)canva\.(com|link)$/i.test(new URL(url).hostname); } catch { return false; } };

/** Content Calendar managers: share a link (a Canva design or template) with every stylist. */
function AddLink({ kind, onClose }: { kind: 'post' | 'story'; onClose: () => void }) {
  const toast = useToast();
  const [d, setD] = useState({ title: '', url: '', kind: kind as 'post' | 'story' | 'both' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.post('/my-content/links', d); onClose(); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Share a Canva link" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!d.url.trim()} onClick={save}>Share with stylists</Button></>}>
      <div className="space-y-3">
        <Field label="Link" hint="In Canva: Share → copy the link (set it so anyone with the link can view, or use a template link).">
          <input className="field" value={d.url} onChange={(e) => setD({ ...d, url: e.target.value })} placeholder="https://www.canva.com/design/…" autoFocus />
        </Field>
        <Field label="Name"><input className="field" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="e.g. Holiday story templates" /></Field>
        <Field label="Show under">
          <select className="field" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as typeof d.kind })}><option value="both">Posts and Stories</option><option value="post">Posts</option><option value="story">Stories</option></select>
        </Field>
      </div>
    </Modal>
  );
}
