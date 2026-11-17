/**
 * A database holds one network's store: the service stamps it on its first start and refuses it under any other
 * network. The database is a stand-in that keeps the one row the stamp table holds; nothing here connects to one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { refuseAStoreOfAnotherNetwork, stampedFor, storeStamp, type StampSql } from './store-network.js';
import { CLEARED_TABLES } from '../../scripts/reset-test-store-rules.js';
import { NETWORK } from 'midnight-identity/network';

/** A network other than the one this build is compiled for. */
const OTHER = 'preview';

/** A stand-in for `store_network` (one row at most, written by an insert only while there is none) and the record tables. */
const aStore = (stamped: string | null = null, holdsRecords = false): StampSql & { readonly row: () => string | null; readonly asked: string[] } => {
  let row = stamped;
  const asked: string[] = [];
  const sql = async (strings: TemplateStringsArray, ...values: string[]) => {
    const text = strings.join('$');
    asked.push(text);
    if (/EXISTS \(SELECT 1 FROM sessions\)/u.test(text)) return [{ held: holdsRecords }];
    if (/^\s*INSERT INTO store_network/u.test(text)) {
      expect(text).toMatch(/ON CONFLICT \(one_row\) DO NOTHING/u);
      if (row === null) row = values[0]!;
      return [];
    }
    expect(text).toMatch(/^\s*SELECT network FROM store_network\s*$/u);
    return row === null ? [] : [{ network: row }];
  };
  return Object.assign(sql, { row: () => row, asked });
};

describe('a database\'s store names its network, and a service of another network does not serve it', () => {
  it('a store never stamped is stamped with the network the service is built for, and served', async () => {
    const store = aStore();
    /* RED WHEN the first start stops writing the stamp, or writes a network other than its own. */
    expect(await stampedFor(store, NETWORK)).toEqual({ stamped: NETWORK, unstampedWithRecords: false });
    expect(store.row()).toBe(NETWORK);
    expect(refuseAStoreOfAnotherNetwork({ stamped: NETWORK, unstampedWithRecords: false }, NETWORK)).toBeNull();
  });

  it('a store stamped for another network keeps its stamp, and the service refuses it, naming what resolves it', async () => {
    const store = aStore(OTHER);
    /* RED WHEN a later start overwrites the stamp with its own network, which would make every store look like its own. */
    expect(await stampedFor(store, NETWORK)).toEqual({ stamped: OTHER, unstampedWithRecords: false });
    expect(store.row()).toBe(OTHER);
    const refusal = refuseAStoreOfAnotherNetwork({ stamped: OTHER, unstampedWithRecords: false }, NETWORK);
    /* RED WHEN a store stamped for another network is served. */
    expect(refusal).not.toBeNull();
    expect(refusal).toContain(`"${OTHER}"`);
    expect(refusal).toContain(`"${NETWORK}"`);
    expect(refusal).toContain(`What resolves it: point DATABASE_URL in .env at ${NETWORK}'s own database`);
  });

  it('a store whose stamp cannot be read back is refused, not served as if it were this network\'s', async () => {
    /* RED WHEN an empty answer after the write is taken as a store of this network. */
    expect(refuseAStoreOfAnotherNetwork({ stamped: null, unstampedWithRecords: false }, NETWORK)).toMatch(/DOES NOT SAY WHICH NETWORK/u);
    expect(await storeStamp(aStore())).toBeNull();
  });

  it('the service asks before it makes its sessions, and stops on the answer', () => {
    const index = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
    const asked = index.indexOf('refuseAStoreOfAnotherNetwork(await stampedFor(sql, NETWORK), NETWORK)');
    /* RED WHEN the server stops asking, or asks after it has started using the database. */
    expect(asked).toBeGreaterThan(index.indexOf('await refuseWhileMigrationsPending(sql'));
    expect(asked).toBeLessThan(index.indexOf('sessions = new PostgresSessionStore(sql);'));
    expect(index.indexOf('process.exit(1);', asked)).toBeLessThan(index.indexOf('sessions = new PostgresSessionStore(sql);'));
  });

  it('A STORE THAT HOLDS RECORDS AND NO STAMP IS NEVER STAMPED, and the service refuses it, naming what resolves it', async () => {
    const store = aStore(null, true);
    /* RED WHEN an unstamped store already holding another network's records is adopted by whichever network starts first. */
    expect(await stampedFor(store, NETWORK)).toEqual({ stamped: null, unstampedWithRecords: true });
    expect(store.row()).toBeNull();
    expect(store.asked.some((q) => /INSERT INTO store_network/u.test(q))).toBe(false);
    const refusal = refuseAStoreOfAnotherNetwork({ stamped: null, unstampedWithRecords: true }, NETWORK);
    expect(refusal).toMatch(/HOLDS RECORDS AND DOES NOT SAY WHICH NETWORK WROTE THEM/u);
    expect(refusal).toContain(`What resolves it: point DATABASE_URL in .env at an empty database for ${NETWORK}`);
  });

  /* RED WHEN the emptiness question leaves out a table the clean start empties, or asks of one it does not. */
  it('a store is empty when every table the clean start empties is empty', async () => {
    const store = aStore();
    await stampedFor(store, NETWORK);
    const question = store.asked.find((q) => /EXISTS/u.test(q))!;
    expect([...question.matchAll(/FROM (\w+)\)/gu)].map((m) => m[1]).sort()).toEqual([...CLEARED_TABLES].sort());
  });

  it('the stamp table is a migration of its own, holding one row', () => {
    const migration = readFileSync(new URL('../../db/migrations/0013_store_network.sql', import.meta.url), 'utf8');
    /* RED WHEN the table can hold a second row, which would let a store name two networks. */
    expect(migration).toMatch(/one_row boolean PRIMARY KEY DEFAULT true CHECK \(one_row\)/u);
    expect(migration).toMatch(/network text NOT NULL/u);
  });
});
