import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useCanDo } from '../../api/hooks';
import { relative } from '../../lib/format';
import { Badge, EmptyState, ErrorNote, PageLoading, useToast } from '../ui';
import { ReviewItem, STATUS, type Item } from '../../pages/settings/WebsiteInquiries';

/**
 * Follow-Ups → Website inquiries: Showit form submissions — those needing review first (file or ignore), then every
 * submission with its client. The mailbox and routing are set up in Settings → Website Inquiries.
 */
export function WebsiteInquiriesList() {
  const toast = useToast();
  const qc = useQueryClient();
  const canFile = useCanDo()('leads:write');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['website-inquiries'], queryFn: () => api.get<{ connected: boolean; needsReconnect?: boolean; lastRun: { at: string; ok: boolean; message: string } | null; history: Item[] }>('/leads/website-inquiries') });
  const [open, setOpen] = useState<string | null>(null);
  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;
  const resolve = async (it: Item, action: 'extension' | 'general' | 'ignore', contact: { name?: string; email?: string; phone?: string } = {}) => {
    try {
      await api.post(`/leads/website-inquiries/${encodeURIComponent(it.gmailId)}/resolve`, { action, ...contact });
      toast(action === 'ignore' ? 'Ignored' : 'Filed as a new-client inquiry');
      for (const k of ['website-inquiries', 'showit', 'tasks', 'leads']) void qc.invalidateQueries({ queryKey: [k] });
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const review = data.history.filter((h) => h.status === 'review' || h.status === 'failed');
  const filed = data.history.filter((h) => !(h.status === 'review' || h.status === 'failed'));
  return (
    <div className="space-y-6">
      {!data.connected && <p className="text-[13px] text-amber">{data.needsReconnect ? 'Google stopped accepting the website inbox connection — new submissions aren’t coming in. An administrator needs to connect it again in Settings → Website Inquiries.' : 'The website inbox isn’t connected — new submissions aren’t coming in. An administrator can connect it in Settings → Website Inquiries.'}</p>}
      {data.lastRun && <p className={data.lastRun.ok ? 'text-[12px] text-stone' : 'text-[12px] text-rose'}>Last checked {relative(data.lastRun.at)}: {data.lastRun.message}</p>}
      {review.length > 0 && (
        <section>
          <h2 className="mb-2 text-[15px] font-medium text-ink">Needs review <span className="num text-stone">{review.length}</span></h2>
          <ul className="space-y-2">{review.map((it) => canFile ? <ReviewItem key={it.gmailId} it={it} onResolve={resolve} /> : (
            <li key={it.gmailId} className="rounded-lg border border-line p-3 text-[13px]"><Badge tone={STATUS[it.status].tone}>{STATUS[it.status].label}</Badge> <span className="text-ink">{it.contact.name ?? it.subject ?? '(no name)'}</span> <span className="text-stone">{relative(it.receivedAt)}</span></li>
          ))}</ul>
        </section>
      )}
      <section>
        <h2 className="mb-2 text-[15px] font-medium text-ink">Submissions <span className="num text-stone">{filed.length}</span></h2>
        {!filed.length ? <div className="panel"><EmptyState title="No website inquiries yet">Forms sent from the website show here as they arrive, each with a follow-up.</EmptyState></div> : (
          <ul className="panel divide-y divide-line text-[13px]">
            {filed.map((h) => (
              <li key={h.gmailId} className="px-4 py-2.5">
                <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left" onClick={() => setOpen(open === h.gmailId ? null : h.gmailId)}>
                  <Badge tone={STATUS[h.status].tone}>{STATUS[h.status].label}</Badge>
                  <span className="font-medium text-ink">{h.contact.name ?? '(no name)'}</span>
                  {h.kind && <span className="text-stone">{h.kind === 'extension' ? 'Extension consultation' : 'General inquiry'}</span>}
                  <span className="ml-auto text-stone">{relative(h.receivedAt)}</span>
                </button>
                {open === h.gmailId && (
                  <div className="mt-2 space-y-1.5 text-[12px]">
                    <p className="text-stone">{[h.contact.email, h.contact.phone, h.contact.instagram, h.page].filter(Boolean).join(' · ')}</p>
                    <dl className="grid gap-x-3 sm:grid-cols-[minmax(0,14rem)_1fr]">
                      {h.fields.filter((f) => !/^(name|e-?mail|phone)/i.test(f.label)).map((f, i) => <div key={i} className="contents"><dt className="truncate text-stone">{f.label}</dt><dd className="whitespace-pre-line text-ink">{f.value}</dd></div>)}
                    </dl>
                    {h.leadId && <Link className="text-plum hover:underline" to={`/leads?open=${h.leadId}`}>Open {h.leadName ?? 'the client'}</Link>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
