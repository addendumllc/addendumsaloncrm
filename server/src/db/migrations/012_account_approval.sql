-- Account approval and custom role templates.
-- Existing accounts are already approved (the column default), so nobody is locked out by this change.
-- New logins (added by an administrator or requested from the sign-in screen) start as 'pending' and can't use the
-- CRM until an Admin approves them. Square-imported team members stay approved: they have no login until an admin
-- sends them a set-up link.
ALTER TABLE staff ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending','approved','rejected'));
ALTER TABLE staff ADD COLUMN self_requested BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE staff ADD COLUMN approval_requested_at TIMESTAMPTZ;
ALTER TABLE staff ADD COLUMN approved_at TIMESTAMPTZ;
ALTER TABLE staff ADD COLUMN approved_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL;
ALTER TABLE staff ADD COLUMN rejected_at TIMESTAMPTZ;
CREATE INDEX staff_approval_idx ON staff(approval_status);

-- Custom role templates: any key, with its own name and description. The four built-in ones keep their keys.
ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_role_check;
ALTER TABLE role_templates DROP CONSTRAINT IF EXISTS role_templates_role_check;
ALTER TABLE role_templates ADD COLUMN label TEXT;
ALTER TABLE role_templates ADD COLUMN description TEXT;
ALTER TABLE role_templates ADD COLUMN builtin BOOLEAN NOT NULL DEFAULT true;
