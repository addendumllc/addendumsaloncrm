import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, Plus } from 'lucide-react';
import { TASK_TYPE_LABELS, type Priority, type TaskDTO } from '@addendum/shared';
import { useMe, useStaff, useTasks } from '../api/hooks';
import { Button, EmptyState, ErrorNote, PageHeader, PageLoading, Segmented, cx } from '../components/ui';
import { TaskCard, PRIORITY_DOT } from '../components/domain/TaskCard';
import { useActions } from '../components/domain/ActionsProvider';
import { RebookingScheduleList } from '../components/domain/Rebooking';

const GROUPS: { p: Priority; label: string }[] = [
  { p: 'high', label: 'High priority' },
  { p: 'medium', label: 'Medium priority' },
  { p: 'low', label: 'Low priority' },
];

/** Today's Follow-Ups: one simple queue, highest priority first, every action inline. */
export function FollowUpsPage() {
  const [params, setParams] = useSearchParams();
  const due = (params.get('due') ?? 'today') as 'today' | 'overdue' | 'upcoming' | 'done';
  const view = params.get('view') === 'schedule' ? 'schedule' : 'queue';
  const type = params.get('type') ?? '';
  const staffId = params.get('staff') ?? '';
  const focus = params.get('task');
  const { data: me } = useMe();
  const { data: staff } = useStaff();
  const { newFollowUp } = useActions();
  const canSeeAll = me?.permissions.includes('*') || me?.permissions.includes('tasks:read_all');
  const { data: tasks, isLoading, error, refetch } = useTasks({
    kind: 'follow_up', type: type || undefined, staffId: staffId || undefined,
    status: due === 'done' ? 'completed' : 'open', due: due === 'done' ? undefined : due,
  });

  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    p.delete('task');
    setParams(p, { replace: true });
  };

  const list = useMemo(() => {
    let l = tasks ?? [];
    if (focus) l = [...l.filter((t) => t.id === focus), ...l.filter((t) => t.id !== focus)];
    return l;
  }, [tasks, focus]);
  const typesPresent = [...new Set((tasks ?? []).map((t) => t.type))];

  return (
    <div>
      <PageHeader
        title="Today's Follow-Ups"
        subtitle={tasks ? `${tasks.length} ${due === 'done' ? 'completed' : 'to do'}${type ? ` · ${TASK_TYPE_LABELS[type as keyof typeof TASK_TYPE_LABELS]}` : ''}` : undefined}
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => newFollowUp()}>Follow-up</Button>}
      />
      {(me?.permissions.includes('clients:read') || me?.permissions.includes('clients:read_assigned')) && (
        <Segmented className="mb-4" value={view} onChange={(v) => set('view', v === 'queue' ? '' : v)} options={[
          { value: 'queue', label: 'Follow-ups' }, { value: 'schedule', label: 'Rebooking schedule' },
        ]} />
      )}
      {view === 'schedule' ? <RebookingScheduleList /> : <>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Segmented value={due} onChange={(v) => set('due', v === 'today' ? '' : v)} options={[
          { value: 'today', label: 'Due today' }, { value: 'overdue', label: 'Overdue' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'done', label: 'Completed' },
        ]} />
        <select className="field h-9 w-auto py-1 text-sm" value={type} onChange={(e) => set('type', e.target.value)} aria-label="Type">
          <option value="">All types</option>
          {Object.entries(TASK_TYPE_LABELS).filter(([k]) => k !== 'internal').map(([k, v]) => <option key={k} value={k}>{v}{typesPresent.includes(k as any) ? '' : ''}</option>)}
        </select>
        {canSeeAll && (
          <select className="field h-9 w-auto py-1 text-sm" value={staffId} onChange={(e) => set('staff', e.target.value)} aria-label="Staff">
            <option value="">Everyone</option>
            {staff?.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>

      {isLoading && <PageLoading />}
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {tasks && list.length === 0 && (
        <div className="panel">
          <EmptyState icon={<CheckCircle2 className="h-9 w-9" />} title={due === 'done' ? 'Nothing completed yet' : 'All clear'}>
            {due === 'today' ? 'No follow-ups due today. New leads, cancellations and rebooking opportunities appear here automatically.' : 'No follow-ups match these filters.'}
          </EmptyState>
        </div>
      )}
      {due === 'done' ? (
        <div className="space-y-3">{list.map((t) => <TaskCard key={t.id} task={t} compact />)}</div>
      ) : (
        GROUPS.map(({ p, label }) => {
          const group = list.filter((t: TaskDTO) => t.priority === p);
          if (!group.length) return null;
          return (
            <section key={p} className="mb-8">
              <h2 className="mb-3 flex items-center gap-2 text-[15px] font-medium text-ink">
                <span className={cx('h-2.5 w-2.5 rounded-full', PRIORITY_DOT[p])} />{label}
                <span className="num text-stone">{group.length}</span>
              </h2>
              <div className="space-y-3">{group.map((t) => <div key={t.id} className={cx(t.id === focus && 'rounded-xl2 ring-2 ring-plum/40')}><TaskCard task={t} /></div>)}</div>
            </section>
          );
        })
      )}
      </>}
    </div>
  );
}
