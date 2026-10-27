import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Film, ImagePlus, Link2, Plus, Settings2, Trash2, X } from 'lucide-react';
import type { ContentAccount, ContentMediaDTO, ContentPostDTO, ContentPostType, ContentStatus } from '@addendum/shared';
import { api } from '../api/client';
import { useStaff } from '../api/hooks';
import { Badge, Button, Field, Modal, PageHeader, PageLoading, Segmented, Toggle, cx, useToast } from '../components/ui';

const TYPES: { value: ContentPostType; label: string }[] = [{ value: 'feed', label: 'Post' }, { value: 'carousel', label: 'Carousel' }, { value: 'reel', label: 'Reel' }, { value: 'story', label: 'Story' }];
const STATUS: Record<ContentStatus, { label: string; tone: 'neutral' | 'amber' | 'plum' | 'sage' | 'rose' }> = {
  idea: { label: 'Idea', tone: 'neutral' }, draft: { label: 'Draft', tone: 'neutral' }, ready: { label: 'Ready', tone: 'amber' },
  scheduled: { label: 'Scheduled', tone: 'plum' }, publishing: { label: 'Posting…', tone: 'plum' }, posted: { label: 'Posted', tone: 'sage' }, failed: { label: 'Failed', tone: 'rose' },
};
const typeLabel = (t: ContentPostType) => TYPES.find((x) => x.value === t)!.label;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** datetime-local value ↔ ISO. */
const toLocal = (iso: string | null) => (iso ? (() => { const d = new Date(iso); return `${ymd(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; })() : '');
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);

/** Content calendar: Instagram posts for the salon's three accounts, by month — plus ideas without a date. */
export function ContentPage() {
  const [params, setParams] = useSearchParams();
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [only, setOnly] = useState<string>('all');
  const [editing, setEditing] = useState<ContentPostDTO | { new: true; date?: string } | null>(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const { data: acc } = useQuery({ queryKey: ['content-accounts'], queryFn: () => api.get<{ accounts: ContentAccount[] }>('/content/accounts') });
  // The grid shows whole weeks (Monday first), so posts are loaded for those days.
  const start = useMemo(() => { const d = new Date(month); d.setDate(1 - ((d.getDay() + 6) % 7)); return d; }, [month]);
  const days = useMemo(() => Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; }), [start]);
  const end = days[41];
  const { data, isLoading } = useQuery({
    queryKey: ['content-posts', ymd(start)],
    queryFn: () => api.get<{ posts: ContentPostDTO[] }>(`/content/posts?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(new Date(end.getTime() + 86400_000).toISOString())}`).then((r) => r.posts),
  });
  const accounts = acc?.accounts ?? [];
  const accOf = (id: string) => accounts.find((a) => a.id === id);
  const posts = (data ?? []).filter((p) => only === 'all' || p.account === only);
  const dated = posts.filter((p) => p.scheduledAt);
  const ideas = posts.filter((p) => !p.scheduledAt);
  const byDay = (d: Date) => dated.filter((p) => ymd(new Date(p.scheduledAt!)) === ymd(d)).sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!));
  // Opened from a reminder (?post=…).
  const focus = params.get('post');
  if (focus && data && !editing) {
    const p = data.find((x) => x.id === focus);
    if (p) { setEditing(p); const n = new URLSearchParams(params); n.delete('post'); setParams(n, { replace: true }); }
  }
  const chip = (p: ContentPostDTO) => {
    const a = accOf(p.account);
    return (
      <button key={p.id} type="button" onClick={() => setEditing(p)} className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] text-white hover:opacity-90" style={{ background: a?.color ?? '#6b5242', opacity: p.status === 'idea' || p.status === 'draft' ? 0.7 : 1 }}
        title={`${a?.name ?? ''} · ${typeLabel(p.type)} · ${STATUS[p.status].label}${p.caption ? ` — ${p.caption.slice(0, 80)}` : ''}`}>
        {new Date(p.scheduledAt!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} {typeLabel(p.type)}{p.status === 'posted' ? ' ✓' : p.status === 'failed' ? ' !' : ''}
      </button>
    );
  };
  return (
    <div>
      <PageHeader title="Content calendar" subtitle="Instagram posts for each account — plan, assign and schedule."
        actions={<>
          <Button variant="ghost" icon={<Settings2 className="h-4 w-4" />} onClick={() => setAccountsOpen(true)}>Accounts</Button>
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ new: true })}>New post</Button>
        </>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" icon={<ChevronLeft className="h-4 w-4" />} aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} />
        <span className="min-w-[9rem] text-center text-[15px] font-medium text-ink">{month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</span>
        <Button size="sm" variant="ghost" icon={<ChevronRight className="h-4 w-4" />} aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} />
        <Button size="sm" variant="ghost" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</Button>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {[{ id: 'all', name: 'All accounts', color: '' }, ...accounts].map((a) => (
            <button key={a.id} type="button" onClick={() => setOnly(a.id)} className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]', only === a.id ? 'border-ink text-ink' : 'border-line text-stone hover:border-ink/40')}>
              {a.color && <span className="h-2.5 w-2.5 rounded-full" style={{ background: a.color }} />}{a.name}
            </button>
          ))}
        </div>
      </div>
      {isLoading ? <PageLoading /> : (
        <div className="overflow-x-auto">
          <div className="grid min-w-[720px] grid-cols-7 border-l border-t border-line bg-white text-[12px]">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="border-b border-r border-line bg-mist/40 px-2 py-1.5 text-[11px] uppercase tracking-wide text-stone">{d}</div>)}
            {days.map((d) => {
              const list = byDay(d);
              const out = d.getMonth() !== month.getMonth();
              const today = ymd(d) === ymd(new Date());
              return (
                <div key={ymd(d)} className={cx('group min-h-[96px] border-b border-r border-line p-1', out && 'bg-mist/30')}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className={cx('inline-flex h-6 w-6 items-center justify-center rounded-full text-[12px]', today ? 'bg-plum text-white' : out ? 'text-stone-light' : 'text-ink-soft')}>{d.getDate()}</span>
                    <button type="button" className="rounded p-0.5 text-stone opacity-0 hover:bg-mist hover:text-ink group-hover:opacity-100" aria-label={`New post on ${d.toDateString()}`} onClick={() => setEditing({ new: true, date: ymd(d) })}><Plus className="h-3.5 w-3.5" /></button>
                  </div>
                  <div className="space-y-0.5">{list.slice(0, 4).map(chip)}{list.length > 4 && <span className="block px-1 text-[11px] text-stone">+{list.length - 4} more</span>}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <section className="mt-6">
        <h2 className="mb-2 text-[15px] font-medium text-ink">Ideas without a date <span className="num text-stone">{ideas.length}</span></h2>
        {!ideas.length ? <p className="text-[13px] text-stone">Jot down ideas with New post and leave the date empty.</p> : (
          <ul className="panel divide-y divide-line">
            {ideas.map((p) => (
              <li key={p.id}><button type="button" className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px] hover:bg-mist/40" onClick={() => setEditing(p)}>
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: accOf(p.account)?.color }} />
                <span className="w-24 shrink-0 text-stone">{accOf(p.account)?.name}</span>
                <span className="min-w-0 flex-1 truncate text-ink">{p.caption || <span className="text-stone">No caption yet</span>}</span>
                <span className="text-stone">{typeLabel(p.type)}</span>{p.assignedName && <span className="text-stone">{p.assignedName}</span>}
                <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
              </button></li>
            ))}
          </ul>
        )}
      </section>
      {editing && <PostModal post={'new' in editing ? null : editing} date={'new' in editing ? editing.date : undefined} accounts={accounts} defaultAccount={only !== 'all' ? only : undefined} onClose={() => setEditing(null)} />}
      {accountsOpen && <AccountsModal accounts={accounts} onClose={() => setAccountsOpen(false)} />}
    </div>
  );
}

type Draft = { account: ContentAccount['id']; type: ContentPostType; when: string; caption: string; status: ContentStatus; autoPost: boolean; media: ContentMediaDTO[]; link: ContentPostDTO['link']; assignedStaffId: string; notes: string };

/** One post: account, type, when, caption, photos/videos, what it promotes, who's on it, and auto-posting. */
function PostModal({ post, date, accounts, defaultAccount, onClose }: { post: ContentPostDTO | null; date?: string; accounts: ContentAccount[]; defaultAccount?: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: staff } = useStaff();
  const [d, setD] = useState<Draft>(() => post ? {
    account: post.account, type: post.type, when: toLocal(post.scheduledAt), caption: post.caption, status: post.status === 'publishing' ? 'scheduled' : post.status, autoPost: post.autoPost,
    media: post.media, link: post.link, assignedStaffId: post.assignedStaffId ?? '', notes: post.notes ?? '',
  } : { account: (defaultAccount as ContentAccount['id']) ?? 'a1', type: 'feed', when: date ? `${date}T10:00` : '', caption: '', status: date ? 'draft' : 'idea', autoPost: false, media: [], link: null, assignedStaffId: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [linkQ, setLinkQ] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const account = accounts.find((a) => a.id === d.account);
  const { data: linkOpts } = useQuery({ queryKey: ['content-links', linkQ], enabled: linkQ.trim().length >= 2, queryFn: () => api.get<{ options: NonNullable<ContentPostDTO['link']>[] }>(`/content/links?q=${encodeURIComponent(linkQ)}`).then((r) => r.options) });
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const done = () => { void qc.invalidateQueries({ queryKey: ['content-posts'] }); onClose(); };
  const save = async () => {
    setBusy(true);
    try {
      const body = { account: d.account, type: d.type, scheduledAt: fromLocal(d.when), caption: d.caption, status: d.autoPost && d.status === 'ready' ? 'scheduled' : d.status, autoPost: d.autoPost, mediaIds: d.media.map((m) => m.id), link: d.link, assignedStaffId: d.assignedStaffId || null, notes: d.notes.trim() || null };
      if (post) await api.put(`/content/posts/${post.id}`, body); else await api.post('/content/posts', body);
      toast(post ? 'Saved' : 'Added to the calendar');
      done();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!post || !window.confirm('Delete this post and its photos/videos?')) return;
    try { await api.del(`/content/posts/${post.id}`); done(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const addFiles = async (files: FileList | null) => {
    for (const f of [...(files ?? [])]) {
      setUploading((n) => n + 1);
      try { const r = await api.upload<{ media: ContentMediaDTO }>('/content/media', f); setD((x) => ({ ...x, media: [...x.media, r.media] })); }
      catch (e) { toast(`${f.name}: ${(e as Error).message}`, 'error'); }
      finally { setUploading((n) => n - 1); }
    }
  };
  const move = (i: number, dir: -1 | 1) => setD((x) => { const m = [...x.media]; if (!m[i + dir]) return x; [m[i], m[i + dir]] = [m[i + dir], m[i]]; return { ...x, media: m }; });
  const posted = post?.status === 'posted';
  return (
    <Modal open xl onClose={onClose} title={post ? `${account?.name ?? 'Instagram'} · ${typeLabel(d.type)}` : 'New post'} footer={<>
      {post && <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} className="mr-auto" onClick={del}>Delete</Button>}
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={busy} disabled={uploading > 0} onClick={save}>{post ? 'Save' : 'Add'}</Button>
    </>}>
      <div className="grid gap-5 text-[14px] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Account">
              <select className="field" value={d.account} onChange={(e) => set({ account: e.target.value as ContentAccount['id'] })}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.handle ? ` (@${a.handle})` : ''}</option>)}</select>
            </Field>
            <Field label="When" hint="Leave empty for an idea."><input type="datetime-local" className="field" value={d.when} onChange={(e) => set({ when: e.target.value })} /></Field>
          </div>
          <Segmented value={d.type} onChange={(t) => set({ type: t })} options={TYPES} />
          <Field label="Caption" hint={`${d.caption.length} / 2,200`}><textarea className="field min-h-[160px]" maxLength={2200} value={d.caption} onChange={(e) => set({ caption: e.target.value })} placeholder="Caption and hashtags" /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Status">
              <select className="field" value={d.status} onChange={(e) => set({ status: e.target.value as ContentStatus })}>
                {(['idea', 'draft', 'ready', 'scheduled', 'posted'] as ContentStatus[]).concat(d.status === 'failed' ? ['failed'] : []).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
              </select>
            </Field>
            <Field label="Who’s on it" hint="Reminded the day before and on the day.">
              <select className="field" value={d.assignedStaffId} onChange={(e) => set({ assignedStaffId: e.target.value })}>
                <option value="">No one yet</option>{(staff ?? []).filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Notes"><textarea className="field min-h-[60px]" maxLength={2000} value={d.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Shot list, music, who’s modelling…" /></Field>
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
                    {i > 0 && <button type="button" className="rounded bg-white/90 px-1 text-[11px]" onClick={() => move(i, -1)} aria-label="Move earlier">←</button>}
                    {i < d.media.length - 1 && <button type="button" className="rounded bg-white/90 px-1 text-[11px]" onClick={() => move(i, 1)} aria-label="Move later">→</button>}
                    <button type="button" className="rounded bg-white/90 p-0.5" onClick={() => set({ media: d.media.filter((x) => x.id !== m.id) })} aria-label="Remove"><X className="h-3.5 w-3.5" /></button>
                  </span>
                </div>
              ))}
              <button type="button" onClick={() => file.current?.click()} className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line-strong text-[12px] text-stone hover:border-ink/40 hover:text-ink">
                <ImagePlus className="h-5 w-5" />{uploading ? `Uploading ${uploading}…` : 'Add'}
              </button>
            </div>
            <input ref={file} type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime" className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
            <p className="mt-1 text-[12px] text-stone">Photos up to 15 MB, videos up to 100 MB. Carousel: 2–10, in this order.</p>
          </div>
          <div>
            <span className="label">Promotes</span>
            {d.link ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white py-1 pl-3 pr-1 text-[13px]"><Link2 className="h-3.5 w-3.5 text-stone" />{d.link.label}<span className="text-stone">· {d.link.kind}</span>
                <button type="button" className="rounded-full p-0.5 text-stone hover:text-ink" onClick={() => set({ link: null })} aria-label="Remove"><X className="h-3.5 w-3.5" /></button></span>
            ) : (
              <div className="relative">
                <input className="field" placeholder="Search a product or service, e.g. clip-ins, balayage" value={linkQ} onChange={(e) => setLinkQ(e.target.value)} />
                {!!linkOpts?.length && linkQ.trim().length >= 2 && (
                  <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line bg-white shadow-pop">
                    {linkOpts.map((o) => <li key={`${o.kind}-${o.ref}`}><button type="button" className="w-full px-3 py-2 text-left text-[13px] hover:bg-mist" onClick={() => { set({ link: o }); setLinkQ(''); }}>{o.label} <span className="text-stone">· {o.kind}</span></button></li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
          <div className="rounded-xl border border-line p-3">
            <Toggle checked={d.autoPost} onChange={(v) => set({ autoPost: v, status: v && (d.status === 'ready' || d.status === 'draft') ? 'scheduled' : d.status })} label="Post it automatically"
              description={account?.connected ? 'The CRM posts it to Instagram at the time above (status Scheduled).' : 'This account isn’t connected yet — Settings → API & Integrations → Instagram. Until then, post it yourself and mark it Posted.'} />
            {post?.error && <p className="mt-2 text-[13px] text-rose">{post.error}</p>}
            {posted && post?.permalink && <a className="mt-2 inline-block text-[13px] text-plum hover:underline" href={post.permalink} target="_blank" rel="noreferrer">View on Instagram</a>}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** The three accounts' names, handles and colours (their connection is in Settings → API & Integrations). */
function AccountsModal({ accounts, onClose }: { accounts: ContentAccount[]; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [list, setList] = useState(accounts.map(({ id, name, handle, color }) => ({ id, name, handle, color })));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { const r = await api.put<{ accounts: ContentAccount[] }>('/content/accounts', { accounts: list }); qc.setQueryData(['content-accounts'], r); toast('Saved'); onClose(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open wide onClose={onClose} title="Instagram accounts" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="space-y-3 text-[14px]">
        {list.map((a, i) => (
          <div key={a.id} className="grid items-end gap-2 sm:grid-cols-[auto_1fr_1fr_auto]">
            <input type="color" className="color-circle h-9 w-9 cursor-pointer overflow-hidden rounded-full border border-line-strong p-0" value={a.color} onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} aria-label={`Colour of account ${i + 1}`} />
            <Field label={`Account ${i + 1}`}><input className="field" value={a.name} maxLength={60} onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="e.g. Addendum Salon" /></Field>
            <Field label="Handle"><input className="field" value={a.handle} maxLength={60} onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, handle: e.target.value } : x)))} placeholder="@addendumsalon" /></Field>
            <span className="pb-2">{accounts[i]?.connected ? <Badge tone="sage">Auto-posting on</Badge> : <Badge>Plan only</Badge>}</span>
          </div>
        ))}
        <p className="text-[13px] text-stone">To post automatically, connect each account in Settings → API & Integrations → Instagram (account 1, 2 and 3 match the order here).</p>
      </div>
    </Modal>
  );
}

