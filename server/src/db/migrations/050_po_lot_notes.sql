-- A lot number (or any note) on each purchase order item — editable any time, including after it's received.
ALTER TABLE purchase_order_lines ADD COLUMN IF NOT EXISTS lot_note TEXT;
