/**
 * WHICH NETWORK A DATABASE'S STORE HOLDS, WRITTEN ONCE AND CHECKED AT EVERY START.
 *
 * Nothing in a database's address says which network's companies it holds, so
 * the store says it itself: the first start of the service on an empty database
 * writes the network the service is built for into `store_network` (one row), and every
 * start afterwards reads it back and refuses to serve under any other network.
 * A service pointed at another network's database would otherwise show one
 * chain's companies while reading and writing another chain. A database that
 * already holds records and no stamp is never stamped: nothing says which network
 * wrote them, so it is refused.
 */

/** The database handle this needs: postgres.js's tagged template. */
export type StampSql = (
  strings: TemplateStringsArray, ...values: string[]
) => PromiseLike<ReadonlyArray<Record<string, unknown>>>;

/**
 * Whether the store already holds what a network's run keeps: sessions, or a company's or a vault's sealed records.
 * These are the tables the clean start of a test network's run empties; schema_migrations, login_attempts (counters,
 * no records) and store_network itself are not.
 */
export async function storeHoldsRecords(sql: StampSql): Promise<boolean> {
  const rows = await sql`SELECT (EXISTS (SELECT 1 FROM sessions) OR EXISTS (SELECT 1 FROM company_sealed_records) OR EXISTS (SELECT 1 FROM vault_sealed_records)) AS held`;
  return rows[0]?.held === true;
}

/** The network the store is stamped for, or null when it has never been stamped. */
export async function storeStamp(sql: StampSql): Promise<string | null> {
  const rows = await sql`SELECT network FROM store_network`;
  const network = rows[0]?.network;
  return typeof network === 'string' ? network : null;
}

/** What a start finds: the stamp the store carries afterwards, and whether an unstamped store held records. */
export interface StoreSeen {
  readonly stamped: string | null;
  readonly unstampedWithRecords: boolean;
}

/**
 * Stamps an EMPTY store that has no stamp yet with `network`, and answers what the store is stamped for afterwards.
 * A store already stamped keeps its stamp. A store with no stamp that already holds records is not stamped: nothing
 * says which network wrote them, so it is left for the refusal.
 */
export async function stampedFor(sql: StampSql, network: string): Promise<StoreSeen> {
  const before = await storeStamp(sql);
  if (before !== null) return { stamped: before, unstampedWithRecords: false };
  if (await storeHoldsRecords(sql)) return { stamped: null, unstampedWithRecords: true };
  await sql`INSERT INTO store_network (network) VALUES (${network}) ON CONFLICT (one_row) DO NOTHING`;
  return { stamped: await storeStamp(sql), unstampedWithRecords: false };
}

/** Null when a store seen as `seen` may be served by a service built for `network`; the refusal otherwise. */
export function refuseAStoreOfAnotherNetwork(seen: StoreSeen, network: string): string | null {
  const { stamped } = seen;
  if (stamped === network) return null;
  if (seen.unstampedWithRecords) {
    return 'THE DATABASE HOLDS RECORDS AND DOES NOT SAY WHICH NETWORK WROTE THEM.\n\n'
      + `  This service is built for "${network}", and the database already holds sessions or sealed records\n`
      + '  written before it said which network its store holds. Serving it could show another network\'s\n'
      + '  companies against this chain. Nothing was started.\n'
      + `  What resolves it: point DATABASE_URL in .env at an empty database for ${network}, apply every\n`
      + `  migration to it with the database setup, then start again; it is stamped for ${network} the first\n`
      + '  time the service starts on it. The\n'
      + '  records in this database are left as they are.';
  }
  if (stamped === null) {
    return 'THE DATABASE DOES NOT SAY WHICH NETWORK ITS STORE HOLDS.\n\n'
      + `  The service wrote "${network}" into it and could not read it back. Nothing was started.\n`
      + '  Run the database setup, which applies every migration and says what is wrong with the\n'
      + '  database, then start again.';
  }
  return 'THE DATABASE HOLDS ANOTHER NETWORK\'S STORE.\n\n'
    + `  It was first started on "${stamped}", and this service is built for "${network}". Serving it\n`
    + '  would show one network\'s companies while reading and writing another network\'s chain.\n'
    + '  Nothing was started.\n'
    + `  What resolves it: point DATABASE_URL in .env at ${network}'s own database (a new database is\n`
    + `  stamped for ${network} the first time the service starts on it), or run the build for ${stamped}.`;
}
