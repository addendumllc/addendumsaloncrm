-- Payroll hours entered as one weekly total for some people (instead of day by day).
ALTER TABLE staff ADD COLUMN timesheet_mode TEXT NOT NULL DEFAULT 'day' CHECK (timesheet_mode IN ('day','week'));
