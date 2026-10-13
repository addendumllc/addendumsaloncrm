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
  static sets: ShopifySetQuantity[][] = [];
  /** Test hook: make the next pushes fail. */
  static failNext: Error | null = null;
  /** Test hook: runs just before a write (e.g. to simulate a sale landing mid-sync). */
  static onBeforeSet: (() => void) | null = null;

  static reset() {
    this.stock = new Map(this.catalog.map((c) => [c.inventoryItemId, 50]));
    this.applied = new Set();
    this.sets = [];
    this.failNext = null;
    this.onBeforeSet = null;
  }

  async testConnection() {
    return { shopName: 'Addendum Hair (demo)', locationName: 'Demo warehouse' };
  }

  async locationId() {
    return 'gid://shopify/Location/1';
  }

  async findBySkus(skus: string[]) {
    const want = new Set(skus.map((s) => s.toLowerCase()));
    return MockShopifyService.catalog.filter((c) => want.has(c.sku.toLowerCase()));
  }

  async listInventory() {
    return MockShopifyService.catalog.map((c) => ({ ...c, available: c.tracked ? MockShopifyService.stock.get(c.inventoryItemId) ?? 0 : null }));
  }

  async accessScopes() {
    return ['read_products', 'read_inventory', 'write_inventory', 'read_locations'];
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
