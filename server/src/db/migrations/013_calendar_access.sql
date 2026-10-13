-- "Can view team calendars" can be limited per person to chosen team members. NULL = every team member's calendar;
-- an array = only those people (plus always their own). Only used when the person has appointments:read.
ALTER TABLE staff ADD COLUMN calendar_staff_ids UUID[];
