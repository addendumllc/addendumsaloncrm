-- Website inquiries from Showit, read from the salon's Gmail: one row per notification email (by Gmail message id),
-- so each submission is handled once. Holds the parsed form, not the whole email.
CREATE TABLE showit_messages (
  gmail_id TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL CHECK (status IN ('processed', 'review', 'failed', 'duplicate', 'ignored')),
  kind TEXT CHECK (kind IN ('extension', 'general')),
  fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  contact JSONB NOT NULL DEFAULT '{}'::jsonb,
  page TEXT,
  content_hash TEXT,
  reason TEXT,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  resolved_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX showit_messages_hash_idx ON showit_messages(content_hash);
CREATE INDEX showit_messages_received_idx ON showit_messages(received_at DESC);
