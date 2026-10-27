import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { api } from '../../api/client';
import { useReauth } from '../../components/domain/Reauth';
import { Badge, Button, useToast } from '../../components/ui';
import { Card } from './shared';

type Preview = { from: string; to: string; total: number; toCreate: number; toTag: number; alreadyThere: number; subscribed: number; skipped: string[]; sample: { name: string; action: 'add' | 'tags'; tags: string[] }[] };
type Job = { state: 'running' | 'done' | 'failed'; startedAt: string; finishedAt: string | null; total: number; created: number; tagged: number; failed: { name: string; message: string }[]; message: string | null };

/**
 * One-time: copy the Pro store's customers into Addendum Hair with their tags (consent as it was; existing customers
 * only get missing tags; the Pro store doesn't change). Preview first, then copy — progress shows while it runs.
 */
export function CustomerCopyCard() {
  const toast = useToast();
  const reauth = useReauth();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: job, refetch } = useQuery({ queryKey: ['customer-copy-status'], queryFn: () => api.get<{ job: Job | null }>('/integrations/customer-copy/status').then((r) => r.job),
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 2000 : false) });
  const look = async () => {
    setBusy(true);
    try { setPreview(await api.get<Preview>('/integrations/customer-copy/preview')); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const start = async () => {
    if (!preview || !window.confirm(`Add ${preview.toCreate} customers to ${preview.to} and add missing tags to ${preview.toTag}? The Pro store doesn’t change.`)) return;
    try { await api.post('/integrations/customer-copy/start'); void refetch(); setPreview(null); }
    catch (e) { if (reauth.handle(e, start)) return; toast((e as Error).message, 'error'); }
  };
  const running = job?.state === 'running';
  return (
    <Card title="Copy Pro customers to Addendum Hair" description="One-time: adds the professional store’s customers to the Addendum Hair store with their tags. Email-marketing consent comes across exactly as it was; customers already there (same email) only get the tags they’re missing; nothing in the Pro store changes.">
      {reauth.modal}
      <div className="space-y-3 text-[14px]">
        {job && (
          <div className="rounded-lg border border-line px-3 py-2 text-[13px]">
            <Badge tone={job.state === 'done' ? 'sage' : job.state === 'failed' ? 'rose' : 'plum'}>{job.state === 'running' ? 'Copying…' : job.state === 'done' ? 'Done' : 'Stopped'}</Badge>
            <span className="ml-2 text-ink-soft">{job.created} added · {job.tagged} tagged{job.total ? ` of ${job.total}` : ''}{job.failed.length ? ` · ${job.failed.length} didn’t go through` : ''}</span>
            {job.message && <p className="mt-1 text-rose">{job.message}</p>}
            {job.failed.length > 0 && <details className="mt-1"><summary className="cursor-pointer text-plum">What didn’t go through</summary><ul className="mt-1 list-disc pl-5 text-ink-soft">{job.failed.slice(0, 50).map((f, i) => <li key={i}>{f.name}: {f.message}</li>)}</ul></details>}
          </div>
        )}
        {!preview ? (
          <Button icon={<Users className="h-4 w-4" />} loading={busy} disabled={running} onClick={look}>Preview</Button>
        ) : (
          <div className="space-y-2 rounded-lg border border-line bg-mist/30 p-3 text-[13px]">
            <p className="text-ink"><b className="font-medium">{preview.total}</b> customers in {preview.from}: <b className="font-medium">{preview.toCreate}</b> to add to {preview.to} ({preview.subscribed} of them subscribed to emails), <b className="font-medium">{preview.toTag}</b> already there needing tags, {preview.alreadyThere} already there with their tags.</p>
            {preview.skipped.length > 0 && <p className="text-stone">{preview.skipped.length} skipped (no email or phone).</p>}
            {preview.sample.length > 0 && <ul className="list-disc pl-5 text-ink-soft">{preview.sample.map((s, i) => <li key={i}>{s.name} — {s.action === 'add' ? 'add' : 'add tags'}{s.tags.length ? `: ${s.tags.join(', ')}` : ''}</li>)}</ul>}
            <div className="flex gap-2"><Button variant="primary" disabled={!preview.toCreate && !preview.toTag} onClick={start}>Copy {preview.toCreate + preview.toTag}</Button><Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button></div>
          </div>
        )}
        <p className="text-[12px] text-stone">Needs the Shopify apps to have read_customers (Pro store) and write_customers (Addendum Hair) — add them in each app’s settings in the Shopify Dev Dashboard, release, and approve the update in the store.</p>
      </div>
    </Card>
  );
}
