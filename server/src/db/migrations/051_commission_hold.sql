-- On hold: credited to someone, but not counted in their pay until confirmed in Needs review (e.g. a service several
-- stylists worked on, split evenly for now; a product-only sale, given to whoever checked out).
ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS on_hold BOOLEAN NOT NULL DEFAULT false;
