-- Content Calendar assets: a description (what it is, what it's for).
ALTER TABLE content_media ADD COLUMN IF NOT EXISTS description TEXT;
-- …and their order within a group (a carousel's slides), set by hand; downloads follow it.
ALTER TABLE content_media ADD COLUMN IF NOT EXISTS position INTEGER;
