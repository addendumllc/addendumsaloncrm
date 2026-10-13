import bcrypt from 'bcryptjs';
import {
  DEFAULT_ROLE,
  PERMISSION_KEYS,
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLES,
  SENSITIVE_PERMISSIONS,
  type CurrentUser,
  type PermissionPreviewDTO,
  type Role,
  type RoleTemplateDTO,
  type StaffAccountDetailDTO,
  type StaffAccountDTO,
} from '@addendum/shared';
import { computeEffective, permissionBreakdown, rolePermissions, staffOverrides } from '../auth/permissions.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { emailService } from '../integrations/registry.js';
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
         COALESCE((SELECT json_agg(json_build_object('permission', o.permission, 'granted', o.granted))
                     FROM staff_permission_overrides o WHERE o.staff_id = s.id), '[]'::json) AS overrides
    FROM staff s`;

const overridesOf = (r: any): { permission: string; granted: boolean }[] =>
  (typeof r.overrides === 'string' ? JSON.parse(r.overrides) : r.overrides) ?? [];

function toAccount(r: any): StaffAccountDTO {
  const effective = computeEffective(r.role_perms ?? [], overridesOf(r));
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    active: r.active,
    color: r.color,
    canSignIn: !!r.password_hash && r.active,
    squareTeamMemberId: r.square_team_member_id,
    lastLoginAt: iso(r.last_login_at),
    createdAt: iso(r.created_at)!,
    overrideCount: overridesOf(r).filter((o) => KNOWN.has(o.permission)).length,
    effectiveCount: effective.length,
    sensitiveCount: effective.filter((p) => SENSITIVE.has(p)).length,
  };
}

export async function listAccounts(): Promise<StaffAccountDTO[]> {
  return (await db().query(`${ACCOUNT_SELECT} ORDER BY s.active DESC, lower(s.name)`)).map(toAccount);
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
  const counts = new Map((await db().query<{ role: string; n: number }>('SELECT role, count(*)::int AS n FROM staff WHERE active GROUP BY role')).map((r) => [r.role, r.n]));
  const out: RoleTemplateDTO[] = [];
  for (const role of ROLES) {
    const perms = new Set(await rolePermissions(role));
    out.push({
      role, label: ROLE_LABELS[role], description: ROLE_DESCRIPTIONS[role],
      permissions: PERMISSION_KEYS.filter((k) => perms.has(k)),
      defaults: ROLE_DEFAULT_PERMISSIONS[role], members: counts.get(role) ?? 0,
    });
  }
  return out;
}

// ---------- Guards ----------
function assertNotSelf(actor: CurrentUser, targetId: string, what: string) {
  if (actor.id === targetId) throw forbidden(`You can’t change your own ${what}. Ask another administrator.`);
}

/** You may only manage people whose access is within your own. */
async function assertCanManage(actor: CurrentUser, targetId: string) {
  const { effective } = await effectiveOf(targetId);
  const mine = new Set(actor.permissions);
  if (effective.some((p) => !mine.has(p))) throw forbidden('This person has access you don’t have, so you can’t manage their account.');
}

function assertCanGrant(actor: CurrentUser, permissions: string[]) {
  const mine = new Set(actor.permissions);
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
  for (const r of ROLES) m.set(r, await rolePermissions(r));
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
  if (change.role && !ROLES.includes(change.role)) throw badRequest('Choose Admin, Reception, Stylist or Assistant.');
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
  if (!ROLES.includes(role)) throw notFound('That role');
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

// ---------- Accounts ----------
export interface NewAccount {
  name: string;
  email: string;
  role?: Role;
  color?: string;
  squareTeamMemberId?: string | null;
}

export async function createAccount(actor: CurrentUser, a: NewAccount, confirm = false) {
  // Every new account starts as Assistant. Choosing another role needs permission to assign roles.
  const role = a.role ?? DEFAULT_ROLE;
  if (role !== DEFAULT_ROLE) {
    if (!actor.permissions.includes('users:permissions')) throw forbidden('Only people who can assign roles can create accounts with a role other than Assistant.');
    const perms = await rolePermissions(role);
    assertCanGrant(actor, perms);
    if (role === 'admin' && !confirm) throw new ConfirmRequired(perms.filter((p) => SENSITIVE.has(p)));
  }
  const email = a.email.trim().toLowerCase();
  if (await db().one('SELECT 1 FROM staff WHERE lower(email) = $1', [email])) throw badRequest('Someone already has an account with that email.');
  if (a.squareTeamMemberId && (await db().one('SELECT 1 FROM staff WHERE square_team_member_id = $1', [a.squareTeamMemberId]))) {
    throw badRequest('That Square team member is already linked to another account.');
  }
  const row = await db().one<{ id: string }>(
    `INSERT INTO staff(name, email, role, color, square_team_member_id) VALUES ($1,$2,$3,COALESCE($4,'#9A8478'),$5) RETURNING id`,
    [a.name.trim(), email, role, a.color ?? null, a.squareTeamMemberId ?? null],
  );
  return { id: row!.id, role };
}

export interface AccountPatch {
  name?: string;
  email?: string;
  color?: string;
  squareTeamMemberId?: string | null;
  highlevelUserId?: string | null;
}

export async function updateAccount(actor: CurrentUser, id: string, p: AccountPatch) {
  await getAccount(id);
  if (actor.id !== id) await assertCanManage(actor, id);
  if (p.email) {
    const e = p.email.trim().toLowerCase();
    if (await db().one('SELECT 1 FROM staff WHERE lower(email) = $1 AND id <> $2', [e, id])) throw badRequest('Someone already has an account with that email.');
  }
  if (p.squareTeamMemberId && (await db().one('SELECT 1 FROM staff WHERE square_team_member_id = $1 AND id <> $2', [p.squareTeamMemberId, id]))) {
    throw badRequest('That Square team member is already linked to another account.');
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
  await getAccount(id);
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
      WHERE t.id = $1 AND t.used_at IS NULL AND t.expires_at > now() AND s.active`,
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
