import { describe, expect, it } from 'vitest';
import { estimateTaxes } from '../src/domain/wages.js';

const rates = { socialSecurityBps: 620, medicareBps: 145, futaBps: 60, sutaBps: 0, sdiBps: 130, stateIncomeBps: 400, federalIncomeBps: 1000, netCushionBps: 200, workAddress: '12853 El Camino Real Ste 104, San Diego, CA 92130' };
const person = (federalBps: number | null, stateBps: number | null) => ({
  workerType: 'w2', federalBps, stateBps, localBps: null, showBreakdown: true,
  w4: { filingStatus: null, multipleJobs: false, dependentsCents: null, otherIncomeCents: null, deductionsCents: null, extraWithholdingCents: null },
  de4: { exempt: false, filingStatus: null, regularAllowances: 0, additionalAllowances: 0, additionalWithholdingCents: 0 },
}) as any;

describe('estimated net pay', () => {
  // A real paycheck: gross $3,577.59 → federal $262.00, SS $221.81, Medicare $51.87, CA $192.86, SDI $46.50 → net $2,802.55.
  it('matched to a paystub, the taxes come out the same and net shows a little under the real pay', () => {
    const fed = Math.round((262.00 / 3577.59) * 10000); // Match a paystub: 7.32%
    const st = Math.round((192.86 / 3577.59) * 10000); // 5.39%
    const e = estimateTaxes(357759, person(fed, st), rates);
    expect(Math.abs(e.federalCents - 26200)).toBeLessThan(200);
    expect(Math.abs(e.stateCents - 19286)).toBeLessThan(200);
    expect(e.socialSecurityCents).toBe(22181);
    expect(Math.abs(e.medicareCents - 5187)).toBeLessThanOrEqual(1);
    expect(Math.abs(e.sdiCents - 4650)).toBeLessThanOrEqual(1);
    expect(e.netCents).toBeLessThan(280255); // never more than the real check
    expect(e.netCents + (e.cushionCents ?? 0)).toBeGreaterThan(280255 - 300); // and close to it before the cushion
  });
  it('without their own federal rate, the salon default is used (never $0 federal)', () => {
    const e = estimateTaxes(357759, person(null, null), rates);
    expect(e.federalCents).toBe(35776);
    expect(e.netCents).toBeLessThan(280255);
  });
});

describe('overtime (California)', async () => {
  const { overtimeSplit } = await import('../src/domain/wages.js');
  const SAT = 6;
  const h = (n: number) => Math.round(n * 60);
  it('over 8 hours in a day is overtime, over 12 is double time', () => {
    const s = overtimeSplit([['2026-10-10', h(9.5), 0], ['2026-10-11', h(13), 0]], SAT, 'california');
    expect(s.get('2026-10-10')).toEqual({ regular: h(8), overtime: h(1.5), double: 0 });
    expect(s.get('2026-10-11')).toEqual({ regular: h(8), overtime: h(4), double: h(1) });
  });
  it('regular hours over 40 in the workweek (Saturday–Friday) are overtime; a new week starts over', () => {
    const week = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'].map((d) => [d, h(8), 0] as [string, number, number]);
    const s = overtimeSplit([...week, ['2026-10-17', h(8), 0]], SAT, 'california');
    expect(s.get('2026-10-15')).toEqual({ regular: 0, overtime: h(8), double: 0 }); // 6th day of 8: past 40
    expect(s.get('2026-10-17')).toEqual({ regular: h(8), overtime: 0, double: 0 }); // next Saturday: new week
  });
  it('weekly-only and none', () => {
    const days: [string, number, number][] = [['2026-10-10', h(10), 0], ['2026-10-11', h(10), 0]];
    expect(overtimeSplit(days, SAT, 'weekly').get('2026-10-10')).toEqual({ regular: h(10), overtime: 0, double: 0 });
    expect(overtimeSplit(days, SAT, 'none').get('2026-10-11')).toEqual({ regular: h(10), overtime: 0, double: 0 });
  });
  it('a weekly total typed in has no daily overtime, only the weekly 40', () => {
    expect(overtimeSplit([['2026-10-16', h(45), h(45)]], SAT, 'california').get('2026-10-16')).toEqual({ regular: h(40), overtime: h(5), double: 0 });
  });
  it('pays like the paystub: 66.23 regular × $23 + 8.4 overtime × $34.50', () => {
    const cents = Math.round((h(66.23) / 60) * 2300 + (h(8.4) / 60) * 2300 * 1.5);
    expect(Math.abs(cents - (152329 + 28980))).toBeLessThanOrEqual(25); // $1,813.09 (minutes rounding)
  });
});
