-- Wage history: each rate applies from its start date until the next one starts, so a raise never rewrites past weeks.
-- staff.pay_type / hourly_rate_cents / salary_* keep the rate in effect today (for display).
CREATE TABLE staff_pay_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  effective_from DATE NOT NULL,
  pay_type TEXT NOT NULL CHECK (pay_type IN ('none','hourly','salary')),
  hourly_rate_cents INTEGER CHECK (hourly_rate_cents >= 0),
  salary_cents INTEGER CHECK (salary_cents >= 0),
  salary_period TEXT NOT NULL DEFAULT 'year' CHECK (salary_period IN ('week','biweekly','semimonthly','month','year')),
  created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (staff_id, effective_from)
);
-- Wages set before history existed apply to all past dates.
INSERT INTO staff_pay_rates(staff_id, effective_from, pay_type, hourly_rate_cents, salary_cents, salary_period)
  SELECT id, DATE '2000-01-01', pay_type, hourly_rate_cents, salary_cents, salary_period FROM staff WHERE pay_type <> 'none';
