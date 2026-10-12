-- 0007 - each seat's opening of its own leaf, kept as one of the company's records.
--
-- One record per seat, sealed on that seat's own device under the company's
-- roster key and signed by the seat that filed it, so only the company's own
-- members can work out which seat moved its record anchor. The table and its
-- four properties are 0004's; this only lets it hold the kind.

ALTER TABLE company_sealed_records DROP CONSTRAINT IF EXISTS company_sealed_records_kind_check;
ALTER TABLE company_sealed_records ADD CONSTRAINT company_sealed_records_kind_check
  CHECK (kind IN ('state', 'roster', 'policy', 'person', 'run', 'proposal', 'offer', 'spending-policy', 'opening'));
