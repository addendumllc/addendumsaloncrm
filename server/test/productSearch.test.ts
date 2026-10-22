import { describe, expect, it } from 'vitest';
import { productSearchText, productSearchWords } from '@addendum/shared';

const finds = (q: string, ...parts: (string | null)[]) => { const t = productSearchText(...parts); return productSearchWords(q).every((w) => t.includes(w)); };

describe('Product search', () => {
  it('matches name, colour, size however it’s typed, SKU and collection', () => {
    const p = ['18” Redefined Weft - Aperol Spritz', '18-APRW-20g', 'Redefined Weft'] as const;
    expect(finds('aperol', ...p)).toBe(true);
    expect(finds('aperol 18"', ...p)).toBe(true);
    expect(finds('18 inch spritz', ...p)).toBe(true);
    expect(finds('18in redefined', ...p)).toBe(true);
    expect(finds('18-aprw', ...p)).toBe(true);
    expect(finds('APRW', ...p)).toBe(true);
    expect(finds('redefined weft', ...p)).toBe(true);
    expect(finds('22" aperol', ...p)).toBe(false);
    expect(finds('classic', ...p)).toBe(false);
  });
});
