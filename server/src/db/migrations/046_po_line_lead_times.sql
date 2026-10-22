-- Products from the same supplier can take different times: each purchase order line has its own lead time, and once
-- the order is placed, its own expected arrival date (the order's expected date is the last of them).
ALTER TABLE purchase_order_lines ADD COLUMN lead_time_days INTEGER CHECK (lead_time_days BETWEEN 0 AND 730);
ALTER TABLE purchase_order_lines ADD COLUMN expected_on DATE;

-- One supplier can be the default: used for products and orders that don't name one (instead of "No supplier").
ALTER TABLE suppliers ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX suppliers_one_default ON suppliers((true)) WHERE is_default;
