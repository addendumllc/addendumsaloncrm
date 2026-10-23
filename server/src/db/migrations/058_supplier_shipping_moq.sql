-- Suppliers: shipping time (days in transit, on top of the lead time) and a default minimum order for their products.
ALTER TABLE suppliers ADD COLUMN shipping_days INTEGER CHECK (shipping_days IS NULL OR shipping_days >= 0);
ALTER TABLE suppliers ADD COLUMN default_moq INTEGER CHECK (default_moq IS NULL OR default_moq > 0);
