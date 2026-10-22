import { Router, type Request } from 'express';
import { z } from 'zod';
import type { TimeClockStatusDTO } from '@addendum/shared';
import { accessStatus } from '../auth/access.js';
import { can } from '../auth/permissions.js';
import { requireAnyPermission, requirePermission } from '../auth/session.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { squareService } from '../integrations/registry.js';
import { addShift, fixDoubledInSquare, clockIn, clockOut, clockedInNow, deleteShift, editShift, endBreak, getSchedule, listShifts, openShift, pushShift, recentShifts, setSchedule, startBreak, todaysSchedule } from '../domain/timeclock.js';
import { ah, logAction, parse } from './util.js';

/** Time Clock: for people with "Use the time clock". Schedules are set by people who manage pay. */
export const timeclockRouter = Router();

/** Clocking in/out only on the salon's approved network, unless they have "Clock in from anywhere". */
async function networkCheck(req: Request) {
  const st = await accessStatus(req);
  const needs = st.configured && !st.overridden && !can(req.user, 'timeclock:anywhere');
  return { needs, onSalonNetwork: st.onSalonNetwork, ok: !needs || st.onSalonNetwork };
}
async function assertOnNetwork(req: Request) {
  if (!(await networkCheck(req)).ok) throw forbidden('The time clock only works on the salon’s Wi-Fi. Connect to the salon network, then try again.');
}

timeclockRouter.get('/me', requirePermission('timeclock:use'), ah(async (req, res) => {
  const net = await networkCheck(req);
  const body: TimeClockStatusDTO = {
    shift: await openShift(req.user!.id), today: await todaysSchedule(req.user!.id), schedule: await getSchedule(req.user!.id),
    recent: await recentShifts(req.user!.id), needsSalonNetwork: net.needs, onSalonNetwork: net.onSalonNetwork,
  };
  res.json(body);
}));

timeclockRouter.post('/in', requirePermission('timeclock:use'), ah(async (req, res) => {
  await assertOnNetwork(req);
  const shift = await clockIn(req.user!.id, await squareService());
  await logAction(req, 'timeclock.in', 'staff', req.user!.id);
  res.json({ shift });
}));

timeclockRouter.post('/break', requirePermission('timeclock:use'), ah(async (req, res) => {
  const { kind } = parse(z.object({ kind: z.enum(['lunch', 'rest']) }), req.body);
  await assertOnNetwork(req);
  res.json({ shift: await startBreak(req.user!.id, kind, await squareService()) });
}));

timeclockRouter.post('/break/end', requirePermission('timeclock:use'), ah(async (req, res) => {
  await assertOnNetwork(req);
  res.json({ shift: await endBreak(req.user!.id, await squareService()) });
}));

timeclockRouter.post('/out', requirePermission('timeclock:use'), ah(async (req, res) => {
  await assertOnNetwork(req);
  const shift = await clockOut(req.user!.id, await squareService());
  await logAction(req, 'timeclock.out', 'staff', req.user!.id, { paidMinutes: shift.paidMinutes, square: shift.squareSent });
  res.json({ shift });
}));

/** Managers: who's clocked in now. */
timeclockRouter.get('/now', requireAnyPermission('commission:team', 'commission:manage'), ah(async (_req, res) => {
  res.json({ shifts: await clockedInNow() });
}));

const day = z.object({
  weekday: z.number().int().min(0).max(6), start: z.string().regex(/^[0-2]\d:[0-5]\d$/).nullable(), end: z.string().regex(/^[0-2]\d:[0-5]\d$/).nullable(),
  lunchMinutes: z.number().int().min(0).max(180).default(30), breakMinutes: z.number().int().min(0).max(60).default(10),
});
timeclockRouter.get('/schedule/:staffId', requireAnyPermission('commission:manage', 'commission:team', 'users:manage'), ah(async (req, res) => {
  res.json({ schedule: await getSchedule(req.params.staffId) });
}));
timeclockRouter.put('/schedule/:staffId', requireAnyPermission('commission:manage', 'users:manage'), ah(async (req, res) => {
  const { days } = parse(z.object({ days: z.array(day).max(7) }), req.body);
  await setSchedule(req.params.staffId, days);
  await logAction(req, 'timeclock.schedule', 'staff', req.params.staffId, { days: days.length });
  res.json({ schedule: await getSchedule(req.params.staffId) });
}));

// ---------- Editing shifts (Owners/Admins): changes go to Payroll hours and Square ----------
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const at = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'must be a date and time');
const shiftInput = z.object({
  clockInAt: at, clockOutAt: at.nullable(),
  breaks: z.array(z.object({ kind: z.enum(['lunch', 'rest']), startedAt: at, endedAt: at.nullable(), plannedMinutes: z.number().int().min(0).max(180).optional() })).max(10),
});
const ownerAdmin = (req: Request, _res: unknown, next: (e?: unknown) => void) =>
  next(req.user?.role === 'admin' && can(req.user, 'commission:manage') ? undefined : forbidden('Only an Owner or Admin can change time clock shifts.'));

timeclockRouter.get('/shifts', requireAnyPermission('commission:team', 'commission:manage'), ah(async (req, res) => {
  const q = parse(z.object({ from: ymd, to: ymd, staffId: z.string().uuid().optional() }), req.query);
  res.json({ shifts: await listShifts(q.from, q.to, q.staffId) });
}));

timeclockRouter.post('/shifts', ownerAdmin, ah(async (req, res) => {
  const b = parse(shiftInput.extend({ staffId: z.string().uuid() }), req.body);
  const shift = await addShift(b.staffId, b, await squareService());
  await logAction(req, 'timeclock.shift_add', 'staff', b.staffId, { paidMinutes: shift.paidMinutes, square: shift.squareSent });
  res.status(201).json({ shift });
}));

timeclockRouter.put('/shifts/:id', ownerAdmin, ah(async (req, res) => {
  const b = parse(shiftInput, req.body);
  const shift = await editShift(req.params.id, b, await squareService());
  await logAction(req, 'timeclock.shift_edit', 'staff', shift.staffId, { shiftId: shift.id, paidMinutes: shift.paidMinutes, square: shift.squareSent });
  res.json({ shift });
}));

/** Send (again) to Square — e.g. after connecting Square or linking the person. */
/** Owners/Admins: clean up days counted twice in Square for these dates (one person or everyone). */
timeclockRouter.post('/shifts/fix-doubles', ownerAdmin, ah(async (req, res) => {
  const b = parse(z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), staffId: z.string().uuid().optional() }), req.body);
  const sq = await squareService();
  if (!sq) throw badRequest('Square isn’t connected.');
  const r = await fixDoubledInSquare(sq, b.from, b.to, b.staffId);
  await logAction(req, 'timeclock.fix_doubles', 'staff', b.staffId ?? null, { from: b.from, to: b.to, days: r.days, removed: r.removed });
  res.json(r);
}));

timeclockRouter.post('/shifts/:id/square', ownerAdmin, ah(async (req, res) => {
  const shift = await pushShift(req.params.id, await squareService());
  await logAction(req, 'timeclock.shift_resend', 'staff', shift.staffId, { shiftId: shift.id, square: shift.squareSent });
  res.json({ shift });
}));

timeclockRouter.delete('/shifts/:id', ownerAdmin, ah(async (req, res) => {
  await deleteShift(req.params.id, await squareService());
  await logAction(req, 'timeclock.shift_delete', 'time_clock_shift', req.params.id);
  res.json({ ok: true });
}));
