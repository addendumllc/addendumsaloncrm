-- Hourly pay: for all hours worked, only for hours not with a client (appointments are paid as commission), or off.
ALTER TABLE staff ADD COLUMN hourly_mode TEXT NOT NULL DEFAULT 'all' CHECK (hourly_mode IN ('all', 'not_servicing', 'off'));
UPDATE staff SET hourly_mode = 'off' WHERE hourly_off;
ALTER TABLE staff DROP COLUMN hourly_off;
