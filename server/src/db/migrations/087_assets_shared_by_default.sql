-- Salon assets are for stylists to download unless turned off: the salon's (addendum.salon) and all-account assets
-- uploaded so far are shared (as a story for story assets, otherwise as a post). Other accounts' assets stay as they were.
UPDATE content_media SET stylist_share = CASE WHEN post_type = 'story' THEN 'story' ELSE 'post' END
  WHERE stylist_share IS NULL AND (account IS NULL OR account = 'a1');
