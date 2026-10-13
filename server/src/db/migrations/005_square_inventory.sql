-- Square is the source of truth for retail inventory. This is a searchable local copy of the Square
-- catalog's retail variations and their in-stock counts, refreshed with the Square sync.
-- Admins can push these quantities to Shopify by hand; the last push is recorded per variation.

CREATE TABLE square_inventory (
  variation_id TEXT PRIMARY KEY,                 -- Square ITEM_VARIATION id
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  variation_name TEXT,
  sku TEXT,
  upc TEXT,
  price_cents INT,
  track_inventory BOOLEAN NOT NULL DEFAULT true,
  quantity NUMERIC,                              -- total IN_STOCK across locations; NULL if not tracked / never counted
  quantities JSONB NOT NULL DEFAULT '{}'::jsonb, -- { locationId: quantity }
  search_text TEXT NOT NULL DEFAULT '',          -- lowercased name + variation + SKU + UPC
  shopify_pushed_at TIMESTAMPTZ,
  shopify_pushed_quantity NUMERIC,
  shopify_push_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX square_inventory_sku_idx ON square_inventory(lower(sku));
CREATE INDEX square_inventory_name_idx ON square_inventory(lower(item_name));
