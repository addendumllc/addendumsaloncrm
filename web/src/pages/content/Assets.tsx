import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronLeft, ChevronRight, Download, ExternalLink, Film, Link2, Search, Trash2, Upload } from 'lucide-react';
import type { ContentAccountId, ContentMediaDTO } from '@addendum/shared';
import { api } from '../../api/client';
import { Badge, Button, EmptyState, Field, Modal, PageLoading, Segmented, buttonClass, cx, useToast } from '../../components/ui';
import { AccountTag, type Basics } from './common';

const useAssets = (f: { q: string; account: string; tag: string; approved: string }) => useQuery({
  queryKey: ['content-assets', f],
  queryFn: () => api.get<{ assets: ContentMediaDTO[] }>(`/content/assets?${new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][])}`).then((r) => r.assets),
});
type PostType = 'post' | 'story' | 'reel' | 'carousel';
const POST_TYPES: { value: PostType; label: string }[] = [{ value: 'post', label: 'Posts' }, { value: 'carousel', label: 'Carousels' }, { value: 'reel', label: 'Reels' }, { value: 'story', label: 'Stories' }];
interface AssetLink { id: string; title: string; url: string; kind: 'post' | 'story' | 'both'; postType?: PostType | null; group?: string | null; stylists?: boolean; addedAt: string }
const isCanva = (url: string) => { try { return /(^|\.)canva\.(com|link)$/i.test(new URL(url).hostname); } catch { return false; } };
/** One section of the grid: files and links of a type of post or a group. */
type Item = { kind: 'file'; m: ContentMediaDTO } | { kind: 'link'; l: AssetLink };
const typeOf = (x: Item) => (x.kind === 'file' ? x.m.postType : x.l.postType) ?? null;
const groupOf = (x: Item) => (x.kind === 'file' ? x.m.group : x.l.group) ?? null;
const Thumb = ({ m }: { m: ContentMediaDTO }) => (
  <span className="relative block aspect-square overflow-hidden rounded-lg border border-line bg-mist">
    {m.mime.startsWith('video/') ? <video src={m.url} className="h-full w-full object-cover" muted /> : <img src={m.url} alt="" className="h-full w-full object-cover" loading="lazy" />}
    {m.mime.startsWith('video/') && <Film className="absolute left-1.5 top-1.5 h-4 w-4 text-white drop-shadow" />}
    {m.approved && <CheckCircle2 className="absolute right-1.5 top-1.5 h-4 w-4 text-white drop-shadow" />}
    {m.stylistShare && <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1 text-[10px] text-white">Stylists · {m.stylistShare === 'story' ? 'Story' : 'Post'}</span>}
  </span>
);

/** Assets: every uploaded photo and video — search, tags, which account it belongs to, and approved for reuse. */
export function AssetsTab({ b }: { b: Basics }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ q: '', account: '', tag: '', approved: '' });
  const { data, isLoading } = useAssets(f);
  const [open, setOpen] = useState<{ list: ContentMediaDTO[]; id: string } | null>(null);
  const [uploading, setUploading] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const tags = [...new Set((data ?? []).flatMap((m) => m.tags ?? []))].sort();
  const { data: links } = useQuery({ queryKey: ['content-asset-links'], queryFn: () => api.get<{ links: AssetLink[] }>('/content/asset-links').then((r) => r.links) });
  const [groupBy, setGroupBy] = useState<'type' | 'group' | 'none'>(() => { try { return (localStorage.getItem('assets-group') as 'type' | 'group' | 'none') || 'type'; } catch { return 'type'; } });
  const setGroup = (v: typeof groupBy) => { setGroupBy(v); try { localStorage.setItem('assets-group', v); } catch { /* private window */ } };
  const [linkOpen, setLinkOpen] = useState<AssetLink | 'new' | null>(null);
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const items: Item[] = [
    ...(data ?? []).map((m) => ({ kind: 'file' as const, m })),
    // Links follow the search (title or group); the account / tag / approved filters are for files.
    ...(f.account || f.tag || f.approved ? [] : (links ?? []).filter((l) => words.every((w) => `${l.title} ${l.group ?? ''}`.toLowerCase().includes(w))).map((l) => ({ kind: 'link' as const, l }))),
  ];
  const groupNames = [...new Set([...(data ?? []).map((m) => m.group), ...(links ?? []).map((l) => l.group)].filter((x): x is string => !!x))].sort();
  // In a group (a carousel set…), the order matters: slides are numbered and can be moved; downloads follow it.
  const ordered = (sec: { title: string }) => groupBy === 'group' && groupNames.includes(sec.title);
  const move = async (sec: { items: Item[] }, id: string, d: -1 | 1) => {
    const ids = sec.items.flatMap((y) => (y.kind === 'file' ? [y.m.id] : []));
    const i = ids.indexOf(id), j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await api.post('/content/assets/order', { ids }); void qc.invalidateQueries({ queryKey: ['content-assets'] }); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const sections: { title: string; items: Item[] }[] = groupBy === 'none' ? [{ title: '', items }]
    : groupBy === 'type' ? [...POST_TYPES.map((t) => ({ title: t.label, items: items.filter((x) => typeOf(x) === t.value) })), { title: 'No type yet', items: items.filter((x) => !typeOf(x)) }]
      : [...groupNames.map((g) => ({ title: g, items: items.filter((x) => groupOf(x) === g) })), { title: 'Not in a group', items: items.filter((x) => !groupOf(x)) }];
  // One photo uploads straight away; several open the upload window (order, group, type of post) — or into a group.
  const [batch, setBatch] = useState<{ files: File[]; group: string; postType: string } | null>(null);
  const pickInto = useRef<{ group: string; postType: string } | null>(null);
  const upload = async (files: FileList | null) => {
    const list = [...(files ?? [])];
    const into = pickInto.current;
    pickInto.current = null;
    if (!list.length) return;
    if (list.length > 1 || into) { setBatch({ files: list, group: into?.group ?? '', postType: into?.postType ?? '' }); return; }
    setUploading((n) => n + 1);
    try { await api.upload('/content/media', list[0]); } catch (e) { toast(`${list[0].name}: ${(e as Error).message}`, 'error'); } finally { setUploading((n) => n - 1); }
    void qc.invalidateQueries({ queryKey: ['content-assets'] });
  };
  /** Add photos into a group (e.g. more slides for a carousel): they go after the ones already there, in order. */
  const addInto = (group: string, postType: string) => { pickInto.current = { group, postType }; file.current?.click(); };
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[12rem] flex-1 sm:max-w-xs"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" /><input className="field h-10 pl-9" placeholder="Search title or tag" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></label>
        <select className="field h-10 w-auto" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} aria-label="Account"><option value="">All accounts</option>{b.mine.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <select className="field h-10 w-auto" value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} aria-label="Tag"><option value="">All tags</option>{tags.map((t) => <option key={t}>{t}</option>)}</select>
        <select className="field h-10 w-auto" value={f.approved} onChange={(e) => setF({ ...f, approved: e.target.value })} aria-label="Approved"><option value="">Any</option><option value="true">Approved to reuse</option><option value="false">Not approved</option></select>
        <Segmented size="sm" value={groupBy} onChange={setGroup} options={[{ value: 'type', label: 'By type' }, { value: 'group', label: 'By group' }, { value: 'none', label: 'All' }]} />
        <Button className="ml-auto" icon={<Link2 className="h-4 w-4" />} onClick={() => setLinkOpen('new')}>Add Canva link</Button>
        <Button variant="primary" icon={<Upload className="h-4 w-4" />} loading={uploading > 0} onClick={() => { pickInto.current = null; file.current?.click(); }}>Upload</Button>
        <input ref={file} type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime" className="hidden" onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
      </div>
      {isLoading ? <PageLoading /> : !items.length ? <div className="panel"><EmptyState title="No assets yet">Upload photos and videos, or add a Canva link.</EmptyState></div> : (
        <div className="space-y-6">
          {sections.filter((sec) => sec.items.length).map((sec) => (
            <section key={sec.title || 'all'}>
              {sec.title && <div className="mb-2 flex items-center gap-2">
                <h3 className="text-[13px] font-semibold uppercase tracking-wide text-stone">{sec.title} <span className="font-normal">({sec.items.length})</span></h3>
                {groupBy === 'group' && groupNames.includes(sec.title) && <Button size="sm" className="ml-auto" icon={<Upload className="h-3.5 w-3.5" />} onClick={() => addInto(sec.title, typeOf(sec.items[0]) ?? '')}>Add photos</Button>}
                {/* A whole group at once: its photos and videos in a ZIP, with its links listed. */}
                {groupBy === 'group' && groupNames.includes(sec.title) && <a className={buttonClass('secondary', 'sm')} href={`/api/content/assets/group-download?group=${encodeURIComponent(sec.title)}`}><Download className="h-3.5 w-3.5" /><span className="btn-label">{sec.items.some((x) => typeOf(x) === 'carousel') ? 'Download carousel (in order)' : 'Download group'}</span></a>}
              </div>}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {sec.items.map((x) => x.kind === 'file' ? (
                  <Tile key={x.m.id} m={x.m} slide={ordered(sec) ? sec.items.filter((y) => y.kind === 'file').indexOf(x) + 1 : null}
                    onOpen={() => setOpen({ list: sec.items.flatMap((y) => (y.kind === 'file' ? [y.m] : [])), id: x.m.id })}
                    onMove={ordered(sec) ? (d) => move(sec, x.m.id, d) : undefined} />
                ) : (
                  <button key={x.l.id} type="button" className="text-left" onClick={() => setLinkOpen(x.l)}>
                    <span className={cx('relative flex aspect-[4/5] flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border border-line', isCanva(x.l.url) ? 'bg-[#7d2ae8] text-white' : 'bg-mist text-stone')}>
                      {isCanva(x.l.url) ? <span className="text-[26px] font-semibold leading-none">C</span> : <Link2 className="h-6 w-6" />}
                      <span className="text-[11px]">{isCanva(x.l.url) ? 'Canva' : 'Link'}</span>
                      {x.l.stylists !== false && <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1 text-[10px] text-white">Stylists</span>}
                    </span>
                    <span className="mt-1 block truncate text-[12px] text-ink">{x.l.title}</span>
                    <span className="block truncate text-[11px] text-stone">{[groupBy !== 'group' && x.l.group, 'Link'].filter(Boolean).join(' · ')}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <datalist id="asset-groups">{groupNames.map((g) => <option key={g} value={g} />)}</datalist>
      {linkOpen && <LinkEditor link={linkOpen === 'new' ? null : linkOpen} onClose={() => { setLinkOpen(null); void qc.invalidateQueries({ queryKey: ['content-asset-links'] }); }} />}
      {open && <AssetViewer list={open.list} startId={open.id} b={b} onClose={() => { setOpen(null); void qc.invalidateQueries({ queryKey: ['content-assets'] }); }}
        onAddPhotos={(group, postType) => { setOpen(null); void qc.invalidateQueries({ queryKey: ['content-assets'] }); addInto(group, postType); }} />}
      {batch && <UploadBatch initial={batch} groups={groupNames} existing={(data ?? []).filter((m) => batch.group && m.group === batch.group)} onClose={() => { setBatch(null); void qc.invalidateQueries({ queryKey: ['content-assets'] }); }} />}
    </div>
  );
}

const typeLabel = (t: PostType | null | undefined) => POST_TYPES.find((x) => x.value === t)?.label.replace(/s$/, '') ?? null;

/** A gallery tile: the photo or video, its type, title and description, and a download button. */
function Tile({ m, slide, onOpen, onMove }: { m: ContentMediaDTO; slide: number | null; onOpen: () => void; onMove?: (d: -1 | 1) => void }) {
  const video = m.mime.startsWith('video/');
  return (
    <div className="group relative overflow-hidden rounded-xl border border-line bg-white">
      <button type="button" className="block w-full text-left" onClick={onOpen}>
        <span className="relative block aspect-[4/5] overflow-hidden bg-mist">
          {video ? <video src={m.url} muted playsInline preload="metadata" className="h-full w-full object-cover" /> : <img src={m.url} alt={m.title ?? ''} loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]" />}
          <span className="absolute left-2 top-2 flex flex-wrap gap-1">
            {slide != null && <span className="rounded-full bg-ink/80 px-2 py-0.5 text-[11px] font-medium text-white">{slide}</span>}
            {m.postType && <span className="rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-medium text-ink">{typeLabel(m.postType)}</span>}
            {video && <span className="rounded-full bg-white/90 px-2 py-0.5 text-[11px] text-ink"><Film className="inline h-3 w-3" /></span>}
          </span>
          {m.approved && <CheckCircle2 className="absolute bottom-2 right-2 h-4 w-4 text-white drop-shadow" />}
        </span>
        <span className="block px-2.5 py-2">
          <span className="block truncate text-[13px] font-medium text-ink">{m.title || m.name || 'Untitled'}</span>
          <span className="line-clamp-2 block min-h-[2.4em] text-[12px] leading-snug text-stone">{m.description || (m.stylistShare ? `Stylists can download · ${m.stylistShare === 'story' ? 'Story' : 'Post'}` : 'No description yet')}</span>
        </span>
      </button>
      <a href={`${m.url}?download`} className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-ink shadow-sm hover:bg-white" aria-label={`Download ${m.title ?? 'asset'}`} title="Download"><Download className="h-4 w-4" /></a>
      {onMove && (
        <span className="absolute right-2 top-12 flex flex-col gap-1">
          <button type="button" className="flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-ink shadow-sm" aria-label="Earlier in the order" onClick={() => onMove(-1)}><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" className="flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-ink shadow-sm" aria-label="Later in the order" onClick={() => onMove(1)}><ChevronRight className="h-4 w-4" /></button>
        </span>
      )}
    </div>
  );
}

/** The photo or video large, with what it is (type, description) and Download; its details edited alongside. Arrows go through the gallery. */
function AssetViewer({ list, startId, b, onClose, onAddPhotos }: { list: ContentMediaDTO[]; startId: string; b: Basics; onClose: () => void; onAddPhotos: (group: string, postType: string) => void }) {
  const [i, setI] = useState(Math.max(0, list.findIndex((x) => x.id === startId)));
  const m = list[i];
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.target as HTMLElement)?.closest('input,textarea,select')) return; if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1)); if (e.key === 'ArrowRight') setI((x) => Math.min(list.length - 1, x + 1)); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [list.length]);
  return <AssetDetails key={m.id} m={m} b={b} onClose={onClose} onAddPhotos={onAddPhotos} nav={list.length > 1 ? { at: i + 1, of: list.length, prev: i > 0 ? () => setI(i - 1) : undefined, next: i < list.length - 1 ? () => setI(i + 1) : undefined } : null} />;
}

function AssetDetails({ m, b, onClose, onAddPhotos, nav }: { m: ContentMediaDTO; b: Basics; onClose: () => void; onAddPhotos: (group: string, postType: string) => void; nav: { at: number; of: number; prev?: () => void; next?: () => void } | null }) {
  const toast = useToast();
  const [d, setD] = useState({ title: m.title ?? '', description: m.description ?? '', tags: (m.tags ?? []).join(', '), account: m.account ?? '', approved: !!m.approved, share: m.stylistShare ?? '', postType: m.postType ?? '', group: m.group ?? '' });
  const [saved, setSaved] = useState(false);
  const save = async (close = true) => {
    try {
      await api.patch(`/content/assets/${m.id}`, { title: d.title || null, description: d.description.trim() || null, tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean), account: (d.account || null) as ContentAccountId | null, stylistShare: (d.share || null) as 'post' | 'story' | null, postType: (d.postType || null) as PostType | null, group: d.group.trim() || null, ...(b.canApprove ? { approved: d.approved } : {}) });
      if (close) onClose(); else { setSaved(true); setTimeout(() => setSaved(false), 1500); }
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const del = async () => { if (!window.confirm('Delete this file?')) return; try { await api.del(`/content/assets/${m.id}`); onClose(); } catch (e) { toast((e as Error).message, 'error'); } };
  const go = async (f?: () => void) => { if (!f) return; await save(false); f(); };
  const video = m.mime.startsWith('video/');
  return (
    <Modal open xl onClose={onClose} title={m.title || m.name || 'Asset'} footer={<>
      <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} className="mr-auto" onClick={del}>Delete</Button>
      <Button variant="ghost" onClick={onClose}>Close</Button>
      <Button variant="primary" onClick={() => save()}>{saved ? 'Saved' : 'Save'}</Button>
    </>}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div>
          <div className="relative flex items-center justify-center overflow-hidden rounded-xl bg-ink/95">
            {video ? <video key={m.id} src={m.url} controls playsInline className="max-h-[70vh] w-full object-contain" /> : <img src={m.url} alt={m.title ?? ''} className="max-h-[70vh] w-full object-contain" />}
            {nav?.prev && <button type="button" onClick={() => go(nav.prev)} className="absolute left-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink shadow" aria-label="Previous"><ChevronLeft className="h-5 w-5" /></button>}
            {nav?.next && <button type="button" onClick={() => go(nav.next)} className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink shadow" aria-label="Next"><ChevronRight className="h-5 w-5" /></button>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-stone">
            {nav && <span>{nav.at} of {nav.of}</span>}
            {m.postType && <Badge>{typeLabel(m.postType)}</Badge>}
            {m.group && <Badge tone="plum">{m.group}</Badge>}
            <span>{m.mime.split('/')[1]?.toUpperCase()} · {(m.size / 1024 / 1024).toFixed(1)} MB</span>
            <Button size="sm" className="ml-auto" icon={<Upload className="h-4 w-4" />} onClick={async () => {
              // Into this photo's group — one named after it when it has none yet (it becomes slide 1).
              const group = d.group.trim() || d.title.trim() || 'Carousel';
              const postType = d.postType || 'carousel';
              if (group !== d.group.trim() || postType !== d.postType) { setD({ ...d, group, postType }); await api.patch(`/content/assets/${m.id}`, { group, postType }); }
              onAddPhotos(group, postType);
            }}>Add photos to this group</Button>
            <a className={buttonClass('primary', 'sm')} href={`${m.url}?download`}><Download className="h-4 w-4" /><span className="btn-label">Download</span></a>
          </div>
        </div>
        <div className="space-y-3 text-[14px]">
          <Field label="Title"><input className="field" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
          <Field label="Description" hint="What it is and how to use it — e.g. “Slide 2 of the holiday carousel: before & after.”"><textarea className="field min-h-[80px]" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type of post"><select className="field" value={d.postType} onChange={(e) => setD({ ...d, postType: e.target.value })}><option value="">—</option>{POST_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label.replace(/s$/, '')}</option>)}</select></Field>
            <Field label="Group" hint="A carousel set or campaign"><input className="field" list="asset-groups" value={d.group} onChange={(e) => setD({ ...d, group: e.target.value })} placeholder="e.g. Holiday 2026" /></Field>
          </div>
          <Field label="Stylists can download" hint="Shows in every stylist’s My Content → Salon downloads.">
            <select className="field" value={d.share} onChange={(e) => setD({ ...d, share: e.target.value })}><option value="">No</option><option value="post">Yes — as a post</option><option value="story">Yes — as a story</option></select>
          </Field>
          <details className="rounded-lg border border-line p-2.5">
            <summary className="cursor-pointer text-[13px] text-ink">Account, tags, approval</summary>
            <div className="mt-2 space-y-3">
              <Field label="Account" hint="Restrict it to one account, or share it with all."><select className="field" value={d.account} onChange={(e) => setD({ ...d, account: e.target.value })}><option value="">All accounts</option>{b.mine.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
              <Field label="Tags" hint="Separate with commas"><input className="field" value={d.tags} onChange={(e) => setD({ ...d, tags: e.target.value })} /></Field>
              <label className={cx('flex items-center gap-2 text-[13px]', !b.canApprove && 'opacity-60')}><input type="checkbox" className="h-4 w-4 accent-plum" disabled={!b.canApprove} checked={d.approved} onChange={(e) => setD({ ...d, approved: e.target.checked })} />Approved to reuse{!b.canApprove && ' (approvers only)'}</label>
            </div>
          </details>
        </div>
      </div>
    </Modal>
  );
}

/** Pick files from the library for a post (that account's and shared ones; approved first). */
export function AssetPicker({ account, onPick, onClose }: { account?: ContentAccountId; onPick: (m: ContentMediaDTO[]) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const { data, isLoading } = useAssets({ q, account: account ?? '', tag: '', approved: '' });
  const [sel, setSel] = useState<ContentMediaDTO[]>([]);
  const list = [...(data ?? [])].sort((a, b2) => Number(!!b2.approved) - Number(!!a.approved));
  return (
    <Modal open xl onClose={onClose} title="Asset library" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!sel.length} onClick={() => onPick(sel)}>Add {sel.length || ''}</Button></>}>
      <input className="field mb-3" placeholder="Search title or tag" value={q} onChange={(e) => setQ(e.target.value)} />
      {isLoading ? <PageLoading /> : !list.length ? <p className="text-[13px] text-stone">Nothing here yet.</p> : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {list.map((m) => { const on = sel.some((x) => x.id === m.id); return (
            <button key={m.id} type="button" className={cx('rounded-lg p-0.5', on && 'ring-2 ring-plum')} onClick={() => setSel(on ? sel.filter((x) => x.id !== m.id) : [...sel, m])}>
              <Thumb m={m} /><span className="mt-0.5 block truncate text-[11px] text-stone">{m.title || m.name}</span>{m.approved && <Badge tone="sage">Approved</Badge>}
            </button>
          ); })}
        </div>
      )}
    </Modal>
  );
}
export { AccountTag };

/** A Canva design or template (or another link) kept with the assets — shared with stylists unless turned off. */
function LinkEditor({ link, onClose }: { link: AssetLink | null; onClose: () => void }) {
  const toast = useToast();
  const [d, setD] = useState({ url: link?.url ?? '', title: link?.title ?? '', postType: link?.postType ?? '', group: link?.group ?? '', stylists: link?.stylists !== false });
  const [busy, setBusy] = useState(false);
  const body = { title: d.title, postType: (d.postType || null) as PostType | null, group: d.group.trim() || null, stylists: d.stylists };
  const save = async () => {
    setBusy(true);
    try {
      if (link) await api.patch(`/content/asset-links/${link.id}`, body);
      else await api.post('/content/asset-links', { ...body, url: d.url.trim() });
      onClose();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const del = async () => { if (!link || !window.confirm(`Remove “${link.title}”?`)) return; try { await api.del(`/content/asset-links/${link.id}`); onClose(); } catch (e) { toast((e as Error).message, 'error'); } };
  return (
    <Modal open onClose={onClose} title={link ? link.title : 'Add a Canva link'} footer={<>
      {link && <Button variant="ghost" className="mr-auto" icon={<Trash2 className="h-4 w-4" />} onClick={del}>Remove</Button>}
      <Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!d.url.trim()} onClick={save}>Save</Button>
    </>}>
      <div className="space-y-3">
        {link ? (
          <a className={buttonClass('secondary')} href={link.url} target="_blank" rel="noreferrer noopener"><ExternalLink className="h-4 w-4" /><span className="btn-label">{isCanva(link.url) ? 'Open in Canva' : 'Open link'}</span></a>
        ) : (
          <Field label="Link" hint="In Canva: Share → copy the link (anyone with the link can view, or a template link).">
            <input className="field" autoFocus value={d.url} onChange={(e) => setD({ ...d, url: e.target.value })} placeholder="https://www.canva.com/design/…" />
          </Field>
        )}
        <Field label="Name"><input className="field" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="e.g. Holiday story templates" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type of post"><select className="field" value={d.postType} onChange={(e) => setD({ ...d, postType: e.target.value })}><option value="">—</option>{POST_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label.replace(/s$/, '')}</option>)}</select></Field>
          <Field label="Group"><input className="field" list="asset-groups" value={d.group} onChange={(e) => setD({ ...d, group: e.target.value })} placeholder="e.g. Holiday 2026" /></Field>
        </div>
        <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" className="h-4 w-4 accent-plum" checked={d.stylists} onChange={(e) => setD({ ...d, stylists: e.target.checked })} />Stylists can open it (My Content → Salon downloads)</label>
      </div>
    </Modal>
  );
}

/** Several photos at once: put them in order (a carousel's slides), then give them a group and type of post. */
function UploadBatch({ initial, groups, existing, onClose }: { initial: { files: File[]; group: string; postType: string }; groups: string[]; existing: ContentMediaDTO[]; onClose: () => void }) {
  const toast = useToast();
  const [files, setFiles] = useState(initial.files);
  const [group, setGroup] = useState(initial.group);
  const [postType, setPostType] = useState(initial.postType || (initial.files.length > 1 ? 'carousel' : ''));
  const [done, setDone] = useState(0);
  const [busy, setBusy] = useState(false);
  const previews = useMemo(() => files.map((f) => ({ f, url: URL.createObjectURL(f) })), [files]);
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);
  const move = (i: number, d: -1 | 1) => { const n = [...files]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; setFiles(n); };
  const go = async () => {
    setBusy(true);
    const ids: string[] = [];
    for (const f of files) {
      try {
        const r = await api.upload<{ media: ContentMediaDTO }>('/content/media', f);
        if (group.trim() || postType) await api.patch(`/content/assets/${r.media.id}`, { group: group.trim() || null, postType: (postType || null) as PostType | null });
        ids.push(r.media.id);
      } catch (e) { toast(`${f.name}: ${(e as Error).message}`, 'error'); }
      setDone((n) => n + 1);
    }
    // The order: what was already in the group, then these as picked.
    if (group.trim() && ids.length) await api.post('/content/assets/order', { ids: [...existing.map((m) => m.id), ...ids] }).catch(() => undefined);
    toast(`${ids.length} uploaded${group.trim() ? ` to ${group.trim()}` : ''}`);
    onClose();
  };
  return (
    <Modal open wide onClose={() => !busy && onClose()} title={`Upload ${files.length} photo${files.length === 1 ? '' : 's'}`} footer={<>
      <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={busy} disabled={!files.length} onClick={go}>{busy ? `${done} of ${files.length}…` : 'Upload'}</Button>
    </>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Group" hint={existing.length ? `Added after the ${existing.length} already in it` : 'Optional — a carousel set or campaign'}><input className="field" list="asset-groups" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="e.g. Holiday carousel" /></Field>
          <Field label="Type of post"><select className="field" value={postType} onChange={(e) => setPostType(e.target.value)}><option value="">—</option>{POST_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label.replace(/s$/, '')}</option>)}</select></Field>
        </div>
        <datalist id="asset-groups-batch">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        <div>
          <p className="label">Order {files.length > 1 && <span className="font-normal text-stone">— the carousel’s slide order; downloads follow it</span>}</p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {previews.map((p, i) => (
              <div key={p.url} className="relative overflow-hidden rounded-lg border border-line">
                {p.f.type.startsWith('video/') ? <video src={p.url} muted className="aspect-[4/5] w-full object-cover" /> : <img src={p.url} alt="" className="aspect-[4/5] w-full object-cover" />}
                <span className="absolute left-1 top-1 rounded-full bg-ink/80 px-1.5 text-[11px] text-white">{existing.length + i + 1}</span>
                <span className="absolute inset-x-1 bottom-1 flex justify-between">
                  <button type="button" disabled={busy || i === 0} onClick={() => move(i, -1)} className="flex h-7 w-7 items-center justify-center rounded-full bg-white/90 shadow disabled:opacity-30" aria-label="Earlier"><ChevronLeft className="h-4 w-4" /></button>
                  <button type="button" disabled={busy} onClick={() => setFiles(files.filter((_, k) => k !== i))} className="flex h-7 w-7 items-center justify-center rounded-full bg-white/90 shadow" aria-label="Leave out"><Trash2 className="h-3.5 w-3.5" /></button>
                  <button type="button" disabled={busy || i === files.length - 1} onClick={() => move(i, 1)} className="flex h-7 w-7 items-center justify-center rounded-full bg-white/90 shadow disabled:opacity-30" aria-label="Later"><ChevronRight className="h-4 w-4" /></button>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
