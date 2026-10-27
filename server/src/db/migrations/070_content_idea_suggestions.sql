-- Ideas drafted each week (kept only when saved) and Reel ideas that also work as Stories.
ALTER TABLE content_ideas
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'library' CHECK (status IN ('library','suggested')),
  ADD COLUMN IF NOT EXISTS suggested_on DATE,
  ADD COLUMN IF NOT EXISTS also_story BOOLEAN NOT NULL DEFAULT false;
