import { config } from '../../config.js';
import { IntegrationError } from '../../lib/errors.js';
import { ShopifyStaleQuantityError, type ShopifyInventoryEntry, type ShopifySetQuantity, type ShopifyService, type ShopifyVariantBySku } from './ShopifyService.js';

/** Access scopes the Shopify app needs. */
export const SHOPIFY_SCOPES = ['read_products', 'read_inventory', 'write_inventory', 'read_locations'];

/**
 * Thrown when Shopify may or may not have applied a change (timeout, 5xx). Retrying with the same
 * idempotency key is safe; Shopify applies it at most once.
 */
export class ShopifyOutcomeUnknownError extends IntegrationError {}

/** SKU search terms are quoted; quotes and backslashes in a SKU are dropped from the search (matching is exact afterwards). */
const skuTerm = (sku: string) => `sku:"${sku.replace(/["\\]/g, '')}"`;

let cachedToken: { token: string; expiresAt: number } | null = null;
/** Forget the cached token (credentials were changed in the admin screen). */
export const resetShopifyToken = () => { cachedToken = null; };

/** Live Shopify Admin GraphQL client. */
export class ShopifyApiService implements ShopifyService {
  readonly mode = 'live' as const;
  private resolvedLocation: string | null = null;
  constructor(private domain: string) {}

  /** A legacy shpat_ token, or a 24-hour token from the client credentials grant (cached until shortly before it expires). */
  private async token() {
    const c = config();
    if (c.SHOPIFY_ADMIN_TOKEN) return c.SHOPIFY_ADMIN_TOKEN;
    if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60_000) return cachedToken.token;
    let res: Response;
    try {
      res = await fetch(`https://${this.domain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: c.SHOPIFY_CLIENT_ID, client_secret: c.SHOPIFY_CLIENT_SECRET, grant_type: 'client_credentials' }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new IntegrationError('shopify', 'Shopify could not be reached. Try again in a moment.', true, false, String(e));
    }
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json?.access_token) {
      throw new IntegrationError('shopify', 'Shopify connection needs attention. Check SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET, and that the app is installed on the store.', false, true, `${res.status} ${JSON.stringify(json)}`);
    }
    cachedToken = { token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 86_400) * 1000 };
    return cachedToken.token;
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
      if (!c.SHOPIFY_ADMIN_TOKEN) cachedToken = null;
      throw new IntegrationError('shopify', `Shopify connection needs attention. Check the app's access and that it has these scopes: ${SHOPIFY_SCOPES.join(', ')}.`, false, true, `${res.status} ${JSON.stringify(json)}`);
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
    const configured = config().SHOPIFY_LOCATION_ID?.trim();
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
          productVariants(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { sku displayName inventoryItem { id tracked inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } } }
          }
        }`,
        { loc: locationId, after },
      );
      for (const v of d.productVariants.nodes) {
        if (!v.sku || !v.inventoryItem?.id) continue;
        const level = v.inventoryItem.inventoryLevel;
        const available = level?.quantities?.find((q: any) => q.name === 'available')?.quantity;
        out.push({ sku: String(v.sku), inventoryItemId: v.inventoryItem.id, label: v.displayName, tracked: !!v.inventoryItem.tracked, available: level ? Number(available ?? 0) : null });
      }
      after = d.productVariants.pageInfo.hasNextPage ? d.productVariants.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  async accessScopes(): Promise<string[]> {
    const d = await this.gql<{ currentAppInstallation: { accessScopes: { handle: string }[] } }>('{ currentAppInstallation { accessScopes { handle } } }');
    return d.currentAppInstallation.accessScopes.map((s) => s.handle);
  }
}
