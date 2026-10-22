-- Payroll timesheet: a day's hours set on Team Commission → Payroll hours are that day's hours for pay, replacing
-- Square timecards and other hand entries for the day ('timesheet'). Earlier timesheet entries move over.
ALTER TABLE staff_hours DROP CONSTRAINT staff_hours_source_check;
ALTER TABLE staff_hours ADD CONSTRAINT staff_hours_source_check CHECK (source IN ('square','manual','timesheet'));
UPDATE staff_hours SET source = 'timesheet' WHERE source = 'manual' AND note = 'Payroll timesheet';
CREATE UNIQUE INDEX staff_hours_one_timesheet_per_day ON staff_hours(staff_id, work_date) WHERE source = 'timesheet';
