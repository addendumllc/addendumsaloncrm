-- Internal tasks are for Addendum Salon or Addendum Hair (client follow-ups are always the salon's).
ALTER TABLE tasks ADD COLUMN business TEXT NOT NULL DEFAULT 'salon' CHECK (business IN ('salon', 'hair'));
