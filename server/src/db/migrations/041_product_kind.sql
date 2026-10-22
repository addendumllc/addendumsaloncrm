-- What each Square product is, so the sync and stock tools treat it right:
--   shared     – the same stock is sold online: kept in sync with Shopify
--   separate   – also sold online, but the salon floor is counted on its own: never synced
--   salon_only – sold in the salon only
--   service    – an add-on service (no stock): left out of inventory lists
-- Kept apart from square_inventory (rebuilt from Square) so the choice survives refreshes.
CREATE TABLE product_kind (
  square_variation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('shared', 'separate', 'salon_only', 'service')),
  updated_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
