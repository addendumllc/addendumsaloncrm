import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS_CATALOG, PERMISSION_CATEGORIES, type RoleTemplateDTO, type StaffAccountDTO } from '@addendum/shared';
import { ArrowLeft, ChevronDown, ChevronRight, Layers, Pencil, Plus, Search, ShieldAlert, Trash2, UserPlus } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { useCanDo, useMe } from '../../api/hooks';
import { Avatar, Badge, Button, EmptyState, Field, Modal, Spinner, cx, useToast } from '../../components/ui';
import { Card } from './shared';
import { StatusBadge, useUsersData } from './UsersTab';
import { Tc } from '../../lib/titleCase';

/**
 * Settings → Role templates: its own screen (separate from Users & Permissions), laid out for phones first —
 * a list of templates, then one template at a time with large touch targets and a save bar that stays in view.
 * The server enforces every rule (only what you hold, sensitive confirmations, no lock-outs).
 */
const PERM = new Map(PERMISSIONS_CATALOG.map((p) => [p.key, p]));
const ACTION_LABEL: Record<string, string> = { view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', approve: 'Approve', export: 'Export' };

export function RoleTemplatesSettings() {
  const [params, setParams] = useSearchParams();
  const { data, isLoading } = useUsersData();
  const canDo = useCanDo();
  const [creating, setCreating] = useState(false);
  const open = params.get('role');
  const go = (role: string | null) => {
    const p = new URLSearchParams(params);
    if (role) p.set('role', role); else p.delete('role');
    setParams(p);
    window.scrollTo?.({ top: 0 });
  };
  if (isLoading || !data) return <div className="flex justify-center py-10"><Spinner /></div>;
  const t = open ? data.roles.find((r) => r.role === open) : null;
  if (t) return <TemplateEditor key={t.role} t={t} people={data.users} onBack={() => go(null)} />;

  return (
    <div className="space-y-4">
      <Card
        title="Role templates"
        description="A template is a set of permissions. Everyone using it gets exactly those, plus or minus any individual settings on their account."
        footer={canDo('users:permissions') && <Button variant="primary" className="w-full sm:w-auto" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New template</Button>}
      >
        <ul className="-mx-2 divide-y divide-line">
          {data.roles.map((r) => (
            <li key={r.role}>
              <button type="button" onClick={() => go(r.role)} className="flex min-h-[64px] w-full items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-mist/50 active:bg-mist">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-plum-tint text-plum"><Layers className="h-5 w-5" /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[15px] font-medium text-ink">{r.label}</span>
                    <Badge tone={r.builtin ? 'neutral' : 'plum'}>{r.builtin ? 'Built-in' : 'Custom'}</Badge>
                  </span>
                  <span className="block text-[13px] text-stone">{r.members} {r.members === 1 ? 'person' : 'people'} · {r.permissions.length} permissions</span>
                  {r.description && <span className="block truncate text-[12px] text-stone">{r.description}</span>}
                </span>
                <ChevronRight className="h-5 w-5 shrink-0 text-stone" />
              </button>
            </li>
          ))}
        </ul>
      </Card>
      {creating && <NewTemplate roles={data.roles} onClose={() => setCreating(false)} onCreated={(role) => { setCreating(false); go(role); }} />}
    </div>
  );
}

function NewTemplate({ roles, onClose, onCreated }: { roles: RoleTemplateDTO[]; onClose: () => void; onCreated: (role: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ label: '', description: '', copyFrom: 'assistant' });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (ok = false) => {
    setBusy(true);
    try {
      const r = await api.post<{ role: string }>('/admin/roles', { label: f.label, description: f.description || null, copyFrom: f.copyFrom || null, confirm: ok });
      await qc.invalidateQueries({ queryKey: ['admin-users'] });
      toast(`“${f.label}” created`);
      onCreated(r.role);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_required') setConfirm(true);
      else toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="New role template" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.label.trim()} loading={busy} onClick={() => save(confirm)}>{confirm ? 'Confirm and create' : 'Create'}</Button></>}>
      <div className="space-y-4">
        <Field label="Name"><input className="field" value={f.label} maxLength={40} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="e.g. Senior Stylist" autoFocus /></Field>
        <Field label="Description (optional)"><input className="field" value={f.description} maxLength={200} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Who it’s for" /></Field>
        <Field label="Start from" hint="Copies its permissions; you can change them next.">
          <select className="field" value={f.copyFrom} onChange={(e) => { setF({ ...f, copyFrom: e.target.value }); setConfirm(false); }}>
            <option value="">Nothing (no permissions)</option>
            {roles.map((r) => <option key={r.role} value={r.role}>A copy of {r.label}</option>)}
          </select>
        </Field>
        {confirm && <p className="flex items-start gap-2 rounded-lg bg-amber/10 px-3 py-2 text-[13px] text-ink-soft"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber" />This copies sensitive access. Click “Confirm and create” if that’s intended.</p>}
      </div>
    </Modal>
  );
}

function TemplateEditor({ t, people, onBack }: { t: RoleTemplateDTO; people: StaffAccountDTO[]; onBack: () => void }) {
  const canDo = useCanDo();
  const { data: me } = useMe();
  const toast = useToast();
  const qc = useQueryClient();
  const canEdit = canDo('users:permissions');
  const [draft, setDraft] = useState<Set<string>>(() => new Set(t.permissions));
  const [openCats, setOpenCats] = useState<Set<string>>(() => new Set());
  const [q, setQ] = useState('');
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ label: string; description: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const added = [...draft].filter((k) => !t.permissions.includes(k));
  const removed = t.permissions.filter((k) => !draft.has(k));
  const dirty = added.length + removed.length > 0;
  const members = people.filter((p) => p.role === t.role);
  const needle = q.trim().toLowerCase();
  const matches = (k: string) => { const p = PERM.get(k)!; return !needle || `${p.label} ${p.description} ${p.category}`.toLowerCase().includes(needle); };
  const refresh = () => { for (const k of ['admin-users', 'admin-user', 'staff', 'me']) qc.invalidateQueries({ queryKey: [k] }); };

  const toggle = (k: string) => canEdit && setDraft((d) => { const n = new Set(d); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const save = async (ok = false) => {
    setBusy('save');
    try {
      await api.put(`/admin/roles/${t.role}`, { permissions: [...draft], confirm: ok });
      toast(`${t.label} saved. It applies to everyone using it on their next click.`);
      setConfirm(null);
      refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_required') setConfirm((e.details as any)?.sensitive ?? []);
      else toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const rename = async () => {
    if (!renaming) return;
    setBusy('rename');
    try {
      await api.patch(`/admin/roles/${t.role}`, { label: renaming.label, description: renaming.description || null });
      toast('Template renamed');
      setRenaming(null);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('delete');
    try {
      await api.del(`/admin/roles/${t.role}`);
      toast(`“${t.label}” deleted`);
      refresh();
      onBack();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4 pb-4">
      <button type="button" onClick={onBack} className="inline-flex min-h-[44px] items-center gap-1.5 text-[14px] text-stone hover:text-ink"><ArrowLeft className="h-4 w-4" />All templates</button>

      <div className="panel p-4 sm:p-5">
        {renaming ? (
          <div className="space-y-3">
            <Field label="Name"><input className="field" value={renaming.label} maxLength={40} onChange={(e) => setRenaming({ ...renaming, label: e.target.value })} /></Field>
            <Field label="Description"><input className="field" value={renaming.description} maxLength={200} onChange={(e) => setRenaming({ ...renaming, description: e.target.value })} /></Field>
            <div className="flex gap-2"><Button variant="primary" loading={busy === 'rename'} disabled={!renaming.label.trim()} onClick={rename}>Save</Button><Button variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button></div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="h-display text-[26px] leading-tight"><Tc>{t.label}</Tc></h2>
              <Badge tone={t.builtin ? 'neutral' : 'plum'}>{t.builtin ? 'Built-in' : 'Custom'}</Badge>
            </div>
            {t.description && <p className="mt-1 text-[14px] text-stone">{t.description}</p>}
            <p className="mt-1 text-[13px] text-stone">{draft.size} permissions · {t.members} active {t.members === 1 ? 'person' : 'people'}</p>
            {canEdit && !t.builtin && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" icon={<Pencil className="h-4 w-4" />} onClick={() => setRenaming({ label: t.label, description: t.description })}>Rename</Button>
                <Button size="sm" variant="ghost" className="text-rose" icon={<Trash2 className="h-4 w-4" />} disabled={t.totalMembers > 0} onClick={() => setDeleting(true)}>Delete</Button>
                {t.totalMembers > 0 && <span className="self-center text-[12px] text-stone">Move its {t.totalMembers} {t.totalMembers === 1 ? 'person' : 'people'} to another template to delete it.</span>}
              </div>
            )}
          </>
        )}
      </div>

      <Members t={t} members={members} people={people} canEdit={canEdit} selfId={me?.id} onChanged={refresh} />

      <div className="panel p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px] font-medium text-ink"><Tc>Permissions</Tc></h3>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpenCats(new Set(openCats.size ? [] : PERMISSION_CATEGORIES))}>{openCats.size ? 'Collapse all' : 'Expand all'}</Button>
            {canEdit && t.builtin && <Button size="sm" variant="ghost" onClick={() => setDraft(new Set(t.defaults))}>Built-in defaults</Button>}
          </div>
        </div>
        <label className="relative mb-3 block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone" />
          <input className="field h-10 pl-9" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a permission" aria-label="Find a permission" />
        </label>
        <div className="space-y-2">
          {PERMISSION_CATEGORIES.map((cat) => {
            const items = PERMISSIONS_CATALOG.filter((p) => p.category === cat && matches(p.key));
            if (!items.length) return null;
            const all = PERMISSIONS_CATALOG.filter((p) => p.category === cat);
            const on = all.filter((p) => draft.has(p.key)).length;
            const expanded = !!needle || openCats.has(cat);
            return (
              <div key={cat} className="overflow-hidden rounded-xl border border-line bg-white">
                <button type="button" aria-expanded={expanded} onClick={() => setOpenCats((s) => { const n = new Set(s); if (n.has(cat)) n.delete(cat); else n.add(cat); return n; })}
                  className="flex min-h-[52px] w-full items-center gap-2 px-3 text-left active:bg-mist">
                  {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-stone" /> : <ChevronRight className="h-4 w-4 shrink-0 text-stone" />}
                  <span className="flex-1 text-[14px] font-medium text-ink">{cat}</span>
                  <span className={cx('rounded-full px-2 py-0.5 text-[12px]', on ? 'bg-sage-tint text-sage' : 'bg-mist text-stone')}>{on} of {all.length}</span>
                </button>
                {expanded && (
                  <ul className="divide-y divide-line border-t border-line">
                    {items.map((p) => {
                      const checked = draft.has(p.key);
                      return (
                        <li key={p.key}>
                          <button type="button" role="switch" aria-checked={checked} disabled={!canEdit} onClick={() => toggle(p.key)}
                            className="flex min-h-[56px] w-full items-center gap-3 px-3 py-2.5 text-left active:bg-mist disabled:cursor-default">
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-1.5 text-[14px] text-ink">
                                {p.label}
                                <Badge>{ACTION_LABEL[p.action]}</Badge>
                                {p.sensitive && <Badge tone="amber">Sensitive</Badge>}
                                {added.includes(p.key) && <Badge tone="sage">Adding</Badge>}
                                {removed.includes(p.key) && <Badge tone="rose">Removing</Badge>}
                              </span>
                              <span className="block text-[12px] leading-snug text-stone">{p.description}</span>
                            </span>
                            <span className={cx('relative inline-flex h-7 w-12 shrink-0 rounded-full transition-colors', checked ? 'bg-sage' : 'bg-line-strong')}>
                              <span className={cx('absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {canEdit && dirty && (
        <div className="sticky bottom-[calc(68px+env(safe-area-inset-bottom))] z-20 flex items-center gap-2 rounded-xl2 border border-line bg-white p-3 shadow-pop backdrop-blur lg:bottom-4">
          <span className="flex-1 text-[13px] text-amber">{added.length} adding · {removed.length} removing</span>
          <Button variant="ghost" onClick={() => setDraft(new Set(t.permissions))}>Discard</Button>
          <Button variant="primary" loading={busy === 'save'} onClick={() => save()}>Save</Button>
        </div>
      )}

      {confirm && (
        <Modal open onClose={() => setConfirm(null)} title="Confirm sensitive access" footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Back</Button><Button variant="primary" onClick={() => save(true)} loading={busy === 'save'}>Confirm and save</Button></>}>
          <p className="text-[15px] text-ink-soft">Everyone using {t.label} ({t.members}) will get: <b>{confirm.map((k) => PERM.get(k)?.label ?? k).join(', ')}</b>.</p>
        </Modal>
      )}
      {deleting && (
        <Modal open onClose={() => setDeleting(false)} title={`Delete “${t.label}”?`} footer={<><Button variant="ghost" onClick={() => setDeleting(false)}>Cancel</Button><Button variant="danger" loading={busy === 'delete'} onClick={remove}>Delete template</Button></>}>
          <p className="text-[15px] text-ink-soft">Nobody uses it, so no one’s access changes.</p>
        </Modal>
      )}
    </div>
  );
}

/** Who uses this template, and assigning it to someone else (the same change as picking a role on their account). */
function Members({ t, members, people, canEdit, selfId, onChanged }: { t: RoleTemplateDTO; members: StaffAccountDTO[]; people: StaffAccountDTO[]; canEdit: boolean; selfId?: string; onChanged: () => void }) {
  const toast = useToast();
  const [pick, setPick] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const others = useMemo(() => people.filter((p) => p.role !== t.role && p.id !== selfId && (p.status === 'active' || p.status === 'disabled')), [people, t.role, selfId]);
  const chosen = others.find((p) => p.id === pick);
  const assign = async (ok = false) => {
    if (!chosen) return;
    setBusy(true);
    try {
      await api.put(`/admin/users/${chosen.id}/access`, { role: t.role, confirm: ok });
      toast(`${chosen.name} now uses ${t.label}.`);
      setPick('');
      setConfirm(false);
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_required') setConfirm(true);
      else toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel p-4 sm:p-5">
      <h3 className="mb-2 text-[15px] font-medium text-ink"><Tc>People using it</Tc></h3>
      {members.length === 0 ? <EmptyState title="Nobody yet">Assign it below, or choose it when approving a new login.</EmptyState> : (
        <ul className="-mx-1 divide-y divide-line">
          {members.map((m) => (
            <li key={m.id} className="flex min-h-[52px] items-center gap-3 px-1 py-2">
              <Avatar name={m.name} color={m.color} size="sm" />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{m.name}</span>
              {m.overrideCount > 0 && <Badge tone="plum">{m.overrideCount} custom</Badge>}
              {m.status !== 'active' && <StatusBadge s={m.status} />}
            </li>
          ))}
        </ul>
      )}
      {canEdit && others.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <span className="label">Assign to Someone</span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select className="field h-11" value={pick} onChange={(e) => { setPick(e.target.value); setConfirm(false); }}>
              <option value="">Choose a person…</option>
              {others.map((p) => <option key={p.id} value={p.id}>{p.name} (now {p.roleLabel})</option>)}
            </select>
            <Button variant="primary" className="h-11" icon={<UserPlus className="h-4 w-4" />} disabled={!chosen} loading={busy} onClick={() => assign(confirm)}>{confirm ? 'Confirm and assign' : 'Assign'}</Button>
          </div>
          <p className="mt-1.5 text-[12px] text-stone">Extra permissions given to them individually are removed when their template changes, so nothing carries over by accident.</p>
          {confirm && <p className="mt-2 flex items-start gap-2 rounded-lg bg-amber/10 px-3 py-2 text-[13px] text-ink-soft"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber" />{t.label} includes sensitive access. Click “Confirm and assign” if that’s intended.</p>}
        </div>
      )}
    </div>
  );
}
