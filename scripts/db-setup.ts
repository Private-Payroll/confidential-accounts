/**
 * Everything `DB.command` does. Run it through that; this is the whole body.
 *
 * WHY THIS IS TYPESCRIPT AND NOT SHELL. The first version parsed `.env` twice —
 * once in bash to compare the two connection strings, once here to connect —
 * and two parsers for one file is precisely the shape that produces "the guard
 * said they were different and the migration went to the wrong database".
 * `write every rule once` applies to a config file as much as to a circuit.
 *
 * The other reason: **a connection string is a password**, and bash would have
 * to hold it in a variable to pass it to vitest. Here it goes straight into a
 * child process's environment and is never interpolated into anything a log
 * could capture. Nothing in this file prints a URL.
 */
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { loadEnvFile, describeDb, sameDatabase } from '../src/db/connect.js';

loadEnvFile();

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim();

const die = (msg: string): never => {
  console.error(`\n${msg}\n`);
  process.exit(1);
};

if (!DATABASE_URL) {
  die(
    '  DATABASE_URL is missing or empty in .env.\n\n' +
    '  In Neon: your project → Connection Details → copy the connection string.\n' +
    '  It looks like:\n\n' +
    '      postgres://user:password@ep-something.neon.tech/neondb?sslmode=require\n\n' +  // not-a-secret: a made-up example, kept so the scanner is strict by default
    '  Put it in .env, never on a command line — that is your shell history.',
  );
}

/*
 * THE GUARD lives in src/db/connect.ts, where it is tested and mutation-tested,
 * rather than here where it would be a script nobody runs twice. It compares
 * the two strings AFTER parsing: the same database reached by two spellings — a
 * trailing slash, a different sslmode, a different user — is still the same
 * database, and string equality waves every one of those through.
 */
/**
 * If there is no TEST_DATABASE_URL, make one.
 *
 * The alternative is asking a human to create a second database and paste a
 * second connection string, and the most likely outcome of that is the SAME
 * string twice — at which point the test suite TRUNCATEs the real data. The
 * guard below would catch it, but the best guard is not needing one.
 *
 * A second database on the same Neon project rather than a branch: it is one
 * `CREATE DATABASE`, it costs nothing, and it is reached by changing the last
 * part of the connection string, so there is no second password to keep.
 */
const derivedTestUrl = (url: string, name = 'ca_test') => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

async function ensureTestDatabase(adminUrl: string): Promise<string | undefined> {
  const wanted = derivedTestUrl(adminUrl);
  const name = new URL(wanted).pathname.slice(1);
  const admin = postgres(adminUrl, { onnotice: () => {} });
  try {
    const rows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_database WHERE datname = ${name}`;
    if (rows[0].n === 0) {
      console.log(`  creating a separate test database: ${name} (first run only)`);
      // CREATE DATABASE cannot run inside a transaction, hence unsafe().
      await admin.unsafe(`CREATE DATABASE "${name}"`);
    }
    return wanted;
  } catch (e: any) {
    console.log(`  could not create a test database (${e?.code ?? 'error'}).`);
    console.log('  The suite will run without one, and the database-backed tests will skip.');
    return undefined;
  } finally {
    await admin.end();
  }
}

if (TEST_DATABASE_URL && sameDatabase(DATABASE_URL, TEST_DATABASE_URL)) {
  die(
    '  STOPPED. DATABASE_URL and TEST_DATABASE_URL are the same database.\n\n' +
    '  The tests TRUNCATE tables. Running them against the real database would\n' +
    '  delete every live session and every rate-limit bucket.\n\n' +
    '  Simplest fix: DELETE the TEST_DATABASE_URL line from .env entirely.\n' +
    '  With it absent this script creates a separate `ca_test` database on the\n' +
    '  same project and uses that, so there is nothing to get wrong.',
  );
}

async function applyTo(url: string, label: string) {
  console.log(`  ${label}   ${describeDb(url)}`);
  const sql = postgres(url, { onnotice: () => {} });
  try {
    const r = await migrate(sql as any, { log: m => console.log(`  ${m}`) });
    console.log(r.applied.length
      ? `  applied ${r.applied.length}: ${r.applied.join(', ')}`
      : `  up to date (${r.alreadyApplied.length} already applied)`);
  } finally {
    await sql.end();
  }
}

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;

console.log('-- 1/4  migrating the main database ------------------------------------\n');
try {
  await applyTo(DATABASE_URL, 'database');
} catch (e: any) {
  die(`  MIGRATION FAILED\n\n  ${String(e?.message ?? e).split('\n').join('\n  ')}`);
}
console.log();

/*
 * Only auto-create when nothing was configured. If a TEST_DATABASE_URL is set,
 * that is a deliberate choice — a Neon branch, say — and inventing a different
 * one behind it would be the surprising thing.
 */
let testUrl = TEST_DATABASE_URL;
if (!testUrl) {
  /*
   * The old heading here said "no TEST_DATABASE_URL set, so making one" on
   * EVERY run, which reads as though it rebuilds the test database each time.
   * It does not — it checks, and creates only if the database is missing. A
   * status line that overstates what happened is the same failure as a test
   * that claims more than it checks.
   *
   * The connection string is derived from DATABASE_URL each run rather than
   * written into .env, so there is one password in one place and no way for
   * the two to drift apart. That reasoning belongs here, not in the output of
   * every run.
   */
  testUrl = await ensureTestDatabase(DATABASE_URL);
  if (testUrl) console.log(`  test db    ${describeDb(testUrl)}\n`);
}

if (!testUrl) {
  console.log('-- 2/4  no TEST_DATABASE_URL, so the suite runs without a database -----\n');
  console.log('  The database-backed tests will SKIP — read the count the suite prints');
  console.log('  rather than trusting a number written here. They are the ones that');
  console.log('  prove the Postgres halves work: the concurrency test that a');
  console.log('  read-then-write limiter fails, the restart test that sessions survive a');
  console.log('  new process, and the migration runner against a real database.\n');
  console.log('  To run them: make a BRANCH of your Neon project and add its connection');
  console.log('  string to .env as TEST_DATABASE_URL. A branch is a separate database,');
  console.log('  which matters because the tests TRUNCATE tables.\n');

  console.log('-- 3/4  full suite (Postgres halves skipped) ---------------------------\n');
  run('./node_modules/.bin/vitest', ['run']);
  console.log();
  console.log('-- 4/4  session mutations (twelve of seventeen) ------------------------\n');
  run('./MUTATE-SESSIONS.command', []);
} else {
  console.log('-- 2/4  the test database ----------------------------------------------\n');
  try {
    await applyTo(testUrl, 'test db ');
  } catch (e: any) {
    die(`  TEST MIGRATION FAILED\n\n  ${String(e?.message ?? e).split('\n').join('\n  ')}`);
  }
  console.log();

  console.log('-- 3/4  full suite, WITH the database ----------------------------------\n');
  console.log('  The normally-skipped tests run this time. Read the skip count at the');
  console.log('  end: it should be 0.\n');
  run('./node_modules/.bin/vitest', ['run'], { TEST_DATABASE_URL: testUrl });
  console.log();

  console.log('-- 4/4  session mutations, all seventeen -------------------------------\n');
  run('./MUTATE-SESSIONS.command', [], { TEST_DATABASE_URL: testUrl });
}

console.log();
console.log('=======================================================================');
console.log('  READ THE COUNTS ABOVE, NOT THIS LINE.');
console.log();
console.log("  The suite prints  'Tests  N passed | M skipped'.  With a test database");
console.log('  M MUST BE 0. Every skipped test is a thing nobody has checked.');
console.log();
/*
 * NO EXPECTED SKIP COUNT IS PRINTED HERE ANY MORE, and the reason is M-133.
 *
 * This block used to say the number should be 33 without a database. It was 34,
 * and had been for some time — so anybody comparing the two was chasing a
 * phantom, and a REAL drift of one test would have been invisible against the
 * noise. A hardcoded expectation that nothing updates is worse than no
 * expectation: it looks like a check and is a rumour.
 *
 * The rule that survives is the one that cannot rot: with a test database the
 * skip count is zero, and anything else is a gate with a hole in it.
 */
console.log();
console.log('  The mutation run prints  caught / survived / skipped.  Survived must be');
console.log('  zero: a survivor is a bug the tests would not notice.');
console.log('=======================================================================');
