/**
 * **A CLEAN START FOR THE STAGENET RUN, run by RESET-DATA.command.**
 *
 * Moves `.midnight/created-companies.json` into `_to_delete/` under a dated
 * name and empties the sealed-record and session rows in the database named by
 * DATABASE_URL (never TEST_DATABASE_URL, never `ca_test`). Refuses while the run
 * is up, says what it will remove before it removes anything, and wants the word
 * `yes` typed.
 *
 *   tsx scripts/reset-stagenet-store.ts                run it
 *   tsx scripts/reset-stagenet-store.ts --device-steps print how to clear the web app's records on this device
 *
 * Exit 0: done, or nothing to do. 1: refused or failed. 3: stopped at the question.
 */
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { loadEnvFile, describeDb } from '../src/db/connect.js';
import {
  CLEARED_TABLES, CREATED_COMPANIES, emptyTheTables, moveCreatedCompanies, portsOfTheRun, refuseWhileRunning,
  type Database,
} from './reset-stagenet-store-rules.js';

const ROOT = join(import.meta.dirname, '..');
const SNIPPET = 'scripts/clear-web-app-device-records.js';

const listens = (port: number) => new Promise<boolean>((resolve) => {
  const tries = ['127.0.0.1', '::1'].map((host) => new Promise<boolean>((r) => {
    const s = createConnection({ host, port });
    s.setTimeout(1500);
    s.once('connect', () => { s.destroy(); r(true); });
    s.once('timeout', () => { s.destroy(); r(false); });
    s.once('error', () => r(false));
  }));
  Promise.all(tries).then((a) => resolve(a.some(Boolean)));
});

export function deviceSteps(): string {
  return [
    '  CLEARING THE WEB APP\'S OWN RECORDS ON THIS DEVICE (http://localhost:5173 only):',
    '    The company records the page keeps in this browser are not in any file above.',
    '    The wallet at http://localhost:5180 is a different origin and is NOT touched.',
    '      1. Open http://localhost:5173 in the browser you used (the run can be stopped).',
    '      2. Open DevTools (Option+Command+I) and choose the Console tab.',
    `      3. Paste the whole of ${join(ROOT, SNIPPET)} and press Return.`,
    '      4. It refuses on any other address, lists the page\'s databases and stored keys,',
    '         deletes them, lists again and prints what remains. It should say: nothing remains.',
    '      5. Reload the page. Do NOT run it on http://localhost:5180.',
  ].join('\n');
}

async function main(): Promise<number> {
  if (process.argv.includes('--device-steps')) { console.log(deviceSteps()); return 0; }
  const say = (s = '') => console.log(s);
  loadEnvFile();
  const devScript = String((JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {}).dev ?? '');

  say('  THE STAGENET RUN\'S STORE  (.midnight/created-companies.json and the database)');
  say();
  const refusal = await refuseWhileRunning(portsOfTheRun(process.env, devScript), listens);
  if (refusal) { say('  ' + refusal); return 1; }
  say('  The run is not up: its ports are free.');
  say();

  const file = join(ROOT, CREATED_COMPANIES);
  const url = process.env.DATABASE_URL;
  let db: (Database & { unsafe: any }) | undefined;
  const before: Record<string, number> = {};

  say('  WHAT THIS WILL REMOVE:');
  say();
  if (existsSync(file)) {
    const st = statSync(file);
    say(`    MOVE   ${CREATED_COMPANIES}   (${st.size} bytes, last written ${st.mtime.toISOString().replace('T', ' ').slice(0, 19)})`);
    say('           into _to_delete/ under a dated name. It is moved, never deleted.');
  } else say(`    ${CREATED_COMPANIES} is not there: nothing to move.`);
  if (!url) {
    say('    DATABASE_URL is not set, so no database is cleared. Put it in .env and run this again if one should be.');
  } else {
    db = postgres(url, { onnotice: () => {} }) as any;
    say(`    EMPTY  these tables in ${describeDb(url)}, in one transaction:`);
    try {
      for (const t of CLEARED_TABLES) {
        const r = await db!.unsafe(`SELECT count(*)::int AS n FROM ${t}`);
        before[t] = Number(r[0]?.n ?? 0);
        say(`             ${String(before[t]).padStart(6)} rows  ${t}`);
      }
    } catch (e: any) {
      say(`    The tables could not be counted, so nothing was touched: ${String(e?.message ?? e)}`);
      await db!.end();
      return 1;
    }
    say('           Never touched: schema_migrations, login_attempts, any other table or database.');
  }
  say();
  say('  Every company above is sealed. Once its records are gone, what the browser holds opens nothing.');
  say();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('  Type  yes  to do this, or anything else to stop: ');
  rl.close();
  say();
  if (answer !== 'yes') {
    say('  Stopped. Nothing was moved or removed.');
    await db?.end();
    return 3;
  }

  try {
    if (db) {
      const removed = await emptyTheTables(db);
      say('  Removed from the database:');
      for (const t of CLEARED_TABLES) say(`    ${String(removed[t]).padStart(6)} rows  ${t}`);
    }
  } catch (e: any) {
    say(`  THE DATABASE WAS NOT CHANGED (the transaction was rolled back): ${String(e?.message ?? e)}`);
    return 1;
  } finally {
    await db?.end();
  }
  const to = moveCreatedCompanies(
    { exists: existsSync, mkdir: (p) => mkdirSync(p, { recursive: true }), rename: renameSync }, ROOT, new Date());
  if (to) {
    say('  Moved.');
    say(`    from  ${CREATED_COMPANIES}`);
    say(`    to    ${to.slice(ROOT.length + 1)}`);
    say(`  TO UNDO THE FILE: mv ${to.slice(ROOT.length + 1)} ${CREATED_COMPANIES}`);
  } else say(`  ${CREATED_COMPANIES} was not there, so nothing was moved.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((c) => process.exit(c), (e) => { console.error(`  FAILED: ${String(e?.message ?? e)}`); process.exit(1); });
}
