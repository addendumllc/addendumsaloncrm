-- Hybrid installs: each method and colour used (e.g. weft in #60 and K-tip in #18).
ALTER TABLE transformation_extensions ADD COLUMN IF NOT EXISTS parts JSONB NOT NULL DEFAULT '[]';
