-- Whether the team member is bookable online in Square (their booking profile): only they count as stylists.
-- null = not known yet (no Square link or no sync since): treated as before.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS square_bookable boolean;
