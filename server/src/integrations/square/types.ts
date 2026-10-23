import type { SquareBookingStatus } from '@addendum/shared';

/** Shapes below mirror Square's API objects (Square-Version 2026-09-16). Only fields we use are typed. */
export interface SquareAppointmentSegment {
  duration_minutes?: number;
  service_variation_id?: string;
  team_member_id: string;
  service_variation_version?: number;
  intermission_minutes?: number;
  any_team_member?: boolean;
}

export interface SquareBooking {
  id: string;
  version?: number;
  status: SquareBookingStatus;
  created_at?: string;
  updated_at?: string;
  start_at: string;
  location_id?: string;
  customer_id?: string;
  customer_note?: string;
  seller_note?: string;
  appointment_segments?: SquareAppointmentSegment[];
  transition_time_minutes?: number;
  all_day?: boolean;
  location_type?: string;
  source?: string;
}

export interface SquareCustomer {
  id: string;
  given_name?: string;
  family_name?: string;
  nickname?: string;
  email_address?: string;
  phone_number?: string;
  birthday?: string;
  note?: string;
  created_at?: string;
  creation_source?: string;
}

export interface SquareTeamMember {
  id: string;
  given_name?: string;
  family_name?: string;
  email_address?: string;
  /** E.164, when the team member has one in Square. */
  phone_number?: string;
  status?: string;
  is_owner?: boolean;
}

/** Flattened Square catalog service variation (an appointment service). */
export interface SquareServiceVariation {
  variationId: string;
  itemId: string;
  name: string;
  durationMinutes: number | null;
  priceCents: number | null;
}

/** A sellable product variation from the Square catalog (retail items, not appointment services). */
export interface SquareProductVariation {
  variationId: string;
  itemId: string;
  itemName: string;
  variationName: string | null;
  sku: string | null;
  upc: string | null;
  priceCents: number | null;
  trackInventory: boolean;
  /** The item's Square categories (names). */
  categories?: string[];
  /** The listing's photo (the variation's own, else the item's), as Square hosts it. */
  imageUrl?: string | null;
}

/** In-stock quantity of one variation at one location (Square returns decimals as strings). */
export interface SquareInventoryCount {
  variationId: string;
  locationId: string;
  quantity: number;
  calculatedAt: string | null;
}

/** Sets the IN_STOCK count of one variation at one location, as of `occurredAt` (Square applies later sales on top). */
export interface SquareSetCount {
  variationId: string;
  locationId: string;
  quantity: number;
  occurredAt: string;
  referenceId?: string;
}

export interface SquareLocation {
  id: string;
  name: string;
  timezone?: string;
  address?: string;
}

/**
 * The integration boundary for Square. The rest of the app depends only on this interface,
 * so the live API client and the demo simulator are interchangeable.
 */
// ---------- Orders & payments (for commission). Field names exactly as Square returns them (snake_case). ----------
// Verified against the official Square SDK v46 types (Square-Version 2026-09-16). Order line items carry NO team
// member, so who did the work comes from the matching booking (or the payment's team_member_id) — see commission.ts.
export interface SquareMoney { amount?: number | null; currency?: string }

export interface SquareOrderLineItem {
  uid?: string;
  name?: string;
  quantity: string;
  catalog_object_id?: string;
  variation_name?: string;
  item_type?: 'ITEM' | 'CUSTOM_AMOUNT' | 'GIFT_CARD';
  base_price_money?: SquareMoney;
  gross_sales_money?: SquareMoney;
  total_discount_money?: SquareMoney;
  total_money?: SquareMoney;
}

export interface SquareOrderReturnLineItem {
  uid?: string;
  source_line_item_uid?: string;
  name?: string;
  quantity: string;
  catalog_object_id?: string;
  item_type?: string;
  gross_return_money?: SquareMoney;
  total_discount_money?: SquareMoney;
  total_money?: SquareMoney;
}

export interface SquareOrder {
  id: string;
  location_id: string;
  customer_id?: string;
  state?: 'OPEN' | 'COMPLETED' | 'CANCELED' | 'DRAFT';
  version?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  line_items?: SquareOrderLineItem[];
  returns?: { uid?: string; source_order_id?: string; return_line_items?: SquareOrderReturnLineItem[] }[];
  refunds?: { id: string; tender_id?: string; amount_money?: SquareMoney; status?: string; reason?: string }[];
  tenders?: { id?: string; payment_id?: string; type?: string; amount_money?: SquareMoney; tip_money?: SquareMoney }[];
  total_money?: SquareMoney;
  total_tip_money?: SquareMoney;
  total_discount_money?: SquareMoney;
}

/** A job from a team member's wage setting in Square (title, pay and id). */
export interface SquareJob { jobId: string | null; title: string; hourlyRateCents: number | null }

/** A break on a timecard sent to Square (an unpaid lunch). endAt null while they're still on it. */
export interface TimecardBreakInput { startAt: Date; endAt: Date | null; paid: boolean; plannedMinutes: number }

/** A Square timecard (shift): who worked, when, and the breaks in it. */
export interface SquareTimecard {
  id: string;
  team_member_id: string;
  start_at: string;
  end_at?: string | null;
  status?: string;
  breaks?: { start_at: string; end_at?: string | null; is_paid?: boolean }[];
  /** The job it was filed under (timecards created from the CRM use the person's assigned job). */
  job_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface SquarePaymentInfo {
  id: string;
  order_id?: string;
  team_member_id?: string | null;
  status?: string;
  created_at?: string;
  tip_money?: SquareMoney;
  amount_money?: SquareMoney;
}

/** A new retail product for Square: one item (by name) can get several variations. */
export interface NewSquareItem { itemName: string; variationName: string; sku: string; priceCents: number; categoryName: string | null }

export interface SquareService {
  readonly mode: 'live' | 'demo';
  /** Lists bookings with start times in [min, max). Implementations handle Square's 31-day window + paging. */
  listBookings(startMin: Date, startMax: Date): Promise<SquareBooking[]>;
  retrieveBooking(id: string): Promise<SquareBooking | null>;
  bulkRetrieveCustomers(ids: string[]): Promise<SquareCustomer[]>;
  listTeamMembers(): Promise<SquareTeamMember[]>;
  listServices(): Promise<SquareServiceVariation[]>;
  listLocations(): Promise<SquareLocation[]>;
  merchantName(): Promise<string | null>;
  /** Retail products (every ITEM that isn't an appointment service), one entry per variation. */
  listProducts(): Promise<SquareProductVariation[]>;
  /** IN_STOCK counts for every tracked variation at every location. Needs INVENTORY_READ. */
  listInventoryCounts(): Promise<SquareInventoryCount[]>;
  /** Records physical counts (needs INVENTORY_WRITE). Repeating an idempotency key is applied once. */
  setInventoryCounts(counts: SquareSetCount[], idempotencyKey: string): Promise<void>;
  /** Changes one item variation's SKU in the Square catalog (nothing else on it). Needs ITEMS_WRITE. */
  setVariationSku(variationId: string, sku: string, idempotencyKey: string): Promise<void>;
  /** Sets a variation's price (fixed pricing, in the store's currency). Needs ITEMS_WRITE. */
  setVariationPrice(variationId: string, priceCents: number, idempotencyKey: string): Promise<void>;
  /** Creates retail items (stock tracked, at every location), grouping variations by item name; a missing category is created. Needs ITEMS_WRITE. */
  createItems(items: NewSquareItem[], idempotencyKey: string): Promise<{ sku: string; variationId: string }[]>;
  /** Adds variations to existing items (stock tracked, at every location). Needs ITEMS_WRITE. */
  addVariations(variations: { itemId: string; name: string; sku: string; priceCents: number }[], idempotencyKey: string): Promise<{ sku: string; variationId: string }[]>;
  /** The permissions of the access token in use (null when Square doesn't list them). */
  tokenScopes(): Promise<{ scopes: string[] | null; expiresAt: string | null }>;
  /** Orders at these locations updated in [from, to], oldest first (POST /v2/orders/search; ORDERS_READ). */
  searchOrders(locationIds: string[], updatedFrom: Date, updatedTo: Date): Promise<SquareOrder[]>;
  /** Payments created in [from, to] (GET /v2/payments; PAYMENTS_READ) — for the team member who took each payment. */
  listPayments(from: Date, to: Date): Promise<SquarePaymentInfo[]>;
  /** Closed timecards that started in [from, to] (Labor API; TIMECARDS_READ). */
  listTimecards(from: Date, to: Date): Promise<SquareTimecard[]>;
  /**
   * Creates a closed timecard (Labor API; TIMECARDS_WRITE), with any breaks on it (an unpaid lunch uses the location's
   * unpaid break type, made if there's none). Returns its id. Repeating the key creates it once.
   */
  createTimecard(t: { teamMemberId: string; locationId: string; startAt: Date; endAt: Date; job?: SquareJob | null; breaks?: TimecardBreakInput[] }, idempotencyKey: string): Promise<string>;
  /** The team member's assigned job in Square (their first job assignment), for timecards. null when none. */
  assignedJob(teamMemberId: string): Promise<SquareJob | null>;
  /** Clocks someone in on Square: an open timecard (no end yet). Returns its id. */
  openTimecard(t: { teamMemberId: string; locationId: string; startAt: Date; job?: SquareJob | null }, idempotencyKey: string): Promise<string>;
  /** Replaces the breaks on an open timecard (starting or ending lunch while clocked in), keeping it open. */
  setTimecardBreaks(id: string, breaks: TimecardBreakInput[]): Promise<void>;
  /** Clocks out an open timecard at this time (and sets its breaks, when given). */
  closeTimecard(id: string, endAt: Date, breaks?: TimecardBreakInput[]): Promise<void>;
  /** Deletes a timecard (Labor API; TIMECARDS_WRITE). A timecard that's already gone is fine. */
  deleteTimecard(id: string): Promise<void>;
}
