/**
 * **THE ATTEMPT JOURNALS, ON DISK: WHAT A DOOR WROTE DOWN BEFORE IT MOVED A
 * VAULT'S MONEY, AND HOW A REBUILD READS IT BACK.**
 *
 * A vault's pool is written AFTER the transaction, because the other order
 * leaves a pool claiming a note the chain never made. So between the call
 * landing and the pool write there is a window in which the chain holds a note
 * this machine has not yet named -- and a commitment discloses nothing, so a
 * process that stops in that window has lost the name for good unless it was
 * written down FIRST.
 *
 * Two doors move a vault's private money and each writes one line before its
 * call:
 *
 *   · **a deposit** writes the whole coin it is about to make. The deposit door
 *     has done this since the journal was first built, in its own code; the
 *     file name is `depositJournalFile` there and the reader below opens it.
 *   · **a payment** writes the note it is about to spend, whole, and the amount
 *     leaving it. `VaultLedger.payPrivately` records it through the
 *     `PaymentJournal` interface, and `SealedPaymentJournal` below is the
 *     implementation the payment door hands it.
 *
 * **A JOURNAL IS NOT A POOL AND MUST NEVER BE READ AS ONE.** The pool is a
 * claim about what the vault HOLDS; a journal is a record of what was
 * ATTEMPTED. A line for a call that never landed is correct and harmless: the
 * rebuild proposes it to the chain and the chain does not hold it. A pool
 * entry for the same call is the unrecoverable direction.
 *
 * **SEALED TO THE SAME SIGNERS AS THE POOL, BECAUSE IT CARRIES WHAT THE POOL
 * CARRIES** -- a nonce, a colour and a value. A plaintext journal beside a
 * sealed pool publishes exactly what the pool exists to protect. So each
 * journal is a `SealedPool` record in a `FileSealedPoolStore`, filed one
 * version per write like the pool, which is also what makes reading it back
 * a union over every version rather than a trust in the newest: a version
 * whose write raced another and lost is still on disk and still counts.
 *
 * **ONE FILE PER JOURNAL, NOT ONE FILE WITH TWO SHAPES.** The deposit journal's
 * lines are coins and were written before there was a second kind; a payment's
 * line is a different shape. A shared file would need a discriminator the
 * existing lines do not carry, and a reader guessing the shape of a line that
 * lacks one is a reader that can read a payment as a deposit -- proposing the
 * spent note as a coin the vault made, which it did not.
 */
import { join } from 'node:path';

import {
  sealPool, openPool, VaultPoolVersionAlreadyFiled, type PoolSigner,
} from '../src/midnight/vault-pool.js';
import type { PaymentAttempt, PaymentJournal } from '../src/midnight/vault-ledger.js';
import type { AttemptedVaultCalls } from '../src/midnight/vault-recovery.js';
import type { VaultCoin } from '../src/midnight/vault-coins.js';
import type { Hex } from '../src/core/crypto.js';
import { assertVaultName } from '../src/midnight/vault-record.js';
import { FileSealedPoolStore, everyVersionFiled } from './vault-pool-file.js';

/** Where a vault's payment journal lives. Named after the vault, never addressed by it. */
export const paymentJournalFile = (stateDir: string, network: string, name: string): string =>
  join(stateDir, `${network}-vault-payment-journal-${assertVaultName(name)}.json`);

/**
 * Where a vault's deposit journal lives. The deposit door defines the same
 * name in its own file; it is repeated here rather than imported because a
 * rebuild that imports a door imports the door's whole module, and this one
 * has to stay importable by a test that runs no door.
 */
export const depositJournalFileOf = (stateDir: string, network: string, name: string): string =>
  join(stateDir, `${network}-vault-deposit-journal-${assertVaultName(name)}.json`);

/** What the payment journal seals: its lines, under a name that says what they are. */
interface PaymentJournalPage {
  readonly attempts: readonly PaymentAttempt[];
}

/** One signer who can open a sealed record on this machine. */
export interface JournalOpener {
  readonly id: string;
  readonly wrappingSecret: Hex;
}

/**
 * How many times a write that lost the version to another writer is tried
 * again against a fresh read. Two doors paying out of one vault at once is
 * the only way to lose it, and each retry re-reads and re-appends.
 */
const JOURNAL_WRITE_ATTEMPTS = 5;

/**
 * **THE PAYMENT JOURNAL A DOOR HANDS `VaultLedger`.** Every `record` reads the
 * journal as filed, appends one line, and files the next version sealed to
 * every signer -- so a line is on disk, whole, before `record` returns, and
 * `payPrivately` does not call the contract until it has.
 *
 * `open()` is separate and is called by the door BEFORE anything is proved:
 * a journal the secrets on this machine cannot open has to stop the run
 * while stopping costs nothing, not surface at the one moment this file
 * exists to survive. `record` itself refuses on the same condition, which is
 * the guarantee; `open()` is the courtesy of refusing early.
 */
export class SealedPaymentJournal implements PaymentJournal {
  private readonly store: FileSealedPoolStore;

  constructor(
    file: string,
    private readonly vault: string,
    private readonly me: JournalOpener,
    /** Everybody who must be able to open what this writes: the pool's signers. */
    private readonly signers: () => Promise<readonly PoolSigner[]>,
  ) {
    this.store = new FileSealedPoolStore(file, vault);
  }

  /**
   * The journal as filed now, and the version it was read at. An absent file is
   * an empty journal at version 0 -- the one place in this product where absent
   * and empty are the same thing, because a journal that has never been written
   * to records exactly nothing and claims exactly nothing.
   */
  async open(): Promise<{ attempts: readonly PaymentAttempt[]; version: number }> {
    const rec = await this.store.get(this.vault);
    if (!rec) return { attempts: [], version: 0 };
    const page = openPool(rec, this.me.id, this.me.wrappingSecret) as unknown as PaymentJournalPage;
    if (!Array.isArray(page.attempts)) {
      throw new Error(
        'this vault\x27s payment journal opened but does not hold a list of attempts. It is not '
        + 'an empty journal: it is a record something other than this store wrote, and nothing '
        + 'is added to a record that cannot be read back.');
    }
    return { attempts: page.attempts, version: rec.version };
  }

  async record(vaultAddress: string, attempt: PaymentAttempt): Promise<void> {
    if (vaultAddress !== this.vault) {
      throw new Error(
        'this payment journal was built for a different vault than the one whose payment is '
        + 'being recorded. Nothing is written and nothing is paid. Neither address is printed.');
    }
    let lost: unknown;
    for (let i = 1; i <= JOURNAL_WRITE_ATTEMPTS; i += 1) {
      const now = await this.open();
      const page: PaymentJournalPage = { attempts: [...now.attempts, attempt] };
      try {
        await this.store.put(this.vault, sealPool(
          this.vault, page as never, await this.signers(), now.version + 1));
        return;
      } catch (cause) {
        if (!(cause instanceof VaultPoolVersionAlreadyFiled)) throw cause;
        lost = cause;
      }
    }
    throw new Error(
      `the payment\x27s attempt could not be journalled: another writer filed the next version `
      + `of this vault\x27s payment journal first on all ${JOURNAL_WRITE_ATTEMPTS} attempts. `
      + 'Nothing is written, nothing is proved and nothing is paid. Find what else is paying out '
      + 'of this vault before paying again.', { cause: lost });
  }
}

/**
 * **EVERYTHING THE JOURNALS ON THIS MACHINE SAY WAS ATTEMPTED AGAINST ONE
 * VAULT**, in the shape the rebuild takes.
 *
 * Every filed version of each journal is opened and the lines are taken as a
 * union: a version is cumulative, so the newest normally holds every line,
 * but a write that raced and lost is a version only the union sees. A line
 * present in several versions is one attempt, not several -- the same line
 * proposes the same note, so nothing is double-counted by keeping one.
 *
 * An absent journal is an empty one. Nothing was journalled, so nothing is
 * claimed, which is the one case where absent and empty agree.
 */
export const journalledAttempts = (input: {
  depositJournalFile: string;
  paymentJournalFile: string;
  vault: string;
  opener: JournalOpener;
}): AttemptedVaultCalls & { versionsRead: { deposits: number; payments: number } } => {
  const open = (file: string): unknown[] => {
    const pages: unknown[] = [];
    for (const v of everyVersionFiled(file, input.vault)) {
      pages.push(openPool(v.sealed, input.opener.id, input.opener.wrappingSecret));
    }
    return pages;
  };

  const depositPages = open(input.depositJournalFile);
  const deposits = new Map<string, VaultCoin>();
  for (const page of depositPages) {
    const lines = (page as { notes?: unknown }).notes;
    if (!Array.isArray(lines)) {
      throw new Error(
        'a version of this vault\x27s deposit journal opened but holds no list of lines. It is '
        + 'not empty; it is a record this reader does not understand, and a rebuild built on a '
        + 'guess about it would propose the wrong notes.');
    }
    for (const line of lines) {
      const { nonce, token, value } = line as VaultCoin;
      if (typeof nonce !== 'string' || typeof token !== 'string' || typeof value !== 'bigint') {
        throw new Error('a deposit journal line is not a coin (nonce, token, value). Nothing is proposed from it.');
      }
      deposits.set(`${nonce}:${token}:${value}`, { nonce, token, value });
    }
  }

  const paymentPages = open(input.paymentJournalFile);
  const payments = new Map<string, { spent: VaultCoin; amount: bigint }>();
  for (const page of paymentPages) {
    const lines = (page as { attempts?: unknown }).attempts;
    if (!Array.isArray(lines)) {
      throw new Error(
        'a version of this vault\x27s payment journal opened but holds no list of attempts. It is '
        + 'not empty; it is a record this reader does not understand.');
    }
    for (const line of lines) {
      const a = line as PaymentAttempt;
      const s = a?.spent;
      if (!s || typeof s.nonce !== 'string' || typeof s.token !== 'string'
        || typeof s.value !== 'bigint' || typeof a.amount !== 'bigint') {
        throw new Error('a payment journal line is not an attempt (spent note and amount). Nothing is proposed from it.');
      }
      payments.set(`${s.nonce}:${s.token}:${s.value}:${a.amount}`, {
        spent: { nonce: s.nonce, token: s.token, value: s.value }, amount: a.amount,
      });
    }
  }

  return {
    deposits: [...deposits.values()],
    payments: [...payments.values()],
    versionsRead: { deposits: depositPages.length, payments: paymentPages.length },
  };
};
