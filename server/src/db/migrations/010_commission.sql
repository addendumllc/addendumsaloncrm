-- Stylist commission. Square doesn't calculate commission through its API, so the CRM stores the verified Square
-- sales (orders, refunds, payments) and calculates commission from the rules an administrator sets here.
-- Every commission record keeps the rate and calculation it used; finalized records are never recalculated.

-- Commission rules. A rule is never edited in place: changing a rate ends the old rule and starts a new one
-- from its effective date, so history stays accurate.
CREATE TABLE commission_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID REFERENCES staff(id) ON DELETE CASCADE,         -- NULL = everyone without their own rule
  category TEXT NOT NULL CHECK (category IN ('service','retail')),
  target_type TEXT NOT NULL DEFAULT 'all' CHECK (target_type IN ('all','service','product')),
  target_id TEXT,                                                -- services.id, or a Square product variation id
  target_name TEXT,
  method TEXT NOT NULL CHECK (method IN ('percent','flat','tiered')),
  rate_bps INTEGER CHECK (rate_bps BETWEEN 0 AND 10000),         -- percent × 100 (40% = 4000)
  flat_cents INTEGER CHECK (flat_cents >= 0),                    -- per unit sold
  tiers JSONB,                                                   -- [{ "upToCents": 500000, "rateBps": 3500 }, { "upToCents": null, "rateBps": 4500 }]
  tier_period TEXT NOT NULL DEFAULT 'month' CHECK (tier_period IN ('month','week')),
  effective_from DATE NOT NULL,
  effective_to DATE,                                             -- last day it applies; NULL = open-ended
  note TEXT,
  created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  ended_at TIMESTAMPTZ,
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK ((target_type = 'all') = (target_id IS NULL))
);
CREATE INDEX commission_rules_staff_idx ON commission_rules(staff_id);

-- Square sales as Square sent them (only what commission needs), refreshed when Square reports a change.
CREATE TABLE commission_orders (
  order_id TEXT PRIMARY KEY,
  location_id TEXT,
  customer_id TEXT,
  state TEXT,
  closed_at TIMESTAMPTZ,
  square_updated_at TIMESTAMPTZ,
  is_return BOOLEAN NOT NULL DEFAULT false,
  raw JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commission_orders_closed_idx ON commission_orders(closed_at);

CREATE TABLE commission_payments (
  payment_id TEXT PRIMARY KEY,
  order_id TEXT,
  team_member_id TEXT,
  status TEXT,
  tip_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ
);
CREATE INDEX commission_payments_order_idx ON commission_payments(order_id);

-- A person's decision about who did a sale line Square couldn't attribute (empty list = no commission).
CREATE TABLE commission_attributions (
  line_key TEXT PRIMARY KEY,                                     -- "<order id>:<line item uid>"
  staff_ids UUID[] NOT NULL DEFAULT '{}',
  note TEXT,
  set_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  set_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reviewed and accepted as-is (e.g. "no rule → $0 is right").
CREATE TABLE commission_review_accepted (
  source_key TEXT PRIMARY KEY,
  note TEXT,
  accepted_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE commission_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  note TEXT,
  totals JSONB NOT NULL DEFAULT '{}'::jsonb,                     -- snapshot per stylist at finalization
  CHECK (end_date >= start_date)
);

-- One commission record per stylist per sale line (or tip, refund, adjustment).
CREATE TABLE commission_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key TEXT NOT NULL UNIQUE,                               -- makes repeated syncs idempotent (no duplicates)
  staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,         -- NULL while waiting for review
  kind TEXT NOT NULL CHECK (kind IN ('sale','refund','tip','adjustment')),
  category TEXT NOT NULL CHECK (category IN ('service','retail','tip','other')),
  status TEXT NOT NULL DEFAULT 'estimated' CHECK (status IN ('estimated','finalized','void')),
  square_order_id TEXT,
  square_line_item_uid TEXT,
  square_payment_ids TEXT[] NOT NULL DEFAULT '{}',
  source_order_id TEXT,                                          -- refunds: the original sale
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,
  catalog_object_id TEXT,
  item_name TEXT NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 1,
  share NUMERIC NOT NULL DEFAULT 1,                              -- split between providers (0.5 = half)
  transaction_at TIMESTAMPTZ NOT NULL,
  transaction_date DATE NOT NULL,
  service_date DATE,
  posted_date DATE NOT NULL,                                     -- the date it counts on (moves forward if that period was finalized)
  gross_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  eligible_cents INTEGER NOT NULL DEFAULT 0,                     -- what the rate is applied to
  net_sales_cents INTEGER NOT NULL DEFAULT 0,                    -- attributed sales after discounts (negative for refunds)
  tip_cents INTEGER NOT NULL DEFAULT 0,
  rule_id UUID REFERENCES commission_rules(id) ON DELETE SET NULL,
  method TEXT,
  rate_bps INTEGER,
  flat_cents INTEGER,
  commission_cents INTEGER NOT NULL DEFAULT 0,
  calc JSONB NOT NULL DEFAULT '{}'::jsonb,                       -- { steps: [...], rule: "...", basis: "..." }
  attribution TEXT,                                              -- booking | booking_single | payment | manual | split
  needs_review BOOLEAN NOT NULL DEFAULT false,
  review_reason TEXT,
  note TEXT,
  period_id UUID REFERENCES commission_periods(id) ON DELETE SET NULL,
  finalized_at TIMESTAMPTZ,
  finalized_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commission_entries_staff_date_idx ON commission_entries(staff_id, posted_date);
CREATE INDEX commission_entries_review_idx ON commission_entries(needs_review) WHERE needs_review;
CREATE INDEX commission_entries_order_idx ON commission_entries(square_order_id);

-- History of every commission record: created, recalculated (while estimated), finalized, voided, adjusted.
CREATE TABLE commission_entry_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL REFERENCES commission_entries(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commission_entry_events_entry_idx ON commission_entry_events(entry_id);

CREATE TABLE commission_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual','auto','rebuild')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed')),
  started_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  orders_seen INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  voided INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  message TEXT
);
CREATE INDEX commission_sync_runs_started_idx ON commission_sync_runs(started_at DESC);
