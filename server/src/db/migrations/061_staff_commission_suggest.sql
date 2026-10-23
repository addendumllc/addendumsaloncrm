-- People who aren't at the salon (e.g. an online-only team member): never picked or suggested for commission when
-- Square didn't record who checked out — they can still be credited by choosing them.
ALTER TABLE staff ADD COLUMN commission_suggest BOOLEAN NOT NULL DEFAULT true;
