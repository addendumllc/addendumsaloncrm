-- Addendum Salon's Google review link (opens Google's "write a review" box). Only filled in where none is set yet, so a
-- link already entered in Settings → Salon details is kept.
UPDATE settings
   SET value = jsonb_set(value, '{business,reviewUrl}', to_jsonb('https://www.google.com/search?q=Addendum+Salon+12853+El+Camino+Real+San+Diego+CA#lrd=0x80dc0ecd7fb6aaab:0x3e215c50708febbd,3,,,,'::text), true), updated_at = now()
 WHERE key = 'app' AND coalesce(value->'business'->>'reviewUrl', '') = '';
