import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, ExternalLink, Film, Link2, Search, Trash2, Upload } from 'lucide-react';
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
  const [open, setOpen] = useState<ContentMediaDTO | null>(null);
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
  const sections: { title: string; items: Item[] }[] = groupBy === 'none' ? [{ title: '', items }]
    : groupBy === 'type' ? [...POST_TYPES.map((t) => ({ title: t.label, items: items.filter((x) => typeOf(x) === t.value) })), { title: 'No type yet', items: items.filter((x) => !typeOf(x)) }]
      : [...groupNames.map((g) => ({ title: g, items: items.filter((x) => groupOf(x) === g) })), { title: 'Not in a group', items: items.filter((x) => !groupOf(x)) }];
  const upload = async (files: FileList | null) => {
    for (const x of [...(files ?? [])]) {
      setUploading((n) => n + 1);
      try { await api.upload('/content/media', x); } catch (e) { toast(`${x.name}: ${(e as Error).message}`, 'error'); } finally { setUploading((n) => n - 1); }
    }
    void qc.invalidateQueries({ queryKey: ['content-assets'] });
  };
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[12rem] flex-1 sm:max-w-xs"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" /><input className="field h-10 pl-9" placeholder="Search title or tag" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></label>
        <select className="field h-10 w-auto" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} aria-label="Account"><option value="">All accounts</option>{b.mine.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <select className="field h-10 w-auto" value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} aria-label="Tag"><option value="">All tags</option>{tags.map((t) => <option key={t}>{t}</option>)}</select>
        <select className="field h-10 w-auto" value={f.approved} onChange={(e) => setF({ ...f, approved: e.target.value })} aria-label="Approved"><option value="">Any</option><option value="true">Approved to reuse</option><option value="false">Not approved</option></select>
        <Segmented size="sm" value={groupBy} onChange={setGroup} options={[{ value: 'type', label: 'By type' }, { value: 'group', label: 'By group' }, { value: 'none', label: 'All' }]} />
        <Button className="ml-auto" icon={<Link2 className="h-4 w-4" />} onClick={() => setLinkOpen('new')}>Add Canva link</Button>
        <Button variant="primary" icon={<Upload className="h-4 w-4" />} loading={uploading > 0} onClick={() => file.current?.click()}>Upload</Button>
        <input ref={file} type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime" className="hidden" onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
      </div>
      {isLoading ? <PageLoading /> : !items.length ? <div className="panel"><EmptyState title="No assets yet">Upload photos and videos, or add a Canva link.</EmptyState></div> : (
        <div className="space-y-6">
          {sections.filter((sec) => sec.items.length).map((sec) => (
            <section key={sec.title || 'all'}>
              {sec.title && <div className="mb-2 flex items-center gap-2">
                <h3 className="text-[13px] font-semibold uppercase tracking-wide text-stone">{sec.title} <span className="font-normal">({sec.items.length})</span></h3>
                {/* A whole group at once: its photos and videos in a ZIP, with its links listed. */}
                {groupBy === 'group' && groupNames.includes(sec.title) && <a className={buttonClass('secondary', 'sm', 'ml-auto')} href={`/api/content/assets/group-download?group=${encodeURIComponent(sec.title)}`}><Download className="h-3.5 w-3.5" /><span className="btn-label">Download group</span></a>}
              </div>}
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-7">
                {sec.items.map((x) => x.kind === 'file' ? (
                  <button key={x.m.id} type="button" className="text-left" onClick={() => setOpen(x.m)}>
                    <Thumb m={x.m} />
                    <span className="mt-1 block truncate text-[12px] text-ink">{x.m.title || x.m.name || 'Untitled'}</span>
                    <span className="block truncate text-[11px] text-stone">{[x.m.account ? b.accountOf(x.m.account)?.name : 'All accounts', groupBy !== 'group' && x.m.group, ...(x.m.tags ?? [])].filter(Boolean).join(' · ')}</span>
                  </button>
                ) : (
                  <button key={x.l.id} type="button" className="text-left" onClick={() => setLinkOpen(x.l)}>
                    <span className={cx('relative flex aspect-square flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border border-line', isCanva(x.l.url) ? 'bg-[#7d2ae8] text-white' : 'bg-mist text-stone')}>
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
      {open && <AssetEditor m={open} b={b} onClose={() => { setOpen(null); void qc.invalidateQueries({ queryKey: ['content-assets'] }); }} />}
    </div>
  );
}

function AssetEditor({ m, b, onClose }: { m: ContentMediaDTO; b: Basics; onClose: () => void }) {
  const toast = useToast();
  const [d, setD] = useState({ title: m.title ?? '', tags: (m.tags ?? []).join(', '), account: m.account ?? '', approved: !!m.approved, share: m.stylistShare ?? '', postType: m.postType ?? '', group: m.group ?? '' });
  const save = async () => {
    try {
      await api.patch(`/content/assets/${m.id}`, { title: d.title || null, tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean), account: (d.account || null) as ContentAccountId | null, stylistShare: (d.share || null) as 'post' | 'story' | null, postType: (d.postType || null) as PostType | null, group: d.group.trim() || null, ...(b.canApprove ? { approved: d.approved } : {}) });
      onClose();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const del = async () => { if (!window.confirm('Delete this file?')) return; try { await api.del(`/content/assets/${m.id}`); onClose(); } catch (e) { toast((e as Error).message, 'error'); } };
  return (
    <Modal open wide onClose={onClose} title={m.title || m.name || 'Asset'} footer={<><Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} className="mr-auto" onClick={del}>Delete</Button><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-[14rem_1fr]">
        <Thumb m={m} />
        <div className="space-y-3 text-[14px]">
          <Field label="Title"><input className="field" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
          <Field label="Tags" hint="Separate with commas, e.g. balayage, before-after"><input className="field" value={d.tags} onChange={(e) => setD({ ...d, tags: e.target.value })} /></Field>
          <Field label="Account" hint="Restrict it to one account, or share it with all."><select className="field" value={d.account} onChange={(e) => setD({ ...d, account: e.target.value })}><option value="">All accounts</option>{b.mine.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type of post"><select className="field" value={d.postType} onChange={(e) => setD({ ...d, postType: e.target.value })}><option value="">—</option>{POST_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label.replace(/s$/, '')}</option>)}</select></Field>
            <Field label="Group" hint="e.g. a carousel set or campaign"><input className="field" list="asset-groups" value={d.group} onChange={(e) => setD({ ...d, group: e.target.value })} placeholder="e.g. Holiday 2026" /></Field>
          </div>
          <Field label="Stylists can download" hint="Shows in every stylist’s My Content → Salon downloads.">
            <select className="field" value={d.share} onChange={(e) => setD({ ...d, share: e.target.value })}><option value="">No</option><option value="post">Yes — as a post</option><option value="story">Yes — as a story</option></select>
          </Field>
          <label className={cx('flex items-center gap-2 text-[13px]', !b.canApprove && 'opacity-60')}><input type="checkbox" className="h-4 w-4 accent-plum" disabled={!b.canApprove} checked={d.approved} onChange={(e) => setD({ ...d, approved: e.target.checked })} />Approved to reuse{!b.canApprove && ' (approvers only)'}</label>
          <p className="text-[12px] text-stone">{m.mime} · {(m.size / 1024 / 1024).toFixed(1)} MB</p>
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
