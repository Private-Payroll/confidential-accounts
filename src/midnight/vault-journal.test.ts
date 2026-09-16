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
import { newWrappingKeypair, newSymmetricKey, seal, wrapKey, canonical } from '../core/crypto.js';
import { depositNonceAt, depositNonceKeyFor } from './deposit-nonce.js';

const KEY = depositNonceKeyFor(new Uint8Array(32).fill(0x31), 'c4'.repeat(32));

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
      store, VAULT, { id: 'ada', wrappingSecret: a.secret }, async () => [a.who], KEY, () => { toldAfter.push(filed); });
    const claimed = await j.claim(VAULT, { token: GBP, value: 70n }, 1, 'x');
    expect(toldAfter, 'RED WHEN: the ledger is told the line is stored before it is, or is told twice or never').toEqual([1]);
    const read = attemptsFromJournalVersions({
      deposits: await inner.versions(VAULT), payments: [], opener: { id: 'ada', wrappingSecret: a.secret },
    });
    expect(read.deposits, 'RED WHEN: the line filed is not the coin the claim handed back')
      .toEqual([claimed.coin]);
  });

  it('A CLAIM DERIVES ITS NONCE FROM THE SLOT IT IS GIVEN, whatever version it files', async () => {
    const a = signer('ada');
    const store = new MemorySealedPoolStore();
    const j = new DepositJournalInStore(store, VAULT, { id: 'ada', wrappingSecret: a.secret }, async () => [a.who], KEY);
    const money = { token: GBP, value: 70n };
    const first = await j.claim(VAULT, money, 5, 'x');
    const second = await j.claim(VAULT, money, 6, 'y');
    expect(first.coin.nonce, 'RED WHEN: the nonce is not the one derived from the slot given')
      .toBe(depositNonceAt(KEY, money, 5));
    expect(second.coin.nonce, 'RED WHEN: a claim at another slot names the same coin')
      .toBe(depositNonceAt(KEY, money, 6));
    expect((await store.versions(VAULT)).map((v) => v.version), 'the two lines are two versions').toEqual([1, 2]);
    expect(second.attemptedAt).toBe('y');
    await expect(j.claim(VAULT, money, 0, 'z'), 'RED WHEN: a slot a rebuild never walks is accepted').rejects.toThrow(/whole slot from 1/);
    expect(await store.versions(VAULT), 'RED WHEN: a line is filed for a slot that derives nothing').toHaveLength(2);
  });

  it('TWO WRITERS WHO READ THE SAME VAULT CLAIM THE SAME COIN AND FILE TWO VERSIONS, and the journal reads it as one attempt', async () => {
    const a = signer('ada');
    const inner = new MemorySealedPoolStore();
    /* Both writers read before either writes: the first read of each is held until both have read. */
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => { release = r; });
    const store: SealedPoolStore = {
      get: async (v) => {
        const got = await inner.get(v);
        reads += 1;
        if (reads === 2) release();
        if (reads <= 2) await bothRead;
        return got;
      },
      versions: (v) => inner.versions(v),
      put: (v, rec) => inner.put(v, rec),
    };
    const opener = { id: 'ada', wrappingSecret: a.secret };
    const one = new DepositJournalInStore(store, VAULT, opener, async () => [a.who], KEY);
    const two = new DepositJournalInStore(store, VAULT, opener, async () => [a.who], KEY);
    const money = { token: GBP, value: 70n };
    const [x, y] = await Promise.all([one.claim(VAULT, money, 1, 'x'), two.claim(VAULT, money, 1, 'y')]);
    expect(x.coin, 'only one of these can land: the ledger refuses a coin it has already made').toEqual(y.coin);
    expect((await inner.versions(VAULT)).map((v) => v.version), 'RED WHEN: the lost race is not retried at the next version').toEqual([1, 2]);
    const filed = attemptsFromJournalVersions({ deposits: await inner.versions(VAULT), payments: [], opener });
    expect(filed.deposits, 'RED WHEN: one coin journalled twice is proposed as two').toEqual([x.coin]);
  });

  it('A RECORD IS OPENED ONLY AS WHAT IT WAS SEALED AS: a deposit journal presented as the payment journal is refused', async () => {
    const a = signer('ada');
    const deposits = new MemorySealedPoolStore();
    const d = new DepositJournalInStore(deposits, VAULT, { id: 'ada', wrappingSecret: a.secret }, async () => [a.who], KEY);
    await d.claim(VAULT, { token: GBP, value: 9n }, 1, 'x');
    const relabelled: SealedPoolStore = { get: (v) => deposits.get(v), versions: (v) => deposits.versions(v), put: async () => {} };
    const p = new PaymentJournalInStore(relabelled, VAULT, { id: 'ada', wrappingSecret: a.secret }, async () => [a.who]);
    await expect(p.open(), 'RED WHEN: a store can hand one record back as another').rejects.toThrow(/payment-journal was asked for/);
    const filedAsDeposits = await deposits.versions(VAULT);
    expect(() => attemptsFromJournalVersions({
      deposits: [], payments: filedAsDeposits, opener: { id: 'ada', wrappingSecret: a.secret },
    }), 'RED WHEN: the rebuild reads a deposit journal\'s versions as payments').toThrow(/payment-journal was asked for/);
  });

  it('AN UNLABELLED RECORD IS REFUSED unless the store it came from kept records before labels', async () => {
    const a = signer('ada');
    const key = newSymmetricKey();
    const old = {
      vault: VAULT, version: 1, sealed: seal(canonical({ attempts: [] }), key),
      wrapped: [{ signerId: 'ada', wrapped: wrapKey(key, a.who.wrappingPublicKey) }],
    };
    const store = new MemorySealedPoolStore();
    await store.put(VAULT, old);
    const fresh = new PaymentJournalInStore(store, VAULT, { id: 'ada', wrappingSecret: a.secret }, async () => [a.who]);
    await expect(fresh.open(), 'RED WHEN: a record that does not say what it is is believed from a store that never held such records')
      .rejects.toThrow(/does not say which record/);
    const legacy: SealedPoolStore = {
      unlabelledRecordsFiled: true, get: (v) => store.get(v), versions: (v) => store.versions(v), put: (v, r) => store.put(v, r),
    };
    const kept = new PaymentJournalInStore(legacy, VAULT, { id: 'ada', wrappingSecret: a.secret }, async () => [a.who]);
    expect((await kept.open()).attempts, 'RED WHEN: records written before labels stop opening where they are kept').toEqual([]);
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
    await store.put(VAULT, sealPool(VAULT, { attempts: [] } as never, [a.who, b.who], 1, 'payment-journal'));
    const j = new PaymentJournalInStore(store, VAULT, { id: 'ada', wrappingSecret: a.secret }, async () => [a.who]);
    await expect(j.record(VAULT, attempt('01'.repeat(32), 5n, 1n) as never)).rejects.toThrow(/bo/);
    await expect(j.record('d9'.repeat(32), attempt('01'.repeat(32), 5n, 1n) as never)).rejects.toThrow(/different vault/);
    expect(await store.versions(VAULT)).toHaveLength(1);
  });
});
