-- Services that never need a rebooking follow-up (add-ons like "Extra product charge"). They still show in a client's
-- visits and rebooking list (to note or adjust); a client's own setting can still turn follow-ups on for them.
ALTER TABLE services ADD COLUMN rebook_not_needed BOOLEAN NOT NULL DEFAULT false;
