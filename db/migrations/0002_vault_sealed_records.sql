-- 0002 - a vault's sealed records: its note pool and its two attempt journals.
--
-- The note pool is the only record of what a vault's notes ARE. The chain holds
-- commitments, and a commitment cannot be inverted, so a pool that is lost is
-- money nobody can name. These rows are that record, one row per version.
--
-- WHAT A ROW HOLDS IS CIPHERTEXT. `body` is the sealed record exactly as it was
-- written: sealed under a fresh key that is wrapped to each signer's own key.
-- Nothing on this server can open it. The only readable fields are a version
-- counter and which of the three records a row belongs to.
--
-- THE VAULT IS NOT A COLUMN. A vault's address is the one value that destroys
-- money when it is pasted into a wallet, and a database key is printed by
-- every error that names it. Rows are keyed by a hash of the address instead;
-- the address itself travels only inside `body`, where the reader checks it.
--
-- FOUR PROPERTIES, AND THIS TABLE IS WHERE THEY ARE ENFORCED:
--
--   1. One writer per version. The primary key is the claim: of two writers
--      filing the same version, exactly one row is inserted and the other
--      insert fails, having written nothing.
--   2. Versions follow one another. The writer inserts version n only while
--      the newest is n - 1, in the same statement.
--   3. A write that returns has happened. The writer commits with
--      synchronous_commit on, so the commit is acknowledged only once its WAL
--      is flushed (or, on a service that replicates the WAL, acknowledged by
--      its quorum).
--   4. Nothing filed is ever changed or removed. The triggers below refuse an
--      UPDATE, a DELETE and a TRUNCATE. A rebuild proposes every note any
--      version ever held, so a version that disappears is a note that can no
--      longer be proposed.

CREATE TABLE IF NOT EXISTS vault_sealed_records (
  -- sha256 of a fixed label and the vault's address. Never the address.
  vault_key  bytea       NOT NULL CHECK (octet_length(vault_key) = 32),
  record     text        NOT NULL CHECK (record IN ('pool', 'deposit-journal', 'payment-journal')),
  version    integer     NOT NULL CHECK (version >= 1),
  -- The sealed record as written, byte for byte. Text rather than jsonb, which
  -- would reorder and renormalise it.
  body       text        NOT NULL,
  -- sha256 of `body`, checked on every read: a row that does not match its own
  -- digest is refused rather than opened.
  digest     bytea       NOT NULL CHECK (octet_length(digest) = 32),
  filed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_key, record, version)
);

CREATE OR REPLACE FUNCTION vault_sealed_records_are_kept() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a filed version of a vault''s sealed record is never changed or removed: a rebuild proposes every note any version ever held, so removing one loses the only name of a note'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE TRIGGER vault_sealed_records_no_update_or_delete
  BEFORE UPDATE OR DELETE ON vault_sealed_records
  FOR EACH ROW EXECUTE FUNCTION vault_sealed_records_are_kept();

CREATE OR REPLACE TRIGGER vault_sealed_records_no_truncate
  BEFORE TRUNCATE ON vault_sealed_records
  FOR EACH STATEMENT EXECUTE FUNCTION vault_sealed_records_are_kept();
