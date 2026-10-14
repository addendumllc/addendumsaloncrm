import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../auth/session.js';
import { projectionAppointments, projections, rangeDays } from '../domain/projections.js';
import { badRequest } from '../lib/errors.js';
import { ah, logAction, parse } from './util.js';

/** Projected service revenue — Admin/Owner by default ("revenue:projections", checked here for every request). */
export const projectionsRouter = Router();
projectionsRouter.use(requirePermission('revenue:projections'));

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)').refine((s) => !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().startsWith(s), 'must be a real date');
const range = z.object({ from: ymd, to: ymd }).refine((r) => r.from <= r.to, 'the start date must be before the end date');
const check = (r: { from: string; to: string }) => { if (rangeDays(r.from, r.to) > 731) throw badRequest('Choose a range of two years or less.'); };

projectionsRouter.get('/', ah(async (req, res) => {
  const r = parse(range.and(z.object({ by: z.enum(['day', 'week', 'month']).default('day') })), req.query);
  check(r);
  res.json(await projections(r));
}));

projectionsRouter.get('/appointments', ah(async (req, res) => {
  const r = parse(range, req.query);
  check(r);
  await logAction(req, 'projections.appointments_view', 'appointments', null, r);
  res.json({ appointments: await projectionAppointments(r.from, r.to) });
}));
