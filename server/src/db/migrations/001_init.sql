-- Addendum Salon CRM — initial schema (PostgreSQL 14+; also runs on embedded PGlite for demo/dev).
-- Conventions: UUID primary keys, created_at/updated_at on every mutable table,
-- external IDs (square_*, highlevel_*) are unique where they identify one record.

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Staff doubles as the login/users table: every login is a staff member; stylists
-- who never log in simply have no password.
CREATE TABLE staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner','manager','staff')),
  active BOOLEAN NOT NULL DEFAULT true,
  color TEXT NOT NULL DEFAULT '#9A8478',
  square_team_member_id TEXT UNIQUE,
  highlevel_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- SHA-256 of the random session token (token itself never stored)
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  user_agent TEXT
);
CREATE INDEX sessions_staff_idx ON sessions(staff_id);

CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  square_location_id TEXT UNIQUE,
  name TEXT NOT NULL,
  address TEXT,
  timezone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Services come from the Square catalog (appointment services). One row per service variation.
CREATE TABLE services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  square_variation_id TEXT UNIQUE,
  square_item_id TEXT,
  name TEXT NOT NULL,
  category TEXT,
  duration_minutes INTEGER,
  price_cents INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT,                         -- E.164
  email TEXT,
  birthday TEXT,                      -- Square format YYYY-MM-DD or 0000-MM-DD (year unknown)
  square_customer_id TEXT UNIQUE,
  highlevel_contact_id TEXT,
  preferred_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  lead_source TEXT,
  sms_opted_out BOOLEAN NOT NULL DEFAULT false,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX clients_phone_idx ON clients(phone);
CREATE INDEX clients_email_idx ON clients(lower(email));
CREATE INDEX clients_name_idx ON clients(lower(first_name || ' ' || last_name));

CREATE TABLE client_staff (
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  PRIMARY KEY (client_id, staff_id)
);

CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  source TEXT,
  service_interest TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  assigned_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  last_contact_at TIMESTAMPTZ,
  last_inbound_at TIMESTAMPTZ,
  next_follow_up_at TIMESTAMPTZ,
  notes TEXT,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,   -- set when converted / booked
  highlevel_contact_id TEXT,
  sms_opted_out BOOLEAN NOT NULL DEFAULT false,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX leads_status_idx ON leads(status);
CREATE INDEX leads_phone_idx ON leads(phone);

-- Square appointments. Square is the source of truth: these rows are only written by the sync.
-- Internal follow-ups live in `tasks` and are never stored here.
CREATE TABLE appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  square_booking_id TEXT NOT NULL UNIQUE,
  square_version INTEGER,
  source TEXT NOT NULL DEFAULT 'square' CHECK (source IN ('square','demo')),
  square_customer_id TEXT,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  square_status TEXT NOT NULL,
  customer_note TEXT,
  seller_note TEXT,
  booked_value_cents INTEGER,
  rescheduled_from TIMESTAMPTZ,
  client_confirmed_at TIMESTAMPTZ,
  square_created_at TIMESTAMPTZ,
  square_updated_at TIMESTAMPTZ,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX appointments_start_idx ON appointments(start_at);
CREATE INDEX appointments_client_idx ON appointments(client_id, start_at);
CREATE INDEX appointments_staff_idx ON appointments(staff_id, start_at);

CREATE TABLE appointment_services (
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,
  service_name TEXT NOT NULL,
  duration_minutes INTEGER,
  PRIMARY KEY (appointment_id, position)
);

-- Change log produced by the sync (new / cancelled / rescheduled / no-show / completed).
CREATE TABLE appointment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX appointment_events_appt_idx ON appointment_events(appointment_id);

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL UNIQUE,         -- E.164 of the client/lead
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  last_inbound_at TIMESTAMPTZ,
  insight JSONB,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conversations_last_idx ON conversations(last_message_at DESC);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT UNIQUE,
  ai_generated BOOLEAN NOT NULL DEFAULT false,
  sent_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  task_id UUID,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);

-- Follow-ups (kind='follow_up', client/lead outreach) and internal tasks (kind='task').
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL DEFAULT 'follow_up' CHECK (kind IN ('follow_up','task')),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT,
  notes TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','completed','snoozed','cancelled')),
  due_at TIMESTAMPTZ NOT NULL,
  snoozed_until TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  completed_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  assigned_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  source_rule TEXT,                    -- which automation rule created it (null = manual)
  dedupe_key TEXT UNIQUE,              -- prevents a rule from creating the same follow-up twice
  hl_status TEXT NOT NULL DEFAULT 'not_pushed',
  hl_task_id TEXT,
  hl_contact_id TEXT,
  hl_attempts INTEGER NOT NULL DEFAULT 0,
  hl_last_attempt_at TIMESTAMPTZ,
  hl_last_synced_at TIMESTAMPTZ,
  hl_next_retry_at TIMESTAMPTZ,
  hl_error TEXT,
  created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tasks_open_idx ON tasks(status, due_at);
CREATE INDEX tasks_client_idx ON tasks(client_id);
CREATE INDEX tasks_lead_idx ON tasks(lead_id);
CREATE INDEX tasks_hl_retry_idx ON tasks(hl_status, hl_next_retry_at);

-- Internal notes. Never sent to clients; kept separate from messages on purpose.
CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  author_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  pinned BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notes_client_idx ON notes(client_id);

CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE client_tags (
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, tag_id)
);

-- Automation rule run log (what fired, when) — rules themselves are configured in settings.
CREATE TABLE automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule TEXT NOT NULL,
  created_count INTEGER NOT NULL DEFAULT 0,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID REFERENCES staff(id) ON DELETE CASCADE,   -- null = everyone
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_staff_idx ON notifications(staff_id, created_at DESC);

-- Integration connection state. Secrets (OAuth tokens) are AES-256-GCM encrypted at rest.
CREATE TABLE integrations (
  provider TEXT PRIMARY KEY,           -- 'square' | 'highlevel' | 'sms'
  status TEXT NOT NULL DEFAULT 'disconnected',
  encrypted_credentials TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at TIMESTAMPTZ,
  last_sync_status TEXT,
  last_sync_message TEXT,
  last_error_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,                 -- provider event id (idempotency)
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  error TEXT
);

-- Audit log. Stores who did what to which record — never message bodies or contact details.
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail JSONB,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity_type, entity_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
