import type { DashboardSummary, RecommendedAction } from '@addendum/shared';
import { db } from '../db/index.js';
import { addDays, dayBounds, DAY } from '../lib/time.js';
import { getSettings } from '../repos/settings.js';

/**
 * "Today's Priorities": summary counts + a short list of recommended actions,
 * each pointing at the exact filtered list where staff can act in one click.
 * Staff role sees only their own follow-ups (staffId).
 */
export async function dashboard(staffId: string | null, now = new Date()) {
  const s = await getSettings();
  const { start, end } = dayBounds(now, s.business.timezone);
  const mine = staffId ? 'AND (t.assigned_staff_id = $3 OR t.assigned_staff_id IS NULL)' : '';
  const tp = staffId ? [now, end, staffId] : [now, end];
  const openTask = `(t.status = 'due' OR (t.status = 'snoozed' AND t.snoozed_until <= now()))`;

  const byType = await db().query<{ type: string; n: number; overdue: number }>(
    `SELECT t.type, count(*)::int AS n, count(*) FILTER (WHERE t.due_at < $1)::int AS overdue
       FROM tasks t WHERE ${openTask} AND t.due_at < $2 AND t.kind = 'follow_up' ${mine} GROUP BY t.type`,
    tp,
  );
  const count = (types: string[]) => byType.filter((r) => types.includes(r.type)).reduce((a, r) => a + r.n, 0);
  const dueTotal = byType.reduce((a, r) => a + r.n, 0);
  const overdueTotal = byType.reduce((a, r) => a + r.overdue, 0);

  const appts = await db().one<any>(
    `SELECT count(*) FILTER (WHERE start_at >= $1 AND start_at < $2 AND square_status IN ('ACCEPTED','PENDING','NO_SHOW'))::int AS today,
            count(*) FILTER (WHERE square_status LIKE 'CANCELLED%' AND COALESCE(square_updated_at, updated_at) >= $3)::int AS cancellations,
            count(*) FILTER (WHERE square_status = 'NO_SHOW' AND start_at >= $3)::int AS no_shows,
            count(*) FILTER (WHERE square_status = 'PENDING' AND start_at >= $4)::int AS pending,
            count(*) FILTER (WHERE square_status = 'ACCEPTED' AND start_at >= $2 AND start_at < $5 AND client_confirmed_at IS NULL)::int AS unconfirmed_tomorrow
       FROM appointments`,
    [start, end, new Date(now.getTime() - 7 * DAY), now, addDays(end, 1)],
  );
  const leads = await db().one<any>(
    `SELECT count(*) FILTER (WHERE status = 'new')::int AS new_leads,
            count(*) FILTER (WHERE status IN ('waiting','contacted') )::int AS waiting
       FROM leads WHERE archived_at IS NULL`,
  );
  const unread = await db().one<any>(
    `SELECT COALESCE(sum(unread_count),0)::int AS n, count(*) FILTER (WHERE unread_count > 0)::int AS convos FROM conversations WHERE archived_at IS NULL`,
  );
  const hlFailed = await db().one<any>(`SELECT count(*)::int AS n FROM tasks WHERE hl_status IN ('failed','needs_contact') AND status <> 'cancelled'`);

  const summary: DashboardSummary = {
    appointmentsToday: appts.today,
    newLeads: leads.new_leads,
    followUpsDue: dueTotal,
    overdueFollowUps: overdueTotal,
    unreadMessages: unread.n,
    readyToRebook: count(['rebook']),
    cancellations: appts.cancellations,
    noShows: appts.no_shows,
    pendingConfirmations: appts.pending,
  };

  const actions: RecommendedAction[] = [];
  const push = (a: Omit<RecommendedAction, 'count'> & { count: number }) => a.count > 0 && actions.push(a);
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  push({ key: 'unread', count: unread.convos, priority: 'high', icon: 'message', title: `Reply to ${plural(unread.convos, 'unread conversation')}`,
    description: 'Clients are waiting on a text back.', actionLabel: 'Open messages', link: '/messages?filter=unread' });
  push({ key: 'new_lead', count: count(['new_lead']), priority: 'high', icon: 'sparkles', title: `Follow up with ${plural(count(['new_lead']), 'new client')}`,
    description: "New inquiries that haven't been contacted yet.", actionLabel: 'Contact new clients', link: '/follow-ups?type=new_lead' });
  push({ key: 'no_show', count: count(['no_show']), priority: 'high', icon: 'alert', title: `Follow up with ${plural(count(['no_show']), 'no-show')}`,
    description: 'Check in kindly and offer a new time.', actionLabel: 'Review', link: '/follow-ups?type=no_show' });
  push({ key: 'lead_no_response', count: count(['follow_up']), priority: 'medium', icon: 'clock', title: `Nudge ${plural(count(['follow_up']), 'lead')} waiting for a response`,
    description: "They haven't replied to your last message.", actionLabel: 'Follow up', link: '/follow-ups?type=follow_up' });
  push({ key: 'cancellation', count: count(['cancellation']), priority: 'medium', icon: 'calendar-x', title: `Contact ${plural(count(['cancellation']), 'client')} who cancelled but haven't rebooked`,
    description: 'Cancelled in Square with nothing new on the books.', actionLabel: 'Rebook', link: '/follow-ups?type=cancellation' });
  push({ key: 'consultation', count: count(['consultation']), priority: 'high', icon: 'sparkles', title: `Book ${plural(count(['consultation']), 'client')} after their consultation`,
    description: 'Strike while the excitement is fresh.', actionLabel: 'Book', link: '/follow-ups?type=consultation' });
  push({ key: 'rebook', count: count(['rebook']), priority: 'medium', icon: 'repeat', title: `Contact ${plural(count(['rebook']), 'client')} overdue for rebooking`,
    description: 'Based on how often each client usually books in Square.', actionLabel: 'View clients', link: '/follow-ups?type=rebook' });
  push({ key: 'pending', count: appts.pending, priority: 'medium', icon: 'calendar', title: `Accept ${plural(appts.pending, 'pending booking')} in Square`,
    description: 'These requests are waiting for the salon to accept them in Square.', actionLabel: 'View', link: '/appointments?view=list&status=needs_attention' });
  push({ key: 'confirm', count: appts.unconfirmed_tomorrow, priority: 'low', icon: 'check', title: `Confirm ${plural(appts.unconfirmed_tomorrow, "of tomorrow's appointment", "of tomorrow's appointments")}`,
    description: "Clients who haven't confirmed tomorrow's visit.", actionLabel: 'View tomorrow', link: '/appointments?view=list&range=tomorrow' });
  push({ key: 'reminder', count: count(['appointment_reminder']), priority: 'low', icon: 'bell', title: `Send ${plural(count(['appointment_reminder']), 'appointment reminder')}`,
    description: 'Reminder texts ready for review.', actionLabel: 'Review', link: '/follow-ups?type=appointment_reminder' });
  push({ key: 'review', count: count(['review_request']), priority: 'low', icon: 'star', title: `Ask ${plural(count(['review_request']), 'recent client')} for reviews`,
    description: 'Happy clients from the last few days.', actionLabel: 'Send requests', link: '/follow-ups?type=review_request' });
  push({ key: 'hl_failed', count: hlFailed.n, priority: 'low', icon: 'refresh', title: `${plural(hlFailed.n, 'follow-up')} need attention in HighLevel`,
    description: "They're safe here — retry or create the missing contact.", actionLabel: 'Review', link: '/tasks?hl=failed' });

  return { summary, actions };
}
