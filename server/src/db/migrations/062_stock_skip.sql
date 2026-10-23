-- To order → Skip: a product you're not going to order, left out of suggestions and alerts until this date
-- (9999-12-31 = until turned back on).
ALTER TABLE stock_products ADD COLUMN skip_until DATE;
