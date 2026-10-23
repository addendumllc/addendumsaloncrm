-- Suppliers whose lead time isn't tracked (e.g. bought as needed): reorder timing leaves lead time out for their products.
ALTER TABLE suppliers ADD COLUMN lead_untracked BOOLEAN NOT NULL DEFAULT false;
