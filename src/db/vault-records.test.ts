/**
 * **A VAULT'S SEALED RECORDS IN THE PRODUCT'S DATABASE**, against a real
 * Postgres.
 *
 * What is pinned: one writer per version, decided by the table and watched
 * across two connections; versions that follow one another; a write that
 * commits durably whatever the server's default is; rows that can never be
 * changed or removed; a row that is not what was written being refused rather
 * than opened; the vault's address kept out of every column but the sealed
 * body; and the pool and both journals working through the classes the ledger
 * is handed.
 *
 * **THIS FILE GETS ITS OWN DATABASE**, for the reason `migrate.test.ts` gives:
 * it changes a database default, and the files beside it share the other one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  PostgresVaultRecords, openVaultRecords, vaultKeyOf, whyCommitsMayNotBeDurable,
  refuseVaultsTheOperatorToolsKeep, VaultRecordUnreadable, assertCommitsAreDurable,
  NOTHING_IS_KEPT_ELSEWHERE,
} from './vault-records.js';
import {
  sealPool, openPool, SealedNotePool, VaultPoolVersionAlreadyFiled, type PoolSigner,
} from '../midnight/vault-pool.js';
import { PaymentJournalInStore, DepositJournalInStore, attemptsFromJournalVersions } from '../midnight/vault-journal.js';
import { newWrappingKeypair } from '../core/crypto.js';
import { depositNonceKeyFor } from '../midnight/deposit-nonce.js';

const DB = process.env.TEST_DATABASE_URL;
const withDb = DB ? describe : describe.skip;
const OWN_DB = 'ca_test_vault_records';
const MIGRATION = 'db/migrations/0002_vault_sealed_records.sql';
const GBP = '9b'.repeat(32);

/** A vault no other test has used, so nothing here depends on what ran before. */
const aVault = (): string => randomBytes(32).toString('hex');

const signers = () => {
  const k = newWrappingKeypair();
  return { list: [{ id: 'ada', wrappingPublicKey: k.publicKey }] as PoolSigner[], secret: k.secret };
};

describe('what makes a commit durable on a server', () => {
  it('accepts a server that flushes its log', () => {
    expect(whyCommitsMayNotBeDurable({ fsync: 'on', neonTimeline: null })).toBeNull();
  });

  it('accepts a server that makes a commit durable by replicating its log, which reports fsync off', () => {
    expect(
      whyCommitsMayNotBeDurable({ fsync: 'off', neonTimeline: '22b046870ee624e560b7e6146796576b' }),
      'RED WHEN: the product\'s own database - measured reporting fsync off and a Neon timeline - is refused',
    ).toBeNull();
  });

  it('REFUSES a server that neither flushes nor replicates, and names what resolves it', () => {
    const why = whyCommitsMayNotBeDurable({ fsync: 'off', neonTimeline: null });
    expect(why, 'RED WHEN: a store whose acknowledged writes can vanish is accepted').not.toBeNull();
    expect(why).toMatch(/What resolves it: turn fsync on/);
    expect(whyCommitsMayNotBeDurable({ fsync: 'off', neonTimeline: '' }),
      'RED WHEN: an empty timeline setting is read as a replicated log').not.toBeNull();
  });
});

describe('a vault is filed under a hash of its address, never the address', () => {
  it('is 32 bytes, differs per vault, and does not contain the address', () => {
    const a = aVault(); const b = aVault();
    expect(vaultKeyOf(a)).toHaveLength(32);
    expect(vaultKeyOf(a).equals(vaultKeyOf(b))).toBe(false);
    expect(vaultKeyOf(a).toString('hex'), 'RED WHEN: the key is the address').not.toContain(a.slice(0, 16));
    expect(vaultKeyOf(a).equals(vaultKeyOf(a))).toBe(true);
  });
});

describe('a vault the operator tools keep in files is not given a second record here', () => {
  const stateWith = (registry: unknown, name = 'stagenet-vaults.json'): string => {
    const d = mkdtempSync(join(tmpdir(), 'vault-records-state-'));
    writeFileSync(join(d, name), typeof registry === 'string' ? registry : JSON.stringify(registry));
    return d;
  };
  const registryNaming = (address: string) => ({
    network: 'stagenet', savedAt: '2026-09-16T00:00:00.000Z',
    vaults: {
      'payroll-test-9': {
        name: 'payroll-test-9', contractAddress: address, accountAddress: '00'.repeat(32),
        deployedAt: '2026-09-16T00:00:00.000Z', circuits: [],
        maintenanceAuthority: { kind: 'single-key', committeeSize: 1, threshold: 1 },
        adopted: true, deployTx: null,
      },
    },
  });

  it('REFUSES the first version of a vault a registry in the state folder names, without printing the address', () => {
    const v = aVault();
    const why = refuseVaultsTheOperatorToolsKeep(stateWith(registryNaming(v)))(v);
    expect(why, 'RED WHEN: a vault the doors keep in files gets a second record in the database').not.toBeNull();
    expect(why).toContain('payroll-test-9');
    expect(why).not.toContain(v);
  });

  it('lets through a vault no registry names, and a machine with no state folder', () => {
    expect(refuseVaultsTheOperatorToolsKeep(stateWith(registryNaming(aVault())))(aVault())).toBeNull();
    expect(refuseVaultsTheOperatorToolsKeep(join(tmpdir(), `absent-${randomBytes(4).toString('hex')}`))(aVault())).toBeNull();
  });

  it('REFUSES when a registry cannot be read, because an unreadable registry may name the vault', () => {
    expect(
      refuseVaultsTheOperatorToolsKeep(stateWith('{ not json'))(aVault()),
      'RED WHEN: an unreadable registry is treated as one naming nothing',
    ).toMatch(/could not be read/);
  });
});

withDb('against a real database', () => {
  let admin: any;
  let sql: any;
  let second: any;
  let url: string;
  let records: PostgresVaultRecords;

  beforeAll(async () => {
    const { default: postgres } = await import('postgres');
    admin = postgres(DB!, { onnotice: () => {} });
    const [row] = await admin`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${OWN_DB}`;
    if (row.n === 0) await admin.unsafe(`CREATE DATABASE "${OWN_DB}"`);
    const u = new URL(DB!);
    u.pathname = `/${OWN_DB}`;
    url = u.toString();
    sql = postgres(url, { onnotice: () => {} });
    second = postgres(url, { onnotice: () => {} });
    const [me] = await sql`SELECT current_database() AS db`;
    if (me.db !== OWN_DB) throw new Error(`refusing to run: connected to ${me.db}, not ${OWN_DB}`);
    await sql.unsafe(readFileSync(MIGRATION, 'utf8'));
    records = await openVaultRecords(sql, { refuseToCreate: NOTHING_IS_KEPT_ELSEWHERE });
  });

  afterAll(async () => {
    for (const c of [sql, second, admin]) if (c) await c.end({ timeout: 2 });
  });

  it('the migration applies twice, as a migration runner re-run would', async () => {
    await expect(sql.unsafe(readFileSync(MIGRATION, 'utf8'))).resolves.toBeDefined();
  });

  it('this server passes the durability check', async () => {
    await expect(assertCommitsAreDurable(sql)).resolves.toBeUndefined();
  });

  it('A TIMELINE A SESSION INVENTS IS NOT BELIEVED: only one the server\'s own configuration defines', async () => {
    /* This server flushes; the wrapper makes it read as one that does not, inside a transaction that invents a Neon timeline. */
    await sql.begin(async (tx: any) => {
      await tx`SET LOCAL neon.timeline_id = 'invented'`;
      const [seen] = await tx`SELECT current_setting('neon.timeline_id', true) AS t`;
      expect(seen.t, 'the fixture did not take: the session has no invented timeline').toBe('invented');
      const readsAsNotFlushing: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
        const swapped = strings.map((s) => s.replace("current_setting('fsync')", "'off'::text"));
        return tx(Object.assign(swapped, { raw: swapped }), ...values);
      };
      await expect(
        assertCommitsAreDurable(readsAsNotFlushing),
        'RED WHEN: any session can make a server that does not flush pass the durability check by setting one name',
      ).rejects.toThrow(/fsync off/);
    });
  });

  it('A VAULT HAS ONE SPELLING: capitals or a 0x are refused by every read and write, and nothing is filed', async () => {
    const v = aVault(); const s = signers();
    const pool = records.of('pool');
    for (const other of [v.toUpperCase(), `0x${v}`]) {
      await expect(pool.get(other),
        'RED WHEN: a second spelling reads as a vault with no record, which invites a second first version').rejects.toThrow(/64 lower-case hex/);
      await expect(pool.versions(other)).rejects.toThrow(/64 lower-case hex/);
      const refused = await pool.put(other, sealPool(other, { notes: [] }, s.list, 1)).then(() => null, (e: Error) => e);
      expect(refused?.message, 'RED WHEN: a second spelling is filed as a second series').toMatch(/64 lower-case hex/);
      expect(refused?.message, 'RED WHEN: the refusal prints the address').not.toContain(v);
    }
    expect(await pool.get(v)).toBeNull();
    expect(() => vaultKeyOf(v.toUpperCase())).toThrow(/64 lower-case hex/);
  });

  it('the store is only ever opened through the durability check, typed or not', () => {
    const Unchecked = PostgresVaultRecords as unknown as new (...a: unknown[]) => unknown;
    expect(() => new Unchecked(sql, NOTHING_IS_KEPT_ELSEWHERE),
      'RED WHEN: the store can be constructed without the durability check having been asked').toThrow(/openVaultRecords/);
    expect(() => new Unchecked(Symbol('opened after the durability check'), sql, NOTHING_IS_KEPT_ELSEWHERE),
      'RED WHEN: a token anyone can make opens the store').toThrow(/openVaultRecords/);
  });

  it('answers null for a record never filed, files version 1, and reads it back whole', async () => {
    const v = aVault(); const s = signers();
    const pool = records.of('pool');
    expect(await pool.get(v), 'RED WHEN: an absent record reads as something').toBeNull();
    expect(await pool.versions(v)).toEqual([]);
    const rec = sealPool(v, { notes: [{ nonce: '11'.repeat(32), token: GBP, value: 700n }] }, s.list, 1);
    await pool.put(v, rec);
    const back = await pool.get(v);
    expect(back).toEqual(JSON.parse(JSON.stringify(rec)));
    expect(openPool(back!, 'ada', s.secret).notes[0]!.value).toBe(700n);
    expect((await pool.versions(v)).map((x) => x.version)).toEqual([1]);
  });

  it('the three records of one vault are three series, and two vaults never see each other', async () => {
    const v = aVault(); const w = aVault(); const s = signers();
    await records.of('pool').put(v, sealPool(v, { notes: [] }, s.list, 1));
    await records.of('payment-journal').put(v, sealPool(v, { notes: [] }, s.list, 1));
    expect(await records.of('deposit-journal').get(v),
      'RED WHEN: a record is looked up without its kind, so a journal reads as the pool').toBeNull();
    expect(await records.of('pool').get(w), 'RED WHEN: one vault reads another\'s pool').toBeNull();
  });

  it('ONE WRITER PER VERSION, across two connections: of two writers filing the same version, exactly one is filed and the other is told by name', async () => {
    const s = signers();
    const a = (await openVaultRecords(sql, { refuseToCreate: NOTHING_IS_KEPT_ELSEWHERE })).of('pool');
    const b = (await openVaultRecords(second, { refuseToCreate: NOTHING_IS_KEPT_ELSEWHERE })).of('pool');
    let lost = 0;
    for (let round = 0; round < 25; round += 1) {
      const v = aVault();
      await a.put(v, sealPool(v, { notes: [] }, s.list, 1));
      const mine = sealPool(v, { notes: [{ nonce: '01'.repeat(32), token: GBP, value: 1n }] }, s.list, 2);
      const theirs = sealPool(v, { notes: [{ nonce: '02'.repeat(32), token: GBP, value: 2n }] }, s.list, 2);
      const outcomes = await Promise.allSettled([a.put(v, mine), b.put(v, theirs)]);
      const won = outcomes.filter((o) => o.status === 'fulfilled');
      const refused = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
      expect(won, 'RED WHEN: both writers are told their version was filed, so one of them was silently discarded').toHaveLength(1);
      expect(refused[0]!.reason).toBeInstanceOf(VaultPoolVersionAlreadyFiled);
      expect(String(refused[0]!.reason?.message), 'RED WHEN: the refusal prints the vault').not.toContain(v);
      /* What is filed is the winner's record, byte for byte. */
      const winner = outcomes[0]!.status === 'fulfilled' ? mine : theirs;
      expect(await a.get(v)).toEqual(JSON.parse(JSON.stringify(winner)));
      expect((await a.versions(v)).map((x) => x.version)).toEqual([1, 2]);
      lost += 1;
    }
    expect(lost).toBe(25);
  });

  it('REFUSES a version already filed and a version past the next one, and files nothing for either', async () => {
    const v = aVault(); const s = signers();
    const pool = records.of('pool');
    await pool.put(v, sealPool(v, { notes: [] }, s.list, 1));
    await expect(pool.put(v, sealPool(v, { notes: [] }, s.list, 1)),
      'RED WHEN: a version already filed is written again').rejects.toThrow(VaultPoolVersionAlreadyFiled);
    await expect(pool.put(v, sealPool(v, { notes: [] }, s.list, 3)),
      'RED WHEN: a version past the next one is filed, leaving a gap the newest read steps over').rejects.toThrow(/the next one is 2/);
    await expect(pool.put(v, sealPool(v, { notes: [] }, s.list, 2 + 0))).resolves.toBeUndefined();
    expect((await pool.versions(v)).map((x) => x.version)).toEqual([1, 2]);
    await expect(records.of('pool').put(aVault(), sealPool(v, { notes: [] }, s.list, 1)),
      'RED WHEN: a record sealed for one vault is filed under another').rejects.toThrow(/DIFFERENT vault/);
  });

  it('A WRITE THAT RETURNS IS DURABLE: it commits with synchronous_commit on even where the database default is off', async () => {
    await admin.unsafe(`ALTER DATABASE "${OWN_DB}" SET synchronous_commit = off`);
    const { default: postgres } = await import('postgres');
    const lax = postgres(url, { onnotice: () => {} });
    try {
      const [d] = await lax`SELECT current_setting('synchronous_commit') AS s`;
      expect(d.s, 'the fixture did not take: this connection does not default to off').toBe('off');
      const v = aVault(); const s = signers();
      await expect(
        (await openVaultRecords(lax, { refuseToCreate: NOTHING_IS_KEPT_ELSEWHERE })).of('payment-journal').put(v, sealPool(v, { attempts: [] } as never, s.list, 1)),
        'RED WHEN: the write stops setting synchronous_commit for its own transaction, and is refused for committing laxly',
      ).resolves.toBeUndefined();
      expect(await (await openVaultRecords(lax, { refuseToCreate: NOTHING_IS_KEPT_ELSEWHERE })).of('payment-journal').get(v)).not.toBeNull();
    } finally {
      await admin.unsafe(`ALTER DATABASE "${OWN_DB}" RESET synchronous_commit`);
      await lax.end({ timeout: 2 });
    }
  });

  it('A WRITE THAT WOULD COMMIT LAXLY IS ROLLED BACK: a connection that loses the setting files nothing', async () => {
    /* A driver or pooler that swallowed the setting, modelled by dropping that one statement. */
    const dropsTheSetting: any = (strings: TemplateStringsArray, ...values: unknown[]) => sql(strings, ...values);
    dropsTheSetting.begin = (fn: (tx: any) => Promise<unknown>) => sql.begin(async (tx: any) => {
      await tx`SET LOCAL synchronous_commit TO off`;
      const lossy: any = (strings: TemplateStringsArray, ...values: unknown[]) =>
        strings.join('').includes('SET LOCAL synchronous_commit') ? Promise.resolve([]) : tx(strings, ...values);
      return fn(lossy);
    });
    const v = aVault(); const s = signers();
    await expect(
      (await openVaultRecords(dropsTheSetting, { refuseToCreate: NOTHING_IS_KEPT_ELSEWHERE })).of('pool').put(v, sealPool(v, { notes: [] }, s.list, 1)),
      'RED WHEN: a write is accepted without checking the mode it committed under',
    ).rejects.toThrow(/rolled back and nothing is filed/);
    expect(await records.of('pool').get(v), 'RED WHEN: the lax write is filed anyway').toBeNull();
  });

  it('NOTHING FILED IS CHANGED OR REMOVED: the table refuses an update, a delete and a truncate', async () => {
    const v = aVault(); const s = signers();
    await records.of('pool').put(v, sealPool(v, { notes: [] }, s.list, 1));
    const key = vaultKeyOf(v);
    await expect(sql`UPDATE vault_sealed_records SET body = '{}' WHERE vault_key = ${key}`,
      'RED WHEN: a filed version can be rewritten').rejects.toThrow(/never changed or removed/);
    await expect(sql`DELETE FROM vault_sealed_records WHERE vault_key = ${key}`,
      'RED WHEN: a filed version can be deleted').rejects.toThrow(/never changed or removed/);
    await expect(sql`TRUNCATE vault_sealed_records`,
      'RED WHEN: every filed version can be removed at once').rejects.toThrow(/never changed or removed/);
    expect((await records.of('pool').versions(v))).toHaveLength(1);
  });

  it('A ROW THAT IS NOT WHAT WAS WRITTEN IS REFUSED, NEVER READ AS EMPTY', async () => {
    const s = signers();
    const tampered = aVault();
    const good = JSON.stringify(sealPool(tampered, { notes: [] }, s.list, 1));
    await sql`INSERT INTO vault_sealed_records (vault_key, record, version, body, digest)
      VALUES (${vaultKeyOf(tampered)}, 'pool', 1, ${good.replace('"version":1', '"version":1 ')},
              ${Buffer.alloc(32)})`;
    await expect(records.of('pool').get(tampered),
      'RED WHEN: a row whose body does not match its digest is opened').rejects.toThrow(VaultRecordUnreadable);
    await expect(records.of('pool').versions(tampered)).rejects.toThrow(/does not match the digest/);

    const renumbered = aVault();
    const body = JSON.stringify(sealPool(renumbered, { notes: [] }, s.list, 1));
    const { createHash } = await import('node:crypto');
    await sql`INSERT INTO vault_sealed_records (vault_key, record, version, body, digest)
      VALUES (${vaultKeyOf(renumbered)}, 'pool', 1, ${body}, ${createHash('sha256').update(body).digest()})`;
    await sql`INSERT INTO vault_sealed_records (vault_key, record, version, body, digest)
      VALUES (${vaultKeyOf(renumbered)}, 'pool', 2, ${body}, ${createHash('sha256').update(body).digest()})`;
    await expect(records.of('pool').get(renumbered),
      'RED WHEN: a row filed as version 2 whose record says version 1 is trusted').rejects.toThrow(/one fact/);
  });

  it('THE VAULT\'S ADDRESS IS IN NO COLUMN BUT THE SEALED BODY', async () => {
    const v = aVault(); const s = signers();
    await records.of('pool').put(v, sealPool(v, { notes: [] }, s.list, 1));
    const [row] = await sql`
      SELECT encode(vault_key, 'hex') AS k, record, version::text AS n, encode(digest, 'hex') AS d
      FROM vault_sealed_records WHERE vault_key = ${vaultKeyOf(v)}`;
    expect(Object.values(row).join(' '), 'RED WHEN: the address is stored as a key').not.toContain(v);
  });

  it('THE READ IS AN INDEX LOOKUP, NOT A SCAN: the newest version is served by the primary key', async () => {
    const v = aVault();
    const plan = await sql.begin(async (tx: any) => {
      await tx`SET LOCAL enable_seqscan = off`;
      return tx`EXPLAIN SELECT version, body, digest FROM vault_sealed_records
        WHERE vault_key = ${vaultKeyOf(v)} AND record = 'pool' ORDER BY version DESC LIMIT 1`;
    });
    const text = plan.map((r: any) => r['QUERY PLAN']).join('\n');
    expect(text, 'RED WHEN: nothing indexes a vault\'s record by version').toMatch(/Index (Only )?Scan Backward using vault_sealed_records_pkey/);
  });

  it('REFUSES the first version when told the vault is kept elsewhere, and files nothing', async () => {
    const v = aVault(); const s = signers();
    const guarded = await openVaultRecords(sql, { refuseToCreate: () => 'kept by the operator tools' });
    await expect(guarded.of('pool').put(v, sealPool(v, { notes: [] }, s.list, 1))).rejects.toThrow(/operator tools/);
    expect(await guarded.of('pool').get(v)).toBeNull();
  });

  it('THE POOL AND BOTH JOURNALS, THROUGH THE CLASSES A LEDGER IS HANDED', async () => {
    const v = aVault(); const s = signers();
    const me = { signerId: 'ada', wrappingSecret: s.secret };
    const pool = new SealedNotePool(records.of('pool'), me, async () => s.list);
    await pool.create(v, { notes: [] });
    const first = await pool.load(v);
    await pool.save(v, { notes: [{ nonce: '33'.repeat(32), token: GBP, value: 900n }] }, first.readAt);
    const second = await pool.load(v);
    expect(second.readAt.version).toBe(2);
    await expect(pool.save(v, { notes: [] }, first.readAt),
      'RED WHEN: a write built on a stale read lands').rejects.toThrow(/at version 2 now/);

    const opener = { id: 'ada', wrappingSecret: s.secret };
    const payments = new PaymentJournalInStore(records.of('payment-journal'), v, opener, async () => s.list);
    const deposits = new DepositJournalInStore(
      records.of('deposit-journal'), v, opener, async () => s.list, depositNonceKeyFor(new Uint8Array(32).fill(9), v));
    const claimed = await deposits.claim(v, { token: GBP, value: 900n }, 1, 'now');
    await payments.record(v, { spent: { nonce: '33'.repeat(32), token: GBP, value: 900n }, amount: 250n, attemptedAt: 'now' } as never);
    await payments.record(v, { spent: { nonce: '33'.repeat(32), token: GBP, value: 900n }, amount: 250n, attemptedAt: 'again' } as never);
    const read = attemptsFromJournalVersions({
      deposits: await records.of('deposit-journal').versions(v),
      payments: await records.of('payment-journal').versions(v),
      opener,
    });
    expect(read.versionsRead).toEqual({ deposits: 1, payments: 2 });
    expect(read.deposits).toEqual([claimed.coin]);
    expect(read.payments).toEqual([{ spent: { nonce: '33'.repeat(32), token: GBP, value: 900n }, amount: 250n }]);
  });
});
