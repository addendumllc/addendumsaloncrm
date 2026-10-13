import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../auth/session.js';
import { db } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { DAY } from '../lib/time.js';
import { handleInboundSms } from '../domain/messaging.js';
import { runRules } from '../domain/rulesEngine.js';
import { syncSingleBooking } from '../domain/squareSync.js';
import { isDemo } from '../integrations/registry.js';
import { loadDemoHL, saveDemoHL } from '../integrations/highlevel/MockHighLevelService.js';
import { demoSquareSimulator, loadDemoSquare } from '../integrations/square/MockSquareService.js';
import { seedDemo } from '../seed/demo.js';
import { ah, parse } from './util.js';

/**
 * DEMO MODE simulators: act as Square / a client's phone / HighLevel so staff can try every
 * workflow without real accounts. Disabled entirely when DEMO_MODE is off.
 */
export const demoRouter = Router();
demoRouter.use((_req, _res, next) => (isDemo() ? next() : next(notFound('Demo tools'))));

demoRouter.post('/reset', requirePermission('integrations:manage'), ah(async (_req, res) => {
  await seedDemo();
  res.json({ ok: true });
}));

/** Simulate a client texting the salon number. */
demoRouter.post('/inbound-sms', ah(async (req, res) => {
  const b = parse(z.object({ from: z.string().min(7).max(40).optional(), clientId: z.string().uuid().optional(), body: z.string().trim().min(1).max(1000) }), req.body);
  let from = b.from;
  if (b.clientId) from = (await db().one<any>('SELECT phone FROM clients WHERE id = $1', [b.clientId]))?.phone;
  if (!from) from = `+1619555${Math.floor(3000 + Math.random() * 6000)}`;
  const r = await handleInboundSms({ from, body: b.body, providerMessageId: `demo-in-${Date.now()}` });
  await runRules();
  res.json(r);
}));

/** Simulate a change made in Square, then deliver it like a booking.updated webhook. */
demoRouter.post('/square/:appointmentId/:action', ah(async (req, res) => {
  const action = req.params.action;
  const appt = await db().one<any>('SELECT square_booking_id, start_at FROM appointments WHERE id = $1', [req.params.appointmentId]);
  if (!appt) throw notFound('That appointment');
  const patch =
    action === 'cancel' ? { status: 'CANCELLED_BY_CUSTOMER' as const }
    : action === 'no-show' ? { status: 'NO_SHOW' as const }
    : action === 'accept' ? { status: 'ACCEPTED' as const }
    : action === 'reschedule' ? { start_at: new Date(new Date(appt.start_at).getTime() + 2 * DAY).toISOString() }
    : null;
  if (!patch) throw badRequest('Unknown demo action.');
  await demoSquareSimulator.updateBooking(appt.square_booking_id, patch);
  const change = await syncSingleBooking(appt.square_booking_id);
  res.json({ change });
}));

/** Simulate a client booking online in Square (e.g. after a follow-up text). */
demoRouter.post('/square/book', ah(async (req, res) => {
  const { clientId, daysFromNow } = parse(z.object({ clientId: z.string().uuid(), daysFromNow: z.number().min(0).max(120).default(5) }), req.body);
  const c = await db().one<any>('SELECT square_customer_id, preferred_staff_id FROM clients WHERE id = $1', [clientId]);
  if (!c?.square_customer_id) throw badRequest('This demo client is not in Square yet.');
  const s = await loadDemoSquare();
  const staff = await db().one<any>('SELECT square_team_member_id FROM staff WHERE id = $1', [c.preferred_staff_id]);
  const start = new Date(Date.now() + daysFromNow * DAY);
  start.setUTCMinutes(0, 0, 0);
  const svc = s.services[2];
  const b = await demoSquareSimulator.createBooking({
    status: 'ACCEPTED', start_at: start.toISOString(), location_id: s.locations[0].id, customer_id: c.square_customer_id,
    appointment_segments: [{ duration_minutes: svc.durationMinutes ?? 60, service_variation_id: svc.variationId, team_member_id: staff?.square_team_member_id ?? s.team[1].id }],
  });
  const change = await syncSingleBooking(b.id);
  res.json({ change });
}));

demoRouter.get('/highlevel', ah(async (_req, res) => res.json(await loadDemoHL())));

demoRouter.post('/highlevel/outage', ah(async (req, res) => {
  const { on } = parse(z.object({ on: z.boolean() }), req.body);
  await saveDemoHL({ ...(await loadDemoHL()), outage: on });
  res.json({ outage: on });
}));
