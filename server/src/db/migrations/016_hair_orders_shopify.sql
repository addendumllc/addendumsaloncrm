-- Order Hair takes the chosen products out of Shopify stock (Shopify is the source of truth for hair inventory).
-- submission_id: one form submission = one order, however many times it's sent (double clicks, retries).
-- inventory_status: 'none' (nothing picked from inventory) → 'reserving' (recorded, Shopify being updated) → 'reserved'.
ALTER TABLE inventory_requests ADD COLUMN submission_id TEXT UNIQUE;
ALTER TABLE inventory_requests ADD COLUMN inventory_status TEXT NOT NULL DEFAULT 'none' CHECK (inventory_status IN ('none','reserving','reserved'));
ALTER TABLE inventory_requests ADD COLUMN inventory_reserved_at TIMESTAMPTZ;
ALTER TABLE inventory_requests ADD COLUMN shopify_location_id TEXT;

-- Items picked from Shopify: the SKU, plus the exact stock change made (so a retry repeats it with the same idempotency
-- key and is applied once). The variant's inventory item and name use the existing shopify_inventory_item_id and
-- shopify_variant_label columns (from 003).
ALTER TABLE inventory_request_items ADD COLUMN sku TEXT;
ALTER TABLE inventory_request_items ADD COLUMN stock_before INTEGER;
ALTER TABLE inventory_request_items ADD COLUMN stock_after INTEGER;
