-- A supplier's real company name, separate from the name shown around the CRM (e.g. shown as "Addendum Hair").
-- Only people with "See supplier company names and contacts" see it, and the contact details.
ALTER TABLE suppliers ADD COLUMN company_name TEXT;
