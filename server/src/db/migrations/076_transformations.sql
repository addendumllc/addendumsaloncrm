-- Transformations Library: stylists' work with photos (files on disk, references here), services performed, extension
-- details, Instagram references, client consent / publication permissions, collections and export jobs.
CREATE SEQUENCE IF NOT EXISTS transformation_number_seq START 1;
CREATE TABLE IF NOT EXISTS transformations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number INTEGER NOT NULL DEFAULT nextval('transformation_number_seq') UNIQUE,
  title TEXT NOT NULL,
  stylist_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  service_date DATE NOT NULL,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  main_service TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  technical_notes TEXT,
  internal_notes TEXT,
  caption TEXT,
  hashtags TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transformations_date ON transformations (service_date DESC);
CREATE INDEX IF NOT EXISTS transformations_stylist ON transformations (stylist_staff_id);
CREATE TABLE IF NOT EXISTS transformation_services (
  transformation_id UUID NOT NULL REFERENCES transformations(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  PRIMARY KEY (transformation_id, service)
);
CREATE TABLE IF NOT EXISTS transformation_extensions (
  transformation_id UUID PRIMARY KEY REFERENCES transformations(id) ON DELETE CASCADE,
  has_extensions BOOLEAN NOT NULL DEFAULT true,
  method TEXT, brand TEXT, length TEXT, shade TEXT, quantity TEXT, work_type TEXT,
  blending BOOLEAN, customization TEXT, maintenance_notes TEXT, next_appointment TEXT
);
CREATE TABLE IF NOT EXISTS transformation_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transformation_id UUID NOT NULL REFERENCES transformations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'after' CHECK (kind IN ('before','after','finished','detail','other')),
  caption TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  file_path TEXT NOT NULL,
  thumb_path TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  original_name TEXT,
  uploaded_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transformation_media_t ON transformation_media (transformation_id, position);
CREATE TABLE IF NOT EXISTS transformation_instagram (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transformation_id UUID NOT NULL REFERENCES transformations(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  post_type TEXT,
  title TEXT,
  author TEXT,
  thumbnail_url TEXT,
  preview_status TEXT NOT NULL DEFAULT 'unchecked',
  is_primary BOOLEAN NOT NULL DEFAULT false,
  added_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS transformation_consent (
  transformation_id UUID PRIMARY KEY REFERENCES transformations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved_social','internal','do_not_publish')),
  client_consent TEXT NOT NULL DEFAULT 'unknown' CHECK (client_consent IN ('unknown','requested','given','declined')),
  social_permission BOOLEAN NOT NULL DEFAULT false,
  marketing_permission BOOLEAN NOT NULL DEFAULT false,
  scope TEXT,
  consent_date DATE,
  identifiable BOOLEAN,
  restrictions TEXT,
  expires_on DATE,
  verified_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS transformation_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transformation_collection_items (
  collection_id UUID NOT NULL REFERENCES transformation_collections(id) ON DELETE CASCADE,
  transformation_id UUID NOT NULL REFERENCES transformations(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, transformation_id)
);
CREATE TABLE IF NOT EXISTS transformation_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  preset TEXT NOT NULL,
  filter JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  failed JSONB NOT NULL DEFAULT '[]',
  file_path TEXT,
  size BIGINT,
  token TEXT,
  expires_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
