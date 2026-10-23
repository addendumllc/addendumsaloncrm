import { useState, type ReactNode } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ListTodo, Trash2 } from 'lucide-react';
import { TASK_BUSINESS_LABELS, TASK_TYPE_LABELS, type HairTaskDTO, type InventorySyncOverviewDTO, type PurchaseOrderDTO, type StockForecastResponse, type TaskBusiness } from '@addendum/shared';
import { useIntegrations, useInventory, useMe, useRefreshAll, useStaff, useTasks } from '../api/hooks';
import { dayKey } from '../lib/format';
import { api } from '../api/client';
import { Button, EmptyState, ErrorNote, Field, Modal, PageHeader, PageLoading, PageTabs, Segmented, Toggle, cx, useToast } from '../components/ui';
import { TaskCard } from '../components/domain/TaskCard';
import { useActions } from '../components/domain/ActionsProvider';
import { useAccessStatus } from '../components/layout/NetworkBlocked';
import { SectionPicker } from '../components/layout/subNav';
import { useStoreNames } from '../lib/storeNames';
import { HairTasks } from './HairCrm';
import { pageBusiness, useWorkspace } from '../lib/workspace';
import { LeadsPage } from './Leads';

type Preset = { kind?: 'follow_up' | 'task'; business?: TaskBusiness; status?: string; mine?: boolean; since?: string; title: string; subtitle?: string };

/**
 * Tasks (side menu): All Tasks (a dashboard: your to-dos, everyone's, and optionally what the stores need) · To Do
 * (open or done) · Follow Ups. Every page starts with Addendum Salon / Addendum Hair: internal to-dos can be for either
 * (Addendum Hair is the main company), so everyone with tasks can switch; Addendum Hair's client tasks and store work
 * show only to people with those permissions.
 */
export function TasksPage() {
  const [params, setParams] = useSearchParams();
  const { data: me } = useMe();
  const names = useStoreNames();
  const ws = useWorkspace();
  const can = (p: string) => !!me?.permissions.includes(p) || !!me?.permissions.includes('*');
  const seesTasks = can('tasks:read_all') || can('tasks:read_own');
  const seesHair = can('hair:manage');
  // Older links.
  const legacy = params.get('hair');
  const oldView = params.get('view');
  const oldBiz = params.get('business');
  if (legacy || oldView === 'done' || oldView === 'mine' || oldBiz) {
    const forHair = legacy ? legacy !== 'clients' : (oldBiz ?? params.get('for')) === 'hair';
    const to = legacy === 'clients' ? `/clients?business=hair${params.get('client') ? `&client=${params.get('client')}` : ''}`
      : legacy === 'waiting' || oldView === 'followups' ? `/tasks?view=followups${forHair ? '&for=hair' : ''}`
      : legacy === 'done' || oldView === 'done' ? `/tasks?view=todo&show=done${forHair ? '&for=hair' : ''}`
      : oldView === 'mine' ? `/tasks${forHair ? '?for=hair' : ''}`
      : `/tasks?view=todo${forHair ? '&for=hair' : ''}`;
    return <Navigate to={to} replace />;
  }
  if (!me) return <PageLoading />;
  // The full, filterable list is part of All tasks (?filters=1).
  const view = params.get('filters') === '1' ? 'list' : (['todo', 'followups'] as const).find((v) => v === params.get('view')) ?? 'all';
  // Follow-ups for Addendum Hair are its client tasks waiting on a reply: only with Addendum Hair access.
  const hairAllowed = view === 'followups' ? seesHair : seesTasks || seesHair;
  // The page's own choice (?for=), else the business workspace they're in.
  const forB: TaskBusiness = hairAllowed && (pageBusiness(params, 'for', ws.current?.id ?? 'salon') === 'hair' || (!seesTasks && seesHair)) ? 'hair' : 'salon';
  const setParam = (k: string, v: string | null) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const showPicker = view !== 'list' && hairAllowed && (seesTasks || view !== 'todo');
  const switcher = showPicker && (
    <Segmented size="sm" value={forB} onChange={(b) => setParam('for', b)}
      options={[{ value: 'salon', label: TASK_BUSINESS_LABELS.salon }, { value: 'hair', label: TASK_BUSINESS_LABELS.hair }]} />
  );
  // Follow-ups puts the switch in its tab bar; the other pages show it on its own, top right.
  const picker = view !== 'followups' && switcher && <div className="mb-4 flex justify-end">{switcher}</div>;
  const label = TASK_BUSINESS_LABELS[forB];
  let body: ReactNode;
  if (view === 'list') {
    body = <TaskList />;
  } else if (view === 'todo') {
    const done = params.get('show') === 'done';
    body = <>
      <Segmented className="mb-4" value={done ? 'done' : 'open'} onChange={(v) => setParam('show', v === 'done' ? 'done' : null)} options={[{ value: 'open', label: 'To do' }, { value: 'done', label: 'Done' }]} />
      {done && <RetentionNote />}
      {forB === 'hair' && seesHair && <HairTasks status={done ? 'done' : 'open'} title={`${done ? 'Done' : 'To do'} · ${label} clients`} />}
      {seesTasks && (forB === 'hair' && seesHair
        ? <TaskList section preset={{ kind: 'task', business: 'hair', status: done ? 'completed' : 'open', title: done ? 'Finished internal to-dos' : 'Internal to-dos' }} />
        : <TaskList preset={{ kind: 'task', business: forB, status: done ? 'completed' : 'open', title: `${done ? 'Done' : 'To do'} · ${label}`, subtitle: done ? 'Finished internal to-dos.' : `Internal to-dos for ${label}.` }} />)}
    </>;
  } else if (view === 'followups') {
    const tab = params.get('tab') === 'new' && can('leads:read') ? 'new' : 'followups';
    // Done: follow-ups finished in the last 6 months.
    const done = params.get('show') === 'done';
    const since = (() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return dayKey(d); })();
    const openDone = (
      <Segmented value={done ? 'done' : 'open'} onChange={(v) => setParam('show', v === 'done' ? 'done' : null)}
        options={[{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done (last 6 months)' }]} />
    );
    const tabs = [{ value: 'followups' as const, label: 'Follow-ups' }, ...(forB === 'salon' && can('leads:read') ? [{ value: 'new' as const, label: 'New client inquiries' }] : [])];
    const bar = <PageTabs value={forB === 'hair' ? 'followups' : tab} onChange={(t) => setParam('tab', t === 'new' ? 'new' : null)} options={tabs} aside={switcher} />;
    body = forB === 'hair'
      ? <>
        {bar}
        <div className="mb-4">{openDone}</div>
        <HairTasks status={done ? 'done' : 'waiting'} since={done ? since : undefined} title={done ? 'Done follow-ups · Addendum Hair' : 'Follow-ups · Addendum Hair'} />
      </>
      : <>
        {bar}
        {tab === 'followups' && <div className="mb-4">{openDone}</div>}
        {tab === 'new' ? <LeadsPage embedded /> : seesTasks && (done
          ? <TaskList preset={{ kind: 'follow_up', status: 'completed', since, title: 'Done follow-ups · Addendum Salon', subtitle: 'Follow-ups completed in the last 6 months.' }} />
          : <TaskList preset={{ kind: 'follow_up', title: 'Follow-ups · Addendum Salon', subtitle: 'Client and new-client follow-ups.' }} />)}
      </>;
  } else {
    body = <TasksDashboard business={forB} seesTasks={seesTasks} seesHair={seesHair} can={can} />;
  }
  return <>
    {picker}
    <SectionPicker path="/tasks" names={names} can={can} className="mb-4" />
    {body}
  </>;
}

/**
 * All Tasks: a dashboard for the chosen business — your to-do list, everyone's open to-dos, and (switch on) what the
 * stores need: products to reorder, purchase orders, sync problems, hair orders and Addendum Hair client tasks.
 */
function TasksDashboard({ business, seesTasks, seesHair, can }: { business: TaskBusiness; seesTasks: boolean; seesHair: boolean; can: (p: string) => boolean }) {
  const { newFollowUp } = useActions();
  const label = TASK_BUSINESS_LABELS[business];
  const storeAccess = can('inventory:sync') || can('inventory:read_all') || can('inventory:manage') || (business === 'hair' && seesHair);
  const [showStores, setShowStores] = useState(() => { try { return localStorage.getItem('tasks-show-stores') === '1'; } catch { return false; } });
  const toggleStores = (v: boolean) => { setShowStores(v); try { localStorage.setItem('tasks-show-stores', v ? '1' : '0'); } catch { /* private window */ } };
  return (
    <div>
      <PageHeader
        title={`Tasks · ${label}`}
        subtitle={<>Your to-do list first, then everyone’s. <Link to="/tasks?filters=1" className="text-plum hover:underline">Search and filter every task</Link></>}
        actions={seesTasks && <>
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => newFollowUp({ internal: true, business })}>Internal task</Button>
          {business === 'salon' && <Button icon={<Plus className="h-4 w-4" />} onClick={() => newFollowUp()}>Follow-up</Button>}
        </>}
      />
      {storeAccess && (
        <div className="mb-2 flex justify-end">
          <Toggle checked={showStores} onChange={toggleStores} label="Show what the stores need" />
        </div>
      )}
      {showStores && storeAccess && <StoreTasks business={business} can={can} seesHair={seesHair} />}
      {seesTasks && <TaskList section first preset={{ business, mine: true, kind: business === 'hair' ? 'task' : undefined, status: 'open', title: 'My to-do list' }} />}
      {business === 'hair' && seesHair && <HairTasks section status="active" mine title="My Addendum Hair client tasks" />}
      {seesTasks && <TaskList section preset={{ kind: 'task', business, status: 'open', title: `Everyone’s to-dos · ${label}` }} />}
      {business === 'hair' && seesHair && <HairTasks section status="active" title="Addendum Hair client tasks" />}
    </div>
  );
}

/** What the stores need (All Tasks → switch): only the parts this person may see. */
function StoreTasks({ business, can, seesHair }: { business: TaskBusiness; can: (p: string) => boolean; seesHair: boolean }) {
  const sync = can('inventory:sync');
  const orders = can('inventory:read_all') || can('inventory:manage');
  const store = business === 'hair' ? 'shopify' : 'salon';
  const forecast = useQuery({ queryKey: ['stock-forecast'], enabled: sync, queryFn: () => api.get<StockForecastResponse>('/inventory-sync/stock/forecast') });
  const pos = useQuery({ queryKey: ['purchase-orders'], enabled: sync, queryFn: () => api.get<{ orders: PurchaseOrderDTO[] }>('/inventory-sync/stock/purchase-orders').then((r) => r.orders) });
  const overview = useQuery({ queryKey: ['inventory-sync'], enabled: sync, queryFn: () => api.get<InventorySyncOverviewDTO>('/inventory-sync') });
  const hairOrders = useInventory({ status: 'submitted' }, orders && business === 'hair');
  const hairTasks = useQuery({ queryKey: ['hair', 'tasks', 'active', false, ''], enabled: seesHair && business === 'hair', queryFn: () => api.get<{ tasks: HairTaskDTO[] }>('/hair/tasks?status=active').then((r) => r.tasks) });
  const today = dayKey(new Date());
  const tiles: { label: string; n: number | undefined; sub: string; to: string; warn?: boolean }[] = [];
  if (sync) {
    const reorder = forecast.data?.items.filter((i) => i.stores?.[store === 'shopify' ? 'online' : 'salon'] && (i.status === 'out' || i.status === 'order_now')).length;
    const open = pos.data?.filter((o) => o.store === store && ['draft', 'ordered', 'shipped'].includes(o.status));
    tiles.push({ label: 'To order', n: reorder, sub: 'out of stock or order now', to: `/inventory-sync?view=toorder${store === 'shopify' ? '&for=hair' : ''}`, warn: !!reorder });
    tiles.push({ label: business === 'hair' ? 'Shopify purchase orders' : 'Square purchase orders', n: open?.length, sub: open?.some((o) => o.expectedOn && o.expectedOn <= today) ? 'some due to arrive' : 'open', to: `/inventory-sync?view=orders${store === 'shopify' ? '&for=hair' : ''}` });
    const att = overview.data ? overview.data.counts.attention + overview.data.counts.errors : undefined;
    tiles.push({ label: 'Sync needs attention', n: att, sub: 'Square ↔ Shopify', to: '/inventory-sync?view=sync', warn: !!att });
  }
  if (orders && business === 'hair') tiles.push({ label: 'Hair orders to send', n: hairOrders.data?.requests.length, sub: 'submitted by stylists', to: '/inventory' });
  if (seesHair && business === 'hair') {
    const overdue = hairTasks.data?.filter((t) => t.dueOn && t.dueOn < today).length ?? 0;
    tiles.push({ label: 'Client tasks', n: hairTasks.data?.length, sub: overdue ? `${overdue} overdue` : 'open', to: '/tasks?view=todo&for=hair', warn: overdue > 0 });
  }
  if (!tiles.length) return null;
  return (
    <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl2 border border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((t) => (
        <Link key={t.label} to={t.to} className="bg-white px-4 py-3 hover:bg-plum-tint/30">
          <span className="block text-[13px] text-stone">{t.label}</span>
          <span className={cx('num block font-display text-[30px] leading-tight', t.warn ? 'text-rose' : 'text-ink')}>{t.n ?? '–'}</span>
          <span className="block text-[12px] text-stone">{t.sub}</span>
        </Link>
      ))}
    </div>
  );
}

/** Tasks → Done: finished internal tasks are deleted after 6, 9 or 12 months (client follow-ups are kept). */
function RetentionNote() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const canSet = !!me?.permissions.includes('tasks:delete') || !!me?.permissions.includes('*');
  const { data } = useQuery({ queryKey: ['task-retention'], queryFn: () => api.get<{ months: 6 | 9 | 12 | null; lastRemoved: number }>('/tasks/retention') });
  if (!data) return null;
  const save = async (v: string) => {
    try {
      const r = await api.put<{ removed: number }>('/tasks/retention', { months: v ? Number(v) : null });
      qc.invalidateQueries({ queryKey: ['task-retention'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      toast(r.removed ? `Saved · ${r.removed} old finished task${r.removed === 1 ? '' : 's'} deleted` : 'Saved');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl2 border border-line bg-white px-4 py-3 text-[13px] text-ink-soft">
      <span>Finished internal tasks are deleted after</span>
      {canSet ? (
        <select className="field h-8 w-auto py-0 text-[13px]" value={data.months ?? ''} onChange={(e) => save(e.target.value)} aria-label="Delete finished internal tasks after">
          <option value="6">6 months</option><option value="9">9 months</option><option value="12">12 months</option><option value="">Never</option>
        </select>
      ) : <strong className="text-ink">{data.months ? `${data.months} months` : 'never'}</strong>}
      <span className="text-stone">Client follow-ups are kept.</span>
    </div>
  );
}

function TaskList({ preset, section, first }: { preset?: Preset; section?: boolean; first?: boolean } = {}) {
  const [params, setParams] = useSearchParams();
  const { data: me } = useMe();
  const { data: staff } = useStaff();
  const { data: integ } = useIntegrations();
  const { newFollowUp } = useActions();
  // Away from the salon (Location & Access): internal tasks only — client follow-ups stay at the salon.
  const { data: access } = useAccessStatus();
  const away = !!access?.limited;
  // A preset (a side-menu section) fixes some filters; the rest are on the page (?status=, ?type=… — not in sections).
  const own = section ? new URLSearchParams() : params;
  const f = {
    kind: away ? 'task' : preset ? preset.kind ?? '' : own.get('kind') ?? '',
    business: preset?.business ?? own.get('biz') ?? '',
    status: preset?.status ?? own.get('status') ?? 'open',
    type: own.get('type') ?? '',
    priority: own.get('priority') ?? '',
    staffId: preset?.mine ? '' : own.get('staff') ?? '',
    hl: own.get('hl') ?? '',
    q: own.get('q') ?? '',
  };
  const { data: tasks, isLoading, error, refetch } = useTasks({
    kind: f.kind || undefined, business: f.business || undefined, status: f.status, type: f.type || undefined, priority: f.priority || undefined,
    staffId: f.staffId || undefined, hl: f.hl || undefined, q: f.q || undefined, mine: preset?.mine ? '1' : undefined, since: preset?.since,
  });
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    setParams(p, { replace: true });
  };
  const canSeeAll = me?.permissions.includes('*') || me?.permissions.includes('tasks:read_all');
  const canDelete = !!me?.permissions.includes('tasks:delete');
  const [clearing, setClearing] = useState(false);

  return (
    <div>
      {section ? (
        <div className={cx('mb-3', first ? 'mt-2' : 'mt-8')}><h2 className="h-display text-xl">{preset?.title}</h2>{tasks && <p className="text-[13px] text-stone">{tasks.length} {f.status === 'completed' ? 'finished' : 'to do'}</p>}</div>
      ) : (
      <PageHeader
        title={preset?.title ?? (f.kind === 'task' ? (f.business ? `${TASK_BUSINESS_LABELS[f.business as TaskBusiness]} internal tasks` : 'Internal tasks') : 'All tasks')}
        subtitle={away ? 'Internal to-dos. Client follow-ups are available at the salon.' : preset ? preset.subtitle : 'Every follow-up plus internal to-dos for Addendum Salon and Addendum Hair.'}
        actions={<>
          {canDelete && !away && (!preset || f.status === 'completed') && <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setClearing(true)}>Clear finished</Button>}
          {preset?.kind !== 'follow_up' && <Button variant={away || preset?.kind === 'task' ? 'primary' : 'secondary'} icon={<Plus className="h-4 w-4" />} onClick={() => newFollowUp({ internal: true, business: f.business === 'hair' ? 'hair' : 'salon' })}>Internal task</Button>}
          {!away && preset?.kind !== 'task' && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => newFollowUp()}>Follow-up</Button>}
        </>}
      />
      )}
      {clearing && <ClearFinished onClose={() => setClearing(false)} />}
      {!preset && <div className="mb-5 flex flex-wrap items-center gap-2">
        {!away && <Segmented value={f.kind || 'all'} onChange={(v) => { const p = new URLSearchParams(params); if (v === 'all') p.delete('kind'); else p.set('kind', v); if (v !== 'task') p.delete('biz'); setParams(p, { replace: true }); }} options={[{ value: 'all', label: 'All' }, { value: 'follow_up', label: 'Follow-ups' }, { value: 'task', label: 'Internal' }]} />}
        {f.kind === 'task' && (
          <select className="field h-9 w-auto py-1 text-sm" value={f.business} onChange={(e) => set('biz', e.target.value)} aria-label="For">
            <option value="">Salon and Hair</option><option value="salon">Addendum Salon</option><option value="hair">Addendum Hair</option>
          </select>
        )}
        <select className="field h-9 w-auto py-1 text-sm" value={f.status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="open">Due</option><option value="snoozed">Snoozed</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="any">Any status</option>
        </select>
        <select className="field h-9 w-auto py-1 text-sm" value={f.type} onChange={(e) => set('type', e.target.value)} aria-label="Type">
          <option value="">All types</option>{Object.entries(TASK_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="field h-9 w-auto py-1 text-sm" value={f.priority} onChange={(e) => set('priority', e.target.value)} aria-label="Priority">
          <option value="">Any priority</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
        </select>
        {canSeeAll && (
          <select className="field h-9 w-auto py-1 text-sm" value={f.staffId} onChange={(e) => set('staff', e.target.value)} aria-label="Staff">
            <option value="">Everyone</option>{staff?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        {integ?.highlevel.connected && (
          <select className="field h-9 w-auto py-1 text-sm" value={f.hl} onChange={(e) => set('hl', e.target.value)} aria-label="HighLevel status">
            <option value="">HighLevel: any</option><option value="synced">In HighLevel</option><option value="failed">Needs attention</option><option value="not_pushed">Not pushed</option>
          </select>
        )}
        <input className="field h-9 w-48 py-1 text-sm" placeholder="Search tasks" value={f.q} onChange={(e) => set('q', e.target.value)} />
      </div>}
      {isLoading && <PageLoading />}
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {tasks?.length === 0 && (section ? <p className="text-sm text-stone">Nothing here.</p> : <div className="panel"><EmptyState icon={<ListTodo className="h-9 w-9" />} title="No tasks here">{preset ? 'Nothing here right now.' : 'Try a different filter, or create a task.'}</EmptyState></div>)}
      <div className="space-y-3">{tasks?.map((t) => <TaskCard key={t.id} task={t} compact />)}</div>
    </div>
  );
}

/** Deletes finished (completed or cancelled) follow-ups and tasks to clear out storage. Open ones are never touched. */
function ClearFinished({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshAll();
  const [kind, setKind] = useState<'' | 'follow_up' | 'task'>('');
  const [age, setAge] = useState('30');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const before = age === 'all' ? undefined : new Date(Date.now() - Number(age) * 86400_000).toISOString().slice(0, 10);
      const q = new URLSearchParams({ ...(before ? { before } : {}), ...(kind ? { kind } : {}) });
      const r = await api.del<{ removed: number }>(`/tasks/finished${q.toString() ? `?${q}` : ''}`);
      toast(r.removed ? `Deleted ${r.removed} finished item${r.removed === 1 ? '' : 's'}` : 'Nothing to delete');
      refresh();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Clear finished tasks" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} onClick={run}>Delete</Button></>}>
      <p className="mb-4 text-[14px] text-ink-soft">Permanently deletes completed and cancelled items. Open and snoozed ones are never touched. Automatic follow-ups that are deleted won’t be created again for the same reason.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What">
          <select className="field" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="">Follow-ups and internal tasks</option><option value="follow_up">Follow-ups only</option><option value="task">Internal tasks only</option>
          </select>
        </Field>
        <Field label="Finished">
          <select className="field" value={age} onChange={(e) => setAge(e.target.value)}>
            <option value="7">More than a week ago</option><option value="30">More than 30 days ago</option><option value="90">More than 90 days ago</option><option value="all">Any time</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}
