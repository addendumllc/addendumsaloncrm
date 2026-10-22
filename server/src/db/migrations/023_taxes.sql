-- Tax details per person, for payroll ESTIMATES only (the payroll provider does the official withholding).
-- No SSNs or bank details are stored here.
ALTER TABLE staff ADD COLUMN worker_type TEXT NOT NULL DEFAULT 'w2' CHECK (worker_type IN ('w2','1099'));
ALTER TABLE staff ADD COLUMN federal_withholding_bps INTEGER CHECK (federal_withholding_bps BETWEEN 0 AND 10000);
ALTER TABLE staff ADD COLUMN state_withholding_bps INTEGER CHECK (state_withholding_bps BETWEEN 0 AND 10000);
ALTER TABLE staff ADD COLUMN local_withholding_bps INTEGER CHECK (local_withholding_bps BETWEEN 0 AND 10000);
-- W-4 (2020+): Step 1(c) filing status, Step 2 multiple jobs, Step 3 dependents, Step 4(a)(b)(c).
ALTER TABLE staff ADD COLUMN w4_filing_status TEXT CHECK (w4_filing_status IN ('single','married_jointly','head_of_household'));
ALTER TABLE staff ADD COLUMN w4_multiple_jobs BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE staff ADD COLUMN w4_dependents_cents INTEGER CHECK (w4_dependents_cents >= 0);
ALTER TABLE staff ADD COLUMN w4_other_income_cents INTEGER CHECK (w4_other_income_cents >= 0);
ALTER TABLE staff ADD COLUMN w4_deductions_cents INTEGER CHECK (w4_deductions_cents >= 0);
ALTER TABLE staff ADD COLUMN w4_extra_withholding_cents INTEGER CHECK (w4_extra_withholding_cents >= 0);
