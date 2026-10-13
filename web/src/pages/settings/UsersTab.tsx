import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_ROLE, PERMISSIONS_CATALOG, PERMISSION_CATEGORIES, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES,
  type PermissionPreviewDTO, type Role, type RoleTemplateDTO, type StaffAccountDTO, type StaffAccountDetailDTO,
} from '@addendum/shared';
import { AlertTriangle, Copy, KeyRound, Link2, RotateCcw, ShieldAlert, ShieldCheck, UserPlus } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { useCanDo, useMe } from '../../api/hooks';
import { relative } from '../../lib/format';
import { Avatar, Badge, Button, Field, Modal, Segmented, Spinner, Toggle, cx, useToast } from '../../components/ui';
import { Card } from './shared';

const ACTION_LABEL: Record<string, string> = { view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', approve: 'Approve', export: 'Export' };
const PERM = new Map(PERMISSIONS_CATALOG.map((p) => [p.key, p]));
const label = (k: string) => PERM.get(k)?.label ?? k;

type UsersData = { users: StaffAccountDTO[]; roles: RoleTemplateDTO[] };

/** Settings → Users & Permissions. Every rule is enforced by the server; this screen explains and previews them. */
export function UsersSettings() {
  const canDo = useCanDo();
  const { data, isLoading } = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get<UsersData>('/admin/users') });
  const [view, setView] = useState<'people' | 'roles'>('people');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  if (isLoading || !data) return <div className="flex justify-center py-10"><Spinner /></div>;
  const people = data.users.filter((u) => showInactive || u.active);

  return (
    <div className="space-y-5">
      <Segmented value={view} onChange={setView} options={[{ value: 'people', label: 'Employees' }, ...(canDo('users:permissions') ? [{ value: 'roles' as const, label: 'Role templates' }] : [])]} />
      {view === 'people' ? (
        <Card
          title="Employees"
          description="Everyone has their own sign-in. New accounts start as Assistant; change the role or individual permissions any time."
          footer={canDo('users:manage') && <Button variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add employee</Button>}
        >
          <div className="mb-2 flex justify-end"><Toggle checked={showInactive} onChange={setShowInactive} label="Show deactivated" /></div>
          <ul className="divide-y divide-line">
            {people.map((u) => (
              <li key={u.id}>
                <button onClick={() => setOpen(u.id)} className="flex w-full items-center gap-3 py-3 text-left hover:bg-mist/40 sm:px-2">
                  <Avatar name={u.name} color={u.color} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-ink">{u.name}</span>
                      <Badge tone={u.role === 'admin' ? 'ink' : 'neutral'}>{ROLE_LABELS[u.role]}</Badge>
                      {u.overrideCount > 0 && <Badge tone="plum">{u.overrideCount} custom</Badge>}
                      {!u.active && <Badge tone="rose">Deactivated</Badge>}
                      {u.active && !u.canSignIn && <Badge tone="amber">No password yet</Badge>}
                    </span>
                    <span className="block truncate text-[13px] text-stone">
                      {u.email ?? 'No email'} · {u.effectiveCount} permissions{u.sensitiveCount ? ` · ${u.sensitiveCount} sensitive` : ''} · {u.lastLoginAt ? `signed in ${relative(u.lastLoginAt)}` : 'never signed in'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <RoleTemplates roles={data.roles} />
      )}
      {open && <UserDetail id={open} onClose={() => setOpen(null)} />}
      {adding && <AddEmployee onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddEmployee({ onClose }: { onClose: () => void }) {
  const canDo = useCanDo();
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', role: DEFAULT_ROLE as Role, squareTeamMemberId: '', sendInvite: true });
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ link: string; emailed: boolean; expiresAt: string } | null>(null);
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.post<{ setupLink: string; emailed: boolean; expiresAt: string }>('/admin/users', {
        name: form.name, email: form.email, role: form.role, squareTeamMemberId: form.squareTeamMemberId || null, sendInvite: form.sendInvite, confirm,
      });
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      qc.invalidateQueries({ queryKey: ['staff'] });
      setDone({ link: r.setupLink, emailed: r.emailed, expiresAt: r.expiresAt });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_required') setConfirm(true);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  if (done) {
    return (
      <Modal open onClose={onClose} title="Account created" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <p className="text-[15px] text-ink-soft">{done.emailed ? `We emailed ${form.name.split(' ')[0]} a link to choose their password.` : 'Email isn’t set up, so share this link with them yourself.'} The link works once and expires {relative(done.expiresAt)}.</p>
        <LinkBox link={done.link} />
        <p className="mt-2 text-[12px] text-stone">This link is shown only now. You can create a new one later from their account.</p>
      </Modal>
    );
  }
  return (
    <Modal open onClose={onClose} title="Add employee" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={saving}>{confirm ? 'Confirm and create' : 'Create account'}</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name"><input className="field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email (their sign-in)"><input type="email" className="field" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        </div>
        <Field label="Role" hint={canDo('users:permissions') ? ROLE_DESCRIPTIONS[form.role] : 'New accounts start as Assistant. An administrator who can assign roles can change it.'}>
          <select className="field" value={form.role} disabled={!canDo('users:permissions')} onChange={(e) => { setForm({ ...form, role: e.target.value as Role }); setConfirm(false); }}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}{r === DEFAULT_ROLE ? ' (default)' : ''}</option>)}
          </select>
        </Field>
        {confirm && <p className="flex items-start gap-2 rounded-lg bg-amber/10 px-3 py-2 text-[13px] text-ink-soft"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber" />Admin includes sensitive access: API keys, payroll and commission, exports and user management. Click “Confirm and create” if that’s intended.</p>}
        <Field label="Square team member ID (optional)" hint="Links their Square bookings and sales (for My Calendar and commission). Square imports team members automatically too.">
          <input className="field font-mono text-[13px]" value={form.squareTeamMemberId} onChange={(e) => setForm({ ...form, squareTeamMemberId: e.target.value })} />
        </Field>
        <Toggle checked={form.sendInvite} onChange={(v) => setForm({ ...form, sendInvite: v })} label="Email them a link to choose a password" description="If email isn’t set up you’ll get a link to share instead." />
      </div>
    </Modal>
  );
}

function LinkBox({ link }: { link: string }) {
  const toast = useToast();
  return (
    <div className="mt-3 flex gap-2">
      <code className="flex-1 truncate rounded-lg border border-line bg-mist/60 px-3 py-2 text-[12px]">{link}</code>
      <Button size="sm" icon={<Copy className="h-4 w-4" />} onClick={() => navigator.clipboard?.writeText(link).then(() => toast('Link copied'), () => toast('Copy failed — select the text instead', 'error'))}>Copy</Button>
    </div>
  );
}

type Choice = 'role' | 'allow' | 'deny';

function UserDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const canDo = useCanDo();
  const { data: me } = useMe();
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['admin-user', id], queryFn: () => api.get<{ user: StaffAccountDetailDTO }>(`/admin/users/${id}`).then((r) => r.user) });
  const roles = qc.getQueryData<UsersData>(['admin-users'])?.roles ?? [];
  const [role, setRole] = useState<Role | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [clearRestrictions, setClearRestrictions] = useState(false);
  const [preview, setPreview] = useState<{ p: PermissionPreviewDTO; body: object } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [account, setAccount] = useState<{ name: string; email: string; squareTeamMemberId: string; color: string } | null>(null);
  const [link, setLink] = useState<{ link: string; emailed: boolean } | null>(null);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [filter, setFilter] = useState<'all' | 'on' | 'custom'>('all');

  const self = me?.id === id;
  const canPerms = canDo('users:permissions') && !self;
  const u = data;
  const roleNow = role ?? u?.role ?? 'assistant';
  const template = useMemo(() => new Set(roles.find((r) => r.role === roleNow)?.permissions ?? []), [roles, roleNow]);
  if (isLoading || !u) return <Modal open onClose={onClose} title="Loading…" side><div className="flex justify-center py-10"><Spinner /></div></Modal>;

  const current = new Map(u.permissions.map((p) => [p.key, p]));
  const choiceOf = (k: string): Choice => choices[k] ?? (current.get(k)?.override === true ? 'allow' : current.get(k)?.override === false ? 'deny' : 'role');
  const effectiveOf = (k: string) => { const c = choiceOf(k); return c === 'allow' ? true : c === 'deny' ? false : template.has(k); };
  const roleChanged = role !== null && role !== u.role;
  const dirty = roleChanged || Object.keys(choices).length > 0;

  const body = (extra: object = {}) => {
    const overrides: Record<string, boolean | null> = {};
    for (const [k, c] of Object.entries(choices)) overrides[k] = c === 'role' ? null : c === 'allow';
    return { ...(roleChanged ? { role } : {}), overrides, clearRestrictions, ...extra };
  };
  const reload = () => {
    qc.invalidateQueries({ queryKey: ['admin-user', id] });
    qc.invalidateQueries({ queryKey: ['admin-users'] });
    qc.invalidateQueries({ queryKey: ['staff'] });
  };
  const doPreview = async (extra: object = {}) => {
    setBusy('preview');
    try {
      const b = body(extra);
      const r = await api.post<{ preview: PermissionPreviewDTO }>(`/admin/users/${id}/access/preview`, b);
      setPreview({ p: r.preview, body: b });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy('apply');
    try {
      await api.put(`/admin/users/${id}/access`, { ...preview.body, confirm: true });
      toast('Access updated — it applies on their next click.');
      setPreview(null);
      setChoices({});
      setRole(null);
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const saveAccount = async () => {
    if (!account) return;
    setBusy('account');
    try {
      await api.patch(`/admin/users/${id}`, { name: account.name, email: account.email, color: account.color, squareTeamMemberId: account.squareTeamMemberId || null });
      toast('Account saved');
      setAccount(null);
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const setStatus = async () => {
    setBusy('status');
    try {
      await api.post(`/admin/users/${id}/${u.active ? 'deactivate' : 'reactivate'}`);
      toast(u.active ? `${u.name} was deactivated and signed out.` : `${u.name} can sign in again.`);
      setConfirmStatus(false);
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const passwordLink = async () => {
    setBusy('link');
    try {
      setLink(await api.post<{ link: string; emailed: boolean }>(`/admin/users/${id}/password-link`));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const visible = PERMISSIONS_CATALOG.filter((p) => filter === 'all' || (filter === 'on' ? effectiveOf(p.key) : choiceOf(p.key) !== 'role'));

  return (
    <Modal open onClose={onClose} side wide title={u.name} footer={
      canPerms ? (
        <>
          {dirty && <span className="mr-auto text-[13px] text-amber">Unsaved changes</span>}
          {u.overrideCount > 0 && !dirty && <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={() => doPreview({ resetToRole: true, overrides: {} })} loading={busy === 'preview'}>Reset to role defaults</Button>}
          {dirty && <Button variant="ghost" onClick={() => { setChoices({}); setRole(null); }}>Discard</Button>}
          <Button variant="primary" disabled={!dirty} onClick={() => doPreview()} loading={busy === 'preview'}>Review changes</Button>
        </>
      ) : undefined
    }>
      <div className="space-y-6">
        {self && <p className="rounded-lg bg-mist px-3 py-2 text-[13px] text-ink-soft">This is your own account. Another administrator has to change your role, permissions or status.</p>}

        <section>
          <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone">Account</h3>
          {account ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name"><input className="field" value={account.name} onChange={(e) => setAccount({ ...account, name: e.target.value })} /></Field>
              <Field label="Email"><input className="field" value={account.email} onChange={(e) => setAccount({ ...account, email: e.target.value })} /></Field>
              <Field label="Square team member ID"><input className="field font-mono text-[13px]" value={account.squareTeamMemberId} onChange={(e) => setAccount({ ...account, squareTeamMemberId: e.target.value })} /></Field>
              <Field label="Calendar colour"><input type="color" className="field h-10 p-1" value={account.color} onChange={(e) => setAccount({ ...account, color: e.target.value })} /></Field>
              <div className="flex gap-2 sm:col-span-2"><Button variant="primary" size="sm" onClick={saveAccount} loading={busy === 'account'}>Save</Button><Button size="sm" variant="ghost" onClick={() => setAccount(null)}>Cancel</Button></div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-[14px]">
              <span className="text-ink-soft">{u.email ?? 'No email'}</span>
              <Badge tone={u.active ? 'sage' : 'rose'}>{u.active ? 'Active' : 'Deactivated'}</Badge>
              <span className="text-[13px] text-stone">{u.squareTeamMemberId ? 'Linked to Square' : 'Not linked to Square'} · {u.lastLoginAt ? `last sign-in ${relative(u.lastLoginAt)}` : 'never signed in'}</span>
              {canDo('users:manage') && (
                <span className="flex w-full flex-wrap gap-2 pt-1">
                  <Button size="sm" onClick={() => setAccount({ name: u.name, email: u.email ?? '', squareTeamMemberId: u.squareTeamMemberId ?? '', color: u.color })}>Edit details</Button>
                  {u.active && <Button size="sm" icon={<KeyRound className="h-4 w-4" />} onClick={passwordLink} loading={busy === 'link'}>{u.canSignIn ? 'Password reset link' : 'Set-up link'}</Button>}
                  {!self && <Button size="sm" variant={u.active ? 'ghost' : 'secondary'} className={u.active ? 'text-rose' : ''} onClick={() => setConfirmStatus(true)}>{u.active ? 'Deactivate' : 'Reactivate'}</Button>}
                </span>
              )}
            </div>
          )}
          {link && (
            <div className="mt-3 rounded-lg border border-line bg-white p-3 text-[13px]">
              <p className="flex items-center gap-1.5 text-ink-soft"><Link2 className="h-4 w-4" />{link.emailed ? 'Emailed to them. You can also share it:' : 'Email isn’t set up — share this link with them:'}</p>
              <LinkBox link={link.link} />
              <p className="mt-1 text-[12px] text-stone">Works once. Any older link stops working. Setting a password signs them out everywhere else.</p>
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone">Role</h3>
          <select className="field max-w-xs" value={roleNow} disabled={!canPerms} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
          <p className="mt-1 text-[13px] text-stone">{ROLE_DESCRIPTIONS[roleNow]}</p>
          {roleChanged && (
            <div className="mt-2 rounded-lg bg-amber/10 px-3 py-2 text-[13px] text-ink-soft">
              Changing the role removes the extra permissions given to {u.name.split(' ')[0]} individually, so nothing carries over by accident.
              <Toggle checked={clearRestrictions} onChange={setClearRestrictions} label="Also clear individual restrictions" />
            </div>
          )}
        </section>

        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold uppercase tracking-wide text-stone">Permissions</h3>
            <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'on', label: 'Allowed' }, { value: 'custom', label: 'Custom only' }]} />
          </div>
          <p className="mb-3 text-[12px] text-stone">“Role” follows the {ROLE_LABELS[roleNow]} template. “Allow” or “Deny” applies to {u.name.split(' ')[0]} only — no one else with this role is affected.</p>
          {PERMISSION_CATEGORIES.map((cat) => {
            const items = visible.filter((p) => p.category === cat);
            if (!items.length) return null;
            return (
              <div key={cat} className="mb-4">
                <p className="mb-1 text-[13px] font-medium text-ink">{cat}</p>
                <div className="divide-y divide-line rounded-xl border border-line bg-white">
                  {items.map((p) => {
                    const c = choiceOf(p.key);
                    const on = effectiveOf(p.key);
                    return (
                      <div key={p.key} className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <span className={cx('h-2 w-2 shrink-0 rounded-full', on ? 'bg-sage' : 'bg-line-strong')} aria-label={on ? 'Allowed' : 'Not allowed'} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5 text-[14px] text-ink">
                            {p.label}
                            <Badge>{ACTION_LABEL[p.action]}</Badge>
                            {p.sensitive && <Badge tone="amber">Sensitive</Badge>}
                            {c !== 'role' && <Badge tone="plum">Custom</Badge>}
                          </span>
                          <span className="block text-[12px] text-stone">{p.description} {c === 'role' && <>· role default: {template.has(p.key) ? 'allowed' : 'not included'}</>}</span>
                        </span>
                        <div className="flex overflow-hidden rounded-lg border border-line text-[12px]">
                          {(['role', 'allow', 'deny'] as Choice[]).map((x) => (
                            <button key={x} disabled={!canPerms} onClick={() => setChoices({ ...choices, [p.key]: x })}
                              className={cx('px-2.5 py-1', c === x ? (x === 'deny' ? 'bg-rose text-white' : x === 'allow' ? 'bg-sage text-white' : 'bg-ink text-white') : 'bg-white text-ink-soft hover:bg-mist', !canPerms && 'cursor-not-allowed opacity-60')}>
                              {x === 'role' ? 'Role' : x === 'allow' ? 'Allow' : 'Deny'}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </section>
      </div>

      {preview && (
        <Modal open onClose={() => setPreview(null)} title="Review changes" footer={<><Button variant="ghost" onClick={() => setPreview(null)}>Back</Button><Button variant="primary" onClick={apply} loading={busy === 'apply'}>{preview.p.sensitiveAdded.length ? 'Confirm sensitive access and save' : 'Save'}</Button></>}>
          <div className="space-y-3 text-[14px]">
            {preview.p.added.length === 0 && preview.p.removed.length === 0 && <p className="text-stone">No change to what {u.name.split(' ')[0]} can do.</p>}
            {preview.p.added.length > 0 && <div><p className="font-medium text-sage">Will be able to</p><ul className="mt-1 list-disc pl-5 text-ink-soft">{preview.p.added.map((k) => <li key={k}>{label(k)}{PERM.get(k)?.sensitive && <Badge tone="amber" className="ml-1.5">Sensitive</Badge>}</li>)}</ul></div>}
            {preview.p.removed.length > 0 && <div><p className="font-medium text-rose">Will no longer be able to</p><ul className="mt-1 list-disc pl-5 text-ink-soft">{preview.p.removed.map((k) => <li key={k}>{label(k)}</li>)}</ul></div>}
            {preview.p.droppedOverrides.length > 0 && <p className="text-[13px] text-stone">Individual settings cleared: {preview.p.droppedOverrides.map(label).join(', ')}.</p>}
            {preview.p.sensitiveAdded.length > 0 && (
              <p className="flex items-start gap-2 rounded-lg bg-amber/10 px-3 py-2 text-[13px] text-ink-soft"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" />This gives sensitive access ({preview.p.sensitiveAdded.map(label).join(', ')}). Only confirm if {u.name.split(' ')[0]} needs it.</p>
            )}
            <p className="flex items-center gap-1.5 text-[12px] text-stone"><ShieldCheck className="h-4 w-4" />After saving: {preview.p.effective.length} permissions. Recorded in the activity log.</p>
          </div>
        </Modal>
      )}
      {confirmStatus && (
        <Modal open onClose={() => setConfirmStatus(false)} title={u.active ? `Deactivate ${u.name}?` : `Reactivate ${u.name}?`} footer={<><Button variant="ghost" onClick={() => setConfirmStatus(false)}>Cancel</Button><Button variant={u.active ? 'danger' : 'primary'} onClick={setStatus} loading={busy === 'status'}>{u.active ? 'Deactivate' : 'Reactivate'}</Button></>}>
          <p className="text-[15px] text-ink-soft">{u.active ? 'They’re signed out immediately and can’t sign in. Their history, appointments and commission records are kept.' : 'They can sign in again with their existing password and permissions.'}</p>
        </Modal>
      )}
    </Modal>
  );
}

function RoleTemplates({ roles }: { roles: RoleTemplateDTO[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [role, setRole] = useState<Role>('assistant');
  const t = roles.find((r) => r.role === role)!;
  const [draft, setDraft] = useState<Record<Role, Set<string>>>(() => Object.fromEntries(roles.map((r) => [r.role, new Set(r.permissions)])) as Record<Role, Set<string>>);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const set = draft[role];
  const added = [...set].filter((k) => !t.permissions.includes(k));
  const removed = t.permissions.filter((k) => !set.has(k));
  const toggle = (k: string) => setDraft({ ...draft, [role]: new Set(set.has(k) ? [...set].filter((x) => x !== k) : [...set, k]) });
  const save = async (ok = false) => {
    setSaving(true);
    try {
      await api.put(`/admin/roles/${role}`, { permissions: [...set], confirm: ok });
      toast(`${ROLE_LABELS[role]} template saved. It applies to everyone with this role (individual custom settings are kept).`);
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_required') setConfirm((e.details as any)?.sensitive ?? []);
      else toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card title="Role templates" description="Starting points for each role. Changing a template affects everyone with that role, except where someone has their own custom setting."
      footer={<>
        {(added.length > 0 || removed.length > 0) && <span className="mr-auto text-[13px] text-amber">{added.length} added · {removed.length} removed</span>}
        <Button variant="ghost" onClick={() => setDraft({ ...draft, [role]: new Set(t.defaults) })}>Built-in defaults</Button>
        <Button variant="primary" disabled={!added.length && !removed.length} loading={saving} onClick={() => save()}>Save template</Button>
      </>}>
      <Segmented className="mb-3" value={role} onChange={setRole} options={ROLES.map((r) => ({ value: r, label: `${ROLE_LABELS[r]} (${roles.find((x) => x.role === r)?.members ?? 0})` }))} />
      <p className="mb-3 text-[13px] text-stone">{ROLE_DESCRIPTIONS[role]}</p>
      {PERMISSION_CATEGORIES.map((cat) => (
        <div key={cat} className="mb-3">
          <p className="mb-1 text-[13px] font-medium text-ink">{cat}</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {PERMISSIONS_CATALOG.filter((p) => p.category === cat).map((p) => (
              <label key={p.key} className="flex items-start gap-2 rounded-lg px-2 py-1 hover:bg-mist/50">
                <input type="checkbox" className="mt-1" checked={set.has(p.key)} onChange={() => toggle(p.key)} />
                <span className="text-[13px]"><span className="text-ink">{p.label}</span> <span className="text-stone">· {ACTION_LABEL[p.action]}</span>{p.sensitive && <Badge tone="amber" className="ml-1">Sensitive</Badge>}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      {confirm && (
        <Modal open onClose={() => setConfirm(null)} title="Confirm sensitive access" footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Back</Button><Button variant="primary" onClick={() => save(true)} loading={saving}>Confirm and save</Button></>}>
          <p className="text-[15px] text-ink-soft">Everyone with the {ROLE_LABELS[role]} role ({t.members}) will get: <b>{confirm.map(label).join(', ')}</b>.</p>
        </Modal>
      )}
    </Card>
  );
}
