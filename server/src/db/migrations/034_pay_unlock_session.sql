-- Admins can keep pay (commission, payroll, wages) unlocked on a device for a working session (4 hours).
ALTER TABLE sessions ADD COLUMN pay_unlocked_until TIMESTAMPTZ;
