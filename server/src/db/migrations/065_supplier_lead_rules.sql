-- Lead-time rules per supplier: a whole collection's production (and optional shipping) time. Product-specific times
-- stay on each product (stock_products); the supplier's own default stays on the supplier. A collection is referred to
-- by a stable reference: "shopify:<collection id>", "internal:<inventory collection>", or "name:<store collection>".
CREATE TABLE supplier_lead_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier TEXT NOT NULL,
  ref TEXT NOT NULL,
  label TEXT NOT NULL,
  production_days INTEGER NOT NULL CHECK (production_days >= 0 AND production_days <= 730),
  shipping_days INTEGER CHECK (shipping_days IS NULL OR (shipping_days >= 0 AND shipping_days <= 365)),
  active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (supplier, ref)
);
