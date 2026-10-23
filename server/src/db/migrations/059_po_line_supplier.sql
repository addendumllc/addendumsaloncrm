-- An order can be for several suppliers (e.g. one company's product lines with different lead times): each item keeps
-- the supplier it came from, and the order's supplier lists them all ("AH - 18in + AH - 22in").
ALTER TABLE purchase_order_lines ADD COLUMN supplier TEXT;
