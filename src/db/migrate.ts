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
      const version = f.split('_')[0] ?? '';
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

/**
 * The migrations this database has recorded as applied. The runner and the start-up check both read "applied"
 * through here, so they cannot disagree. A database that has never been migrated has no record table yet and
 * answers an empty list; it is not created here, so asking never changes the database.
 */
export async function appliedMigrations(
  sql: SqlRunner,
): Promise<{ version: string; name: string; checksum: string }[]> {
  try {
    return await sql<{ version: string; name: string; checksum: string }>`
      SELECT version, name, checksum FROM schema_migrations
    `;
  } catch (e: any) {
    if (e?.code === '42P01') return [];
    throw e;
  }
}

/** The migration files this database has not recorded, in the order they would be applied. */
export async function pendingMigrations(sql: SqlRunner, dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const seen = new Set((await appliedMigrations(sql)).map(r => r.version));
  return readMigrations(dir).filter(m => !seen.has(m.version));
}

/** Whether an error came from the database itself, which names it with a five-character SQLSTATE code. */
const answeredWithAnError = (e: any): boolean => typeof e?.code === 'string' && /^[0-9A-Z]{5}$/u.test(e.code);

/** How often, and how far apart, a start asks a database that does not answer before it gives up. */
export interface DatabaseWake {
  readonly tries: number;
  readonly pauseMs: number;
  sleep(ms: number): Promise<void>;
}

/**
 * Three tries, ten seconds apart: a hosted database that was asleep answers its
 * first connection only once it has woken, which takes seconds.
 */
export const DATABASE_WAKE: DatabaseWake = {
  tries: 3,
  pauseMs: 10_000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * What to tell the person when the service must not start on this database, or null when it may. It refuses
 * while any migration file is unrecorded, naming each one, and it refuses when the database does not answer
 * after it was asked again, because a start that cannot tell whether the database is current would fail later,
 * in the middle of filing something. It reads only; it never applies a migration, and a database that did not
 * answer is never sent to the setup, which would not wake it either.
 */
export async function refuseWhileMigrationsPending(
  sql: SqlRunner, dir = MIGRATIONS_DIR, wake: DatabaseWake = DATABASE_WAKE,
): Promise<string | null> {
  let pending: Migration[] | null = null;
  let last: any;
  for (let attempt = 1; attempt <= wake.tries && pending === null; attempt++) {
    try {
      pending = await pendingMigrations(sql, dir);
    } catch (e: any) {
      last = e;
      /* A database that answered with an error of its own is awake: asking again changes nothing. */
      if (answeredWithAnError(e)) {
        return 'THE DATABASE COULD NOT BE CHECKED FOR UNAPPLIED MIGRATIONS.\n\n' +
          `  ${String(e?.message ?? e)}\n\n` +
          '  Nothing was started. Run the database setup, which says what is wrong with the database, then start again.';
      }
      if (attempt < wake.tries) await wake.sleep(wake.pauseMs);
    }
  }
  if (pending === null) {
    const seconds = Math.round(((wake.tries - 1) * wake.pauseMs) / 1000);
    return 'THE DATABASE DID NOT ANSWER.\n\n' +
      `  ${String(last?.message ?? last)}\n\n` +
      `  It was asked ${wake.tries} times over about ${seconds} s. Nothing was started.\n` +
      '  A database that was asleep can take a moment to wake: start again in a minute.\n' +
      '  If it still does not answer, check DATABASE_URL in .env.';
  }
  if (pending.length === 0) return null;
  return 'THE DATABASE IS OUT OF DATE.\n\n' +
    `  ${pending.length === 1 ? 'This migration has' : `These ${pending.length} migrations have`} not been applied to it:\n` +
    pending.map(m => `    ${m.name}`).join('\n') + '\n\n' +
    '  Filing a record on it would fail. Nothing was started.\n' +
    '  Run the database setup first, which applies them, then start again.';
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
    const seen = new Map((await appliedMigrations(sql)).map(r => [r.version, r]));

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
