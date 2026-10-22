-- A name for each purchase order (shown in place of "PO #12"; the number stays alongside).
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS name TEXT;
