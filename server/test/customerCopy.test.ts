import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerCopyStatus, startCustomerCopy } from '../src/domain/customerCopy.js';
import { setIntegrationOverride } from '../src/integrations/registry.js';
import { MockShopifyService, MockShopifyStore2, type ShopifyCustomer } from '../src/integrations/shopify/ShopifyService.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
const cust = (o: Partial<ShopifyCustomer>): ShopifyCustomer => ({ id: `gid://shopify/Customer/${Math.random()}`, email: null, phone: null, firstName: null, lastName: null, tags: [], note: null, emailConsent: null, smsConsent: null, address: null, ...o });

beforeAll(async () => {
  ({ api } = await setup());
  setIntegrationOverride({ shopify: new MockShopifyService(), shopify2: new MockShopifyStore2() });
  // Store 1 is the professional store here; store 2 the retail one.
  MockShopifyService.customers = [
    cust({ email: 'ava@salon.example', firstName: 'Ava', tags: ['professional-stylist'], emailConsent: { marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt: '2025-01-01T00:00:00Z' } }),
    cust({ email: 'Bo@Salon.example', firstName: 'Bo', tags: ['professional-stylist', 'vip'] }),
    cust({ firstName: 'No Contact' }),
  ];
  MockShopifyStore2.customers = [cust({ email: 'bo@salon.example', firstName: 'Bo', tags: ['vip'] })];
});
afterAll(() => { MockShopifyService.customers = []; MockShopifyStore2.customers = []; });

describe('Copy Pro customers to Addendum Hair', () => {
  it('previews, then adds new customers with their tags and consent, and only adds missing tags to existing ones', async () => {
    const p = (await api.get('/api/integrations/customer-copy/preview')).body;
    expect(p).toMatchObject({ total: 3, toCreate: 1, toTag: 1, alreadyThere: 0, subscribed: 1 });
    expect(p.skipped).toHaveLength(1);
    expect(MockShopifyStore2.customers).toHaveLength(1); // preview changes nothing
    await startCustomerCopy(0);
    for (let i = 0; i < 50 && (await customerCopyStatus())?.state === 'running'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await customerCopyStatus()).toMatchObject({ state: 'done', created: 1, tagged: 1, failed: [] });
    const ava = MockShopifyStore2.customers.find((c) => c.email === 'ava@salon.example')!;
    expect(ava.tags).toEqual(['professional-stylist']);
    expect(ava.emailConsent?.marketingState).toBe('SUBSCRIBED');
    expect(MockShopifyStore2.customers.filter((c) => c.email?.toLowerCase() === 'bo@salon.example')).toHaveLength(1); // no duplicate
    expect(MockShopifyStore2.customers.find((c) => c.firstName === 'Bo')!.tags.sort()).toEqual(['professional-stylist', 'vip']);
    expect(MockShopifyService.customers).toHaveLength(3); // the Pro store is unchanged
    // Running it again has nothing left to do.
    expect((await api.get('/api/integrations/customer-copy/preview')).body).toMatchObject({ toCreate: 0, toTag: 0, alreadyThere: 2 });
  });
});
