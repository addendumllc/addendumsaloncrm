-- Clocking in through the CRM clocks in on Square too: the live (open) Square timecard while they're working.
ALTER TABLE time_clock_shifts ADD COLUMN square_live BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE time_clock_shifts ADD COLUMN square_open_timecard_id TEXT;
