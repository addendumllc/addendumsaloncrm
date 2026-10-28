-- Content Calendar assets the salon shares with stylists (My Content → Salon downloads), as a post or a story.
ALTER TABLE content_media ADD COLUMN IF NOT EXISTS stylist_share TEXT CHECK (stylist_share IS NULL OR stylist_share IN ('post','story'));
