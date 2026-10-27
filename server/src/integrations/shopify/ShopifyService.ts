/**
 * Shopify inventory, written to only when an Administrator pushes Square's stock counts to Shopify.
 * Square stays the source of truth: products are matched to Shopify variants by SKU, and Shopify's
 * "available" quantity at one location is set to Square's in-stock count.
 */
export interface ShopifyVariantBySku {
  sku: string;
  inventoryItemId: string;
  label: string;
  tracked: boolean;
}

export interface ShopifySetQuantity {
  inventoryItemId: string;
  quantity: number;
  /**
   * Compare-and-set: the quantity we expect Shopify to have now. If it changed in the meantime Shopify refuses
   * (CHANGE_FROM_QUANTITY_STALE), so a sale made during a sync is never overwritten. null = no check.
   */
  changeFromQuantity?: number | null;
}

/** A Shopify variant with its SKU and "available" stock at one location. */
export interface ShopifyInventoryEntry {
  sku: string;
  inventoryItemId: string;
  label: string;
  tracked: boolean;
  /** null when the item isn't stocked at this location */
  available: number | null;
  /** The product's status in Shopify (drafts aren't on sale yet). */
  status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  /** The product's collections and product type, for search. */
  collections?: string[];
  /** Its Shopify collections with their stable ids (lead-time rules refer to these, not the names). */
  collectionRefs?: { id: string; title: string }[];
  /** The listing's photo (the variant's own, else the product's), a small thumbnail on Shopify's CDN. */
  imageUrl?: string | null;
}

/** A variant's price and its inventory item's cost (Inventory → Pricing). */
export interface ShopifyPriceEntry { variantId: string; productId: string; inventoryItemId: string; sku: string | null; label: string; priceCents: number | null; costCents: number | null; productTitle?: string; tags?: string[] }
/** An order's number (e.g. "#1042") and the customer's name, when the app may read customers. */
export interface ShopifyOrderWho { name: string | null; customer: string | null }
/** A product's variants with their options (e.g. "Length - Density" = "18 inch - 120g"). */
export interface ShopifyProductVariants { productId: string; variants: { sku: string | null; options: { name: string; value: string }[] }[] }
/** A variant to add to an existing product: its option values, SKU and price; stock is tracked and starts at 0. */
export interface ShopifyNewVariant { options: { name: string; value: string }[]; sku: string; priceCents: number }

/** One line of a Shopify order (for sales history and forecasts). */
export interface ShopifyOrderLine {
  orderId: string;
  lineId: string;
  inventoryItemId: string | null;
  sku: string | null;
  /** Units still on the order (after removals and refunds). */
  quantity: number;
  /** Price paid per unit after line discounts, in cents (null if Shopify didn't say). */
  unitPriceCents: number | null;
  orderedAt: string;
  cancelled: boolean;
  /** The product title on the line ("Product - Variant"), kept for matching sales to products by name. */
  title?: string | null;
}

/** Thrown when a compare-and-set failed because Shopify's quantity changed since it was read. */
export class ShopifyStaleQuantityError extends Error {
  constructor() {
    super('Shopify quantity changed since it was read');
  }
}

export interface ShopifyService {
  readonly mode: 'live' | 'demo';
  testConnection(): Promise<{ shopName: string; locationName: string | null }>;
  /** The location stock is set at (configured, or the store's only active location). */
  locationId(): Promise<string>;
  /** Every Shopify variant whose SKU matches one of these (case-insensitive). */
  findBySkus(skus: string[]): Promise<ShopifyVariantBySku[]>;
  /** Sets "available" to exactly these quantities. Repeating the same key is applied once. */
  setAvailable(locationId: string, quantities: ShopifySetQuantity[], idempotencyKey: string, referenceUri: string): Promise<void>;
  /** Every variant that has a SKU, with its available stock at the location. */
  listInventory(locationId: string): Promise<ShopifyInventoryEntry[]>;
  /** Access scopes granted to the app (checked by Test connection). */
  accessScopes(): Promise<string[]>;
  /** Changes one variant's SKU (on its inventory item; nothing else). Needs write_inventory. */
  setSku(inventoryItemId: string, sku: string): Promise<void>;
  /** Turns "Track quantity" on or off for one variant (its inventory item). Needs write_inventory. */
  setTracked(inventoryItemId: string, tracked: boolean): Promise<void>;
  /** Lines of orders updated since this time (needs read_orders; read_all_orders for more than 60 days back). */
  listOrderLines(updatedSince: Date): Promise<ShopifyOrderLine[]>;
  /** Every variant's price and cost (needs read_products). */
  listPrices(): Promise<ShopifyPriceEntry[]>;
  /** Sets prices for variants of one product (needs write_products). */
  setPrices(productId: string, variants: { variantId: string; priceCents: number }[]): Promise<void>;
  /** Sets the cost per item on an inventory item (needs write_inventory). */
  setUnitCost(inventoryItemId: string, costCents: number | null): Promise<void>;
  /** Order numbers and customer names for these orders (the name only when the app may read customers). */
  orderWho(orderIds: string[]): Promise<Map<string, ShopifyOrderWho>>;
  /** These products' variants and options (needs read_products). */
  productVariants(productIds: string[]): Promise<ShopifyProductVariants[]>;
  /** Adds variants to one product, stocked at the location with 0 (needs write_products). */
  addVariants(productId: string, variants: ShopifyNewVariant[], locationId: string): Promise<{ sku: string; inventoryItemId: string }[]>;
  /** Puts one value of an option first (e.g. "Sample Swatch" above "18 inch - 120g"), so it shows first (write_products). */
  moveOptionValueFirst(productId: string, optionName: string, value: string): Promise<void>;
}

/** Demo prices and costs per listing (by inventory item), shared by both demo stores. */
export const demoPrices = new Map<string, { priceCents: number; costCents: number | null }>();
/** Demo product tags per listing (e.g. "pro-pricing"). */
export const demoTags = new Map<string, string[]>();
const demoPriceOf = (id: string, i: number) => demoPrices.get(id) ?? { priceCents: 9500 + i * 2000, costCents: 4000 + i * 800 };
const DEMO_CUSTOMERS = ['Maya Lopez', 'Bella Moreno', 'Jade Kim', 'Rosa Diaz', 'Sam Patel', 'Ava Chen'];
function demoWho(orderIds: string[]) {
  return new Map(orderIds.map((id) => {
    const n = [...id].reduce((a, ch) => a + ch.charCodeAt(0), 0);
    return [id, { name: `#${1000 + (n % 900)}`, customer: DEMO_CUSTOMERS[n % DEMO_CUSTOMERS.length] }];
  }));
}
/** Demo: a product's variants from the catalog labels ("Product – Option value"). */
function demoProductVariants(catalog: ShopifyVariantBySku[], prefix: string, productIds: string[]): ShopifyProductVariants[] {
  const list = demoPriceList(catalog, prefix);
  return productIds.map((productId) => ({ productId, variants: list.filter((l) => l.productId === productId).map((l) => ({ sku: l.sku, options: [{ name: 'Option', value: l.label.split(/\s+[–-]\s+/).slice(1).join(' - ') || 'Default Title' }] })) }));
}
function demoAddVariants(catalog: ShopifyVariantBySku[], stock: Map<string, number>, prefix: string, productId: string, variants: ShopifyNewVariant[]) {
  const title = demoPriceList(catalog, prefix).find((l) => l.productId === productId)?.productTitle;
  if (!title) throw new Error('not found');
  return variants.map((v) => {
    const inventoryItemId = `gid://shopify/InventoryItem/${prefix}new${catalog.length}`;
    catalog.push({ sku: v.sku, inventoryItemId, label: `${title} – ${v.options.map((o) => o.value).join(' / ')}`, tracked: true });
    stock.set(inventoryItemId, 0);
    demoPrices.set(inventoryItemId, { priceCents: v.priceCents, costCents: null });
    return { sku: v.sku, inventoryItemId };
  });
}
function demoPriceList(catalog: ShopifyVariantBySku[], prefix: string) {
  return catalog.map((c, i) => ({
    variantId: `gid://shopify/ProductVariant/${prefix}${i}`, productId: `gid://shopify/Product/${prefix}${c.label.split(/\s+[–-]\s+/)[0].length}`,
    inventoryItemId: c.inventoryItemId, sku: c.sku, label: c.label, productTitle: c.label.split(/\s+[–-]\s+/)[0], tags: demoTags.get(c.inventoryItemId) ?? [], ...demoPriceOf(c.inventoryItemId, i),
  }));
}

/** Simulated store for Demo Mode and tests. Like Shopify, a repeated idempotency key is applied only once. */
export class MockShopifyService implements ShopifyService {
  readonly mode = 'demo' as const;
  static catalog: ShopifyVariantBySku[] = [
    { sku: 'HTW-20-60', inventoryItemId: 'gid://shopify/InventoryItem/1', label: 'Signature Hand-Tied Weft – 20" / #60 Platinum', tracked: true },
    { sku: 'HTW-20-1822', inventoryItemId: 'gid://shopify/InventoryItem/2', label: 'Signature Hand-Tied Weft – 20" / #18/22 Balayage', tracked: true },
    { sku: 'KTIP-22-1B', inventoryItemId: 'gid://shopify/InventoryItem/4', label: 'K-Tip Extensions – 22" / #1B Natural Black', tracked: true },
    { sku: 'TAPE-16-8', inventoryItemId: 'gid://shopify/InventoryItem/5', label: 'Tape-In Extensions – 16" / #8 Chestnut', tracked: true },
    { sku: 'CARE-KIT', inventoryItemId: 'gid://shopify/InventoryItem/6', label: 'Extension Care Kit', tracked: false },
  ];
  static stock = new Map<string, number>();
  static applied = new Set<string>();
  /** SKUs changed through setSku (the catalog itself stays as listed). */
  static skus = new Map<string, string>();
  static sets: ShopifySetQuantity[][] = [];
  /** Test hook: make the next pushes fail. */
  static failNext: Error | null = null;
  /** Test hook: runs just before a write (e.g. to simulate a sale landing mid-sync). */
  static onBeforeSet: (() => void) | null = null;
  /** Test hook: extra order lines (e.g. sales under an old SKU). */
  static extraOrderLines: ShopifyOrderLine[] = [];

  static reset() {
    this.stock = new Map(this.catalog.map((c) => [c.inventoryItemId, 50]));
    this.applied = new Set();
    this.skus = new Map();
    this.sets = [];
    this.failNext = null;
    this.onBeforeSet = null;
    this.extraOrderLines = [];
  }

  async testConnection() {
    return { shopName: 'Addendum Hair (demo)', locationName: 'Demo warehouse' };
  }

  async locationId() {
    return 'gid://shopify/Location/1';
  }

  private static view() {
    return this.catalog.map((c) => ({ ...c, sku: this.skus.get(c.inventoryItemId) ?? c.sku }));
  }

  async findBySkus(skus: string[]) {
    const want = new Set(skus.map((s) => s.toLowerCase()));
    return MockShopifyService.view().filter((c) => want.has(c.sku.toLowerCase()));
  }

  async listInventory() {
    return MockShopifyService.view().map((c) => ({ ...c, available: c.tracked ? MockShopifyService.stock.get(c.inventoryItemId) ?? 0 : null }));
  }

  async setTracked(inventoryItemId: string, tracked: boolean) {
    const c = MockShopifyService.catalog.find((x) => x.inventoryItemId === inventoryItemId);
    if (c) c.tracked = tracked;
  }

  async setSku(inventoryItemId: string, sku: string) {
    if (MockShopifyService.failNext) throw MockShopifyService.failNext;
    if (!MockShopifyService.catalog.some((c) => c.inventoryItemId === inventoryItemId)) throw new Error('not found');
    MockShopifyService.skus.set(inventoryItemId, sku);
  }

  async accessScopes() {
    return ['read_products', 'read_inventory', 'write_inventory', 'read_locations', 'read_orders'];
  }

  async listPrices() { return demoPriceList(MockShopifyService.view(), '1'); }
  async setPrices(_productId: string, variants: { variantId: string; priceCents: number }[]) {
    if (MockShopifyService.failNext) throw MockShopifyService.failNext;
    const list = demoPriceList(MockShopifyService.view(), '1');
    for (const v of variants) { const e = list.find((x) => x.variantId === v.variantId); if (e) demoPrices.set(e.inventoryItemId, { ...demoPriceOf(e.inventoryItemId, list.indexOf(e)), priceCents: v.priceCents }); }
  }
  async setUnitCost(inventoryItemId: string, costCents: number | null) {
    const list = demoPriceList(MockShopifyService.view(), '1');
    const i = list.findIndex((x) => x.inventoryItemId === inventoryItemId);
    if (i >= 0) demoPrices.set(inventoryItemId, { ...demoPriceOf(inventoryItemId, i), costCents });
  }
  async orderWho(orderIds: string[]) { return demoWho(orderIds); }
  async productVariants(productIds: string[]) { return demoProductVariants(MockShopifyService.view(), '1', productIds); }
  async addVariants(productId: string, variants: ShopifyNewVariant[]) { return demoAddVariants(MockShopifyService.catalog, MockShopifyService.stock, '1', productId, variants); }
  /** Demo: remembered, so tests can see what was moved first. */
  static firstValues: { productId: string; option: string; value: string }[] = [];
  async moveOptionValueFirst(productId: string, option: string, value: string) { MockShopifyService.firstValues.push({ productId, option, value }); }

  /** Demo sales: a few units of each tracked product most days, the same every time. */
  async listOrderLines(updatedSince: Date) {
    const out: ShopifyOrderLine[] = [];
    const tracked = MockShopifyService.catalog.filter((c) => c.tracked);
    for (let d = new Date(Math.max(updatedSince.getTime(), Date.now() - 400 * 86400_000)); d.getTime() < Date.now(); d = new Date(d.getTime() + 86400_000)) {
      const day = d.toISOString().slice(0, 10);
      tracked.forEach((c, i) => {
        const n = (day.split('-').reduce((a, x) => a + Number(x), 0) * (i + 3)) % 4;
        if (n > 0) out.push({ orderId: `demo-${day}-${i}`, lineId: `${i}`, inventoryItemId: c.inventoryItemId, sku: c.sku, quantity: n, unitPriceCents: 4500 + i * 1000, orderedAt: `${day}T18:00:00Z`, cancelled: false, title: c.label });
      });
    }
    out.push(...MockShopifyService.extraOrderLines.filter((l) => Date.parse(l.orderedAt) >= updatedSince.getTime()));
    return out;
  }

  async setAvailable(_locationId: string, quantities: ShopifySetQuantity[], idempotencyKey: string) {
    if (MockShopifyService.failNext) throw MockShopifyService.failNext;
    if (MockShopifyService.applied.has(idempotencyKey)) return;
    const hook = MockShopifyService.onBeforeSet;
    MockShopifyService.onBeforeSet = null;
    hook?.();
    for (const q of quantities) {
      if (q.changeFromQuantity != null && (MockShopifyService.stock.get(q.inventoryItemId) ?? 0) !== q.changeFromQuantity) throw new ShopifyStaleQuantityError();
    }
    MockShopifyService.applied.add(idempotencyKey);
    MockShopifyService.sets.push(quantities);
    for (const q of quantities) MockShopifyService.stock.set(q.inventoryItemId, q.quantity);
  }
}
MockShopifyService.reset();

/**
 * A second demo store (tests): shares SKUs with the main one, and lists one SKU twice at different prices — like a
 * pro store with stylist and retail prices for the same product.
 */
export class MockShopifyStore2 implements ShopifyService {
  readonly mode = 'demo' as const;
  static catalog: ShopifyVariantBySku[] = [
    { sku: 'HTW-20-60', inventoryItemId: 'gid://shopify/InventoryItem/201', label: 'Signature Hand-Tied Weft – 20" / #60 (stylist price)', tracked: true },
    { sku: 'HTW-20-60', inventoryItemId: 'gid://shopify/InventoryItem/202', label: 'Signature Hand-Tied Weft – 20" / #60 (salon price)', tracked: true },
    { sku: 'KTIP-22-1B', inventoryItemId: 'gid://shopify/InventoryItem/204', label: 'K-Tip Extensions – 22" / #1B', tracked: true },
    { sku: 'PRO-ONLY-1', inventoryItemId: 'gid://shopify/InventoryItem/299', label: 'Pro starter kit', tracked: true },
  ];
  static stock = new Map<string, number>();
  static applied = new Set<string>();
  static skus = new Map<string, string>();
  /** Product status per listing (default active) and "Track quantity" changes made through setTracked. */
  static status = new Map<string, 'ACTIVE' | 'DRAFT' | 'ARCHIVED'>();
  static tracked = new Map<string, boolean>();
  static reset() {
    this.stock = new Map(this.catalog.map((c) => [c.inventoryItemId, 50]));
    this.applied = new Set();
    this.skus = new Map();
    this.status = new Map();
    this.tracked = new Map();
  }
  private static view() { return this.catalog.map((c) => ({ ...c, sku: this.skus.get(c.inventoryItemId) ?? c.sku, tracked: this.tracked.get(c.inventoryItemId) ?? c.tracked, status: this.status.get(c.inventoryItemId) ?? 'ACTIVE' as const })); }
  async testConnection() { return { shopName: 'Addendum Hair Pro (demo)', locationName: 'Demo warehouse' }; }
  async locationId() { return 'gid://shopify/Location/2'; }
  async findBySkus(skus: string[]) { const want = new Set(skus.map((s) => s.toLowerCase())); return MockShopifyStore2.view().filter((c) => want.has(c.sku.toLowerCase())); }
  async listInventory() { return MockShopifyStore2.view().map((c) => ({ ...c, available: MockShopifyStore2.stock.get(c.inventoryItemId) ?? 0 })); }
  async setSku(inventoryItemId: string, sku: string) { MockShopifyStore2.skus.set(inventoryItemId, sku); }
  async setTracked(inventoryItemId: string, tracked: boolean) { MockShopifyStore2.tracked.set(inventoryItemId, tracked); }
  async accessScopes() { return ['read_products', 'write_inventory', 'read_locations', 'read_orders']; }
  async listPrices() { return demoPriceList(MockShopifyStore2.view(), '2'); }
  async setPrices(_productId: string, variants: { variantId: string; priceCents: number }[]) {
    const list = demoPriceList(MockShopifyStore2.view(), '2');
    for (const v of variants) { const e = list.find((x) => x.variantId === v.variantId); if (e) demoPrices.set(e.inventoryItemId, { ...demoPriceOf(e.inventoryItemId, list.indexOf(e)), priceCents: v.priceCents }); }
  }
  async setUnitCost(inventoryItemId: string, costCents: number | null) {
    const list = demoPriceList(MockShopifyStore2.view(), '2');
    const i = list.findIndex((x) => x.inventoryItemId === inventoryItemId);
    if (i >= 0) demoPrices.set(inventoryItemId, { ...demoPriceOf(inventoryItemId, i), costCents });
  }
  async orderWho(orderIds: string[]) { return demoWho(orderIds); }
  async productVariants(productIds: string[]) { return demoProductVariants(MockShopifyStore2.view(), '2', productIds); }
  async addVariants(productId: string, variants: ShopifyNewVariant[]) { return demoAddVariants(MockShopifyStore2.catalog, MockShopifyStore2.stock, '2', productId, variants); }
  async moveOptionValueFirst(productId: string, option: string, value: string) { MockShopifyService.firstValues.push({ productId, option, value }); }
  async setAvailable(_loc: string, quantities: ShopifySetQuantity[], key: string) {
    if (MockShopifyStore2.applied.has(key)) return;
    for (const q of quantities) if (q.changeFromQuantity != null && (MockShopifyStore2.stock.get(q.inventoryItemId) ?? 0) !== q.changeFromQuantity) throw new ShopifyStaleQuantityError();
    MockShopifyStore2.applied.add(key);
    for (const q of quantities) MockShopifyStore2.stock.set(q.inventoryItemId, q.quantity);
  }
  async listOrderLines(updatedSince: Date) {
    const out: ShopifyOrderLine[] = [];
    for (let d = new Date(Math.max(updatedSince.getTime(), Date.now() - 60 * 86400_000)); d.getTime() < Date.now(); d = new Date(d.getTime() + 86400_000)) {
      const day = d.toISOString().slice(0, 10);
      if (Number(day.slice(8)) % 3) continue;
      out.push({ orderId: `pro-${day}`, lineId: '1', inventoryItemId: 'gid://shopify/InventoryItem/201', sku: 'HTW-20-60', quantity: 1, unitPriceCents: 3500, orderedAt: `${day}T18:00:00Z`, cancelled: false });
    }
    return out;
  }
}
MockShopifyStore2.reset();
