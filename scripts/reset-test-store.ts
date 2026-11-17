/**
 * **A CLEAN START FOR A TEST NETWORK'S RUN, run by RESET-DATA.command.**
 *
 * Moves the network's `created-companies.json` (in its store folder) into
 * `_to_delete/` under a dated name and empties the sealed-record and session
 * rows in the database named by DATABASE_URL (never TEST_DATABASE_URL, never
 * `ca_test`). Refuses a build for a network that settles real money before any
 * connection is opened, and a database whose stamp does not name this same test
 * network before it counts or touches a row. Refuses while the run is up, says
 * what it will remove before it removes anything, and wants the word `yes` typed.
 *
 *   tsx scripts/reset-test-store.ts                run it
 *   tsx scripts/reset-test-store.ts --device-steps print how to clear the web app's records on this device
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
import { storeStamp } from '../src/db/store-network.js';
import { theNetwork, type NetworkName } from '../src/midnight/network.js';
import { createdCompaniesFile } from '../src/wiring/deployment.js';
import {
  CLEARED_TABLES, emptyTheTables, moveCreatedCompanies, portsOfTheRun, refuseUnlessATestNetwork,
  refuseUnlessThisTestStore, refuseWhileRunning, type Database,
} from './reset-test-store-rules.js';

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

type Say = (s?: string) => void;
type Db = Database & { unsafe: any };

/**
 * Opens the database, refuses one whose stamp is not this test network, and counts what the clean start would
 * empty. Answers the open database and the counts, or null when it refused or could not count (said, and closed).
 */
async function countedStore(url: string, network: NetworkName, say: Say): Promise<{ db: Db; before: Record<string, number> } | null> {
  const sql = postgres(url, { onnotice: () => {} });
  const db: Db = sql as any;
  const before: Record<string, number> = {};
  try {
    const notThisStore = refuseUnlessThisTestStore(await storeStamp(sql), network);
    if (notThisStore) { say('  ' + notThisStore); await db.end(); return null; }
    say(`    EMPTY  these tables in ${describeDb(url)}, the store of ${network}, in one transaction:`);
    for (const t of CLEARED_TABLES) {
      const r = await db.unsafe(`SELECT count(*)::int AS n FROM ${t}`);
      before[t] = Number(r[0]?.n ?? 0);
      say(`             ${String(before[t]).padStart(6)} rows  ${t}`);
    }
  } catch (e: any) {
    say(`    The store could not be read, so nothing was touched: ${String(e?.message ?? e)}`);
    await db.end();
    return null;
  }
  say('           Never touched: schema_migrations, login_attempts, store_network, any other table or database.');
  return { db, before };
}

/** Empties the database's tables and moves the created-companies file, saying what was done. */
async function clearTheStore(db: Db | undefined, network: NetworkName, file: string, say: Say): Promise<number> {
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
    { exists: existsSync, mkdir: (p) => mkdirSync(p, { recursive: true }), rename: renameSync }, ROOT, network, new Date());
  const shown = file.slice(ROOT.length + 1);
  if (to) {
    say('  Moved.');
    say(`    from  ${shown}`);
    say(`    to    ${to.slice(ROOT.length + 1)}`);
    say(`  TO UNDO THE FILE: mv ${to.slice(ROOT.length + 1)} ${shown}`);
  } else say(`  ${shown} was not there, so nothing was moved.`);
  return 0;
}

async function main(): Promise<number> {
  if (process.argv.includes('--device-steps')) { console.log(deviceSteps()); return 0; }
  const say: Say = (s = '') => console.log(s);
  loadEnvFile();
  const devScript = String((JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {}).dev ?? '');
  const network = theNetwork();
  const file = createdCompaniesFile(ROOT, network);
  const shown = file.slice(ROOT.length + 1);

  say(`  THE STORE OF THE RUN ON ${network.toUpperCase()}  (${shown} and the database)`);
  say();
  const notATestNetwork = refuseUnlessATestNetwork(network);
  if (notATestNetwork) { say('  ' + notATestNetwork); return 1; }
  const refusal = await refuseWhileRunning(portsOfTheRun(process.env, devScript), listens);
  if (refusal) { say('  ' + refusal); return 1; }
  say('  The run is not up: its ports are free.');
  say();

  const url = process.env.DATABASE_URL;
  let db: Db | undefined;
  say('  WHAT THIS WILL REMOVE:');
  say();
  if (existsSync(file)) {
    const st = statSync(file);
    say(`    MOVE   ${shown}   (${st.size} bytes, last written ${st.mtime.toISOString().replace('T', ' ').slice(0, 19)})`);
    say('           into _to_delete/ under a dated name. It is moved, never deleted.');
  } else say(`    ${shown} is not there: nothing to move.`);
  if (!url) {
    say('    DATABASE_URL is not set, so no database is cleared. Put it in .env and run this again if one should be.');
  } else {
    const counted = await countedStore(url, network, say);
    if (counted === null) return 1;
    db = counted.db;
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
  return clearTheStore(db, network, file, say);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((c) => process.exit(c), (e) => { console.error(`  FAILED: ${String(e?.message ?? e)}`); process.exit(1); });
}
