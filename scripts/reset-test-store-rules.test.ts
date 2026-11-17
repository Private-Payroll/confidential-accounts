/**
 * **THE CLEAN START OF A TEST NETWORK'S RUN, with the database and the disk faked.**
 * Nothing here connects to a database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  CLEARED_TABLES, DELETE_GUARDS, KEPT_TABLES, emptyTheTables, moveCreatedCompanies, portsOfTheRun,
  refuseUnlessATestNetwork, refuseUnlessThisTestStore, refuseWhileRunning, stamp, type Disk,
} from './reset-test-store-rules.js';
import { networkRecord, NETWORK_IDS } from '../src/core/networks.js';
import { createdCompaniesFile } from '../src/wiring/deployment.js';
import { NETWORK } from 'midnight-identity/network';

const ROOT = join(import.meta.dirname, '..');

function fakeDb(counts: Record<string, number>, failAt?: string) {
  const ran: string[] = [];
  let committed = false;
  const db = {
    async begin<T>(fn: (tx: any) => Promise<T>) {
      const tx = {
        async unsafe(q: string) {
          ran.push(q);
          if (failAt && q.includes(failAt)) throw new Error('boom');
          const m = /^SELECT count\(\*\)::int AS n FROM (\w+)$/.exec(q);
          if (m) return [{ n: ran.filter((x) => x === `DELETE FROM ${m[1]}`).length ? 0 : counts[m[1]!] }];
          return [];
        },
      };
      const r = await fn(tx);
      committed = true;
      return r;
    },
    async end() {},
  };
  return { db, ran, committed: () => committed };
}

describe('the tables the clean start empties', () => {
  /*
   * RED WHEN: the migrations table or login_attempts is in the list, or a table the
   * migrations create is in neither list - a new table would be emptied, or left, unasked.
   */
  it('excludes the migrations table, and every table the migrations create is in exactly one list', () => {
    expect(CLEARED_TABLES as readonly string[]).not.toContain('schema_migrations');
    expect(KEPT_TABLES as readonly string[]).toContain('schema_migrations');
    const created = new Set<string>();
    for (const f of readdirSync(join(ROOT, 'db', 'migrations')).filter((n) => n.endsWith('.sql'))) {
      const sql = readFileSync(join(ROOT, 'db', 'migrations', f), 'utf8');
      for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)/gi)) created.add(m[1]!);
    }
    const listed = [...CLEARED_TABLES, ...KEPT_TABLES].filter((t) => t !== 'schema_migrations');
    expect([...created].sort()).toEqual([...listed].sort());
    expect(new Set([...CLEARED_TABLES, ...KEPT_TABLES]).size).toBe(CLEARED_TABLES.length + KEPT_TABLES.length);
  });

  /*
   * RED WHEN: the run touches the migrations table, any test database (ca_test, its
   * guard in .maintainer/db-setup.ts relies on TEST_DATABASE_URL differing from the real
   * one) or a trigger other than the two delete guards.
   */
  it('never names the migrations table, ca_test or TEST_DATABASE_URL, and only the two delete triggers', async () => {
    const f = fakeDb({ sessions: 2, company_sealed_records: 3, vault_sealed_records: 4 });
    await emptyTheTables(f.db);
    const all = f.ran.join('\n');
    expect(all).not.toMatch(/schema_migrations|login_attempts|ca_test|TRUNCATE|DROP/i);
    expect(f.ran.filter((q) => /TRIGGER/.test(q)).sort()).toEqual([
      'ALTER TABLE company_sealed_records DISABLE TRIGGER company_sealed_records_no_update_or_delete',
      'ALTER TABLE company_sealed_records ENABLE TRIGGER company_sealed_records_no_update_or_delete',
      'ALTER TABLE vault_sealed_records DISABLE TRIGGER vault_sealed_records_no_update_or_delete',
      'ALTER TABLE vault_sealed_records ENABLE TRIGGER vault_sealed_records_no_update_or_delete',
    ]);
    for (const t of Object.keys(DELETE_GUARDS)) expect(CLEARED_TABLES as readonly string[]).toContain(t);
    for (const file of ['reset-test-store.ts', 'reset-test-store-rules.ts']) {
      expect(readFileSync(join(ROOT, 'scripts', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''))
        .not.toMatch(/TEST_DATABASE_URL|ca_test/);
    }
  });

  it('removes every row of every cleared table in one transaction and reports the counts', async () => {
    const f = fakeDb({ sessions: 2, company_sealed_records: 3, vault_sealed_records: 4 });
    expect(await emptyTheTables(f.db)).toEqual({ sessions: 2, company_sealed_records: 3, vault_sealed_records: 4 });
    expect(f.ran.filter((q) => q.startsWith('DELETE FROM')).sort())
      .toEqual(CLEARED_TABLES.map((t) => `DELETE FROM ${t}`).sort());
    expect(f.committed()).toBe(true);
  });

  it('commits nothing when a statement fails', async () => {
    const f = fakeDb({ sessions: 1, company_sealed_records: 1, vault_sealed_records: 1 }, 'DELETE FROM vault_sealed_records');
    await expect(emptyTheTables(f.db)).rejects.toThrow('boom');
    expect(f.committed()).toBe(false);
  });
});

describe('it refuses while the service runs', () => {
  const dev = 'APP_ORIGIN=http://localhost:5173 WALLET_ORIGIN=http://localhost:5180 tsx scripts/serve.ts';
  /*
   * RED WHEN: a listening service port, page port or wallet port does not stop the clean start.
   */
  it('reads the service, page and wallet ports and refuses when any one listens', async () => {
    expect(portsOfTheRun({}, dev).sort()).toEqual([5173, 5180, 8787]);
    expect(portsOfTheRun({ PORT: '9000' }, dev)).toContain(9000);
    expect(await refuseWhileRunning([8787, 5173], async (p) => p === 8787)).toMatch(/8787 is in use/);
    expect(await refuseWhileRunning([8787, 5173], async () => true)).toMatch(/8787 and 5173/);
    expect(await refuseWhileRunning([8787, 5173], async () => false)).toBeNull();
  });
});

describe('the created-companies file is moved, not deleted', () => {
  function fakeDisk(files: string[]) {
    const there = new Set(files);
    const moves: Array<[string, string]> = [];
    const disk: Disk = {
      exists: (p) => there.has(p),
      mkdir: () => {},
      rename: (a, b) => { there.delete(a); there.add(b); moves.push([a, b]); },
    };
    return { disk, moves, there };
  }
  const NOW = new Date(2026, 9, 21, 14, 5, 59);
  /*
   * RED WHEN: the file is removed rather than renamed into _to_delete, the name carries no
   * date, or a second reset in the same minute overwrites the first.
   */
  it('renames it into _to_delete under a dated name', () => {
    /* RED WHEN the file is looked for anywhere but the network's own store folder. */
    expect(createdCompaniesFile('/r', NETWORK)).toBe(`/r/.midnight/${NETWORK}/created-companies.json`);
    const f = fakeDisk([`/r/.midnight/${NETWORK}/created-companies.json`]);
    const to = moveCreatedCompanies(f.disk, '/r', NETWORK, NOW);
    expect(stamp(NOW)).toBe('2026-10-21-1405');
    expect(to).toBe('/r/_to_delete/RESET-2026-10-21-1405-created-companies.json');
    expect(f.moves).toEqual([[`/r/.midnight/${NETWORK}/created-companies.json`, to]]);
    expect(f.there.has(`/r/.midnight/${NETWORK}/created-companies.json`)).toBe(false);
    expect(f.there.has(to!)).toBe(true);
  });
  it('never overwrites an earlier move and says nothing moved when there is no file', () => {
    const f = fakeDisk([`/r/.midnight/${NETWORK}/created-companies.json`, '/r/_to_delete/RESET-2026-10-21-1405-created-companies.json']);
    expect(moveCreatedCompanies(f.disk, '/r', NETWORK, NOW)).toBe('/r/_to_delete/RESET-2026-10-21-1405-created-companies-2.json');
    expect(moveCreatedCompanies(fakeDisk([]).disk, '/r', NETWORK, NOW)).toBeNull();
  });
});

describe('the console snippet clears http://localhost:5173 and nothing else', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'clear-web-app-device-records.js'), 'utf8');
  function page(origin: string) {
    const mk = () => { const data: Record<string, string> = { a: '1', b: '2' };
      return new Proxy(data, { get: (t, k) => k === 'clear' ? () => { for (const x of Object.keys(t)) delete t[x]; } : (t as any)[k], ownKeys: (t) => Reflect.ownKeys(t) }); };
    let dbs = ['payroll', 'keys'];
    const deleted: string[] = [];
    const logs: string[] = [];
    const ctx: any = {
      location: { origin },
      localStorage: mk(), sessionStorage: mk(),
      indexedDB: {
        databases: async () => dbs.map((name) => ({ name })),
        deleteDatabase: (name: string) => {
          const r: any = {};
          setTimeout(() => { dbs = dbs.filter((d) => d !== name); deleted.push(name); r.onsuccess?.(); }, 0);
          return r;
        },
      },
      console: { log: (...a: any[]) => logs.push(a.join(' ')), error: (...a: any[]) => logs.push('ERR ' + a.join(' ')) },
      setTimeout,
    };
    return { ctx, deleted, logs };
  }
  /*
   * RED WHEN: the snippet deletes on any origin other than http://localhost:5173 - the wallet
   * at http://localhost:5180 holds keys that open every company.
   */
  it.each(['http://localhost:5180', 'http://localhost:5173.evil.test', 'https://localhost:5173', 'http://127.0.0.1:5173'])(
    'refuses on %s and deletes nothing', async (origin) => {
      const p = page(origin);
      const r = await runInNewContext(source, p.ctx);
      expect(r).toEqual({ refused: true, origin });
      expect(p.deleted).toEqual([]);
      expect(Object.keys(p.ctx.localStorage)).toEqual(['a', 'b']);
      expect(p.logs.join('\n')).toMatch(/REFUSED/);
    });
  it('on its own origin lists, deletes, lists again and says nothing remains', async () => {
    const p = page('http://localhost:5173');
    const r = await runInNewContext(source, p.ctx);
    expect(r.before.indexedDB).toEqual(['keys', 'payroll']);
    expect(r.after).toEqual({ indexedDB: [], localStorage: [], sessionStorage: [] });
    expect(p.deleted.sort()).toEqual(['keys', 'payroll']);
    expect(p.logs.join('\n')).toMatch(/NOTHING REMAINS on http:\/\/localhost:5173/);
  });
});

describe('the clean start runs only on the store of a test network, as the database itself says', () => {
  const REAL = NETWORK_IDS.filter((id) => networkRecord(id).kind === 'real');
  const TEST = NETWORK_IDS.filter((id) => networkRecord(id).kind === 'test');

  /* RED WHEN a build for a network that settles real money can clear its store, by any setting. */
  it('refuses a build for a real network before anything is opened, and says nothing was removed', () => {
    expect(REAL.length).toBeGreaterThan(0);
    for (const network of REAL) {
      const said = refuseUnlessATestNetwork(network);
      expect(said, network).toMatch(/^THE STORE CANNOT BE CLEARED/);
      expect(said).toContain('settles real money');
      expect(said).toMatch(/Nothing was moved or removed\.$/);
      /* And a database stamped for that real network is refused too, even by a build for it. */
      expect(refuseUnlessThisTestStore(network, network), network).toMatch(/settles real money/);
    }
    expect(refuseUnlessATestNetwork('no-such-network')).toMatch(/^THE STORE CANNOT BE CLEARED/);
    /* RED WHEN a name with no record is described as a network that settles real money. */
    expect(refuseUnlessATestNetwork('no-such-network')).toContain('has no record of');
    expect(refuseUnlessATestNetwork('no-such-network')).not.toContain('settles real money');
  });

  /* RED WHEN a database that does not say which network it holds, or says another, is emptied. */
  it('refuses a database with no stamp, or stamped for another network, saying what resolves it', () => {
    expect(refuseUnlessThisTestStore(null, NETWORK)).toContain(`does not say which network's store it holds. What resolves it: if the database is empty, start RUN-WEB.command on ${NETWORK} once`);
    expect(refuseUnlessThisTestStore(null, NETWORK)).toContain(`point DATABASE_URL at an empty database for ${NETWORK}`);
    const other = refuseUnlessThisTestStore('stagenet', NETWORK);
    expect(other).toContain(`holds stagenet's store, and this build is for ${NETWORK}`);
    expect(other).toContain(`What resolves it: point DATABASE_URL in .env at ${NETWORK}'s own database`);
  });

  /* RED WHEN the store of a test network, stamped as such, is refused, so a clean start can never run. */
  it('lets the store of a test network, stamped for it, be cleared', () => {
    expect(TEST).toContain('preprod');
    for (const network of TEST) {
      expect(refuseUnlessATestNetwork(network), network).toBeNull();
      expect(refuseUnlessThisTestStore(network, network), network).toBeNull();
    }
  });

  /* RED WHEN the clean start opens a connection before the network is decided, or counts rows before the stamp is read. */
  it('decides on the network before any connection is opened, and on the stamp before a row is counted', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'reset-test-store.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const decided = script.indexOf('refuseUnlessATestNetwork(network)');
    expect(decided).toBeGreaterThan(-1);
    /* The one place a connection is opened is the counting, and main reaches it only after the network is decided. */
    expect(script.match(/postgres\(url/gu)).toHaveLength(1);
    expect(script.indexOf('postgres(url')).toBeGreaterThan(script.indexOf('async function countedStore('));
    expect(decided).toBeLessThan(script.indexOf('await countedStore(url'));
    expect(script.slice(decided, decided + 160)).toMatch(/if \(notATestNetwork\) \{ say\('  ' \+ notATestNetwork\); return 1; \}/);
    const stamped = script.indexOf('refuseUnlessThisTestStore(await storeStamp(sql), network)');
    expect(stamped).toBeGreaterThan(script.indexOf('postgres(url'));
    expect(stamped).toBeLessThan(script.indexOf('SELECT count(*)'));
    expect(script.slice(stamped, stamped + 200)).toMatch(/if \(notThisStore\) \{ say\('  ' \+ notThisStore\); await db\.end\(\); return null; \}/);
  });
});
