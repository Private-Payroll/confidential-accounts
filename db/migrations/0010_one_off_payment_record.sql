-- 0010 - a one-off payment from a vault, kept as one of the company's records.
--
-- One record per one-off payment, filed once under a random id, sealed on the
-- filing seat's device under a fresh key wrapped to each signer and signed by
-- the seat that filed it. The table and its four properties are 0004's; this
-- only lets it hold the kind.

ALTER TABLE company_sealed_records DROP CONSTRAINT IF EXISTS company_sealed_records_kind_check;
ALTER TABLE company_sealed_records ADD CONSTRAINT company_sealed_records_kind_check
  CHECK (kind IN ('state', 'roster', 'policy', 'person', 'run', 'proposal', 'offer', 'spending-policy', 'vault-info', 'transfer'));
