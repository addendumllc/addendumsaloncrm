-- My Content: a stylist can share one of their ideas with the team (others see its text, never their photos).
ALTER TABLE personal_posts ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;
