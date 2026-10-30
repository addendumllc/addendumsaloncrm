import { afterEach, describe, expect, it, vi } from 'vitest';
import { SquareApiService } from '../src/integrations/square/SquareApiService.js';

// Square's List Payments returns only the main location's payments unless location_id is given, so the salon's
// payments (with who checked out) were missed when the main location was another one.
describe('Square payments', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('reads payments at every location', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      const loc = new URL(url).searchParams.get('location_id');
      return new Response(JSON.stringify({ payments: [{ id: `p-${loc}`, order_id: `o-${loc}`, team_member_id: loc === 'SALON' ? 'TM-GABBY' : null, status: 'COMPLETED' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const sq = new SquareApiService(async () => 'token');
    const out = await sq.listPayments(new Date('2026-10-01'), new Date('2026-10-30'), ['MAIN', 'SALON']);
    expect(urls.map((u) => new URL(u).searchParams.get('location_id'))).toEqual(['MAIN', 'SALON']);
    expect(out.find((p) => p.order_id === 'o-SALON')?.team_member_id).toBe('TM-GABBY');
  });
});
