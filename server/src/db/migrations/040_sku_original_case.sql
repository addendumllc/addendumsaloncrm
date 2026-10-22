-- Paired products' SKUs were saved in lowercase. Restore Square's own spelling where the local Square copy has it
-- (the rest are corrected by the next inventory sync).
UPDATE inventory_sync_links l
   SET sku = trim(s.sku), updated_at = now()
  FROM square_inventory s
 WHERE s.variation_id = l.square_variation_id
   AND s.sku IS NOT NULL
   AND lower(trim(s.sku)) = l.sku
   AND trim(s.sku) <> l.sku;
