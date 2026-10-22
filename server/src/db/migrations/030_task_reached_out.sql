-- "Reached out": the team contacted the client/lead and is waiting for a reply. The task stays open (snoozed until
-- the check-back date) and comes back straight away if they text back.
ALTER TABLE tasks ADD COLUMN reached_out_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN reach_out_count INTEGER NOT NULL DEFAULT 0;
