import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { CONTENT_FORMATS, CONTENT_PLATFORMS, CONTENT_STATUSES, type ContentPostDTO } from '@addendum/shared';
import { api } from '../../api/client';
import { Badge, Button, PageLoading, Segmented, cx, useToast } from '../../components/ui';
import { AccountTag, STATUS_TONE, formatLabel, platformLabel, statusLabel, timeOf, ymd, type Basics } from './common';

type View = 'month' | 'week' | 'day';
const PILL = { sage: 'bg-sage-tint text-sage', amber: 'bg-amber-tint text-amber', rose: 'bg-rose-tint text-rose', plum: 'bg-plum-tint text-plum', neutral: 'bg-mist text-stone' } as const;
const startOfWeek = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

/**
 * The calendar: month, week or day, filtered by account, platform, pillar, format, status, campaign and person.
 * Drag a post to another day to move it (its time stays the same). Ideas without a date are listed below.
 */
export function CalendarTab({ b, onOpen, onNew }: { b: Basics; onOpen: (p: ContentPostDTO) => void; onNew: (date?: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [view, setViewState] = useState<View>(() => { try { return (localStorage.getItem('content-view') as View) || 'month'; } catch { return 'month'; } });
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem('content-view', v); } catch { /* private */ } };
  const [anchor, setAnchor] = useState(() => new Date());
  const [f, setF] = useState({ account: '', platform: '', pillar: '', format: '', status: '', campaign: '', person: '' });
  const [dragging, setDragging] = useState<string | null>(null);
  const days = useMemo(() => {
    if (view === 'day') { const d = new Date(anchor); d.setHours(0, 0, 0, 0); return [d]; }
    const start = view === 'week' ? startOfWeek(anchor) : startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    return Array.from({ length: view === 'week' ? 7 : 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }, [view, anchor]);
  const from = days[0]; const to = new Date(days[days.length - 1].getTime() + 86400_000);
  const { data, isLoading } = useQuery({ queryKey: ['content-posts', ymd(from), ymd(to)], queryFn: () => api.get<{ posts: ContentPostDTO[] }>(`/content/posts?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`).then((r) => r.posts) });
  const posts = (data ?? []).filter((p) => (!f.account || p.account === f.account) && (!f.platform || p.platform === f.platform) && (!f.pillar || p.pillar === f.pillar) && (!f.format || p.type === f.format)
    && (!f.status || p.status === f.status) && (!f.campaign || p.campaignId === f.campaign) && (!f.person || [p.assignedStaffId, p.reviewerStaffId, p.publisherStaffId].includes(f.person)));
  const dated = posts.filter((p) => p.scheduledAt);
  const ideas = posts.filter((p) => !p.scheduledAt);
  const on = (d: Date) => dated.filter((p) => ymd(new Date(p.scheduledAt!)) === ymd(d)).sort((a, x) => a.scheduledAt!.localeCompare(x.scheduledAt!));
  const pillars = [...new Set(b.mine.flatMap((a) => a.pillars))];
  const step = (n: number) => { const d = new Date(anchor); if (view === 'month') d.setMonth(d.getMonth() + n, 1); else d.setDate(d.getDate() + n * (view === 'week' ? 7 : 1)); setAnchor(d); };
  const drop = async (day: Date) => {
    const p = (data ?? []).find((x) => x.id === dragging);
    setDragging(null);
    if (!p) return;
    const when = p.scheduledAt ? new Date(p.scheduledAt) : new Date(new Date(day).setHours(10, 0, 0, 0));
    const next = new Date(day); next.setHours(when.getHours(), when.getMinutes(), 0, 0);
    if (p.scheduledAt && ymd(new Date(p.scheduledAt)) === ymd(day)) return;
    try { await api.post(`/content/posts/${p.id}/reschedule`, { scheduledAt: next.toISOString() }); void qc.invalidateQueries({ queryKey: ['content-posts'] }); toast(`Moved to ${next.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const Entry = ({ p, full }: { p: ContentPostDTO; full?: boolean }) => {
    const a = b.accountOf(p.account);
    return (
      <button type="button" draggable={!['published', 'publishing'].includes(p.status)} onDragStart={() => setDragging(p.id)} onDragEnd={() => setDragging(null)} onClick={() => onOpen(p)}
        className={cx('block w-full rounded border-l-[3px] bg-white px-1.5 py-1 text-left shadow-sm hover:bg-mist/60', full ? 'text-[13px]' : 'text-[11px]')} style={{ borderLeftColor: a?.color }}
        title={`${p.title} · ${a?.name} · ${platformLabel(p.platform)} · ${statusLabel(p.status)}`}>
        <span className="flex items-center gap-1"><span className="num text-stone">{p.scheduledAt ? timeOf(p.scheduledAt) : ''}</span><span className="truncate font-medium text-ink">{p.title}</span></span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-[10.5px] text-stone"><span className="truncate">{a?.name}</span>· {platformLabel(p.platform)}{full && <> · {formatLabel(p.type)}</>}
          <span className={cx('rounded px-1', PILL[STATUS_TONE[p.status]])}>{statusLabel(p.status)}</span></span>
        {full && p.assignedName && <span className="block text-[11px] text-stone">{p.assignedName}</span>}
      </button>
    );
  };
  const sel = (k: keyof typeof f, label: string, opts: { value: string; label: string }[]) => (
    <select className="field h-9 w-auto py-1 text-[13px]" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} aria-label={label}><option value="">{label}</option>{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
  );
  const title = view === 'month' ? anchor.toLocaleDateString([], { month: 'long', year: 'numeric' }) : view === 'week' ? `Week of ${days[0].toLocaleDateString([], { month: 'short', day: 'numeric' })}` : anchor.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" icon={<ChevronLeft className="h-4 w-4" />} aria-label="Previous" onClick={() => step(-1)} />
        <span className="min-w-[10rem] text-center text-[15px] font-medium text-ink">{title}</span>
        <Button size="sm" variant="ghost" icon={<ChevronRight className="h-4 w-4" />} aria-label="Next" onClick={() => step(1)} />
        <Button size="sm" variant="ghost" onClick={() => setAnchor(new Date())}>Today</Button>
        <Segmented size="sm" className="ml-auto" value={view} onChange={setView} options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }, { value: 'day', label: 'Day' }]} />
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="flex flex-wrap gap-1.5">
          {[{ id: '', name: 'All accounts', color: '' }, ...b.mine].map((a) => (
            <button key={a.id || 'all'} type="button" onClick={() => setF({ ...f, account: a.id })} className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]', f.account === a.id ? 'border-ink text-ink' : 'border-line text-stone hover:border-ink/40')}>
              {a.color && <span className="h-2.5 w-2.5 rounded-full" style={{ background: a.color }} />}{a.name}
            </button>
          ))}
        </div>
        {sel('platform', 'All platforms', CONTENT_PLATFORMS)}{sel('pillar', 'All pillars', pillars.map((p) => ({ value: p, label: p })))}{sel('format', 'All formats', CONTENT_FORMATS)}
        {sel('status', 'All statuses', CONTENT_STATUSES.filter((s) => s.value !== 'publishing'))}{sel('campaign', 'All campaigns', b.campaigns.map((c) => ({ value: c.id, label: c.name })))}{sel('person', 'Everyone', b.staff.map((s) => ({ value: s.id, label: s.name })))}
      </div>
      {isLoading ? <PageLoading /> : view === 'day' ? (
        <div className="panel min-h-[200px] p-3" onDragOver={(e) => e.preventDefault()} onDrop={() => drop(days[0])}>
          <div className="space-y-2">{on(days[0]).map((p) => <Entry key={p.id} p={p} full />)}</div>
          {!on(days[0]).length && <p className="text-[13px] text-stone">Nothing scheduled. <button type="button" className="text-plum hover:underline" onClick={() => onNew(ymd(days[0]))}>Add a post</button></p>}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="grid min-w-[760px] grid-cols-7 border-l border-t border-line bg-white text-[12px]">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="border-b border-r border-line bg-mist/40 px-2 py-1.5 text-[11px] uppercase tracking-wide text-stone">{d}</div>)}
            {days.map((d) => {
              const list = on(d);
              const out = view === 'month' && d.getMonth() !== anchor.getMonth();
              const today = ymd(d) === ymd(new Date());
              return (
                <div key={ymd(d)} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(d)}
                  className={cx('group border-b border-r border-line p-1', view === 'week' ? 'min-h-[320px]' : 'min-h-[104px]', out && 'bg-mist/30', dragging && 'hover:bg-plum-tint/40')}>
                  <div className="mb-1 flex items-center justify-between">
                    <button type="button" onClick={() => { setAnchor(d); setView('day'); }} className={cx('inline-flex h-6 w-6 items-center justify-center rounded-full text-[12px]', today ? 'bg-plum text-white' : out ? 'text-stone-light' : 'text-ink-soft hover:bg-mist')}>{d.getDate()}</button>
                    <button type="button" className="rounded p-0.5 text-stone opacity-0 hover:bg-mist hover:text-ink group-hover:opacity-100" aria-label="New post this day" onClick={() => onNew(ymd(d))}><Plus className="h-3.5 w-3.5" /></button>
                  </div>
                  <div className="space-y-1">{(view === 'week' ? list : list.slice(0, 3)).map((p) => <Entry key={p.id} p={p} full={view === 'week'} />)}
                    {view === 'month' && list.length > 3 && <button type="button" className="block px-1 text-[11px] text-plum hover:underline" onClick={() => { setAnchor(d); setView('day'); }}>+{list.length - 3} more</button>}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <section className="mt-6">
        <h2 className="mb-2 text-[15px] font-medium text-ink">Not scheduled yet <span className="num text-stone">{ideas.length}</span></h2>
        {!ideas.length ? <p className="text-[13px] text-stone">Posts without a date show here — drag one onto a day to schedule it.</p> : (
          <ul className="panel divide-y divide-line">{ideas.map((p) => (
            <li key={p.id} draggable onDragStart={() => setDragging(p.id)} onDragEnd={() => setDragging(null)}>
              <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left text-[13px] hover:bg-mist/40" onClick={() => onOpen(p)}>
                <AccountTag a={b.accountOf(p.account)} /><span className="min-w-0 flex-1 truncate font-medium text-ink">{p.title}</span>
                <span className="text-stone">{platformLabel(p.platform)} · {formatLabel(p.type)}</span>{p.assignedName && <span className="text-stone">{p.assignedName}</span>}
                <Badge tone={STATUS_TONE[p.status]}>{statusLabel(p.status)}</Badge>
              </button>
            </li>
          ))}</ul>
        )}
      </section>
    </div>
  );
}
