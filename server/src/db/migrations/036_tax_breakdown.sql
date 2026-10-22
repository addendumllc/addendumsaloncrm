-- Per person: whether My Commission → Year shows estimated taxes broken down by tax.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS show_tax_breakdown BOOLEAN NOT NULL DEFAULT true;
