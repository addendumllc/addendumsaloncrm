-- The product title on each Shopify sale line, so sales under an old SKU or a replaced listing can be matched to the
-- current product by name in Analytics. Clearing the "last read" marks makes the next refresh re-read past orders (≈400
-- days) to fill in titles for existing lines.
ALTER TABLE shopify_order_lines ADD COLUMN IF NOT EXISTS title TEXT;
DELETE FROM settings WHERE key IN ('stock.shopify-sales', 'stock.shopify-sales-2');
