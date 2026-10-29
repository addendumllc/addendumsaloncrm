-- Their own Earnings page shows commission (and tips) only — no hours, wages, taxes or net. Admins still see everything.
ALTER TABLE staff ADD COLUMN commission_only_view BOOLEAN NOT NULL DEFAULT false;
