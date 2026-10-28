-- Transformations to confirm: each stylist's finished appointments become suggestions (confirm with photos and notes,
-- or "no photos" to skip). A transformation remembers the appointment it came from.
ALTER TABLE transformations ADD COLUMN IF NOT EXISTS appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS transformations_appointment ON transformations (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS transformation_skips (
  appointment_id UUID PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
  staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  skipped_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
