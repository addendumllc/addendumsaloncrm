-- A scheduled day can have no set hours: they work that day, but the times vary (e.g. booked by appointment).
ALTER TABLE staff_schedules ALTER COLUMN start_time DROP NOT NULL;
ALTER TABLE staff_schedules ALTER COLUMN end_time DROP NOT NULL;
ALTER TABLE staff_schedules ADD CONSTRAINT staff_schedules_times_together CHECK ((start_time IS NULL) = (end_time IS NULL));
