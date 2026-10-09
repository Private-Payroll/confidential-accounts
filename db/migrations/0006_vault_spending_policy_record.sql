-- 0006 - a vault's spending policy, kept as one of the company's records.
--
-- One record per vault and currency, each version sealed on a signer's device
-- under a key wrapped to each signer and signed by the seat that filed it. The
-- table and its four properties are 0004's; this only lets it hold the kind.

ALTER TABLE company_sealed_records DROP CONSTRAINT IF EXISTS company_sealed_records_kind_check;
ALTER TABLE company_sealed_records ADD CONSTRAINT company_sealed_records_kind_check
  CHECK (kind IN ('state', 'roster', 'policy', 'person', 'run', 'proposal', 'offer', 'spending-policy'));
