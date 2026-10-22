-- Optional "For Customer" on a hair order (free text: who the hair is for).
ALTER TABLE inventory_requests ADD COLUMN customer_name TEXT;
