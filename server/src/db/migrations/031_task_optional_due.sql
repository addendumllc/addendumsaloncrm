-- Internal tasks can have no due date (just a priority). Client follow-ups always have one.
ALTER TABLE tasks ALTER COLUMN due_at DROP NOT NULL;
ALTER TABLE tasks ADD CONSTRAINT tasks_due_needed CHECK (due_at IS NOT NULL OR kind = 'task');
