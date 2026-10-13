-- Order Hair: each item is described by Size, Color and Collection with its own Needed By date, and can
-- optionally be removed from Shopify inventory when the order is marked Ordered. Urgency is no longer used
-- (the column stays so older rows remain valid, but nothing reads or writes it).

ALTER TABLE inventory_request_items
  ADD COLUMN size TEXT,
  ADD COLUMN color TEXT,
  ADD COLUMN collection TEXT,
  ADD COLUMN needed_by DATE,
  -- Shopify inventory: off (leave Shopify alone) → pending (deduct when ordered) → in_progress → deducted | failed
  ADD COLUMN shopify_deduct BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN shopify_status TEXT NOT NULL DEFAULT 'off' CHECK (shopify_status IN ('off','pending','in_progress','deducted','failed')),
  ADD COLUMN shopify_variant_id TEXT,
  ADD COLUMN shopify_inventory_item_id TEXT,
  ADD COLUMN shopify_location_id TEXT,
  ADD COLUMN shopify_variant_label TEXT,
  ADD COLUMN shopify_idempotency_key TEXT,
  ADD COLUMN shopify_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN shopify_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN shopify_deducted_quantity INT,
  ADD COLUMN shopify_deducted_at TIMESTAMPTZ,
  ADD COLUMN shopify_error TEXT;

-- Existing items: the product name becomes the Collection, and they inherit the request's needed-by date.
UPDATE inventory_request_items i SET collection = i.product, needed_by = r.needed_by
  FROM inventory_requests r WHERE r.id = i.request_id;

CREATE INDEX inventory_request_items_shopify_idx ON inventory_request_items(shopify_status) WHERE shopify_status IN ('pending','in_progress','failed');
