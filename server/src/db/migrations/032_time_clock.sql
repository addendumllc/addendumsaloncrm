-- Time clock: shifts clocked in the CRM, their breaks, and each person's regular weekly schedule.
CREATE TABLE time_clock_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  clock_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  clock_out_at TIMESTAMPTZ,
  paid_minutes INTEGER,
  -- Square timecards made from this shift (one per worked stretch; an unpaid lunch splits it), or why that failed.
  square_timecard_ids TEXT[] NOT NULL DEFAULT '{}',
  square_error TEXT,
  staff_hours_id UUID REFERENCES staff_hours(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one open shift per person.
CREATE UNIQUE INDEX time_clock_one_open ON time_clock_shifts(staff_id) WHERE clock_out_at IS NULL;
CREATE INDEX time_clock_shifts_staff_idx ON time_clock_shifts(staff_id, clock_in_at);

CREATE TABLE time_clock_breaks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID NOT NULL REFERENCES time_clock_shifts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('lunch','rest')),
  paid BOOLEAN NOT NULL,
  planned_minutes INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX time_clock_breaks_shift_idx ON time_clock_breaks(shift_id);

-- Regular weekly schedule (0 = Sunday … 6 = Saturday). Lunch is unpaid, the short break is paid.
CREATE TABLE staff_schedules (
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL CHECK (start_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  end_time TEXT NOT NULL CHECK (end_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  lunch_minutes INTEGER NOT NULL DEFAULT 30 CHECK (lunch_minutes BETWEEN 0 AND 180),
  break_minutes INTEGER NOT NULL DEFAULT 10 CHECK (break_minutes BETWEEN 0 AND 60),
  PRIMARY KEY (staff_id, weekday)
);
