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
 *   · **a deposit** writes the whole coin it is about to make.
 *     `VaultLedger.deposit` records it through the `DepositJournal` interface,
 *     and `SealedDepositJournal` below is the implementation the deposit door
 *     hands it. The door used to write this line in its own code, so the
 *     guarantee lasted as long as every caller remembered; the file and its
 *     shape are unchanged, so every line already on disk still reads.
 *   · **a payment** writes the note it is about to spend, whole, and the amount
 *     leaving it. `VaultLedger.payPrivately` records it through the
 *     `PaymentJournal` interface, and `SealedPaymentJournal` below is the
 *     implementation the payment door hands it.
 *
 * **A WRITE NEVER TAKES A READER AWAY.** Each write re-seals the whole journal
 * to the signers it is told about. A signer the journal is wrapped for and that
 * list has stopped naming would keep no copy of the new key, and the write would
 * succeed; so a write that would do that is refused, the same way a pool write
 * is.
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
import type {
  DepositAttempt, DepositJournal, PaymentAttempt, PaymentJournal,
} from '../src/midnight/vault-ledger.js';
import type { AttemptedVaultCalls } from '../src/midnight/vault-recovery.js';
import type { VaultCoin } from '../src/midnight/vault-coins.js';
import type { Hex } from '../src/core/crypto.js';
import { assertVaultName } from '../src/midnight/vault-record.js';
import { FileSealedPoolStore, everyVersionFiled } from './vault-pool-file.js';
import { assertNoSignerWouldLoseAccess } from './reconcile-vault-pool-rules.js';

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
 * **ONE SEALED JOURNAL FILE: READ, APPEND ONE LINE, FILE THE NEXT VERSION.**
 *
 * Both journals are this, with a different name for their list of lines and a
 * different line. Every append reads the journal as filed, appends one line, and
 * files the next version sealed to every signer -- so a line is on disk, whole,
 * before the append returns, and the ledger does not call the contract until it
 * has.
 */
class SealedJournalFile<Line> {
  private readonly store: FileSealedPoolStore;

  constructor(
    file: string,
    private readonly vault: string,
    private readonly me: JournalOpener,
    private readonly signers: () => Promise<readonly PoolSigner[]>,
    /** The name the sealed page gives its lines, and what the journal is called in a sentence. */
    private readonly page: { readonly lines: 'attempts' | 'notes'; readonly called: string },
  ) {
    this.store = new FileSealedPoolStore(file, vault);
  }

  /**
   * The journal as filed now, the version it was read at, and who it is wrapped
   * for. An absent file is an empty journal at version 0, wrapped for nobody --
   * the one place in this product where absent and empty are the same thing,
   * because a journal that has never been written to records exactly nothing and
   * claims exactly nothing.
   */
  async open(): Promise<{ lines: readonly Line[]; version: number; wrappedFor: readonly string[] }> {
    const rec = await this.store.get(this.vault);
    if (!rec) return { lines: [], version: 0, wrappedFor: [] };
    const opened = openPool(rec, this.me.id, this.me.wrappingSecret) as unknown as Record<string, unknown>;
    const lines = opened[this.page.lines];
    if (!Array.isArray(lines)) {
      throw new Error(
        `${this.page.called} opened but does not hold a list of ${this.page.lines}. It is not `
        + 'an empty journal: it is a record something other than this store wrote, and nothing '
        + 'is added to a record that cannot be read back.');
    }
    return { lines: lines as Line[], version: rec.version, wrappedFor: rec.wrapped.map((w) => w.signerId) };
  }

  async append(vaultAddress: string, line: Line, what: string): Promise<void> {
    if (vaultAddress !== this.vault) {
      throw new Error(
        `${this.page.called} was built for a different vault than the one whose ${what} is being `
        + `recorded. Nothing is written and nothing is ${what === 'deposit' ? 'deposited' : 'paid'}. `
        + 'Neither address is printed.');
    }
    let lost: unknown;
    for (let i = 1; i <= JOURNAL_WRITE_ATTEMPTS; i += 1) {
      const now = await this.open();
      const to = await this.signers();
      /*
       * **COMPARED AGAINST THE JOURNAL'S OWN WRAPPED LIST, ON EVERY WRITE.** A
       * door compares the POOL's list before it starts, and the journal is a
       * second record with its own list: a signer it is wrapped for and the list
       * handed here no longer names would lose the only record that names a lost
       * note, and the write would succeed.
       */
      assertNoSignerWouldLoseAccess(now.wrappedFor, to.map((s) => s.id), this.page.called);
      const page = { [this.page.lines]: [...now.lines, line] };
      try {
        await this.store.put(this.vault, sealPool(this.vault, page as never, to, now.version + 1));
        return;
      } catch (cause) {
        if (!(cause instanceof VaultPoolVersionAlreadyFiled)) throw cause;
        lost = cause;
      }
    }
    throw new Error(
      `the ${what}\x27s attempt could not be journalled: another writer filed the next version `
      + `of ${this.page.called} first on all ${JOURNAL_WRITE_ATTEMPTS} attempts. Nothing is `
      + `written, nothing is proved and nothing is ${what === 'deposit' ? 'deposited' : 'paid'}. `
      + `Find what else is moving money in or out of this vault before trying again.`, { cause: lost });
  }
}

/**
 * **THE PAYMENT JOURNAL A DOOR HANDS `VaultLedger`.**
 *
 * `open()` is separate and is called by the door BEFORE anything is proved:
 * a journal the secrets on this machine cannot open has to stop the run
 * while stopping costs nothing, not surface at the one moment this file
 * exists to survive. `record` itself refuses on the same condition, which is
 * the guarantee; `open()` is the courtesy of refusing early.
 */
export class SealedPaymentJournal implements PaymentJournal {
  private readonly file: SealedJournalFile<PaymentAttempt>;

  constructor(
    file: string,
    vault: string,
    me: JournalOpener,
    /** Everybody who must be able to open what this writes: the pool's signers. */
    signers: () => Promise<readonly PoolSigner[]>,
  ) {
    this.file = new SealedJournalFile(file, vault, me, signers, {
      lines: 'attempts', called: 'this vault\x27s payment journal',
    });
  }

  async open(): Promise<{ attempts: readonly PaymentAttempt[]; version: number }> {
    const now = await this.file.open();
    return { attempts: now.lines, version: now.version };
  }

  async record(vaultAddress: string, attempt: PaymentAttempt): Promise<void> {
    await this.file.append(vaultAddress, attempt, 'payment');
  }
}

/** One deposit journal line, exactly as the deposit door has always written it. */
interface DepositLine {
  readonly nonce: Hex;
  readonly token: Hex;
  readonly value: bigint;
  readonly attemptedAt: string;
}

/**
 * **THE DEPOSIT JOURNAL A DOOR HANDS `VaultLedger`.** The same file, name and
 * page the deposit door wrote in its own code -- `{ notes: [coin + attemptedAt] }`
 * -- so every line already on disk is read by the same reader, and nothing
 * about the record changes but who guarantees it is written.
 */
export class SealedDepositJournal implements DepositJournal {
  private readonly file: SealedJournalFile<DepositLine>;

  constructor(
    file: string,
    vault: string,
    me: JournalOpener,
    /** Everybody who must be able to open what this writes: the pool's signers. */
    signers: () => Promise<readonly PoolSigner[]>,
    /** Called once the line is on disk, before the ledger calls the contract. */
    private readonly written: () => void = () => {},
  ) {
    this.file = new SealedJournalFile(file, vault, me, signers, {
      lines: 'notes', called: 'this vault\x27s deposit journal',
    });
  }

  async open(): Promise<{ attempts: readonly DepositLine[]; version: number }> {
    const now = await this.file.open();
    return { attempts: now.lines, version: now.version };
  }

  async record(vaultAddress: string, attempt: DepositAttempt): Promise<void> {
    await this.file.append(vaultAddress, {
      nonce: attempt.coin.nonce, token: attempt.coin.token, value: attempt.coin.value,
      attemptedAt: attempt.attemptedAt,
    }, 'deposit');
    this.written();
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
