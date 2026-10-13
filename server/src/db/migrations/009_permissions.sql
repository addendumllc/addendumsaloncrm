-- Roles and permissions: four role templates (Admin, Reception, Stylist, Assistant), per-person overrides,
-- password reset links. Existing employees keep their roles; only NEW accounts default to Assistant.

ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_role_check;
ALTER TABLE staff ADD CONSTRAINT staff_role_check CHECK (role IN ('admin','receptionist','stylist','assistant'));
ALTER TABLE staff ALTER COLUMN role SET DEFAULT 'assistant';
ALTER TABLE staff ADD COLUMN last_login_at TIMESTAMPTZ;
ALTER TABLE staff ADD COLUMN deactivated_at TIMESTAMPTZ;

-- Role templates. Filled from the built-in defaults at start-up; `known_permissions` records which permissions a
-- template has already been offered, so new features get their defaults while an admin's edits are kept.
CREATE TABLE role_templates (
  role TEXT PRIMARY KEY CHECK (role IN ('admin','receptionist','stylist','assistant')),
  known_permissions TEXT[] NOT NULL DEFAULT '{}',
  updated_by_staff_id UUID,                          -- no foreign key, so clearing staff never clears the templates
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role TEXT NOT NULL REFERENCES role_templates(role) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);

-- Individual overrides: granted = true adds a permission for this person, false removes it. Independent of others.
CREATE TABLE staff_permission_overrides (
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted BOOLEAN NOT NULL,
  set_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, permission)
);

-- One-time links to set or reset a password (token itself never stored, only its SHA-256).
CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('invite','reset')),
  created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX password_reset_tokens_staff_idx ON password_reset_tokens(staff_id);
