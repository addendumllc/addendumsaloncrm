-- Email campaigns (Flodesk) in the content calendar: the email's own details on the post, and email templates in the
-- ideas library (subject line, preview text, send timing).
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS email JSONB;
ALTER TABLE content_ideas
  ADD COLUMN IF NOT EXISTS subject TEXT,
  ADD COLUMN IF NOT EXISTS preview_text TEXT,
  ADD COLUMN IF NOT EXISTS send_timing TEXT;
