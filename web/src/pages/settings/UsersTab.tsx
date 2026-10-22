import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACCOUNT_STATUS_LABEL, DEFAULT_ROLE, PERMISSIONS_CATALOG, PERMISSION_CATEGORIES,
  type AccountStatus, type PermissionPreviewDTO, type Role, type RoleTemplateDTO, type SquareTeamMemberOptionDTO, type StaffAccountDTO, type StaffAccountDetailDTO,
} from '@addendum/shared';
import { AlertTriangle, ArrowLeft, ChevronRight, Clock, Copy, KeyRound, Layers, Link2, RotateCcw, ShieldAlert, ShieldCheck, UserCheck, UserPlus, UserX } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { useCanDo, useMe, useStaff } from '../../api/hooks';
import { useReauth } from '../../components/domain/Reauth';
import { phone, relative } from '../../lib/format';
import { Avatar, Badge, Button, Field, Modal, Segmented, Spinner, Toggle, cx, useToast } from '../../components/ui';
import { Card, useSection } from './shared';
import { StaffCommissionRates } from './CommissionTab';
import { WagesSection } from './WagesSection';
import { ScheduleSection } from './ScheduleSection';
import { ShiftsList } from '../../components/domain/Shifts';

const daysAgoKey = (n: number) => { const d = new Date(Date.now() - n * 86400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
import { PayGate } from '../../components/domain/PayGate';
import { Tc } from '../../lib/titleCase';

const ACTION_LABEL: Record<string, string> = { view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', approve: 'Approve', export: 'Export' };
const PERM = new Map(PERMISSIONS_CATALOG.map((p) => [p.key, p]));
const label = (k: string) => PERM.get(k)?.label ?? k;

export type UsersData = { users: StaffAccountDTO[]; roles: RoleTemplateDTO[]; canApprove: boolean };
export const useUsersData = () => useQuery({ queryKey: ['admin-users'], queryFn: () => api.get<UsersData>('/admin/users') });

const STATUS_TONE: Record<AccountStatus, 'sage' | 'amber' | 'rose' | 'neutral'> = { active: 'sage', pending: 'amber', rejected: 'rose', disabled: 'rose' };
export const StatusBadge = ({ s }: { s: AccountStatus }) => <Badge tone={STATUS_TONE[s]}>{ACCOUNT_STATUS_LABEL[s]}</Badge>;

/** Settings → Users & Permissions. Every rule is enforced by the server; this screen explains and previews them. */
export function UsersSettings() {
  const canDo = useCanDo();
  const [params, setParams] = useSearchParams();
  const { data, isLoading } = useUsersData();
  const [open, setOpenState] = useState<string | null>(() => params.get('open'));
  const setOpen = (id: string | null) => {
    setOpenState(id);
    if (!id && params.get('open')) { const p = new URLSearchParams(params); p.delete('open'); setParams(p, { replace: true }); }
  };
  const [adding, setAdding] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  if (isLoading || !data) return <div className="flex justify-center py-10"><Spinner /></div>;
  const pending = data.users.filter((u) => u.status === 'pending');
  const people = data.users.filter((u) => u.status !== 'pending' && (showInactive || u.status === 'active'));
  const goRoles = () => { const p = new URLSearchParams(params); p.set('tab', 'roles'); p.delete('open'); setParams(p, { replace: true }); };

  // A team member opens as a full page (tabs for account, permissions, pay and taxes) in place of the list.
  if (open) return <UserDetail id={open} onClose={() => setOpen(null)} />;

  return (
    <div className="space-y-5">
      {pending.length > 0 && (
        <Card
          title={<span className="flex items-center gap-2"><Clock className="h-5 w-5 text-amber" />Waiting for approval ({pending.length})</span>}
          description={data.canApprove
            ? 'They have a login but can’t see anything yet. Choose their role template, then approve — or reject the request.'
            : 'They can’t use the CRM until an Admin approves them.'}
        >
          <ul className="divide-y divide-line">
            {pending.map((u) => <li key={u.id} className="py-3"><PendingRow u={u} roles={data.roles} canApprove={data.canApprove} onOpen={() => setOpen(u.id)} /></li>)}
          </ul>
        </Card>
      )}
      <Card
        title="Employees"
        description="Everyone has their own sign-in, separate from Square. New logins wait for an Admin’s approval; then their role template decides what they can do."
        footer={canDo('users:manage') && <Button variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add employee</Button>}
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          {canDo('users:permissions') ? <Button size="sm" variant="ghost" icon={<Layers className="h-4 w-4" />} onClick={goRoles}>Role templates</Button> : <span />}
          <Toggle checked={showInactive} onChange={setShowInactive} label="Show deactivated & rejected" />
        </div>
        <ul className="divide-y divide-line">
          {people.map((u) => (
              <li key={u.id}>
                <button onClick={() => setOpen(u.id)} className="flex w-full items-center gap-3 py-3 text-left hover:bg-mist/40 sm:px-2">
                  <Avatar name={u.name} color={u.color} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-ink">{u.name}</span>
                      <Badge tone={u.role === 'admin' ? 'ink' : 'neutral'}>{u.roleLabel}</Badge>
                      {u.overrideCount > 0 && <Badge tone="plum">{u.overrideCount} custom</Badge>}
                      {u.status !== 'active' && <StatusBadge s={u.status} />}
                      {u.status === 'active' && !u.canSignIn && <Badge tone="amber">No password yet</Badge>}
                    </span>
                    <span className="block truncate text-[13px] text-stone">
                      {u.email ?? 'No email'}{u.mobilePhone ? ` · ${phone(u.mobilePhone)}` : ' · no mobile'} · {u.effectiveCount} permissions{u.sensitiveCount ? ` · ${u.sensitiveCount} sensitive` : ''} · {u.lastLoginAt ? `signed in ${relative(u.lastLoginAt)}` : 'never signed in'}
                    </span>
                  </span>
                </button>
              </li>
          ))}
        </ul>
      </Card>
      {canDo('users:manage') && <AccessRequestsSetting />}
      {adding && <AddEmployee roles={data.roles} canApprove={data.canApprove} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AccessRequestsSetting() {
  const a = useSection('accounts');
  if (!a.draft) return null;
  return (
    <Card title="Requests from the sign-in screen">
      <Toggle
        checked={a.draft.allowAccessRequests}
        onChange={async (v) => { a.set('allowAccessRequests', v); await api.patch('/settings', { accounts: { allowAccessRequests: v } }).catch(() => a.reset()); }}
        label="Let people ask for an account"
        description="Shows “Request access” on the sign-in screen. Requests can’t see anything until an Admin approves them, and Admins are notified."
      />
    </Card>
  );
}

/** A pending login: pick the role template and approve, or reject. Admins only (the server checks too). */
function PendingRow({ u, roles, canApprove, onOpen, onDone }: { u: StaffAccountDTO; roles: RoleTemplateDTO[]; canApprove: boolean; onOpen?: () => void; onDone?: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [role, setRole] = useState<Role>(u.role);
  const [confirm, setConfirm] = useState<'admin' | 'reject' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => {
    for (const k of ['admin-users', 'admin-user', 'staff']) qc.invalidateQueries({ queryKey: [k] });
    onDone?.();
  };
  const approve = async (ok = false) => {
    setBusy('approve');
    try {
      await api.post(`/admin/users/${u.id}/approve`, { role, confirm: ok });
      toast(`${u.name} approved — they can sign in now.`);
      setConfirm(null);
      refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_required') setConfirm('admin');
      else toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const reject = async () => {
    setBusy('reject');
    try {
      await api.post(`/admin/users/${u.id}/reject`);
      toast(`${u.name}’s request was rejected.`);
      setConfirm(null);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const t = roles.find((r) => r.role === role);
  return (
    <div className="space-y-2">
      <button type="button" onClick={onOpen} disabled={!onOpen} className="flex w-full items-center gap-3 text-left">
        <Avatar name={u.name} color={u.color} />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-ink">{u.name}</span>
          <span className="block truncate text-[13px] text-stone">{u.email} · {u.selfRequested ? 'asked for access' : 'added by staff'}{u.requestedAt ? ` ${relative(u.requestedAt)}` : ''}</span>
        </span>
        {onOpen && <ChevronRight className="h-4 w-4 shrink-0 text-stone" />}
      </button>
      {canApprove && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select className="field sm:max-w-[220px]" value={role} onChange={(e) => { setRole(e.target.value); setConfirm(null); }} aria-label={`Role template for ${u.name}`}>
            {roles.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
          </select>
          <div className="flex gap-2">
            <Button variant="primary" className="flex-1 sm:flex-none" icon={<UserCheck className="h-4 w-4" />} loading={busy === 'approve'} onClick={() => approve()}>Approve</Button>
            {u.status === 'pending' && <Button variant="ghost" className="flex-1 text-rose sm:flex-none" icon={<UserX className="h-4 w-4" />} onClick={() => setConfirm('reject')}>Reject</Button>}
          </div>
        </div>
      )}
      {canApprove && t && <p className="text-[12px] text-stone">{t.label}: {t.permissions.length} permissions{t.description ? ` — ${t.description}` : ''}</p>}
      {confirm === 'admin' && (
        <p className="flex flex-wrap items-center gap-2 rounded-lg bg-amber/10 px-3 py-2 text-[13px] text-ink-soft">
          <ShieldAlert className="h-4 w-4 shrink-0 text-amber" />{t?.label} includes sensitive access (keys, payroll, user management…).
          <Button size="sm" variant="primary" loading={busy === 'approve'} onClick={() => approve(true)}>Confirm and approve</Button>
        </p>
      )}
      {confirm === 'reject' && (
        <p className="flex flex-wrap items-center gap-2 rounded-lg bg-rose-tint px-3 py-2 text-[13px] text-ink-soft">
          They won’t be able to sign in. You can still approve them later.
          <Button size="sm" variant="danger" loading={busy === 'reject'} onClick={reject}>Reject request</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
        </p>
      )}
    </div>
  );
}

function AddEmployee({ roles, canApprove, onClose }: { roles: RoleTemplateDTO[]; canApprove: boolean; onClose: () => void }) {
  const canDo = useCanDo();
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', mobilePhone: '', role: DEFAULT_ROLE as Role, squareTeamMemberId: '', sendInvite: true, approveNow: false });
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ link: string; emailed: boolean; expiresAt: string; pending: boolean } | null>(null);
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.post<{ setupLink: string; emailed: boolean; expiresAt: string; user: StaffAccountDTO }>('/admin/users', {
        name: form.name, email: form.email, mobilePhone: form.mobilePhone.trim() || null, role: form.role, squareTeamMemberId: form.squareTeamMemberId || null, sendInvite: form.sendInvite, approveNow: form.approveNow, confirm,
      });
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      qc.invalidateQueries({ queryKey: ['staff'] });
      qc.invalidateQueries({ queryKey: ['square-team-members'] });
      setDone({ link: r.setupLink, emailed: r.emailed, expiresAt: r.expiresAt, pending: r.user.status === 'pending' });
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
        {done.pending && <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber/10 px-3 py-2 text-[13px] text-ink-soft"><Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber" />{form.name.split(' ')[0]} can choose a password, but can’t use the CRM until an Admin approves the account (it’s at the top of Users & Permissions).</p>}
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
        <Field label="Role template" hint={canDo('users:permissions') ? roles.find((r) => r.role === form.role)?.description : 'New accounts start as Assistant. An administrator who can assign roles can change it.'}>
          <select className="field" value={form.role} disabled={!canDo('users:permissions')} onChange={(e) => { setForm({ ...form, role: e.target.value }); setConfirm(false); }}>
            {roles.map((r) => <option key={r.role} value={r.role}>{r.label}{r.role === DEFAULT_ROLE ? ' (default)' : ''}</option>)}
          </select>
        </Field>
        {confirm && <p className="flex items-start gap-2 rounded-lg bg-amber/10 px-3 py-2 text-[13px] text-ink-soft"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber" />Admin includes sensitive access: API keys, payroll and commission, exports and user management. Click “Confirm and create” if that’s intended.</p>}
        <Field label="Mobile (optional)" hint="So the team can text them tasks and notifications."><input className="field" type="tel" value={form.mobilePhone} onChange={(e) => setForm({ ...form, mobilePhone: e.target.value })} placeholder="(619) 555-0100" /></Field>
        <SquareMemberField label="Square team member (optional)" value={form.squareTeamMemberId} onChange={(v) => setForm({ ...form, squareTeamMemberId: v })} />
        <Toggle checked={form.sendInvite} onChange={(v) => setForm({ ...form, sendInvite: v })} label="Email them a link to choose a password" description="If email isn’t set up you’ll get a link to share instead." />
        {canApprove
          ? <Toggle checked={form.approveNow} onChange={(v) => setForm({ ...form, approveNow: v })} label="Approve their access now" description="Off: the account waits in “Waiting for approval” until an Admin approves it." />
          : <p className="text-[13px] text-stone">The account will wait for an Admin’s approval before it can be used.</p>}
      </div>
    </Modal>
  );
}

/**
 * Picks the Square team member an account is linked to (for My Calendar and commission). Lists Square's team by
 * name; falls back to typing the ID when Square isn't connected or can't be reached.
 */
function SquareMemberField({ label, value, userId, onChange }: { label: string; value: string; userId?: string; onChange: (v: string) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['square-team-members'],
    queryFn: () => api.get<{ connected: boolean; error?: string; members: SquareTeamMemberOptionDTO[] }>('/admin/users/square-team-members'),
    staleTime: 60_000,
  });
  const [manual, setManual] = useState(false);
  const members = data?.members ?? [];
  const hint = 'Links their Square bookings and sales (for My Calendar and commission).';
  if (isLoading) return <Field label={label} hint={hint}><select className="field" disabled><option>Loading Square team…</option></select></Field>;
  if (manual || !members.length) {
    const why = !data?.connected ? 'Square isn’t connected, so enter the team member ID.' : data.error ? `Couldn’t load the Square team (${data.error}), so enter the ID.` : '';
    return (
      <Field label={label} hint={why ? `${why} ${hint}` : hint}>
        <input className="field font-mono text-[13px]" value={value} placeholder="Square team member ID" onChange={(e) => onChange(e.target.value.trim())} />
        {members.length > 0 && <button type="button" className="mt-1 text-[12px] text-plum" onClick={() => setManual(false)}>Choose from the Square team</button>}
      </Field>
    );
  }
  const current = members.find((m) => m.id === value);
  const moving = current?.linkedTo && current.linkedTo.id !== userId && !current.linkedTo.signsIn ? current.linkedTo : null;
  return (
    <Field label={label} hint={moving ? `This moves the link from “${moving.name}”, a record the Square sync added that can’t sign in.` : hint}>
      <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Not linked</option>
        {value && !current && <option value={value}>ID {value} (not in Square’s team list)</option>}
        {members.map((m) => {
          const other = m.linkedTo && m.linkedTo.id !== userId ? m.linkedTo : null;
          return (
            <option key={m.id} value={m.id} disabled={!!other?.signsIn}>
              {m.name}{m.email ? ` · ${m.email}` : ''}{m.active ? '' : ' (inactive in Square)'}{other ? (other.signsIn ? ` — linked to ${other.name}` : ` — on “${other.name}” (no sign-in), will move`) : ''}
            </option>
          );
        })}
      </select>
      <button type="button" className="mt-1 text-[12px] text-plum" onClick={() => setManual(true)}>Enter an ID instead</button>
    </Field>
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
  const users = useUsersData().data;
  const roles = users?.roles ?? [];
  const [role, setRole] = useState<Role | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [clearRestrictions, setClearRestrictions] = useState(false);
  const [preview, setPreview] = useState<{ p: PermissionPreviewDTO; body: object } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [account, setAccount] = useState<{ name: string; email: string; squareTeamMemberId: string; color: string; mobilePhone: string } | null>(null);
  const [link, setLink] = useState<{ link: string; emailed: boolean } | null>(null);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [filter, setFilter] = useState<'all' | 'on' | 'custom'>('all');
  const [tab, setTab] = useState<'account' | 'permissions' | 'pay' | 'taxes'>('account');
  // Square's team list (cached; also used by the Square team member picker): their phone there, if any.
  const { data: squareTeam } = useQuery({
    queryKey: ['square-team-members'],
    queryFn: () => api.get<{ connected: boolean; members: SquareTeamMemberOptionDTO[] }>('/admin/users/square-team-members'),
    staleTime: 60_000, enabled: canDo('users:manage'),
  });
  const seesPay = ['commission:manage', 'commission:team'].some(canDo);

  const self = me?.id === id;
  const canPerms = canDo('users:permissions') && !self && (data?.status === 'active' || data?.status === 'disabled');
  const u = data;
  const roleNow = role ?? u?.role ?? 'assistant';
  const template = useMemo(() => new Set(roles.find((r) => r.role === roleNow)?.permissions ?? []), [roles, roleNow]);
  if (isLoading || !u) return <div className="flex justify-center py-10"><Spinner /></div>;

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
    qc.invalidateQueries({ queryKey: ['square-team-members'] });
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
      await api.patch(`/admin/users/${id}`, { name: account.name, email: account.email, color: account.color, squareTeamMemberId: account.squareTeamMemberId || null, mobilePhone: account.mobilePhone.trim() || null });
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
      await api.post(`/admin/users/${id}/${u.status === 'active' ? 'deactivate' : 'reactivate'}`);
      toast(u.status === 'active' ? `${u.name} was deactivated and signed out.` : `${u.name} can sign in again.`);
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
    <div className="pb-24">
      <button onClick={onClose} className="mb-3 inline-flex items-center gap-1 text-sm text-stone hover:text-ink"><ArrowLeft className="h-4 w-4" />All employees</button>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Avatar name={u.name} color={u.color} />
        <div className="min-w-0 flex-1">
          <h2 className="h-display text-[30px] leading-tight">{u.name}</h2>
          <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-stone"><Badge tone={u.role === 'admin' ? 'ink' : 'neutral'}>{roles.find((r) => r.role === u.role)?.label ?? u.role}</Badge><StatusBadge s={u.status} />{u.email}</p>
        </div>
      </div>
      <Segmented className="mb-5 max-w-full overflow-x-auto" value={tab} onChange={setTab} options={[
        { value: 'account', label: 'Account' }, { value: 'permissions', label: u.overrideCount ? `Role & permissions (${u.overrideCount} custom)` : 'Role & permissions' },
        ...(seesPay ? [{ value: 'pay' as const, label: 'Pay' }, { value: 'taxes' as const, label: 'Taxes' }] : []),
      ]} />
      <div className="space-y-6">
        {tab === 'account' && <>
        {self && <p className="rounded-lg bg-mist px-3 py-2 text-[13px] text-ink-soft">This is your own account. Another administrator has to change your role, permissions or status.</p>}
        {(u.status === 'pending' || u.status === 'rejected') && (
          <section className="rounded-xl border border-amber/30 bg-amber/5 p-3">
            <p className="mb-2 text-[14px] text-ink-soft">{u.status === 'pending' ? 'This login is waiting for approval. Until then it can’t see or do anything.' : 'This request was rejected, so they can’t sign in. You can still approve it.'}</p>
            {u.status === 'pending' ? <PendingRow u={u} roles={roles} canApprove={!!users?.canApprove && !self} onDone={onClose} />
              : users?.canApprove && <ApproveRejected u={u} roles={roles} onDone={onClose} />}
          </section>
        )}

        <section>
          <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone"><Tc>Account</Tc></h3>
          {/* Details are editable straight away (no "Edit details" step) for people who manage accounts. */}
          {canDo('users:manage') ? (() => {
            const squarePhone = squareTeam?.members.find((m) => m.id === u.squareTeamMemberId)?.phone ?? null;
            const cur = account ?? { name: u.name, email: u.email ?? '', squareTeamMemberId: u.squareTeamMemberId ?? '', color: u.color, mobilePhone: u.mobilePhone ?? '' };
            const edit = (patch: Partial<typeof cur>) => setAccount({ ...cur, ...patch });
            return (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name"><input className="field" value={cur.name} onChange={(e) => edit({ name: e.target.value })} /></Field>
                <Field label="Email"><input className="field" value={cur.email} onChange={(e) => edit({ email: e.target.value })} /></Field>
                <Field label="Mobile" hint="For texting them tasks and notifications. Filled in from Square when it’s blank.">
                  <input className="field" type="tel" value={cur.mobilePhone} onChange={(e) => edit({ mobilePhone: e.target.value })} placeholder="(619) 555-0100" />
                  {!cur.mobilePhone.trim() && squarePhone && (
                    <button type="button" className="mt-1 text-[12px] text-plum hover:underline" onClick={() => edit({ mobilePhone: phone(squarePhone) })}>Square has {phone(squarePhone)} · Use it</button>
                  )}
                </Field>
                <SquareMemberField label="Square team member" userId={id} value={cur.squareTeamMemberId} onChange={(v) => edit({ squareTeamMemberId: v })} />
                <Field label="Calendar colour"><input type="color" className="field h-10 p-1" value={cur.color} onChange={(e) => edit({ color: e.target.value })} /></Field>
                {account && <div className="flex items-end gap-2"><Button variant="primary" size="sm" onClick={saveAccount} loading={busy === 'account'}>Save</Button><Button size="sm" variant="ghost" onClick={() => setAccount(null)}>Undo changes</Button></div>}
              </div>
            );
          })() : (
            <div className="flex flex-wrap items-center gap-2 text-[14px]">
              <span className="text-ink-soft">{u.email ?? 'No email'}</span>
              {u.mobilePhone ? <a className="text-plum hover:underline" href={`sms:${u.mobilePhone}`}>{phone(u.mobilePhone)}</a> : <span className="text-[13px] text-amber">No mobile</span>}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[14px]">
            <StatusBadge s={u.status} />
            <span className="text-[13px] text-stone">{u.squareTeamMemberId ? 'Linked to Square' : 'Not linked to Square (optional)'} · {u.lastLoginAt ? `last sign-in ${relative(u.lastLoginAt)}` : 'never signed in'}{u.approvedAt ? ` · approved ${relative(u.approvedAt)}${u.approvedByName ? ` by ${u.approvedByName}` : ''}` : ''}</span>
            {canDo('users:manage') && (
              <span className="flex w-full flex-wrap gap-2 pt-1">
                {(u.status === 'active' || u.status === 'pending') && <Button size="sm" icon={<KeyRound className="h-4 w-4" />} onClick={passwordLink} loading={busy === 'link'}>{u.canSignIn ? 'Password reset link' : 'Set-up link'}</Button>}
                {!self && (u.status === 'active' || u.status === 'disabled') && <Button size="sm" variant={u.active ? 'ghost' : 'secondary'} className={u.active ? 'text-rose' : ''} onClick={() => setConfirmStatus(true)}>{u.active ? 'Deactivate' : 'Reactivate'}</Button>}
              </span>
            )}
          </div>
          {link && (
            <div className="mt-3 rounded-lg border border-line bg-white p-3 text-[13px]">
              <p className="flex items-center gap-1.5 text-ink-soft"><Link2 className="h-4 w-4" />{link.emailed ? 'Emailed to them. You can also share it:' : 'Email isn’t set up — share this link with them:'}</p>
              <LinkBox link={link.link} />
              <p className="mt-1 text-[12px] text-stone">Works once. Any older link stops working. Setting a password signs them out everywhere else.</p>
            </div>
          )}
        </section>



        {canDo('users:manage') && <SignInCode u={u} canEdit={!!users?.canApprove} />}

        {u.permissions.find((p) => p.key === 'appointments:read')?.effective && <CalendarAccess u={u} canEdit={canPerms} onSaved={reload} />}
        </>}

        {tab === 'pay' && ['commission:manage', 'commission:team', 'commission:approve'].some(canDo) && (
          <section>
            <h3 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-stone"><Tc>Commission rates</Tc></h3>
            <p className="mb-2 text-[13px] text-stone">Service and product rates for {u.name.split(' ')[0]} only. The same rates show in Settings → Commission.</p>
            <StaffCommissionRates staffId={u.id} staffName={u.name} />
          </section>
        )}

        {tab === 'pay' && seesPay && (
          <section>
            <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone"><Tc>Wages, tips & hours</Tc></h3>
            <PayGate title={`Enter your password to see ${u.name.split(' ')[0]}’s pay`}><WagesSection staffId={u.id} staffName={u.name} part="pay" /></PayGate>
          </section>
        )}

        {tab === 'pay' && ['commission:manage', 'commission:team', 'users:manage'].some(canDo) && (
          <section>
            <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone"><Tc>Work schedule</Tc></h3>
            <ScheduleSection staffId={u.id} staffName={u.name} />
          </section>
        )}

        {tab === 'pay' && seesPay && (
          <section>
            <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone"><Tc>Time clock shifts (last 30 days)</Tc></h3>
            <PayGate title={`Enter your password to see ${u.name.split(' ')[0]}’s shifts`}><ShiftsList staffId={u.id} from={daysAgoKey(30)} to={daysAgoKey(0)} /></PayGate>
          </section>
        )}

        {tab === 'taxes' && seesPay && (
          <section>
            <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone"><Tc>Tax information</Tc></h3>
            <PayGate title={`Enter your password to see ${u.name.split(' ')[0]}’s tax details`}><WagesSection staffId={u.id} staffName={u.name} part="taxes" /></PayGate>
          </section>
        )}

        {tab === 'permissions' && <>
        <section>
          <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-stone"><Tc>Role</Tc></h3>
          <select className="field max-w-xs" value={roleNow} disabled={!canPerms} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
          </select>
          <p className="mt-1 text-[13px] text-stone">{roles.find((r) => r.role === roleNow)?.description}</p>
          <p className="mt-1 text-[12px] text-stone">Need something different for {u.name.split(' ')[0]}? Allow or deny single permissions below — or make a reusable template under Role templates.</p>
          {roleChanged && (
            <div className="mt-2 rounded-lg bg-amber/10 px-3 py-2 text-[13px] text-ink-soft">
              Changing the role removes the extra permissions given to {u.name.split(' ')[0]} individually, so nothing carries over by accident.
              <Toggle checked={clearRestrictions} onChange={setClearRestrictions} label="Also clear individual restrictions" />
            </div>
          )}
        </section>
        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold uppercase tracking-wide text-stone"><Tc>Permissions</Tc></h3>
            <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'on', label: 'Allowed' }, { value: 'custom', label: 'Custom only' }]} />
          </div>
          <p className="mb-3 text-[12px] text-stone">“Role” follows the {roles.find((r) => r.role === roleNow)?.label ?? 'role'} template. “Allow” or “Deny” applies to {u.name.split(' ')[0]} only — no one else with this role is affected.</p>
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
                              className={cx('px-2.5 py-1', c === x ? (x === 'deny' ? 'bg-rose text-white' : x === 'allow' ? 'bg-sage text-white' : 'bg-plum text-white') : 'bg-white text-ink-soft hover:bg-mist', !canPerms && 'cursor-not-allowed opacity-60')}>
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
        </>}
      </div>

      {/* Role and permission changes are reviewed before saving; the bar stays in view on every tab. */}
      {canPerms && (dirty || u.overrideCount > 0) && (
        <div className="fixed inset-x-0 bottom-[calc(3.6rem+env(safe-area-inset-bottom))] z-30 border-t border-line bg-white px-4 py-3 backdrop-blur lg:bottom-0 lg:left-[232px]">
          <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-end gap-2">
            {dirty && <span className="mr-auto text-[13px] text-amber">Unsaved role or permission changes</span>}
            {u.overrideCount > 0 && !dirty && <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={() => doPreview({ resetToRole: true, overrides: {} })} loading={busy === 'preview'}>Reset to role defaults</Button>}
            {dirty && <Button variant="ghost" onClick={() => { setChoices({}); setRole(null); }}>Discard</Button>}
            {dirty && <Button variant="primary" onClick={() => doPreview()} loading={busy === 'preview'}>Review changes</Button>}
          </div>
        </div>
      )}

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
    </div>
  );
}

/** A rejected request can still be approved later (Admins only). */
function ApproveRejected({ u, roles, onDone }: { u: StaffAccountDTO; roles: RoleTemplateDTO[]; onDone: () => void }) {
  return <PendingRow u={u} roles={roles} canApprove onDone={onDone} />;
}

/** With "Can view team calendars": everyone's calendar, or only chosen team members (their own is always included). */
function CalendarAccess({ u, canEdit, onSaved }: { u: StaffAccountDetailDTO; canEdit: boolean; onSaved: () => void }) {
  const toast = useToast();
  const { data: staff } = useStaff();
  const [draft, setDraft] = useState<string[] | null>(u.calendarStaffIds);
  const [busy, setBusy] = useState(false);
  const people = (staff ?? []).filter((s) => s.active && s.id !== u.id && s.squareTeamMemberId);
  const dirty = JSON.stringify(draft) !== JSON.stringify(u.calendarStaffIds);
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/admin/users/${u.id}/calendars`, { staffIds: draft });
      toast('Calendar access saved — it applies on their next click.');
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h3 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-stone"><Tc>Team calendars</Tc></h3>
      <p className="mb-2 text-[13px] text-stone">Whose appointments {u.name.split(' ')[0]} can see. Viewing never lets them change, cancel or reschedule anything — that happens in Square.</p>
      <Segmented value={draft === null ? 'all' : 'some'} onChange={(v) => canEdit && setDraft(v === 'all' ? null : (u.calendarStaffIds ?? []))}
        options={[{ value: 'all', label: 'Everyone' }, { value: 'some', label: 'Only these people' }]} />
      {draft !== null && (
        <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-white">
          {people.map((p) => {
            const on = draft.includes(p.id);
            return (
              <li key={p.id}>
                <label className={cx('flex min-h-[48px] items-center gap-3 px-3', canEdit && 'cursor-pointer')}>
                  <input type="checkbox" className="h-5 w-5 accent-plum" disabled={!canEdit} checked={on} onChange={() => setDraft(on ? draft.filter((x) => x !== p.id) : [...draft, p.id])} />
                  <Avatar name={p.name} color={p.color} size="sm" />
                  <span className="text-[15px] text-ink">{p.name}</span>
                </label>
              </li>
            );
          })}
          {people.length === 0 && <li className="px-3 py-3 text-[13px] text-stone">No team members with a Square calendar yet.</li>}
        </ul>
      )}
      {draft !== null && <p className="mt-1.5 text-[12px] text-stone">Their own calendar is always included.</p>}
      {canEdit && dirty && <Button size="sm" variant="primary" className="mt-2" loading={busy} onClick={save}>Save calendar access</Button>}
    </section>
  );
}

interface CodeStatus { set: boolean; enabled: boolean; locked: boolean; lockedUntil: string | null; failedAttempts: number; lastUsedAt: string | null; updatedAt: string | null; squareLocationId: string | null; squareLocationName: string | null }

/**
 * Owner/Admin: the person's custom sign-in code (an alternative to their password; email + code). The code itself is
 * never shown — except a generated one, once, right after generating it, to hand over.
 */
function SignInCode({ u, canEdit }: { u: StaffAccountDetailDTO; canEdit: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const reauth = useReauth();
  const { data: status } = useQuery({ queryKey: ['user-code', u.id], queryFn: () => api.get<{ code: CodeStatus }>(`/admin/users/${u.id}/code`).then((r) => r.code) });
  const { data: locations } = useQuery({ queryKey: ['square-locations'], queryFn: () => api.get<{ locations: { id: string; name: string }[] }>('/admin/locations').then((r) => r.locations), enabled: canEdit });
  const [typed, setTyped] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const act = async (key: string, fn: () => Promise<{ code: CodeStatus; generatedCode?: string | null }>, msg: string) => {
    setBusy(key);
    try {
      const r = await fn();
      qc.setQueryData(['user-code', u.id], r.code);
      if (r.generatedCode) setShown(r.generatedCode);
      setTyped(null);
      setConfirmRevoke(false);
      toast(msg);
    } catch (e) {
      if (reauth.handle(e, () => act(key, fn, msg))) return;
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const base = `/admin/users/${u.id}/code`;
  if (!status) return null;
  return (
    <section>
      <h3 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-stone"><Tc>Sign-in code</Tc></h3>
      <p className="mb-2 text-[13px] text-stone">An alternative to a password: {u.name.split(' ')[0]} signs in with their email and this code. It’s the CRM’s own code — not a Square passcode — and it’s never shown again after it’s set.</p>
      <div className="flex flex-wrap items-center gap-2 text-[14px]">
        {!status.set ? <Badge>No code</Badge> : status.locked ? <Badge tone="rose">Locked until {new Date(status.lockedUntil!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Badge>
          : status.enabled ? <Badge tone="sage">On</Badge> : <Badge>Off</Badge>}
        {status.set && <span className="text-[13px] text-stone">{status.lastUsedAt ? `last used ${relative(status.lastUsedAt)}` : 'not used yet'}{status.updatedAt ? ` · set ${relative(status.updatedAt)}` : ''}{status.squareLocationName ? ` · ${status.squareLocationName}` : ''}</span>}
      </div>
      {shown && (
        <div className="mt-3 rounded-xl border border-sage/30 bg-sage-tint p-3">
          <p className="text-[13px] text-ink-soft">New code for {u.name.split(' ')[0]} — give it to them privately. It won’t be shown again.</p>
          <p className="num mt-1 font-mono text-[26px] tracking-[0.2em] text-ink">{shown}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" icon={<Copy className="h-4 w-4" />} onClick={() => navigator.clipboard?.writeText(shown).then(() => toast('Code copied'), () => toast('Copy failed — note it down instead', 'error'))}>Copy</Button>
            <Button size="sm" variant="ghost" onClick={() => setShown(null)}>Done</Button>
          </div>
        </div>
      )}
      {canEdit ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" icon={<KeyRound className="h-4 w-4" />} loading={busy === 'gen'} onClick={() => act('gen', () => api.put(base, { generate: true }), 'New code generated — the old one no longer works')}>{status.set ? 'Generate a new code' : 'Generate a code'}</Button>
            <Button size="sm" onClick={() => setTyped(typed === null ? '' : null)}>{status.set ? 'Choose a new code' : 'Choose a code'}</Button>
            {status.set && <Button size="sm" variant="ghost" loading={busy === 'toggle'} onClick={() => act('toggle', () => api.post(`${base}/${status.enabled ? 'disable' : 'enable'}`), status.enabled ? 'Code turned off — they’re signed out of code sessions' : 'Code turned on')}>{status.enabled ? 'Turn off' : 'Turn on'}</Button>}
            {status.set && <Button size="sm" variant="ghost" className="text-rose" onClick={() => setConfirmRevoke(true)}>Revoke</Button>}
          </div>
          {typed !== null && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input className="field h-11 font-mono" type="password" autoComplete="new-password" value={typed} maxLength={32} onChange={(e) => setTyped(e.target.value)} placeholder="6+ characters, or 8+ digits" aria-label="New code" />
              <Button className="h-11" variant="primary" disabled={!typed} loading={busy === 'set'} onClick={() => act('set', () => api.put(base, { code: typed }), 'Code saved — it works now, and the old one doesn’t')}>Save code</Button>
            </div>
          )}
          {status.set && (
            <Field label="Square location" hint="Where they work (from Square). Linking to their Square team member is under Edit details.">
              <select className="field h-11 sm:max-w-xs" value={status.squareLocationId ?? ''} onChange={(e) => act('loc', () => api.put(`${base}/location`, { squareLocationId: e.target.value || null }), 'Location saved')}>
                <option value="">Not set</option>
                {locations?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
          )}
          {confirmRevoke && (
            <p className="flex flex-wrap items-center gap-2 rounded-lg bg-rose-tint px-3 py-2 text-[13px] text-ink-soft">
              The code is deleted and every session it opened ends now. Their password still works.
              <Button size="sm" variant="danger" loading={busy === 'revoke'} onClick={() => act('revoke', () => api.del(base), 'Code revoked')}>Revoke code</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(false)}>Cancel</Button>
            </p>
          )}
        </div>
      ) : <p className="mt-2 text-[13px] text-stone">Only an Owner or Admin can set or change codes.</p>}
      {reauth.modal}
    </section>
  );
}
