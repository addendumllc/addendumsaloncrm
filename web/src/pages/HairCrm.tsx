import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Clock, Download, Mail, Pencil, Plus, RotateCcw, Trash2, Users } from 'lucide-react';
import { HAIR_TASK_TYPES, suggestHairTask, type HairClientDTO, type HairHighLevelDTO, type HairTaskDTO, type HairTaskStatus, type HairTaskType } from '@addendum/shared';
import { api } from '../api/client';
import { useMe, useStaff } from '../api/hooks';
import { Badge, Button, EmptyState, ErrorNote, Field, Modal, PageHeader, PageLoading, Toggle, cx, useToast } from '../components/ui';

/**
 * Addendum Hair CRM: Addendum Hair's own clients (stylists and salons who buy hair) and the tasks that come from their
 * emails and follow-ups. Separate from the salon's clients and follow-ups.
 */

const TYPE_LABEL = Object.fromEntries(HAIR_TASK_TYPES.map((t) => [t.value, t.label])) as Record<HairTaskType, string>;
const SOURCE_LABEL = { email: 'Email', follow_up: 'Follow-up', manual: 'Added' } as const;
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const plusDays = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDay = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

function useHairInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['hair'] });
}

/** Where one Addendum Hair client opens (Clients → Addendum Hair). */
export const hairClientUrl = (id?: string | null) => (id ? `/clients?business=hair&client=${id}` : '/clients?business=hair');

/** Clients → Addendum Hair: the client list, or one client. */
export function HairClientsView() {
  const [params] = useSearchParams();
  const clientId = params.get('client');
  return clientId ? <ClientDetail id={clientId} /> : <ClientList />;
}

// ---------------- Tasks ----------------

/**
 * Addendum Hair client tasks (Tasks): to do (open), follow-ups (waiting on the client's reply), done, or all open ones;
 * optionally only those assigned to the person. As the page, or a section under the salon's tasks.
 */
export function HairTasks({ status, mine, since, title, section }: { status: HairTaskStatus | 'active'; mine?: boolean; since?: string; title?: string; section?: boolean }) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState<null | 'manual' | 'email'>(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['hair', 'tasks', status, mine, since, q],
    queryFn: () => api.get<{ tasks: HairTaskDTO[] }>(`/hair/tasks?status=${status}${mine ? '&mine=1' : ''}${since ? `&since=${since}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`).then((r) => r.tasks),
  });
  const today = todayStr();
  const overdue = (data ?? []).filter((t) => t.dueOn && t.dueOn < today).length;
  const heading = title ?? (status === 'waiting' ? 'Addendum Hair follow-ups' : status === 'done' ? 'Done' : 'Addendum Hair client tasks');
  const count = data ? `${data.length} ${status === 'done' ? 'completed' : status === 'waiting' ? 'waiting on a reply' : 'to do'}${overdue && status !== 'done' ? ` · ${overdue} overdue` : ''}` : undefined;
  const actions = status !== 'done' && (
    <div className="flex flex-wrap gap-2">
      <Button size={section ? 'sm' : 'md'} icon={<Mail className="h-4 w-4" />} onClick={() => setAdding('email')}>From an email</Button>
      <Button size={section ? 'sm' : 'md'} variant={section ? 'secondary' : 'primary'} icon={<Plus className="h-4 w-4" />} onClick={() => setAdding('manual')}>Client task</Button>
    </div>
  );
  return (
    <div className={section ? 'mt-8' : ''}>
      {section ? (
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div><h2 className="h-display text-xl">{heading}</h2>{count && <p className="text-[13px] text-stone">{count}</p>}</div>
          {actions}
        </div>
      ) : <PageHeader title={heading} subtitle={count} actions={actions || undefined} />}
      {!section && <input className="field mb-4 sm:max-w-xs" placeholder="Search tasks or clients" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />}
      {isLoading ? <PageLoading /> : error ? <ErrorNote error={error} onRetry={refetch} /> : !data?.length ? (
        section ? <p className="text-sm text-stone">Nothing here.</p> : (
          <EmptyState icon={<CheckCircle2 className="h-6 w-6" />} title={status === 'done' ? 'Nothing completed yet' : status === 'waiting' ? 'No follow-ups waiting' : 'All caught up'}>
            {status === 'open' && 'When an email or follow-up needs a reply, an order or a check-in, add it here.'}
          </EmptyState>
        )
      ) : (
        <div className="space-y-3">{data.map((t) => <TaskCard key={t.id} task={t} showClient />)}</div>
      )}
      {adding && <TaskModal mode={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}

function TaskCard({ task: t, showClient }: { task: HairTaskDTO; showClient?: boolean }) {
  const go = useNavigate();
  const toast = useToast();
  const invalidate = useHairInvalidate();
  const [editing, setEditing] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const set = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/hair/tasks/${t.id}`, body),
    onSuccess: invalidate,
    onError: (e: any) => toast(e.message, 'error'),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/hair/tasks/${t.id}`),
    onSuccess: () => { invalidate(); toast('Task deleted'); },
  });
  const overdue = t.status !== 'done' && !!t.dueOn && t.dueOn < todayStr();
  return (
    <div className={cx('panel p-4', t.status === 'done' && 'opacity-75')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={t.type === 'order' ? 'amber' : t.type === 'reply' ? 'plum' : t.type === 'check_in' ? 'sage' : 'neutral'}>{TYPE_LABEL[t.type]}</Badge>
            {t.status === 'waiting' && <Badge tone="amber">Follow-up · waiting on client</Badge>}
            {t.dueOn && <span className={cx('text-[13px]', overdue ? 'font-medium text-rose' : 'text-stone')}>{overdue ? 'Overdue · ' : 'Due '}{fmtDay(t.dueOn)}</span>}
          </div>
          <div className={cx('mt-1 font-medium text-ink', t.status === 'done' && 'line-through')}>{t.title}</div>
          {showClient && t.clientName && (
            <button className="text-[13px] text-plum hover:underline" onClick={() => go(hairClientUrl(t.clientId))}>{t.clientName}</button>
          )}
        </div>
      </div>
      {t.description && <p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft">{t.description}</p>}
      {t.nextStep && <p className="mt-2 text-sm"><span className="font-medium text-ink">Next step:</span> <span className="text-ink-soft">{t.nextStep}</span></p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-stone">
        <span>{SOURCE_LABEL[t.source]}{t.sourceSubject ? `: ${t.sourceSubject}` : ''}{t.sourceFrom ? ` (${t.sourceFrom})` : ''}</span>
        {t.sourceExcerpt && <button className="text-plum hover:underline" onClick={() => setShowEmail((v) => !v)}>{showEmail ? 'Hide email' : 'Show email'}</button>}
        {t.assignedName && <span>· {t.assignedName}</span>}
        {t.completedAt && <span>· Done {new Date(t.completedAt).toLocaleDateString()}</span>}
      </div>
      {showEmail && t.sourceExcerpt && <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-line-strong pl-3 text-[13px] text-ink-soft">{t.sourceExcerpt}</blockquote>}
      <div className="mt-3 flex flex-wrap gap-2">
        {t.status !== 'done' ? <>
          <Button size="sm" variant="primary" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setFinishing(true)}>Done</Button>
          {t.status === 'open'
            ? <Button size="sm" icon={<Clock className="h-4 w-4" />} loading={set.isPending} onClick={() => set.mutate({ status: 'waiting' })}>Move to follow-ups</Button>
            : <Button size="sm" icon={<RotateCcw className="h-4 w-4" />} loading={set.isPending} onClick={() => set.mutate({ status: 'open' })}>Back to to-do</Button>}
        </> : <Button size="sm" icon={<RotateCcw className="h-4 w-4" />} loading={set.isPending} onClick={() => set.mutate({ status: 'open' })}>Reopen</Button>}
        <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit</Button>
        <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => confirm('Delete this task?') && remove.mutate()}>Delete</Button>
      </div>
      {editing && <TaskModal mode="manual" task={t} onClose={() => setEditing(false)} />}
      {finishing && <FinishModal task={t} onClose={() => setFinishing(false)} />}
    </div>
  );
}

/** Marking a task done can schedule the next check-in straight away. */
function FinishModal({ task, onClose }: { task: HairTaskDTO; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useHairInvalidate();
  const [follow, setFollow] = useState(task.type === 'order');
  const [title, setTitle] = useState(task.type === 'order' ? 'Check the hair arrived' : `Check in: ${task.title}`.slice(0, 200));
  const [dueOn, setDueOn] = useState(plusDays(7));
  const done = useMutation({
    mutationFn: () => api.patch(`/hair/tasks/${task.id}`, { status: 'done', followUp: follow ? { title, dueOn } : null }),
    onSuccess: () => { invalidate(); toast(follow ? 'Done — check-in added' : 'Done'); onClose(); },
    onError: (e: any) => toast(e.message, 'error'),
  });
  return (
    <Modal open onClose={onClose} title="Mark as done" footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={done.isPending} disabled={follow && (!title.trim() || !dueOn)} onClick={() => done.mutate()}>Done</Button>
    </>}>
      <p className="mb-3 text-sm text-ink-soft">{task.title}</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Add a check-in for later</label>
      {follow && <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="Check-in"><input className="field" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="On"><input type="date" className="field" value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></Field>
      </div>}
    </Modal>
  );
}

function useHairClients(q = '') {
  return useQuery({
    queryKey: ['hair', 'clients', q],
    queryFn: () => api.get<{ clients: HairClientDTO[] }>(`/hair/clients${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => r.clients),
  });
}

/** Add a task by hand, or from a pasted email (its type, title and due date are suggested); also edits a task. */
function TaskModal({ mode, task, clientId: fixedClient, onClose }: { mode: 'manual' | 'email'; task?: HairTaskDTO; clientId?: string; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useHairInvalidate();
  const { data: clients } = useHairClients();
  const { data: staff } = useStaff();
  const { data: me } = useMe();
  const [email, setEmail] = useState({ from: '', subject: '', body: '' });
  const [suggested, setSuggested] = useState(mode === 'manual');
  const [f, setF] = useState({
    clientId: task?.clientId ?? fixedClient ?? '',
    newName: '', newEmail: '',
    title: task?.title ?? '', description: task?.description ?? '',
    type: (task?.type ?? 'other') as HairTaskType,
    status: (task?.status ?? 'open') as HairTaskStatus,
    nextStep: task?.nextStep ?? '', dueOn: task?.dueOn ?? plusDays(1),
    assignedStaffId: '',
  });
  const up = (p: Partial<typeof f>) => setF((v) => ({ ...v, ...p }));

  // "Name <email>" or a bare email: matched to a client already on the list, otherwise a new one.
  const suggest = () => {
    const s = suggestHairTask({ subject: email.subject, body: email.body }, todayStr());
    const m = email.from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/) ?? email.from.match(/^\s*()(\S+@\S+)\s*$/);
    const addr = m?.[2]?.trim() ?? '';
    const name = m?.[1]?.trim() || (!addr ? email.from.trim() : addr.split('@')[0]);
    const known = clients?.find((c) => addr && c.email?.toLowerCase() === addr.toLowerCase());
    up({ type: s.type, title: s.title, dueOn: s.dueOn, clientId: known?.id ?? (f.clientId || ''), newName: known ? '' : name, newEmail: known ? '' : addr,
      description: s.type === 'order' ? 'Needs hair to order' : '' });
    setSuggested(true);
  };

  const save = useMutation({
    mutationFn: () => {
      const base = {
        title: f.title, description: f.description || null, type: f.type, status: f.status,
        nextStep: f.nextStep || null, dueOn: f.dueOn || null, assignedStaffId: f.assignedStaffId || undefined,
      };
      if (task) return api.patch(`/hair/tasks/${task.id}`, { ...base, clientId: f.clientId || null });
      return api.post('/hair/tasks', {
        ...base,
        clientId: f.clientId && f.clientId !== 'new' ? f.clientId : null,
        client: (!f.clientId || f.clientId === 'new') && f.newName.trim() ? { name: f.newName.trim(), email: f.newEmail.trim() || null } : null,
        source: mode === 'email' ? 'email' : 'manual',
        sourceSubject: mode === 'email' ? email.subject || null : null,
        sourceFrom: mode === 'email' ? email.from || null : null,
        sourceExcerpt: mode === 'email' ? email.body.slice(0, 4000) || null : null,
      });
    },
    onSuccess: () => { invalidate(); toast(task ? 'Task saved' : 'Task added'); onClose(); },
    onError: (e: any) => toast(e.message, 'error'),
  });

  const newClient = !task && (!f.clientId || f.clientId === 'new');
  return (
    <Modal open wide onClose={onClose} title={task ? 'Edit task' : mode === 'email' ? 'Task from an email' : 'New task'} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      {suggested
        ? <Button variant="primary" loading={save.isPending} disabled={!f.title.trim()} onClick={() => save.mutate()}>{task ? 'Save' : 'Add task'}</Button>
        : <Button variant="primary" disabled={!email.subject.trim() && !email.body.trim()} onClick={suggest}>Next</Button>}
    </>}>
      {mode === 'email' && !task && (
        <div className={cx('space-y-3', suggested && 'mb-4 border-b border-line pb-4')}>
          {!suggested && <p className="text-sm text-ink-soft">Paste the email. The task type, title and due date are filled in for you; change anything before saving.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From"><input className="field" placeholder="Bella Salon <bella@example.com>" value={email.from} onChange={(e) => setEmail({ ...email, from: e.target.value })} /></Field>
            <Field label="Subject"><input className="field" value={email.subject} onChange={(e) => setEmail({ ...email, subject: e.target.value })} /></Field>
          </div>
          <Field label="Email"><textarea className="field min-h-[110px]" value={email.body} onChange={(e) => setEmail({ ...email, body: e.target.value })} /></Field>
          {suggested && <Button size="sm" variant="ghost" onClick={suggest}>Suggest again</Button>}
        </div>
      )}
      {suggested && (
        <div className="space-y-3">
          {!fixedClient && (
            <Field label="Client">
              <select className="field" value={f.clientId || (task ? '' : 'new')} onChange={(e) => up({ clientId: e.target.value })}>
                {task ? <option value="">No client</option> : <option value="new">New client…</option>}
                {clients?.map((c) => <option key={c.id} value={c.id}>{c.name}{c.company ? ` · ${c.company}` : ''}</option>)}
              </select>
            </Field>
          )}
          {newClient && !fixedClient && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Client name"><input className="field" value={f.newName} onChange={(e) => up({ newName: e.target.value })} /></Field>
              <Field label="Email"><input className="field" type="email" value={f.newEmail} onChange={(e) => up({ newEmail: e.target.value })} /></Field>
            </div>
          )}
          <Field label="Task"><input className="field" value={f.title} onChange={(e) => up({ title: e.target.value })} placeholder="Order 3 packs of 22” 60A" /></Field>
          <Field label="Description"><textarea className="field min-h-[70px]" value={f.description} onChange={(e) => up({ description: e.target.value })} placeholder="e.g. Needs hair to order — not in inventory yet" /></Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Type">
              <select className="field" value={f.type} onChange={(e) => up({ type: e.target.value as HairTaskType })}>
                {HAIR_TASK_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select className="field" value={f.status} onChange={(e) => up({ status: e.target.value as HairTaskStatus })}>
                <option value="open">To do</option><option value="waiting">Follow-up (waiting on client)</option><option value="done">Done</option>
              </select>
            </Field>
            <Field label="Due"><input type="date" className="field" value={f.dueOn} onChange={(e) => up({ dueOn: e.target.value })} /></Field>
          </div>
          <Field label="Next step"><input className="field" value={f.nextStep} onChange={(e) => up({ nextStep: e.target.value })} placeholder="e.g. Email when the order arrives" /></Field>
          {!task && (staff?.length ?? 0) > 1 && (
            <Field label="For">
              <select className="field" value={f.assignedStaffId} onChange={(e) => up({ assignedStaffId: e.target.value })}>
                <option value="">Anyone</option>
                {staff?.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.id === me?.id ? `${s.name} (you)` : s.name}</option>)}
              </select>
            </Field>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------- Clients ----------------

function ClientList() {
  const go = useNavigate();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [pulling, setPulling] = useState(false);
  const { data, isLoading, error, refetch } = useHairClients(q);
  return (
    <div>
      <PageHeader title="Addendum Hair clients" subtitle={data ? `${data.length} client${data.length === 1 ? '' : 's'}` : undefined}
        actions={<div className="flex flex-wrap gap-2">
          <Button icon={<Download className="h-4 w-4" />} onClick={() => setPulling(true)}>From HighLevel</Button>
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Client</Button>
        </div>} />
      <input className="field mb-4 sm:max-w-xs" placeholder="Search name, email, phone or company" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
      {isLoading ? <PageLoading /> : error ? <ErrorNote error={error} onRetry={refetch} /> : !data?.length ? (
        <EmptyState icon={<Users className="h-6 w-6" />} title="No clients yet">Clients are added here, or automatically when you add a task from their email.</EmptyState>
      ) : (
        <div className="panel divide-y divide-line">
          {data.map((c) => (
            <button key={c.id} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-mist" onClick={() => go(hairClientUrl(c.id))}>
              <div className="min-w-0">
                <div className="font-medium text-ink">{c.name}{c.company && <span className="font-normal text-stone"> · {c.company}</span>}</div>
                <div className="truncate text-[13px] text-stone">{[c.email, c.phone].filter(Boolean).join(' · ') || 'No contact details'}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {c.fromHighLevel && <Badge>HighLevel</Badge>}
                {c.openTasks > 0 && <Badge tone="plum">{c.openTasks} open</Badge>}
              </div>
            </button>
          ))}
        </div>
      )}
      {adding && <ClientModal onClose={() => setAdding(false)} />}
      {pulling && <HighLevelPull onClose={() => setPulling(false)} />}
    </div>
  );
}

/**
 * Pulls Addendum Hair's clients from HighLevel: contacts with a tag (e.g. "Addendum Hair"), or every contact when
 * Addendum Hair has its own HighLevel sub-account. Clients already here are updated, never duplicated.
 */
function HighLevelPull({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const invalidate = useHairInvalidate();
  const qc = useQueryClient();
  const { data: st } = useQuery({ queryKey: ['hair', 'highlevel'], queryFn: () => api.get<HairHighLevelDTO>('/hair/highlevel') });
  const [tag, setTag] = useState<string | null>(null);
  const [auto, setAuto] = useState<boolean | null>(null);
  const tagValue = tag ?? st?.tag ?? '';
  const autoValue = auto ?? st?.auto ?? false;
  const pull = useMutation({
    mutationFn: async () => {
      await api.put('/hair/highlevel', { tag: tagValue.trim() || null, auto: autoValue });
      return api.post<{ added: number; updated: number; matched: number; scanned: number }>('/hair/highlevel/pull');
    },
    onSuccess: (r) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ['hair', 'highlevel'] });
      toast(r.matched ? `${r.added} added, ${r.updated} updated (${r.matched} in HighLevel)` : `No HighLevel contacts${tagValue.trim() ? ` tagged “${tagValue.trim()}”` : ''} found`);
      onClose();
    },
    onError: (e: any) => toast(e.message, 'error'),
  });
  return (
    <Modal open onClose={onClose} title="Pull clients from HighLevel" footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={pull.isPending} disabled={!st?.connected} onClick={() => pull.mutate()}>Pull clients</Button>
    </>}>
      {!st ? <PageLoading /> : !st.connected ? (
        <p className="text-sm text-ink-soft">HighLevel isn’t connected. Connect it in Settings → API &amp; Integrations: GoHighLevel, or “Addendum Hair HighLevel” if Addendum Hair has its own sub-account.</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink-soft">
            {st.source === 'own' ? 'From Addendum Hair’s own HighLevel sub-account.' : 'From the GoHighLevel connection.'}{' '}
            Names, emails, phones and companies follow HighLevel; notes and tasks here are kept. Nobody is removed.
          </p>
          <Field label="Only contacts tagged" hint={tagValue.trim() ? `Contacts with the “${tagValue.trim()}” tag in HighLevel.` : 'Empty: every contact in HighLevel.'}>
            <input className="field" value={tagValue} onChange={(e) => setTag(e.target.value)} placeholder="Addendum Hair" />
          </Field>
          <Toggle checked={autoValue} onChange={setAuto} label="Pull automatically every hour" description="New and changed HighLevel contacts show up here on their own." />
          {st.lastPullAt && (
            <p className={cx('text-[13px]', st.lastError ? 'text-rose' : 'text-stone')}>
              Last pulled {new Date(st.lastPullAt).toLocaleString()}
              {st.lastError ? ` — ${st.lastError}` : st.lastResult ? ` · ${st.lastResult.added} added, ${st.lastResult.updated} updated` : ''}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function ClientModal({ client, onClose }: { client?: HairClientDTO; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useHairInvalidate();
  const [f, setF] = useState({ name: client?.name ?? '', email: client?.email ?? '', phone: client?.phone ?? '', company: client?.company ?? '', notes: client?.notes ?? '' });
  const save = useMutation({
    mutationFn: () => (client ? api.patch(`/hair/clients/${client.id}`, f) : api.post('/hair/clients', f)),
    onSuccess: () => { invalidate(); toast(client ? 'Client saved' : 'Client added'); onClose(); },
    onError: (e: any) => toast(e.message, 'error'),
  });
  return (
    <Modal open onClose={onClose} title={client ? 'Edit client' : 'New client'} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={save.isPending} disabled={!f.name.trim()} onClick={() => save.mutate()}>Save</Button>
    </>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input className="field" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Salon or company"><input className="field" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></Field>
          <Field label="Email"><input className="field" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Phone"><input className="field" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        </div>
        <Field label="Notes"><textarea className="field min-h-[80px]" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function ClientDetail({ id }: { id: string }) {
  const go = useNavigate();
  const toast = useToast();
  const invalidate = useHairInvalidate();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['hair', 'client', id],
    queryFn: () => api.get<{ client: HairClientDTO; tasks: HairTaskDTO[] }>(`/hair/clients/${id}`),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/hair/clients/${id}`),
    onSuccess: () => { invalidate(); toast('Client deleted'); go(hairClientUrl()); },
  });
  if (isLoading) return <PageLoading />;
  if (error || !data) return <ErrorNote error={error} onRetry={refetch} />;
  const { client: c, tasks } = data;
  const open = tasks.filter((t) => t.status !== 'done');
  const done = tasks.filter((t) => t.status === 'done');
  return (
    <div>
      <button className="mb-3 inline-flex items-center gap-1 text-sm text-stone hover:text-ink" onClick={() => go(hairClientUrl())}><ArrowLeft className="h-4 w-4" /> Clients</button>
      <PageHeader title={c.name} subtitle={[c.company, c.email, c.phone].filter(Boolean).join(' · ') || undefined}
        actions={<div className="flex flex-wrap gap-2">
          <Button icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit</Button>
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Task</Button>
        </div>} />
      {c.notes && <p className="panel mb-4 whitespace-pre-wrap p-4 text-sm text-ink-soft">{c.notes}</p>}
      <h2 className="h-display mb-2 text-lg">Open tasks and follow-ups</h2>
      {open.length ? <div className="mb-6 space-y-3">{open.map((t) => <TaskCard key={t.id} task={t} />)}</div> : <p className="mb-6 text-sm text-stone">Nothing open.</p>}
      {done.length > 0 && <>
        <h2 className="h-display mb-2 text-lg">Done</h2>
        <div className="space-y-3">{done.map((t) => <TaskCard key={t.id} task={t} />)}</div>
      </>}
      <div className="mt-8">
        <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => confirm(`Delete ${c.name} and their tasks?`) && remove.mutate()}>Delete client</Button>
      </div>
      {editing && <ClientModal client={c} onClose={() => setEditing(false)} />}
      {adding && <TaskModal mode="manual" clientId={c.id} onClose={() => setAdding(false)} />}
    </div>
  );
}
