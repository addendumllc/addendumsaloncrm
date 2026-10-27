-- Product launches: a campaign for a product's release, with promotion posts placed relative to the release date
-- (moved together when the date is set or changes).
ALTER TABLE content_campaigns ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'campaign' CHECK (kind IN ('campaign','launch'));
ALTER TABLE content_campaigns ADD COLUMN IF NOT EXISTS product TEXT;
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS launch_offset INTEGER;
