-- Purchasing details per product (one supplier can supply many products, each with its own timing):
-- transit/shipping days (else the supplier's), the supplier's own SKU, an ordering note, and a purchasing collection
-- (the group it's ordered in — overrides the store collections for To order, suggested orders and reports).
ALTER TABLE stock_products ADD COLUMN shipping_days INTEGER CHECK (shipping_days IS NULL OR shipping_days >= 0);
ALTER TABLE stock_products ADD COLUMN supplier_sku TEXT;
ALTER TABLE stock_products ADD COLUMN order_note TEXT;
ALTER TABLE stock_products ADD COLUMN collection TEXT;
