/**
 * The migration runner, against a real Postgres.
 *
 * Every one of these is a property you only find out about in production if you
 * do not check it here: running twice, a migration edited after it ran, and two
 * instances starting at the same time.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, readMigrations, MIGRATIONS_DIR } from './migrate.js';

const DB = process.env.TEST_DATABASE_URL;
const withDb = DB ? describe : describe.skip;

/**
 * THIS FILE GETS ITS OWN DATABASE, AND THAT IS NOT TIDINESS.
 *
 * It DROPS TABLES — including `sessions` and `login_attempts`, because proving
 * the runner can build a schema from nothing is the whole point. Vitest runs
 * test files in parallel, in separate workers, so sharing a database with
 * `sessions.test.ts` and `rate-limit.test.ts` means deleting their tables while
 * they are using them. That is exactly what happened: twelve failures, most of
 * them in files that had done nothing wrong.
 *
 * **It passed against a local Postgres and failed against Neon**, because the
 * only thing holding it together was a local database being fast enough for
 * each file to finish inside the gap.
 *
 * THE FIRST FIX WAS A PRIVATE SCHEMA VIA `search_path`, AND IT DID NOT WORK.
 * postgres.js sends that as a startup parameter and Neon's proxy does not pass
 * it through, so the connection silently landed in `public` and did the damage
 * again — silently, because a startup parameter that is ignored does not error.
 * A separate DATABASE cannot be quietly ignored: you are either connected to it
 * or you are not, and `current_database()` says which.
 *
 * `beforeAll` REFUSES TO CONTINUE if the answer is wrong. An assertion inside a
 * test is too late — by then the destructive tests are already running. The
 * check has to gate the file, not be one of its cases.
 */
const MIGRATE_DB = 'ca_test_migrate';

let ownUrl: string;
let sql: any;

const connect = async () => {
  const { default: postgres } = await import('postgres');
  return postgres(ownUrl, { onnotice: () => {} });
};

beforeAll(async () => {
  if (!DB) return;
  const { default: postgres } = await import('postgres');

  const admin = postgres(DB, { onnotice: () => {} });
  try {
    const rows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_database WHERE datname = ${MIGRATE_DB}`;
    // CREATE DATABASE cannot run inside a transaction, hence unsafe().
    if (rows[0].n === 0) await admin.unsafe(`CREATE DATABASE "${MIGRATE_DB}"`);
  } finally {
    await admin.end();
  }

  const u = new URL(DB);
  u.pathname = `/${MIGRATE_DB}`;
  ownUrl = u.toString();
  sql = await connect();

  const [row] = await sql`SELECT current_database() AS db`;
  if (row.db !== MIGRATE_DB) {
    throw new Error(
      `refusing to run: this file DROPS tables and is connected to "${row.db}" ` +
      `rather than its own "${MIGRATE_DB}". Running would delete tables that ` +
      `sessions.test.ts and rate-limit.test.ts are using.`,
    );
  }
});

afterAll(async () => { if (sql) await sql.end(); });

describe('reading the directory', () => {
  it('sorts by the numeric prefix, so 0002 never runs before 0010 by accident', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    for (const f of ['0010_ten.sql', '0002_two.sql', '0001_one.sql']) {
      writeFileSync(join(dir, f), `-- ${f}`);
    }
    expect(readMigrations(dir).map(m => m.name))
      .toEqual(['0001_one.sql', '0002_two.sql', '0010_ten.sql']);
    rmSync(dir, { recursive: true });
  });

  it('refuses a file whose order is undefined rather than guessing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, 'add_sessions.sql'), 'select 1');
    expect(() => readMigrations(dir)).toThrow(/does not start with a number/);
    rmSync(dir, { recursive: true });
  });

  it('the real migrations directory is well formed', () => {
    const all = readMigrations(MIGRATIONS_DIR);
    expect(all.length).toBeGreaterThan(0);
    // Duplicate versions would mean one silently never runs.
    expect(new Set(all.map(m => m.version)).size).toBe(all.length);
  });
});

withDb('against a real database', () => {
  let dir: string;

  beforeEach(async () => {
    /*
     * Every test here starts from an empty database, including after the one
     * that applies the REAL migrations and therefore leaves `sessions` and
     * `login_attempts` behind. Missing those two off this list made the second
     * run of the suite fail while the first passed — found by running it twice
     * rather than once, which is the only way that class of bug shows up.
     */
    await sql`DROP TABLE IF EXISTS schema_migrations, widgets, gadgets, sessions, login_attempts`;
    dir = mkdtempSync(join(tmpdir(), 'mig-'));
  });

  const write = (name: string, body: string) => writeFileSync(join(dir, name), body);

  it('applies migrations in order and records them', async () => {
    write('0001_widgets.sql', 'CREATE TABLE widgets (id text PRIMARY KEY);');
    write('0002_gadgets.sql', 'CREATE TABLE gadgets (id text PRIMARY KEY);');

    const r = await migrate(sql, { dir });
    expect(r.applied).toEqual(['0001_widgets.sql', '0002_gadgets.sql']);

    const rows = await sql`SELECT version FROM schema_migrations ORDER BY version`;
    expect(rows.map((x: any) => x.version)).toEqual(['0001', '0002']);
  });

  it('THE ONE THAT MAKES IT SAFE TO RUN ON EVERY DEPLOY: twice is the same as once', async () => {
    write('0001_widgets.sql', 'CREATE TABLE widgets (id text PRIMARY KEY);');
    await migrate(sql, { dir });

    const second = await migrate(sql, { dir });
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(['0001_widgets.sql']);
  });

  it('THE ONE THAT CATCHES A SILENT SCHEMA DRIFT: an applied migration cannot be edited', async () => {
    /*
     * The most natural mistake there is. You notice a missing index, you add it
     * to the migration that created the table, it runs on your machine because
     * your machine is fresh — and the deployment, which already applied the old
     * version, will never get the index. Nothing errors. Nothing ever will.
     */
    write('0001_widgets.sql', 'CREATE TABLE widgets (id text PRIMARY KEY);');
    await migrate(sql, { dir });

    write('0001_widgets.sql',
      'CREATE TABLE widgets (id text PRIMARY KEY);\nCREATE INDEX ON widgets (id);');
    await expect(migrate(sql, { dir })).rejects.toThrow(/has changed since it was applied/);
  });

  it('even a whitespace change counts, because a reformat is still an edit', async () => {
    write('0001_widgets.sql', 'CREATE TABLE widgets (id text PRIMARY KEY);');
    await migrate(sql, { dir });
    write('0001_widgets.sql', 'CREATE TABLE widgets (id text PRIMARY KEY);\n');
    await expect(migrate(sql, { dir })).rejects.toThrow(/has changed/);
  });

  it('a migration that fails leaves nothing behind, not half a schema', async () => {
    write('0001_widgets.sql',
      'CREATE TABLE widgets (id text PRIMARY KEY);\nTHIS IS NOT SQL;');
    await expect(migrate(sql, { dir })).rejects.toThrow();

    const t = await sql`SELECT to_regclass('widgets') AS t`;
    expect(t[0].t).toBeNull();                       // rolled back
    const rows = await sql`SELECT * FROM schema_migrations`;
    expect(rows).toHaveLength(0);                    // and not recorded
  });

  it('THE ONE THE TRANSACTION IS FOR: the schema change and the record of it land together', async () => {
    /*
     * The test above passes WITHOUT the explicit transaction, and that is the
     * trap. A multi-statement query with no parameters uses the simple query
     * protocol, which Postgres wraps in an implicit transaction, so a migration
     * that fails inside itself rolls back on its own.
     *
     * The bookkeeping INSERT is a separate statement and is not covered by
     * that. If it fails — a dropped connection at the wrong moment — the schema
     * change has committed and nothing records it, so the next deploy applies
     * the same migration again and dies on "relation already exists", which
     * reads like a broken migration rather than a lost write.
     *
     * So: make the bookkeeping write fail, and assert the table did not
     * survive. Deleting the `begin` turns this red.
     */
    const failBookkeeping = (real: any) => {
      const wrap = (target: any): any => {
        const f = (strings: TemplateStringsArray, ...vals: any[]) =>
          strings.join('?').includes('INSERT INTO schema_migrations')
            ? Promise.reject(new Error('bookkeeping write failed'))
            : target(strings, ...vals);
        f.unsafe = (q: string) => target.unsafe(q);
        f.begin = (fn: any) => target.begin((tx: any) => fn(wrap(tx)));
        return f;
      };
      return wrap(real);
    };

    write('0001_widgets.sql', 'CREATE TABLE widgets (id text PRIMARY KEY);');
    await expect(migrate(failBookkeeping(sql), { dir })).rejects.toThrow(/bookkeeping/);

    const t = await sql`SELECT to_regclass('widgets') AS t`;
    expect(t[0].t, 'the table committed while its record did not').toBeNull();
  });

  it('a later migration failing does not undo the earlier one that worked', async () => {
    write('0001_widgets.sql', 'CREATE TABLE widgets (id text PRIMARY KEY);');
    write('0002_bad.sql', 'NOT SQL AT ALL;');
    await expect(migrate(sql, { dir })).rejects.toThrow();

    const rows = await sql`SELECT version FROM schema_migrations`;
    expect(rows.map((x: any) => x.version)).toEqual(['0001']);

    // And fixing 0002 carries on from there rather than starting over.
    write('0002_bad.sql', 'CREATE TABLE gadgets (id text PRIMARY KEY);');
    const r = await migrate(sql, { dir });
    expect(r.applied).toEqual(['0002_bad.sql']);
  });

  it('two runners starting at once apply each migration exactly once', async () => {
    /*
     * A deploy that starts two instances together. Without the advisory lock
     * both read "0001 is not applied" and both run it; the second gets
     * "relation already exists" and the deploy fails for a reason that looks
     * like a broken migration.
     */
    write('0001_widgets.sql', 'CREATE TABLE widgets (id text PRIMARY KEY);');
    const b = await connect();
    try {
      const [r1, r2] = await Promise.all([
        migrate(sql, { dir }),
        migrate(b as any, { dir }),
      ]);
      const applied = [...r1.applied, ...r2.applied];
      expect(applied).toEqual(['0001_widgets.sql']);   // exactly one of them did it
    } finally {
      await b.end();
    }
  });

  it('THE ONE THAT KEEPS THIS FILE FROM BREAKING THE OTHERS: its own database', async () => {
    /*
     * `beforeAll` already refuses to continue if this is wrong, which is where
     * the safety actually lives — an assertion here would fire after the
     * destructive tests had already run. This states the property so it is
     * visible in the test list rather than buried in a hook.
     */
    const [row] = await sql`SELECT current_database() AS db`;
    expect(row.db).toBe(MIGRATE_DB);
    // And the tables the other files depend on are not in here at all.
    const [t] = await sql`SELECT to_regclass('public.sessions') AS s`;
    expect(t.s).toBeNull();
  });

  it('applies the real migrations to an empty database', async () => {
    await sql`DROP TABLE IF EXISTS sessions, login_attempts, schema_migrations`;
    const r = await migrate(sql, {});
    expect(r.applied).toContain('0001_sessions_and_rate_limits.sql');

    const t = await sql`SELECT to_regclass('sessions') AS s, to_regclass('login_attempts') AS l`;
    expect(t[0].s).not.toBeNull();
    expect(t[0].l).not.toBeNull();
  });
});
