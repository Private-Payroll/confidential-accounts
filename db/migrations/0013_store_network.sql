-- 0013 - which network this database's store holds.
--
-- One row, written by the service the first time it starts on this database,
-- naming the network it is built for. Every later start reads it and refuses to
-- serve under any other network, and the store's reset empties a store only when
-- this row names a test network. Nothing updates or deletes the row: a database
-- holds one network's companies for its whole life.

CREATE TABLE IF NOT EXISTS store_network (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row),
  network text NOT NULL CHECK (network <> ''),
  stamped_at timestamptz NOT NULL DEFAULT now()
);
