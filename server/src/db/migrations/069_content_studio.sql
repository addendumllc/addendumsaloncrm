-- Content calendar, full workflow: Idea → Draft → In Review → Changes Requested → Approved → Scheduled → Published,
-- with creator / reviewer / publisher, campaigns, comments and history, the ideas library, an asset library and metrics.
ALTER TABLE content_posts DROP CONSTRAINT IF EXISTS content_posts_status_check;
ALTER TABLE content_posts DROP CONSTRAINT IF EXISTS content_posts_post_type_check;
UPDATE content_posts SET status = 'approved' WHERE status = 'ready';
UPDATE content_posts SET status = 'published' WHERE status = 'posted';
ALTER TABLE content_posts ADD CONSTRAINT content_posts_status_check CHECK (status IN ('idea','draft','in_review','changes_requested','approved','scheduled','publishing','published','failed'));
ALTER TABLE content_posts ADD CONSTRAINT content_posts_post_type_check CHECK (post_type IN ('feed','carousel','reel','story','video','pin','email','promo'));
ALTER TABLE content_posts
  ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS headline TEXT,
  ADD COLUMN IF NOT EXISTS cta TEXT,
  ADD COLUMN IF NOT EXISTS hashtags TEXT,
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'instagram',
  ADD COLUMN IF NOT EXISTS pillar TEXT,
  ADD COLUMN IF NOT EXISTS campaign_id UUID,
  ADD COLUMN IF NOT EXISTS group_id UUID,
  ADD COLUMN IF NOT EXISTS source_post_id UUID REFERENCES content_posts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS idea_id UUID,
  ADD COLUMN IF NOT EXISTS reviewer_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS publisher_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_links TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS metrics JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS metrics_source TEXT,
  ADD COLUMN IF NOT EXISTS metrics_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
UPDATE content_posts SET title = left(coalesce(nullif(split_part(caption, E'\n', 1), ''), 'Untitled post'), 120) WHERE title = '';

CREATE TABLE IF NOT EXISTS content_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  accounts TEXT[] NOT NULL DEFAULT '{}',
  starts_on DATE,
  ends_on DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Comments, status changes and revisions on a post (its approval history).
CREATE TABLE IF NOT EXISTS content_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES content_posts(id) ON DELETE CASCADE,
  staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('comment','status','revision')),
  body TEXT,
  from_status TEXT,
  to_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_comments_post ON content_comments (post_id, created_at);

-- The post ideas library (built-in suggestions and the team's own).
CREATE TABLE IF NOT EXISTS content_ideas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE,
  accounts TEXT[] NOT NULL DEFAULT '{}',
  title TEXT NOT NULL,
  pillar TEXT NOT NULL,
  audience TEXT,
  platform TEXT NOT NULL DEFAULT 'instagram',
  format TEXT NOT NULL DEFAULT 'feed',
  hook TEXT, visual TEXT, shot_list TEXT, caption TEXT, cta TEXT, hashtags TEXT, season TEXT,
  effort TEXT NOT NULL DEFAULT 'medium' CHECK (effort IN ('low','medium','high')),
  builtin BOOLEAN NOT NULL DEFAULT false,
  created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS content_idea_favorites (
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  idea_id UUID NOT NULL REFERENCES content_ideas(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, idea_id)
);

-- The asset library: every uploaded file, with a title, tags, an account restriction and "approved to reuse".
ALTER TABLE content_media
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS account TEXT,
  ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT false;
