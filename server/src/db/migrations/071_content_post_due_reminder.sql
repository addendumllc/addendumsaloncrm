-- "Time to post" reminders for posts published by hand (e.g. private accounts, which apps can't post to).
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS reminded_due BOOLEAN NOT NULL DEFAULT false;
