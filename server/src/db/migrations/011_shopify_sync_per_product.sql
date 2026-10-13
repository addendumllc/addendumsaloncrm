-- Per-product "Sync to Shopify". One row per Square variation that someone has set; a product without a row
-- syncs (as every paired product did before this setting existed). Kept apart from square_inventory, which is
-- rebuilt from Square, so the choice survives refreshes, re-pairing and products briefly missing from Square.
CREATE TABLE product_shopify_sync (
  square_variation_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  updated_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who each Order Hair email was copied to, as actually sent.
ALTER TABLE inventory_requests ADD COLUMN email_cc TEXT;
