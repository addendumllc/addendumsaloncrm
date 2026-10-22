-- Wages and tips per person (Users & Permissions → Wages & tips; Team Commission shows hours, wages and total pay).
ALTER TABLE staff ADD COLUMN pay_type TEXT NOT NULL DEFAULT 'none' CHECK (pay_type IN ('none','hourly','salary'));
ALTER TABLE staff ADD COLUMN hourly_rate_cents INTEGER CHECK (hourly_rate_cents >= 0);
ALTER TABLE staff ADD COLUMN salary_cents INTEGER CHECK (salary_cents >= 0);
ALTER TABLE staff ADD COLUMN salary_period TEXT NOT NULL DEFAULT 'year' CHECK (salary_period IN ('week','biweekly','semimonthly','month','year'));
-- Not tip eligible: tips on their work go to Needs review instead of to them.
ALTER TABLE staff ADD COLUMN tip_eligible BOOLEAN NOT NULL DEFAULT true;

-- Hours worked: closed Square timecards (synced) and hours entered by hand.
CREATE TABLE staff_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes >= 0 AND minutes <= 1440 * 31),
  source TEXT NOT NULL CHECK (source IN ('square','manual')),
  square_timecard_id TEXT UNIQUE,
  note TEXT,
  created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX staff_hours_staff_date_idx ON staff_hours(staff_id, work_date);
