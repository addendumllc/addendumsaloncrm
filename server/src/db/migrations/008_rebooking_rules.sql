-- Rebooking schedules per service, with optional per-client overrides.
-- Defaults live with the service; a client's overrides are stored separately, so changing one client
-- never affects other clients or the service default. NULL in an override means "use the default".

CREATE TABLE service_rebooking_rules (
  service_id UUID PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  min_days INTEGER,                                  -- recommended window start (optional)
  max_days INTEGER,                                  -- recommended window end (optional)
  target_days INTEGER NOT NULL,                      -- preferred interval
  remind_before_days INTEGER NOT NULL DEFAULT 7,     -- follow-up this many days before the recommended date
  auto_follow_up BOOLEAN NOT NULL DEFAULT true,
  updated_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (target_days BETWEEN 1 AND 730),
  CHECK (min_days IS NULL OR min_days BETWEEN 1 AND target_days),
  CHECK (max_days IS NULL OR max_days BETWEEN target_days AND 730),
  CHECK (remind_before_days BETWEEN 0 AND 120)
);

CREATE TABLE client_service_rebooking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  interval_days INTEGER,                             -- this client's own interval (NULL = service default)
  preferred_next_date DATE,                          -- a date the client asked for (overrides the calculation)
  last_visit_date DATE,                              -- a visit not in Square (e.g. before Square was used)
  remind_before_days INTEGER,                        -- NULL = service default
  follow_ups_enabled BOOLEAN,                        -- NULL = service default
  note TEXT,
  updated_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, service_id),
  CHECK (interval_days IS NULL OR interval_days BETWEEN 1 AND 730),
  CHECK (remind_before_days IS NULL OR remind_before_days BETWEEN 0 AND 120)
);
CREATE INDEX client_service_rebooking_client_idx ON client_service_rebooking(client_id);

-- Rebooking follow-ups record which service and cycle they're for, and what the schedule said.
ALTER TABLE tasks ADD COLUMN service_id UUID REFERENCES services(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN rebook_last_visit DATE;
ALTER TABLE tasks ADD COLUMN rebook_due_date DATE;
ALTER TABLE tasks ADD COLUMN rebook_interval_days INTEGER;
-- rebook_source: client | service | history | preferred
ALTER TABLE tasks ADD COLUMN rebook_source TEXT;
CREATE INDEX tasks_service_idx ON tasks(client_id, service_id);

-- Suggested starting defaults are applied once per service (when it first arrives from Square), so an admin who
-- removes or edits a default never has it put back.
ALTER TABLE services ADD COLUMN rebooking_defaults_applied BOOLEAN NOT NULL DEFAULT false;
