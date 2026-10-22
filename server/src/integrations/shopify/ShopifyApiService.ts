import { config } from '../../config.js';
import { IntegrationError } from '../../lib/errors.js';
import { ShopifyStaleQuantityError, type ShopifyInventoryEntry, type ShopifyOrderLine, type ShopifyOrderWho, type ShopifyPriceEntry, type ShopifySetQuantity, type ShopifyService, type ShopifyVariantBySku } from './ShopifyService.js';

/** Access scopes the Shopify app needs. */
export const SHOPIFY_SCOPES = ['read_products', 'read_inventory', 'write_inventory', 'read_locations', 'read_orders'];

/**
 * Thrown when Shopify may or may not have applied a change (timeout, 5xx). Retrying with the same
 * idempotency key is safe; Shopify applies it at most once.
 */
export class ShopifyOutcomeUnknownError extends IntegrationError {}

/** SKU search terms are quoted; quotes and backslashes in a SKU are dropped from the search (matching is exact afterwards). */
const skuTerm = (sku: string) => `sku:"${sku.replace(/["\\]/g, '')}"`;

/** Which store's settings: SHOPIFY_* (the main store) or SHOPIFY2_* (a second store sharing the same stock). */
export type ShopifyPrefix = 'SHOPIFY' | 'SHOPIFY2';
const cachedTokens = new Map<ShopifyPrefix, { token: string; expiresAt: number }>();
/** Forget the cached tokens (credentials were changed in the admin screen). */
export const resetShopifyToken = () => { cachedTokens.clear(); };
const setting = (prefix: ShopifyPrefix, key: 'ADMIN_TOKEN' | 'CLIENT_ID' | 'CLIENT_SECRET' | 'LOCATION_ID') => (config() as unknown as Record<string, string | undefined>)[`${prefix}_${key}`];

/** Live Shopify Admin GraphQL client. */
export class ShopifyApiService implements ShopifyService {
  readonly mode = 'live' as const;
  private resolvedLocation: string | null = null;
  constructor(private domain: string, private prefix: ShopifyPrefix = 'SHOPIFY') {}

  /** A legacy shpat_ token, or a 24-hour token from the client credentials grant (cached until shortly before it expires). */
  private async token() {
    const admin = setting(this.prefix, 'ADMIN_TOKEN');
    if (admin) return admin;
    const cachedToken = cachedTokens.get(this.prefix);
    if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60_000) return cachedToken.token;
    let res: Response;
    try {
      res = await fetch(`https://${this.domain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: setting(this.prefix, 'CLIENT_ID'), client_secret: setting(this.prefix, 'CLIENT_SECRET'), grant_type: 'client_credentials' }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new IntegrationError('shopify', 'Shopify could not be reached. Try again in a moment.', true, false, String(e));
    }
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json?.access_token) {
      throw new IntegrationError('shopify', 'Shopify connection needs attention. Check SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET, and that the app is installed on the store.', false, true, `${res.status} ${JSON.stringify(json)}`);
    }
    const t = { token: json.access_token as string, expiresAt: Date.now() + (Number(json.expires_in) || 86_400) * 1000 };
    cachedTokens.set(this.prefix, t);
    return t.token;
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}, attempt = 0): Promise<T> {
    const c = config();
    let res: Response;
    try {
      res = await fetch(`https://${this.domain}/admin/api/${c.SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': await this.token(), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new ShopifyOutcomeUnknownError('shopify', 'Shopify could not be reached. Try again in a moment.', true, false, String(e));
    }
    const json: any = await res.json().catch(() => null);
    const throttled = res.status === 429 || json?.errors?.some?.((e: any) => e?.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return this.gql(query, variables, attempt + 1);
    }
    if (res.status === 401 || res.status === 403) {
      if (setting(this.prefix, 'ADMIN_TOKEN')) {
        // A saved Admin API token is always used before the Client ID + secret — say so, it's the usual mix-up.
        throw new IntegrationError('shopify', 'Shopify rejected the saved Admin API access token. If your app is from the Shopify Dev Dashboard, remove that token (Settings → API & Integrations → Shopify) so the Client ID + secret are used.', false, true, `${res.status} ${JSON.stringify(json)}`);
      }
      // The cached 24-hour token may have been revoked (secret rotated, scopes changed, app reinstalled): get a new one once.
      cachedTokens.delete(this.prefix);
      if (attempt === 0) return this.gql(query, variables, 9);
      throw new IntegrationError('shopify', `Shopify didn't accept the app's access. Check the Client ID and secret, that the app is installed on the store, and that it has these scopes: ${SHOPIFY_SCOPES.join(', ')}.`, false, true, `${res.status} ${JSON.stringify(json)}`);
    }
    if (res.status >= 500) throw new ShopifyOutcomeUnknownError('shopify', 'Shopify had a problem. Try again in a moment.', true, false, `${res.status} ${JSON.stringify(json)}`);
    if (!res.ok || json?.errors) {
      const msg = Array.isArray(json?.errors) ? json.errors.map((e: any) => e.message).join('; ') : '';
      const scope = /access denied|scope/i.test(msg);
      throw new IntegrationError('shopify', scope ? `The Shopify app is missing a permission. It needs: ${SHOPIFY_SCOPES.join(', ')}.` : 'Shopify rejected the request.', false, scope, `${res.status} ${JSON.stringify(json)}`);
    }
    return json.data as T;
  }

  async testConnection() {
    const d = await this.gql<{ shop: { name: string } }>('{ shop { name } }');
    const loc = await this.locationId();
    const l = await this.gql<{ location: { name: string } | null }>('query($id: ID!) { location(id: $id) { name } }', { id: loc });
    return { shopName: d.shop.name, locationName: l.location?.name ?? null };
  }

  async locationId() {
    if (this.resolvedLocation) return this.resolvedLocation;
    const configured = setting(this.prefix, 'LOCATION_ID')?.trim();
    if (configured) return (this.resolvedLocation = /^\d+$/.test(configured) ? `gid://shopify/Location/${configured}` : configured);
    const d = await this.gql<{ locations: { nodes: { id: string; name: string; isActive: boolean }[] } }>('{ locations(first: 10) { nodes { id name isActive } } }');
    const active = d.locations.nodes.filter((l) => l.isActive);
    if (active.length !== 1) {
      throw new IntegrationError('shopify', `The Shopify store has ${active.length} active locations. Set SHOPIFY_LOCATION_ID on the server to the one hair is taken from.`, false);
    }
    return (this.resolvedLocation = active[0].id);
  }

  async findBySkus(skus: string[]): Promise<ShopifyVariantBySku[]> {
    const out: ShopifyVariantBySku[] = [];
    const want = new Set(skus.map((x) => x.toLowerCase()));
    // 25 SKUs per search keeps the query short; exact (case-insensitive) matching happens here.
    for (let i = 0; i < skus.length; i += 25) {
      const q = skus.slice(i, i + 25).map(skuTerm).join(' OR ');
      const d = await this.gql<any>(
        'query($q: String!) { productVariants(first: 100, query: $q) { nodes { sku displayName inventoryItem { id tracked } } } }',
        { q },
      );
      for (const v of d.productVariants.nodes) {
        if (!v.sku || !want.has(String(v.sku).toLowerCase()) || !v.inventoryItem?.id) continue;
        out.push({ sku: v.sku, inventoryItemId: v.inventoryItem.id, label: v.displayName, tracked: !!v.inventoryItem.tracked });
      }
    }
    return out;
  }

  async setAvailable(locationId: string, quantities: ShopifySetQuantity[], idempotencyKey: string, referenceUri: string) {
    const d = await this.gql<any>(
      `mutation Set($input: InventorySetQuantitiesInput!, $key: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { field message code } }
      }`,
      {
        key: idempotencyKey,
        input: {
          name: 'available',
          reason: 'correction',
          referenceDocumentUri: referenceUri,
          // changeFromQuantity is compare-and-set: Shopify refuses if the quantity changed since we read it. It must be
          // passed explicitly (null opts out of the check).
          quantities: quantities.map((q) => ({ inventoryItemId: q.inventoryItemId, locationId, quantity: q.quantity, changeFromQuantity: q.changeFromQuantity ?? null })),
        },
      },
    );
    const errs = d.inventorySetQuantities?.userErrors ?? [];
    if (errs.some((e: any) => e.code === 'CHANGE_FROM_QUANTITY_STALE')) throw new ShopifyStaleQuantityError();
    if (errs.length) throw new IntegrationError('shopify', `Shopify didn't accept the update: ${errs.map((e: any) => e.message).join('; ')}`, false, false, JSON.stringify(errs));
  }

  async listInventory(locationId: string): Promise<ShopifyInventoryEntry[]> {
    const out: ShopifyInventoryEntry[] = [];
    let after: string | null = null;
    do {
      const d: any = await this.gql<any>(
        `query($loc: ID!, $after: String) {
          productVariants(first: 50, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { sku displayName image { url(transform: { maxWidth: 160, maxHeight: 160 }) } product { status productType collections(first: 5) { nodes { title } } featuredMedia { preview { image { url(transform: { maxWidth: 160, maxHeight: 160 }) } } } } inventoryItem { id tracked inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } } }
          }
        }`,
        { loc: locationId, after },
      );
      for (const v of d.productVariants.nodes) {
        if (!v.sku || !v.inventoryItem?.id) continue;
        const level = v.inventoryItem.inventoryLevel;
        const available = level?.quantities?.find((q: any) => q.name === 'available')?.quantity;
        out.push({ sku: String(v.sku), inventoryItemId: v.inventoryItem.id, label: v.displayName, tracked: !!v.inventoryItem.tracked, available: level ? Number(available ?? 0) : null, status: v.product?.status,
          collections: [...new Set([v.product?.productType, ...(v.product?.collections?.nodes ?? []).map((c: any) => c.title)].filter(Boolean))] as string[],
          imageUrl: v.image?.url ?? v.product?.featuredMedia?.preview?.image?.url ?? null });
      }
      after = d.productVariants.pageInfo.hasNextPage ? d.productVariants.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  async setTracked(inventoryItemId: string, tracked: boolean) {
    const d = await this.gql<any>(
      `mutation($id: ID!, $input: InventoryItemInput!) { inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id tracked } userErrors { field message } } }`,
      { id: inventoryItemId, input: { tracked } },
    );
    const errs = d.inventoryItemUpdate?.userErrors ?? [];
    if (errs.length) throw new IntegrationError('shopify', `Shopify didn't turn on stock tracking: ${errs.map((e: any) => e.message).join('; ')}`, false, false, JSON.stringify(errs));
  }

  async setSku(inventoryItemId: string, sku: string) {
    const d = await this.gql<any>(
      `mutation($id: ID!, $input: InventoryItemInput!) { inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id sku } userErrors { field message } } }`,
      { id: inventoryItemId, input: { sku } },
    );
    const errs = d.inventoryItemUpdate?.userErrors ?? [];
    if (errs.length) throw new IntegrationError('shopify', `Shopify didn't accept the SKU: ${errs.map((e: any) => e.message).join('; ')}`, false, false, JSON.stringify(errs));
  }

  async listOrderLines(updatedSince: Date): Promise<ShopifyOrderLine[]> {
    const out: ShopifyOrderLine[] = [];
    let after: string | null = null;
    do {
      const d: any = await this.gql<any>(
        `query($q: String!, $after: String) {
          orders(first: 100, after: $after, query: $q, sortKey: UPDATED_AT) {
            pageInfo { hasNextPage endCursor }
            nodes { id createdAt cancelledAt test lineItems(first: 100) { nodes { id name sku currentQuantity discountedUnitPriceSet { shopMoney { amount } } variant { inventoryItem { id } } } } }
          }
        }`,
        { q: `updated_at:>='${updatedSince.toISOString()}'`, after },
      );
      for (const o of d.orders.nodes) {
        if (o.test) continue;
        for (const l of o.lineItems.nodes) {
          out.push({ orderId: o.id, lineId: l.id, inventoryItemId: l.variant?.inventoryItem?.id ?? null, sku: l.sku ?? null, quantity: Number(l.currentQuantity ?? 0),
            unitPriceCents: l.discountedUnitPriceSet?.shopMoney?.amount != null ? Math.round(Number(l.discountedUnitPriceSet.shopMoney.amount) * 100) : null, orderedAt: o.createdAt, cancelled: !!o.cancelledAt, title: l.name ?? null });
        }
      }
      after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  async listPrices(): Promise<ShopifyPriceEntry[]> {
    const out: ShopifyPriceEntry[] = [];
    let after: string | null = null;
    do {
      const d: any = await this.gql<any>(
        `query($after: String) {
          productVariants(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id sku price displayName product { id title tags } inventoryItem { id unitCost { amount } } }
          }
        }`, { after });
      for (const v of d.productVariants.nodes) {
        if (!v.inventoryItem?.id) continue;
        out.push({ variantId: v.id, productId: v.product.id, inventoryItemId: v.inventoryItem.id, sku: v.sku || null, label: v.displayName, productTitle: v.product.title, tags: v.product.tags ?? [],
          priceCents: v.price != null ? Math.round(Number(v.price) * 100) : null,
          costCents: v.inventoryItem.unitCost?.amount != null ? Math.round(Number(v.inventoryItem.unitCost.amount) * 100) : null });
      }
      after = d.productVariants.pageInfo.hasNextPage ? d.productVariants.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  async setPrices(productId: string, variants: { variantId: string; priceCents: number }[]) {
    let d: any;
    try {
      d = await this.gql<any>(
        `mutation($pid: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $pid, variants: $v) { userErrors { field message } } }`,
        { pid: productId, v: variants.map((x) => ({ id: x.variantId, price: (x.priceCents / 100).toFixed(2) })) });
    } catch (e) {
      // Changing prices needs write_products (optional: everything else works without it).
      if (e instanceof IntegrationError && e.authProblem) throw new IntegrationError('shopify', 'The Shopify app needs the write_products permission to change prices. Add it to the app, then try again.', false, true, e.technical);
      throw e;
    }
    const errs = d.productVariantsBulkUpdate?.userErrors ?? [];
    if (errs.length) throw new IntegrationError('shopify', `Shopify didn't accept the price: ${errs.map((x: any) => x.message).join('; ')}`, false, false, JSON.stringify(errs));
  }

  async setUnitCost(inventoryItemId: string, costCents: number | null) {
    const d: any = await this.gql<any>(
      `mutation($id: ID!, $input: InventoryItemInput!) { inventoryItemUpdate(id: $id, input: $input) { userErrors { field message } } }`,
      { id: inventoryItemId, input: { cost: costCents == null ? null : (costCents / 100).toFixed(2) } });
    const errs = d.inventoryItemUpdate?.userErrors ?? [];
    if (errs.length) throw new IntegrationError('shopify', `Shopify didn't accept the cost: ${errs.map((x: any) => x.message).join('; ')}`, false, false, JSON.stringify(errs));
  }

  async orderWho(orderIds: string[]): Promise<Map<string, ShopifyOrderWho>> {
    const out = new Map<string, ShopifyOrderWho>();
    const ids = orderIds.map((id) => (id.startsWith('gid://') ? id : `gid://shopify/Order/${id}`));
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      // The customer's name needs read_customers (and customer-data access); without it, just the order number.
      let d: any;
      try {
        d = await this.gql<any>('query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id name customer { displayName } } } }', { ids: chunk });
      } catch {
        d = await this.gql<any>('query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id name } } }', { ids: chunk });
      }
      for (const n of d.nodes ?? []) if (n?.id) out.set(n.id, { name: n.name ?? null, customer: n.customer?.displayName ?? null });
    }
    return out;
  }

  async accessScopes(): Promise<string[]> {
    const d = await this.gql<{ currentAppInstallation: { accessScopes: { handle: string }[] } }>('{ currentAppInstallation { accessScopes { handle } } }');
    return d.currentAppInstallation.accessScopes.map((s) => s.handle);
  }
}
