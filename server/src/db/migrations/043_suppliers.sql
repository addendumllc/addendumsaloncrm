-- Suppliers you can add before any product uses them, with contact details and a usual lead time.
-- Products still point at a supplier by name (stock_products.supplier); renaming updates both.
CREATE TABLE suppliers (
  name TEXT PRIMARY KEY,
  email TEXT,
  phone TEXT,
  website TEXT,
  notes TEXT,
  lead_time_days INTEGER CHECK (lead_time_days BETWEEN 0 AND 730),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Suppliers already typed on products become rows.
INSERT INTO suppliers(name) SELECT DISTINCT supplier FROM stock_products WHERE supplier IS NOT NULL ON CONFLICT DO NOTHING;
