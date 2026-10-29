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
