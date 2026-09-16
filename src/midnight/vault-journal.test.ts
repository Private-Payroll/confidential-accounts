/**
 * **THE ATTEMPT JOURNALS OVER ANY STORE.** The file-backed journals the doors
 * use are pinned in `scripts/vault-journal.test.ts` and the database-backed
 * ones in `src/db/vault-records.test.ts`; this file pins what the journal does
 * whatever holds it, against the in-memory store.
 */
import { describe, it, expect } from 'vitest';

import {
  PaymentJournalInStore, DepositJournalInStore, attemptsFromJournalVersions, JOURNAL_WRITE_ATTEMPTS,
} from './vault-journal.js';
import {
  MemorySealedPoolStore, sealPool, type PoolSigner, type SealedPoolStore,
} from './vault-pool.js';
import { newWrappingKeypair } from '../core/crypto.js';

const VAULT = 'c4'.repeat(32);
const GBP = 'aa'.repeat(32);

const signer = (id: string) => {
  const k = newWrappingKeypair();
  return { who: { id, wrappingPublicKey: k.publicKey } as PoolSigner, secret: k.secret };
};

const attempt = (nonce: string, value: bigint, amount: bigint) => ({
  spent: { nonce, token: GBP, value }, amount, attemptedAt: '2026-09-16T00:00:00.000Z',
});

describe('a journal over any store', () => {
  it('files one version per line, each holding every line so far, and reads back as a union', async () => {
    const a = signer('ada');
    const store = new MemorySealedPoolStore();
    const j = new PaymentJournalInStore(store, VAULT, { id: 'ada', wrappingSecret: a.secret }, async () => [a.who]);
    await j.record(VAULT, attempt('01'.repeat(32), 500n, 100n) as never);
    await j.record(VAULT, attempt('02'.repeat(32), 300n, 50n) as never);
    expect((await store.versions(VAULT)).map((v) => v.version)).toEqual([1, 2]);
    expect((await j.open()).attempts).toHaveLength(2);
    const read = attemptsFromJournalVersions({
      deposits: [], payments: await store.versions(VAULT), opener: { id: 'ada', wrappingSecret: a.secret },
    });
    expect(read.payments.map((p) => p.amount)).toEqual([100n, 50n]);
    expect(read.versionsRead).toEqual({ deposits: 0, payments: 2 });
  });

  it('a deposit line is the coin, under the page every deposit line has always had', async () => {
    const a = signer('ada');
    const inner = new MemorySealedPoolStore();
    let filed = 0;
    const store: SealedPoolStore = {
      get: (v) => inner.get(v), versions: (v) => inner.versions(v),
      put: async (v, rec) => { await inner.put(v, rec); filed += 1; },
    };
    const toldAfter: number[] = [];
    const j = new DepositJournalInStore(
      store, VAULT, { id: 'ada', wrappingSecret: a.secret }, async () => [a.who], () => { toldAfter.push(filed); });
    await j.record(VAULT, { coin: { nonce: '05'.repeat(32), token: GBP, value: 70n }, attemptedAt: 'x' } as never);
    expect(toldAfter, 'RED WHEN: the ledger is told the line is stored before it is, or is told twice or never').toEqual([1]);
    const read = attemptsFromJournalVersions({
      deposits: await inner.versions(VAULT), payments: [], opener: { id: 'ada', wrappingSecret: a.secret },
    });
    expect(read.deposits).toEqual([{ nonce: '05'.repeat(32), token: GBP, value: 70n }]);
  });

  it('A LOST VERSION IS RETRIED, AND IT IS RECOGNISED BY NAME, not by which module\'s class threw it', async () => {
    const a = signer('ada');
    const inner = new MemorySealedPoolStore();
    let toLose = 2;
    /* A store whose refusal is a different class object with the shared name, as a second bundle's would be. */
    const racy: SealedPoolStore = {
      get: (v) => inner.get(v),
      versions: (v) => inner.versions(v),
      put: async (v, rec) => {
        if (toLose > 0) {
          toLose -= 1;
          const e = new Error('another writer filed it');
          e.name = 'VaultPoolVersionAlreadyFiled';
          throw e;
        }
        return inner.put(v, rec);
      },
    };
    const j = new PaymentJournalInStore(racy, VAULT, { id: 'ada', wrappingSecret: a.secret }, async () => [a.who]);
    await expect(j.record(VAULT, attempt('01'.repeat(32), 500n, 100n) as never),
      'RED WHEN: the retry recognises only its own module\'s class, so a lost race from another bundle stops a payment it could have made').resolves.toBeUndefined();
    expect((await inner.versions(VAULT))).toHaveLength(1);
  });

  it('gives up after the stated number of lost races, having written nothing, and says what to look for', async () => {
    const a = signer('ada');
    let tries = 0;
    const alwaysLoses: SealedPoolStore = {
      get: async () => null,
      versions: async () => [],
      put: async () => {
        tries += 1;
        const e = new Error('lost'); e.name = 'VaultPoolVersionAlreadyFiled'; throw e;
      },
    };
    const j = new PaymentJournalInStore(alwaysLoses, VAULT, { id: 'ada', wrappingSecret: a.secret }, async () => [a.who]);
    await expect(j.record(VAULT, attempt('01'.repeat(32), 5n, 1n) as never)).rejects.toThrow(/Nothing is written/);
    expect(tries).toBe(JOURNAL_WRITE_ATTEMPTS);
  });

  it('does not retry anything else, because only a lost race says the record is unchanged', async () => {
    const a = signer('ada');
    let tries = 0;
    const broken: SealedPoolStore = {
      get: async () => null,
      versions: async () => [],
      put: async () => { tries += 1; throw new Error('the database is not answering'); },
    };
    const j = new PaymentJournalInStore(broken, VAULT, { id: 'ada', wrappingSecret: a.secret }, async () => [a.who]);
    await expect(j.record(VAULT, attempt('01'.repeat(32), 5n, 1n) as never)).rejects.toThrow(/not answering/);
    expect(tries, 'RED WHEN: a store failure is retried as if it were a lost race').toBe(1);
  });

  it('REFUSES a line that would drop a signer the journal is sealed to, and a vault it was not built for', async () => {
    const a = signer('ada'); const b = signer('bo');
    const store = new MemorySealedPoolStore();
    await store.put(VAULT, sealPool(VAULT, { attempts: [] } as never, [a.who, b.who], 1));
    const j = new PaymentJournalInStore(store, VAULT, { id: 'ada', wrappingSecret: a.secret }, async () => [a.who]);
    await expect(j.record(VAULT, attempt('01'.repeat(32), 5n, 1n) as never)).rejects.toThrow(/bo/);
    await expect(j.record('d9'.repeat(32), attempt('01'.repeat(32), 5n, 1n) as never)).rejects.toThrow(/different vault/);
    expect(await store.versions(VAULT)).toHaveLength(1);
  });
});
