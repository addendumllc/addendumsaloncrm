import { config, squareBaseUrl } from '../../config.js';
import { IntegrationError } from '../../lib/errors.js';
import { DAY } from '../../lib/time.js';
import type { NewSquareItem,
  SquareBooking, SquareCustomer, SquareInventoryCount, SquareOrder, SquarePaymentInfo, SquareTimecard, SquareJob, TimecardBreakInput, SquareLocation, SquareProductVariation, SquareService, SquareServiceVariation, SquareTeamMember, SquareSetCount,
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
 *  POST /v2/labor/timecards/search   (TIMECARDS_READ; falls back to /v2/labor/shifts/search on older API versions)
 */
export class SquareApiService implements SquareService {
  readonly mode = 'live' as const;
  constructor(private getToken: () => Promise<string>) {}

  private async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, attempt = 0): Promise<T> {
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
      // Square refused the request itself (e.g. an overlapping timecard): say what Square said.
      const detail: string | undefined = json?.errors?.[0]?.detail;
      if (res.status >= 400 && res.status < 500 && detail) {
        throw new IntegrationError('square', `Square said: ${detail}`, false, false, `${res.status} ${code}`);
      }
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

  async bookableTeamMemberIds(): Promise<Set<string> | null> {
    const out = new Set<string>();
    let cursor: string | undefined;
    try {
      do {
        const qs = new URLSearchParams({ bookable_only: 'true', limit: '100' });
        if (cursor) qs.set('cursor', cursor);
        const res = await this.call<{ team_member_booking_profiles?: { team_member_id: string; is_bookable?: boolean }[]; cursor?: string }>('GET', `/v2/bookings/team-member-booking-profiles?${qs}`);
        for (const p of res?.team_member_booking_profiles ?? []) if (p.is_bookable !== false) out.add(p.team_member_id);
        cursor = res?.cursor || undefined;
      } while (cursor);
    } catch (e) {
      // Without APPOINTMENTS_BUSINESS_SETTINGS_READ Square won't list them: leave who's a stylist as it was.
      console.warn('[square] booking profiles:', (e as Error).message);
      return null;
    }
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
            teamMemberIds: Array.isArray(vd.team_member_ids) ? vd.team_member_ids : [], availableForBooking: vd.available_for_booking !== false,
          });
        }
      }
      cursor = res?.cursor || undefined;
    } while (cursor);
    return out;
  }

  async listProducts(): Promise<SquareProductVariation[]> {
    const out: SquareProductVariation[] = [];
    // Categories come in the same listing; items refer to them by ID, so names are filled in at the end.
    const categoryNames = new Map<string, string>();
    const itemCategories = new Map<SquareProductVariation, string[]>();
    // Photos also come in the listing (IMAGE objects); items and variations refer to them by ID.
    const imageUrls = new Map<string, string>();
    const itemImages = new Map<SquareProductVariation, string[]>();
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ types: 'ITEM,CATEGORY,IMAGE' });
      if (cursor) qs.set('cursor', cursor);
      const res = await this.call<{ objects?: any[]; cursor?: string }>('GET', `/v2/catalog/list?${qs}`);
      for (const obj of res?.objects ?? []) {
        if (obj.type === 'CATEGORY') { if (obj.category_data?.name) categoryNames.set(obj.id, obj.category_data.name); continue; }
        if (obj.type === 'IMAGE') { if (obj.image_data?.url) imageUrls.set(obj.id, obj.image_data.url); continue; }
        const item = obj.item_data;
        if (!item || obj.is_deleted || item.is_archived) continue;
        if (item.product_type === 'APPOINTMENTS_SERVICE') continue;
        for (const v of item.variations ?? []) {
          if (v.is_deleted) continue;
          const vd = v.item_variation_data ?? {};
          const varName: string = vd.name ?? '';
          const cats = [...(item.categories ?? []).map((c: any) => c.id), item.category_id, item.reporting_category?.id].filter(Boolean) as string[];
          const row: SquareProductVariation = {
            variationId: v.id,
            itemId: obj.id,
            itemName: item.name ?? 'Unnamed item',
            variationName: varName && !/^regular$/i.test(varName) ? varName : null,
            sku: vd.sku || null,
            upc: vd.upc || null,
            priceCents: vd.price_money?.amount != null ? Number(vd.price_money.amount) : null,
            trackInventory: vd.track_inventory !== false,
          };
          out.push(row);
          itemCategories.set(row, cats);
          itemImages.set(row, [...(vd.image_ids ?? []), ...(item.image_ids ?? [])]);
        }
      }
      cursor = res?.cursor || undefined;
    } while (cursor);
    for (const [row, ids] of itemCategories) row.categories = [...new Set(ids.map((id) => categoryNames.get(id)).filter(Boolean) as string[])];
    for (const [row, ids] of itemImages) row.imageUrl = ids.map((id) => imageUrls.get(id)).find(Boolean) ?? null;
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

  /**
   * Reads the variation, changes only its SKU and writes it back with the version Square gave us (Square refuses the
   * write if someone changed the product in between, so nothing else on it is overwritten). Needs ITEMS_WRITE.
   */
  async setVariationSku(variationId: string, sku: string, idempotencyKey: string) {
    const got = await this.call<{ object?: any }>('GET', `/v2/catalog/object/${encodeURIComponent(variationId)}`);
    const obj = got?.object;
    if (!obj || obj.type !== 'ITEM_VARIATION' || obj.is_deleted) throw new IntegrationError('square', 'That product wasn’t found in Square (it may have been deleted).', false);
    obj.item_variation_data = { ...obj.item_variation_data, sku };
    await this.call('POST', '/v2/catalog/object', { idempotency_key: idempotencyKey.slice(0, 128), object: obj });
  }

  async setVariationPrice(variationId: string, priceCents: number, idempotencyKey: string) {
    const got = await this.call<{ object?: any }>('GET', `/v2/catalog/object/${encodeURIComponent(variationId)}`);
    const obj = got?.object;
    if (!obj || obj.type !== 'ITEM_VARIATION' || obj.is_deleted) throw new IntegrationError('square', 'That product wasn’t found in Square (it may have been deleted).', false);
    const currency = obj.item_variation_data?.price_money?.currency ?? 'USD';
    obj.item_variation_data = { ...obj.item_variation_data, pricing_type: 'FIXED_PRICING', price_money: { amount: priceCents, currency } };
    await this.call('POST', '/v2/catalog/object', { idempotency_key: idempotencyKey.slice(0, 128), object: obj });
  }

  async createItems(items: NewSquareItem[], idempotencyKey: string) {
    // Existing categories by name, so new items join them (one is created when missing).
    const cats = new Map<string, string>();
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ types: 'CATEGORY' });
      if (cursor) qs.set('cursor', cursor);
      const res = await this.call<{ objects?: any[]; cursor?: string }>('GET', `/v2/catalog/list?${qs}`);
      for (const o of res?.objects ?? []) if (!o.is_deleted && o.category_data?.name) cats.set(o.category_data.name.trim().toLowerCase(), o.id);
      cursor = res?.cursor || undefined;
    } while (cursor);
    const objects: any[] = [];
    const catId = (name: string | null) => {
      if (!name) return null;
      const k = name.trim().toLowerCase();
      if (!cats.has(k)) { const id = `#cat-${cats.size}`; cats.set(k, id); objects.push({ type: 'CATEGORY', id, category_data: { name: name.trim() } }); }
      return cats.get(k)!;
    };
    const byItem = new Map<string, NewSquareItem[]>();
    for (const it of items) byItem.set(it.itemName, [...(byItem.get(it.itemName) ?? []), it]);
    const varIds = new Map<string, string>();
    let n = 0;
    for (const [name, vars] of byItem) {
      const itemId = `#item-${n++}`;
      const cat = catId(vars[0].categoryName);
      objects.push({
        type: 'ITEM', id: itemId, present_at_all_locations: true,
        item_data: {
          name, product_type: 'REGULAR', ...(cat ? { categories: [{ id: cat }], reporting_category: { id: cat } } : {}),
          variations: vars.map((v, i) => {
            const id = `${itemId}-v${i}`;
            varIds.set(id, v.sku);
            return { type: 'ITEM_VARIATION', id, present_at_all_locations: true, item_variation_data: {
              item_id: itemId, name: v.variationName, sku: v.sku, pricing_type: 'FIXED_PRICING', price_money: { amount: v.priceCents, currency: 'USD' }, track_inventory: true,
            } };
          }),
        },
      });
    }
    const res = await this.call<{ id_mappings?: { client_object_id: string; object_id: string }[] }>('POST', '/v2/catalog/batch-upsert', { idempotency_key: idempotencyKey.slice(0, 128), batches: [{ objects }] });
    return (res?.id_mappings ?? []).filter((m) => varIds.has(m.client_object_id)).map((m) => ({ sku: varIds.get(m.client_object_id)!, variationId: m.object_id }));
  }

  async addVariations(variations: { itemId: string; name: string; sku: string; priceCents: number | null }[], idempotencyKey: string) {
    const ids = new Map<string, string>();
    const objects = variations.map((v, i) => {
      ids.set(`#var-${i}`, v.sku);
      return { type: 'ITEM_VARIATION', id: `#var-${i}`, present_at_all_locations: true, item_variation_data: {
        // No price yet: variable pricing (the price is entered at the sale), never a $0 item.
        item_id: v.itemId, name: v.name, sku: v.sku, track_inventory: true,
        ...(v.priceCents == null ? { pricing_type: 'VARIABLE_PRICING' } : { pricing_type: 'FIXED_PRICING', price_money: { amount: v.priceCents, currency: 'USD' } }),
      } };
    });
    const res = await this.call<{ id_mappings?: { client_object_id: string; object_id: string }[] }>('POST', '/v2/catalog/batch-upsert', { idempotency_key: idempotencyKey.slice(0, 128), batches: [{ objects }] });
    return (res?.id_mappings ?? []).filter((m) => ids.has(m.client_object_id)).map((m) => ({ sku: ids.get(m.client_object_id)!, variationId: m.object_id }));
  }

  async addVariationFirst(v: { itemId: string; name: string; sku: string; priceCents: number | null }, idempotencyKey: string) {
    // A variation's place is its position in the item's list, so the item is saved with the new one first (the rest
    // unchanged, with their versions, so nothing newer is overwritten).
    const got = await this.call<{ object?: any }>('GET', `/v2/catalog/object/${encodeURIComponent(v.itemId)}`);
    const item = got?.object;
    if (!item?.item_data) throw new IntegrationError('square', 'Square didn’t return the item to add the variation to.', false, false, v.itemId);
    const added = { type: 'ITEM_VARIATION', id: '#var-new', present_at_all_locations: true, item_variation_data: {
      item_id: v.itemId, name: v.name, sku: v.sku, track_inventory: true,
      ...(v.priceCents == null ? { pricing_type: 'VARIABLE_PRICING' } : { pricing_type: 'FIXED_PRICING', price_money: { amount: v.priceCents, currency: 'USD' } }),
    } };
    const res = await this.call<{ id_mappings?: { client_object_id: string; object_id: string }[] }>('POST', '/v2/catalog/batch-upsert', {
      idempotency_key: idempotencyKey.slice(0, 128), batches: [{ objects: [{ ...item, item_data: { ...item.item_data, variations: [added, ...(item.item_data.variations ?? [])] } }] }],
    });
    const id = res?.id_mappings?.find((m) => m.client_object_id === '#var-new')?.object_id;
    return id ? { sku: v.sku, variationId: id } : null;
  }

  async moveVariationFirst(itemId: string, variationId: string, idempotencyKey: string) {
    const item = (await this.call<{ object?: any }>('GET', `/v2/catalog/object/${encodeURIComponent(itemId)}`))?.object;
    const vars: any[] = item?.item_data?.variations ?? [];
    const at = vars.findIndex((v) => v.id === variationId);
    if (at <= 0) return false;
    await this.call('POST', '/v2/catalog/batch-upsert', { idempotency_key: idempotencyKey.slice(0, 128), batches: [{ objects: [{ ...item, item_data: { ...item.item_data, variations: [vars[at], ...vars.filter((_, i) => i !== at)] } }] }] });
    return true;
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

  async listTimecards(from: Date, to: Date): Promise<SquareTimecard[]> {
    const out: SquareTimecard[] = [];
    // Square renamed shifts to timecards; older API versions only have /shifts/search.
    let path = '/v2/labor/timecards/search';
    let key: 'timecards' | 'shifts' = 'timecards';
    let cursor: string | undefined;
    do {
      const body = { query: { filter: { start: { start_at: from.toISOString(), end_at: to.toISOString() }, status: 'CLOSED' } }, limit: 200, ...(cursor ? { cursor } : {}) };
      const res = await this.call<any>('POST', path, body);
      if (res === null && key === 'timecards') {
        path = '/v2/labor/shifts/search';
        key = 'shifts';
        continue;
      }
      for (const t of res?.[key] ?? []) {
        if (t.team_member_id || t.employee_id) out.push({ id: t.id, team_member_id: t.team_member_id ?? t.employee_id, start_at: t.start_at, end_at: t.end_at ?? null, status: t.status, breaks: t.breaks ?? [], created_at: t.created_at, updated_at: t.updated_at });
      }
      cursor = res?.cursor || undefined;
    } while (cursor);
    return out;
  }

  async assignedJob(teamMemberId: string): Promise<SquareJob | null> {
    const r = await this.call<any>('GET', `/v2/team-members/${encodeURIComponent(teamMemberId)}/wage-setting`);
    const j = r?.wage_setting?.job_assignments?.[0];
    if (!j) return null;
    return { jobId: j.job_id ?? null, title: j.job_title ?? 'Job', hourlyRateCents: j.hourly_rate?.amount ?? null };
  }

  /**
   * The location's break type for this kind of break: an unpaid one for lunch (named like "Lunch" if there are several),
   * a paid one otherwise. Made in Square when the location has none.
   */
  private breakTypes = new Map<string, string>();
  private async breakTypeId(locationId: string, paid: boolean, minutes: number) {
    const key = `${locationId}:${paid}`;
    const cached = this.breakTypes.get(key);
    if (cached) return cached;
    const res = await this.call<any>('GET', `/v2/labor/break-types?location_id=${encodeURIComponent(locationId)}&limit=200`);
    const types: any[] = (res?.break_types ?? []).filter((b: any) => !!b.is_paid === paid);
    const want = paid ? /break|rest/i : /lunch|meal|unpaid/i;
    let id: string | undefined = (types.find((b) => want.test(b.break_name ?? '')) ?? types[0])?.id;
    if (!id) {
      const made = await this.call<any>('POST', '/v2/labor/break-types', {
        idempotency_key: `crm-break-${locationId}-${paid ? 'paid' : 'unpaid'}`.slice(0, 128),
        break_type: { location_id: locationId, break_name: paid ? 'Break' : 'Lunch', expected_duration: `PT${minutes}M`, is_paid: paid },
      });
      id = made?.break_type?.id;
      if (!id) throw new IntegrationError('square', 'Square didn’t make a lunch break type. Add an unpaid break in Square (Team → Settings → Breaks).', false);
    }
    this.breakTypes.set(key, id);
    return id;
  }

  private async squareBreaks(locationId: string, breaks: TimecardBreakInput[] | undefined) {
    const out = [];
    for (const b of breaks ?? []) {
      out.push({
        start_at: b.startAt.toISOString(), ...(b.endAt ? { end_at: b.endAt.toISOString() } : {}),
        break_type_id: await this.breakTypeId(locationId, b.paid, b.plannedMinutes),
        name: b.paid ? 'Break' : 'Lunch', expected_duration: `PT${b.plannedMinutes}M`, is_paid: b.paid,
      });
    }
    return out;
  }

  async createTimecard(t: { teamMemberId: string; locationId: string; startAt: Date; endAt: Date; job?: SquareJob | null; breaks?: TimecardBreakInput[] }, idempotencyKey: string) {
    // The person's assigned job, so Square files the hours (and pay) under it.
    const wage = t.job ? { title: t.job.title, ...(t.job.jobId ? { job_id: t.job.jobId } : {}), ...(t.job.hourlyRateCents != null ? { hourly_rate: { amount: t.job.hourlyRateCents, currency: 'USD' } } : {}) } : undefined;
    const breaks = await this.squareBreaks(t.locationId, t.breaks);
    const body = { location_id: t.locationId, team_member_id: t.teamMemberId, start_at: t.startAt.toISOString(), end_at: t.endAt.toISOString(), ...(wage ? { wage } : {}), ...(breaks.length ? { breaks } : {}) };
    // Square renamed shifts to timecards; older API versions only have /shifts.
    let r = await this.call<any>('POST', '/v2/labor/timecards', { idempotency_key: idempotencyKey.slice(0, 128), timecard: body });
    if (r === null) r = await this.call<any>('POST', '/v2/labor/shifts', { idempotency_key: idempotencyKey.slice(0, 128), shift: body });
    const id = r?.timecard?.id ?? r?.shift?.id;
    if (!id) throw new IntegrationError('square', 'Square didn’t create the timecard. Try again.', true);
    return id as string;
  }

  async openTimecard(t: { teamMemberId: string; locationId: string; startAt: Date; job?: SquareJob | null }, idempotencyKey: string) {
    const wage = t.job ? { title: t.job.title, ...(t.job.jobId ? { job_id: t.job.jobId } : {}), ...(t.job.hourlyRateCents != null ? { hourly_rate: { amount: t.job.hourlyRateCents, currency: 'USD' } } : {}) } : undefined;
    const body = { location_id: t.locationId, team_member_id: t.teamMemberId, start_at: t.startAt.toISOString(), ...(wage ? { wage } : {}) };
    let r = await this.call<any>('POST', '/v2/labor/timecards', { idempotency_key: idempotencyKey.slice(0, 128), timecard: body });
    if (r === null) r = await this.call<any>('POST', '/v2/labor/shifts', { idempotency_key: idempotencyKey.slice(0, 128), shift: body });
    const id = r?.timecard?.id ?? r?.shift?.id;
    if (!id) throw new IntegrationError('square', 'Square didn’t clock them in. Try again.', true);
    return id as string;
  }

  /** Reads the timecard (Square needs its current version), then updates its end and/or breaks. */
  private async updateTimecard(id: string, change: { endAt?: Date; breaks?: TimecardBreakInput[] }) {
    let kind: 'timecards' | 'shifts' = 'timecards';
    let got = await this.call<any>('GET', `/v2/labor/timecards/${encodeURIComponent(id)}`);
    if (got === null) { kind = 'shifts'; got = await this.call<any>('GET', `/v2/labor/shifts/${encodeURIComponent(id)}`); }
    const card = got?.timecard ?? got?.shift;
    if (!card) throw new IntegrationError('square', 'That Square timecard wasn’t found.', false);
    const body = { ...card, ...(change.endAt ? { end_at: change.endAt.toISOString() } : {}) };
    if (change.breaks) body.breaks = await this.squareBreaks(card.location_id, change.breaks);
    for (const k of ['id', 'status', 'created_at', 'updated_at']) delete body[k];
    await this.call('PUT', `/v2/labor/${kind}/${encodeURIComponent(id)}`, kind === 'timecards' ? { timecard: body } : { shift: body });
  }

  async setTimecardBreaks(id: string, breaks: TimecardBreakInput[]) {
    await this.updateTimecard(id, { breaks });
  }

  async closeTimecard(id: string, endAt: Date, breaks?: TimecardBreakInput[]) {
    await this.updateTimecard(id, { endAt, breaks });
  }

  /** Removes a timecard (already gone counts as done). */
  async deleteTimecard(id: string) {
    const r = await this.call<any>('DELETE', `/v2/labor/timecards/${encodeURIComponent(id)}`);
    if (r === null) await this.call<any>('DELETE', `/v2/labor/shifts/${encodeURIComponent(id)}`);
  }

  /** Payments at each location: without location_id Square returns only the main location's, so the salon's were missed. */
  async listPayments(from: Date, to: Date, locationIds: string[] = []): Promise<SquarePaymentInfo[]> {
    const out: SquarePaymentInfo[] = [];
    for (const loc of locationIds.length ? locationIds : [null]) out.push(...await this.paymentsAt(from, to, loc));
    return out;
  }
  private async paymentsAt(from: Date, to: Date, locationId: string | null): Promise<SquarePaymentInfo[]> {
    const out: SquarePaymentInfo[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ begin_time: from.toISOString(), end_time: to.toISOString(), limit: '100', sort_order: 'ASC' });
      if (locationId) qs.set('location_id', locationId);
      if (cursor) qs.set('cursor', cursor);
      const res = await this.call<{ payments?: any[]; cursor?: string }>('GET', `/v2/payments?${qs}`);
      for (const p of res?.payments ?? []) {
        // Who took the payment (checked the client out): team_member_id, or employee_id on some POS setups and older payments.
        out.push({ id: p.id, order_id: p.order_id, team_member_id: p.team_member_id ?? p.employee_id ?? null, status: p.status, created_at: p.created_at, tip_money: p.tip_money, amount_money: p.amount_money });
      }
      cursor = res?.cursor || undefined;
    } while (cursor);
    return out;
  }
}
