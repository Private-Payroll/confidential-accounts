/**
 * The migration runner.
 *
 * Until now `0001` was applied by the test files and by nothing else, which
 * means the only thing that had ever created these tables was a test. That is
 * fine exactly once and then it is a deployment with no schema.
 *
 * THREE PROPERTIES, AND EACH ONE IS A BUG SOMEBODY HAS SHIPPED:
 *
 * 1. **Applied migrations are recorded, so running it twice does nothing.**
 *    A runner you have to remember not to re-run is a runner that gets re-run.
 *
 * 2. **A migration that has already been applied is CHECKSUMMED, and editing
 *    it is a hard error.** This is the one worth the code. Editing an applied
 *    migration is the most natural thing in the world — you notice a missing
 *    index and add it to the file that created the table — and the result is
 *    that your machine has the index and the deployment never will, silently
 *    and for ever. The runner cannot fix that, but it can refuse to pretend.
 *
 * 3. **One migration, one transaction, and an advisory lock around the whole
 *    run.** The lock is for the deploy that starts two instances at once:
 *    without it both read "0002 is not applied" and both apply it.
 *
 *    **DO NOT DELETE THE `begin` BECAUSE POSTGRES SEEMS TO DO IT ANYWAY.** It
 *    looks redundant and is not, and a mutation run is what showed the
 *    difference. A multi-statement query with no parameters goes over the
 *    SIMPLE query protocol, which Postgres wraps in an implicit transaction —
 *    so a migration that fails halfway does roll back on its own, and a test
 *    for only that passes either way. What the implicit transaction does NOT
 *    cover is the bookkeeping INSERT, which is a separate statement. Without
 *    the explicit `begin`, a schema change can commit while its record fails,
 *    and then the next deploy applies it again and dies on "already exists" —
 *    a broken deploy whose error names the wrong thing entirely. The test is
 *    `the schema change and the record of it land together`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export interface Migration { version: string; name: string; sql: string; checksum: string; }

/** Arbitrary but FIXED. Two runners must pick the same number to queue behind each other. */
const LOCK_ID = 83_141_001;

export const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

/** Reads the directory in filename order. `0001_…`, `0002_…`; zero-padded, so it sorts. */
export function readMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => {
      const sql = readFileSync(join(dir, f), 'utf8');
      const version = f.split('_')[0];
      if (!/^\d+$/.test(version)) {
        throw new Error(`migration "${f}" does not start with a number, so its order is undefined`);
      }
      return {
        version,
        name: f,
        sql,
        // Whitespace is deliberately NOT normalised. A reformat is still an edit
        // to a file that has already run somewhere, and the point is to notice.
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

/** A minimal view of the driver, so this file depends on no particular one. */
export interface SqlRunner {
  <T = any>(strings: TemplateStringsArray, ...values: any[]): Promise<T[]>;
  unsafe<T = any>(query: string): Promise<T[]>;
  begin<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

export interface MigrateResult { applied: string[]; alreadyApplied: string[]; }

export async function migrate(
  sql: SqlRunner,
  opts: { dir?: string; log?: (m: string) => void } = {},
): Promise<MigrateResult> {
  const log = opts.log ?? (() => {});
  const migrations = readMigrations(opts.dir ?? MIGRATIONS_DIR);

  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text        PRIMARY KEY,
      name       text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  // Session-level lock, held across the transactions below.
  await sql`SELECT pg_advisory_lock(${LOCK_ID})`;
  try {
    const rows = await sql<{ version: string; name: string; checksum: string }>`
      SELECT version, name, checksum FROM schema_migrations
    `;
    const seen = new Map(rows.map(r => [r.version, r]));

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const m of migrations) {
      const before = seen.get(m.version);
      if (before) {
        if (before.checksum !== m.checksum) {
          throw new Error(
            `migration ${m.name} has changed since it was applied.\n\n` +
            `  applied:  ${before.checksum.slice(0, 16)}…  (as ${before.name})\n` +
            `  on disk:  ${m.checksum.slice(0, 16)}…\n\n` +
            `  A migration that has already run somewhere is history and cannot be\n` +
            `  edited: this database has the old version and will never get the new\n` +
            `  one, silently. Put the change in a NEW migration file instead.\n` +
            `  If this database is disposable, drop it and start again.`,
          );
        }
        alreadyApplied.push(m.name);
        continue;
      }

      log(`applying ${m.name}`);
      await sql.begin(async tx => {
        await tx.unsafe(m.sql);
        await tx`
          INSERT INTO schema_migrations (version, name, checksum)
          VALUES (${m.version}, ${m.name}, ${m.checksum})
        `;
      });
      applied.push(m.name);
    }

    return { applied, alreadyApplied };
  } finally {
    await sql`SELECT pg_advisory_unlock(${LOCK_ID})`;
  }
}
