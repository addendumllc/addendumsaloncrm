import { describe, expect, it } from 'vitest';
import { simpleServices } from '../src/domain/messaging.js';
import { RuleBasedAIService } from '../src/integrations/ai/RuleBasedAIService.js';

describe('Text drafts are short and plain', () => {
  it('services are said simply: no tiers, stylists, bundles or add-on wording', () => {
    expect(simpleServices('Weft Install - 1 Row - Tier 1, Haircut with Service - Tier 1, Toner Add On - Tier 1')).toBe('weft install, haircut and toner');
    expect(simpleServices("K-Tip Install - Per Bundle - Lisa, Women's Haircut - Tier 1")).toBe("k-tip install and women's haircut");
    expect(simpleServices('Hair Botox Package - 4 Treatments')).toBe('hair botox');
    expect(simpleServices('Mini Highlight - Lisa, Toner Add On - Lisa')).toBe('mini highlight and toner');
    expect(simpleServices(null)).toBeNull();
  });

  it('the rebooking draft has no stylist, no service list in brackets and no link', async () => {
    const text = await new RuleBasedAIService().draft({
      kind: 'rebooking', firstName: 'Jilliana', salonName: 'Addendum Salon', tone: 'warm', signature: '— Addendum Salon', bookingUrl: '', reviewUrl: '',
      service: simpleServices('Weft Install - 1 Row - Tier 1, Haircut with Service - Tier 1, Toner Add On - Tier 1'), staffName: null, lastVisitText: 'Sep 10',
    } as any);
    expect(text).toBe("Hi Jilliana! It's been a little while since your last visit — you're due for your next weft install, haircut and toner. Would you like us to find you a spot? — Addendum Salon");
  });
});
