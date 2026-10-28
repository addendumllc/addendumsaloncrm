-- Asset sets as ready-made post ideas: the caption, hashtags and notes that go with a set's photos (keyed by its name).
CREATE TABLE IF NOT EXISTS content_asset_sets (
  name TEXT PRIMARY KEY,
  caption TEXT,
  hashtags TEXT,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
