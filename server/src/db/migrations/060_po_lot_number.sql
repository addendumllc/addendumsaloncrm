-- One lot number per purchase order (usually the same for every item); each item keeps a small note.
ALTER TABLE purchase_orders ADD COLUMN lot_number TEXT;
-- Orders whose items all had the same lot: it becomes the order's lot, and the items' copies are cleared.
UPDATE purchase_orders p SET lot_number = x.lot
  FROM (SELECT po_id, min(lot_note) AS lot FROM purchase_order_lines GROUP BY po_id
         HAVING count(*) = count(lot_note) AND count(DISTINCT lot_note) = 1) x
 WHERE x.po_id = p.id;
UPDATE purchase_order_lines l SET lot_note = NULL FROM purchase_orders p WHERE p.id = l.po_id AND p.lot_number IS NOT NULL AND l.lot_note = p.lot_number;
