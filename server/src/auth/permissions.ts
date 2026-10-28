import {
  PERMISSION_KEYS,
  PERMISSIONS_CATALOG,
  type CurrentUser,
  type EffectivePermissionDTO,
  type Role,
} from '@addendum/shared';
import { db } from '../db/index.js';

/**
 * Role-based permissions with per-person overrides, enforced on the server for every request.
 *
 *   effective = role template (Settings → Users & Permissions → Roles) + individual grants − individual removals
 *
 * Permissions are worked out fresh from the database on every request, so a change takes effect on the person's
 * very next click — no cached permissions to go stale. Unknown permission names never grant anything.
 */

type Who = Pick<CurrentUser, 'permissions'> | null | undefined;

export function can(user: Who, permission: string) {
  return !!user && user.permissions.includes(permission);
}

export function canAny(user: Who, permissions: readonly string[]) {
  return permissions.some((p) => can(user, p));
}

const KNOWN = new Set(PERMISSION_KEYS);

export function computeEffective(rolePerms: Iterable<string>, overrides: { permission: string; granted: boolean }[]): string[] {
  const set = new Set([...rolePerms].filter((p) => KNOWN.has(p)));
  for (const o of overrides) {
    if (!KNOWN.has(o.permission)) continue;
    if (o.granted) set.add(o.permission);
    else set.delete(o.permission);
  }
  return PERMISSION_KEYS.filter((k) => set.has(k));
}

export async function rolePermissions(role: Role): Promise<string[]> {
  return (await db().query<{ permission: string }>('SELECT permission FROM role_permissions WHERE role = $1', [role])).map((r) => r.permission);
}

export async function staffOverrides(staffId: string) {
  return db().query<{ permission: string; granted: boolean }>('SELECT permission, granted FROM staff_permission_overrides WHERE staff_id = $1', [staffId]);
}

export async function effectivePermissions(staffId: string, role: Role): Promise<string[]> {
  return computeEffective(await rolePermissions(role), await staffOverrides(staffId));
}

/** Per-permission breakdown for the Users & Permissions screen. */
export function permissionBreakdown(rolePerms: string[], overrides: { permission: string; granted: boolean }[]): EffectivePermissionDTO[] {
  const role = new Set(rolePerms);
  const ov = new Map(overrides.map((o) => [o.permission, o.granted]));
  return PERMISSIONS_CATALOG.map((p) => {
    const fromRole = role.has(p.key);
    const override = ov.has(p.key) ? ov.get(p.key)! : null;
    const effective = override ?? fromRole;
    return {
      key: p.key,
      effective,
      fromRole,
      override,
      source: override === true ? 'granted' : override === false ? 'denied' : fromRole ? 'role' : 'none',
    };
  });
}

/**
 * Every API path a signed-in person can call, and the permissions that open it (any one of them).
 * Anything not listed here is refused — new endpoints are closed until they are added. Routes then apply their own,
 * finer checks (e.g. "only your own appointments").
 */
const ANY_SIGNED_IN: string[] = [];
export const API_RULES: { method: string; path: RegExp; anyOf: string[] }[] = [
  // Always available once signed in: limited settings (salon name, time zone, colours, Order Hair defaults).
  { method: 'GET', path: /^\/settings$/, anyOf: ANY_SIGNED_IN },
  { method: 'GET', path: /^\/settings\/booking-links$/, anyOf: ANY_SIGNED_IN },
  { method: '*', path: /^\/content\/studio(\/.*)?$/, anyOf: ['content:manage', 'content:studio'] },
  { method: '*', path: /^\/content(\/.*)?$/, anyOf: ['content:manage'] },
  // Transformations Library: each route then checks the record (own / all / download / consent).
  { method: '*', path: /^\/transformations(\/.*)?$/, anyOf: ['transformations:own', 'transformations:view_all', 'transformations:manage'] },
  // Location & Access: everyone can see whether they're on the salon network; changing it is Owner/Admin only (checked in the route).
  { method: 'GET', path: /^\/access\/status$/, anyOf: ANY_SIGNED_IN },
  // Each person's own sidebar order and hidden items (Customize menu).
  { method: '*', path: /^\/sidebar\/layout$/, anyOf: ANY_SIGNED_IN },
  // Each person's own theme (and the ones others published); removing someone else's is checked in the route.
  { method: '*', path: /^\/user-themes(\/[a-z0-9-]+)?$/, anyOf: ANY_SIGNED_IN },
  { method: 'PUT', path: /^\/access$/, anyOf: ['settings:write'] },
  // Everyone gets notifications addressed to them (e.g. a task sent to them); salon-wide alerts need the Dashboard (the routes filter).
  { method: 'GET', path: /^\/notifications$/, anyOf: ANY_SIGNED_IN },
  { method: 'POST', path: /^\/notifications\/read-all$/, anyOf: ANY_SIGNED_IN },
  { method: 'GET', path: /^\/updates$/, anyOf: ANY_SIGNED_IN },
  // Time clock (each route checks its own permission).
  { method: '*', path: /^\/timeclock(\/.*)?$/, anyOf: ['timeclock:use', 'commission:manage', 'commission:team', 'users:manage'] },
  // Each person's own profile (mobile) and look (accent, light/dark).
  { method: '*', path: /^\/my-profile$/, anyOf: ANY_SIGNED_IN },
  { method: '*', path: /^\/look$/, anyOf: ANY_SIGNED_IN },
  // Each person's own Dashboard arrangement.
  { method: '*', path: /^\/dashboard\/layout$/, anyOf: ['dashboard:view'] },
  { method: '*', path: /^\/analytics\/layout$/, anyOf: ['analytics:read', 'revenue:projections'] },

  { method: 'GET', path: /^\/dashboard$/, anyOf: ['dashboard:view'] },
  { method: 'GET', path: /^\/analytics$/, anyOf: ['analytics:read'] },
  { method: 'GET', path: /^\/projections(\/appointments)?$/, anyOf: ['revenue:projections'] },
  { method: 'GET', path: /^\/analytics\/new-clients$/, anyOf: ['analytics:read'] },
  { method: 'GET', path: /^\/analytics\/products$/, anyOf: ['analytics:read'] },
  { method: 'GET', path: /^\/analytics\/forecast$/, anyOf: ['analytics:read'] },
  { method: 'GET', path: /^\/purchases(\/items)?$/, anyOf: ['analytics:read', 'inventory:sync', 'hair:manage'] },
  { method: 'GET', path: /^\/search$/, anyOf: ['clients:read', 'clients:read_assigned', 'leads:read'] },
  { method: 'GET', path: /^\/services$/, anyOf: ['services:read'] },

  { method: '*', path: /^\/clients(\/.*)?$/, anyOf: ['clients:read', 'clients:read_assigned'] },
  { method: '*', path: /^\/notes\/[^/]+$/, anyOf: ['clients:notes', 'clients:write'] },
  { method: '*', path: /^\/leads(\/.*)?$/, anyOf: ['leads:read'] },
  { method: '*', path: /^\/appointments(\/[^/]+)?$/, anyOf: ['appointments:read', 'appointments:read_own'] },
  { method: '*', path: /^\/messages(\/.*)?$/, anyOf: ['messages:read', 'messages:send'] },
  { method: '*', path: /^\/tasks(\/.*)?$/, anyOf: ['tasks:read_all', 'tasks:read_own'] },
  { method: '*', path: /^\/announcements(\/.*)?$/, anyOf: ['announcements:read', 'announcements:publish', 'announcements:manage'] },
  { method: '*', path: /^\/rebooking(\/.*)?$/, anyOf: ['clients:read', 'clients:read_assigned', 'rebooking:defaults'] },

  { method: 'GET', path: /^\/integrations\/status$/, anyOf: ['dashboard:view', 'settings:read', 'integrations:manage', 'inventory:manage'] },
  { method: '*', path: /^\/integrations(\/.*)?$/, anyOf: ['integrations:manage', 'settings:read', 'square:sync'] },
  { method: '*', path: /^\/admin\/credentials(\/.*)?$/, anyOf: ['integrations:manage'] },
  { method: 'GET', path: /^\/admin\/system$/, anyOf: ['settings:write', 'integrations:manage'] },
  { method: 'GET', path: /^\/admin\/locations$/, anyOf: ['users:manage'] },
  { method: '*', path: /^\/admin\/(users|roles|permissions)(\/.*)?$/, anyOf: ['users:manage', 'users:permissions'] },
  { method: '*', path: /^\/inventory-sync(\/.*)?$/, anyOf: ['inventory:sync'] },
  { method: '*', path: /^\/hair(\/.*)?$/, anyOf: ['hair:manage'] },
  { method: '*', path: /^\/inventory(\/.*)?$/, anyOf: ['inventory:view', 'inventory:order', 'inventory:read_all', 'inventory:manage'] },
  { method: '*', path: /^\/commission(\/.*)?$/, anyOf: ['commission:own', 'commission:team', 'commission:manage', 'commission:approve', 'commission:export'] },

  { method: '*', path: /^\/settings\/logo$/, anyOf: ['settings:write'] },
  { method: '*', path: /^\/settings\/font\/(heading|body|link|button|nav)$/, anyOf: ['settings:write'] },
  { method: '*', path: /^\/settings\/login-image$/, anyOf: ['settings:write'] },
  { method: '*', path: /^\/settings\/font-file(\/[a-z0-9]+)?$/, anyOf: ['settings:write'] },
  { method: 'PATCH', path: /^\/settings$/, anyOf: ['settings:rules', 'settings:write', 'integrations:manage', 'inventory:sync', 'users:manage'] },
  { method: 'GET', path: /^\/staff$/, anyOf: ['staff:read', 'users:manage', 'tasks:assign', 'inventory:order_for_others', 'commission:team'] },
  { method: 'PATCH', path: /^\/staff\/[^/]+$/, anyOf: ['users:manage'] },
  { method: 'GET', path: /^\/tags$/, anyOf: ['clients:read', 'clients:read_assigned', 'leads:read'] },
  { method: '*', path: /^\/tags(\/.*)?$/, anyOf: ['clients:write', 'settings:rules'] },
  { method: 'GET', path: /^\/audit$/, anyOf: ['audit:read'] },
  { method: 'GET', path: /^\/audit\/export$/, anyOf: ['audit:export'] },
  { method: 'GET', path: /^\/privacy\/export$/, anyOf: ['privacy:export_all'] },
  { method: '*', path: /^\/demo(\/.*)?$/, anyOf: ['integrations:manage', 'settings:write'] },
];

/**
 * Approving or rejecting new accounts is for Admins (the owner is an Admin) who can manage accounts.
 * Checked from the role itself, so an individual grant can't turn someone else into an approver.
 */
export const isApprover = (user: Pick<CurrentUser, 'permissions' | 'role'> | null | undefined) => !!user && user.role === 'admin' && can(user, 'users:manage');

export function apiAllowed(user: Who, method: string, path: string) {
  const rule = API_RULES.find((r) => (r.method === '*' || r.method === method) && r.path.test(path));
  if (!rule) return false; // deny by default
  return rule.anyOf.length === 0 ? !!user : canAny(user, rule.anyOf);
}
