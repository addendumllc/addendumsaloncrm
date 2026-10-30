-- Addendum Salon theme (matches addendumsalon.com): added to a saved theme list that doesn't have it yet.
-- Lists never saved use the built-in themes, which include it.
UPDATE settings
   SET value = jsonb_set(value, '{themeSettings,themes}', (value->'themeSettings'->'themes') || '[{"id": "salon", "name": "Addendum Salon", "description": "Matches addendumsalon.com: ivory pages, a deep brown accent, a pale sage menu and EB Garamond headings.", "status": "published", "roles": [], "type": {"font": "helvetica", "headingFont": "eb-garamond", "base": "default", "heading": "default", "small": "default", "weight": 400}, "buttons": {"size": "default", "radius": "square"}, "colors": {"accent": "#5A2C1A", "accent2": "#C9B39C", "background": "#F8F6F1", "sidebar": "#EAEBDB", "surface": "#FAFAF8", "text": "#14110E", "line": "#DEDBD3"}}]'::jsonb), updated_at = now()
 WHERE key = 'app'
   AND jsonb_typeof(value->'themeSettings'->'themes') = 'array'
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value->'themeSettings'->'themes') t WHERE t->>'id' = 'salon');
