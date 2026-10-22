-- Products kept in one store only: never paired by SKU and left out of "Not matched". Pairing one by hand removes its mark.
CREATE TABLE inventory_sync_separate (
  store TEXT NOT NULL CHECK (store IN ('square','shopify')),
  item_id TEXT NOT NULL,                  -- Square variation ID / Shopify inventory item ID
  label TEXT NOT NULL DEFAULT '',
  sku TEXT,
  marked_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store, item_id)
);
