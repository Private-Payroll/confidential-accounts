/**
 * **THE ATTEMPT JOURNALS ON DISK: WRITTEN SEALED, READ AS A UNION, AND NEVER
 * READ AS A POOL.**
 *
 * What is pinned here is the file layer under `PaymentJournal`: that a line is
 * on disk, whole and sealed, when `record` returns; that a second writer
 * losing the version is retried rather than lost; that the reader takes every
 * filed version rather than trusting the newest; and that both journals come
 * back in the shape the rebuild takes. What the rebuild DOES with them is
 * pinned against the real contract in `contracts/test/vault-recovery.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SealedPaymentJournal, SealedDepositJournal, journalledAttempts, paymentJournalFile, depositJournalFileOf,
} from './vault-journal.js';
import { FileSealedPoolStore, vaultPoolFile } from './vault-pool-file.js';
import { depositJournalFile } from './deposit-to-vault.js';
import { sealPool, openPool, type PoolSigner } from '../src/midnight/vault-pool.js';
import { newWrappingKeypair } from '../src/core/crypto.js';
import { depositNonceAt, depositNonceKeyFor } from '../src/midnight/deposit-nonce.js';

const KEY = depositNonceKeyFor(new Uint8Array(32).fill(0x42), 'd0'.repeat(32));

const VAULT = 'd0'.repeat(32);
const OTHER = 'e1'.repeat(32);
const GBP = 'aa'.repeat(32);

const dir = () => mkdtempSync(join(tmpdir(), 'vault-journal-'));

const signers = (): { signers: PoolSigner[]; secret: string } => {
  const k = newWrappingKeypair();
  return { signers: [{ id: 'ada', wrappingPublicKey: k.publicKey }], secret: k.secret };
};

const attempt = (nonce: string, value: bigint, amount: bigint) => ({
  spent: { nonce, token: GBP, value }, amount, attemptedAt: '2026-09-14T00:00:00.000Z',
});

const journalIn = (d: string, s: ReturnType<typeof signers>, vault = VAULT) =>
  new SealedPaymentJournal(
    paymentJournalFile(d, 'stagenet', 'payroll-test-1'), vault,
    { id: 'ada', wrappingSecret: s.secret as never }, async () => s.signers);

describe('the payment journal is named after the vault, never addressed by it', () => {
  it('puts the NAME in the path and the address nowhere in it, for both journals', () => {
    for (const path of [
      paymentJournalFile('/state', 'stagenet', 'payroll-test-1'),
      depositJournalFileOf('/state', 'stagenet', 'payroll-test-1'),
    ]) {
      expect(path).toContain('payroll-test-1');
      expect(path).not.toMatch(/[0-9a-f]{16}/);
    }
    expect(() => paymentJournalFile('/state', 'stagenet', '../x')).toThrow();
  });

  it('the reader opens the file the deposit door writes: the two spellings of its name are one', () => {
    /*
     * The name is declared twice on purpose -- the rebuild must not import the
     * door -- so this is what keeps them one. If they drift, the door keeps
     * writing and the rebuild reads "0 version(s) filed", which is absent-equals-
     * empty doing exactly what it should about the wrong file.
     */
    expect(
      depositJournalFileOf('/x/.midnight', 'stagenet', 'payroll-test-2'),
      'RED WHEN: the deposit door and the rebuild spell the deposit journal\'s name differently, so the record written before every deposit is never read',
    ).toBe(depositJournalFile('/x/.midnight', 'stagenet', 'payroll-test-2'));
  });

  it('the two journals and the pool are three different files', () => {
    const names = new Set([
      paymentJournalFile('/s', 'stagenet', 'payroll-uk'),
      depositJournalFileOf('/s', 'stagenet', 'payroll-uk'),
      vaultPoolFile('/s', 'stagenet', 'payroll-uk'),
    ]);
    expect(names.size, 'RED WHEN: two of the three share a name, so one record is written over another\x27s versions').toBe(3);
  });
});

describe('a line is on disk, sealed, when record() returns', () => {
  it('writes the attempt as a new sealed version, and nothing in the file is readable', async () => {
    const d = dir(); const s = signers();
    const j = journalIn(d, s);
    await j.record(VAULT, attempt('01'.repeat(32), 1_000n, 200n));

    const filed = readdirSync(d).filter((f) => f.includes('payment-journal'));
    expect(filed.length).toBeGreaterThan(0);
    for (const f of filed) {
      const raw = readFileSync(join(d, f), 'utf8');
      expect(raw, 'RED WHEN: the journal is written in the clear -- a nonce, a colour and a value beside a sealed pool publish what the pool exists to protect').not.toContain('01'.repeat(32));
      expect(raw).not.toContain('"amount"');
    }
    const opened = await j.open();
    expect(opened.version).toBe(1);
    expect(opened.attempts).toEqual([attempt('01'.repeat(32), 1_000n, 200n)]);
  });

  it('appends: the second line joins the first in the next version', async () => {
    const d = dir(); const s = signers();
    const j = journalIn(d, s);
    await j.record(VAULT, attempt('01'.repeat(32), 1_000n, 200n));
    await j.record(VAULT, attempt('02'.repeat(32), 500n, 500n));
    const opened = await j.open();
    expect(opened.version).toBe(2);
    expect(
      opened.attempts.map((a) => a.amount),
      'RED WHEN: a write replaces the journal rather than appending to it, so every attempt but the last is lost',
    ).toEqual([200n, 500n]);
  });

  it('REFUSES to record against a vault other than the one it was built for', async () => {
    const d = dir(); const s = signers();
    const j = journalIn(d, s);
    await expect(j.record(OTHER, attempt('01'.repeat(32), 1_000n, 200n)))
      .rejects.toThrow(/different vault/);
    expect(readdirSync(d)).toHaveLength(0);
  });

  it('REFUSES when the secret on this machine cannot open what is already filed, and writes nothing', async () => {
    const d = dir(); const s = signers();
    await journalIn(d, s).record(VAULT, attempt('01'.repeat(32), 1_000n, 200n));
    const stranger = signers();
    const before = readdirSync(d).length;
    await expect(journalIn(d, stranger).record(VAULT, attempt('02'.repeat(32), 500n, 100n)))
      .rejects.toThrow();
    expect(readdirSync(d).length, 'RED WHEN: a journal that cannot be read back is appended to anyway, adding a line nobody on this machine can open').toBe(before);
  });

  it('a version another writer filed between the read and the write is not lost: it is re-read', async () => {
    const d = dir(); const s = signers();
    const a = journalIn(d, s);
    const b = journalIn(d, s);
    /* Both open at version 0; both then write. Whoever loses the claim re-reads. */
    const both = await Promise.allSettled([
      a.record(VAULT, attempt('01'.repeat(32), 1_000n, 200n)),
      b.record(VAULT, attempt('02'.repeat(32), 500n, 100n)),
    ]);
    expect(
      both.map((r) => (r.status === 'rejected' ? String((r.reason as Error).message).slice(0, 80) : 'fulfilled')),
      'RED WHEN: a lost version claim is not retried, so one of two concurrent payments is refused at the journal',
    ).toEqual(['fulfilled', 'fulfilled']);
    const opened = await a.open();
    expect(opened.version).toBe(2);
    expect(
      opened.attempts.map((x) => x.amount).sort(),
      'RED WHEN: a lost version claim is not retried, so one of two concurrent payments goes unjournalled',
    ).toEqual([100n, 200n]);
  });
});

describe('the reader takes every filed version of both journals, as the rebuild takes them', () => {
  const opener = (s: ReturnType<typeof signers>) => ({ id: 'ada', wrappingSecret: s.secret as never });

  it('answers empty for a machine with no journals at all', () => {
    const d = dir(); const s = signers();
    const r = journalledAttempts({
      depositJournalFile: depositJournalFileOf(d, 'stagenet', 'payroll-test-1'),
      paymentJournalFile: paymentJournalFile(d, 'stagenet', 'payroll-test-1'),
      vault: VAULT, opener: opener(s),
    });
    expect(r).toEqual({ deposits: [], payments: [], versionsRead: { deposits: 0, payments: 0 } });
  });

  it('reads the deposit journal the deposit door writes -- coins under `notes` -- and the payment journal', async () => {
    const d = dir(); const s = signers();
    /* The deposit door's own shape: note-shaped lines plus when, cumulative per version. */
    const depositFile = depositJournalFileOf(d, 'stagenet', 'payroll-test-1');
    const depositStore = new FileSealedPoolStore(depositFile, VAULT);
    const line1 = { nonce: '11'.repeat(32), token: GBP, value: 700n, attemptedAt: 't1' };
    const line2 = { nonce: '12'.repeat(32), token: GBP, value: 800n, attemptedAt: 't2' };
    await depositStore.put(VAULT, sealPool(VAULT, { notes: [line1] } as never, s.signers, 1));
    await depositStore.put(VAULT, sealPool(VAULT, { notes: [line1, line2] } as never, s.signers, 2));

    await journalIn(d, s).record(VAULT, attempt('01'.repeat(32), 1_000n, 200n));

    const r = journalledAttempts({
      depositJournalFile: depositFile,
      paymentJournalFile: paymentJournalFile(d, 'stagenet', 'payroll-test-1'),
      vault: VAULT, opener: opener(s),
    });
    expect(r.versionsRead).toEqual({ deposits: 2, payments: 1 });
    expect(
      r.deposits,
      'RED WHEN: a deposit line present in two versions is counted twice, or `attemptedAt` leaks into the coin the rebuild proposes',
    ).toEqual([
      { nonce: '11'.repeat(32), token: GBP, value: 700n },
      { nonce: '12'.repeat(32), token: GBP, value: 800n },
    ]);
    expect(r.payments).toEqual([{ spent: { nonce: '01'.repeat(32), token: GBP, value: 1_000n }, amount: 200n }]);
  });

  it('takes the UNION across versions, so a line only an older version holds still counts', async () => {
    const d = dir(); const s = signers();
    const file = paymentJournalFile(d, 'stagenet', 'payroll-test-1');
    const store = new FileSealedPoolStore(file, VAULT);
    const a1 = attempt('01'.repeat(32), 1_000n, 200n);
    const a2 = attempt('02'.repeat(32), 500n, 100n);
    /* Version 2 was written by a writer that had not seen version 1's line. */
    await store.put(VAULT, sealPool(VAULT, { attempts: [a1] } as never, s.signers, 1));
    await store.put(VAULT, sealPool(VAULT, { attempts: [a2] } as never, s.signers, 2));
    const r = journalledAttempts({
      depositJournalFile: depositJournalFileOf(d, 'stagenet', 'payroll-test-1'),
      paymentJournalFile: file, vault: VAULT, opener: opener(s),
    });
    expect(
      r.payments.map((p) => p.amount).sort(),
      'RED WHEN: only the newest version is read, so an attempt a lost write filed is not proposed',
    ).toEqual([100n, 200n]);
  });

  it('REFUSES a journal version whose lines are not the shape it claims, rather than proposing from a guess', async () => {
    const d = dir(); const s = signers();
    const file = paymentJournalFile(d, 'stagenet', 'payroll-test-1');
    const store = new FileSealedPoolStore(file, VAULT);
    await store.put(VAULT, sealPool(VAULT, { attempts: [{ spent: { nonce: '01'.repeat(32), token: GBP, value: 1n }, amount: 'ten' }] } as never, s.signers, 1));
    expect(() => journalledAttempts({
      depositJournalFile: depositJournalFileOf(d, 'stagenet', 'payroll-test-1'),
      paymentJournalFile: file, vault: VAULT, opener: opener(s),
    })).toThrow(/not an attempt/);
  });

  it('what the reader hands back is what the writer sealed: opening a version directly agrees', async () => {
    const d = dir(); const s = signers();
    await journalIn(d, s).record(VAULT, attempt('01'.repeat(32), 1_000n, 200n));
    const file = paymentJournalFile(d, 'stagenet', 'payroll-test-1');
    const rec = await new FileSealedPoolStore(file, VAULT).get(VAULT);
    const page: any = openPool(rec!, 'ada', s.secret as never);
    expect(page.attempts[0].spent.value).toBe(1_000n);
    expect(typeof page.attempts[0].amount, 'RED WHEN: the amount round-trips as something other than a bigint, and a rebuild subtracting it would derive a value that is not a number').toBe('bigint');
  });
});

/* ------------------------------------------------------------------ *
 * the deposit journal, now handed to the ledger
 * ------------------------------------------------------------------ */

describe('the deposit journal the ledger is handed writes what the door always wrote', () => {
  const opener = (s: ReturnType<typeof signers>) => ({ id: 'ada', wrappingSecret: s.secret as never });
  const depositIn = (d: string, s: ReturnType<typeof signers>, written = () => {}, vault = VAULT) =>
    new SealedDepositJournal(
      depositJournalFileOf(d, 'stagenet', 'payroll-test-1'), vault, opener(s), async () => s.signers, KEY, written);
  const money = (value: bigint) => ({ token: GBP, value });

  it('files the coin, sealed, in the page the rebuild has always read, and says so only once it is on disk', async () => {
    const d = dir(); const s = signers();
    const said: number[] = [];
    const j = depositIn(d, s, () => { said.push(readdirSync(d).length); });
    const first = await j.claim(VAULT, money(700n), 't9');
    const second = await j.claim(VAULT, money(800n), 't9');
    expect(first.coin.nonce, 'RED WHEN: the door\'s journal does not derive the nonce from version 1')
      .toBe(depositNonceAt(KEY, money(700n), 1));
    expect(second.coin.nonce).toBe(depositNonceAt(KEY, money(800n), 2));
    for (const f of readdirSync(d)) {
      expect(readFileSync(join(d, f), 'utf8'), 'RED WHEN: the deposit journal is written in the clear').not.toContain(first.coin.nonce);
    }
    let r!: ReturnType<typeof journalledAttempts>;
    expect(
      () => { r = journalledAttempts({
        depositJournalFile: depositJournalFileOf(d, 'stagenet', 'payroll-test-1'),
        paymentJournalFile: paymentJournalFile(d, 'stagenet', 'payroll-test-1'),
        vault: VAULT, opener: opener(s),
      }); },
      'RED WHEN: the ledger\'s deposit line is filed under a page name the rebuild does not read, so every rebuild of this vault stops',
    ).not.toThrow();
    expect(
      r.deposits,
      'RED WHEN: the ledger\'s deposit line is filed in a shape or file the rebuild does not read -- the door keeps writing and the rebuild reads nothing',
    ).toEqual([first.coin, second.coin]);
    const rec = await new FileSealedPoolStore(depositJournalFileOf(d, 'stagenet', 'payroll-test-1'), VAULT).get(VAULT);
    const page: any = openPool(rec!, 'ada', s.secret as never);
    expect(page.notes[1], 'RED WHEN: the page stops carrying each line whole, with when it was attempted, as the door wrote it').toEqual({
      nonce: second.coin.nonce, token: GBP, value: 800n, attemptedAt: 't9',
    });
    expect(said.every((n) => n > 0), 'RED WHEN: the door is told the line is journalled before it is on disk').toBe(true);
    expect(said).toHaveLength(2);
    expect((await j.open()).attempts.map((a) => a.value)).toEqual([700n, 800n]);
  });

  it('A LINE WRITTEN BEFORE NONCES WERE DERIVED STILL READS, UNCHANGED, and the next claim is filed after it', async () => {
    const d = dir(); const s = signers();
    const file = depositJournalFileOf(d, 'stagenet', 'payroll-test-1');
    const random = { nonce: '5c'.repeat(32), token: GBP, value: 600n, attemptedAt: 'before' };
    await new FileSealedPoolStore(file, VAULT).put(VAULT, sealPool(VAULT, { notes: [random] } as never, s.signers, 1));
    const next = await depositIn(d, s).claim(VAULT, money(600n), 'after');
    expect(next.coin.nonce, 'RED WHEN: a claim after a random line is not filed at version 2').toBe(depositNonceAt(KEY, money(600n), 2));
    const r = journalledAttempts({
      depositJournalFile: file, paymentJournalFile: paymentJournalFile(d, 'stagenet', 'payroll-test-1'), vault: VAULT, opener: opener(s),
    });
    expect(r.deposits, 'RED WHEN: a note made with a random nonce stops being named by the line that recorded it')
      .toEqual([{ nonce: '5c'.repeat(32), token: GBP, value: 600n }, next.coin]);
  });

  it('REFUSES to record a deposit into a vault other than the one it was built for, and writes nothing', async () => {
    const d = dir(); const s = signers();
    let told = 0;
    await expect(depositIn(d, s, () => { told += 1; }).claim(OTHER, money(700n), 't'))
      .rejects.toThrow(/different vault .* nothing is deposited/);
    expect(readdirSync(d)).toHaveLength(0);
    expect(told).toBe(0);
  });
});

describe('a journal write never takes a reader away', () => {
  const two = () => {
    const ada = newWrappingKeypair();
    const bob = newWrappingKeypair();
    return {
      both: [{ id: 'ada', wrappingPublicKey: ada.publicKey }, { id: 'bob', wrappingPublicKey: bob.publicKey }] as PoolSigner[],
      adaSecret: ada.secret,
    };
  };

  for (const kind of ['payment', 'deposit'] as const) {
    it(`REFUSES a ${kind} line that would re-seal the ${kind} journal to fewer signers than it is wrapped for, and writes nothing`, async () => {
      const d = dir(); const k = two();
      let listed: PoolSigner[] = k.both;
      const me = { id: 'ada', wrappingSecret: k.adaSecret as never };
      const journal = kind === 'payment'
        ? new SealedPaymentJournal(paymentJournalFile(d, 'stagenet', 'payroll-test-1'), VAULT, me, async () => listed)
        : new SealedDepositJournal(depositJournalFileOf(d, 'stagenet', 'payroll-test-1'), VAULT, me, async () => listed, KEY);
      const write = async (): Promise<void> => {
        if (journal instanceof SealedPaymentJournal) await journal.record(VAULT, attempt('01'.repeat(32), 1_000n, 200n) as never);
        else await journal.claim(VAULT, { token: GBP, value: 700n }, 't');
      };
      await write();
      const before = readdirSync(d).length;

      listed = k.both.filter((x) => x.id === 'ada');
      await expect(
        write(),
        `RED WHEN: the ${kind} journal is re-sealed to whatever the signers list says without comparing its own wrapped list, so a signer loses the only record that names a lost note and the write succeeds`,
      ).rejects.toThrow(new RegExp(`this vault's ${kind} journal is readable by 1 signer\\(s\\) that the signers file no longer lists \\(bob\\)`));
      expect(readdirSync(d).length, 'RED WHEN: the refusal comes after the write').toBe(before);

      /* Adding a reader is not taking one away. */
      const carol = newWrappingKeypair();
      listed = [...k.both, { id: 'carol', wrappingPublicKey: carol.publicKey }];
      await expect(write()).resolves.toBeUndefined();
    });
  }
});
