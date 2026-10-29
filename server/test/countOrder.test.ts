import { describe, expect, it } from 'vitest';
import { hairCompareByColor } from '@addendum/shared';

describe('stock count order', () => {
  it('sorts by collection, then colour, then length (18", 22", 24")', () => {
    const rows = [
      { label: '24" Aperol Spritz Redefined Weft', sku: '24-APRW' },
      { label: '18" Bees Knees Redefined Weft', sku: '18-BKRW-20g' },
      { label: '22" Aperol Spritz Redefined Weft', sku: '22-APRW' },
      { label: '18" Aperol Spritz K-Tips', sku: '18-APKT' },
      { label: '18" Aperol Spritz Redefined Weft', sku: '18-APRW-20g' },
    ];
    expect([...rows].sort(hairCompareByColor).map((r) => r.label)).toEqual([
      '18" Aperol Spritz K-Tips',
      '18" Aperol Spritz Redefined Weft',
      '22" Aperol Spritz Redefined Weft',
      '24" Aperol Spritz Redefined Weft',
      '18" Bees Knees Redefined Weft',
    ]);
  });
});
