-- 0005 - a person's id is on one company's payroll only.
--
-- A company's people are kept here with its other records. A person's id is
-- the handle every route that names a person is checked by, so no two
-- companies may hold one: the store refuses another company's person under an
-- id already taken, and this index refuses the second of two that race to file
-- a person's first version under one id.

CREATE UNIQUE INDEX IF NOT EXISTS company_sealed_records_one_payroll_per_person
  ON company_sealed_records (record_id, version) WHERE kind = 'person';
