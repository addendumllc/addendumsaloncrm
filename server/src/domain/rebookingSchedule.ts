import type {
  ClientRebookingOverrideDTO,
  ClientServiceScheduleDTO,
  RebookingStatus,
  ServiceRebookingRuleDTO,
} from '@addendum/shared';
import { db } from '../db/index.js';
import { iso, zonedToUtc } from '../lib/time.js';
import { getSettings } from '../repos/settings.js';
import { autoResolve, createTask } from './tasks.js';

/**
 * Rebooking schedules per client and service.
 *
 * Where each number comes from, in order:
 *   interval      → the client's own interval for that service → the service default (target) → the client's history
 *   next date     → a preferred date the client asked for (if after their last visit) → last visit + interval
 *   reminder      → the client's reminder timing → the service default → 7 days before
 *                   (history-only estimates follow up `graceDays` after the expected date instead, as before)
 *   follow-ups    → the client's on/off → the service default → on; the global "smart rebooking" switch turns all off
 *
 * Client overrides live in client_service_rebooking and never touch the service defaults or other clients.
 * Follow-ups are de-duplicated per client + service + cycle (the last visit date), and are adjusted, closed or
 * cancelled automatically when the schedule changes or the client books.
 */

const DEFAULT_REMIND_DAYS = 7;

// ---------- Date helpers (calendar dates in the salon's time zone, as YYYY-MM-DD) ----------
export function localDate(d: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
}
const toUtcDay = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
export const addDaysToDate = (s: string, n: number) => new Date(toUtcDay(s) + n * 86400_000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((toUtcDay(b) - toUtcDay(a)) / 86400_000);
// DATE columns are always read as text via to_char (drivers turn them into Dates at different midnights).
const dateOnly = (v: unknown): string | null => (typeof v === 'string' && v ? v.slice(0, 10) : null);
const OVERRIDE_COLS = `o.*, to_char(o.preferred_next_date, 'YYYY-MM-DD') AS preferred_next_date, to_char(o.last_visit_date, 'YYYY-MM-DD') AS last_visit_date`;
const prettyDate = (s: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(toUtcDay(s)));
export const describeInterval = (d: number) => (d % 7 === 0 ? `${d / 7} week${d === 7 ? '' : 's'}` : `${d} days`);

// ---------- Suggested starting defaults ----------
const SUGGESTED: { match: RegExp; min: number | null; max: number | null; target: number }[] = [
  { match: /move[\s-]?ups?\b/i, min: 42, max: 56, target: 49 }, // extension move-ups: 6–8 weeks, aim for 7
  { match: /hair\s?cut|\bcut\b|trim/i, min: null, max: null, target: 56 }, // haircuts: about 8 weeks
];

/** Applies the suggested defaults once to services that have just arrived from Square. Never overwrites. */
export async function applySuggestedRebookingDefaults() {
  const fresh = await db().query<{ id: string; name: string }>('SELECT id, name FROM services WHERE NOT rebooking_defaults_applied');
  for (const s of fresh) {
    const hit = SUGGESTED.find((x) => x.match.test(s.name));
    if (hit) {
      await db().query(
        `INSERT INTO service_rebooking_rules(service_id, min_days, max_days, target_days, remind_before_days, auto_follow_up)
         VALUES ($1,$2,$3,$4,$5,true) ON CONFLICT (service_id) DO NOTHING`,
        [s.id, hit.min, hit.max, hit.target, DEFAULT_REMIND_DAYS],
      );
    }
    await db().query('UPDATE services SET rebooking_defaults_applied = true WHERE id = $1', [s.id]);
  }
}

// ---------- Service defaults ----------
const toRuleDTO = (r: any): ServiceRebookingRuleDTO => ({
  serviceId: r.service_id,
  serviceName: r.service_name,
  minDays: r.min_days,
  maxDays: r.max_days,
  targetDays: r.target_days,
  remindBeforeDays: r.remind_before_days,
  autoFollowUp: r.auto_follow_up,
  updatedAt: iso(r.updated_at),
});

export async function listServiceRules(): Promise<{ serviceId: string; serviceName: string; rule: ServiceRebookingRuleDTO | null }[]> {
  const rows = await db().query<any>(
    `SELECT s.id, s.name, r.service_id, s.name AS service_name, r.min_days, r.max_days, r.target_days, r.remind_before_days,
            r.auto_follow_up, r.updated_at
       FROM services s LEFT JOIN service_rebooking_rules r ON r.service_id = s.id
      ORDER BY (r.service_id IS NULL), lower(s.name)`,
  );
  return rows.map((r) => ({ serviceId: r.id, serviceName: r.name, rule: r.service_id ? toRuleDTO(r) : null }));
}

export interface RuleInput {
  minDays: number | null;
  maxDays: number | null;
  targetDays: number;
  remindBeforeDays: number;
  autoFollowUp: boolean;
}

export function validateRule(r: RuleInput): string | null {
  if (r.minDays != null && r.minDays > r.targetDays) return 'The earliest date can’t be after the preferred date.';
  if (r.maxDays != null && r.maxDays < r.targetDays) return 'The latest date can’t be before the preferred date.';
  if (r.remindBeforeDays >= r.targetDays) return 'The reminder must come before the recommended date (fewer days than the interval).';
  return null;
}

export async function saveServiceRule(serviceId: string, r: RuleInput, staffId: string | null) {
  await db().query(
    `INSERT INTO service_rebooking_rules(service_id, min_days, max_days, target_days, remind_before_days, auto_follow_up, updated_by_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (service_id) DO UPDATE SET min_days = EXCLUDED.min_days, max_days = EXCLUDED.max_days, target_days = EXCLUDED.target_days,
       remind_before_days = EXCLUDED.remind_before_days, auto_follow_up = EXCLUDED.auto_follow_up,
       updated_by_staff_id = EXCLUDED.updated_by_staff_id, updated_at = now()`,
    [serviceId, r.minDays, r.maxDays, r.targetDays, r.remindBeforeDays, r.autoFollowUp, staffId],
  );
}

export async function deleteServiceRule(serviceId: string) {
  await db().query('DELETE FROM service_rebooking_rules WHERE service_id = $1', [serviceId]);
}

// ---------- Client overrides ----------
const toOverrideDTO = (r: any): ClientRebookingOverrideDTO => ({
  serviceId: r.service_id,
  intervalDays: r.interval_days,
  preferredNextDate: dateOnly(r.preferred_next_date),
  lastVisitDate: dateOnly(r.last_visit_date),
  remindBeforeDays: r.remind_before_days,
  followUpsEnabled: r.follow_ups_enabled,
  note: r.note,
  updatedAt: iso(r.updated_at),
});

export interface OverrideInput {
  intervalDays: number | null;
  preferredNextDate: string | null;
  lastVisitDate: string | null;
  remindBeforeDays: number | null;
  followUpsEnabled: boolean | null;
  note: string | null;
}

export async function saveClientOverride(clientId: string, serviceId: string, o: OverrideInput, staffId: string | null) {
  const empty = o.intervalDays == null && !o.preferredNextDate && !o.lastVisitDate && o.remindBeforeDays == null && o.followUpsEnabled == null && !o.note;
  if (empty) return deleteClientOverride(clientId, serviceId); // nothing custom left → back to the defaults
  await db().query(
    `INSERT INTO client_service_rebooking(client_id, service_id, interval_days, preferred_next_date, last_visit_date, remind_before_days,
        follow_ups_enabled, note, updated_by_staff_id)
     VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9)
     ON CONFLICT (client_id, service_id) DO UPDATE SET interval_days = EXCLUDED.interval_days,
       preferred_next_date = EXCLUDED.preferred_next_date, last_visit_date = EXCLUDED.last_visit_date,
       remind_before_days = EXCLUDED.remind_before_days, follow_ups_enabled = EXCLUDED.follow_ups_enabled, note = EXCLUDED.note,
       updated_by_staff_id = EXCLUDED.updated_by_staff_id, updated_at = now()`,
    [clientId, serviceId, o.intervalDays, o.preferredNextDate, o.lastVisitDate, o.remindBeforeDays, o.followUpsEnabled, o.note, staffId],
  );
}

export async function deleteClientOverride(clientId: string, serviceId: string) {
  await db().query('DELETE FROM client_service_rebooking WHERE client_id = $1 AND service_id = $2', [clientId, serviceId]);
}

// ---------- Schedule computation ----------
interface Inputs {
  tz: string;
  today: string;
  minVisits: number;
  graceDays: number;
  globalEnabled: boolean;
}

function historyInterval(dates: string[], minVisits: number): number | null {
  if (dates.length < Math.max(2, minVisits)) return null;
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const g = daysBetween(dates[i - 1], dates[i]);
    if (g >= 7) gaps.push(g); // same-week touch-ups don't count
  }
  const recent = gaps.slice(-5).sort((a, b) => a - b);
  if (!recent.length) return null;
  const mid = Math.floor(recent.length / 2);
  return Math.round(recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2);
}

export function computeSchedule(
  p: {
    serviceId: string;
    serviceName: string;
    visitDates: string[]; // completed visits for this service, ascending, unique
    nextBookedDate: string | null; // earliest upcoming booking that includes this service
    otherBookingDate: string | null; // earliest upcoming booking for other services
    rule: ServiceRebookingRuleDTO | null;
    override: ClientRebookingOverrideDTO | null;
    openTaskId?: string | null;
  },
  x: Inputs,
): ClientServiceScheduleDTO {
  const { rule, override: o } = p;
  const squareLast = p.visitDates.at(-1) ?? null;
  const manualLast = o?.lastVisitDate ?? null;
  const lastVisitDate = squareLast && manualLast ? (manualLast > squareLast ? manualLast : squareLast) : squareLast ?? manualLast;
  const lastVisitSource: ClientServiceScheduleDTO['lastVisitSource'] = !lastVisitDate ? null : lastVisitDate === squareLast ? 'square' : 'manual';
  const historyIntervalDays = historyInterval(p.visitDates, x.minVisits);

  let intervalDays: number | null = null;
  let intervalSource: ClientServiceScheduleDTO['intervalSource'] = null;
  if (o?.intervalDays) [intervalDays, intervalSource] = [o.intervalDays, 'client'];
  else if (rule) [intervalDays, intervalSource] = [rule.targetDays, 'service'];
  else if (historyIntervalDays) [intervalDays, intervalSource] = [historyIntervalDays, 'history'];

  const suggestedNextDate = lastVisitDate && intervalDays ? addDaysToDate(lastVisitDate, intervalDays) : null;
  // A preferred date only counts for the current cycle: once they visit after it was set, it's done.
  const preferredValid = !!o?.preferredNextDate && (!lastVisitDate || o.preferredNextDate > lastVisitDate);
  const nextDate = preferredValid ? o!.preferredNextDate : suggestedNextDate;
  const nextDateSource: ClientServiceScheduleDTO['nextDateSource'] = !nextDate ? null : preferredValid ? 'preferred' : 'calculated';

  // The service's window applies when the service default sets the interval.
  const windowStart = intervalSource === 'service' && rule?.minDays && lastVisitDate && !preferredValid ? addDaysToDate(lastVisitDate, rule.minDays) : null;
  const windowEnd = intervalSource === 'service' && rule?.maxDays && lastVisitDate && !preferredValid ? addDaysToDate(lastVisitDate, rule.maxDays) : null;

  let remindBeforeDays: number;
  let remindSource: ClientServiceScheduleDTO['remindSource'];
  if (o?.remindBeforeDays != null) [remindBeforeDays, remindSource] = [o.remindBeforeDays, 'client'];
  else if (rule) [remindBeforeDays, remindSource] = [rule.remindBeforeDays, 'service'];
  else [remindBeforeDays, remindSource] = [DEFAULT_REMIND_DAYS, 'default'];

  let followUpsEnabled: boolean;
  let followUpsSource: ClientServiceScheduleDTO['followUpsSource'];
  if (o?.followUpsEnabled != null) [followUpsEnabled, followUpsSource] = [o.followUpsEnabled, 'client'];
  else if (rule) [followUpsEnabled, followUpsSource] = [rule.autoFollowUp, 'service'];
  else [followUpsEnabled, followUpsSource] = [true, 'default'];
  // The global "Rebooking follow-ups" switch in Settings → Follow-up rules turns them all off at once.
  if (!x.globalEnabled) [followUpsEnabled, followUpsSource] = [false, 'default'];

  // History-only estimates keep the original behaviour: follow up once they're `graceDays` past the usual gap.
  const estimateOnly = intervalSource === 'history' && remindSource === 'default' && !preferredValid;
  const reminderDate = nextDate ? (estimateOnly ? addDaysToDate(nextDate, x.graceDays) : addDaysToDate(nextDate, -remindBeforeDays)) : null;
  const overdueFrom = nextDate ? (estimateOnly ? addDaysToDate(nextDate, x.graceDays) : nextDate) : null;

  let status: RebookingStatus;
  if (p.nextBookedDate) status = 'booked';
  else if (!lastVisitDate && !preferredValid) status = 'no_visit';
  else if (!nextDate) status = 'no_interval';
  else if (!followUpsEnabled) status = 'off';
  else if (x.today > overdueFrom!) status = 'overdue';
  else if (x.today >= reminderDate!) status = 'due_soon';
  else status = 'upcoming';

  return {
    serviceId: p.serviceId,
    serviceName: p.serviceName,
    visits: p.visitDates.length,
    lastVisitDate,
    lastVisitSource,
    intervalDays,
    intervalSource,
    historyIntervalDays,
    serviceDefault: rule
      ? { minDays: rule.minDays, maxDays: rule.maxDays, targetDays: rule.targetDays, remindBeforeDays: rule.remindBeforeDays, autoFollowUp: rule.autoFollowUp }
      : null,
    suggestedNextDate,
    nextDate,
    nextDateSource,
    windowStart,
    windowEnd,
    remindBeforeDays,
    remindSource,
    reminderDate,
    followUpsEnabled,
    followUpsSource,
    status,
    daysUntilNext: nextDate ? daysBetween(x.today, nextDate) : null,
    nextBookedDate: p.nextBookedDate,
    otherBookingDate: p.otherBookingDate,
    override: o,
    openTaskId: p.openTaskId ?? null,
  };
}

interface ScheduleRow extends ClientServiceScheduleDTO {
  clientId: string;
}

async function inputs(now: Date): Promise<Inputs> {
  const s = await getSettings();
  return {
    tz: s.business.timezone,
    today: localDate(now, s.business.timezone),
    minVisits: s.rules.rebookingMinVisits,
    graceDays: s.rules.rebookingGraceDays,
    globalEnabled: s.rules.rebookingEnabled,
  };
}

/** Every client + service schedule (optionally for one client). Includes services the client has visited for or has custom settings for. */
export async function computeSchedules(opts: { clientId?: string } = {}, now = new Date()): Promise<ScheduleRow[]> {
  const x = await inputs(now);
  const p: unknown[] = [now];
  const clientFilter = opts.clientId ? (p.push(opts.clientId), `AND a.client_id = $${p.length}`) : '';
  const appts = await db().query<{ client_id: string; service_id: string; start_at: Date; future: boolean }>(
    `SELECT DISTINCT a.client_id, x.service_id, a.start_at, (a.start_at >= $1) AS future
       FROM appointments a JOIN appointment_services x ON x.appointment_id = a.id JOIN clients c ON c.id = a.client_id
      WHERE c.archived_at IS NULL AND x.service_id IS NOT NULL
        AND ((a.square_status = 'ACCEPTED' AND a.end_at < $1) OR (a.square_status IN ('ACCEPTED','PENDING') AND a.start_at >= $1))
        ${clientFilter}
      ORDER BY a.start_at`,
    p,
  );
  const op: unknown[] = [];
  const ovFilter = opts.clientId ? (op.push(opts.clientId), 'AND o.client_id = $1') : '';
  const overrides = await db().query<any>(
    `SELECT ${OVERRIDE_COLS} FROM client_service_rebooking o JOIN clients c ON c.id = o.client_id WHERE c.archived_at IS NULL ${ovFilter}`, op);
  const rules = new Map((await db().query<any>(
    'SELECT r.*, s.name AS service_name FROM service_rebooking_rules r JOIN services s ON s.id = r.service_id')).map((r) => [r.service_id, toRuleDTO(r)]));
  const names = new Map((await db().query<{ id: string; name: string }>('SELECT id, name FROM services')).map((s) => [s.id, s.name]));
  const tp: unknown[] = [];
  const tFilter = opts.clientId ? (tp.push(opts.clientId), 'AND client_id = $1') : '';
  const openTasks = new Map((await db().query<any>(
    `SELECT id, client_id, service_id FROM tasks WHERE type = 'rebook' AND service_id IS NOT NULL AND status IN ('due','snoozed') ${tFilter}`, tp,
  )).map((t) => [`${t.client_id}|${t.service_id}`, t.id as string]));

  const pairs = new Map<string, { clientId: string; serviceId: string; visits: Set<string>; booked: string | null }>();
  const futureByClient = new Map<string, { serviceId: string; date: string }[]>();
  const pair = (clientId: string, serviceId: string) => {
    const k = `${clientId}|${serviceId}`;
    if (!pairs.has(k)) pairs.set(k, { clientId, serviceId, visits: new Set(), booked: null });
    return pairs.get(k)!;
  };
  for (const a of appts) {
    const d = localDate(a.start_at, x.tz);
    if (a.future) {
      const list = futureByClient.get(a.client_id) ?? [];
      list.push({ serviceId: a.service_id, date: d });
      futureByClient.set(a.client_id, list);
    } else pair(a.client_id, a.service_id).visits.add(d);
  }
  const ovMap = new Map<string, ClientRebookingOverrideDTO>();
  for (const o of overrides) {
    ovMap.set(`${o.client_id}|${o.service_id}`, toOverrideDTO(o));
    pair(o.client_id, o.service_id);
  }
  // Upcoming bookings for each tracked service (visited before, or with custom settings).
  for (const [clientId, list] of futureByClient) {
    for (const f of list) {
      const e = pairs.get(`${clientId}|${f.serviceId}`);
      if (e && (!e.booked || f.date < e.booked)) e.booked = f.date;
    }
  }

  const out: ScheduleRow[] = [];
  for (const [k, v] of pairs) {
    const future = futureByClient.get(v.clientId) ?? [];
    const other = future.filter((f) => f.serviceId !== v.serviceId).map((f) => f.date).sort()[0] ?? null;
    out.push({
      clientId: v.clientId,
      ...computeSchedule({
        serviceId: v.serviceId,
        serviceName: names.get(v.serviceId) ?? 'Service',
        visitDates: [...v.visits].sort(),
        nextBookedDate: v.booked,
        otherBookingDate: other,
        rule: rules.get(v.serviceId) ?? null,
        override: ovMap.get(k) ?? null,
        openTaskId: openTasks.get(k) ?? null,
      }, x),
    });
  }
  const order: Record<RebookingStatus, number> = { overdue: 0, due_soon: 1, upcoming: 2, booked: 3, off: 4, no_interval: 5, no_visit: 6 };
  return out.sort((a, b) => order[a.status] - order[b.status] || (a.nextDate ?? '9999').localeCompare(b.nextDate ?? '9999'));
}

export const clientSchedules = (clientId: string, now = new Date()) =>
  computeSchedules({ clientId }, now).then((rows) => rows.map(({ clientId: _c, ...r }) => r));

/** Number of clients with at least one overdue service schedule (for Analytics). */
export async function countOverdueClients(now = new Date()) {
  const rows = await computeSchedules({}, now);
  return new Set(rows.filter((r) => r.status === 'overdue').map((r) => r.clientId)).size;
}

// ---------- Follow-up tasks ----------
const sourceLabel = (s: ClientServiceScheduleDTO, first: string) =>
  s.nextDateSource === 'preferred' ? `${first}’s preferred date`
    : s.intervalSource === 'client' ? `${first}’s own schedule`
      : s.intervalSource === 'service' ? 'service default' : 'based on visit history';

function taskText(s: ClientServiceScheduleDTO, name: string, first: string) {
  const title = s.status === 'overdue' ? `${name} is overdue for ${s.serviceName}` : `${name} is due for ${s.serviceName} soon`;
  const parts = [
    s.lastVisitDate ? `Last ${s.serviceName} ${prettyDate(s.lastVisitDate)}.` : null,
    s.nextDateSource === 'preferred'
      ? `Asked to come back ${prettyDate(s.nextDate!)}.`
      : `Every ${describeInterval(s.intervalDays!)} (${sourceLabel(s, first)}) → recommended ${prettyDate(s.nextDate!)}${
          s.windowStart && s.windowEnd ? ` (window ${prettyDate(s.windowStart)}–${prettyDate(s.windowEnd)})` : ''}.`,
    s.otherBookingDate ? `Has another visit booked ${prettyDate(s.otherBookingDate)} — consider adding ${s.serviceName}.` : null,
  ];
  return { title, reason: parts.filter(Boolean).join(' ') };
}

export interface RebookingSyncResult {
  created: number;
  updated: number;
  closed: number;
}

/**
 * Creates, adjusts and closes rebooking follow-ups so they match the schedules. Safe to run any number of times.
 * Pass a clientId after changing one client's settings to refresh only that client.
 */
export async function syncRebookingTasks(opts: { clientId?: string } = {}, now = new Date()): Promise<RebookingSyncResult> {
  const x = await inputs(now);
  const schedules = await computeSchedules(opts, now);
  const byKey = new Map(schedules.map((s) => [`${s.clientId}|${s.serviceId}`, s]));
  const result: RebookingSyncResult = { created: 0, updated: 0, closed: 0 };

  // 1. Bring existing open follow-ups in line with the current schedule.
  const tp: unknown[] = [];
  const tFilter = opts.clientId ? (tp.push(opts.clientId), 'AND client_id = $1') : '';
  const open = await db().query<any>(
    `SELECT id, client_id, service_id, status, to_char(rebook_last_visit, 'YYYY-MM-DD') AS rebook_last_visit,
            to_char(rebook_due_date, 'YYYY-MM-DD') AS rebook_due_date, due_at, reason, title FROM tasks
      WHERE type = 'rebook' AND service_id IS NOT NULL AND status IN ('due','snoozed') ${tFilter}`, tp);
  for (const t of open) {
    const s = byKey.get(`${t.client_id}|${t.service_id}`);
    const cycle = dateOnly(t.rebook_last_visit);
    let close: { note: string; status: 'completed' | 'cancelled' } | null = null;
    if (!s) close = { note: 'Auto-closed: no longer applies.', status: 'cancelled' };
    else if (s.status === 'booked') close = { note: `Auto-closed: ${s.serviceName} booked for ${prettyDate(s.nextBookedDate!)} ✓`, status: 'completed' };
    else if (s.lastVisitDate !== cycle) close = { note: `Auto-closed: visited again on ${prettyDate(s.lastVisitDate!)} — schedule recalculated.`, status: 'completed' };
    else if (!s.followUpsEnabled) close = { note: 'Cancelled: follow-ups turned off for this client and service.', status: 'cancelled' };
    else if (!s.nextDate) close = { note: 'Cancelled: no rebooking interval set any more.', status: 'cancelled' };
    if (close) {
      await db().query(
        `UPDATE tasks SET status = $2, completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
           notes = trim(both E'\\n' FROM COALESCE(notes, '') || E'\\n' || $3), updated_at = now() WHERE id = $1`,
        [t.id, close.status, close.note]);
      result.closed++;
      continue;
    }
    if (dateOnly(t.rebook_due_date) !== s!.nextDate || s!.reminderDate !== localDate(t.due_at, x.tz)) {
      const c = await db().one<any>('SELECT first_name, last_name FROM clients WHERE id = $1', [t.client_id]);
      const { title, reason } = taskText(s!, `${c.first_name} ${c.last_name}`.trim(), c.first_name || 'Client');
      // Not due yet under the new schedule → tucked away (snoozed) until its reminder date; otherwise any snooze the team set is kept.
      const dueAt = reminderDue(s!.reminderDate!, x.tz);
      await db().query(
        `UPDATE tasks SET title = $2, reason = $3, rebook_due_date = $4::date, rebook_interval_days = $5, rebook_source = $6,
           status = CASE WHEN $7::timestamptz > now() THEN 'snoozed' ELSE status END,
           snoozed_until = CASE WHEN $7::timestamptz > now() THEN $7::timestamptz ELSE snoozed_until END,
           due_at = CASE WHEN $7::timestamptz > now() OR status <> 'snoozed' THEN $7::timestamptz ELSE due_at END, updated_at = now(),
           hl_status = CASE WHEN hl_status = 'synced' THEN 'pending' ELSE hl_status END,
           hl_next_retry_at = CASE WHEN hl_status = 'synced' THEN now() ELSE hl_next_retry_at END
         WHERE id = $1`,
        [t.id, title, reason, s!.nextDate, s!.intervalDays, s!.nextDateSource === 'preferred' ? 'preferred' : s!.intervalSource, dueAt]);
      result.updated++;
    }
  }

  // 2. Create follow-ups that have come due.
  for (const s of schedules) {
    if (s.status !== 'due_soon' && s.status !== 'overdue') continue;
    if (s.otherBookingDate) continue; // already coming in — the note shows on their profile instead
    // An open cancellation / no-show / older general rebooking follow-up already covers this client.
    const covered = await db().one(
      `SELECT 1 FROM tasks WHERE client_id = $1 AND status IN ('due','snoozed')
         AND (type IN ('cancellation','no_show') OR (type = 'rebook' AND (service_id IS NULL OR service_id = $2))) LIMIT 1`,
      [s.clientId, s.serviceId]);
    if (covered) continue;
    const c = await db().one<any>('SELECT first_name, last_name, preferred_staff_id FROM clients WHERE id = $1', [s.clientId]);
    if (!c) continue;
    const { title, reason } = taskText(s, `${c.first_name} ${c.last_name}`.trim(), c.first_name || 'Client');
    const overdueBy = s.nextDate ? daysBetween(s.nextDate, x.today) : 0;
    const cycle = s.lastVisitDate ?? `preferred-${s.nextDate}`;
    const id = await createTask({
      type: 'rebook', title, reason,
      priority: overdueBy > 21 ? 'high' : 'medium',
      dueAt: reminderDue(s.reminderDate!, x.tz),
      clientId: s.clientId, assignedStaffId: c.preferred_staff_id, sourceRule: 'rebooking',
      dedupeKey: `rebook:${s.clientId}:${s.serviceId}:${cycle}`, automation: 'overdue_rebook',
    });
    if (id) {
      await db().query(
        `UPDATE tasks SET service_id = $2, rebook_last_visit = $3::date, rebook_due_date = $4::date, rebook_interval_days = $5, rebook_source = $6
          WHERE id = $1`,
        [id, s.serviceId, s.lastVisitDate, s.nextDate, s.intervalDays, s.nextDateSource === 'preferred' ? 'preferred' : s.intervalSource]);
      result.created++;
    }
  }
  return result;
}

/** Follow-ups are due at 9am salon time on the reminder date. */
function reminderDue(date: string, tz: string) {
  return zonedToUtc(+date.slice(0, 4), +date.slice(5, 7), +date.slice(8, 10), 9, 0, tz);
}

/** Older general rebooking follow-ups (from before per-service schedules) close when the client books anything. */
export async function resolveLegacyRebookTasks(now: Date) {
  return autoResolve(
    `type = 'rebook' AND service_id IS NULL AND client_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM appointments a WHERE a.client_id = tasks.client_id AND a.square_status IN ('ACCEPTED','PENDING')
         AND a.start_at >= $1 AND COALESCE(a.square_created_at, a.created_at) >= tasks.created_at - interval '1 hour')`,
    [now], 'Auto-closed: client rebooked in Square ✓',
  );
}
