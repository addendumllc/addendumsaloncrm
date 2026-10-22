-- Shopify sales in dollars too (Analytics → Product sales): the price paid per unit after line discounts.
ALTER TABLE shopify_order_lines ADD COLUMN IF NOT EXISTS unit_price_cents INTEGER;
-- Read Shopify's orders again from the start once, so earlier lines get their prices.
DELETE FROM settings WHERE key = 'stock.shopify-sales';
