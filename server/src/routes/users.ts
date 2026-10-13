import { Router } from 'express';
import { z } from 'zod';
import { ROLES, type Role } from '@addendum/shared';
import { badRequest, forbidden } from '../lib/errors.js';
import { requireAnyPermission, requirePermission } from '../auth/session.js';
import {
  changeAccess,
  createAccount,
  createPasswordLink,
  emailPasswordLink,
  getAccount,
  listAccounts,
  previewAccess,
  roleTemplates,
  setActive,
  updateAccount,
  updateRoleTemplate,
} from '../domain/users.js';
import { ah, logAction, parse } from './util.js';

/**
 * Settings → Users & Permissions. Every rule (no self-changes, no granting what you don't have, confirmation for
 * sensitive permissions, no lock-outs) is enforced in domain/users.ts, on the server.
 * Audit entries record names of permissions and roles only — never passwords or links.
 */
export const usersRouter = Router();

const role = z.enum(ROLES as [Role, ...Role[]]);
const overrides = z.record(z.string().max(60), z.boolean().nullable()).refine((o) => Object.keys(o).length <= 200, 'too many changes');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a colour like #9A6B7F');

usersRouter.get('/users', requireAnyPermission('users:manage', 'users:permissions'), ah(async (_req, res) => {
  res.json({ users: await listAccounts(), roles: await roleTemplates() });
}));

usersRouter.get('/users/:id', requireAnyPermission('users:manage', 'users:permissions'), ah(async (req, res) => {
  res.json({ user: await getAccount(req.params.id) });
}));

usersRouter.post('/users', requirePermission('users:manage'), ah(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(1, 'is required').max(100),
    email: z.string().trim().email('must be an email address').max(200),
    role: role.optional(),
    color: color.optional(),
    squareTeamMemberId: z.string().trim().max(64).nullable().optional(),
    sendInvite: z.boolean().default(true),
    confirm: z.boolean().default(false),
  }), req.body);
  const created = await createAccount(req.user!, b, b.confirm);
  await logAction(req, 'user.create', 'staff', created.id, { role: created.role });
  // A one-time link to choose a password: emailed when email is set up, and shown once to the admin to pass on.
  const link = await createPasswordLink(created.id, 'invite', req.user!.id);
  const emailed = b.sendInvite ? await emailPasswordLink(created.id, link, 'invite') : false;
  await logAction(req, 'user.password_link', 'staff', created.id, { purpose: 'invite', emailed });
  res.status(201).json({ user: await getAccount(created.id), setupLink: link.url, expiresAt: link.expiresAt, emailed });
}));

usersRouter.patch('/users/:id', requirePermission('users:manage'), ah(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().email('must be an email address').max(200).optional(),
    color: color.optional(),
    squareTeamMemberId: z.string().trim().max(64).nullable().optional(),
    highlevelUserId: z.string().trim().max(100).nullable().optional(),
  }).strict(), req.body);
  await updateAccount(req.user!, req.params.id, b);
  await logAction(req, 'user.update', 'staff', req.params.id, { fields: Object.keys(b) });
  res.json({ user: await getAccount(req.params.id) });
}));

usersRouter.post('/users/:id/deactivate', requirePermission('users:manage'), ah(async (req, res) => {
  await setActive(req.user!, req.params.id, false);
  await logAction(req, 'user.deactivate', 'staff', req.params.id);
  res.json({ user: await getAccount(req.params.id) });
}));

usersRouter.post('/users/:id/reactivate', requirePermission('users:manage'), ah(async (req, res) => {
  await setActive(req.user!, req.params.id, true);
  await logAction(req, 'user.reactivate', 'staff', req.params.id);
  res.json({ user: await getAccount(req.params.id) });
}));

usersRouter.post('/users/:id/password-link', requirePermission('users:manage'), ah(async (req, res) => {
  const target = await getAccount(req.params.id);
  if (!target.active) throw badRequest('Reactivate the account first.');
  if (req.user!.id !== target.id) {
    // Same rule as other account changes: only for people whose access is within yours.
    const mine = new Set(req.user!.permissions);
    if (target.permissions.some((p) => p.effective && !mine.has(p.key))) {
      throw forbidden('This person has access you don’t have, so you can’t reset their password.');
    }
  }
  const link = await createPasswordLink(target.id, 'reset', req.user!.id);
  const emailed = await emailPasswordLink(target.id, link, 'reset');
  await logAction(req, 'user.password_link', 'staff', target.id, { purpose: 'reset', emailed });
  res.json({ link: link.url, expiresAt: link.expiresAt, emailed });
}));

const accessChange = z.object({
  role: role.optional(),
  overrides: overrides.optional(),
  clearRestrictions: z.boolean().default(false),
  resetToRole: z.boolean().default(false),
  confirm: z.boolean().default(false),
});

usersRouter.post('/users/:id/access/preview', requirePermission('users:permissions'), ah(async (req, res) => {
  const b = parse(accessChange, req.body);
  await getAccount(req.params.id);
  res.json({ preview: await previewAccess(req.params.id, b) });
}));

usersRouter.put('/users/:id/access', requirePermission('users:permissions'), ah(async (req, res) => {
  const b = parse(accessChange, req.body);
  await getAccount(req.params.id);
  const r = await changeAccess(req.user!, req.params.id, b);
  if (r.roleChanged) await logAction(req, 'user.role_change', 'staff', req.params.id, { from: r.from, to: r.role, droppedOverrides: r.dropped });
  if (r.added.length || r.removed.length || b.resetToRole) {
    await logAction(req, b.resetToRole ? 'user.permissions_reset' : 'user.permissions', 'staff', req.params.id, {
      granted: r.added, revoked: r.removed, overrides: r.overrides.map((o) => `${o.granted ? '+' : '−'}${o.permission}`),
    });
  }
  res.json({ user: await getAccount(req.params.id), added: r.added, removed: r.removed });
}));

usersRouter.get('/roles', requireAnyPermission('users:manage', 'users:permissions'), ah(async (_req, res) => {
  res.json({ roles: await roleTemplates() });
}));

usersRouter.put('/roles/:role', requirePermission('users:permissions'), ah(async (req, res) => {
  const r = parse(role, req.params.role);
  const b = parse(z.object({ permissions: z.array(z.string().max(60)).max(200), confirm: z.boolean().default(false) }), req.body);
  const out = await updateRoleTemplate(req.user!, r, b.permissions, b.confirm);
  await logAction(req, 'role_template.update', 'role', r, out);
  res.json({ roles: await roleTemplates(), ...out });
}));

