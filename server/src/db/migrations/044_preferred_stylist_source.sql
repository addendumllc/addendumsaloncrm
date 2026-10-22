-- Where a client's preferred stylist came from: 'auto' (from their visits, kept up to date), 'manual' (chosen by
-- someone; never changed automatically). NULL = set before this existed (replaced only by a clear visit pattern).
ALTER TABLE clients ADD COLUMN preferred_staff_source TEXT CHECK (preferred_staff_source IN ('auto', 'manual'));
