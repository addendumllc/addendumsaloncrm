-- A second Shopify store that sells from the same stock with the same SKUs (it may list a SKU more than once, at
-- different prices). Each of its products with a synced SKU is tracked here: its count when it was last set to match,
-- so its own sales since then are added to the shared count.
CREATE TABLE inventory_sync_extra (
  inventory_item_id TEXT PRIMARY KEY,
  store TEXT NOT NULL DEFAULT 'shopify2',
  sku TEXT,
  label TEXT,
  synced_baseline INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sales lines from either Shopify store.
ALTER TABLE shopify_order_lines ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'shopify';
ALTER TABLE shopify_order_lines DROP CONSTRAINT IF EXISTS shopify_order_lines_pkey;
ALTER TABLE shopify_order_lines ADD PRIMARY KEY (store, order_id, line_id);
