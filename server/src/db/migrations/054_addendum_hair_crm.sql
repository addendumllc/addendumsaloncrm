-- Addendum Hair's own CRM: its clients (stylists and salons who buy hair) and their tasks, kept apart from the salon's
-- clients and follow-ups.
CREATE TABLE hair_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hair_clients_email_idx ON hair_clients(lower(email)) WHERE email IS NOT NULL;

CREATE TABLE hair_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES hair_clients(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  -- reply (needs an answer), order (hair to order, e.g. not in stock yet), check_in (a future check-in), other
  type TEXT NOT NULL DEFAULT 'other' CHECK (type IN ('reply', 'order', 'check_in', 'other')),
  -- Where it came from: an email, a follow-up, or added by hand; with the email's subject, sender and an excerpt.
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('email', 'follow_up', 'manual')),
  source_subject TEXT,
  source_from TEXT,
  source_excerpt TEXT,
  -- open (to do), waiting (on the client's reply), done
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'done')),
  next_step TEXT,
  due_on DATE,
  assigned_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX hair_tasks_status_idx ON hair_tasks(status, due_on);
CREATE INDEX hair_tasks_client_idx ON hair_tasks(client_id);
