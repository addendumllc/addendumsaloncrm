import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { InventorySyncLinkDTO, InventorySyncOverviewDTO, InventorySyncRunDTO } from '@addendum/shared';
import { AlertTriangle, ArrowLeftRight, CheckCircle2, CircleDashed, Link2, RefreshCw, RotateCcw, Unlink, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { ShopifySyncSwitch } from '../components/domain/ShopifySyncSwitch';
import { relative } from '../lib/format';
import { Badge, Button, EmptyState, ErrorNote, Field, Modal, PageHeader, PageLoading, Segmented, Toggle, cx, useToast } from '../components/ui';
import { NumberField } from './settings/shared';

const RESULT: Record<InventorySyncRunDTO['details'][number]['result'], { label: string; tone: 'sage' | 'neutral' | 'rose' | 'amber' | 'plum' }> = {
  updated_square: { label: 'Square updated', tone: 'sage' }, updated_shopify: { label: 'Shopify updated', tone: 'sage' }, updated_both: { label: 'Both updated', tone: 'sage' },
  unchanged: { label: 'No change', tone: 'neutral' }, failed: { label: 'Failed', tone: 'rose' }, attention: { label: 'Needs attention', tone: 'amber' }, retry: { label: 'Will retry', tone: 'plum' },
};

/** Square ↔ Shopify stock sync: products and quantities only. */
export function InventorySyncPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['inventory-sync'],
    queryFn: () => api.get<InventorySyncOverviewDTO>('/inventory-sync'),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : 30_000),
  });
  const [tab, setTab] = useState<'attention' | 'all' | 'unmatched' | 'last'>('attention');
  const [starting, setStarting] = useState(false);
  const [linking, setLinking] = useState(false);
  const run = data?.lastRun;
  useEffect(() => {
    if (data && !data.running) qc.invalidateQueries({ queryKey: ['inventory-sync-links'] });
  }, [data?.running, data?.lastRun?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (onlyFailed = false) => {
    setStarting(true);
    try {
      await api.post('/inventory-sync/run', { onlyFailed });
      await refetch();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setStarting(false);
    }
  };
  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;
  const bothConnected = data.square.connected && data.shopify.connected;

  return (
    <div>
      <PageHeader
        title="Inventory Sync"
        subtitle={<>Square ↔ Shopify · products and stock only{data.lastSuccessfulSyncAt ? ` · last successful sync ${relative(data.lastSuccessfulSyncAt)}` : ' · never synced'}</>}
        actions={<Button variant="primary" icon={<RefreshCw className={cx('h-4 w-4', data.running && 'animate-spin')} />} loading={starting} disabled={data.running || !bothConnected} onClick={() => start()}>{data.running ? 'Syncing…' : 'Sync Inventory'}</Button>}
      />
      {data.demoMode && <p className="mb-4 rounded-xl2 border border-line bg-mist/50 px-4 py-2 text-[13px] text-ink-soft">Demo Mode: this syncs the demo Square and Shopify catalogs. Nothing is sent to a real store.</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Connection name="Square" c={data.square} />
        <Connection name="Shopify" c={data.shopify} />
      </div>
      {!bothConnected && (
        <p className="mt-3 flex items-start gap-2 rounded-xl2 border border-amber/30 bg-amber/10 px-4 py-3 text-[14px] text-ink-soft">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
          <span>Both systems must be connected before syncing. Add the credentials in <Link className="text-plum underline" to="/settings?tab=api">Settings → API &amp; Integrations</Link> and use Test connection.</span>
        </p>
      )}

      {run && <RunPanel run={run} running={data.running} onRetry={() => start(true)} />}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {([['Linked products', data.counts.linked], ['In sync', data.counts.inSync], ['Need attention', data.counts.attention], ['Errors', data.counts.errors], ['Waiting', data.counts.pending], ['Sync off', data.counts.syncOff]] as const).map(([l, n]) => (
          <div key={l} className="rounded-xl2 border border-line bg-white px-3 py-2"><p className="text-[12px] text-stone">{l}</p><p className={cx('num font-display text-[24px] leading-tight', (l === 'Need attention' || l === 'Errors') && n > 0 && 'text-rose')}>{n}</p></div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <Segmented value={tab} onChange={setTab} options={[
          { value: 'attention', label: `Needs attention${data.counts.attention + data.counts.errors ? ` (${data.counts.attention + data.counts.errors})` : ''}` },
          { value: 'all', label: 'All linked' },
          { value: 'unmatched', label: `Not matched (${data.unmatched.squareOnly.length + data.unmatched.shopifyOnly.length})` },
          { value: 'last', label: 'Last run' },
        ]} />
        <Button size="sm" icon={<Link2 className="h-4 w-4" />} onClick={() => setLinking(true)}>Link by SKU</Button>
      </div>
      <div className="mt-4">
        {tab === 'attention' && <Links status="problems" />}
        {tab === 'all' && <Links />}
        {tab === 'unmatched' && <Unmatched u={data.unmatched} />}
        {tab === 'last' && (run ? <RunDetails run={run} /> : <p className="text-sm text-stone">No sync has run yet.</p>)}
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <section className="panel p-5">
          <h2 className="h-display flex items-center gap-2 text-[22px]"><ArrowLeftRight className="h-5 w-5" />How conflicts are handled</h2>
          <p className="mt-2 whitespace-pre-line text-[14px] text-ink-soft">{data.rule}</p>
        </section>
        <AutoSettings s={data.settings} />
      </div>
      {linking && <LinkModal onClose={() => setLinking(false)} />}
    </div>
  );
}

function Connection({ name, c }: { name: string; c: InventorySyncOverviewDTO['square'] }) {
  const Icon = c.connected ? (c.status === 'error' ? XCircle : CheckCircle2) : CircleDashed;
  return (
    <div className="rounded-xl2 border border-line bg-white px-4 py-3">
      <p className="flex items-center gap-2 font-medium text-ink"><Icon className={cx('h-5 w-5', c.connected ? (c.status === 'error' ? 'text-rose' : 'text-sage') : 'text-stone')} />{name}
        <Badge tone={!c.connected ? 'neutral' : c.status === 'error' ? 'rose' : c.status === 'connected' ? 'sage' : 'amber'}>{!c.connected ? 'Not connected' : c.status === 'error' ? 'Connection error' : c.status === 'connected' ? 'Connected' : 'Not tested yet'}</Badge>
      </p>
      {c.message && <p className="mt-1 text-[13px] text-stone">{c.message}</p>}
      {c.lastSuccessAt && <p className="mt-0.5 text-[12px] text-stone">Last worked {relative(c.lastSuccessAt)}</p>}
    </div>
  );
}

function RunPanel({ run, running, onRetry }: { run: InventorySyncRunDTO; running: boolean; onRetry: () => void }) {
  const pctDone = run.total ? Math.round((run.processed / run.total) * 100) : running ? 5 : 100;
  return (
    <div className={cx('mt-4 rounded-xl2 border px-4 py-3', run.status === 'failed' ? 'border-rose/30 bg-rose/5' : run.status === 'partial' ? 'border-amber/30 bg-amber/5' : 'border-line bg-white')}>
      <div className="flex flex-wrap items-center gap-2 text-[14px]">
        <span className="font-medium text-ink">{running ? 'Sync in progress' : run.status === 'ok' ? 'Last sync finished' : run.status === 'partial' ? 'Last sync finished with problems' : 'Last sync failed'}</span>
        <span className="text-stone">{relative(run.startedAt)}{run.startedBy ? ` · ${run.startedBy}` : ` · ${run.trigger}`}</span>
        {!running && run.failed > 0 && <Button size="sm" className="ml-auto" icon={<RotateCcw className="h-4 w-4" />} onClick={onRetry}>Retry failed</Button>}
      </div>
      {running && (
        <div className="mt-2">
          <div className="h-2 overflow-hidden rounded-full bg-mist"><div className="h-full rounded-full bg-plum transition-all" style={{ width: `${pctDone}%` }} /></div>
          <p className="mt-1 text-[12px] text-stone">{run.stage ?? 'Working…'} {run.total ? `· ${run.processed} of ${run.total}` : ''}</p>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        <span className="text-sage">{run.updatedSquare} Square updates</span>
        <span className="text-sage">{run.updatedShopify} Shopify updates</span>
        <span className="text-stone">{run.unchanged} unchanged</span>
        <span className={run.failed ? 'text-rose' : 'text-stone'}>{run.failed} failed</span>
        <span className={run.attention ? 'text-amber' : 'text-stone'}>{run.attention} need attention</span>
      </div>
      {run.message && <p className="mt-1 text-[13px] text-ink-soft">{run.message}</p>}
    </div>
  );
}

function RunDetails({ run }: { run: InventorySyncRunDTO }) {
  if (!run.details.length) return <p className="text-sm text-stone">No product changes in this run.</p>;
  return (
    <ul className="divide-y divide-line rounded-xl2 border border-line bg-white">
      {run.details.map((d, i) => (
        <li key={i} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[14px]">
          <span className="min-w-0 flex-1"><span className="text-ink">{d.label}</span>{d.sku && <span className="ml-2 font-mono text-[12px] text-stone">{d.sku}</span>}<span className="block text-[12px] text-stone">{d.note}</span></span>
          <Badge tone={RESULT[d.result].tone}>{RESULT[d.result].label}</Badge>
        </li>
      ))}
    </ul>
  );
}

function Links({ status }: { status?: 'problems' }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['inventory-sync-links', status ?? 'all'],
    queryFn: async () => {
      if (status !== 'problems') return (await api.get<{ links: InventorySyncLinkDTO[] }>('/inventory-sync/links')).links;
      const [a, b] = await Promise.all(['needs_attention', 'error'].map((s) => api.get<{ links: InventorySyncLinkDTO[] }>(`/inventory-sync/links?status=${s}`)));
      return [...a.links, ...b.links];
    },
  });
  const act = async (p: Promise<unknown>, msg: string) => {
    try {
      await p;
      toast(msg);
      qc.invalidateQueries({ queryKey: ['inventory-sync'] });
      qc.invalidateQueries({ queryKey: ['inventory-sync-links'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  if (isLoading) return <PageLoading />;
  if (!data?.length) return <div className="panel"><EmptyState icon={<CheckCircle2 className="h-9 w-9" />} title={status ? 'Nothing needs attention' : 'No linked products yet'}>{status ? 'Every linked product is in sync or waiting for the next run.' : 'Run a sync to pair products by SKU.'}</EmptyState></div>;
  return (
    <div className="overflow-x-auto rounded-xl2 border border-line bg-white">
      <table className="w-full min-w-[760px] text-left text-[14px]">
        <thead className="border-b border-line bg-mist/50 text-[12px] uppercase tracking-wide text-stone">
          <tr><th className="px-4 py-2 font-medium">Product</th><th className="px-3 py-2 text-right font-medium">Square</th><th className="px-3 py-2 text-right font-medium">Shopify</th><th className="px-3 py-2 text-right font-medium">Agreed</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Sync to Shopify</th><th /></tr>
        </thead>
        <tbody className="divide-y divide-line">
          {data.map((l) => (
            <tr key={l.id}>
              <td className="px-4 py-2.5"><span className="text-ink">{l.label}</span>{l.sku && <span className="ml-2 font-mono text-[12px] text-stone">{l.sku}</span>}{l.matchMethod === 'manual' && <Badge className="ml-1">Linked by hand</Badge>}
                {(l.issue || l.lastChange) && <span className={cx('block text-[12px]', l.issue ? 'text-rose' : 'text-stone')}>{l.issue ?? l.lastChange}</span>}</td>
              <td className="num px-3 py-2.5 text-right">{l.squareQuantity ?? '—'}</td>
              <td className="num px-3 py-2.5 text-right">{l.shopifyQuantity ?? '—'}</td>
              <td className="num px-3 py-2.5 text-right text-stone">{l.baselineQuantity ?? '—'}</td>
              <td className="px-3 py-2.5">{!l.shopifySyncEnabled ? <Badge>Square only</Badge> : <Badge tone={l.status === 'in_sync' ? 'sage' : l.status === 'needs_attention' ? 'amber' : l.status === 'error' ? 'rose' : 'neutral'}>{l.status === 'in_sync' ? 'In sync' : l.status === 'needs_attention' ? 'Needs attention' : l.status === 'error' ? 'Error' : 'Waiting'}</Badge>}</td>
              <td className="px-3 py-2.5"><ShopifySyncSwitch key={`${l.id}-${l.shopifySyncEnabled}`} variationId={l.squareVariationId} label={l.label} enabled={l.shopifySyncEnabled} canChange /></td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right">
                {l.shopifySyncEnabled && (l.status === 'needs_attention' || l.status === 'error') && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => act(api.post(`/inventory-sync/links/${l.id}/resolve`, { use: 'square' }), 'Shopify set to Square’s count')}>Use Square</Button>
                    <Button size="sm" variant="ghost" onClick={() => act(api.post(`/inventory-sync/links/${l.id}/resolve`, { use: 'shopify' }), 'Square set to Shopify’s count')}>Use Shopify</Button>
                  </>
                )}
                <Button size="sm" variant="ghost" aria-label="Unlink" icon={<Unlink className="h-4 w-4" />} onClick={() => act(api.del(`/inventory-sync/links/${l.id}`), 'Unlinked — it won’t be synced')} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Unmatched({ u }: { u: InventorySyncOverviewDTO['unmatched'] }) {
  const List = ({ title, items, hint }: { title: string; items: { label: string; sku: string | null }[]; hint: string }) => (
    <section className="panel p-4">
      <h3 className="font-medium text-ink">{title} <span className="num text-stone">{items.length}</span></h3>
      <p className="mb-2 text-[12px] text-stone">{hint}</p>
      <ul className="max-h-72 space-y-1 overflow-y-auto text-[13px]">{items.map((i, n) => <li key={n} className="flex justify-between gap-2"><span className="truncate">{i.label}</span><span className="font-mono text-stone">{i.sku ?? 'no SKU'}</span></li>)}</ul>
    </section>
  );
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-stone">These products exist in only one system (by SKU). Nothing is ever created automatically — add the product in the other system with the same SKU, or link two SKUs by hand.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <List title="Only in Square" items={u.squareOnly} hint="Not found in Shopify." />
        <List title="Only in Shopify" items={u.shopifyOnly} hint="Not found in Square." />
      </div>
      {(u.duplicates.length > 0 || u.noSku > 0) && (
        <p className="flex items-start gap-2 rounded-xl2 border border-amber/30 bg-amber/10 px-4 py-3 text-[13px] text-ink-soft"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
          {u.duplicates.length > 0 && <>Duplicate SKUs (skipped so nothing is overwritten): {u.duplicates.map((d) => `${d.sku} (${d.where} ×${d.count})`).join(', ')}. </>}
          {u.noSku > 0 && <>{u.noSku} product{u.noSku === 1 ? ' has' : 's have'} no SKU and can only be linked by hand.</>}
        </p>
      )}
    </div>
  );
}

function AutoSettings({ s }: { s: InventorySyncOverviewDTO['settings'] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [d, setD] = useState(s);
  const [saving, setSaving] = useState(false);
  useEffect(() => setD(s), [s]);
  const dirty = JSON.stringify(d) !== JSON.stringify(s);
  const save = async () => {
    setSaving(true);
    try {
      await api.patch('/settings', { inventorySync: d });
      toast('Saved');
      qc.invalidateQueries({ queryKey: ['inventory-sync'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="panel p-5">
      <h2 className="h-display text-[22px]">Automatic sync</h2>
      <div className="mt-3 space-y-4">
        <Toggle checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label="Sync automatically" description="On a schedule, and shortly after Square reports a stock change (webhook)." />
        <NumberField label="Every" unit="minutes" min={5} max={1440} value={d.intervalMinutes} onChange={(v) => setD({ ...d, intervalMinutes: v })} />
        <Field label="First time a product is paired and the counts differ, keep">
          <select className="field" value={d.firstSyncSource} onChange={(e) => setD({ ...d, firstSyncSource: e.target.value as any })}><option value="square">Square’s count</option><option value="shopify">Shopify’s count</option></select>
        </Field>
        <NumberField label="Hold changes bigger than" unit="units for review (0 = no limit)" min={0} max={10000} value={d.holdChangesOver} onChange={(v) => setD({ ...d, holdChangesOver: v })} />
        <Button variant="primary" disabled={!dirty} loading={saving} onClick={save}>Save</Button>
      </div>
    </section>
  );
}

function LinkModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [sq, setSq] = useState('');
  const [sh, setSh] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.post('/inventory-sync/links', { squareSku: sq, shopifySku: sh });
      toast('Linked. The next sync keeps them matched.');
      qc.invalidateQueries({ queryKey: ['inventory-sync'] });
      qc.invalidateQueries({ queryKey: ['inventory-sync-links'] });
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Link two products by SKU" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Link</Button></>}>
      <p className="mb-3 text-[14px] text-ink-soft">For the same product with different SKUs in Square and Shopify. Each product can only be linked once, so nothing is duplicated.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Square SKU"><input className="field font-mono" value={sq} onChange={(e) => setSq(e.target.value)} /></Field>
        <Field label="Shopify SKU"><input className="field font-mono" value={sh} onChange={(e) => setSh(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
