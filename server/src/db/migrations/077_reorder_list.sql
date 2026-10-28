-- Reorder List (Addendum Hair): each product's usual ordering preferences, and supplier-level order minimums.
CREATE TABLE IF NOT EXISTS reorder_prefs (
  product_key TEXT PRIMARY KEY,
  typical_qty INTEGER CHECK (typical_qty IS NULL OR typical_qty > 0),
  preferred_plan TEXT CHECK (preferred_plan IS NULL OR preferred_plan IN ('normal','30','60','90')),
  safety_units INTEGER CHECK (safety_units IS NULL OR safety_units >= 0),
  notes TEXT,
  updated_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS min_order_cents INTEGER CHECK (min_order_cents IS NULL OR min_order_cents > 0);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS min_order_units INTEGER CHECK (min_order_units IS NULL OR min_order_units > 0);
