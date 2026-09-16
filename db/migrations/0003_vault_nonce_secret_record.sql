-- 0003 - a vault's nonce secret is one of its sealed records.
--
-- A private deposit's nonce is derived from a secret that belongs to the
-- company, wrapped to every signer under a key each signer derives from their
-- own recovery words. The record that carries it is sealed exactly like the
-- other three and is kept by the same rules: one writer per version, versions
-- in order, durable commits, nothing changed or removed.
--
-- Only the list of record kinds changes.

ALTER TABLE vault_sealed_records DROP CONSTRAINT IF EXISTS vault_sealed_records_record_check;
ALTER TABLE vault_sealed_records ADD CONSTRAINT vault_sealed_records_record_check
  CHECK (record IN ('pool', 'deposit-journal', 'payment-journal', 'nonce-secret'));
