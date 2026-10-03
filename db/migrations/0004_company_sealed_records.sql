-- 0004 - a company's own sealed records, filed by its seats.
--
-- The vault's records table, for a company's own records: each kind and id has
-- versions in order, every row the sealed record exactly as a seat filed it,
-- sealed under a fresh key wrapped to each signer and signed by the seat. The
-- same four properties as 0002, enforced the same way: one writer per version,
-- versions in order, durable commits, nothing changed or removed.
--
-- THE COMPANY IS A COLUMN. A company's id is an opaque handle the server mints,
-- not an address that moves money.

CREATE TABLE IF NOT EXISTS company_sealed_records (
  company    text        NOT NULL CHECK (company ~ '^[A-Za-z0-9_-]{1,64}$'),
  kind       text        NOT NULL CHECK (kind IN ('state', 'roster', 'policy', 'person', 'run', 'proposal', 'offer')),
  record_id  text        NOT NULL CHECK (record_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  version    integer     NOT NULL CHECK (version >= 1),
  key_epoch  integer     NOT NULL CHECK (key_epoch >= 0),
  body       text        NOT NULL,
  digest     bytea       NOT NULL CHECK (octet_length(digest) = 32),
  filed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, kind, record_id, version)
);

CREATE OR REPLACE FUNCTION company_sealed_records_are_kept() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a filed version of a company''s sealed record is never changed or removed'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE TRIGGER company_sealed_records_no_update_or_delete
  BEFORE UPDATE OR DELETE ON company_sealed_records
  FOR EACH ROW EXECUTE FUNCTION company_sealed_records_are_kept();

CREATE OR REPLACE TRIGGER company_sealed_records_no_truncate
  BEFORE TRUNCATE ON company_sealed_records
  FOR EACH STATEMENT EXECUTE FUNCTION company_sealed_records_are_kept();
