-- My Content: each stylist's own, private Instagram plan (only they can see it).
CREATE TABLE IF NOT EXISTS personal_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  post_date DATE,
  post_time TEXT,
  format TEXT NOT NULL DEFAULT 'post' CHECK (format IN ('post','reel','story','carousel')),
  status TEXT NOT NULL DEFAULT 'idea' CHECK (status IN ('idea','draft','ready','posted')),
  title TEXT NOT NULL DEFAULT '',
  caption TEXT,
  hashtags TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS personal_posts_staff_date ON personal_posts (staff_id, post_date);
-- Photos and videos: their own uploads (stored like transformation photos), or one of their transformation photos.
CREATE TABLE IF NOT EXISTS personal_post_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES personal_posts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  transformation_media_id UUID REFERENCES transformation_media(id) ON DELETE CASCADE,
  file_path TEXT,
  thumb_path TEXT,
  mime TEXT,
  size INTEGER,
  sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS personal_post_media_post ON personal_post_media (post_id, position);
