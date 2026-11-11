-- 0012 - the company's read grants, kept as one of the company's records.
--
-- One record per company, versioned: each version sealed on the filing seat's
-- device to every seat and every reader the grants name, and signed by the seat
-- that filed it. The table and its four properties are 0004's; this only lets it
-- hold the kind.

ALTER TABLE company_sealed_records DROP CONSTRAINT IF EXISTS company_sealed_records_kind_check;
ALTER TABLE company_sealed_records ADD CONSTRAINT company_sealed_records_kind_check
  CHECK (kind IN ('state', 'roster', 'policy', 'person', 'run', 'proposal', 'offer', 'spending-policy', 'vault-info', 'transfer', 'vendor', 'grants'));
