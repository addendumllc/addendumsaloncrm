import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Copy, Download, ExternalLink, MessageSquare, Play, Send } from 'lucide-react';
import { Badge, Button, PageLoading, buttonClass, chipClass, cx } from '../components/ui';

interface SharedPost {
  id: string; title: string; account: string; accountColor: string | null; platform: string; type: string; scheduledAt: string | null; status: string;
  headline: string | null; caption: string; cta: string | null; hashtags: string | null; permalink: string | null;
  media: { id: string; mime: string; url: string }[]; notes: { who: string; body: string; creator: boolean; at: string }[];
}
interface Shared { name: string; allowNotes: boolean; posts: SharedPost[] }
const TYPE: Record<string, string> = { feed: 'Post', carousel: 'Carousel', reel: 'Reel', story: 'Story', video: 'Video', pin: 'Pin', email: 'Email', promo: 'Promo', article: 'Blog article' };
const dayKey = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-CA') : '');
const fmtDay = (k: string) => new Date(`${k}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

async function call<T>(url: string, body?: object): Promise<T> {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'addendum-crm' }, body: JSON.stringify(body) } : {});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message ?? 'Something went wrong.');
  return d as T;
}

/**
 * A creator's view of the Content Calendar (a share link, no CRM account): only the posts the salon has shared —
 * approved ones, or ones marked to share — with captions to copy, photos to download and notes for the team.
 */
export function SharePage() {
  const token = useLocation().pathname.split('/')[2] ?? '';
  const [data, setData] = useState<Shared | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState('');
  useEffect(() => { call<Shared>(`/api/public/share/${token}`).then(setData).catch((e) => setError((e as Error).message)); }, [token]);
  const accounts = useMemo(() => [...new Set((data?.posts ?? []).map((p) => p.account))], [data]);
  const shown = (data?.posts ?? []).filter((p) => !account || p.account === account);
  const days = [...new Set(shown.map((p) => dayKey(p.scheduledAt)))];

  if (error) return <Shell><div className="panel mx-auto mt-10 max-w-md p-6 text-center"><h1 className="h-display text-[26px]">This link isn’t available</h1><p className="mt-2 text-[14px] text-stone">It may have been turned off or expired. Ask the salon for a new one.</p></div></Shell>;
  if (!data) return <Shell><PageLoading /></Shell>;
  return (
    <Shell>
      <header className="mb-5">
        <p className="text-[13px] uppercase tracking-[0.12em] text-stone">Addendum · Content calendar</p>
        <h1 className="h-display mt-1 text-[30px] leading-tight sm:text-[38px]">Shared with {data.name}</h1>
        <p className="mt-1 text-[14px] text-stone">Approved posts and what’s coming up. Copy captions, download photos{data.allowNotes ? ', and leave notes for the team' : ''}.</p>
      </header>
      {accounts.length > 1 && (
        <div className="-mx-1 mb-4 flex gap-1.5 overflow-x-auto px-1 scrollbar-none">
          <button type="button" className={chipClass(!account, 'shrink-0')} onClick={() => setAccount('')}>All accounts</button>
          {accounts.map((a) => <button key={a} type="button" className={chipClass(account === a, 'shrink-0')} onClick={() => setAccount(a)}>{a}</button>)}
        </div>
      )}
      {!shown.length ? <p className="panel p-6 text-center text-[14px] text-stone">Nothing shared yet — check back soon.</p> : (
        <div className="space-y-6">
          {days.map((d) => (
            <section key={d || 'unscheduled'}>
              <h2 className="mb-2 text-[14px] font-semibold text-ink">{d ? fmtDay(d) : 'Date to be confirmed'}</h2>
              <div className="space-y-3">{shown.filter((p) => dayKey(p.scheduledAt) === d).map((p) => <PostCard key={p.id} p={p} token={token} allowNotes={data.allowNotes} onUpdated={setData} />)}</div>
            </section>
          ))}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-[100dvh] bg-paper"><div className="app-content mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">{children}</div></div>;
}

function PostCard({ p, token, allowNotes, onUpdated }: { p: SharedPost; token: string; allowNotes: boolean; onUpdated: (d: Shared) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const caption = [p.headline, p.caption, p.cta, p.hashtags].filter(Boolean).join('\n\n');
  const copy = async () => { try { await navigator.clipboard.writeText(caption); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* select by hand */ } };
  const send = async () => {
    setBusy(true); setMsg(null);
    try { onUpdated(await call<Shared>(`/api/public/share/${token}/notes`, { postId: p.id, body: note })); setNote(''); setMsg('Sent to the team'); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <article className="panel overflow-hidden !p-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2 text-[13px]">
        <span className="inline-flex items-center gap-1.5 text-ink"><span className="h-2.5 w-2.5 rounded-full" style={{ background: p.accountColor ?? '#999' }} />{p.account}</span>
        <span className="text-stone">{TYPE[p.type] ?? p.type}{p.scheduledAt ? ` · ${fmtTime(p.scheduledAt)}` : ''}</span>
        <Badge tone={p.status === 'Published' ? 'sage' : p.status === 'Scheduled' ? 'plum' : 'neutral'} className="ml-auto">{p.status}</Badge>
      </div>
      {p.media.length > 0 && (
        <div className="flex h-48 snap-x snap-mandatory gap-1 overflow-x-auto bg-mist p-1 scrollbar-none sm:h-60">
          {p.media.map((m, i) => (
            <span key={m.id} className={cx('relative h-full shrink-0 snap-start overflow-hidden rounded-md', p.type === 'story' || p.type === 'reel' ? 'aspect-[9/16]' : 'aspect-[4/5]')}>
              {m.mime.startsWith('video/') ? <video src={m.url} controls playsInline preload="metadata" className="h-full w-full bg-black object-cover" /> : <img src={m.url} alt="" loading="lazy" className="h-full w-full object-cover" />}
              {p.media.length > 1 && <span className="absolute left-1 top-1 rounded-full bg-ink/80 px-1.5 text-[10px] text-white">{i + 1}</span>}
              {m.mime.startsWith('video/') && <Play className="pointer-events-none absolute right-1 top-1 h-3.5 w-3.5 fill-white text-white drop-shadow" />}
              <a href={m.url} download className="absolute bottom-1 right-1 flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-ink shadow" aria-label="Download"><Download className="h-4 w-4" /></a>
            </span>
          ))}
        </div>
      )}
      <div className="space-y-2 p-3">
        <h3 className="text-[15px] font-medium text-ink">{p.title}</h3>
        {caption && <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink-soft">{caption}</p>}
        <div className="flex flex-wrap gap-2">
          {caption && <Button size="sm" icon={<Copy className="h-3.5 w-3.5" />} onClick={copy}>{copied ? 'Copied' : 'Copy caption'}</Button>}
          {p.permalink && <a className={buttonClass('secondary', 'sm')} href={p.permalink} target="_blank" rel="noreferrer noopener"><ExternalLink className="h-3.5 w-3.5" /><span className="btn-label">View post</span></a>}
        </div>
        {allowNotes && (
          <div className="mt-2 border-t border-line pt-2">
            {p.notes.length > 0 && (
              <ul className="mb-2 space-y-1.5">{p.notes.map((n, i) => (
                <li key={i} className={cx('rounded-lg px-2.5 py-1.5 text-[13px]', n.creator ? 'bg-plum-tint' : 'bg-mist')}><span className="font-medium text-ink">{n.who}</span> <span className="text-stone">· {new Date(n.at).toLocaleDateString()}</span><span className="block whitespace-pre-wrap text-ink-soft">{n.body}</span></li>
              ))}</ul>
            )}
            <div className="flex items-end gap-2">
              <textarea className="field min-h-[40px] flex-1 text-[14px]" rows={1} maxLength={2000} placeholder="Leave a note for the team" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button variant="primary" icon={<Send className="h-4 w-4" />} loading={busy} disabled={!note.trim()} onClick={send} aria-label="Send note" />
            </div>
            {msg && <p className="mt-1 flex items-center gap-1 text-[12px] text-stone"><MessageSquare className="h-3 w-3" />{msg}</p>}
          </div>
        )}
      </div>
    </article>
  );
}
