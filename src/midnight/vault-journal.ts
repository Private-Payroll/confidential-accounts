/**
 * **THE ATTEMPT JOURNALS: WHAT IS WRITTEN DOWN BEFORE A VAULT'S MONEY MOVES,
 * AND HOW A REBUILD READS IT BACK, OVER ANY STORE.**
 *
 * A vault's pool is written AFTER the transaction, because the other order
 * leaves a pool claiming a note the chain never made. So between the call
 * landing and the pool write there is a window in which the chain holds a note
 * nothing has named yet -- and a commitment discloses nothing, so a process
 * that stops in that window has lost the name for good unless it was written
 * down FIRST.
 *
 *   · **a deposit** writes the whole coin it is about to make
 *     (`DepositJournal`, implemented by `DepositJournalInStore`);
 *   · **a payment** writes the note it is about to spend, whole, and the amount
 *     leaving it (`PaymentJournal`, implemented by `PaymentJournalInStore`).
 *
 * **THE STORE IS A PARAMETER, AND THAT IS THE WHOLE REASON THIS FILE IS HERE.**
 * The same journal is kept in a file by the operator tools and in the
 * product's database by the product, and a journal whose logic lived beside one
 * of those stores is a guarantee the other one does not have. Every store
 * satisfies `SealedPoolStore`: one writer per version, versions that follow one
 * another, a write that returns having happened, and nothing ever removed.
 *
 * **A WRITE NEVER TAKES A READER AWAY.** Each write re-seals the whole journal
 * to the signers it is told about, so a write that would drop a signer the
 * journal is wrapped for is refused, the same way a pool write is.
 *
 * **A JOURNAL IS NOT A POOL AND MUST NEVER BE READ AS ONE.** The pool is a claim
 * about what the vault HOLDS; a journal is a record of what was ATTEMPTED. A
 * line for a call that never landed is correct and harmless: the rebuild
 * proposes it to the chain and the chain does not hold it.
 *
 * **SEALED TO THE SAME SIGNERS AS THE POOL, BECAUSE IT CARRIES WHAT THE POOL
 * CARRIES** -- a nonce, a colour and a value. Each journal is a `SealedPool`
 * record, filed one version per write, which is also what makes reading it back
 * a union over every version rather than a trust in the newest.
 *
 * **TWO JOURNALS, NOT ONE WITH TWO SHAPES.** A deposit's lines are coins, under
 * `notes`; a payment's are attempts, under `attempts`. A shared record would
 * need a discriminator the existing lines do not carry, and a reader guessing a
 * line's shape can read a payment as a deposit.
 */
import {
  sealPool, openPool, assertNoSignerWouldLoseAccess,
  type PoolSigner, type SealedPoolStore, type FiledPoolVersion,
} from './vault-pool.js';
import type {
  DepositAttempt, DepositJournal, PaymentAttempt, PaymentJournal,
} from './vault-ledger.js';
import {
  depositNonceAt, DepositSlotTaken, DEPOSIT_CLAIM_LIVE_MS, type DepositMoney, type DepositNonceKey,
} from './deposit-nonce.js';
import type { AttemptedVaultCalls } from './vault-recovery.js';
import type { VaultCoin } from './vault-coins.js';
import type { Hex } from '../core/crypto.js';

/** One signer who can open a sealed record here. */
export interface JournalOpener {
  readonly id: string;
  readonly wrappingSecret: Hex;
}

/**
 * How many times a write that lost the version to another writer is tried
 * again against a fresh read. Two processes moving one vault's money at once is
 * the only way to lose it, and each retry re-reads and re-appends.
 */
export const JOURNAL_WRITE_ATTEMPTS = 5;

/**
 * **ONE SEALED JOURNAL: READ, APPEND ONE LINE, FILE THE NEXT VERSION.**
 *
 * Every append reads the journal as filed, appends one line, and files the next
 * version sealed to every signer -- so a line is stored, whole and durable,
 * before the append returns, and the ledger does not call the contract until it
 * has.
 */
export class SealedJournal<Line> {
  constructor(
    private readonly store: SealedPoolStore,
    private readonly vault: string,
    private readonly me: JournalOpener,
    private readonly signers: () => Promise<readonly PoolSigner[]>,
    /** The name the sealed page gives its lines, and what the journal is called in a sentence. */
    private readonly page: {
      readonly lines: 'attempts' | 'notes';
      readonly called: string;
      readonly record: 'deposit-journal' | 'payment-journal';
    },
  ) {}

  /**
   * The journal as filed now, the version it was read at, and who it is wrapped
   * for. An absent record is an empty journal at version 0, wrapped for nobody --
   * the one place in this product where absent and empty are the same thing,
   * because a journal that has never been written to records exactly nothing and
   * claims exactly nothing.
   */
  async open(): Promise<{ lines: readonly Line[]; version: number; wrappedFor: readonly string[] }> {
    const rec = await this.store.get(this.vault);
    if (!rec) return { lines: [], version: 0, wrappedFor: [] };
    const opened = openPool(rec, this.me.id, this.me.wrappingSecret, {
      record: this.page.record, unlabelled: this.store.unlabelledRecordsFiled === true ? 'accept' : 'refuse',
    }) as unknown as Record<string, unknown>;
    const lines = opened[this.page.lines];
    if (!Array.isArray(lines)) {
      throw new Error(
        `${this.page.called} opened but does not hold a list of ${this.page.lines}. It is not `
        + 'an empty journal: it is a record something other than this journal wrote, and nothing '
        + 'is added to a record that cannot be read back.');
    }
    return { lines: lines as Line[], version: rec.version, wrappedFor: rec.wrapped.map((w) => w.signerId) };
  }

  /**
   * Files one line at the next version and returns the line as filed.
   *
   * **THE LINE IS BUILT FOR THE VERSION THIS ATTEMPT FILES**, and built again
   * when a lost race moves it to the next one, so a line that depended on its
   * version would always be the line of the version that holds it.
   */
  async append(
    vaultAddress: string, lineAt: (version: number) => Line, what: 'deposit' | 'payment',
    /**
     * Asked of the lines as filed, on every attempt and so after every lost
     * race: an error it answers stops the append, and nothing is written.
     */
    refuse?: (lines: readonly Line[]) => Error | null,
  ): Promise<{ line: Line; version: number }> {
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
       * signer the journal is wrapped for and the list handed here no longer
       * names would lose the only record that names a lost note, and the write
       * would succeed.
       */
      assertNoSignerWouldLoseAccess(now.wrappedFor, to.map((s) => s.id), this.page.called);
      const refused = refuse?.(now.lines) ?? null;
      if (refused !== null) throw refused;
      const version = now.version + 1;
      const line = lineAt(version);
      const page = { [this.page.lines]: [...now.lines, line] };
      try {
        await this.store.put(this.vault, sealPool(this.vault, page as never, to, version, this.page.record));
        return { line, version };
      } catch (cause) {
        /*
         * **BY NAME, NOT BY `instanceof`.** A store in another module, or a
         * bundle holding its own copy of this one, raises the same named refusal
         * from a different class object, and a retry that silently stopped
         * happening would leave the payment refusing for a race it could win.
         */
        if (!(cause instanceof Error && cause.name === 'VaultPoolVersionAlreadyFiled')) throw cause;
        lost = cause;
      }
    }
    throw new Error(
      `the ${what}\x27s attempt could not be journalled: another writer filed the next version `
      + `of ${this.page.called} first on all ${JOURNAL_WRITE_ATTEMPTS} attempts. Nothing is `
      + `written, nothing is proved and nothing is ${what === 'deposit' ? 'deposited' : 'paid'}. `
      + 'Find what else is moving money in or out of this vault before trying again.', { cause: lost });
  }
}

/**
 * **THE PAYMENT JOURNAL A LEDGER IS HANDED, OVER ANY STORE.**
 *
 * `open()` is for calling BEFORE anything is proved: a journal the secret in
 * hand cannot open has to stop the run while stopping costs nothing. `record`
 * refuses on the same condition, which is the guarantee; `open()` is the
 * courtesy of refusing early.
 */
export class PaymentJournalInStore implements PaymentJournal {
  private readonly journal: SealedJournal<PaymentAttempt>;

  constructor(
    store: SealedPoolStore,
    vault: string,
    me: JournalOpener,
    /** Everybody who must be able to open what this writes: the pool's signers. */
    signers: () => Promise<readonly PoolSigner[]>,
  ) {
    this.journal = new SealedJournal(store, vault, me, signers, {
      lines: 'attempts', called: 'this vault\x27s payment journal', record: 'payment-journal',
    });
  }

  async open(): Promise<{ attempts: readonly PaymentAttempt[]; version: number }> {
    const now = await this.journal.open();
    return { attempts: now.lines, version: now.version };
  }

  async record(vaultAddress: string, attempt: PaymentAttempt): Promise<void> {
    await this.journal.append(vaultAddress, () => attempt, 'payment');
  }
}

/** One deposit journal line, exactly as the deposit journal has always written it. */
export interface DepositLine {
  readonly nonce: Hex;
  readonly token: Hex;
  readonly value: bigint;
  readonly attemptedAt: string;
}

/**
 * **THE DEPOSIT JOURNAL A LEDGER IS HANDED, OVER ANY STORE.** The page is
 * `{ notes: [coin + attemptedAt] }`, the shape every deposit line has always had.
 *
 * **IT DERIVES THE NONCE, INSIDE THE CLAIM.** The nonce comes from the vault's
 * deposit nonce key, the coin, and the slot the caller chose as the lowest one
 * whose coin was never made (`claimNewDepositCoin`), and the coin handed back is the coin
 * that line records. A caller never supplies a nonce, so no caller can make a
 * deposit that the vault's nonce secret cannot name again.
 */
export class DepositJournalInStore implements DepositJournal {
  private readonly journal: SealedJournal<DepositLine>;

  constructor(
    store: SealedPoolStore,
    vault: string,
    me: JournalOpener,
    /** Everybody who must be able to open what this writes: the pool's signers. */
    signers: () => Promise<readonly PoolSigner[]>,
    /** The key this vault's deposit nonces are derived from. */
    private readonly nonces: DepositNonceKey,
    /** Called once the line is stored, before the ledger calls the contract. */
    private readonly written: () => void = () => {},
  ) {
    this.journal = new SealedJournal(store, vault, me, signers, {
      lines: 'notes', called: 'this vault\x27s deposit journal', record: 'deposit-journal',
    });
  }

  async open(): Promise<{ attempts: readonly DepositLine[]; version: number }> {
    const now = await this.journal.open();
    return { attempts: now.lines, version: now.version };
  }

  nonceAt(_vaultAddress: string, money: DepositMoney, slot: number): Hex {
    return depositNonceAt(this.nonces, money, slot);
  }

  /**
   * **A SLOT ANOTHER DEPOSIT CLAIMED A MOMENT AGO IS NOT CLAIMED AGAIN.** Two
   * signers, two browsers or two tabs depositing the same money into one vault
   * at once each find the same lowest free slot, because neither deposit has
   * reached the chain. The journal is the one record both write to, one version
   * at a time, and it is read again after every lost race; so a line for this
   * very coin filed within `DEPOSIT_CLAIM_LIVE_MS` of this claim refuses it with
   * `DepositSlotTaken`, and the caller tries the next slot. An older line is a
   * deposit that can no longer land, and its slot is free again.
   */
  async claim(vaultAddress: string, money: DepositMoney, slot: number, attemptedAt: string): Promise<DepositAttempt> {
    const nonce = depositNonceAt(this.nonces, money, slot);
    const at = Date.parse(attemptedAt);
    const { line } = await this.journal.append(vaultAddress, () => ({
      nonce,
      token: money.token,
      value: money.value,
      attemptedAt,
    }), 'deposit', (lines) => {
      const recent = lines.some((l) => l.nonce.toLowerCase() === nonce.toLowerCase() && l.token.toLowerCase() === money.token.toLowerCase()
        && l.value === money.value && !(at - Date.parse(l.attemptedAt) >= DEPOSIT_CLAIM_LIVE_MS));
      return recent ? new DepositSlotTaken(slot) : null;
    });
    this.written();
    return { coin: { nonce: line.nonce, token: line.token, value: line.value }, attemptedAt: line.attemptedAt };
  }
}

/**
 * **EVERYTHING THE JOURNALS SAY WAS ATTEMPTED AGAINST ONE VAULT**, from their
 * filed versions, in the shape the rebuild takes.
 *
 * Every filed version of each journal is opened and the lines are taken as a
 * union: a version is cumulative, so the newest normally holds every line, but
 * the union costs nothing and trusts no single version. A line present in
 * several versions is one attempt, not several.
 *
 * No versions is an empty journal. Nothing was journalled, so nothing is
 * claimed, which is the one case where absent and empty agree.
 */
export const attemptsFromJournalVersions = (input: {
  deposits: readonly FiledPoolVersion[];
  payments: readonly FiledPoolVersion[];
  opener: JournalOpener;
  /** `accept` only for versions read from a store that kept records before they were labelled. */
  unlabelled?: 'accept' | 'refuse';
}): AttemptedVaultCalls & { versionsRead: { deposits: number; payments: number } } => {
  const open = (filed: readonly FiledPoolVersion[], record: 'deposit-journal' | 'payment-journal'): unknown[] =>
    filed.map((v) => openPool(v.sealed, input.opener.id, input.opener.wrappingSecret, {
      record, unlabelled: input.unlabelled ?? 'refuse',
    }));

  const depositPages = open(input.deposits, 'deposit-journal');
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

  const paymentPages = open(input.payments, 'payment-journal');
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
