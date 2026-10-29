-- Hourly pay can be left out for someone (their wage and hours stay saved; turn it back on any time).
ALTER TABLE staff ADD COLUMN hourly_off BOOLEAN NOT NULL DEFAULT false;
