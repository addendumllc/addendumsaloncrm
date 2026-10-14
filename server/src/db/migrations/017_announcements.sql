-- Team announcements: separate from tasks (publishing one never creates a task for anyone). Visible to everyone, or to
-- the chosen roles; each person can mark one as read.
CREATE TABLE announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link_url TEXT,                          -- optional link or attachment (https)
  link_label TEXT,
  important BOOLEAN NOT NULL DEFAULT false,
  pinned BOOLEAN NOT NULL DEFAULT false,
  audience_roles TEXT[],                  -- NULL = the whole team; otherwise these role templates
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_at TIMESTAMPTZ,
  author_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX announcements_published_idx ON announcements(status, pinned DESC, published_at DESC);

CREATE TABLE announcement_reads (
  announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, staff_id)
);
