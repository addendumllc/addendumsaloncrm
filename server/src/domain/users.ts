import bcrypt from 'bcryptjs';
import {
  DEFAULT_ROLE,
  PERMISSION_KEYS,
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLES,
  SENSITIVE_PERMISSIONS,
  isBuiltinRole,
  type AccountStatus,
  type CurrentUser,
  type PermissionPreviewDTO,
  type Role,
  type RoleTemplateDTO,
  type StaffAccountDetailDTO,
  type StaffAccountDTO,
} from '@addendum/shared';
import { canManageAccess } from '../auth/access.js';
import { computeEffective, isApprover, permissionBreakdown, rolePermissions, staffOverrides } from '../auth/permissions.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { toE164 } from '../lib/phone.js';
import { emailService } from '../integrations/registry.js';
import { getSettings } from '../repos/settings.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { iso } from '../lib/time.js';

/**
 * Employee accounts, roles and individual permissions (Settings → Users & Permissions).
 *
 * Safety rules, all enforced here on the server:
 *  - Nobody can change their own role, permissions or account status (another administrator must).
 *  - You can only give out permissions you hold yourself, and only manage people who don't have more access than you.
 *  - Sensitive permissions (API keys, payroll/commission, exports, user admin…) need an explicit confirmation.
 *  - Changing someone's role drops the extra permissions they were individually granted, so nothing elevated
 *    carries over by accident. Individual restrictions are kept unless you ask to clear them.
 *  - There must always be at least one active person who can sign in and manage permissions (no lock-outs).
 *  - A new login never grants access by itself: it waits as "pending" until an Admin approves it (approveAccount).
 *    Pending and rejected accounts can't sign in, and no session of theirs is accepted (auth/session.ts).
 */

const SENSITIVE = new Set(SENSITIVE_PERMISSIONS);
const KNOWN = new Set(PERMISSION_KEYS);

export class ConfirmRequired extends AppError {
  constructor(public sensitive: string[]) {
    super(400, 'These changes include sensitive permissions. Please review and confirm them.', 'confirm_required', { sensitive });
  }
}

// ---------- Reading ----------
const ACCOUNT_SELECT = `
  SELECT s.*, ARRAY(SELECT permission FROM role_permissions rp WHERE rp.role = s.role) AS role_perms,
         (SELECT COALESCE(t.label, '') FROM role_templates t WHERE t.role = s.role) AS role_label,
         (SELECT a.name FROM staff a WHERE a.id = s.approved_by_staff_id) AS approved_by_name,
         COALESCE((SELECT json_agg(json_build_object('permission', o.permission, 'granted', o.granted))
                     FROM staff_permission_overrides o WHERE o.staff_id = s.id), '[]'::json) AS overrides
    FROM staff s`;

const overridesOf = (r: any): { permission: string; granted: boolean }[] =>
  (typeof r.overrides === 'string' ? JSON.parse(r.overrides) : r.overrides) ?? [];

export const statusOf = (r: { approval_status: string; active: boolean }): AccountStatus =>
  r.approval_status === 'pending' ? 'pending' : r.approval_status === 'rejected' ? 'rejected' : r.active ? 'active' : 'disabled';
export const roleLabel = (role: string, custom?: string | null) => (isBuiltinRole(role) ? ROLE_LABELS[role] : custom || role);

function toAccount(r: any): StaffAccountDTO {
  const effective = computeEffective(r.role_perms ?? [], overridesOf(r));
  const status = statusOf(r);
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    roleLabel: roleLabel(r.role, r.role_label),
    status,
    selfRequested: !!r.self_requested,
    requestedAt: iso(r.approval_requested_at),
    approvedAt: iso(r.approved_at),
    approvedByName: r.approved_by_name ?? null,
    calendarStaffIds: r.calendar_staff_ids ?? null,
    active: r.active,
    color: r.color,
    canSignIn: !!r.password_hash && status === 'active',
    squareTeamMemberId: r.square_team_member_id,
    mobilePhone: r.mobile_phone ?? null,
    lastLoginAt: iso(r.last_login_at),
    createdAt: iso(r.created_at)!,
    overrideCount: overridesOf(r).filter((o) => KNOWN.has(o.permission)).length,
    effectiveCount: effective.length,
    sensitiveCount: effective.filter((p) => SENSITIVE.has(p)).length,
  };
}

export async function listAccounts(): Promise<StaffAccountDTO[]> {
  return (await db().query(`${ACCOUNT_SELECT} ORDER BY (s.approval_status = 'pending') DESC, s.active DESC, lower(s.name)`)).map(toAccount);
}

export async function getAccount(id: string): Promise<StaffAccountDetailDTO> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('That team member');
  const r = await db().one(`${ACCOUNT_SELECT} WHERE s.id = $1`, [id]);
  if (!r) throw notFound('That team member');
  return { ...toAccount(r), permissions: permissionBreakdown(r.role_perms ?? [], overridesOf(r)) };
}

async function effectiveOf(id: string) {
  const r = await db().one<any>('SELECT role FROM staff WHERE id = $1', [id]);
  if (!r) throw notFound('That team member');
  return { role: r.role as Role, overrides: await staffOverrides(id), effective: computeEffective(await rolePermissions(r.role), await staffOverrides(id)) };
}

export async function roleTemplates(): Promise<RoleTemplateDTO[]> {
  const counts = new Map((await db().query<{ role: string; n: number; total: number }>(
    'SELECT role, count(*) FILTER (WHERE active)::int AS n, count(*)::int AS total FROM staff GROUP BY role')).map((r) => [r.role, r]));
  const rows = await db().query<{ role: string; label: string | null; description: string | null; builtin: boolean }>('SELECT role, label, description, builtin FROM role_templates');
  const order = (r: string) => (isBuiltinRole(r) ? ROLES.indexOf(r) : ROLES.length);
  rows.sort((a, b) => order(a.role) - order(b.role) || roleLabel(a.role, a.label).localeCompare(roleLabel(b.role, b.label)));
  const out: RoleTemplateDTO[] = [];
  for (const t of rows) {
    const perms = new Set(await rolePermissions(t.role));
    const builtin = isBuiltinRole(t.role);
    out.push({
      role: t.role, label: roleLabel(t.role, t.label), description: builtin ? ROLE_DESCRIPTIONS[t.role as keyof typeof ROLE_DESCRIPTIONS] : t.description ?? '',
      permissions: PERMISSION_KEYS.filter((k) => perms.has(k)),
      defaults: builtin ? ROLE_DEFAULT_PERMISSIONS[t.role as keyof typeof ROLE_DEFAULT_PERMISSIONS] : [], builtin,
      members: counts.get(t.role)?.n ?? 0, totalMembers: counts.get(t.role)?.total ?? 0,
    });
  }
  return out;
}

async function assertRoleExists(role: string) {
  if (!(await db().one('SELECT 1 FROM role_templates WHERE role = $1', [role]))) throw badRequest('Choose one of the role templates.');
}

// ---------- Guards ----------
function assertNotSelf(actor: CurrentUser, targetId: string, what: string) {
  if (actor.id === targetId) throw forbidden(`You can’t change your own ${what}. Ask another administrator.`);
}

/**
 * What the actor counts as holding when giving out or comparing access. The away-from-the-salon exceptions
 * (location:*) say where someone may work, not what they may do: whoever manages Location & Access (Owners/Admins)
 * can hand them out without holding them.
 */
function held(actor: CurrentUser) {
  const mine = new Set(actor.permissions);
  // Owners/Admins hand out the per-person exceptions (away from the salon, time clock) without holding them themselves.
  if (canManageAccess(actor)) for (const k of PERMISSION_KEYS) if (k.startsWith('location:') || k.startsWith('timeclock:')) mine.add(k);
  return mine;
}

/** You may only manage people whose access is within your own. */
async function assertCanManage(actor: CurrentUser, targetId: string) {
  const { effective } = await effectiveOf(targetId);
  const mine = held(actor);
  if (effective.some((p) => !mine.has(p))) throw forbidden('This person has access you don’t have, so you can’t manage their account.');
}

function assertCanGrant(actor: CurrentUser, permissions: string[]) {
  const mine = held(actor);
  const missing = permissions.filter((p) => !mine.has(p));
  if (missing.length) throw forbidden(`You can only give out permissions you have yourself (missing: ${missing.join(', ')}).`);
}

/** At least one active person who can sign in must be able to manage permissions. Runs inside the transaction. */
async function assertNotLockedOut(q: { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> }) {
  const [r] = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM staff s WHERE s.active AND s.password_hash IS NOT NULL AND (
       EXISTS (SELECT 1 FROM staff_permission_overrides o WHERE o.staff_id = s.id AND o.permission = 'users:permissions' AND o.granted)
       OR (EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role = s.role AND rp.permission = 'users:permissions')
           AND NOT EXISTS (SELECT 1 FROM staff_permission_overrides o WHERE o.staff_id = s.id AND o.permission = 'users:permissions' AND NOT o.granted)))`,
  );
  if (!r?.n) throw badRequest('This would leave nobody able to manage users and permissions. Keep at least one active administrator.');
}

// ---------- Access changes (role + individual permissions) ----------
export interface AccessChange {
  role?: Role;
  /** permission → true (grant to this person), false (remove for this person), null (back to the role default) */
  overrides?: Record<string, boolean | null>;
  /** When changing role, also clear individual restrictions (grants are always cleared on a role change). */
  clearRestrictions?: boolean;
  resetToRole?: boolean;
}

function planAccess(current: { role: Role; overrides: { permission: string; granted: boolean }[] }, rolePerms: Map<Role, string[]>, change: AccessChange) {
  const role = change.role ?? current.role;
  const roleChanged = role !== current.role;
  let next = new Map(current.overrides.filter((o) => KNOWN.has(o.permission)).map((o) => [o.permission, o.granted]));
  const dropped: string[] = [];
  if (change.resetToRole) {
    dropped.push(...next.keys());
    next = new Map();
  } else if (roleChanged) {
    for (const [p, g] of next) {
      if (g || change.clearRestrictions) {
        dropped.push(p);
        next.delete(p);
      }
    }
  }
  for (const [p, v] of Object.entries(change.overrides ?? {})) {
    if (!KNOWN.has(p)) throw badRequest(`Unknown permission: ${p}`);
    if (v === null) next.delete(p);
    else next.set(p, v);
  }
  // Overrides that match the role template are redundant; drop them so "custom" really means custom.
  const template = new Set(rolePerms.get(role) ?? []);
  for (const [p, g] of next) if (template.has(p) === g) next.delete(p);
  const overrides = [...next].map(([permission, granted]) => ({ permission, granted }));
  const before = computeEffective(rolePerms.get(current.role) ?? [], current.overrides);
  const after = computeEffective(template, overrides);
  const added = after.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !after.includes(p));
  return { role, roleChanged, overrides, before, after, added, removed, dropped: dropped.filter((p) => !next.has(p)) };
}

async function rolePermMap() {
  const m = new Map<Role, string[]>();
  for (const r of await db().query<{ role: string }>('SELECT role FROM role_templates')) m.set(r.role, await rolePermissions(r.role));
  return m;
}

export async function previewAccess(targetId: string, change: AccessChange): Promise<PermissionPreviewDTO> {
  const cur = await effectiveOf(targetId);
  const plan = planAccess(cur, await rolePermMap(), change);
  return {
    added: plan.added,
    removed: plan.removed,
    sensitiveAdded: plan.added.filter((p) => SENSITIVE.has(p)),
    droppedOverrides: plan.dropped,
    effective: plan.after,
  };
}

export async function changeAccess(actor: CurrentUser, targetId: string, change: AccessChange & { confirm?: boolean }) {
  assertNotSelf(actor, targetId, 'role or permissions');
  await assertCanManage(actor, targetId);
  if (change.role) await assertRoleExists(change.role);
  const cur = await effectiveOf(targetId);
  const plan = planAccess(cur, await rolePermMap(), change);
  assertCanGrant(actor, plan.added);
  const sensitiveAdded = plan.added.filter((p) => SENSITIVE.has(p));
  if ((sensitiveAdded.length || (plan.role === 'admin' && plan.roleChanged)) && !change.confirm) throw new ConfirmRequired(sensitiveAdded);

  await db().tx(async (q) => {
    if (plan.roleChanged) await q.query('UPDATE staff SET role = $2, updated_at = now() WHERE id = $1', [targetId, plan.role]);
    await q.query('DELETE FROM staff_permission_overrides WHERE staff_id = $1', [targetId]);
    for (const o of plan.overrides) {
      await q.query('INSERT INTO staff_permission_overrides(staff_id, permission, granted, set_by_staff_id) VALUES ($1,$2,$3,$4)', [targetId, o.permission, o.granted, actor.id]);
    }
    await assertNotLockedOut(q);
  });
  return { ...plan, from: cur.role };
}

// ---------- Role templates ----------
export async function updateRoleTemplate(actor: CurrentUser, role: Role, permissions: string[], confirm: boolean) {
  if (!(await db().one('SELECT 1 FROM role_templates WHERE role = $1', [role]))) throw notFound('That role');
  const wanted = [...new Set(permissions)];
  for (const p of wanted) if (!KNOWN.has(p)) throw badRequest(`Unknown permission: ${p}`);
  const current = await rolePermissions(role);
  const added = wanted.filter((p) => !current.includes(p));
  const removed = current.filter((p) => !wanted.includes(p));
  assertCanGrant(actor, added);
  // Removing from your own role could lock you out of this screen; another admin must do that.
  if (role === actor.role && removed.includes('users:permissions')) throw forbidden('You can’t remove permission management from your own role.');
  const sensitiveAdded = added.filter((p) => SENSITIVE.has(p));
  if (sensitiveAdded.length && !confirm) throw new ConfirmRequired(sensitiveAdded);
  await db().tx(async (q) => {
    await q.query('DELETE FROM role_permissions WHERE role = $1', [role]);
    for (const p of wanted) await q.query('INSERT INTO role_permissions(role, permission) VALUES ($1,$2)', [role, p]);
    await q.query('UPDATE role_templates SET updated_by_staff_id = $2, updated_at = now() WHERE role = $1', [role, actor.id]);
    await assertNotLockedOut(q);
  });
  return { added, removed };
}

/** A new template, empty or copied from another one. You can only include permissions you hold yourself. */
export async function createRoleTemplate(actor: CurrentUser, t: { label: string; description?: string | null; copyFrom?: string | null }, confirm: boolean) {
  const label = t.label.trim();
  const taken = (await roleTemplates()).some((x) => x.label.toLowerCase() === label.toLowerCase());
  if (taken) throw badRequest('A template with that name already exists.');
  if (t.copyFrom) await assertRoleExists(t.copyFrom);
  const perms = t.copyFrom ? await rolePermissions(t.copyFrom) : [];
  assertCanGrant(actor, perms);
  const sensitive = perms.filter((p) => SENSITIVE.has(p));
  if (sensitive.length && !confirm) throw new ConfirmRequired(sensitive);
  const role = `custom-${randomToken(6).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8) || Date.now().toString(36)}`;
  await db().tx(async (q) => {
    // known_permissions = everything: future features are never switched on in a custom template by themselves.
    await q.query('INSERT INTO role_templates(role, label, description, builtin, known_permissions, updated_by_staff_id) VALUES ($1,$2,$3,false,$4,$5)',
      [role, label, t.description?.trim() || null, PERMISSION_KEYS, actor.id]);
    for (const p of perms) await q.query('INSERT INTO role_permissions(role, permission) VALUES ($1,$2)', [role, p]);
  });
  return { role };
}

export async function renameRoleTemplate(actor: CurrentUser, role: string, t: { label?: string; description?: string | null }) {
  const row = await db().one<{ builtin: boolean }>('SELECT builtin FROM role_templates WHERE role = $1', [role]);
  if (!row) throw notFound('That role');
  if (isBuiltinRole(role)) throw badRequest('Built-in templates keep their names. Create your own template to name it.');
  if (t.label && (await roleTemplates()).some((x) => x.role !== role && x.label.toLowerCase() === t.label!.trim().toLowerCase())) throw badRequest('A template with that name already exists.');
  await db().query('UPDATE role_templates SET label = COALESCE($2, label), description = CASE WHEN $3::boolean THEN $4 ELSE description END, updated_by_staff_id = $5, updated_at = now() WHERE role = $1',
    [role, t.label?.trim() || null, t.description !== undefined, t.description?.trim() || null, actor.id]);
}

/** Only custom templates nobody uses (including pending and deactivated accounts) can be deleted. */
export async function deleteRoleTemplate(role: string) {
  if (isBuiltinRole(role)) throw badRequest('Built-in templates can’t be deleted.');
  if (!(await db().one('SELECT 1 FROM role_templates WHERE role = $1', [role]))) throw notFound('That role');
  const n = (await db().one<{ n: number }>('SELECT count(*)::int AS n FROM staff WHERE role = $1', [role]))!.n;
  if (n) throw badRequest(`${n} ${n === 1 ? 'person uses' : 'people use'} this template. Move them to another template first.`);
  await db().query('DELETE FROM role_templates WHERE role = $1', [role]);
}

// ---------- Accounts ----------
export interface NewAccount {
  name: string;
  email: string;
  role?: Role;
  color?: string;
  squareTeamMemberId?: string | null;
  /** An Admin adding someone can approve them in the same step; otherwise the account waits as pending. */
  approveNow?: boolean;
  mobilePhone?: string | null;
}

export async function createAccount(actor: CurrentUser, a: NewAccount, confirm = false) {
  // Every new account starts as Assistant. Choosing another role needs permission to assign roles.
  const role = a.role ?? DEFAULT_ROLE;
  await assertRoleExists(role);
  if (a.approveNow && !isApprover(actor)) throw forbidden('Only an Admin can approve accounts.');
  if (role !== DEFAULT_ROLE) {
    if (!actor.permissions.includes('users:permissions')) throw forbidden('Only people who can assign roles can create accounts with a role other than Assistant.');
    const perms = await rolePermissions(role);
    assertCanGrant(actor, perms);
    if (role === 'admin' && !confirm) throw new ConfirmRequired(perms.filter((p) => SENSITIVE.has(p)));
  }
  const email = a.email.trim().toLowerCase();
  if (await db().one('SELECT 1 FROM staff WHERE lower(email) = $1', [email])) throw badRequest('Someone already has an account with that email.');
  if (a.squareTeamMemberId) await takeSquareLink(a.squareTeamMemberId, null);
  if (a.mobilePhone && !toE164(a.mobilePhone)) throw badRequest("That mobile number doesn't look right.");
  const approved = !!a.approveNow;
  const row = await db().one<{ id: string }>(
    `INSERT INTO staff(name, email, role, color, square_team_member_id, approval_status, active, approval_requested_at, approved_at, approved_by_staff_id)
     VALUES ($1,$2,$3,COALESCE($4,'#9A8478'),$5,$6,$7, now(), $8, $9) RETURNING id`,
    [a.name.trim(), email, role, a.color ?? null, a.squareTeamMemberId ?? null, approved ? 'approved' : 'pending', approved,
      approved ? new Date() : null, approved ? actor.id : null],
  );
  if (a.mobilePhone) {
    const mobile = toE164(a.mobilePhone);
    if (mobile) await db().query('UPDATE staff SET mobile_phone = $2 WHERE id = $1', [row!.id, mobile]);
  }
  if (!approved) await notifyApprovers(row!.id, a.name.trim(), `Added by ${actor.name}`, actor.id);
  return { id: row!.id, role, approved };
}

/**
 * Frees a Square team member for linking to an account. The Square sync adds a staff record for any team member it
 * couldn't match by email or name; the link moves off such a placeholder (no sign-in, so nobody loses access), but
 * never off a real account.
 */
async function takeSquareLink(teamMemberId: string, forId: string | null) {
  const holder = await db().one<any>(
    `SELECT id, password_hash IS NOT NULL OR last_login_at IS NOT NULL AS signs_in FROM staff
      WHERE square_team_member_id = $1 AND id IS DISTINCT FROM $2`, [teamMemberId, forId]);
  if (!holder) return;
  if (holder.signs_in) throw badRequest('That Square team member is already linked to another account.');
  await db().query('UPDATE staff SET square_team_member_id = NULL, updated_at = now() WHERE id = $1', [holder.id]);
}

export interface AccountPatch {
  name?: string;
  email?: string;
  color?: string;
  squareTeamMemberId?: string | null;
  highlevelUserId?: string | null;
  mobilePhone?: string | null;
}

export async function updateAccount(actor: CurrentUser, id: string, p: AccountPatch) {
  await getAccount(id);
  if (actor.id !== id) await assertCanManage(actor, id);
  if (p.email) {
    const e = p.email.trim().toLowerCase();
    if (await db().one('SELECT 1 FROM staff WHERE lower(email) = $1 AND id <> $2', [e, id])) throw badRequest('Someone already has an account with that email.');
  }
  if (p.squareTeamMemberId) await takeSquareLink(p.squareTeamMemberId, id);
  let mobile: string | null = null;
  if (p.mobilePhone) {
    mobile = toE164(p.mobilePhone);
    if (!mobile) throw badRequest("That mobile number doesn't look right.");
    await db().query('UPDATE staff SET mobile_phone = $2 WHERE id = $1', [id, mobile]);
  } else if (p.mobilePhone === null || p.mobilePhone === '') {
    await db().query('UPDATE staff SET mobile_phone = NULL WHERE id = $1', [id]);
  }
  await db().query(
    `UPDATE staff SET name = COALESCE($2, name), email = COALESCE($3, email), color = COALESCE($4, color),
       square_team_member_id = CASE WHEN $5::boolean THEN $6 ELSE square_team_member_id END,
       highlevel_user_id = CASE WHEN $7::boolean THEN $8 ELSE highlevel_user_id END, updated_at = now()
     WHERE id = $1`,
    [id, p.name?.trim() ?? null, p.email?.trim().toLowerCase() ?? null, p.color ?? null,
      p.squareTeamMemberId !== undefined, p.squareTeamMemberId ?? null, p.highlevelUserId !== undefined, p.highlevelUserId ?? null],
  );
}

export async function setActive(actor: CurrentUser, id: string, active: boolean) {
  assertNotSelf(actor, id, 'account status');
  const acct = await getAccount(id);
  if (acct.status === 'pending' || acct.status === 'rejected') throw badRequest('This person hasn’t been approved. Approve or reject their request instead.');
  await assertCanManage(actor, id);
  await db().tx(async (q) => {
    await q.query('UPDATE staff SET active = $2, deactivated_at = CASE WHEN $2 THEN NULL ELSE now() END, updated_at = now() WHERE id = $1', [id, active]);
    if (!active) {
      // Signed out everywhere straight away, and any open password links stop working.
      await q.query('DELETE FROM sessions WHERE staff_id = $1', [id]);
      await q.query('UPDATE password_reset_tokens SET used_at = now() WHERE staff_id = $1 AND used_at IS NULL', [id]);
    }
    await assertNotLockedOut(q);
  });
}

/**
 * Which team members' calendars someone may view with "Can view team calendars": null = everyone, or a list (their own
 * is always included). Same rules as other access changes: not your own account, only people within your access.
 */
export async function setCalendarAccess(actor: CurrentUser, id: string, staffIds: string[] | null) {
  assertNotSelf(actor, id, 'calendar access');
  await getAccount(id);
  await assertCanManage(actor, id);
  const ids = staffIds === null ? null : [...new Set(staffIds)].filter((x) => x !== id);
  if (ids?.length) {
    const found = await db().query<{ id: string }>('SELECT id FROM staff WHERE id = ANY($1::uuid[])', [ids]);
    if (found.length !== ids.length) throw badRequest('One of those team members wasn’t found.');
  }
  await db().query('UPDATE staff SET calendar_staff_ids = $2, updated_at = now() WHERE id = $1', [id, ids]);
  return ids;
}

// ---------- Approval ----------
/** Tells every Admin who can approve (in the app, and by email when it's set up). */
async function notifyApprovers(staffId: string, name: string, how: string, exceptId: string | null = null) {
  const approvers = await db().query<{ id: string; email: string | null; name: string }>(
    `SELECT s.id, s.email, s.name FROM staff s WHERE s.active AND s.role = 'admin' AND s.id IS DISTINCT FROM $1
       AND ((EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role = s.role AND rp.permission = 'users:manage')
             AND NOT EXISTS (SELECT 1 FROM staff_permission_overrides o WHERE o.staff_id = s.id AND o.permission = 'users:manage' AND NOT o.granted))
            OR EXISTS (SELECT 1 FROM staff_permission_overrides o WHERE o.staff_id = s.id AND o.permission = 'users:manage' AND o.granted))`,
    [exceptId],
  );
  const link = `/settings?tab=users&open=${staffId}`;
  for (const a of approvers) {
    await db().query('INSERT INTO notifications(staff_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5)',
      [a.id, 'account_pending', `${name} is waiting for approval`, `${how}. Approve or reject in Settings → Users & Permissions.`, link]);
  }
  const mail = emailService();
  if (!mail) return;
  const url = `${config().APP_URL.replace(/\/$/, '')}${link}`;
  for (const a of approvers.filter((x) => x.email)) {
    await mail.send({
      to: a.email!, subject: `${name} is waiting for approval in the Addendum Salon CRM`,
      text: `Hi ${a.name.split(' ')[0]},\n\n${name} has a CRM login waiting for approval (${how.toLowerCase()}). They can't see anything until an Admin approves them.\n\nReview it here: ${url}`,
    }).catch(() => undefined);
  }
}

/** Sign-in screen: someone asks for an account. It's created as pending; nothing is visible to them until approved. */
export async function requestAccess(r: { name: string; email: string; password: string }) {
  if (!(await getSettings()).accounts.allowAccessRequests) throw badRequest('Access requests are turned off. Ask an administrator to add you.');
  const email = r.email.trim().toLowerCase();
  // Same answer whether or not the email has an account, so this can't be used to find out who works here.
  if (await db().one('SELECT 1 FROM staff WHERE lower(email) = $1', [email])) return { created: false };
  const hash = await bcrypt.hash(r.password, 12);
  const row = await db().one<{ id: string }>(
    `INSERT INTO staff(name, email, password_hash, role, approval_status, active, self_requested, approval_requested_at)
     VALUES ($1,$2,$3,$4,'pending',false,true, now()) RETURNING id`,
    [r.name.trim(), email, hash, DEFAULT_ROLE],
  );
  await notifyApprovers(row!.id, r.name.trim(), 'Requested access from the sign-in screen');
  return { created: true, id: row!.id };
}

/**
 * An Admin approves a pending (or previously rejected) account, optionally choosing its role template.
 * They must hold every permission the account will get, and admin-level access needs confirming.
 */
export async function approveAccount(actor: CurrentUser, id: string, opts: { role?: Role; confirm?: boolean }) {
  if (!isApprover(actor)) throw forbidden('Only an Admin can approve accounts.');
  assertNotSelf(actor, id, 'account status');
  const acct = await getAccount(id);
  if (acct.status !== 'pending' && acct.status !== 'rejected') throw badRequest('This account is already approved.');
  const role = opts.role ?? acct.role;
  await assertRoleExists(role);
  const perms = computeEffective(await rolePermissions(role), role === acct.role ? await staffOverrides(id) : []);
  assertCanGrant(actor, perms);
  const sensitive = perms.filter((p) => SENSITIVE.has(p));
  if ((role === 'admin' || sensitive.length) && !opts.confirm) throw new ConfirmRequired(sensitive);
  await db().tx(async (q) => {
    if (role !== acct.role) await q.query('DELETE FROM staff_permission_overrides WHERE staff_id = $1', [id]);
    await q.query(
      `UPDATE staff SET approval_status = 'approved', active = true, role = $2, approved_at = now(), approved_by_staff_id = $3,
         rejected_at = NULL, deactivated_at = NULL, updated_at = now() WHERE id = $1`,
      [id, role, actor.id],
    );
  });
  return { role, permissions: perms.length };
}

export async function rejectAccount(actor: CurrentUser, id: string) {
  if (!isApprover(actor)) throw forbidden('Only an Admin can reject accounts.');
  assertNotSelf(actor, id, 'account status');
  const acct = await getAccount(id);
  if (acct.status !== 'pending') throw badRequest('Only pending requests can be rejected. Deactivate an approved account instead.');
  await db().tx(async (q) => {
    await q.query(`UPDATE staff SET approval_status = 'rejected', active = false, rejected_at = now(), updated_at = now() WHERE id = $1`, [id]);
    await q.query('DELETE FROM sessions WHERE staff_id = $1', [id]);
    await q.query('UPDATE password_reset_tokens SET used_at = now() WHERE staff_id = $1 AND used_at IS NULL', [id]);
  });
}

// ---------- Password links ----------
const RESET_HOURS = 2;
const INVITE_DAYS = 7;

export function resetUrl(token: string) {
  return `${config().APP_URL.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
}

/** Creates a one-time link to set a password. Only the hash is stored; older open links for that person stop working. */
export async function createPasswordLink(staffId: string, purpose: 'invite' | 'reset', createdBy: string | null) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + (purpose === 'invite' ? INVITE_DAYS * 86400_000 : RESET_HOURS * 3600_000));
  await db().query('UPDATE password_reset_tokens SET used_at = now() WHERE staff_id = $1 AND used_at IS NULL', [staffId]);
  await db().query('INSERT INTO password_reset_tokens(id, staff_id, purpose, created_by_staff_id, expires_at) VALUES ($1,$2,$3,$4,$5)', [
    sha256(token), staffId, purpose, createdBy, expires,
  ]);
  return { url: resetUrl(token), expiresAt: expires.toISOString() };
}

/** Emails the link when email is set up. Returns whether it was sent (the link itself is never logged). */
export async function emailPasswordLink(staffId: string, link: { url: string; expiresAt: string }, purpose: 'invite' | 'reset') {
  const s = await db().one<any>('SELECT name, email FROM staff WHERE id = $1', [staffId]);
  const mail = emailService();
  if (!s?.email || !mail) return false;
  const first = String(s.name).split(' ')[0];
  const when = purpose === 'invite' ? `${INVITE_DAYS} days` : `${RESET_HOURS} hours`;
  try {
    await mail.send({
      to: s.email,
      subject: purpose === 'invite' ? 'Your Addendum Salon CRM account' : 'Reset your Addendum Salon CRM password',
      text: `Hi ${first},\n\n${purpose === 'invite' ? 'An account has been created for you in the Addendum Salon CRM.' : 'A password reset was requested for your Addendum Salon CRM account.'}\n\nChoose your password here (the link works once and expires in ${when}):\n${link.url}\n\nIf you didn’t expect this, you can ignore this email.`,
    });
    return true;
  } catch {
    return false;
  }
}

export async function checkPasswordToken(token: string) {
  const r = await db().one<any>(
    `SELECT t.staff_id, t.purpose, s.name, s.email FROM password_reset_tokens t JOIN staff s ON s.id = t.staff_id
      WHERE t.id = $1 AND t.used_at IS NULL AND t.expires_at > now() AND (s.active OR s.approval_status = 'pending')`,
    [sha256(token)],
  );
  return r;
}

export async function usePasswordToken(token: string, password: string) {
  const r = await checkPasswordToken(token);
  if (!r) throw badRequest('This link has expired or was already used. Ask an administrator for a new one.');
  const hash = await bcrypt.hash(password, 12);
  await db().tx(async (q) => {
    await q.query('UPDATE staff SET password_hash = $2, updated_at = now() WHERE id = $1', [r.staff_id, hash]);
    await q.query('UPDATE password_reset_tokens SET used_at = now() WHERE staff_id = $1 AND used_at IS NULL', [r.staff_id]);
    await q.query('DELETE FROM sessions WHERE staff_id = $1', [r.staff_id]); // signed out of every other device
  });
  return r.staff_id as string;
}
