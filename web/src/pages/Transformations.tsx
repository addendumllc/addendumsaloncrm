import { useSearchParams } from 'react-router-dom';
import { SectionPicker } from '../components/layout/subNav';
import { useCanDo, useMe } from '../api/hooks';
import { useStoreNames } from '../lib/storeNames';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown, ArrowUp, Camera, Play, UserCheck, Check, CheckSquare, Copy, Download, ExternalLink, FolderPlus, Grid3x3, Instagram, LayoutList, Pencil, Plus, RefreshCw, Search, Settings2, Star, Trash2, Upload, X,
} from 'lucide-react';
import { CONSENT_STATUSES, EXTENSION_METHODS, EXTENSION_WORK, type TransformationDTO, type TransformationPhotoDTO, type TransformationPhotoKind } from '@addendum/shared';
import { api } from '../api/client';
import { Badge, Button, EmptyState, ErrorNote, Field, Modal, PageHeader, PageLoading, Segmented, Spinner, Toggle, buttonClass, cx, useToast, chipClass } from '../components/ui';

interface Options {
  services: string[]; catalog: string[]; stylists: { id: string; name: string }[]; tags: string[]; methods: string[]; collections: { id: string; name: string; count: number }[];
  can: { create: boolean; viewAll: boolean; manage: boolean; consent: boolean; download: boolean; bulk: boolean; technical: boolean };
}
interface Filter { q: string; stylist: string; service: string; extensions: string; collection: string; consent: string; from: string; to: string; sort: string }
const EMPTY: Filter = { q: '', stylist: '', service: '', extensions: '', collection: '', consent: '', from: '', to: '', sort: 'newest' };
const KINDS: { value: TransformationPhotoKind; label: string }[] = [
  { value: 'before', label: 'Before' }, { value: 'after', label: 'After' }, { value: 'finished', label: 'Finished look' }, { value: 'detail', label: 'Detail' }, { value: 'other', label: 'Other' },
];
const isVideo = (p: { mime: string }) => p.mime.startsWith('video/');
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? 'Photo';
const consentLabel = (s: string) => CONSENT_STATUSES.find((c) => c.value === s)?.label ?? s;
const CONSENT_TONE: Record<string, 'sage' | 'amber' | 'neutral' | 'rose'> = { approved_social: 'sage', pending: 'amber', internal: 'neutral', do_not_publish: 'rose' };
const isExt = (s: string) => /extension/i.test(s);
const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const qs = (o: Record<string, string | number | boolean | undefined>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== false).map(([k, v]) => [k, String(v)])).toString();
const PAGE = 24;

const useOptions = () => useQuery({ queryKey: ['transformations-options'], queryFn: () => api.get<Options>('/transformations/options'), staleTime: 60_000 });
function useLibrary(f: Filter, ready: boolean) {
  return useInfiniteQuery({
    queryKey: ['transformations', f, ready],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.get<{ items: TransformationDTO[]; total: number; nextOffset: number | null }>(`/transformations?${qs({ ...f, ready, limit: PAGE, offset: pageParam })}`),
    getNextPageParam: (p) => p.nextOffset ?? undefined,
  });
}

/** The picture a card shows: an after / finished photo first, then any photo, then the Instagram preview. */
function Cover({ t, className, small }: { t: TransformationDTO; className?: string; small?: boolean }) {
  const photo = t.photos.find((p) => p.kind === 'after' || p.kind === 'finished') ?? t.photos[0];
  const ig = t.instagram.find((i) => i.isPrimary) ?? t.instagram[0];
  const [broken, setBroken] = useState(false);
  const src = photo ? photo.thumbUrl : ig?.thumbnailUrl;
  // No photo of our own but an Instagram post: show the post's picture with Instagram's embed (shown, never copied).
  if (!photo && ig && !(src && !broken) && !small) return (
    <span className={cx('relative block overflow-hidden bg-mist', className)}>
      <iframe title="Instagram post" src={`${ig.url.replace(/\/?$/, '/')}embed/`} loading="lazy" scrolling="no" tabIndex={-1}
        className="pointer-events-none absolute inset-x-0 -top-[56px] h-[calc(100%+180px)] w-full border-0 bg-white" sandbox="allow-scripts allow-same-origin" />
      <Instagram className="absolute left-1.5 top-1.5 h-4 w-4 text-white drop-shadow" />
    </span>
  );
  return (
    <span className={cx('relative block overflow-hidden bg-mist', className)}>
      {src && !broken ? <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setBroken(true)} />
        : <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-stone">{ig ? <Instagram className="h-6 w-6" /> : <Camera className="h-6 w-6" />}<span className="text-[11px]">{ig ? 'Instagram' : photo ? 'Preview unavailable' : 'No photo yet'}</span></span>}
      {!photo && ig && src && !broken && <Instagram className="absolute left-1.5 top-1.5 h-4 w-4 text-white drop-shadow" />}
      {photo && isVideo(photo) && <Play className="absolute left-1.5 top-1.5 h-4 w-4 fill-white text-white drop-shadow" />}
    </span>
  );
}
/** What was done, in a line: the services, and for extensions the method (hybrid: each method). */
const doneOf = (t: TransformationDTO) => {
  const e = t.extension;
  const ext = e?.hasExtensions ? (e.parts?.length ? [...new Set(e.parts.map((x) => x.method).filter(Boolean))].join(' + ') : e.method) : null;
  return [...t.services.length ? t.services : [t.mainService], ext].filter(Boolean).join(' · ') || 'Service to be added';
};
const ConsentBadge = ({ t }: { t: TransformationDTO }) => <Badge tone={t.readyForSocial ? 'sage' : CONSENT_TONE[t.consent.status] === 'sage' ? 'amber' : CONSENT_TONE[t.consent.status]}>{t.readyForSocial ? 'Ready for Social' : consentLabel(t.consent.status)}</Badge>;

export function TransformationsPage() {
  const opts = useOptions();
  const qc = useQueryClient();
  const toast = useToast();
  const [params] = useSearchParams();
  const tab: 'library' | 'social' = params.get('tab') === 'social' ? 'social' : 'library';
  const names = useStoreNames();
  const canDo = useCanDo();
  const [f, setF] = useState<Filter>(EMPTY);
  const [q, setQ] = useState('');
  useEffect(() => { const h = setTimeout(() => setF((x) => ({ ...x, q })), 300); return () => clearTimeout(h); }, [q]);
  const [view, setView] = useState<'grid' | 'list'>(() => { try { return (localStorage.getItem('tf-view') as 'grid' | 'list') || 'grid'; } catch { return 'grid'; } });
  useEffect(() => { try { localStorage.setItem('tf-view', view); } catch { /* private window */ } }, [view]);
  const lib = useLibrary(f, tab === 'social');
  const items = useMemo(() => lib.data?.pages.flatMap((p) => p.items) ?? [], [lib.data]);
  const total = lib.data?.pages[0]?.total ?? 0;
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => setSel(new Set()), [tab]);
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<TransformationDTO | 'new' | null>(null);
  const [confirming, setConfirming] = useState<Appt | null>(null);
  const openParam = params.get('open');
  useEffect(() => { if (openParam) setOpen(openParam); }, [openParam]);
  const [exportId, setExportId] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [collect, setCollect] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['transformations'] }); void qc.invalidateQueries({ queryKey: ['transformation'] }); void qc.invalidateQueries({ queryKey: ['transformations-options'] }); };
  if (opts.isLoading) return <PageLoading />;
  if (opts.error) return <ErrorNote error={opts.error} onRetry={() => opts.refetch()} />;
  const o = opts.data!;
  // Consent, approval and social posts are for administrators; stylists see who did what.
  const social = o.can.manage || o.can.consent;
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const startExport = async (body: object) => {
    try { setExportId((await api.post<{ id: string }>('/transformations/exports', body)).id); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const filterBody = { ...Object.fromEntries(Object.entries(f).filter(([k, v]) => v && k !== 'sort')) };
  const set = (k: keyof Filter) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const filtersOn = Object.entries(f).some(([k, v]) => v && k !== 'sort' && k !== 'q');

  return (
    <div>
      <PageHeader title="Transformations" subtitle={social ? 'The salon’s work and what was done — approve photos for social media.' : 'Your work and what was done.'}
        actions={<>
          {o.can.manage && <Button icon={<Settings2 className="h-4 w-4" />} onClick={() => setSettings(true)}>Services & collections</Button>}
          {o.can.create && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit('new')}>New transformation</Button>}
        </>} />
      <SectionPicker path="/transformations" names={names} can={canDo} />

      {tab === 'library' && o.can.create && <ToConfirm onConfirm={setConfirming} onDetails={(id) => api.get<{ transformation: TransformationDTO }>(`/transformations/${id}`).then((r) => setEdit(r.transformation)).catch((e) => toast((e as Error).message, 'error'))} />}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[12rem] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
          <input className="field h-10 pl-9" placeholder="Search client, stylist, service, method, colour, tag" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {o.can.viewAll && o.stylists.length > 1 && <select className="field h-10 w-auto" aria-label="Stylist" value={f.stylist} onChange={(e) => set('stylist')(e.target.value)}><option value="">All stylists</option>{o.stylists.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
        <select className="field h-10 w-auto" aria-label="Service" value={f.service} onChange={(e) => set('service')(e.target.value)}><option value="">All services</option>{o.services.map((s) => <option key={s}>{s}</option>)}</select>
        <select className="field h-10 w-auto" aria-label="Extensions" value={f.extensions} onChange={(e) => set('extensions')(e.target.value)}>
          <option value="">Extensions: any</option><option value="yes">With extensions</option><option value="no">No extensions</option>
          {[...new Set([...EXTENSION_METHODS.filter((m) => m !== 'Other'), ...o.methods])].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        {o.collections.length > 0 && <select className="field h-10 w-auto" aria-label="Collection" value={f.collection} onChange={(e) => set('collection')(e.target.value)}><option value="">All collections</option>{o.collections.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.count})</option>)}</select>}
        {tab === 'library' && social && <select className="field h-10 w-auto" aria-label="Approval" value={f.consent} onChange={(e) => set('consent')(e.target.value)}><option value="">Any approval</option>{CONSENT_STATUSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>}
        <span className="flex items-center gap-1 text-[13px] text-stone">
          <input type="date" className="field h-10 w-auto" aria-label="From" value={f.from} onChange={(e) => set('from')(e.target.value)} />–
          <input type="date" className="field h-10 w-auto" aria-label="To" value={f.to} onChange={(e) => set('to')(e.target.value)} />
        </span>
        <select className="field h-10 w-auto" aria-label="Sort" value={f.sort} onChange={(e) => set('sort')(e.target.value)}>
          <option value="newest">Newest</option><option value="oldest">Oldest</option><option value="updated">Recently updated</option><option value="stylist">Stylist</option><option value="service">Service</option>
        </select>
        {filtersOn && <Button variant="ghost" size="sm" onClick={() => setF({ ...EMPTY, q: f.q, sort: f.sort })}>Clear filters</Button>}
        <Segmented className="ml-auto" value={view} onChange={setView} options={[{ value: 'grid', label: <Grid3x3 className="h-4 w-4" aria-label="Grid" /> }, { value: 'list', label: <LayoutList className="h-4 w-4" aria-label="List" /> }]} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px] text-stone">
        <span>{lib.isLoading ? 'Loading…' : `${total} transformation${total === 1 ? '' : 's'}`}{tab === 'social' && ' approved for social media'}</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {o.can.bulk && <Button size="sm" variant={selecting ? 'primary' : 'secondary'} icon={<CheckSquare className="h-4 w-4" />} onClick={() => { setSelecting(!selecting); setSel(new Set()); }}>{selecting ? 'Done selecting' : 'Select'}</Button>}
          {selecting && <>
            <Button size="sm" onClick={() => setSel(new Set(items.map((t) => t.id)))}>Select shown ({items.length})</Button>
            <Button size="sm" variant="primary" disabled={!sel.size} icon={<Download className="h-4 w-4" />} onClick={() => startExport({ preset: 'selected', ids: [...sel], approvedOnly: tab === 'social' })}>Download Selected ({sel.size})</Button>
            {o.can.manage && <Button size="sm" disabled={!sel.size} icon={<FolderPlus className="h-4 w-4" />} onClick={() => setCollect(true)}>Add to collection</Button>}
          </>}
          {o.can.bulk && total > 0 && <Button size="sm" icon={<Download className="h-4 w-4" />} onClick={() => startExport(tab === 'social' ? { preset: 'social', filter: filterBody } : { preset: 'filter', filter: filterBody })}>
            Download All{filtersOn || f.q ? ' (filtered)' : ''}
          </Button>}
        </span>
      </div>

      {lib.error ? <ErrorNote error={lib.error} onRetry={() => lib.refetch()} /> : lib.isLoading ? <PageLoading /> : !items.length ? (
        <div className="panel"><EmptyState icon={<Camera className="h-6 w-6" />} title={tab === 'social' ? 'Nothing approved for social media yet' : 'No transformations yet'}
          action={o.can.create && tab === 'library' ? <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit('new')}>New transformation</Button> : undefined}>
          {tab === 'social' ? 'Work shows here once the client’s consent is recorded and verified, and it’s approved for social media.' : 'Add your work with photos, the services and extension details.'}
        </EmptyState></div>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((t) => (
            <div key={t.id} className={cx('panel group relative overflow-hidden !p-0', sel.has(t.id) && 'ring-2 ring-plum')}>
              <button type="button" className="block w-full text-left" onClick={() => (selecting ? toggle(t.id) : setOpen(t.id))}>
                <Cover t={t} className="aspect-[4/5] w-full" />
                <span className="block px-3 py-2.5">
                  <span className="block truncate text-[15px] font-medium text-ink">{t.stylistName ?? 'Stylist unknown'}</span>
                  <span className="mt-0.5 block text-[14px] leading-snug text-ink-soft">{doneOf(t)}</span>
                  <span className="mt-1 block text-[12px] text-stone">{fmtDate(t.serviceDate)}</span>
                  {social && t.readyForSocial && <span className="mt-1.5 flex"><Badge tone="sage">Ready for Social</Badge></span>}
                  {tab === 'social' && t.caption && <span className="mt-1.5 line-clamp-2 block text-[12px] text-ink-soft">{t.caption}</span>}
                </span>
              </button>
              {selecting && <span className={cx('pointer-events-none absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white shadow', sel.has(t.id) ? 'bg-plum text-white' : 'bg-white/70')}>{sel.has(t.id) && <Check className="h-3.5 w-3.5" />}</span>}
            </div>
          ))}
        </div>
      ) : (
        <div className="panel divide-y divide-line !p-0">
          {items.map((t) => (
            <button key={t.id} type="button" className={cx('flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-mist/60', sel.has(t.id) && 'bg-plum-tint')} onClick={() => (selecting ? toggle(t.id) : setOpen(t.id))}>
              {selecting && <input type="checkbox" readOnly checked={sel.has(t.id)} className="h-4 w-4 accent-plum" aria-label="Select" />}
              <Cover t={t} small className="h-14 w-14 shrink-0 rounded-lg" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium text-ink">{t.stylistName ?? 'Stylist unknown'}</span>
                <span className="block truncate text-[14px] text-ink-soft">{doneOf(t)}</span>
              </span>
              <span className="hidden shrink-0 text-[12px] text-stone sm:block">{fmtDate(t.serviceDate)}</span>
              {social && t.readyForSocial && <span className="hidden shrink-0 sm:block"><Badge tone="sage">Ready for Social</Badge></span>}
              <span className="hidden w-16 shrink-0 text-right text-[12px] text-stone sm:block">{t.photos.length} photo{t.photos.length === 1 ? '' : 's'}</span>
            </button>
          ))}
        </div>
      )}
      {lib.hasNextPage && <div className="mt-4 flex justify-center"><Button loading={lib.isFetchingNextPage} onClick={() => lib.fetchNextPage()}>Load more</Button></div>}

      {tab === 'social' && <NeedsAttention f={f} onOpen={setOpen} />}

      {open && <Detail id={open} o={o} onClose={() => setOpen(null)} onEdit={(t) => { setOpen(null); setEdit(t); }} onExport={(body) => startExport(body)} onChanged={refresh} />}
      {edit && <Editor t={edit === 'new' ? null : edit} o={o} onClose={(saved) => { setEdit(null); refresh(); if (saved) setOpen(saved); }} />}
      {confirming && <Editor t={null} o={o} appt={confirming} onClose={() => { setConfirming(null); refresh(); void qc.invalidateQueries({ queryKey: ['tf-confirm'] }); }} />}
      {exportId && <ExportProgress id={exportId} onClose={() => setExportId(null)} />}
      {settings && <LibrarySettings o={o} onClose={() => { setSettings(false); refresh(); }} />}
      {collect && <AddToCollection o={o} ids={[...sel]} onClose={(done) => { setCollect(false); if (done) { setSelecting(false); setSel(new Set()); refresh(); } }} />}
    </div>
  );
}

/** Their finished appointments without a transformation yet: confirm one (photos + notes), or say there are no photos. */
function ToConfirm({ onConfirm, onDetails }: { onConfirm: (a: Appt) => void; onDetails: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: all } = useQuery({ queryKey: ['tf-confirm'], queryFn: () => api.get<{ items: Appt[]; needsDetails: { id: string; date: string; title: string }[] }>('/transformations/to-confirm') });
  const data = all?.items ?? [];
  const needs = all?.needsDetails ?? [];
  if (!data.length && !needs.length) return null;
  const skip = async (a: Appt) => {
    try { await api.post(`/transformations/to-confirm/${a.appointmentId}/skip`); void qc.invalidateQueries({ queryKey: ['tf-confirm'] }); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <>
    {needs.length > 0 && (
      <section className="mb-6">
        <h2 className="h-display mb-2 text-[20px]">Needs your details <span className="font-sans text-[14px] text-stone">({needs.length})</span></h2>
        <p className="mb-2 text-[13px] text-stone">Added for you — say what was done and add your notes.</p>
        <div className="panel divide-y divide-line !p-0">
          {needs.map((n) => (
            <div key={n.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1 text-[14px] text-ink">{fmtDate(n.date)}{n.title && n.title !== 'Transformation' ? ` · ${n.title}` : ''}</span>
              <Button size="sm" variant="primary" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => onDetails(n.id)}>Add details</Button>
            </div>
          ))}
        </div>
      </section>
    )}
    {data.length > 0 && <section className="mb-6">
      <h2 className="h-display mb-2 text-[20px]">To confirm <span className="font-sans text-[14px] text-stone">({data.length})</span></h2>
      <p className="mb-2 text-[13px] text-stone">Your appointments from the last two weeks. Add the photos and a note, or mark ones without photos.</p>
      <div className="panel divide-y divide-line !p-0">
        {data.map((a) => (
          <div key={a.appointmentId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
            <span className="min-w-0 flex-1 text-[14px]"><span className="text-ink">{fmtDate(a.date)}{a.clientName ? ` · ${a.clientName}` : ''}</span><span className="block truncate text-[12px] text-stone">{a.services.join(', ') || 'Appointment'}</span></span>
            <Button size="sm" variant="ghost" onClick={() => skip(a)}>No photos</Button>
            <Button size="sm" variant="primary" icon={<Camera className="h-3.5 w-3.5" />} onClick={() => onConfirm(a)}>Add photos & notes</Button>
          </div>
        ))}
      </div>
    </section>}
    </>
  );
}

/** Ready for Social: what's held back and why (missing photos, details or consent). */
function NeedsAttention({ f, onOpen }: { f: Filter; onOpen: (id: string) => void }) {
  const { data } = useQuery({ queryKey: ['transformations', 'attention', f], queryFn: () => api.get<{ items: TransformationDTO[] }>(`/transformations?${qs({ ...f, consent: '', limit: 60 })}`) });
  const held = (data?.items ?? []).filter((t) => !t.readyForSocial && t.consent.status !== 'do_not_publish' && t.consent.status !== 'internal');
  if (!held.length) return null;
  return (
    <div className="mt-8">
      <h2 className="h-display mb-2 text-[20px]">Not ready yet</h2>
      <div className="panel divide-y divide-line !p-0">
        {held.map((t) => (
          <button key={t.id} type="button" className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-mist/60" onClick={() => onOpen(t.id)}>
            <Cover t={t} className="h-11 w-11 shrink-0 rounded-lg" />
            <span className="min-w-0 flex-1"><span className="block truncate text-[14px] text-ink">{t.title}</span><span className="block truncate text-[12px] text-stone">{t.stylistName} · {fmtDate(t.serviceDate)}</span></span>
            <span className="flex flex-wrap justify-end gap-1">{t.missing.map((m) => <Badge key={m} tone="amber">{m}</Badge>)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------- detail ----------------
function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return <section className="mb-5"><div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-[12px] font-semibold uppercase tracking-wide text-stone">{title}</h3>{aside}</div>{children}</section>;
}
function Rows({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false);
  if (!shown.length) return <p className="text-[13px] text-stone">Nothing added.</p>;
  return <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 text-[14px]">{shown.map(([k, v]) => <div key={k} className="contents"><dt className="text-stone">{k}</dt><dd className="whitespace-pre-wrap text-ink">{v}</dd></div>)}</dl>;
}
const copy = async (text: string, toast: ReturnType<typeof useToast>) => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Couldn’t copy — select the text instead.', 'error'); } };

function Detail({ id, o, onClose, onEdit, onExport, onChanged }: { id: string; o: Options; onClose: () => void; onEdit: (t: TransformationDTO) => void; onExport: (body: object) => void; onChanged: () => void }) {
  const toast = useToast();
  const { data: me } = useMe();
  const { data: t, error, refetch } = useQuery({ queryKey: ['transformation', id], queryFn: () => api.get<{ transformation: TransformationDTO }>(`/transformations/${id}`).then((r) => r.transformation) });
  const [big, setBig] = useState<TransformationPhotoDTO | null>(null);
  const [consent, setConsent] = useState(false);
  useEffect(() => { if (t && !big) setBig(t.photos.find((p) => p.kind === 'after' || p.kind === 'finished') ?? t.photos[0] ?? null); }, [t, big]);
  if (error) return <Modal open onClose={onClose} title="Transformation"><ErrorNote error={error} onRetry={() => refetch()} /></Modal>;
  if (!t) return <Modal open onClose={onClose} title="Transformation"><PageLoading /></Modal>;
  const e = t.extension;
  const socialText = [t.caption, t.hashtags].filter(Boolean).join('\n\n');
  const del = async () => {
    if (!window.confirm(`Delete “${t.title}” and its photos? This can’t be undone.`)) return;
    try { await api.del(`/transformations/${t.id}`); onChanged(); onClose(); } catch (x) { toast((x as Error).message, 'error'); }
  };
  return (
    <Modal open xl onClose={onClose} title={<>{t.title} <span className="text-[14px] text-stone">{t.code}</span></>}
      footer={<>
        {t.canEdit && <Button variant="ghost" className="mr-auto" icon={<Trash2 className="h-4 w-4" />} onClick={del}>Delete</Button>}
        {t.canDownload && <a className={buttonClass('secondary')} href={`/api/transformations/${t.id}/details.csv`}><Download className="h-4 w-4" /><span className="btn-label">Details (CSV)</span></a>}
        {t.canDownload && t.photos.length > 0 && <Button icon={<Download className="h-4 w-4" />} onClick={() => onExport({ preset: 'one', ids: [t.id] })}>Download all photos (ZIP)</Button>}
        {t.canEdit && !t.stylistStaffId && me && <Button icon={<UserCheck className="h-4 w-4" />} onClick={() => api.patch(`/transformations/${t.id}`, { stylistStaffId: me.id }).then(() => { void refetch(); onChanged(); toast('Now in your work'); }).catch((x) => toast((x as Error).message, 'error'))}>This is my work</Button>}
        {t.canEdit && <Button variant="primary" icon={<Pencil className="h-4 w-4" />} onClick={() => onEdit(t)}>Edit</Button>}
      </>}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div>
          {big ? (
            <div className="overflow-hidden rounded-xl border border-line bg-mist">
              {isVideo(big)
                ? (t.canDownload ? <video key={big.id} src={big.originalUrl} poster={big.thumbUrl} controls playsInline preload="metadata" className="max-h-[60vh] w-full bg-black object-contain" />
                  : <div className="flex aspect-video w-full items-center justify-center text-[13px] text-stone"><Play className="mr-1.5 h-4 w-4" />Video — playing it needs download permission</div>)
                : <img src={big.thumbUrl} alt={big.caption ?? kindLabel(big.kind)} className="max-h-[60vh] w-full object-contain" />}
              <div className="flex flex-wrap items-center gap-2 border-t border-line bg-white px-3 py-2 text-[12px] text-stone">
                <Badge>{kindLabel(big.kind)}</Badge><span className="min-w-0 flex-1 truncate">{big.caption}</span>
                <span>Uploaded{big.uploadedBy ? ` by ${big.uploadedBy}` : ''} {new Date(big.uploadedAt).toLocaleDateString()}</span>
                {t.canDownload && <>
                  <a className="text-plum underline" href={big.originalUrl} target="_blank" rel="noreferrer">Open original</a>
                  <a className="text-plum underline" href={`${big.originalUrl}?download`}>Download</a>
                </>}
              </div>
            </div>
          ) : <Cover t={t} className="aspect-[4/5] w-full rounded-xl" />}
          {t.photos.length > 1 && <div className="mt-2 grid grid-cols-5 gap-2">{t.photos.map((p) => (
            <button key={p.id} type="button" onClick={() => setBig(p)} className={cx('relative overflow-hidden rounded-lg border', big?.id === p.id ? 'border-plum ring-1 ring-plum' : 'border-line')}>
              <img src={p.thumbUrl} alt="" loading="lazy" className="aspect-square w-full bg-mist object-cover" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
              {isVideo(p) && <Play className="absolute left-1 top-1 h-3.5 w-3.5 fill-white text-white drop-shadow" />}
              <span className="absolute inset-x-0 bottom-0 bg-black/45 px-1 text-[10px] text-white">{kindLabel(p.kind)}</span>
            </button>))}</div>}
          {t.photos.length > 0 && <p className="mt-2 text-[12px] text-stone">{t.photos.length} photo{t.photos.length === 1 ? '' : 's'} / video{t.photos.length === 1 ? '' : 's'}, originals kept in the CRM{t.canDownload ? ' — full quality when downloaded.' : '.'}</p>}

          {t.instagram.length > 0 && <Section title="On Instagram (external)">
            <div className="space-y-2">{t.instagram.map((i, k) => <InstagramCard key={i.id} i={i} defaultOpen={k === 0 && !t.photos.length} />)}</div>
            <p className="mt-1.5 text-[12px] text-stone">Instagram content stays on Instagram — it isn’t copied into the CRM and may not be downloadable. A public post isn’t consent for other marketing.</p>
          </Section>}
        </div>

        <div>
          <Section title="Service">
            <Rows rows={[
              ['Stylist', t.stylistName ?? 'Unassigned'], ['Date', fmtDate(t.serviceDate)], ['Main service', t.mainService],
              ['Services', t.services.filter((s) => s !== t.mainService).join(', ')], ['Client', t.clientName], ['Tags', t.tags.map((x) => `#${x}`).join(' ')],
              ['Collections', t.collections.map((c) => c.name).join(', ')],
            ]} />
          </Section>
          {e?.hasExtensions && <Section title="Extensions">
            <Rows rows={[['Method', e.method], ['Methods & colours', e.parts?.length ? e.parts.map((x) => [x.method, x.shade, x.length].filter(Boolean).join(' · ')).join('\n') : null], ['Brand / source', e.brand], ['Length', e.length], ['Shade', e.shade], ['Rows / packs', e.quantity], ['Work', e.workType],
              ['Blending / cutting', e.blending ? 'Yes' : null], ['Customization', e.customization], ['Maintenance', e.maintenanceNotes], ['Next appointment', e.nextAppointment]]} />
          </Section>}
          <Section title="Details">
            <Rows rows={[['Starting condition', t.details.startingCondition], ['Desired result', t.details.desiredResult], ['Techniques', t.details.techniques], ['Products', t.details.products],
              ['Length & texture', t.details.lengthTexture], ['Styling & finish', t.details.styling], ['Aftercare', t.details.aftercare]]} />
          </Section>
          {t.canSeeTechnical && (t.technicalNotes || t.internalNotes) && <Section title="Technical & internal (not exported to social)">
            <div className="rounded-lg border border-amber/30 bg-amber/5 p-3"><Rows rows={[['Formula / technical', t.technicalNotes], ['Internal notes', t.internalNotes]]} /></div>
          </Section>}
          {(o.can.manage || o.can.consent) && <Section title="For social media" aside={socialText ? <Button size="sm" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy(socialText, toast)}>Copy caption</Button> : undefined}>
            {t.caption ? <p className="whitespace-pre-wrap text-[14px] text-ink">{t.caption}</p> : <p className="text-[13px] text-stone">No caption yet.</p>}
            {t.hashtags && <p className="mt-1 text-[13px] text-plum">{t.hashtags}</p>}
            <Button size="sm" variant="ghost" className="mt-1 !px-0" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy([t.mainService, ...t.services.filter((s) => s !== t.mainService), e?.hasExtensions ? `${e.method ?? 'Extensions'}${e.length ? ` · ${e.length}` : ''}${e.shade ? ` · ${e.shade}` : ''}` : null].filter(Boolean).join(' · '), toast)}>Copy service info</Button>
          </Section>}
          {(o.can.manage || o.can.consent) && <Section title="Consent & publishing" aside={<Button size="sm" onClick={() => setConsent(true)}>Update</Button>}>
            <div className="mb-2 flex flex-wrap gap-1.5"><ConsentBadge t={t} />{t.consent.verifiedAt ? <Badge tone="sage">Verified by {t.consent.verifiedBy}</Badge> : <Badge>Not verified</Badge>}</div>
            <Rows rows={[['Client consent', { unknown: 'Not asked yet', requested: 'Requested', given: 'Given', declined: 'Declined' }[t.consent.clientConsent]],
              ['Social media', t.consent.socialPermission ? 'Allowed' : 'Not allowed'], ['Marketing / ads', t.consent.marketingPermission ? 'Allowed' : 'Not allowed'],
              ['Scope', t.consent.scope], ['Consent date', t.consent.consentDate && fmtDate(t.consent.consentDate)], ['Identifiable', t.consent.identifiable == null ? null : t.consent.identifiable ? 'Yes' : 'No (face not shown)'],
              ['Restrictions', t.consent.restrictions], ['Expires', t.consent.expiresOn && fmtDate(t.consent.expiresOn)]]} />
            {t.missing.length > 0 && <p className="mt-2 flex flex-wrap gap-1 text-[12px] text-stone">Still needed: {t.missing.map((m) => <Badge key={m} tone="amber">{m}</Badge>)}</p>}
          </Section>}
        </div>
      </div>
      {consent && <ConsentEditor t={t} o={o} onClose={() => { setConsent(false); void refetch(); onChanged(); }} />}
    </Modal>
  );
}

function InstagramCard({ i, actions, defaultOpen = false }: { i: TransformationDTO['instagram'][number]; actions?: ReactNode; defaultOpen?: boolean }) {
  const [broken, setBroken] = useState(false);
  const [show, setShow] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-line">
    <div className="flex flex-wrap items-center gap-3 p-2.5">
      {i.thumbnailUrl && !broken ? <img src={i.thumbnailUrl} alt="" className="h-14 w-14 shrink-0 rounded object-cover" onError={() => setBroken(true)} referrerPolicy="no-referrer" />
        : <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-mist"><Instagram className="h-5 w-5 text-stone" /></span>}
      <span className="min-w-0 flex-1 text-[13px]">
        <span className="flex items-center gap-1.5"><Badge>{i.postType === 'reel' ? 'Reel' : i.postType === 'post' ? 'Post' : 'Instagram'}</Badge>{i.isPrimary && <Badge tone="plum">Primary</Badge>}
          {i.previewStatus === 'unavailable' && <Badge tone="amber">Preview unavailable</Badge>}</span>
        <span className="mt-0.5 block truncate text-ink">{i.title || i.author || i.url.replace('https://www.', '')}</span>
        <span className="block truncate text-[11px] text-stone">Added{i.addedBy ? ` by ${i.addedBy}` : ''} {new Date(i.addedAt).toLocaleDateString()}</span>
      </span>
      {actions}
      <Button size="sm" variant={show ? 'primary' : 'secondary'} onClick={() => setShow(!show)}>{show ? 'Hide post' : 'Show post'}</Button>
      <a className={buttonClass('secondary', 'sm')} href={i.url} target="_blank" rel="noreferrer noopener"><ExternalLink className="h-3.5 w-3.5" /><span className="btn-label">Open on Instagram</span></a>
    </div>
    {/* Instagram's own embed of the post (photos, carousels and Reels, as Instagram shows them) — nothing is copied into the
        CRM. Private or deleted posts show Instagram's own message instead. */}
    {show && (
      <div className="flex justify-center border-t border-line bg-mist/40 p-2">
        <iframe title="Instagram post" src={`${i.url.replace(/\/?$/, '/')}embed/captioned/`} loading="lazy" className="h-[620px] w-full max-w-[420px] rounded border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="strict-origin-when-cross-origin" />
      </div>
    )}
    </div>
  );
}

function ConsentEditor({ t, o, onClose }: { t: TransformationDTO; o: Options; onClose: () => void }) {
  const toast = useToast();
  const c = t.consent;
  const [d, setD] = useState({ ...c, verified: !!c.verifiedAt });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/transformations/${t.id}/consent`, {
        status: d.status, clientConsent: d.clientConsent, socialPermission: d.socialPermission, marketingPermission: d.marketingPermission, scope: d.scope || null,
        consentDate: d.consentDate || null, identifiable: d.identifiable, restrictions: d.restrictions || null, expiresOn: d.expiresOn || null,
        ...(o.can.consent && d.verified !== !!c.verifiedAt ? { verified: d.verified } : {}),
      });
      onClose();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const statuses = CONSENT_STATUSES.filter((s) => o.can.consent || s.value !== 'approved_social' || c.status === 'approved_social');
  return (
    <Modal open onClose={onClose} title="Consent & publishing" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="space-y-3 text-[14px]">
        <Field label="Client photo consent">
          <select className="field" value={d.clientConsent} onChange={(e) => setD({ ...d, clientConsent: e.target.value as typeof d.clientConsent })}>
            <option value="unknown">Not asked yet</option><option value="requested">Requested</option><option value="given">Given</option><option value="declined">Declined</option>
          </select>
        </Field>
        <Toggle checked={d.socialPermission} onChange={(v) => setD({ ...d, socialPermission: v })} label="May be published on the salon’s social media" />
        <Toggle checked={d.marketingPermission} onChange={(v) => setD({ ...d, marketingPermission: v })} label="May be used in marketing or advertising" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Consent date"><input type="date" className="field" value={d.consentDate ?? ''} onChange={(e) => setD({ ...d, consentDate: e.target.value || null })} /></Field>
          <Field label="Expires (optional)"><input type="date" className="field" value={d.expiresOn ?? ''} onChange={(e) => setD({ ...d, expiresOn: e.target.value || null })} /></Field>
        </div>
        <Field label="Can the client be identified?">
          <select className="field" value={d.identifiable == null ? '' : d.identifiable ? 'yes' : 'no'} onChange={(e) => setD({ ...d, identifiable: e.target.value === '' ? null : e.target.value === 'yes' })}>
            <option value="">Not recorded</option><option value="yes">Yes — face or identifying features shown</option><option value="no">No — hair only</option>
          </select>
        </Field>
        <Field label="Scope" hint="e.g. Instagram and website only; signed form on file"><input className="field" value={d.scope ?? ''} onChange={(e) => setD({ ...d, scope: e.target.value })} /></Field>
        <Field label="Restrictions"><input className="field" value={d.restrictions ?? ''} onChange={(e) => setD({ ...d, restrictions: e.target.value })} placeholder="e.g. no face, don't tag the client" /></Field>
        <Field label="Publication status" hint={!o.can.consent ? 'Approving for social media is done by someone allowed to verify consent.' : 'Approved for Social Media needs the client’s consent given, social media allowed and verified.'}>
          <select className="field" value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as typeof d.status })}>{statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
        </Field>
        {o.can.consent && <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" className="h-4 w-4 accent-plum" checked={d.verified} onChange={(e) => setD({ ...d, verified: e.target.checked })} />I’ve verified the client’s consent for these terms</label>}
      </div>
    </Modal>
  );
}

// ---------------- editor ----------------
interface Queued { key: string; file: File; preview: string; kind: TransformationPhotoKind; caption: string; progress: number; status: 'waiting' | 'uploading' | 'done' | 'failed' | 'duplicate'; error?: string }

/** Upload one file with progress (fetch can't report upload progress). */
function uploadWithProgress(url: string, file: Blob, onProgress: (p: number) => void, method = 'POST') {
  return new Promise<any>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, `/api${url}`);
    x.withCredentials = true;
    x.setRequestHeader('X-Requested-With', 'addendum-crm');
    x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let data: any = {};
      try { data = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status >= 200 && x.status < 300) resolve(data);
      else reject(new Error(data?.error?.message ?? (x.status === 413 ? 'That file is too large (photos 25 MB, videos 500 MB).' : 'The upload didn’t go through.')));
    };
    x.onerror = () => reject(new Error('Couldn’t reach the server. Check the connection and retry.'));
    x.send(file);
  });
}
/** A ~800px JPEG for browsing, made in the browser; the original is uploaded untouched. Null when the browser can't read it (e.g. HEIC outside Safari). */
async function makeThumb(file: File): Promise<Blob | null> {
  if (file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(file.name)) return videoPoster(file);
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return await new Promise((r) => c.toBlob((b) => r(b), 'image/jpeg', 0.82));
  } catch { return null; }
}
/** A still from about a second into a video, for the gallery (the video itself is uploaded untouched). */
function videoPoster(file: File): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    const done = (b: Blob | null) => { URL.revokeObjectURL(url); resolve(b); };
    const timer = setTimeout(() => done(null), 15_000);
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); };
    v.onseeked = () => {
      clearTimeout(timer);
      try {
        const scale = Math.min(1, 800 / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
        c.toBlob((b) => done(b), 'image/jpeg', 0.82);
      } catch { done(null); }
    };
    v.onerror = () => { clearTimeout(timer); done(null); };
    v.src = url;
  });
}
const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif,.heic,.heif,video/mp4,video/quicktime,video/webm,.mov,.mp4,.m4v';
const guessKind = (name: string, i: number, existing: number): TransformationPhotoKind => /before/i.test(name) ? 'before' : /detail/i.test(name) ? 'detail' : existing + i === 0 ? 'before' : 'after';

export interface Appt { appointmentId: string; date: string; clientId: string | null; clientName: string | null; services: string[] }

function Editor({ t, o, appt, onClose }: { t: TransformationDTO | null; o: Options; appt?: Appt | null; onClose: (savedId?: string) => void }) {
  const toast = useToast();
  const [cur, setCur] = useState<TransformationDTO | null>(t);
  const [d, setD] = useState(() => ({
    title: t?.title ?? '', stylistStaffId: t?.stylistStaffId ?? '', serviceDate: t?.serviceDate ?? appt?.date ?? new Date().toISOString().slice(0, 10),
    clientId: t?.clientId ?? appt?.clientId ?? null as string | null, clientName: t?.clientName ?? appt?.clientName ?? '', mainService: t?.mainService ?? appt?.services[0] ?? '',
    services: t?.services.filter((s) => s !== t.mainService) ?? appt?.services.slice(1) ?? [] as string[],
    details: { ...(t?.details ?? {}) } as Record<string, string | null | undefined>, technicalNotes: t?.technicalNotes ?? '', internalNotes: t?.internalNotes ?? '',
    caption: t?.caption ?? '', hashtags: t?.hashtags ?? '', tags: (t?.tags ?? []).join(', '), consentStatus: 'pending', instagramUrl: '',
    hasExtensions: !!t?.extension?.hasExtensions, ext: { method: '', parts: [], brand: '', length: '', shade: '', quantity: '', workType: '', blending: false, customization: '', maintenanceNotes: '', nextAppointment: '', ...Object.fromEntries(Object.entries(t?.extension ?? {}).map(([k, v]) => [k, v ?? ''])) } as Record<string, any>,
  }));
  const [queue, setQueue] = useState<Queued[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [igUrl, setIgUrl] = useState('');
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => () => queue.forEach((q) => URL.revokeObjectURL(q.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps
  const allServices = [d.mainService, ...d.services];
  const extRelevant = allServices.some(isExt) || d.hasExtensions;
  const isHybrid = /hybrid/i.test(d.ext.method ?? '');
  const parts: { method: string; shade: string | null; length: string | null }[] = Array.isArray(d.ext.parts) ? d.ext.parts : [];
  const setParts = (p: typeof parts) => setD({ ...d, ext: { ...d.ext, parts: p } });
  const canTech = !cur || cur.canSeeTechnical;
  // Instagram links, captions, hashtags and tags are for social posts: administrators only (the server checks too).
  const social = o.can.manage || o.can.consent;
  const photos = cur?.photos ?? [];

  const add = (files: FileList | File[] | null) => {
    const list = [...(files ?? [])].filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/') || /\.(heic|heif|mov|mp4|m4v)$/i.test(f.name));
    if (!list.length) return;
    // The same file picked twice is queued once (the server also keeps one copy).
    const have = new Set(queue.map((q) => `${q.file.name}|${q.file.size}|${q.file.lastModified}`));
    const fresh = list.filter((f) => !have.has(`${f.name}|${f.size}|${f.lastModified}`));
    setQueue((q) => [...q, ...fresh.map((f, i) => ({ key: `${f.name}-${f.size}-${f.lastModified}-${Math.random()}`, file: f, preview: URL.createObjectURL(f), kind: guessKind(f.name, q.length + i, photos.length), caption: '', progress: 0, status: 'waiting' as const }))]);
  };
  const patchQ = (key: string, p: Partial<Queued>) => setQueue((q) => q.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const uploadOne = async (id: string, q: Queued) => {
    patchQ(q.key, { status: 'uploading', progress: 0, error: undefined });
    try {
      const r = await uploadWithProgress(`/transformations/${id}/photos?${qs({ kind: q.kind, caption: q.caption, name: q.file.name })}`, q.file, (p) => patchQ(q.key, { progress: p }));
      if (!r.duplicate) {
        const th = await makeThumb(q.file);
        if (th) await uploadWithProgress(`/transformations/photos/${r.photoId}/thumb`, th, () => {}, 'PUT').catch(() => null);
      }
      patchQ(q.key, { status: r.duplicate ? 'duplicate' : 'done', progress: 1 });
      return true;
    } catch (e) {
      patchQ(q.key, { status: 'failed', error: (e as Error).message });
      return false;
    }
  };

  const body = () => ({
    title: d.title, serviceDate: d.serviceDate, mainService: d.mainService, services: d.services, clientId: d.clientId,
    ...(o.can.manage && d.stylistStaffId && d.stylistStaffId !== cur?.stylistStaffId ? { stylistStaffId: d.stylistStaffId } : {}),
    details: Object.fromEntries(Object.entries(d.details).map(([k, v]) => [k, v || null])),
    ...(canTech ? { technicalNotes: d.technicalNotes || null, internalNotes: d.internalNotes || null } : {}),
    ...(social ? { caption: d.caption || null, hashtags: d.hashtags || null, tags: d.tags.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
    extension: extRelevant ? { hasExtensions: true, ...Object.fromEntries(Object.entries(d.ext).map(([k, v]) => [k, k === 'blending' ? !!v : k === 'parts' ? (isHybrid ? v : []) : v || null])) } : null,
  });

  const save = async () => {
    // Administrators can leave it for the stylist (e.g. adding an Instagram post); stylists say what was done.
    if (!d.mainService && !o.can.manage) return toast('Choose the service.', 'error');
    const pending = queue.filter((q) => q.status === 'waiting' || q.status === 'failed');
    if (!photos.length && !pending.length && !(cur?.instagram.length) && !d.instagramUrl.trim()) return toast('Add at least one photo or an Instagram link.', 'error');
    setBusy(true);
    try {
      let rec = cur;
      if (!rec) {
        rec = (await api.post<{ transformation: TransformationDTO }>('/transformations', { ...body(), consentStatus: d.consentStatus, instagramUrl: social ? d.instagramUrl.trim() || null : null, appointmentId: appt?.appointmentId ?? null })).transformation;
        setCur(rec);
      } else {
        rec = (await api.patch<{ transformation: TransformationDTO }>(`/transformations/${rec.id}`, body())).transformation;
        setCur(rec);
      }
      let ok = true;
      for (const q of pending) ok = (await uploadOne(rec.id, q)) && ok;
      if (!ok) { toast('Saved. Some photos didn’t upload — retry them below.', 'error'); return; }
      onClose(rec.id);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  const photoAction = async (fn: () => Promise<{ transformation: TransformationDTO }>) => { try { setCur((await fn()).transformation); } catch (e) { toast((e as Error).message, 'error'); } };
  const move = (i: number, dir: -1 | 1) => {
    const ids = photos.map((p) => p.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void photoAction(() => api.post(`/transformations/${cur!.id}/photos/order`, { ids }));
  };
  const replace = (p: TransformationPhotoDTO) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = ACCEPT;
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const r = await uploadWithProgress(`/transformations/photos/${p.id}/replace?${qs({ name: f.name })}`, f, () => {});
        const th = await makeThumb(f);
        if (th) await uploadWithProgress(`/transformations/photos/${p.id}/thumb`, th, () => {}, 'PUT').catch(() => null);
        setCur((await api.get<{ transformation: TransformationDTO }>(`/transformations/${r.transformation.id}`)).transformation);
      } catch (e) { toast((e as Error).message, 'error'); }
    };
    inp.click();
  };
  const addIg = async () => {
    if (!cur || !igUrl.trim()) return;
    await photoAction(() => api.post(`/transformations/${cur.id}/instagram`, { url: igUrl.trim(), isPrimary: !photos.length && !cur.instagram.length }));
    setIgUrl('');
  };
  const det = (k: string) => ({ value: d.details[k] ?? '', onChange: (e: { target: { value: string } }) => setD({ ...d, details: { ...d.details, [k]: e.target.value } }) });
  const ex = (k: string) => ({ value: d.ext[k] ?? '', onChange: (e: { target: { value: string } }) => setD({ ...d, ext: { ...d.ext, [k]: e.target.value } }) });
  const serviceOptions = [...new Set([...o.services, ...allServices.filter(Boolean)])];

  // The few things a stylist fills in, then everything else folded away under "More details".
  const photoList = (photos.length > 0 || queue.length > 0) && (
    <ul className="space-y-2">
      {photos.map((p, i) => (
        <li key={p.id} className="flex items-center gap-2 rounded-lg border border-line p-2">
          <img src={p.thumbUrl} alt="" className="h-14 w-14 shrink-0 rounded object-cover" />
          <div className="grid min-w-0 flex-1 gap-1">
            <select className="field h-9 text-[13px]" value={p.kind} onChange={(e) => photoAction(() => api.patch(`/transformations/photos/${p.id}`, { kind: e.target.value }))}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select>
            <input className="field h-9 text-[13px]" defaultValue={p.caption ?? ''} placeholder="Photo caption (optional)" onBlur={(e) => e.target.value !== (p.caption ?? '') && photoAction(() => api.patch(`/transformations/photos/${p.id}`, { caption: e.target.value || null }))} />
          </div>
          <div className="flex shrink-0 flex-col">
            <button type="button" className="rounded p-2 text-stone hover:bg-mist sm:p-1 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp className="h-4 w-4" /></button>
            <button type="button" className="rounded p-2 text-stone hover:bg-mist sm:p-1 disabled:opacity-30" disabled={i === photos.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown className="h-4 w-4" /></button>
          </div>
          <div className="flex shrink-0 flex-col">
            <button type="button" className="rounded p-2 text-stone hover:bg-mist sm:p-1" onClick={() => replace(p)} aria-label="Replace" title="Replace"><RefreshCw className="h-4 w-4" /></button>
            <button type="button" className="rounded p-2 text-stone hover:bg-mist sm:p-1 hover:text-rose" onClick={() => window.confirm('Remove this photo?') && photoAction(() => api.del(`/transformations/photos/${p.id}`))} aria-label="Remove" title="Remove"><Trash2 className="h-4 w-4" /></button>
          </div>
        </li>
      ))}
      {queue.filter((q) => q.status !== 'done' && q.status !== 'duplicate').map((q) => (
        <li key={q.key} className={cx('flex items-center gap-2 rounded-lg border p-2', q.status === 'failed' ? 'border-rose/50' : 'border-dashed border-line')}>
          {q.file.type.startsWith('video/') ? <video src={q.preview} muted playsInline preload="metadata" className="h-14 w-14 shrink-0 rounded bg-mist object-cover" />
            : <img src={q.preview} alt="" className="h-14 w-14 shrink-0 rounded bg-mist object-cover" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />}
          <div className="grid min-w-0 flex-1 gap-1">
            <select className="field h-9 text-[13px]" value={q.kind} disabled={q.status === 'uploading'} onChange={(e) => patchQ(q.key, { kind: e.target.value as TransformationPhotoKind })}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select>
            {q.status === 'uploading' && <span className="h-1.5 overflow-hidden rounded-full bg-mist"><span className="block h-full bg-plum transition-all" style={{ width: `${Math.round(q.progress * 100)}%` }} /></span>}
            {q.status === 'failed' && <span className="text-[12px] text-rose">{q.error}</span>}
            {q.status === 'waiting' && <span className="truncate text-[11px] text-stone">{q.file.name} · uploads when you save</span>}
          </div>
          <div className="flex shrink-0 flex-col items-center gap-1">
            {q.status === 'failed' && cur && <Button size="sm" onClick={() => uploadOne(cur.id, q).then(async (ok) => { if (ok) setCur((await api.get<{ transformation: TransformationDTO }>(`/transformations/${cur.id}`)).transformation); })}>Retry</Button>}
            {q.status !== 'uploading' && <button type="button" className="rounded p-2 text-stone hover:bg-mist sm:p-1" onClick={() => { URL.revokeObjectURL(q.preview); setQueue((x) => x.filter((y) => y.key !== q.key)); }} aria-label="Remove"><X className="h-4 w-4" /></button>}
            {q.status === 'uploading' && <Spinner />}
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <Modal open wide onClose={() => onClose(cur?.id)} title={cur ? `Edit ${cur.code}` : appt ? 'Confirm transformation' : 'New transformation'}
      footer={<><Button variant="ghost" onClick={() => onClose(cur?.id)}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>{cur ? 'Save' : appt ? 'Confirm' : 'Save'}</Button></>}>
      <div className="space-y-4">
        {/* Administrators say whose work it is first (and can fix it later); stylists' own work is theirs. */}
        {o.can.manage && !appt && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Stylist">
              <select className="field" value={d.stylistStaffId || (cur?.stylistStaffId ?? '')} onChange={(e) => setD({ ...d, stylistStaffId: e.target.value })}>
                {!cur && <option value="">Me</option>}
                {cur && !cur.stylistStaffId && <option value="">Unknown — choose…</option>}
                {o.stylists.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </Field>
            <Field label="Date"><input type="date" className="field" value={d.serviceDate} onChange={(e) => setD({ ...d, serviceDate: e.target.value })} /></Field>
          </div>
        )}
        {appt && <p className="rounded-lg bg-mist px-3 py-2 text-[14px] text-ink-soft">{fmtDate(appt.date)}{appt.clientName ? ` · ${appt.clientName}` : ''} · {appt.services.join(', ') || 'Appointment'}</p>}

        <Field label="Photos & videos">
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
            className={cx('flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-5 text-center text-[13px] text-stone', drag ? 'border-plum bg-plum-tint' : 'border-line')}>
            <Upload className="h-5 w-5" />
            <span><span className="hidden sm:inline">Drag photos or videos here, or </span><button type="button" className="text-plum underline" onClick={() => file.current?.click()}>choose photos & videos</button></span>
            <span className="text-[12px]">Pick as many as you like for this transformation — before, after and detail shots.</span>
            <input ref={file} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
          </div>
        </Field>
        {photoList}

        <Field label="Service"><select className="field" value={d.mainService} onChange={(e) => setD({ ...d, mainService: e.target.value, services: d.services.filter((s) => s !== e.target.value) })}><option value="">Choose…</option>{serviceOptions.map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Also performed" hint="Tap any other services done in this visit.">
          <div className="flex flex-wrap gap-1.5">{serviceOptions.filter((s) => s !== d.mainService).map((s) => {
            const on = d.services.includes(s);
            return <button key={s} type="button" onClick={() => setD({ ...d, services: on ? d.services.filter((x) => x !== s) : [...d.services, s] })} className={chipClass(on)}>{on && <Check className="h-3 w-3" />}{s}</button>;
          })}</div>
        </Field>
        {extRelevant && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Extension method"><select className="field" {...ex('method')}><option value="">—</option>{[...new Set([...EXTENSION_METHODS, ...o.methods])].map((m) => <option key={m}>{m}</option>)}</select></Field>
            <Field label="Length"><input className="field" {...ex('length')} placeholder='e.g. 22"' /></Field>
            <Field label="Shade"><input className="field" {...ex('shade')} /></Field>
          </div>
        )}
        {extRelevant && isHybrid && (
          <Field label="Hybrid: methods and colours used" hint="One row for each method and colour, e.g. Weft · #60 Platinum · 22″.">
            <div className="space-y-2">
              {parts.map((p, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                  <select className="field sm:w-40" aria-label="Method" value={p.method} onChange={(e) => setParts(parts.map((x, k) => (k === i ? { ...x, method: e.target.value } : x)))}>
                    <option value="">Method…</option>{[...new Set([...EXTENSION_METHODS.filter((m) => m !== 'Hybrid'), ...o.methods.filter((m) => !/hybrid/i.test(m))])].map((m) => <option key={m}>{m}</option>)}
                  </select>
                  <input className="field min-w-0 flex-1" aria-label="Colour" placeholder="Colour / shade" value={p.shade ?? ''} onChange={(e) => setParts(parts.map((x, k) => (k === i ? { ...x, shade: e.target.value } : x)))} />
                  <input className="field sm:w-24" aria-label="Length" placeholder='Length' value={p.length ?? ''} onChange={(e) => setParts(parts.map((x, k) => (k === i ? { ...x, length: e.target.value } : x)))} />
                  <button type="button" className="rounded p-1.5 text-stone hover:bg-mist hover:text-rose" aria-label="Remove" onClick={() => setParts(parts.filter((_, k) => k !== i))}><X className="h-4 w-4" /></button>
                </div>
              ))}
              <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setParts([...parts, { method: '', shade: null, length: null }])}>{parts.length ? 'Add another' : 'Add method & colour'}</Button>
            </div>
          </Field>
        )}
        {canTech && <Field label="Notes" hint="Formula, products, anything to remember. Private — never in captions or exports.">
          <textarea className="field min-h-[96px]" value={d.technicalNotes} onChange={(e) => setD({ ...d, technicalNotes: e.target.value })} />
        </Field>}

        <details className="rounded-xl border border-line p-3">
          <summary className="cursor-pointer text-[13px] font-medium text-ink">More details (optional)</summary>
          <div className="mt-3 space-y-4">
            <Field label="Title" hint={`Blank = “${d.mainService || 'the service'}”`}><input className="field" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="e.g. Copper balayage with face-framing" /></Field>
            {!appt && !o.can.manage && <Field label="Service date"><input type="date" className="field" value={d.serviceDate} onChange={(e) => setD({ ...d, serviceDate: e.target.value })} /></Field>}
            {!appt && <ClientPicker value={d.clientId ? { id: d.clientId, name: d.clientName } : null} onChange={(c) => setD({ ...d, clientId: c?.id ?? null, clientName: c?.name ?? '' })} />}
            {!allServices.some(isExt) && <Toggle checked={d.hasExtensions} onChange={(v) => setD({ ...d, hasExtensions: v })} label="Client has extensions" />}
            {extRelevant && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Extension work"><select className="field" {...ex('workType')}><option value="">—</option>{EXTENSION_WORK.map((m) => <option key={m}>{m}</option>)}</select></Field>
                <Field label="Brand or hair source"><input className="field" {...ex('brand')} /></Field>
                <Field label="Rows, packs or pieces"><input className="field" {...ex('quantity')} placeholder="e.g. 2 rows" /></Field>
                <Field label="Next appointment"><input className="field" {...ex('nextAppointment')} placeholder="e.g. Move-up in 6–8 weeks" /></Field>
                <label className="flex items-center gap-2 text-[14px] sm:col-span-2"><input type="checkbox" className="h-4 w-4 accent-plum" checked={!!d.ext.blending} onChange={(e) => setD({ ...d, ext: { ...d.ext, blending: e.target.checked } })} />Includes blending or extension-specific cutting</label>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Techniques used"><input className="field" {...det('techniques')} /></Field>
              <Field label="Products used"><input className="field" {...det('products')} /></Field>
            </div>
            {canTech && <Field label="Internal notes"><textarea className="field min-h-[56px]" value={d.internalNotes} onChange={(e) => setD({ ...d, internalNotes: e.target.value })} /></Field>}
            {social && <>
            <Field label="Instagram post or Reel" hint="Link only — nothing is copied from Instagram.">
              {cur ? (
                <div className="space-y-2">
                  {cur.instagram.map((i) => <InstagramCard key={i.id} i={i} actions={<span className="flex shrink-0 flex-col">
                    {!i.isPrimary && <button type="button" className="rounded p-2 text-stone hover:bg-mist sm:p-1" title="Use as the main reference" onClick={() => photoAction(() => api.patch(`/transformations/instagram/${i.id}`, { isPrimary: true }))}><Star className="h-4 w-4" /></button>}
                    {i.previewStatus !== 'ok' && <button type="button" className="rounded p-2 text-stone hover:bg-mist sm:p-1" title="Try the preview again" onClick={() => photoAction(() => api.post(`/transformations/instagram/${i.id}/refresh`))}><RefreshCw className="h-4 w-4" /></button>}
                    <button type="button" className="rounded p-2 text-stone hover:bg-mist sm:p-1 hover:text-rose" title="Remove link" onClick={() => photoAction(() => api.del(`/transformations/instagram/${i.id}`))}><Trash2 className="h-4 w-4" /></button>
                  </span>} />)}
                  <div className="flex gap-2"><input className="field" value={igUrl} onChange={(e) => setIgUrl(e.target.value)} placeholder="https://www.instagram.com/p/…" /><Button onClick={addIg} disabled={!igUrl.trim()}>Add</Button></div>
                </div>
              ) : <input className="field" value={d.instagramUrl} onChange={(e) => setD({ ...d, instagramUrl: e.target.value })} placeholder="https://www.instagram.com/reel/…" />}
            </Field>
            <Field label="Suggested caption"><textarea className="field min-h-[72px]" value={d.caption} onChange={(e) => setD({ ...d, caption: e.target.value })} maxLength={2200} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Hashtags"><input className="field" value={d.hashtags} onChange={(e) => setD({ ...d, hashtags: e.target.value })} placeholder="#addendumsalon" /></Field>
              <Field label="Tags (searchable)">
                <input className="field" list="tf-tags" value={d.tags} onChange={(e) => setD({ ...d, tags: e.target.value })} placeholder="copper, face-framing" />
                <datalist id="tf-tags">{o.tags.map((x) => <option key={x} value={x} />)}</datalist>
              </Field>
            </div>
            </>}
            {!cur && social && (
              <Field label="Publication & usage" hint="Stays unpublished until the client’s consent is recorded and approved.">
                <select className="field" value={d.consentStatus} onChange={(e) => setD({ ...d, consentStatus: e.target.value })}>
                  <option value="pending">Pending Consent</option><option value="internal">Internal Use Only</option><option value="do_not_publish">Do Not Publish</option>
                </select>
              </Field>
            )}
          </div>
        </details>
      </div>
    </Modal>
  );
}

function ClientPicker({ value, onChange }: { value: { id: string; name: string } | null; onChange: (c: { id: string; name: string } | null) => void }) {
  const [q, setQ] = useState('');
  const { data } = useQuery({ queryKey: ['tf-client-search', q], enabled: q.trim().length >= 2, queryFn: () => api.get<{ clients: { id: string; name: string }[] }>(`/search?q=${encodeURIComponent(q.trim())}`).then((r) => r.clients), retry: false });
  if (value) return <Field label="Client record (optional)"><div className="flex items-center gap-2"><span className="field flex h-10 items-center">{value.name || 'Linked client'}</span><Button size="sm" variant="ghost" onClick={() => onChange(null)}>Unlink</Button></div></Field>;
  return (
    <Field label="Client record (optional)" hint="Kept private: client names never go into captions or exports.">
      <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your clients" />
      {!!data?.length && <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-line bg-white">{data.map((c) => <li key={c.id}><button type="button" className="w-full px-3 py-1.5 text-left text-[14px] hover:bg-mist" onClick={() => { onChange(c); setQ(''); }}>{c.name}</button></li>)}</ul>}
    </Field>
  );
}

// ---------------- downloads ----------------
interface ExportStatus { id: string; status: 'queued' | 'running' | 'done' | 'failed' | 'expired'; total: number; done: number; failed: { transformation: string; file: string; reason: string }[]; size: number | null; error: string | null; downloadUrl: string | null; expiresAt: string | null }
function ExportProgress({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ['tf-export', id], queryFn: () => api.get<ExportStatus>(`/transformations/exports/${id}`),
    refetchInterval: (q) => (q.state.data && ['done', 'failed', 'expired'].includes(q.state.data.status) ? false : 1000),
  });
  const pct = data?.total ? Math.round((data.done / data.total) * 100) : data?.status === 'done' ? 100 : 0;
  const finished = data?.status === 'done';
  return (
    <Modal open onClose={onClose} title="Preparing your download" footer={<>
      <Button variant="ghost" onClick={onClose}>{finished ? 'Close' : 'Keep working'}</Button>
      {finished && data?.downloadUrl && <a className={buttonClass('primary')} href={data.downloadUrl}><Download className="h-4 w-4" /><span className="btn-label">Download ZIP{data.size ? ` (${(data.size / 1024 / 1024).toFixed(1)} MB)` : ''}</span></a>}
    </>}>
      {!data ? <PageLoading /> : (
        <div className="space-y-3 text-[14px]">
          {data.status === 'failed' ? <p className="text-rose">{data.error ?? 'The download couldn’t be prepared.'}</p> : <>
            <div className="h-2 overflow-hidden rounded-full bg-mist"><div className="h-full bg-plum transition-all" style={{ width: `${pct}%` }} /></div>
            <p className="text-stone">{finished ? `Ready — ${data.done - data.failed.filter((f) => f.file !== '(all)').length} photo${data.total === 1 ? '' : 's'} plus details and a manifest. The link works for ${data.expiresAt ? `you until ${new Date(data.expiresAt).toLocaleString()}` : '24 hours'}.` : `${data.done} of ${data.total} photos…`}</p>
          </>}
          {data.failed.length > 0 && (
            <div className="rounded-lg border border-amber/30 bg-amber/5 p-3">
              <p className="mb-1 font-medium text-ink">Not included ({data.failed.length})</p>
              <ul className="max-h-40 space-y-0.5 overflow-y-auto text-[13px] text-ink-soft">{data.failed.map((f, i) => <li key={i}>{f.transformation}{f.file !== '(all)' ? ` · ${f.file}` : ''} — {f.reason}</li>)}</ul>
            </div>
          )}
          <p className="text-[12px] text-stone">Instagram posts are listed as links in the manifest; their media isn’t included.</p>
        </div>
      )}
    </Modal>
  );
}

// ---------------- library settings ----------------
function LibrarySettings({ o, onClose }: { o: Options; onClose: () => void }) {
  const toast = useToast();
  const [services, setServices] = useState(o.services.join('\n'));
  const [cols, setCols] = useState(o.collections);
  const [name, setName] = useState('');
  const save = async () => {
    try { await api.put('/transformations/options/services', { services: services.split('\n') }); onClose(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const addCol = async () => { try { setCols((await api.post<{ collections: Options['collections'] }>('/transformations/collections', { name })).collections); setName(''); } catch (e) { toast((e as Error).message, 'error'); } };
  const delCol = async (id: string) => { if (!window.confirm('Delete this collection? The transformations stay in the library.')) return; setCols((await api.del<{ collections: Options['collections'] }>(`/transformations/collections/${id}`)).collections); };
  const fromCatalog = o.catalog.filter((c) => !services.split('\n').includes(c));
  return (
    <Modal open wide onClose={onClose} title="Services & collections" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save services</Button></>}>
      <div className="grid gap-6 sm:grid-cols-2">
        <Field label="Services stylists can choose" hint="One per line.">
          <textarea className="field min-h-[260px] font-mono text-[13px]" value={services} onChange={(e) => setServices(e.target.value)} />
          {fromCatalog.length > 0 && <select className="field mt-2" value="" onChange={(e) => e.target.value && setServices(`${services.trim()}\n${e.target.value}`)}><option value="">Add from the service menu…</option>{fromCatalog.map((c) => <option key={c}>{c}</option>)}</select>}
        </Field>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-ink">Collections</p>
          <ul className="mb-2 space-y-1">{cols.map((c) => <li key={c.id} className="flex items-center justify-between rounded-lg border border-line px-3 py-1.5 text-[14px]">{c.name} <span className="flex items-center gap-2 text-[12px] text-stone">{c.count}<button type="button" className="rounded p-1 hover:bg-mist hover:text-rose" onClick={() => delCol(c.id)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></button></span></li>)}</ul>
          <div className="flex gap-2"><input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Fall 2026 copper" /><Button onClick={addCol} disabled={!name.trim()}>Add</Button></div>
          <p className="mt-2 text-[12px] text-stone">Add transformations to a collection from the library: Select → Add to collection.</p>
        </div>
      </div>
    </Modal>
  );
}

function AddToCollection({ o, ids, onClose }: { o: Options; ids: string[]; onClose: (done: boolean) => void }) {
  const toast = useToast();
  const [cid, setCid] = useState(o.collections[0]?.id ?? '');
  const [name, setName] = useState('');
  const go = async () => {
    try {
      let id = cid;
      if (!id) {
        const cols = (await api.post<{ collections: Options['collections'] }>('/transformations/collections', { name })).collections;
        id = cols.find((c) => c.name.toLowerCase() === name.trim().toLowerCase())!.id;
      }
      await api.post(`/transformations/collections/${id}/items`, { ids });
      toast(`Added ${ids.length} to the collection`);
      onClose(true);
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <Modal open onClose={() => onClose(false)} title={`Add ${ids.length} to a collection`} footer={<><Button variant="ghost" onClick={() => onClose(false)}>Cancel</Button><Button variant="primary" disabled={!cid && !name.trim()} onClick={go}>Add</Button></>}>
      <Field label="Collection">
        <select className="field" value={cid} onChange={(e) => setCid(e.target.value)}>{o.collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}<option value="">New collection…</option></select>
      </Field>
      {!cid && <Field label="Name" className="mt-3"><input className="field" value={name} onChange={(e) => setName(e.target.value)} /></Field>}
    </Modal>
  );
}
