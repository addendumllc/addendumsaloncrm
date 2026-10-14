-- Sensitive actions (changing integration credentials) need the Owner/Admin to have confirmed their password recently.
ALTER TABLE sessions ADD COLUMN reauthenticated_at TIMESTAMPTZ;
-- An integration can be switched off without deleting its saved credentials (and switched back on).
ALTER TABLE integration_credentials ADD COLUMN disabled BOOLEAN NOT NULL DEFAULT false;
