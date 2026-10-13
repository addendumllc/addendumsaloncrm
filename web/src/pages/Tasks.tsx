import { useSearchParams } from 'react-router-dom';
import { Plus, ListTodo } from 'lucide-react';
import { TASK_TYPE_LABELS } from '@addendum/shared';
import { useIntegrations, useMe, useStaff, useTasks } from '../api/hooks';
import { Button, EmptyState, ErrorNote, PageHeader, PageLoading, Segmented } from '../components/ui';
import { TaskCard } from '../components/domain/TaskCard';
import { useActions } from '../components/domain/ActionsProvider';

/** Every follow-up and internal salon task, with full filters. */
export function TasksPage() {
  const [params, setParams] = useSearchParams();
  const { data: me } = useMe();
  const { data: staff } = useStaff();
  const { data: integ } = useIntegrations();
  const { newFollowUp } = useActions();
  const f = {
    kind: params.get('kind') ?? '',
    status: params.get('status') ?? 'open',
    type: params.get('type') ?? '',
    priority: params.get('priority') ?? '',
    staffId: params.get('staff') ?? '',
    hl: params.get('hl') ?? '',
    q: params.get('q') ?? '',
  };
  const { data: tasks, isLoading, error, refetch } = useTasks({
    kind: f.kind || undefined, status: f.status, type: f.type || undefined, priority: f.priority || undefined,
    staffId: f.staffId || undefined, hl: f.hl || undefined, q: f.q || undefined,
  });
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    setParams(p, { replace: true });
  };
  const canSeeAll = me?.permissions.includes('*') || me?.permissions.includes('tasks:read_all');

  return (
    <div>
      <PageHeader
        title="Tasks"
        subtitle="Every follow-up plus internal salon to-dos."
        actions={<>
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => newFollowUp({ internal: true })}>Internal task</Button>
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => newFollowUp()}>Follow-up</Button>
        </>}
      />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Segmented value={f.kind || 'all'} onChange={(v) => set('kind', v === 'all' ? '' : v)} options={[{ value: 'all', label: 'All' }, { value: 'follow_up', label: 'Follow-ups' }, { value: 'task', label: 'Internal' }]} />
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
      </div>
      {isLoading && <PageLoading />}
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {tasks?.length === 0 && <div className="panel"><EmptyState icon={<ListTodo className="h-9 w-9" />} title="No tasks here">Try a different filter, or create a task.</EmptyState></div>}
      <div className="space-y-3">{tasks?.map((t) => <TaskCard key={t.id} task={t} compact />)}</div>
    </div>
  );
}
