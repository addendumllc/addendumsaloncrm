import { config, squareBaseUrl } from '../../config.js';
import { IntegrationError } from '../../lib/errors.js';
import { DAY } from '../../lib/time.js';
import type {
  SquareBooking, SquareCustomer, SquareInventoryCount, SquareOrder, SquarePaymentInfo, SquareLocation, SquareProductVariation, SquareService, SquareServiceVariation, SquareTeamMember, SquareSetCount,
} from './types.js';

/**
 * Live Square client. Endpoints verified against the official Square OpenAPI spec:
 *  GET  /v2/bookings                 (APPOINTMENTS_READ + APPOINTMENTS_ALL_READ for all staff's bookings)
 *  GET  /v2/bookings/{booking_id}
 *  POST /v2/customers/bulk-retrieve  (CUSTOMERS_READ)
 *  POST /v2/team-members/search      (EMPLOYEES_READ)
 *  GET  /v2/catalog/list?types=ITEM  (ITEMS_READ)
 *  POST /v2/inventory/counts/batch-retrieve (INVENTORY_READ)
 *  POST /v2/inventory/changes/batch-create   (INVENTORY_WRITE; physical counts for the Shopify sync)
 *  POST /oauth2/token/status                 (checks the token's permissions in Test connection)
 *  GET  /v2/locations                (MERCHANT_PROFILE_READ)
 *  GET  /v2/merchants                (MERCHANT_PROFILE_READ)
 *  POST /v2/orders/search            (ORDERS_READ; updated_at filter + UPDATED_AT sort, ≤10 locations, ≤1000/page)
 *  GET  /v2/payments                 (PAYMENTS_READ; begin_time/end_time, ≤100/page)
 */
export class SquareApiService implements SquareService {
  readonly mode = 'live' as const;
  constructor(private getToken: () => Promise<string>) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, attempt = 0): Promise<T> {
    const cfg = config();
    const token = await this.getToken();
    let res: Response;
    try {
      res = await fetch(`${squareBaseUrl(cfg)}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Square-Version': cfg.SQUARE_API_VERSION,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new IntegrationError('square', 'Square could not be reached. Your existing data is safe.', true, false, String(e));
    }
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return this.call(method, path, body, attempt + 1);
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code: string = json?.errors?.[0]?.code ?? String(res.status);
      if (res.status === 401 || ['ACCESS_TOKEN_EXPIRED', 'ACCESS_TOKEN_REVOKED', 'UNAUTHORIZED'].includes(code)) {
        throw new IntegrationError('square', 'Square connection expired. Please reconnect.', false, true, code);
      }
      if (res.status === 403 || code === 'INSUFFICIENT_SCOPES') {
        throw new IntegrationError('square', 'Square needs more permissions. Please reconnect Square and approve all requested access.', false, true, code);
      }
      if (res.status === 404) return null as T;
      throw new IntegrationError('square', 'Unable to load data from Square right now. Your existing data is safe.', res.status >= 500, false, `${res.status} ${code}`);
    }
    return json as T;
  }

  async listBookings(startMin: Date, startMax: Date): Promise<SquareBooking[]> {
    const out: SquareBooking[] = [];
    // Square limits each query to a 31-day start_at range, so walk the range in 30-day windows.
    for (let from = startMin.getTime(); from < startMax.getTime(); from += 30 * DAY) {
      const to = Math.min(from + 30 * DAY, startMax.getTime());
      let cursor: string | undefined;
      do {
        const qs = new URLSearchParams({
          limit: '100',
          start_at_min: new Date(from).toISOString(),
          start_at_max: new Date(to).toISOString(),
        });
        if (cursor) qs.set('cursor', cursor);
        const res = await this.call<{ bookings?: SquareBooking[]; cursor?: string }>('GET', `/v2/bookings?${qs}`);
        out.push(...(res?.bookings ?? []));
        cursor = res?.cursor || undefined;
      } while (cursor);
    }
    return out;
  }

  async retrieveBooking(id: string) {
    const res = await this.call<{ booking?: SquareBooking }>('GET', `/v2/bookings/${encodeURIComponent(id)}`);
    return res?.booking ?? null;
  }

  async bulkRetrieveCustomers(ids: string[]): Promise<SquareCustomer[]> {
    const out: SquareCustomer[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const res = await this.call<{ responses?: Record<string, { customer?: SquareCustomer }> }>(
        'POST', '/v2/customers/bulk-retrieve', { customer_ids: ids.slice(i, i + 100) },
      );
      for (const r of Object.values(res?.responses ?? {})) if (r.customer) out.push(r.customer);
    }
    return out;
  }

  async listTeamMembers(): Promise<SquareTeamMember[]> {
    const out: SquareTeamMember[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.call<{ team_members?: SquareTeamMember[]; cursor?: string }>('POST', '/v2/team-members/search', {
        query: { filter: { status: 'ACTIVE' } }, limit: 200, cursor,
      });
      out.push(...(res?.team_members ?? []));
      cursor = res?.cursor || undefined;
    } while (cursor);
    return out;
  }

  async listServices(): Promise<SquareServiceVariation[]> {
    const out: SquareServiceVariation[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ types: 'ITEM' });
      if (cursor) qs.set('cursor', cursor);
      const res = await this.call<{ objects?: any[]; cursor?: string }>('GET', `/v2/catalog/list?${qs}`);
      for (const obj of res?.objects ?? []) {
        const item = obj.item_data;
        if (!item || obj.is_deleted) continue;
        if (item.product_type !== 'APPOINTMENTS_SERVICE') continue;
        for (const v of item.variations ?? []) {
          const vd = v.item_variation_data ?? {};
          const varName: string = vd.name ?? '';
          out.push({
            variationId: v.id,
            itemId: obj.id,
            name: varName && !/^regular$/i.test(varName) ? `${item.name} — ${varName}` : item.name,
            durationMinutes: vd.service_duration ? Math.round(Number(vd.service_duration) / 60000) : null,
            priceCents: vd.price_money?.amount != null ? Number(vd.price_money.amount) : null,
          });
        }
      }
      cursor = res?.cursor || undefined;
    } while (cursor);
    return out;
  }

  async listProducts(): Promise<SquareProductVariation[]> {
    const out: SquareProductVariation[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ types: 'ITEM' });
      if (cursor) qs.set('cursor', cursor);
      const res = await this.call<{ objects?: any[]; cursor?: string }>('GET', `/v2/catalog/list?${qs}`);
      for (const obj of res?.objects ?? []) {
        const item = obj.item_data;
        if (!item || obj.is_deleted || item.is_archived) continue;
        if (item.product_type === 'APPOINTMENTS_SERVICE') continue;
        for (const v of item.variations ?? []) {
          if (v.is_deleted) continue;
          const vd = v.item_variation_data ?? {};
          const varName: string = vd.name ?? '';
          out.push({
            variationId: v.id,
            itemId: obj.id,
            itemName: item.name ?? 'Unnamed item',
            variationName: varName && !/^regular$/i.test(varName) ? varName : null,
            sku: vd.sku || null,
            upc: vd.upc || null,
            priceCents: vd.price_money?.amount != null ? Number(vd.price_money.amount) : null,
            trackInventory: vd.track_inventory !== false,
          });
        }
      }
      cursor = res?.cursor || undefined;
    } while (cursor);
    return out;
  }

  async listInventoryCounts(): Promise<SquareInventoryCount[]> {
    const out: SquareInventoryCount[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.call<{ counts?: any[]; cursor?: string }>('POST', '/v2/inventory/counts/batch-retrieve', {
        states: ['IN_STOCK'], limit: 1000, ...(cursor ? { cursor } : {}),
      });
      for (const c of res?.counts ?? []) {
        if (c.catalog_object_type && c.catalog_object_type !== 'ITEM_VARIATION') continue;
        out.push({ variationId: c.catalog_object_id, locationId: c.location_id, quantity: Number(c.quantity) || 0, calculatedAt: c.calculated_at ?? null });
      }
      cursor = res?.cursor || undefined;
    } while (cursor);
    return out;
  }

  async listLocations(): Promise<SquareLocation[]> {
    const res = await this.call<{ locations?: any[] }>('GET', '/v2/locations');
    return (res?.locations ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      timezone: l.timezone,
      address: [l.address?.address_line_1, l.address?.locality, l.address?.administrative_district_level_1].filter(Boolean).join(', '),
    }));
  }

  async setInventoryCounts(counts: SquareSetCount[], idempotencyKey: string) {
    // Square accepts up to 100 changes per request. Each chunk has its own key, so a retry can't apply it twice.
    for (let i = 0; i < counts.length; i += 100) {
      const chunk = counts.slice(i, i + 100);
      try {
        await this.call('POST', '/v2/inventory/changes/batch-create', {
          idempotency_key: `${idempotencyKey}-${i / 100}`.slice(0, 128),
          ignore_unchanged_counts: true,
          changes: chunk.map((c) => ({
            type: 'PHYSICAL_COUNT',
            physical_count: {
              catalog_object_id: c.variationId,
              state: 'IN_STOCK',
              location_id: c.locationId,
              quantity: String(c.quantity),
              occurred_at: c.occurredAt,
              ...(c.referenceId ? { reference_id: c.referenceId.slice(0, 255) } : {}),
            },
          })),
        });
      } catch (e) {
        if (e instanceof IntegrationError && e.authProblem && !/expired/i.test(e.userMessage)) {
          throw new IntegrationError('square', 'Square didn’t allow updating stock. The access token needs the INVENTORY_WRITE permission (reconnect Square, or use a token with inventory access).', false, true, e.technical);
        }
        throw e;
      }
    }
  }

  async tokenScopes() {
    const r = await this.call<{ scopes?: string[]; expires_at?: string }>('POST', '/oauth2/token/status', {});
    return { scopes: r?.scopes ?? null, expiresAt: r?.expires_at ?? null };
  }

  async merchantName() {
    const res = await this.call<{ merchant?: { business_name?: string }[] }>('GET', '/v2/merchants');
    return res?.merchant?.[0]?.business_name ?? null;
  }

  async searchOrders(locationIds: string[], updatedFrom: Date, updatedTo: Date): Promise<SquareOrder[]> {
    const out: SquareOrder[] = [];
    // Square allows at most 10 locations per search.
    for (let i = 0; i < locationIds.length; i += 10) {
      let cursor: string | undefined;
      do {
        const res = await this.call<{ orders?: SquareOrder[]; cursor?: string }>('POST', '/v2/orders/search', {
          location_ids: locationIds.slice(i, i + 10),
          limit: 500,
          ...(cursor ? { cursor } : {}),
          query: {
            filter: { date_time_filter: { updated_at: { start_at: updatedFrom.toISOString(), end_at: updatedTo.toISOString() } } },
            // The sort field must match the date filter field.
            sort: { sort_field: 'UPDATED_AT', sort_order: 'ASC' },
          },
        });
        out.push(...(res?.orders ?? []));
        cursor = res?.cursor || undefined;
      } while (cursor);
    }
    return out;
  }

  async listPayments(from: Date, to: Date): Promise<SquarePaymentInfo[]> {
    const out: SquarePaymentInfo[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ begin_time: from.toISOString(), end_time: to.toISOString(), limit: '100', sort_order: 'ASC' });
      if (cursor) qs.set('cursor', cursor);
      const res = await this.call<{ payments?: any[]; cursor?: string }>('GET', `/v2/payments?${qs}`);
      for (const p of res?.payments ?? []) {
        out.push({ id: p.id, order_id: p.order_id, team_member_id: p.team_member_id ?? null, status: p.status, created_at: p.created_at, tip_money: p.tip_money, amount_money: p.amount_money });
      }
      cursor = res?.cursor || undefined;
    } while (cursor);
    return out;
  }
}
