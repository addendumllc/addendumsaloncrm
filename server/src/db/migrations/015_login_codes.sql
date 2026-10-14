-- Custom sign-in codes: an alternative to the password, set by an Owner/Admin. Only an Argon2id hash is stored (never
-- the code). Guessing is limited per account (failed_attempts / locked_until) as well as per network address.
CREATE TABLE staff_login_codes (
  staff_id UUID PRIMARY KEY REFERENCES staff(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,                 -- $argon2id$… (unique salt per code)
  enabled BOOLEAN NOT NULL DEFAULT true,
  square_location_id TEXT,                 -- the Square location they work at (optional; from the synced locations)
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  lockouts INTEGER NOT NULL DEFAULT 0,      -- lock-outs in a row (each one lasts longer)
  locked_until TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  updated_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- How each session was signed in, so revoking someone's code signs out exactly the sessions it opened.
ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password';
