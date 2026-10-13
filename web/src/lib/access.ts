/** Mirrors of the server's permission rules, used only to decide what to show. The server enforces everything. */

/** Any of these opens the Settings area (each tab has its own permission). */
export const SETTINGS_PERMS = [
  'settings:read', 'settings:write', 'integrations:manage', 'users:manage', 'users:permissions',
  'commission:manage', 'commission:approve', 'rebooking:defaults', 'settings:rules',
];

export const hasAny = (permissions: string[] | undefined, anyOf: string[]) => !!permissions && anyOf.some((p) => permissions.includes(p));
