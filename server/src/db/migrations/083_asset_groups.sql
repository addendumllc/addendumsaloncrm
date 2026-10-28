-- Content Calendar assets organised by type of post (post / story / reel / carousel) and an optional group (a carousel
-- set, a campaign…).
ALTER TABLE content_media ADD COLUMN IF NOT EXISTS post_type TEXT CHECK (post_type IS NULL OR post_type IN ('post','story','reel','carousel'));
ALTER TABLE content_media ADD COLUMN IF NOT EXISTS group_name TEXT;
