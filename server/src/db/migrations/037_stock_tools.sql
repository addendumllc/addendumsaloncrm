-- Inventory tools (from Addendum-Stockline), kept beside the Square ↔ Shopify sync.
-- A product is keyed by its Square variation id, or 'shopify:<inventory item id>' when it's only in Shopify.

-- Ordering details per product (kept in the CRM only; never sent to Square or Shopify).
CREATE TABLE stock_products (
  product_key TEXT PRIMARY KEY,
  supplier TEXT,
  cost_cents INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0),
  lead_time_days INTEGER CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 730),
  safety_days INTEGER CHECK (safety_days IS NULL OR safety_days BETWEEN 0 AND 365),
  moq INTEGER CHECK (moq IS NULL OR moq >= 0),
  case_size INTEGER CHECK (case_size IS NULL OR case_size >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','discontinued','not_tracked')),
  updated_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every stock change made here (counts, adjustments, imports, receiving) and by the sync: who, why, before → after.
CREATE TABLE stock_txns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_key TEXT NOT NULL,
  label TEXT NOT NULL,
  sku TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('count','adjust','import','receive','sku','sync')),
  reason TEXT,
  note TEXT,
  square_before NUMERIC,
  square_after NUMERIC,
  shopify_before INTEGER,
  shopify_after INTEGER,
  old_sku TEXT,
  new_sku TEXT,
  staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_txns_product_idx ON stock_txns(product_key, created_at DESC);
CREATE INDEX stock_txns_created_idx ON stock_txns(created_at DESC);

-- Shopify sales (units per line) for forecasts. Square sales come from the orders the commission sync keeps.
CREATE TABLE shopify_order_lines (
  order_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  inventory_item_id TEXT,
  sku TEXT,
  quantity INTEGER NOT NULL,
  ordered_at TIMESTAMPTZ NOT NULL,
  cancelled BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (order_id, line_id)
);
CREATE INDEX shopify_order_lines_item_idx ON shopify_order_lines(inventory_item_id, ordered_at);

CREATE TABLE purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number SERIAL UNIQUE,
  supplier TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','shipped','received','cancelled')),
  expected_on DATE,
  note TEXT,
  created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  ordered_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_key TEXT NOT NULL,
  label TEXT NOT NULL,
  sku TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  received INTEGER NOT NULL DEFAULT 0 CHECK (received >= 0),
  cost_cents INTEGER
);
CREATE INDEX purchase_order_lines_po_idx ON purchase_order_lines(po_id);
