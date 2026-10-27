-- Content Studio: generated copy saved for reuse (e.g. an SMS attached to a follow-up).
CREATE TABLE IF NOT EXISTS content_studio_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  format TEXT NOT NULL,
  service TEXT NOT NULL,
  goal TEXT NOT NULL,
  length TEXT,
  notes JSONB NOT NULL DEFAULT '{}',
  result JSONB NOT NULL,
  created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
