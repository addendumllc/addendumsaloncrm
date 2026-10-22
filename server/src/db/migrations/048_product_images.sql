-- Each Square product's photo (from its listing), shown beside it in Inventory.
ALTER TABLE square_inventory ADD COLUMN IF NOT EXISTS image_url TEXT;
