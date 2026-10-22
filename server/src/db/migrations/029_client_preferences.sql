-- A client's standing preferences and allergies/sensitivities, shown in Details on their profile (internal only).
ALTER TABLE clients ADD COLUMN preferences TEXT;
ALTER TABLE clients ADD COLUMN allergies TEXT;
