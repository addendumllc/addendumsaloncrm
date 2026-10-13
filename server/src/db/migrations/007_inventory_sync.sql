-- Two-way product stock sync between Square and Shopify. Products and stock quantities only:
-- customers, appointments, services and bookings are never part of it.

-- One row per product that exists in both systems (matched by SKU, or linked by hand). Nothing is ever created
-- in either system: unmatched products are only reported.
CREATE TABLE inventory_sync_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT,                                          -- SKU as matched (lowercased), null for hand-made links
  match_method TEXT NOT NULL DEFAULT 'sku' CHECK (match_method IN ('sku','manual')),
  label TEXT NOT NULL,
  square_variation_id TEXT NOT NULL UNIQUE,
  square_location_id TEXT NOT NULL,
  shopify_inventory_item_id TEXT NOT NULL UNIQUE,
  shopify_location_id TEXT NOT NULL,
  -- The quantity both systems agreed on after the last successful sync. Changes made on either side since then
  -- are combined; after a sync both sides equal this again, so the next run has nothing to do (no loops).
  baseline_quantity INTEGER,
  last_square_quantity NUMERIC,
  last_shopify_quantity INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_sync','needs_attention','error')),
  issue TEXT,
  last_synced_at TIMESTAMPTZ,
  last_change TEXT,                                  -- e.g. "Shopify 8 → 6 (sale in Square)"
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inventory_sync_links_status_idx ON inventory_sync_links(status);

CREATE TABLE inventory_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual','auto','retry','webhook','resolve')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','failed')),
  started_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  stage TEXT,                                        -- what it's doing now (for the progress bar)
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  updated_square INTEGER NOT NULL DEFAULT 0,
  updated_shopify INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  attention INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  details JSONB NOT NULL DEFAULT '[]'::jsonb         -- per-product results of this run (capped)
);
CREATE INDEX inventory_sync_runs_started_idx ON inventory_sync_runs(started_at DESC);
