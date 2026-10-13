import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { runRules } from '../src/domain/rulesEngine.js';
import { addDaysToDate, computeSchedule, localDate } from '../src/domain/rebookingSchedule.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: Awaited<ReturnType<typeof setup>>['app'];
let emma: string;
let moveUp: string;
const TZ = 'America/Los_Angeles';
const today = () => localDate(new Date(), TZ);

beforeAll(async () => {
  ({ api, app } = await setup());
  emma = (await db().one<any>("SELECT id FROM clients WHERE first_name = 'Emma' AND last_name = 'Rodriguez'")).id;
  moveUp = (await db().one<any>("SELECT id FROM services WHERE name = 'Extension Move-Up'")).id;
});

const emmaSchedule = async () =>
  ((await api.get(`/api/rebooking/clients/${emma}`)).body.schedules as any[]).find((s) => s.serviceId === moveUp);
const emmaTasks = (status = "('due','snoozed')") =>
  db().query<any>(`SELECT * FROM tasks WHERE client_id = $1 AND service_id = $2 AND type = 'rebook' AND status IN ${status}`, [emma, moveUp]);

describe('Schedule calculation', () => {
  const x = { tz: TZ, today: '2026-10-12', minVisits: 3, graceDays: 7, globalEnabled: true };
  const rule = { serviceId: 's', serviceName: 'Extension Move-Up', minDays: 42, maxDays: 56, targetDays: 49, remindBeforeDays: 7, autoFollowUp: true, updatedAt: null };
  const base = { serviceId: 's', serviceName: 'Extension Move-Up', visitDates: ['2026-07-01', '2026-08-20'], nextBookedDate: null, otherBookingDate: null, rule, override: null };

  it('uses the service default: window 6–8 weeks, target 7, reminder a week before', () => {
    const s = computeSchedule(base, x);
    expect(s).toMatchObject({ intervalDays: 49, intervalSource: 'service', nextDate: '2026-10-08', windowStart: '2026-10-01', windowEnd: '2026-10-15',
      reminderDate: '2026-10-01', status: 'overdue', lastVisitDate: '2026-08-20' });
  });

  it('a client’s own interval and reminder override the default for that client only', () => {
    const o = { serviceId: 's', intervalDays: 63, preferredNextDate: null, lastVisitDate: null, remindBeforeDays: 3, followUpsEnabled: null, note: null, updatedAt: null };
    const s = computeSchedule({ ...base, override: o }, x);
    expect(s).toMatchObject({ intervalDays: 63, intervalSource: 'client', nextDate: '2026-10-22', reminderDate: '2026-10-19', remindSource: 'client',
      windowStart: null, status: 'upcoming' });
    expect(s.serviceDefault?.targetDays).toBe(49); // default still shown for comparison
  });

  it('a preferred date wins for the current cycle, and expires after their next visit', () => {
    const o = { serviceId: 's', intervalDays: null, preferredNextDate: '2026-11-01', lastVisitDate: null, remindBeforeDays: null, followUpsEnabled: null, note: null, updatedAt: null };
    expect(computeSchedule({ ...base, override: o }, x)).toMatchObject({ nextDate: '2026-11-01', nextDateSource: 'preferred', status: 'upcoming' });
    const visitedSince = computeSchedule({ ...base, visitDates: [...base.visitDates, '2026-11-02'], override: o }, x);
    expect(visitedSince).toMatchObject({ nextDateSource: 'calculated', nextDate: addDaysToDate('2026-11-02', 49) });
  });

  it('a last visit entered by hand counts when it is newer than Square’s', () => {
    const o = { serviceId: 's', intervalDays: null, preferredNextDate: null, lastVisitDate: '2026-09-30', remindBeforeDays: null, followUpsEnabled: null, note: null, updatedAt: null };
    expect(computeSchedule({ ...base, override: o }, x)).toMatchObject({ lastVisitDate: '2026-09-30', lastVisitSource: 'manual', nextDate: '2026-11-18' });
  });

  it('booked, off, and history-only estimates', () => {
    expect(computeSchedule({ ...base, nextBookedDate: '2026-10-20' }, x).status).toBe('booked');
    expect(computeSchedule({ ...base, rule: { ...rule, autoFollowUp: false } }, x).status).toBe('off');
    expect(computeSchedule(base, { ...x, globalEnabled: false }).status).toBe('off');
    const hist = computeSchedule({ ...base, rule: null, visitDates: ['2026-05-01', '2026-06-12', '2026-07-24'] }, x);
    expect(hist).toMatchObject({ intervalSource: 'history', intervalDays: 42, nextDate: '2026-09-04', reminderDate: '2026-09-11', status: 'overdue' });
    expect(computeSchedule({ ...base, rule: null, visitDates: ['2026-07-24'] }, x).status).toBe('no_interval');
  });
});

describe('Rebooking by service and client', () => {
  it('ships editable starting defaults: move-ups 6–8 weeks (target 7), haircuts about 8 weeks', async () => {
    const services = (await api.get('/api/rebooking/services')).body.services as any[];
    expect(services.find((s) => s.serviceName === 'Extension Move-Up').rule).toMatchObject({ minDays: 42, maxDays: 56, targetDays: 49 });
    expect(services.find((s) => s.serviceName === "Women's Haircut").rule).toMatchObject({ targetDays: 56 });
    expect(services.find((s) => s.serviceName === 'Balayage').rule).toBeNull();
  });

  it('creates one follow-up per client, service and cycle, with service, last visit and recommended date', async () => {
    const s = await emmaSchedule();
    expect(s.intervalSource).toBe('service');
    expect(s.status).toBe('overdue');
    const tasks = await emmaTasks();
    expect(tasks.length).toBe(1);
    const dto = (await api.get(`/api/tasks/${tasks[0].id}`)).body.task;
    expect(dto.serviceName).toBe('Extension Move-Up');
    expect(dto.rebook).toMatchObject({ lastVisitDate: s.lastVisitDate, recommendedDate: s.nextDate, intervalDays: 49, source: 'service' });
    await runRules();
    await runRules();
    expect((await emmaTasks()).length).toBe(1); // no duplicates
  });

  it('a custom interval for one client moves their follow-up and leaves everyone else alone', async () => {
    const before = (await api.get('/api/rebooking/services')).body.services.find((s: any) => s.serviceId === moveUp).rule;
    const others = await db().query<any>(`SELECT id, due_at, status FROM tasks WHERE type = 'rebook' AND client_id <> $1 ORDER BY id`, [emma]);
    const s0 = await emmaSchedule();
    const daysSince = -Number(((new Date(s0.lastVisitDate).getTime() - Date.parse(today())) / 86400_000).toFixed(0));
    const r = await api.put(`/api/rebooking/clients/${emma}/services/${moveUp}`, { intervalDays: daysSince + 21, remindBeforeDays: 5 });
    expect(r.status).toBe(200);
    const s = r.body.schedules.find((x: any) => x.serviceId === moveUp);
    expect(s).toMatchObject({ intervalSource: 'client', remindSource: 'client', status: 'upcoming' });
    const [t] = await emmaTasks();
    expect(t.status).toBe('snoozed'); // not due yet → tucked away until the new reminder date
    expect(localDate(t.due_at, TZ)).toBe(s.reminderDate);
    expect((await api.get('/api/rebooking/services')).body.services.find((x: any) => x.serviceId === moveUp).rule).toEqual(before);
    expect(await db().query<any>(`SELECT id, due_at, status FROM tasks WHERE type = 'rebook' AND client_id <> $1 ORDER BY id`, [emma])).toEqual(others);
  });

  it('turning follow-ups off for a client cancels the open one; resetting brings back the defaults', async () => {
    await api.put(`/api/rebooking/clients/${emma}/services/${moveUp}`, { followUpsEnabled: false });
    expect((await emmaTasks()).length).toBe(0);
    expect((await emmaSchedule()).status).toBe('off');
    const reset = await api.del(`/api/rebooking/clients/${emma}/services/${moveUp}`);
    expect(reset.status).toBe(200);
    const s = await emmaSchedule();
    expect(s.override).toBeNull();
    expect(s.intervalSource).toBe('service');
  });

  it('a new appointment closes the follow-up and recalculates the next date', async () => {
    await db().query("DELETE FROM tasks WHERE client_id = $1 AND service_id = $2", [emma, moveUp]);
    await runRules();
    expect((await emmaTasks()).length).toBe(1);
    const start = new Date(Date.now() - 2 * 86400_000);
    const a = await db().one<any>(
      `INSERT INTO appointments(square_booking_id, client_id, start_at, end_at, square_status) VALUES ('test-moveup', $1, $2, $3, 'ACCEPTED') RETURNING id`,
      [emma, start, new Date(start.getTime() + 2 * 3600_000)]);
    await db().query("INSERT INTO appointment_services(appointment_id, position, service_id, service_name) VALUES ($1, 0, $2, 'Extension Move-Up')", [a.id, moveUp]);
    await runRules();
    expect((await emmaTasks()).length).toBe(0);
    const closed = (await emmaTasks("('completed')")).at(-1);
    expect(closed.notes).toMatch(/visited again/);
    const s = await emmaSchedule();
    expect(s.lastVisitDate).toBe(localDate(start, TZ));
    expect(s.nextDate).toBe(addDaysToDate(localDate(start, TZ), 49));
    expect(s.status).toBe('upcoming');
  });

  it('“Not needed” closes it for this cycle without it coming back', async () => {
    const victoria = await db().one<any>(`SELECT t.id, t.client_id, t.service_id FROM tasks t JOIN clients c ON c.id = t.client_id
       WHERE c.first_name = 'Victoria' AND t.type = 'rebook' AND t.status = 'due'`);
    const r = await api.post(`/api/tasks/${victoria.id}/not-needed`, { note: 'Moving away' });
    expect(r.body.task.status).toBe('cancelled');
    expect(r.body.task.notes).toMatch(/Not needed: Moving away/);
    await runRules();
    expect(await db().one(`SELECT 1 FROM tasks WHERE client_id = $1 AND type = 'rebook' AND status IN ('due','snoozed')`, [victoria.client_id])).toBeNull();
  });

  it('editing a service default re-checks follow-ups and validates the numbers', async () => {
    const bad = await api.put(`/api/rebooking/services/${moveUp}`, { minDays: 60, targetDays: 49, maxDays: 56, remindBeforeDays: 7, autoFollowUp: true });
    expect(bad.status).toBe(400);
    const ok = await api.put(`/api/rebooking/services/${moveUp}`, { minDays: 42, maxDays: 63, targetDays: 56, remindBeforeDays: 10, autoFollowUp: true });
    expect(ok.status).toBe(200);
    expect((await emmaSchedule()).intervalDays).toBe(56);
  });

  it('lists everyone’s upcoming recommended dates', async () => {
    const rows = (await api.get('/api/rebooking/schedule?status=all')).body.rows as any[];
    expect(rows.length).toBeGreaterThan(5);
    expect(rows[0]).toHaveProperty('clientName');
    expect(new Set(rows.map((r) => `${r.clientId}|${r.serviceId}`)).size).toBe(rows.length);
  });

  it('only administrators change service defaults; front desk can adjust a client', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'frontdesk@addendumsalon.com', password: 'addendum-demo' });
    expect((await agent.put(`/api/rebooking/services/${moveUp}`).set('X-Requested-With', 'addendum-crm').send({ targetDays: 30 })).status).toBe(403);
    expect((await agent.put(`/api/rebooking/clients/${emma}/services/${moveUp}`).set('X-Requested-With', 'addendum-crm').send({ intervalDays: 50 })).status).toBe(200);
    const stylist = request.agent(app);
    await stylist.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'jennifer@addendumsalon.com', password: 'addendum-demo' });
    expect((await stylist.get(`/api/rebooking/clients/${emma}`)).status).toBe(403);
  });
});
