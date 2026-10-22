import type { CurrentUser } from '@addendum/shared';
import { can } from '../auth/permissions.js';
import { db } from '../db/index.js';
import { getSettings } from '../repos/settings.js';
import { listAnnouncements, unreadAnnouncements } from './announcements.js';
import { listEntries, summarize } from './commission.js';
import { addDaysToDate, localDate } from './rebookingSchedule.js';
import { projectionHighlights } from './projections.js';

/**
 * The Dashboard's extra widgets. Each is included only with its widget permission (dashboard:*) AND the permission for
 * its data — so a widget can't show anything the person couldn't open elsewhere. Commission figures come from the
 * same calculation as the commission pages (nothing is recalculated here).
 */
export async function dashboardWidgets(user: CurrentUser, payUnlocked = false) {
  const w = (k: string) => can(user, `dashboard:${k}`);
  const tz = (await getSettings()).business.timezone;
  const today = localDate(new Date(), tz);
  const monday = addDaysToDate(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const week = { from: monday, to: addDaysToDate(monday, 6) };

  const announcements = w('announcements') && can(user, 'announcements:read')
    ? { unread: await unreadAnnouncements(user), latest: (await listAnnouncements(user, { limit: 20 })).filter((a) => a.status === 'published').slice(0, 3) }
    : null;

  let orders = null;
  if (w('orders') && (can(user, 'inventory:order') || can(user, 'inventory:read_all') || can(user, 'inventory:manage'))) {
    const all = can(user, 'inventory:read_all') || can(user, 'inventory:manage');
    const rows = await db().query<any>(
      `SELECT r.id, r.request_number, r.status, r.needed_by, s.name AS for_name,
              (SELECT coalesce(sum(quantity), 0)::int FROM inventory_request_items i WHERE i.request_id = r.id) AS units
         FROM inventory_requests r LEFT JOIN staff s ON s.id = r.for_staff_id
        WHERE r.status IN ('submitted','ordered') ${all ? '' : 'AND (r.for_staff_id = $1 OR r.requested_by_staff_id = $1)'}
        ORDER BY r.needed_by NULLS LAST, r.created_at DESC LIMIT 50`,
      all ? [] : [user.id],
    );
    orders = {
      scope: all ? 'everyone' as const : 'mine' as const, open: rows.length,
      next: rows.slice(0, 3).map((r) => ({ id: r.id, number: Number(r.request_number), status: r.status, neededBy: r.needed_by ? String(r.needed_by instanceof Date ? r.needed_by.toISOString() : r.needed_by).slice(0, 10) : null, forName: r.for_name, units: r.units })),
    };
  }

  const myCommission = w('my_commission') && can(user, 'commission:own')
    // The amount only once they've confirmed their password (same as My Commission); otherwise it shows locked.
    ? { ...week, totalCents: payUnlocked ? summarize(await listEntries({ staffId: user.id, ...week }), week.from, week.to, user.id).totalCommissionCents : null }
    : null;
  const teamCommission = w('team_commission') && can(user, 'commission:team')
    ? { ...week, totalCents: payUnlocked ? summarize((await listEntries({ staffId: 'all', ...week })).filter((e) => e.staffId), week.from, week.to, null).totalCommissionCents : null }
    : null;

  // Projected service revenue: Admin/Owner by default; both the widget and the data permission are needed.
  const projections = w('projections') && can(user, 'revenue:projections') ? await projectionHighlights() : null;

  return {
    projections,
    schedule: w('schedule'),
    priorities: w('priorities'),
    followups: w('followups'),
    clients: w('clients'),
    analytics: w('analytics') && can(user, 'analytics:read'),
    announcements, orders, myCommission, teamCommission,
  };
}
