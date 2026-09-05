/**
 * Applies the migrations. Run by `DB.command`, or `npm run migrate`.
 *
 * Takes the connection string from `DATABASE_URL`, or from `--test` to use
 * `TEST_DATABASE_URL` instead. Prints the host and database it is talking to,
 * never the password.
 */
import postgres from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { loadEnvFile, describeDb } from '../src/db/connect.js';

loadEnvFile();

const useTest = process.argv.includes('--test');
const key = useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
const url = process.env[key];

if (!url) {
  console.error(`\n  ${key} is not set. Put it in .env — never on the command line,\n` +
                `  where it lands in your shell history.\n`);
  process.exit(1);
}

const sql = postgres(url, { onnotice: () => {} });

try {
  console.log(`  database   ${describeDb(url)}`);
  const r = await migrate(sql as any, { log: m => console.log(`  ${m}`) });

  if (r.applied.length === 0) {
    console.log(`  up to date (${r.alreadyApplied.length} already applied)`);
  } else {
    console.log(`  applied ${r.applied.length}: ${r.applied.join(', ')}`);
  }
} catch (e: any) {
  console.error(`\n  MIGRATION FAILED\n`);
  console.error(`  ${String(e?.message ?? e).split('\n').join('\n  ')}\n`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
