-- Which store a purchase order is for: the salon (Square) or online (the main Shopify store). Receiving adds stock to
-- that store only; for products whose stock is shared, the next sync carries it across.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'salon' CHECK (store IN ('salon', 'shopify'));
