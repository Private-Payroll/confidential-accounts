/**
 * **THE CLEAN START OF THE STAGENET RUN, with the database and the disk faked.**
 * Nothing here connects to a database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  CLEARED_TABLES, DELETE_GUARDS, KEPT_TABLES, emptyTheTables, moveCreatedCompanies, portsOfTheRun,
  refuseWhileRunning, stamp, type Disk,
} from './reset-stagenet-store-rules.js';

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
    for (const file of ['reset-stagenet-store.ts', 'reset-stagenet-store-rules.ts']) {
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
    const f = fakeDisk(['/r/.midnight/created-companies.json']);
    const to = moveCreatedCompanies(f.disk, '/r', NOW);
    expect(stamp(NOW)).toBe('2026-10-21-1405');
    expect(to).toBe('/r/_to_delete/RESET-2026-10-21-1405-created-companies.json');
    expect(f.moves).toEqual([['/r/.midnight/created-companies.json', to]]);
    expect(f.there.has('/r/.midnight/created-companies.json')).toBe(false);
    expect(f.there.has(to!)).toBe(true);
  });
  it('never overwrites an earlier move and says nothing moved when there is no file', () => {
    const f = fakeDisk(['/r/.midnight/created-companies.json', '/r/_to_delete/RESET-2026-10-21-1405-created-companies.json']);
    expect(moveCreatedCompanies(f.disk, '/r', NOW)).toBe('/r/_to_delete/RESET-2026-10-21-1405-created-companies-2.json');
    expect(moveCreatedCompanies(fakeDisk([]).disk, '/r', NOW)).toBeNull();
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
