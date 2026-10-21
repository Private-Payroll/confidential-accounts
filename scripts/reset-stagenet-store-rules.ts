/**
 * **THE CLEAN START OF THE STAGENET RUN: WHAT IT CLEARS, WHAT IT REFUSES, AND
 * THE ORDER IT DOES THINGS IN.**
 *
 * The stagenet run (scripts/serve-with-wallets.ts) keeps its companies in
 * `.midnight/created-companies.json` and its sealed records and sessions in the
 * database. Everything here takes what it touches as an argument, so the tests
 * run it with a faked database and a faked disk and never connect to anything.
 *
 * It clears only a store `.env` names as one that may be emptied: nothing a
 * database's address says tells a dev or stagenet store from any other, so the
 * person who set the store up says which it is, once, as `STORE_KIND`.
 */
import { join } from 'node:path';
import { leadingAssignments, servableOrigin } from './serve-rules.js';

/**
 * Every table the clean start empties, in the order it empties them. Derived
 * from db/migrations (0001 sessions, 0002 vault_sealed_records, 0004
 * company_sealed_records) and written out here, so a table added by a later
 * migration is never emptied by accident: the test that reads the migrations
 * fails until the new table is put in this list or in KEPT_TABLES.
 *
 * Users are not in the database (a sign-in names its user as text and has no
 * foreign key), and no table holds manifests or pending trees, so nothing else
 * hangs off these three by a foreign key.
 */
export const CLEARED_TABLES = ['sessions', 'company_sealed_records', 'vault_sealed_records'] as const;

/** Tables that exist and are never touched. */
export const KEPT_TABLES = ['schema_migrations', 'login_attempts'] as const;

/**
 * The sealed-record tables refuse every delete through a trigger. The clean
 * start switches that one trigger off inside its transaction, deletes, switches
 * it on again and checks it is on before it commits. The truncate triggers stay
 * on the whole time, and so does every trigger on any other table.
 */
export const DELETE_GUARDS: Readonly<Record<string, string>> = {
  company_sealed_records: 'company_sealed_records_no_update_or_delete',
  vault_sealed_records: 'vault_sealed_records_no_update_or_delete',
};

export const CREATED_COMPANIES = join('.midnight', 'created-companies.json');

/** The stores the clean start may empty, as `STORE_KIND` in `.env` names them, exactly. */
export const RESETTABLE_STORES = ['dev', 'stagenet'] as const;

/**
 * **THE CLEAN START RUNS ONLY ON A STORE NAMED AS ONE THAT MAY BE EMPTIED.**
 * Answers null when `STORE_KIND` is exactly `dev` or `stagenet`, and otherwise
 * the refusal, which says what to set and why. It is decided before any
 * connection is opened, and a value that is nearly right (another case, a
 * space) is refused rather than guessed at.
 */
export function refuseUnlessResettableStore(storeKind: string | undefined): string | null {
  if ((RESETTABLE_STORES as readonly string[]).includes(storeKind ?? '')) return null;
  const said = storeKind === undefined || storeKind === '' ? 'is not set' : `is ${JSON.stringify(storeKind)}`;
  return `THE STORE CANNOT BE CLEARED: STORE_KIND in .env ${said}, so nothing says the database DATABASE_URL names `
    + 'is a dev or stagenet store. Clearing empties the sealed-record tables, which hold every company\'s records '
    + 'and cannot be filed again, so it only runs on a store named as one that may be emptied. If DATABASE_URL in '
    + '.env names the stagenet store, add the line STORE_KIND=stagenet to .env (STORE_KIND=dev for a development '
    + 'store) and run this again. Nothing was moved or removed.';
}

/** Minimal shape of the database handle: what postgres.js gives. */
export interface Tx {
  unsafe<T = any>(query: string): Promise<T[]>;
}
export interface Database {
  begin<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/** Empties the cleared tables in one transaction; returns the rows removed per table. */
export async function emptyTheTables(db: Database): Promise<Record<string, number>> {
  return db.begin(async (tx) => {
    const removed: Record<string, number> = {};
    for (const t of CLEARED_TABLES) {
      const rows = await tx.unsafe<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
      removed[t] = Number(rows[0]?.n ?? 0);
    }
    for (const [table, trigger] of Object.entries(DELETE_GUARDS)) {
      await tx.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    }
    for (const t of CLEARED_TABLES) await tx.unsafe(`DELETE FROM ${t}`);
    for (const [table, trigger] of Object.entries(DELETE_GUARDS)) {
      await tx.unsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
    for (const t of CLEARED_TABLES) {
      const left = await tx.unsafe<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
      if (Number(left[0]?.n ?? 0) !== 0) throw new Error(`${t} still has rows after the delete, so nothing was removed`);
    }
    const off = await tx.unsafe<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgname IN (${Object.values(DELETE_GUARDS).map((g) => `'${g}'`).join(', ')}) AND tgenabled <> 'O'`);
    if (off.length > 0) throw new Error(`the delete guard ${off[0]!.tgname} is still off, so nothing was removed`);
    return removed;
  });
}

/** The ports whose being in use means the service is up: its own, and the two pages. */
export function portsOfTheRun(env: Record<string, string | undefined>, devScript: string): number[] {
  const dev = Object.fromEntries(leadingAssignments(devScript).map((a) => [a.name, a.value]));
  const ports = new Set<number>([Number(env.PORT ?? 8787)]);
  for (const name of ['APP_ORIGIN', 'WALLET_ORIGIN']) {
    const o = servableOrigin(name, dev[name]);
    if ('port' in o) ports.add(Number(o.port));
  }
  return [...ports];
}

/** Null when nothing listens on those ports; the refusal otherwise. */
export async function refuseWhileRunning(
  ports: readonly number[], listens: (port: number) => Promise<boolean>,
): Promise<string | null> {
  const busy: number[] = [];
  for (const p of ports) if (await listens(p)) busy.push(p);
  if (busy.length === 0) return null;
  return `THE STORE CANNOT BE CLEARED: the stagenet run is up (port ${busy.join(' and ')} is in use). `
    + 'The service holds its companies in memory and writes them back on the next change, so clearing now '
    + 'would be undone a moment later. Close the window running npm run dev (or RUN-WEB-ON-STAGENET.command), '
    + 'then run this again. Nothing was moved or removed.';
}

/** `2026-10-21-1405`, local time. */
export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export interface Disk {
  exists(path: string): boolean;
  mkdir(path: string): void;
  rename(from: string, to: string): void;
}

/**
 * Moves the created-companies file into _to_delete/ under a dated name; never
 * deletes it and never overwrites an earlier move. Returns where it went, or
 * null when there was no file.
 */
export function moveCreatedCompanies(disk: Disk, root: string, now: Date): string | null {
  const from = join(root, CREATED_COMPANIES);
  if (!disk.exists(from)) return null;
  const dir = join(root, '_to_delete');
  disk.mkdir(dir);
  const base = `RESET-${stamp(now)}-created-companies`;
  let to = join(dir, `${base}.json`);
  for (let i = 2; disk.exists(to); i++) to = join(dir, `${base}-${i}.json`);
  disk.rename(from, to);
  return to;
}
