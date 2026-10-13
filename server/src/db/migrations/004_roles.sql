-- Roles: Administrator, Receptionist, Stylist (replacing owner / manager / staff).
-- owner → admin, manager → receptionist, staff → stylist. Change anyone afterwards with `npm run users -- set-role`.

ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_role_check;
UPDATE staff SET role = CASE role WHEN 'owner' THEN 'admin' WHEN 'manager' THEN 'receptionist' WHEN 'staff' THEN 'stylist' ELSE role END;
ALTER TABLE staff ALTER COLUMN role SET DEFAULT 'stylist';
ALTER TABLE staff ADD CONSTRAINT staff_role_check CHECK (role IN ('admin','receptionist','stylist'));
