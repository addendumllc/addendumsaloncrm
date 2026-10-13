import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Users } from 'lucide-react';
import { useClients, useStaff, useTags } from '../api/hooks';
import { dateShort, phone, relative } from '../lib/format';
import { Avatar, Badge, Button, EmptyState, ErrorNote, PageHeader, PageLoading } from '../components/ui';
import { useActions } from '../components/domain/ActionsProvider';

const LAST_VISIT: Record<string, { label: string; days?: number; dir?: 'before' | 'after' }> = {
  '': { label: 'Any last visit' },
  '30': { label: 'Visited in last 30 days', days: 30, dir: 'after' },
  '42+': { label: 'No visit in 6+ weeks', days: 42, dir: 'before' },
  '90+': { label: 'No visit in 3+ months', days: 90, dir: 'before' },
};

export function ClientsPage() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { addClient } = useActions();
  const { data: staff } = useStaff();
  const { data: tags } = useTags();
  const f = {
    q: params.get('q') ?? '', tag: params.get('tag') ?? '', staffId: params.get('staff') ?? '', service: params.get('service') ?? '',
    last: params.get('last') ?? '', next: params.get('next') ?? '', archived: params.get('archived') ?? '',
  };
  const lv = LAST_VISIT[f.last] ?? LAST_VISIT[''];
  const cutoff = lv.days ? new Date(Date.now() - lv.days * 86400_000).toISOString() : undefined;
  const { data, isLoading, error, refetch } = useClients({
    q: f.q || undefined, tag: f.tag || undefined, staffId: f.staffId || undefined, service: f.service || undefined,
    lastBefore: lv.dir === 'before' ? cutoff : undefined, lastAfter: lv.dir === 'after' ? cutoff : undefined,
    hasNext: f.next || undefined, archived: f.archived || undefined, limit: '200',
  });
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    setParams(p, { replace: true });
  };

  return (
    <div>
      <PageHeader title="Clients" subtitle={data ? `${data.total} client${data.total === 1 ? '' : 's'}` : undefined} actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={addClient}>Add client</Button>} />
      <div className="mb-5 flex flex-wrap gap-2">
        <input className="field h-9 w-full py-1 text-sm sm:w-64" placeholder="Name, phone or email" value={f.q} onChange={(e) => set('q', e.target.value)} />
        <select className="field h-9 w-auto py-1 text-sm" value={f.tag} onChange={(e) => set('tag', e.target.value)} aria-label="Tag">
          <option value="">All tags</option>{tags?.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
        </select>
        <select className="field h-9 w-auto py-1 text-sm" value={f.staffId} onChange={(e) => set('staff', e.target.value)} aria-label="Stylist">
          <option value="">Any stylist</option>{staff?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input className="field h-9 w-40 py-1 text-sm" placeholder="Service" value={f.service} onChange={(e) => set('service', e.target.value)} />
        <select className="field h-9 w-auto py-1 text-sm" value={f.last} onChange={(e) => set('last', e.target.value)} aria-label="Last visit">
          {Object.entries(LAST_VISIT).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select className="field h-9 w-auto py-1 text-sm" value={f.next} onChange={(e) => set('next', e.target.value)} aria-label="Next appointment">
          <option value="">Any next appointment</option><option value="yes">Has next appointment</option><option value="no">Nothing booked</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-stone"><input type="checkbox" className="accent-plum" checked={f.archived === 'true'} onChange={(e) => set('archived', e.target.checked ? 'true' : '')} />Archived</label>
      </div>

      {isLoading && <PageLoading />}
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {data?.clients.length === 0 && <div className="panel"><EmptyState icon={<Users className="h-9 w-9" />} title="No clients found">Clients appear automatically when they book in Square.</EmptyState></div>}
      {!!data?.clients.length && (
        <div className="overflow-hidden rounded-xl2 border border-line bg-white">
          <div className="hidden grid-cols-[1.6fr_1fr_1fr_1fr_1.2fr] gap-4 border-b border-line px-5 py-2.5 text-xs text-stone md:grid">
            <span>Client</span><span>Last visit</span><span>Next appointment</span><span>Stylist</span><span>Tags</span>
          </div>
          <ul className="divide-y divide-line">
            {data.clients.map((c) => (
              <li key={c.id}>
                <button onClick={() => nav(`/clients/${c.id}`)} className="grid w-full grid-cols-1 gap-1 px-4 py-3 text-left hover:bg-mist/50 md:grid-cols-[1.6fr_1fr_1fr_1fr_1.2fr] md:items-center md:gap-4 md:px-5">
                  <span className="flex min-w-0 items-center gap-3">
                    <Avatar name={c.name} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{c.name}</span>
                      <span className="block truncate text-[13px] text-stone">{phone(c.phone) || c.email || 'No contact info'}</span>
                    </span>
                  </span>
                  <span className="text-sm text-ink-soft"><span className="md:hidden text-stone">Last visit: </span>{c.lastAppointmentAt ? <>{dateShort(c.lastAppointmentAt)} <span className="text-stone">· {relative(c.lastAppointmentAt)}</span></> : '—'}</span>
                  <span className="text-sm">{c.nextAppointmentAt ? <span className="text-sage">{dateShort(c.nextAppointmentAt)}</span> : <span className="text-stone-light">Not booked</span>}</span>
                  <span className="hidden text-sm text-ink-soft md:block">{c.preferredStaffName ?? '—'}</span>
                  <span className="flex flex-wrap gap-1">{c.tags.slice(0, 3).map((t) => <Badge key={t} tone={t === 'VIP' ? 'plum' : t === 'At Risk' ? 'rose' : 'neutral'}>{t}</Badge>)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
