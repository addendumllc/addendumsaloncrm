-- Who performs each service (Square's team_member_ids) and whether it's bookable online: each stylist's booking page
-- (/book/<first name>) lists their own services.
ALTER TABLE services ADD COLUMN IF NOT EXISTS team_member_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE services ADD COLUMN IF NOT EXISTS available_for_booking BOOLEAN NOT NULL DEFAULT true;
