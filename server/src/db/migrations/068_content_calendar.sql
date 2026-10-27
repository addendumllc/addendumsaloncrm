-- Content calendar (Instagram): planned posts per account, their photos/videos, and what auto-posting did.
CREATE TABLE IF NOT EXISTS content_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mime TEXT NOT NULL,
  name TEXT,
  bytes BYTEA NOT NULL,
  size INTEGER NOT NULL,
  created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS content_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account TEXT NOT NULL,
  post_type TEXT NOT NULL DEFAULT 'feed' CHECK (post_type IN ('feed','reel','story','carousel')),
  scheduled_at TIMESTAMPTZ,
  caption TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idea' CHECK (status IN ('idea','draft','ready','scheduled','publishing','posted','failed')),
  auto_post BOOLEAN NOT NULL DEFAULT false,
  media_ids UUID[] NOT NULL DEFAULT '{}',
  link_kind TEXT CHECK (link_kind IN ('product','service')),
  link_ref TEXT,
  link_label TEXT,
  assigned_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  notes TEXT,
  ig_container_ids TEXT[] NOT NULL DEFAULT '{}',
  ig_media_id TEXT,
  permalink TEXT,
  posted_at TIMESTAMPTZ,
  error TEXT,
  reminded_day_before BOOLEAN NOT NULL DEFAULT false,
  reminded_today BOOLEAN NOT NULL DEFAULT false,
  created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_posts_when ON content_posts (scheduled_at);
