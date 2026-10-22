-- Addendum Hair clients pulled from HighLevel: the HighLevel contact each one came from, so later pulls update it.
ALTER TABLE hair_clients ADD COLUMN highlevel_contact_id TEXT;
CREATE UNIQUE INDEX hair_clients_highlevel_idx ON hair_clients(highlevel_contact_id) WHERE highlevel_contact_id IS NOT NULL;
