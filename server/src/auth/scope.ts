import type { CurrentUser } from '@addendum/shared';
import { db } from '../db/index.js';
import { notFound } from '../lib/errors.js';
import { can } from './permissions.js';

/**
 * Record-level filtering: what a person may see inside a section they can open. Applied on the server before data
 * leaves it, so hidden information never reaches the browser.
 */

/** null = every client; a staff id = only clients that person has served or is assigned to. */
export function clientScope(user: CurrentUser | undefined): string | null {
  if (can(user, 'clients:read')) return null;
  return user!.id;
}

/** SQL condition: client `alias` is assigned to / served by staff `$n`. */
export const assignedClientSql = (alias: string, n: number) =>
  `(${alias}.preferred_staff_id = $${n} OR EXISTS (SELECT 1 FROM client_staff cs WHERE cs.client_id = ${alias}.id AND cs.staff_id = $${n})
     OR EXISTS (SELECT 1 FROM appointments sa WHERE sa.client_id = ${alias}.id AND sa.staff_id = $${n}))`;

/** Throws "not found" (not "forbidden", so existence isn't revealed) when the client is outside the person's scope. */
export async function assertClientVisible(user: CurrentUser | undefined, clientId: string) {
  const scope = clientScope(user);
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw notFound('That client');
  const row = scope
    ? await db().one(`SELECT 1 FROM clients c WHERE c.id = $1 AND ${assignedClientSql('c', 2)}`, [clientId, scope])
    : await db().one('SELECT 1 FROM clients WHERE id = $1', [clientId]);
  if (!row) throw notFound('That client');
}

/** Removes phone numbers and emails unless the person may see contact details. */
export function maskContact<T extends { phone?: string | null; email?: string | null }>(user: CurrentUser | undefined, obj: T): T {
  if (can(user, 'clients:contact')) return obj;
  return { ...obj, ...('phone' in obj ? { phone: null } : {}), ...('email' in obj ? { email: null } : {}), contactHidden: true };
}

/**
 * Whose appointments someone may see. "Can view team calendars" = everyone, or only the team members chosen on their
 * account (plus their own); otherwise "their own calendar" only. null = no calendar access. Viewing never allows changes
 * (appointments are a read-only copy of Square).
 */
export function calendarScope(user: CurrentUser | undefined): { all: true } | { ids: string[] } | null {
  if (!user) return null;
  if (can(user, 'appointments:read')) {
    return user.calendarStaffIds ? { ids: [...new Set([user.id, ...user.calendarStaffIds])] } : { all: true };
  }
  if (can(user, 'appointments:read_own')) return { ids: [user.id] };
  return null;
}
