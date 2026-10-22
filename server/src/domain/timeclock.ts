import type { ClockShiftDTO, ScheduleDayDTO } from '@addendum/shared';
import { db } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { iso, zonedToUtc } from '../lib/time.js';
import type { SquareService, TimecardBreakInput } from '../integrations/square/types.js';
import { getSettings } from '../repos/settings.js';
import { localDate } from './rebookingSchedule.js';
import { squareTargetWithJob, syncTimecards, timecardScopeHint } from './wages.js';

/**
 * Time clock: clock in, take lunch (unpaid) and short breaks (paid), clock out. On clock-out the paid time goes into
 * Payroll hours and the shift is sent to Square as one timecard per shift, with an unpaid lunch on it as an unpaid break
 * (the location's lunch break type in Square). If Square can't be reached the hours still count in the CRM.
 */

const minutesBetween = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));

/** A shift's unpaid lunches, as unpaid breaks on its Square timecard (paid breaks don't change the hours). */
const lunchBreaks = (s: ClockShiftDTO): TimecardBreakInput[] => s.breaks.filter((b) => !b.paid)
  .map((b) => ({ startAt: new Date(b.startedAt), endAt: b.endedAt ? new Date(b.endedAt) : null, paid: false, plannedMinutes: b.plannedMinutes ?? 30 }));

const SHIFT_SELECT = `SELECT t.*, st.name AS staff_name,
    (SELECT count(*)::int FROM staff_hours h WHERE h.square_timecard_id = ANY(t.square_timecard_ids)) AS square_found
  FROM time_clock_shifts t JOIN staff st ON st.id = t.staff_id`;

async function loadShift(id: string): Promise<ClockShiftDTO> {
  const s = await db().one<any>(`${SHIFT_SELECT} WHERE t.id = $1`, [id]);
  if (!s) throw notFound('That shift');
  const breaks = await db().query<any>('SELECT * FROM time_clock_breaks WHERE shift_id = $1 ORDER BY started_at', [id]);
  return toShift(s, breaks);
}

function toShift(s: any, breaks: any[]): ClockShiftDTO {
  const end = s.clock_out_at ? new Date(s.clock_out_at) : new Date();
  const unpaid = breaks.filter((b) => !b.paid).reduce((a, b) => a + minutesBetween(new Date(b.started_at), b.ended_at ? new Date(b.ended_at) : end), 0);
  return {
    id: s.id, staffId: s.staff_id, staffName: s.staff_name, clockInAt: iso(s.clock_in_at)!, clockOutAt: iso(s.clock_out_at),
    paidMinutes: s.paid_minutes ?? Math.max(0, minutesBetween(new Date(s.clock_in_at), end) - unpaid),
    breaks: breaks.map((b) => ({ id: b.id, kind: b.kind, paid: b.paid, plannedMinutes: b.planned_minutes, startedAt: iso(b.started_at)!, endedAt: iso(b.ended_at) })),
    squareSent: (s.square_timecard_ids ?? []).length > 0, squareError: s.square_error ?? null,
    // Sent, but a sync no longer finds those timecards: they were deleted in Square.
    squareRemoved: (s.square_timecard_ids ?? []).length > 0 && s.square_found === 0 && !!s.clock_out_at,
    squareLive: !s.clock_out_at && !!s.square_live && !!s.square_open_timecard_id,
    usesSquareHours: (s.square_error ?? '').startsWith('Square already has timecards'),
  };
}

export async function openShift(staffId: string) {
  const r = await db().one<any>('SELECT id FROM time_clock_shifts WHERE staff_id = $1 AND clock_out_at IS NULL', [staffId]);
  return r ? loadShift(r.id) : null;
}

export async function recentShifts(staffId: string, days = 14) {
  const rows = await db().query<any>(`${SHIFT_SELECT} WHERE t.staff_id = $1 AND t.clock_in_at > now() - make_interval(days => $2) ORDER BY t.clock_in_at DESC`, [staffId, days]);
  const out: ClockShiftDTO[] = [];
  for (const r of rows) out.push(toShift(r, await db().query('SELECT * FROM time_clock_breaks WHERE shift_id = $1 ORDER BY started_at', [r.id])));
  return out;
}

/** Everyone clocked in right now (for managers). */
export async function clockedInNow() {
  const rows = await db().query<any>('SELECT id FROM time_clock_shifts WHERE clock_out_at IS NULL ORDER BY clock_in_at');
  return Promise.all(rows.map((r) => loadShift(r.id)));
}

// ---------- Weekly schedule ----------
export async function getSchedule(staffId: string): Promise<ScheduleDayDTO[]> {
  const rows = await db().query<any>('SELECT * FROM staff_schedules WHERE staff_id = $1 ORDER BY weekday', [staffId]);
  return rows.map((r) => ({ weekday: r.weekday, start: r.start_time, end: r.end_time, lunchMinutes: r.lunch_minutes, breakMinutes: r.break_minutes }));
}

export async function setSchedule(staffId: string, days: ScheduleDayDTO[]) {
  for (const d of days) {
    if ((d.start == null) !== (d.end == null)) throw badRequest('Give a day both a start and an end time, or mark its hours as varying.');
    if (d.start != null && d.end != null && d.end <= d.start) throw badRequest('Each day’s end time must be after its start time.');
  }
  if (new Set(days.map((d) => d.weekday)).size !== days.length) throw badRequest('Each day can only be listed once.');
  await db().tx(async (q) => {
    await q.query('DELETE FROM staff_schedules WHERE staff_id = $1', [staffId]);
    for (const d of days) {
      await q.query('INSERT INTO staff_schedules(staff_id, weekday, start_time, end_time, lunch_minutes, break_minutes) VALUES ($1,$2,$3,$4,$5,$6)',
        [staffId, d.weekday, d.start, d.end, d.lunchMinutes, d.breakMinutes]);
    }
  });
}

/** Their schedule for today (salon time), if they work today. */
export async function todaysSchedule(staffId: string) {
  const tz = (await getSettings()).business.timezone;
  const weekday = new Date(`${localDate(new Date(), tz)}T12:00:00Z`).getUTCDay();
  return (await getSchedule(staffId)).find((d) => d.weekday === weekday) ?? null;
}

// ---------- Clocking ----------
/**
 * Clocking in through the CRM clocks them in on Square too (a live timecard under their assigned job). An unpaid lunch
 * ends that timecard and coming back starts a new one; clock-out ends it. If any Square step fails, the shift carries on
 * in the CRM and is sent to Square in full at clock-out instead.
 */
async function squareLiveFailed(shiftId: string, e: unknown) {
  const err = timecardScopeHint(e) as { userMessage?: string; message: string };
  await db().query('UPDATE time_clock_shifts SET square_live = false, square_open_timecard_id = NULL, square_error = $2 WHERE id = $1',
    [shiftId, `Couldn’t clock in on Square live (${err.userMessage ?? 'Square couldn’t be reached'}). The shift will be sent at clock-out.`]);
}

async function openOnSquare(sq: SquareService, shiftId: string, staffId: string, at: Date, n: number) {
  const t = await squareTargetWithJob(sq, staffId);
  const id = await sq.openTimecard({ teamMemberId: t.teamMemberId, locationId: t.locationId, startAt: at, job: t.job }, `clockin-${shiftId}-${n}`);
  await db().query('UPDATE time_clock_shifts SET square_live = true, square_open_timecard_id = $2, square_timecard_ids = array_append(square_timecard_ids, $2), square_error = NULL WHERE id = $1', [shiftId, id]);
}

export async function clockIn(staffId: string, sq: SquareService | null = null) {
  if (await openShift(staffId)) throw badRequest('You’re already clocked in.');
  const r = await db().one<{ id: string; clock_in_at: Date }>('INSERT INTO time_clock_shifts(staff_id) VALUES ($1) RETURNING id, clock_in_at', [staffId]);
  if (sq) await openOnSquare(sq, r!.id, staffId, new Date(r!.clock_in_at), 0).catch((e) => squareLiveFailed(r!.id, e));
  return loadShift(r!.id);
}

const liveState = (shiftId: string) => db().one<{ square_live: boolean; square_open_timecard_id: string | null; n: number }>(
  'SELECT square_live, square_open_timecard_id, coalesce(array_length(square_timecard_ids, 1), 0) AS n FROM time_clock_shifts WHERE id = $1', [shiftId]);

export async function startBreak(staffId: string, kind: 'lunch' | 'rest', sq: SquareService | null = null) {
  const shift = await openShift(staffId);
  if (!shift) throw badRequest('Clock in first.');
  if (shift.breaks.some((b) => !b.endedAt)) throw badRequest('You’re already on a break. End it first.');
  const today = await todaysSchedule(staffId);
  const planned = kind === 'lunch' ? today?.lunchMinutes ?? 30 : today?.breakMinutes ?? 10;
  await db().query('INSERT INTO time_clock_breaks(shift_id, kind, paid, planned_minutes) VALUES ($1,$2,$3,$4)', [shift.id, kind, kind === 'rest', planned]);
  // Unpaid lunch: an unpaid break starts on their Square timecard too (one timecard for the whole shift).
  const live = await liveState(shift.id);
  if (kind === 'lunch' && sq && live?.square_live && live.square_open_timecard_id) {
    await sq.setTimecardBreaks(live.square_open_timecard_id, lunchBreaks(await loadShift(shift.id))).catch((e) => squareLiveFailed(shift.id, e));
  }
  return loadShift(shift.id);
}

export async function endBreak(staffId: string, sq: SquareService | null = null) {
  const shift = await openShift(staffId);
  const open = shift?.breaks.find((b) => !b.endedAt);
  if (!shift || !open) throw badRequest('You’re not on a break.');
  const [b] = await db().query<{ ended_at: Date }>('UPDATE time_clock_breaks SET ended_at = now() WHERE id = $1 RETURNING ended_at', [open.id]);
  // Back from lunch: the break on their Square timecard ends. (A shift from before lunch breaks were used on Square,
  // whose timecard was closed for lunch, is clocked in again instead.)
  const live = await liveState(shift.id);
  if (open.kind === 'lunch' && sq && live?.square_live) {
    const done = live.square_open_timecard_id
      ? sq.setTimecardBreaks(live.square_open_timecard_id, lunchBreaks(await loadShift(shift.id)))
      : openOnSquare(sq, shift.id, staffId, new Date(b.ended_at), live.n);
    await done.catch((e) => squareLiveFailed(shift.id, e));
  }
  return loadShift(shift.id);
}

/**
 * Clock out: closes any open break, records the paid time in Payroll hours and sends the shift to Square (one timecard
 * with lunch on it as an unpaid break). If Square fails, the hours are kept in the CRM and the reason is shown.
 */
export async function clockOut(staffId: string, sq: SquareService | null) {
  const shift = await openShift(staffId);
  if (!shift) throw badRequest('You’re not clocked in.');
  const now = new Date();
  await db().query('UPDATE time_clock_breaks SET ended_at = $2 WHERE shift_id = $1 AND ended_at IS NULL', [shift.id, now]);
  await db().query('UPDATE time_clock_shifts SET clock_out_at = $2 WHERE id = $1', [shift.id, now]);
  // Clocked in on Square live: clock out there too, then record the hours from those timecards.
  const live = await liveState(shift.id);
  if (sq && live?.square_live) {
    try {
      if (live.square_open_timecard_id) await sq.closeTimecard(live.square_open_timecard_id, now, lunchBreaks(await loadShift(shift.id)));
      const done = await recordLiveShift(shift.id);
      if (done) return done;
    } catch (e) {
      await squareLiveFailed(shift.id, e);
    }
  }
  // Otherwise (or if anything didn't line up): send the whole shift now, replacing any partial timecards.
  return pushShift(shift.id, sq);
}

/** Payroll hours for a shift clocked live on Square: its Square timecard (older shifts: one per worked stretch). null if they don't match. */
async function recordLiveShift(shiftId: string) {
  const closed = await loadShift(shiftId);
  const ids: string[] = (await db().one<any>('SELECT square_timecard_ids FROM time_clock_shifts WHERE id = $1', [shiftId]))?.square_timecard_ids ?? [];
  // One timecard for the shift, lunch on it as an unpaid break: its paid time is the shift's.
  if (ids.length === 1) {
    const tz1 = (await getSettings()).business.timezone;
    await db().tx(async (q) => {
      if (closed.paidMinutes > 0) await q.query(`INSERT INTO staff_hours(staff_id, work_date, minutes, source, square_timecard_id, note) VALUES ($1,$2,$3,'square',$4,'Time clock')
        ON CONFLICT (square_timecard_id) DO NOTHING`, [closed.staffId, localDate(new Date(closed.clockInAt), tz1), closed.paidMinutes, ids[0]]);
      await q.query('UPDATE time_clock_shifts SET paid_minutes = $2, square_error = NULL, square_open_timecard_id = NULL WHERE id = $1', [shiftId, closed.paidMinutes]);
    });
    return loadShift(shiftId);
  }
  const segments: { start: Date; end: Date }[] = [];
  let cursor = new Date(closed.clockInAt);
  for (const b of closed.breaks.filter((x) => !x.paid)) {
    segments.push({ start: cursor, end: new Date(b.startedAt) });
    cursor = new Date(b.endedAt ?? b.startedAt);
  }
  segments.push({ start: cursor, end: new Date(closed.clockOutAt!) });
  if (segments.length !== ids.length) return null;
  const tz = (await getSettings()).business.timezone;
  const date = localDate(new Date(closed.clockInAt), tz);
  await db().tx(async (q) => {
    for (const [i, x] of segments.entries()) {
      const m = minutesBetween(x.start, x.end);
      if (m > 0) await q.query(`INSERT INTO staff_hours(staff_id, work_date, minutes, source, square_timecard_id, note) VALUES ($1,$2,$3,'square',$4,'Time clock')
        ON CONFLICT (square_timecard_id) DO NOTHING`, [closed.staffId, date, m, ids[i]]);
    }
    await q.query('UPDATE time_clock_shifts SET paid_minutes = $2, square_error = NULL, square_open_timecard_id = NULL WHERE id = $1', [shiftId, closed.paidMinutes]);
  });
  return loadShift(shiftId);
}

/**
 * Every Square timecard this person has on this day (salon time) — synced ones, plus any Square has that aren't synced
 * yet — except those belonging to their other time clock shifts that day.
 */
async function squareCardsForDay(sq: SquareService | null, shiftId: string, staffId: string, date: string, tz: string) {
  const rows = await db().query<{ square_timecard_id: string }>(
    `SELECT square_timecard_id FROM staff_hours WHERE staff_id = $1 AND work_date = $2::date AND source = 'square' AND square_timecard_id IS NOT NULL`, [staffId, date]);
  const ids = new Set(rows.map((r) => r.square_timecard_id));
  const member = (await db().one<{ square_team_member_id: string | null }>('SELECT square_team_member_id FROM staff WHERE id = $1', [staffId]))?.square_team_member_id;
  if (sq && member) {
    const [y, m, d] = date.split('-').map(Number);
    const from = zonedToUtc(y, m, d, 0, 0, tz);
    const cards = await sq.listTimecards(from, new Date(from.getTime() + 24 * 3600_000 - 1)).catch(() => []);
    for (const c of cards) if (c.team_member_id === member && localDate(new Date(c.start_at), tz) === date) ids.add(c.id);
  }
  const others = await db().query<{ id: string }>(
    'SELECT unnest(square_timecard_ids) AS id FROM time_clock_shifts WHERE staff_id = $1 AND id <> $2', [staffId, shiftId]);
  for (const o of others) ids.delete(o.id);
  return [...ids];
}

/**
 * Puts a finished shift into Payroll hours and Square. The latest time clock change is the one record of that day: every
 * Square timecard the person has that day (this shift's earlier ones after an edit, and any made on Square itself) is
 * deleted, then one timecard for the shift is created, each unpaid lunch on it as an unpaid break — so a day is never counted twice.
 * If Square can't be updated, the reason is shown and the day still counts once.
 */
export async function pushShift(shiftId: string, sq: SquareService | null) {
  const closed = await loadShift(shiftId);
  if (!closed.clockOutAt) throw badRequest('This shift is still open.');
  const prev = await db().one<any>('SELECT square_timecard_ids, staff_hours_id FROM time_clock_shifts WHERE id = $1', [shiftId]);
  const staffId = closed.staffId;
  const tz = (await getSettings()).business.timezone;
  const date = localDate(new Date(closed.clockInAt), tz);
  const end = new Date(closed.clockOutAt);


  let ids: string[] = [];
  let error: string | null = null;
  // The day's timecards in Square: this shift's earlier ones and any others (e.g. clocked on Square itself).
  const own: string[] = prev?.square_timecard_ids ?? [];
  const existing = [...new Set([...own, ...(await squareCardsForDay(sq, shiftId, staffId, date, tz))])];
  const removed: string[] = [];
  if (sq) {
    try {
      // Old timecards first, so nothing is doubled in Square.
      for (const id of existing) {
        await sq.deleteTimecard(id);
        removed.push(id);
      }
      const t = await squareTargetWithJob(sq, staffId);
      const v = Date.now().toString(36); // a fresh key each time, or Square would return the deleted timecard
      // One timecard, clock-in to clock-out, with each unpaid lunch on it as an unpaid break.
      ids.push(await sq.createTimecard({ teamMemberId: t.teamMemberId, locationId: t.locationId, startAt: new Date(closed.clockInAt), endAt: end, job: t.job, breaks: lunchBreaks(closed) }, `clock-${shiftId}-${v}`));
    } catch (e) {
      const err = timecardScopeHint(e) as { userMessage?: string; message: string };
      error = err.userMessage ?? 'Square couldn’t be updated. The hours are saved here.';
      ids = [];
    }
  } else error = 'Square isn’t connected — the hours are saved here only.';

  // Square timecards that couldn't be removed still count for the day, so the shift isn't added on top of them.
  const left = existing.filter((id) => !removed.includes(id) && !own.includes(id));
  const leftMinutes = left.length
    ? (await db().one<{ m: number }>('SELECT coalesce(sum(minutes), 0)::int AS m FROM staff_hours WHERE square_timecard_id = ANY($1::text[])', [left]))?.m ?? 0
    : 0;
  if (error && leftMinutes > 0) error = `Square already has timecards for this day that couldn’t be replaced (${error}) Square’s hours are used for payroll until this shift is sent again.`;

  // Payroll hours: from the Square timecards when made (so a sync never counts them twice), otherwise by hand.
  let hoursId: string | null = null;
  await db().tx(async (q) => {
    await q.query('DELETE FROM staff_hours WHERE square_timecard_id = ANY($1::text[]) OR id = $2', [[...own, ...removed], prev?.staff_hours_id ?? null]);
    if (leftMinutes > 0) {
      // Square's remaining hours count; nothing added on top.
    } else if (ids.length) {
      await q.query(`INSERT INTO staff_hours(staff_id, work_date, minutes, source, square_timecard_id, note) VALUES ($1,$2,$3,'square',$4,'Time clock')
        ON CONFLICT (square_timecard_id) DO NOTHING`, [staffId, date, closed.paidMinutes, ids[0]]);
    } else if (closed.paidMinutes > 0) {
      const [r] = await q.query<{ id: string }>(`INSERT INTO staff_hours(staff_id, work_date, minutes, source, note) VALUES ($1,$2,$3,'manual','Time clock') RETURNING id`, [staffId, date, closed.paidMinutes]);
      hoursId = r.id;
    }
    await q.query('UPDATE time_clock_shifts SET paid_minutes = $2, square_timecard_ids = $3, square_error = $4, staff_hours_id = $5 WHERE id = $1',
      [shiftId, closed.paidMinutes, ids, error, hoursId]);
  });
  return loadShift(shiftId);
}

/**
 * Cleans up days counted twice in Square (timecards that overlap for the same person, e.g. sent before these fixes):
 * a day with a time clock shift is sent again (the latest shift replaces that day's timecards); otherwise the most
 * recently changed timecard is kept and the ones overlapping it are deleted. Payroll hours are then re-read from Square.
 */
export async function fixDoubledInSquare(sq: SquareService, from: string, to: string, staffId?: string) {
  const tz = (await getSettings()).business.timezone;
  const dayStart = (d: string) => zonedToUtc(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10), 0, 0, tz);
  const start = dayStart(from);
  const end = new Date(dayStart(to).getTime() + 24 * 3600_000 - 1);
  const staff = new Map((await db().query<{ id: string; square_team_member_id: string }>(
    `SELECT id, square_team_member_id FROM staff WHERE square_team_member_id IS NOT NULL ${staffId ? 'AND id = $1' : ''}`, staffId ? [staffId] : [])).map((s) => [s.square_team_member_id, s.id]));
  const groups = new Map<string, { staffId: string; date: string; cards: Awaited<ReturnType<SquareService['listTimecards']>> }>();
  for (const c of await sq.listTimecards(start, end)) {
    const who = staff.get(c.team_member_id);
    if (!who || !c.end_at) continue;
    const date = localDate(new Date(c.start_at), tz);
    const g = groups.get(`${who}:${date}`) ?? { staffId: who, date, cards: [] };
    g.cards.push(c);
    groups.set(`${who}:${date}`, g);
  }
  const span = (c: { start_at: string; end_at?: string | null }) => [Date.parse(c.start_at), Date.parse(c.end_at!)] as const;
  const overlap = (a: { start_at: string; end_at?: string | null }, b: { start_at: string; end_at?: string | null }) => span(a)[0] < span(b)[1] && span(b)[0] < span(a)[1];
  let days = 0;
  let removed = 0;
  const failed: string[] = [];
  for (const g of groups.values()) {
    if (!g.cards.some((a, i) => g.cards.some((b, j) => i < j && overlap(a, b)))) continue;
    days++;
    try {
      const shifts = await db().query<{ id: string }>(
        `SELECT id FROM time_clock_shifts WHERE staff_id = $1 AND clock_out_at IS NOT NULL AND (clock_in_at AT TIME ZONE $3)::date = $2::date ORDER BY clock_in_at`, [g.staffId, g.date, tz]);
      if (shifts.length) {
        for (const s of shifts) {
          const r = await pushShift(s.id, sq);
          if (r.squareError) failed.push(`${r.staffName} ${g.date}: ${r.squareError}`);
        }
        continue;
      }
      // Latest change first; anything overlapping a kept timecard goes.
      const sorted = [...g.cards].sort((a, b) => (b.updated_at ?? b.created_at ?? b.start_at).localeCompare(a.updated_at ?? a.created_at ?? a.start_at));
      const kept: typeof sorted = [];
      for (const c of sorted) {
        if (kept.some((k) => overlap(k, c))) {
          await sq.deleteTimecard(c.id);
          await db().query('DELETE FROM staff_hours WHERE square_timecard_id = $1', [c.id]);
          removed++;
        } else kept.push(c);
      }
    } catch (e) {
      const err = timecardScopeHint(e) as { userMessage?: string; message: string };
      failed.push(`${g.date}: ${err.userMessage ?? err.message}`);
    }
  }
  // Payroll hours re-read from Square (a day either side, so the whole range is refreshed).
  await syncTimecards(sq, new Date(start.getTime() - 24 * 3600_000), new Date(end.getTime() + 24 * 3600_000));
  return { days, removed, failed };
}

// ---------- Editing (Owners/Admins) ----------
export interface ShiftInput {
  clockInAt: string;
  clockOutAt: string | null;
  breaks: { kind: 'lunch' | 'rest'; startedAt: string; endedAt: string | null; plannedMinutes?: number }[];
}

function checkShift(x: ShiftInput) {
  const inAt = new Date(x.clockInAt);
  const outAt = x.clockOutAt ? new Date(x.clockOutAt) : null;
  if (outAt && outAt <= inAt) throw badRequest('Clock-out must be after clock-in.');
  if (outAt && outAt.getTime() - inAt.getTime() > 24 * 3600_000) throw badRequest('A shift can’t be longer than 24 hours.');
  if (inAt > new Date() || (outAt && outAt > new Date(Date.now() + 60_000))) throw badRequest('Shifts can’t be in the future.');
  for (const b of x.breaks) {
    const bs = new Date(b.startedAt);
    const be = b.endedAt ? new Date(b.endedAt) : null;
    if (bs < inAt || (outAt && bs > outAt) || (be && (be < bs || (outAt && be > outAt)))) throw badRequest('Breaks must be inside the shift, and end after they start.');
  }
}

async function writeBreaks(q: { query: (sql: string, p?: unknown[]) => Promise<unknown> }, shiftId: string, breaks: ShiftInput['breaks']) {
  await q.query('DELETE FROM time_clock_breaks WHERE shift_id = $1', [shiftId]);
  for (const b of breaks) {
    await q.query('INSERT INTO time_clock_breaks(shift_id, kind, paid, planned_minutes, started_at, ended_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [shiftId, b.kind, b.kind === 'rest', b.plannedMinutes ?? (b.kind === 'lunch' ? 30 : 10), b.startedAt, b.endedAt]);
  }
}

/** Changes a shift's times and breaks; a finished shift is then re-sent to Payroll hours and Square. */
export async function editShift(shiftId: string, x: ShiftInput, sq: SquareService | null) {
  await loadShift(shiftId);
  checkShift(x);
  await db().tx(async (q) => {
    await q.query('UPDATE time_clock_shifts SET clock_in_at = $2, clock_out_at = $3, paid_minutes = NULL WHERE id = $1', [shiftId, x.clockInAt, x.clockOutAt]);
    await writeBreaks(q, shiftId, x.breaks);
  });
  return x.clockOutAt ? pushShift(shiftId, sq) : loadShift(shiftId);
}

/** A shift someone forgot to clock: added afterwards, then sent like any other. */
export async function addShift(staffId: string, x: ShiftInput, sq: SquareService | null) {
  if (!x.clockOutAt) throw badRequest('Add the clock-out time too.');
  checkShift(x);
  const id = await db().tx(async (q) => {
    const [r] = await q.query<{ id: string }>('INSERT INTO time_clock_shifts(staff_id, clock_in_at, clock_out_at) VALUES ($1,$2,$3) RETURNING id', [staffId, x.clockInAt, x.clockOutAt]);
    await writeBreaks(q, r.id, x.breaks);
    return r.id;
  });
  return pushShift(id, sq);
}

/** Removes a shift, its Payroll hours and its timecards in Square. */
export async function deleteShift(shiftId: string, sq: SquareService | null) {
  const prev = await db().one<any>('SELECT square_timecard_ids, staff_hours_id FROM time_clock_shifts WHERE id = $1', [shiftId]);
  if (!prev) throw notFound('That shift');
  if (prev.square_timecard_ids?.length) {
    if (!sq) throw badRequest('Square isn’t connected, so its timecards can’t be removed. Connect Square first.');
    try {
      for (const id of prev.square_timecard_ids) await sq.deleteTimecard(id);
    } catch (e) {
      throw timecardScopeHint(e);
    }
  }
  await db().tx(async (q) => {
    await q.query('DELETE FROM staff_hours WHERE square_timecard_id = ANY($1::text[]) OR id = $2', [prev.square_timecard_ids ?? [], prev.staff_hours_id]);
    await q.query('DELETE FROM time_clock_shifts WHERE id = $1', [shiftId]);
  });
}

/** Shifts for a date range (salon time), one person or everyone. */
export async function listShifts(from: string, to: string, staffId?: string) {
  const tz = (await getSettings()).business.timezone;
  const rows = await db().query<any>(
    `${SHIFT_SELECT} WHERE (t.clock_in_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date ${staffId ? 'AND t.staff_id = $4' : ''} ORDER BY t.clock_in_at`,
    staffId ? [from, to, tz, staffId] : [from, to, tz]);
  const out: ClockShiftDTO[] = [];
  for (const r of rows) out.push(toShift(r, await db().query('SELECT * FROM time_clock_breaks WHERE shift_id = $1 ORDER BY started_at', [r.id])));
  return out;
}

