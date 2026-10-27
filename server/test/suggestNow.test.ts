import { describe, expect, it } from 'vitest';
import { markSuggestNow } from '../src/domain/stock.js';

const item = (o: object) => ({ key: Math.random().toString(), sku: 'X', stock: 0, ratePerDay: 1, preorders: 0, status: 'order_now', orderBy: '2026-11-01', suggestedQty: 10, skippedUntil: null, ...o }) as any;

describe('What to suggest ordering now', () => {
  it('only what would sell out within 2 weeks, and no 18" pack while the 20g or 25g pack of that colour is in stock', () => {
    const items = [
      item({ sku: 'A', orderBy: '2026-11-05' }), // within 2 weeks of Oct 27
      item({ sku: 'B', orderBy: '2026-11-20', status: 'soon' }), // later
      item({ sku: 'C', status: 'out', stock: 0 }), // out and selling
      item({ sku: '18-APRW-20g', stock: 0, status: 'out' }), // its 25g sibling is in stock
      item({ sku: '18-APRW-25g', stock: 4, status: 'healthy' }),
      item({ sku: '18-BKRW-25g', stock: 0, status: 'out' }), // no pack in stock
      item({ sku: 'D', skippedUntil: '9999-12-31' }),
    ];
    markSuggestNow(items, '2026-10-27');
    expect(items.map((i: any) => [i.sku, i.suggestNow])).toEqual([
      ['A', true], ['B', false], ['C', true], ['18-APRW-20g', false], ['18-APRW-25g', false], ['18-BKRW-25g', true], ['D', false],
    ]);
  });
});
