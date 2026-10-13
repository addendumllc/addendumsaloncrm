-- API keys and secrets entered by an administrator in Settings → API & Integrations.
-- Values are AES-256-GCM encrypted with ENCRYPTION_KEY (never stored or returned in plain text).
-- Saved values take precedence over the matching environment variables.

CREATE TABLE integration_credentials (
  provider TEXT PRIMARY KEY,                       -- square | shopify | highlevel | email | ai
  encrypted_values TEXT,                           -- encrypted JSON { ENV_KEY: value }; NULL when nothing is saved
  saved_keys TEXT[] NOT NULL DEFAULT '{}',         -- which keys are saved (names only, for the status screen)
  updated_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_test_at TIMESTAMPTZ,
  last_test_ok BOOLEAN,
  last_test_message TEXT,                          -- friendly text only; never contains a secret
  last_success_at TIMESTAMPTZ
);
