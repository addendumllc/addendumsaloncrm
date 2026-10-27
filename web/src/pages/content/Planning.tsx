import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Plus, Trash2 } from 'lucide-react';
import type { ContentAccountId, ContentCampaignDTO, ContentIdeaDTO } from '@addendum/shared';
import { api } from '../../api/client';
import { Badge, Button, Field, Modal, PageLoading, useToast } from '../../components/ui';
import { AccountTag, formatLabel, platformLabel, type Basics } from './common';
import type { Prefill } from './PostEditor';

type Plan = { weeks: { weekOf: string; accounts: { account: ContentAccountId; empty: boolean; platforms: { platform: string; goal: number; planned: number; published: number }[] }[] }[]; seasonalIdeas: ContentIdeaDTO[]; campaignsWithoutPosts: ContentCampaignDTO[] };

/** Planning: this week and the next four against the weekly goals, empty weeks flagged, seasonal ideas and campaigns. */
export function PlanningTab({ b, onUse, embedded }: { b: Basics; onUse: (p: Prefill) => void; embedded?: boolean }) {
  const { data, isLoading } = useQuery({ queryKey: ['content-planning'], queryFn: () => api.get<Plan>('/content/planning') });
  const { data: ideas } = useQuery({ queryKey: ['content-ideas'], queryFn: () => api.get<{ ideas: ContentIdeaDTO[] }>('/content/ideas').then((r) => r.ideas) });
  // What could be posted: per account, this week's new ideas first, then favourites, seasonal ones and the rest —
  // a different pair each week.
  const pool = (account: ContentAccountId) => (ideas ?? []).filter((i) => i.accounts.includes(account))
    .sort((a, x) => Number(x.suggested) - Number(a.suggested) || Number(x.favorite) - Number(a.favorite) || Number(!!x.season && x.season !== 'any') - Number(!!a.season && a.season !== 'any'));
  const ideasFor = (account: ContentAccountId, week: number, n: number) => { const p = pool(account); return p.length ? Array.from({ length: Math.min(n, p.length) }, (_, k) => p[(week * n + k) % p.length]) : []; };
  const use = (i: ContentIdeaDTO, account: ContentAccountId, weekOf: string) => onUse({ accounts: [account], title: i.title, platform: i.platform, type: i.format, headline: i.hook, caption: i.caption ?? '', cta: i.cta, hashtags: i.hashtags, pillar: i.pillar, ideaId: i.id, date: weekOf,
    notes: [i.visual && `Visual: ${i.visual}`, i.shotList && `Shot list:\n${i.shotList}`].filter(Boolean).join('\n\n') });
  const [campaign, setCampaign] = useState<ContentCampaignDTO | 'new' | null>(null);
  if (isLoading || !data) return <PageLoading />;
  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-1 text-[15px] font-medium text-ink">Planned vs goal</h2>
        <p className="mb-3 text-[13px] text-stone">Posts scheduled each week (published in brackets) against the weekly goals{b.isAdmin ? ' — set goals in Settings' : ''}, with ideas that could go in each week.</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border border-line bg-white text-left text-[13px]">
            <thead className="border-b border-line bg-mist/50 text-[11px] uppercase tracking-wide text-stone"><tr><th className="px-3 py-2">Account</th>{data.weeks.map((w) => <th key={w.weekOf} className="px-3 py-2">Week of {new Date(`${w.weekOf}T12:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {b.mine.map((a) => (
                <tr key={a.id}>
                  <td className="px-3 py-2 align-top"><AccountTag a={a} /></td>
                  {data.weeks.map((w, wi) => {
                    const x = w.accounts.find((y) => y.account === a.id);
                    const planned = x?.platforms.reduce((n, p) => n + p.planned, 0) ?? 0;
                    const goal = x?.platforms.reduce((n, p) => n + p.goal, 0) ?? 0;
                    const room = goal ? Math.max(0, goal - planned) : planned ? 0 : 2;
                    return (
                      <td key={w.weekOf} className="px-3 py-2 align-top">
                        {x?.platforms.filter((p) => p.planned || p.goal).map((p) => <span key={p.platform} className="block text-ink-soft">{platformLabel(p.platform)}: <b className="num font-medium">{p.planned}</b>{p.goal ? ` / ${p.goal}` : ''} <span className="text-stone">({p.published})</span></span>)}
                        {room > 0 && ideasFor(a.id, wi, Math.min(room, 2)).map((i) => (
                          <button key={i.id} type="button" onClick={() => use(i, a.id, w.weekOf)} title="Add to this week"
                            className="mt-1 flex w-full items-start gap-1 rounded border border-dashed border-line px-1.5 py-1 text-left text-[12px] text-ink-soft hover:border-plum/50 hover:text-ink">
                            <Plus className="mt-0.5 h-3 w-3 shrink-0" /><span className="min-w-0"><span className="block truncate">{i.title}</span><span className="text-[11px] text-stone">{formatLabel(i.format)}</span></span>
                          </button>
                        ))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {!embedded && <section>
        <h2 className="mb-2 text-[15px] font-medium text-ink">Seasonal ideas for the coming weeks</h2>
        {!data.seasonalIdeas.length ? <p className="text-[13px] text-stone">No seasonal ideas for these weeks — browse the Ideas tab.</p> : (
          <ul className="panel divide-y divide-line">{data.seasonalIdeas.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
              <span className="min-w-0 flex-1 font-medium text-ink">{i.title}</span>{i.accounts.map((a) => <AccountTag key={a} a={b.accountOf(a)} small />)}
              <span className="text-stone">{formatLabel(i.format)} · {i.season}</span>
              <Button size="sm" variant="ghost" icon={<CalendarPlus className="h-4 w-4" />} onClick={() => onUse({ accounts: i.accounts.length === 1 ? i.accounts : [], title: i.title, platform: i.platform, type: i.format, headline: i.hook, caption: i.caption ?? '', cta: i.cta, hashtags: i.hashtags, pillar: i.pillar, ideaId: i.id })}>Add</Button>
            </li>
          ))}</ul>
        )}
      </section>}
      <section>
        <div className="mb-2 flex items-center gap-2"><h2 className="text-[15px] font-medium text-ink">Campaigns</h2><Button size="sm" variant="ghost" className="ml-auto" icon={<Plus className="h-4 w-4" />} onClick={() => setCampaign('new')}>New campaign</Button></div>
        {!b.campaigns.length ? <p className="text-[13px] text-stone">Group posts into campaigns (a launch, a promotion, a season) to plan and measure them together.</p> : (
          <ul className="panel divide-y divide-line">{b.campaigns.map((c) => (
            <li key={c.id}><button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left text-[13px] hover:bg-mist/40" onClick={() => setCampaign(c)}>
              <span className="min-w-0 flex-1 font-medium text-ink">{c.name}</span>{c.accounts.map((a) => <AccountTag key={a} a={b.accountOf(a)} small />)}
              <span className="text-stone">{[c.startsOn, c.endsOn].filter(Boolean).join(' – ') || 'No dates'}</span>
              {c.posts ? <Badge>{c.posts} post{c.posts === 1 ? '' : 's'}</Badge> : <Badge tone="amber">No posts yet</Badge>}
            </button></li>
          ))}</ul>
        )}
      </section>
      {campaign && <CampaignEditor c={campaign === 'new' ? null : campaign} b={b} onClose={() => setCampaign(null)} />}
    </div>
  );
}

function CampaignEditor({ c, b, onClose }: { c: ContentCampaignDTO | null; b: Basics; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [d, setD] = useState({ name: c?.name ?? '', accounts: c?.accounts ?? ([] as ContentAccountId[]), startsOn: c?.startsOn ?? '', endsOn: c?.endsOn ?? '', notes: c?.notes ?? '' });
  const done = () => { for (const k of ['content-campaigns', 'content-planning']) void qc.invalidateQueries({ queryKey: [k] }); onClose(); };
  const save = async () => { try { await api.post('/content/campaigns', { ...d, id: c?.id, startsOn: d.startsOn || null, endsOn: d.endsOn || null, notes: d.notes || null }); done(); } catch (e) { toast((e as Error).message, 'error'); } };
  const del = async () => { if (!c || !window.confirm(`Delete ${c.name}? Its posts stay, without a campaign.`)) return; await api.del(`/content/campaigns/${c.id}`); done(); };
  return (
    <Modal open wide onClose={onClose} title={c ? c.name : 'New campaign'} footer={<>{c && <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} className="mr-auto" onClick={del}>Delete</Button>}<Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!d.name.trim()} onClick={save}>Save</Button></>}>
      <div className="grid gap-3 text-[14px] sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2"><input className="field" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. Holiday 2026, Heat Shield launch" /></Field>
        <Field label="Accounts" className="sm:col-span-2"><div className="flex flex-wrap gap-3">{b.mine.map((a) => <label key={a.id} className="flex items-center gap-1.5"><input type="checkbox" className="h-4 w-4 accent-plum" checked={d.accounts.includes(a.id)} onChange={(e) => setD({ ...d, accounts: e.target.checked ? [...d.accounts, a.id] : d.accounts.filter((x) => x !== a.id) })} /><AccountTag a={a} /></label>)}</div></Field>
        <Field label="Starts"><input type="date" className="field" value={d.startsOn} onChange={(e) => setD({ ...d, startsOn: e.target.value })} /></Field>
        <Field label="Ends"><input type="date" className="field" value={d.endsOn} onChange={(e) => setD({ ...d, endsOn: e.target.value })} /></Field>
        <Field label="Notes" className="sm:col-span-2"><textarea className="field min-h-[70px]" value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
