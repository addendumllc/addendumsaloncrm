-- Extensions (wefts, k-tips, tapes…) at 10 or less get the "please count" alert (was 3). Only changes the old default.
UPDATE settings SET value = jsonb_set(value::jsonb, '{recountAt}', '10')
  WHERE key = 'stock.forecast-settings' AND (value::jsonb ->> 'recountAt') = '3';
