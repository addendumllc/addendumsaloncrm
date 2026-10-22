import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Megaphone, Pencil, Pin, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import { useCanDo, useMe } from '../../api/hooks';
import { relative } from '../../lib/format';
import { Badge, Button, EmptyState, Field, Modal, Spinner, Toggle, cx, useToast } from '../ui';
import { useUsersRoles } from './useRoles';
import { Tc } from '../../lib/titleCase';

export interface Announcement {
  id: string; title: string; body: string; linkUrl: string | null; linkLabel: string | null; important: boolean; pinned: boolean;
  audienceRoles: string[] | null; status: 'draft' | 'published'; publishedAt: string | null; authorId: string | null; authorName: string | null;
  read: boolean; readCount: number; createdAt: string; updatedAt: string;
}

export const useAnnouncements = (enabled = true) => useQuery({
  queryKey: ['announcements'],
  queryFn: () => api.get<{ announcements: Announcement[]; unread: number }>('/announcements'),
  enabled, refetchInterval: 120_000,
});

/**
 * Team announcements — a separate section from tasks: publishing one shows it to its audience, it never creates a task.
 * Editing/deleting is offered only where the person may do it; the server checks every action.
 */
/** The page for people without the dashboard (stylists by default). */
export function AnnouncementsPage() {
  return <div className="pt-2"><AnnouncementsSection /></div>;
}

export function AnnouncementsSection({ className = 'mb-8' }: { className?: string }) {
  const canDo = useCanDo();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useAnnouncements();
  const [editing, setEditing] = useState<Announcement | 'new' | null>(null);
  const canPublish = canDo('announcements:publish') || canDo('announcements:manage');
  const canChange = (a: Announcement) => canDo('announcements:manage') || (canDo('announcements:publish') && a.authorId === me?.id);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['announcements'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); };
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast(msg); refresh(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const list = data?.announcements ?? [];
  return (
    <section className={cx('flex flex-col', className)}>
      <div className="mb-3 flex min-h-9 flex-wrap items-end justify-between gap-2">
        <h2 className="h-display flex items-center gap-2 text-[22px] leading-none"><Tc><Megaphone className="h-5 w-5 text-plum" />Team announcements{data?.unread ? <Badge tone="plum">{data.unread} new</Badge> : null}</Tc></h2>
        <div className="flex gap-2">
          {!!data?.unread && <Button size="sm" variant="ghost" onClick={() => act(() => api.post('/announcements/read-all'), 'All marked as read')}>Mark all read</Button>}
          {canPublish && <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>New announcement</Button>}
        </div>
      </div>
      {isLoading && <div className="flex justify-center py-6"><Spinner /></div>}
      {!isLoading && list.length === 0 && <div className="panel flex flex-1 items-center justify-center"><EmptyState icon={<Megaphone className="h-8 w-8" />} title="No announcements">Team-wide news shows here.</EmptyState></div>}
      <ul className="space-y-3">
        {list.map((a) => (
          <li key={a.id} className={cx('rounded-xl2 border bg-white p-4', a.important ? 'border-plum/40' : 'border-line', !a.read && a.status === 'published' && 'shadow-lift')}>
            <div className="flex flex-wrap items-center gap-1.5">
              {a.pinned && <Badge tone="ink"><Pin className="h-3 w-3" />Pinned</Badge>}
              {a.important && <Badge tone="plum">Important</Badge>}
              {a.status === 'draft' && <Badge tone="amber">Draft — not published</Badge>}
              {!a.read && a.status === 'published' && <Badge tone="sage">New</Badge>}
              {a.audienceRoles && <Badge>For {a.audienceRoles.length} role{a.audienceRoles.length === 1 ? '' : 's'}</Badge>}
            </div>
            <h3 className="mt-1.5 text-[17px] font-medium text-ink"><Tc>{a.title}</Tc></h3>
            {a.body && <p className="mt-1 whitespace-pre-wrap text-[15px] text-ink-soft">{a.body}</p>}
            {a.linkUrl && <a href={a.linkUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-[14px] text-plum hover:underline"><ExternalLink className="h-4 w-4" />{a.linkLabel || 'Open link'}</a>}
            <p className="mt-2 text-[12px] text-stone">{a.authorName ?? 'Someone'} · {a.publishedAt ? relative(a.publishedAt) : `saved ${relative(a.updatedAt)}`}{canChange(a) && a.status === 'published' ? ` · read by ${a.readCount}` : ''}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {!a.read && a.status === 'published' && <Button size="sm" onClick={() => act(() => api.post(`/announcements/${a.id}/read`), 'Marked as read')}>Mark as read</Button>}
              {canChange(a) && (
                <>
                  <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(a)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/announcements/${a.id}/${a.status === 'draft' ? 'publish' : 'unpublish'}`), a.status === 'draft' ? 'Published' : 'Moved back to drafts')}>{a.status === 'draft' ? 'Publish' : 'Unpublish'}</Button>
                  <Button size="sm" variant="ghost" className="text-rose" icon={<Trash2 className="h-4 w-4" />} onClick={() => { if (window.confirm('Delete this announcement?')) void act(() => api.del(`/announcements/${a.id}`), 'Deleted'); }}>Delete</Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {editing && <AnnouncementEditor a={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </section>
  );
}

function AnnouncementEditor({ a, onClose, onSaved }: { a: Announcement | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const roles = useUsersRoles();
  const [f, setF] = useState({
    title: a?.title ?? '', body: a?.body ?? '', linkUrl: a?.linkUrl ?? '', linkLabel: a?.linkLabel ?? '',
    important: a?.important ?? false, pinned: a?.pinned ?? false, audience: a?.audienceRoles ?? null as string[] | null,
  });
  const [busy, setBusy] = useState(false);
  const save = async (publish: boolean) => {
    setBusy(true);
    try {
      const body = { title: f.title, body: f.body, linkUrl: f.linkUrl || null, linkLabel: f.linkLabel || null, important: f.important, pinned: f.pinned, audienceRoles: f.audience };
      if (a) await api.put(`/announcements/${a.id}`, body);
      else await api.post('/announcements', { ...body, publish });
      toast(a ? 'Saved' : publish ? 'Published to the team' : 'Saved as a draft');
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open side onClose={onClose} title={a ? 'Edit announcement' : 'New announcement'} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      {!a && <Button disabled={!f.title.trim()} loading={busy} onClick={() => save(false)}>Save draft</Button>}
      <Button variant="primary" disabled={!f.title.trim()} loading={busy} onClick={() => save(true)}>{a ? 'Save' : 'Publish'}</Button>
    </>}>
      <div className="space-y-4">
        <Field label="Title"><input className="field" value={f.title} maxLength={140} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Message"><textarea className="field min-h-[140px]" value={f.body} maxLength={5000} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Link or attachment (optional)" hint="An https:// link, e.g. a shared file or form."><input className="field" value={f.linkUrl} onChange={(e) => setF({ ...f, linkUrl: e.target.value })} placeholder="https://" /></Field>
          <Field label="Link text"><input className="field" value={f.linkLabel} maxLength={80} onChange={(e) => setF({ ...f, linkLabel: e.target.value })} placeholder="e.g. Holiday schedule (PDF)" /></Field>
        </div>
        <Toggle checked={f.important} onChange={(v) => setF({ ...f, important: v })} label="Important" description="Highlighted for everyone." />
        <Toggle checked={f.pinned} onChange={(v) => setF({ ...f, pinned: v })} label="Pin to the top" />
        <div>
          <span className="label">Who Sees It</span>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setF({ ...f, audience: null })} className={cx('rounded-lg border px-3 py-2 text-[13px]', f.audience === null ? 'border-plum bg-plum-tint' : 'border-line-strong')}>The whole team</button>
            <button type="button" onClick={() => setF({ ...f, audience: f.audience ?? [] })} className={cx('rounded-lg border px-3 py-2 text-[13px]', f.audience !== null ? 'border-plum bg-plum-tint' : 'border-line-strong')}>Only some roles</button>
          </div>
          {f.audience !== null && (
            <div className="mt-2 flex flex-wrap gap-2">
              {roles.map((r) => {
                const on = f.audience!.includes(r.role);
                return <label key={r.role} className="flex min-h-[40px] items-center gap-2 rounded-lg border border-line px-3 text-[14px]"><input type="checkbox" className="h-4 w-4 accent-plum" checked={on} onChange={() => setF({ ...f, audience: on ? f.audience!.filter((x) => x !== r.role) : [...f.audience!, r.role] })} />{r.label}</label>;
              })}
            </div>
          )}
        </div>
        <p className="text-[12px] text-stone">Announcements don’t create tasks — they show in Team announcements (and on the Dashboard) for the people chosen.</p>
      </div>
    </Modal>
  );
}
