-- 0008 - a seat's opening is no longer a record of its own.
--
-- A seat's opening of its own leaf now travels in one place only: sealed under
-- the company's roster key inside the seat's own directory entry. The separate
-- record 0007 let this table hold is a second copy of the same fact, so it goes:
-- every version of it is deleted, and the check no longer lets the table hold
-- the kind. The table, and what it guarantees of every record, are 0004's.
--
-- Safe only where no 'opening' entry was ever anchored. Once the kind is gone,
-- a manifest entry naming it is not an entry, so a device's read of the
-- company's records would stop for good at the batch that anchored one. No
-- instance holds such an entry: none was anchored before this migration ships.

DELETE FROM company_sealed_records WHERE kind = 'opening';
ALTER TABLE company_sealed_records DROP CONSTRAINT IF EXISTS company_sealed_records_kind_check;
ALTER TABLE company_sealed_records ADD CONSTRAINT company_sealed_records_kind_check
  CHECK (kind IN ('state', 'roster', 'policy', 'person', 'run', 'proposal', 'offer', 'spending-policy'));
