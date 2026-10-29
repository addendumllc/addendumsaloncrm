-- Content Calendar sharing with creators (people without CRM accounts):
--  each post's sharing — auto (shared once approved), yes (always), no (never);
--  share links (a private link per creator, limited to accounts, can expire or be turned off);
--  notes creators leave on a post (comments with their name instead of a staff member).
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS creator_share TEXT NOT NULL DEFAULT 'auto' CHECK (creator_share IN ('auto','yes','no'));
ALTER TABLE content_comments ADD COLUMN IF NOT EXISTS author_name TEXT;
CREATE TABLE IF NOT EXISTS content_share_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  accounts TEXT[] NOT NULL DEFAULT '{}',
  expires_on DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  allow_notes BOOLEAN NOT NULL DEFAULT true,
  created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_viewed_at TIMESTAMPTZ
);
