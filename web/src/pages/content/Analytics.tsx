import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lightbulb } from 'lucide-react';
import type { ContentMetrics, ContentPostDTO } from '@addendum/shared';
import { api } from '../../api/client';
import { Badge, PageLoading, Segmented } from '../../components/ui';
import { AccountTag, platformLabel, type Basics } from './common';

type Group = { key: string; posts: number; withMetrics: number; totals: Required<ContentMetrics>; engagement: number };
type Report = { posts: number; totals: Required<ContentMetrics>; byAccount: Group[]; byPlatform: Group[]; top: ContentPostDTO[]; suggestions: string[]; manual: number; imported: number };
const n = (x: number) => x.toLocaleString();
const COLS: [keyof ContentMetrics, string][] = [['reach', 'Reach'], ['views', 'Views'], ['impressions', 'Impressions'], ['likes', 'Likes'], ['comments', 'Comments'], ['saves', 'Saves'], ['shares', 'Shares'], ['clicks', 'Clicks'], ['bookingInquiries', 'Booking inquiries'], ['productClicks', 'Product clicks']];

/** Performance of published posts: totals by account and platform, top posts, and what to make more of. */
export function AnalyticsTab({ b, onOpen }: { b: Basics; onOpen: (p: ContentPostDTO) => void }) {
  const [days, setDays] = useState<'30' | '90' | '365'>('30');
  const from = new Date(Date.now() - Number(days) * 86400_000).toISOString(); const to = new Date(Date.now() + 86400_000).toISOString();
  const { data, isLoading } = useQuery({ queryKey: ['content-analytics', days], queryFn: () => api.get<Report>(`/content/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`) });
  if (isLoading || !data) return <PageLoading />;
  const table = (rows: Group[], label: (k: string) => React.ReactNode) => (
    <div className="overflow-x-auto"><table className="w-full min-w-[860px] border border-line bg-white text-left text-[13px]">
      <thead className="border-b border-line bg-mist/50 text-[11px] uppercase tracking-wide text-stone"><tr><th className="px-3 py-2" /><th className="px-2 py-2 text-right">Posts</th>{COLS.map(([, l]) => <th key={l} className="px-2 py-2 text-right">{l}</th>)}<th className="px-2 py-2 text-right">Sales</th></tr></thead>
      <tbody className="divide-y divide-line">{rows.map((r) => (
        <tr key={r.key}><td className="px-3 py-2">{label(r.key)}</td><td className="num px-2 py-2 text-right">{r.posts}{r.withMetrics < r.posts && <span className="text-stone"> ({r.withMetrics} with numbers)</span>}</td>
          {COLS.map(([k]) => <td key={k} className="num px-2 py-2 text-right">{n(r.totals[k])}</td>)}<td className="num px-2 py-2 text-right">${n(Math.round(r.totals.salesCents / 100))}</td></tr>
      ))}</tbody>
    </table></div>
  );
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented size="sm" value={days} onChange={setDays} options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: 'Year' }]} />
        <span className="text-[13px] text-stone">{data.posts} published · numbers <Badge tone="sage">imported</Badge> {data.imported} · <Badge>entered by hand</Badge> {data.manual}</span>
      </div>
      {!!data.suggestions.length && (
        <section className="rounded-xl border border-plum/30 bg-plum-tint/30 p-4 text-[13px]">
          <p className="mb-1 flex items-center gap-1.5 font-medium text-ink"><Lightbulb className="h-4 w-4" />From your results</p>
          <ul className="list-disc space-y-0.5 pl-5 text-ink-soft">{data.suggestions.map((s) => <li key={s}>{s}</li>)}</ul>
        </section>
      )}
      <section><h2 className="mb-2 text-[15px] font-medium text-ink">By account</h2>{data.byAccount.length ? table(data.byAccount, (k) => <AccountTag a={b.accountOf(k)} />) : <p className="text-[13px] text-stone">Nothing published in this period yet.</p>}</section>
      <section><h2 className="mb-2 text-[15px] font-medium text-ink">By platform</h2>{data.byPlatform.length ? table(data.byPlatform, (k) => platformLabel(k)) : <p className="text-[13px] text-stone">—</p>}</section>
      <section>
        <h2 className="mb-2 text-[15px] font-medium text-ink">Top posts</h2>
        {!data.top.length ? <p className="text-[13px] text-stone">Add numbers to published posts (Performance) to see what works best.</p> : (
          <ul className="panel divide-y divide-line">{data.top.map((p) => (
            <li key={p.id}><button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left text-[13px] hover:bg-mist/40" onClick={() => onOpen(p)}>
              <AccountTag a={b.accountOf(p.account)} /><span className="min-w-0 flex-1 truncate font-medium text-ink">{p.title}</span>
              <span className="text-stone">{p.pillar}</span><span className="num text-ink-soft">{n(p.metrics.reach ?? 0)} reach · {n((p.metrics.likes ?? 0) + (p.metrics.comments ?? 0) + (p.metrics.saves ?? 0) + (p.metrics.shares ?? 0))} engagements</span>
              <Badge tone={p.metricsSource === 'imported' ? 'sage' : 'neutral'}>{p.metricsSource === 'imported' ? 'Imported' : 'Manual'}</Badge>
            </button></li>
          ))}</ul>
        )}
      </section>
    </div>
  );
}
