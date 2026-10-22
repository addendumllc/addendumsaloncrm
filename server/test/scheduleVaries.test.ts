import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/index.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let staffId: string;

beforeAll(async () => {
  ({ api } = await setup());
  staffId = (await db().one<any>("SELECT id FROM staff WHERE email = 'frontdesk@addendumsalon.com'")).id;
});

describe('Work schedules with varying hours', () => {
  it('a day can be “hours vary” (no set times) next to days with set hours', async () => {
    const r = await api.put(`/api/timeclock/schedule/${staffId}`, { days: [
      { weekday: 1, start: '09:00', end: '17:00', lunchMinutes: 30, breakMinutes: 10 },
      { weekday: 3, start: null, end: null, lunchMinutes: 30, breakMinutes: 10 },
    ] });
    expect(r.status).toBe(200);
    expect(r.body.schedule).toEqual([
      { weekday: 1, start: '09:00', end: '17:00', lunchMinutes: 30, breakMinutes: 10 },
      { weekday: 3, start: null, end: null, lunchMinutes: 30, breakMinutes: 10 },
    ]);
    // Only one of the two times isn't a valid day.
    const half = await api.put(`/api/timeclock/schedule/${staffId}`, { days: [{ weekday: 2, start: '09:00', end: null, lunchMinutes: 30, breakMinutes: 10 }] });
    expect(half.status).toBe(400);
    await api.put(`/api/timeclock/schedule/${staffId}`, { days: [] });
  });
});
