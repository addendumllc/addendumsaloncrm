-- California DE 4 (state withholding certificate) per person, for payroll estimates and the pay summary export.
ALTER TABLE staff ADD COLUMN de4_exempt BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE staff ADD COLUMN de4_filing_status TEXT CHECK (de4_filing_status IN ('single_or_married_two_incomes','married_one_income','head_of_household'));
ALTER TABLE staff ADD COLUMN de4_regular_allowances INTEGER NOT NULL DEFAULT 0 CHECK (de4_regular_allowances BETWEEN 0 AND 99);
ALTER TABLE staff ADD COLUMN de4_additional_allowances INTEGER NOT NULL DEFAULT 0 CHECK (de4_additional_allowances BETWEEN 0 AND 99);
ALTER TABLE staff ADD COLUMN de4_additional_withholding_cents INTEGER NOT NULL DEFAULT 0 CHECK (de4_additional_withholding_cents >= 0);
