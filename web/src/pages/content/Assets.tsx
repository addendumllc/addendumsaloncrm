import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Film, Search, Trash2, Upload } from 'lucide-react';
import type { ContentAccountId, ContentMediaDTO } from '@addendum/shared';
import { api } from '../../api/client';
import { Badge, Button, EmptyState, Field, Modal, PageLoading, cx, useToast } from '../../components/ui';
import { AccountTag, type Basics } from './common';

const useAssets = (f: { q: string; account: string; tag: string; approved: string }) => useQuery({
  queryKey: ['content-assets', f],
  queryFn: () => api.get<{ assets: ContentMediaDTO[] }>(`/content/assets?${new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][])}`).then((r) => r.assets),
});
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
        <Button variant="primary" className="ml-auto" icon={<Upload className="h-4 w-4" />} loading={uploading > 0} onClick={() => file.current?.click()}>Upload</Button>
        <input ref={file} type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime" className="hidden" onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
      </div>
      {isLoading ? <PageLoading /> : !data?.length ? <div className="panel"><EmptyState title="No assets yet">Upload photos and videos here, or with a post.</EmptyState></div> : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-7">
          {data.map((m) => (
            <button key={m.id} type="button" className="text-left" onClick={() => setOpen(m)}>
              <Thumb m={m} />
              <span className="mt-1 block truncate text-[12px] text-ink">{m.title || m.name || 'Untitled'}</span>
              <span className="block truncate text-[11px] text-stone">{m.account ? b.accountOf(m.account)?.name : 'All accounts'}{m.tags?.length ? ` · ${m.tags.join(', ')}` : ''}</span>
            </button>
          ))}
        </div>
      )}
      {open && <AssetEditor m={open} b={b} onClose={() => { setOpen(null); void qc.invalidateQueries({ queryKey: ['content-assets'] }); }} />}
    </div>
  );
}

function AssetEditor({ m, b, onClose }: { m: ContentMediaDTO; b: Basics; onClose: () => void }) {
  const toast = useToast();
  const [d, setD] = useState({ title: m.title ?? '', tags: (m.tags ?? []).join(', '), account: m.account ?? '', approved: !!m.approved, share: m.stylistShare ?? '' });
  const save = async () => {
    try {
      await api.patch(`/content/assets/${m.id}`, { title: d.title || null, tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean), account: (d.account || null) as ContentAccountId | null, stylistShare: (d.share || null) as 'post' | 'story' | null, ...(b.canApprove ? { approved: d.approved } : {}) });
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
