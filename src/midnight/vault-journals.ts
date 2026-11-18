/**
 * Where a vault payment or deposit writes down what it is about to spend or create before the money moves, so a
 * service that stops part way can tell, on its next start, what may have reached the chain. The journals hold no
 * money and decide nothing. A ledger given no journal refuses to pay or deposit: the empty journals here throw,
 * saying how to construct the ledger with one.
 */
import type { Hex } from '../core/crypto.js';
import type { DepositMoney } from './deposit-nonce.js';


/**
 * **WHAT A PRIVATE PAYMENT WRITES DOWN BEFORE ITS MONEY MOVES.**
 *
 * A payment spends one note and the chain keeps its change as a commitment,
 * which discloses nothing. The change note's nonce follows from the spent
 * note and the vault's nonce secret, and its colour is the spent note's colour,
 * so a rebuild holding the secret can derive both. **Its value is the spent note's value minus this payment's amount, and
 * the amount exists nowhere but in this process until the pool is written** --
 * which happens AFTER the call. A process that stops in between leaves the
 * vault holding money it cannot name, and a commitment cannot be inverted to
 * find it.
 *
 * So the attempt is recorded first: the note about to be spent, whole, and
 * the amount leaving it. Recorded, not applied -- this is what was ATTEMPTED,
 * and a line for a call that never landed is correct and harmless, because
 * the rebuild proposes it to the chain and the chain says whether it holds
 * the note. A pool entry for the same call would be the opposite: a claim the
 * vault holds a note it may not, which is every later payment refused.
 */
export interface PaymentAttempt {
  /** The note the step is about to spend first, exactly as the pool holds it. */
  readonly spent: { readonly nonce: Hex; readonly token: Hex; readonly value: bigint };
  /**
   * Every further note the same step spends, in place order, exactly as the
   * pool holds them. Absent or empty when it spends one note. Every note a step
   * spends is written down, because the coin it keeps is worth what all of
   * them held, and a line naming only the first describes a coin the chain
   * never made.
   */
  readonly further?: ReadonlyArray<{ readonly nonce: Hex; readonly token: Hex; readonly value: bigint }>;
  /**
   * What the step is: a payment of one payee, a batch, or a merge. Absent on a
   * line written before steps took several notes, which is a payment. A merge
   * sends nothing out and keeps one coin worth all it spent.
   */
  readonly step?: 'payment' | 'batch' | 'merge';
  /** How much is leaving: a payment's amount, a batch's total, nothing for a merge. The coin kept is worth the rest. */
  readonly amount: bigint;
  /** When, so two lines for one note can be told apart by a reader. */
  readonly attemptedAt: string;
}

/**
 * Where a payment's attempts are kept. An interface for the reason `NotePool`
 * is one: what it holds is a nonce, a colour and a value -- exactly what the
 * pool seals -- so it belongs in whatever sealed store the customer trusts
 * with the pool, and never in this module, whose callers include tests and a
 * server that must write no file.
 *
 * **`record` throws, and then nothing is proved or paid.** It is called after
 * the note is chosen and before the call, so a store that cannot be written
 * stops the payment while stopping still costs nothing. A refusal here after
 * the money moved would move the loss rather than remove it, and the order of
 * the two statements in `payPrivately` is the whole guarantee.
 */
export interface PaymentJournal {
  record(vaultAddress: string, attempt: PaymentAttempt): Promise<void>;
}

/**
 * The journal a `VaultLedger` has when it is given none: one that refuses a
 * private payment by name, before anything is proved. A ledger built to read
 * holdings, or to move public money, never reaches it; one built to pay
 * privately without saying where the attempt is written is one that would
 * open the window this record exists to close, and it is stopped instead.
 */
export const noPaymentJournal = (): PaymentJournal => ({
  record: async () => {
    throw new Error(
      'a private payment writes down the note it is about to spend and the amount before the '
      + 'money moves, and this ledger was given nowhere to write it. Nothing is proved or paid. '
      + 'Construct the ledger with a payment journal -- the sealed one the payment door keeps '
      + 'beside the pool -- and pay again.');
  },
});

/**
 * **WHAT A PRIVATE DEPOSIT WRITES DOWN BEFORE ITS MONEY MOVES.**
 *
 * A deposit creates a coin addressed to the vault, and its nonce is chosen by
 * the depositor before the transaction exists. The chain keeps only the coin's
 * commitment, which cannot be inverted, and the pool is written AFTER the call.
 * So between the call landing and the pool write, the nonce exists in this
 * process and nowhere else - and a process that stops there has put money in
 * the vault that nobody can name.
 *
 * So the coin is recorded first, whole. Like a payment's line it records an
 * ATTEMPT: a line for a call that never landed is correct and harmless, because
 * the rebuild proposes it to the chain and the chain does not hold it.
 */
export interface DepositAttempt {
  /** The coin the deposit is about to create. */
  readonly coin: { readonly nonce: Hex; readonly token: Hex; readonly value: bigint };
  /** When, so two lines for one nonce can be told apart by a reader. */
  readonly attemptedAt: string;
}

/**
 * Where a deposit's attempts are kept, and **what chooses a deposit's nonce**.
 *
 * `claim` files one line at the journal's next version, with the nonce derived
 * from the vault's nonce secret, the coin and the `slot` it is handed
 * (`claimNewDepositCoin` chooses the lowest slot whose coin was never made),
 * and hands back the coin it recorded. It is called before the call, and a
 * `claim` that throws stops the deposit while stopping still costs nothing. The
 * ledger calls the contract only with a coin a claim returned.
 *
 * `nonceAt` is the same derivation with nothing filed, so slots whose coin
 * already exists are passed over without a line each.
 */
export interface DepositJournal {
  claim(vaultAddress: string, money: DepositMoney, slot: number, attemptedAt: string): Promise<DepositAttempt>;
  nonceAt(vaultAddress: string, money: DepositMoney, slot: number): Hex;
}

/**
 * **THE DEPOSIT JOURNAL A `VaultLedger` HAS WHEN IT IS GIVEN NONE: ONE THAT
 * REFUSES A PRIVATE DEPOSIT, BY NAME, BEFORE ANYTHING IS PROVED.**
 *
 * Journalling a deposit used to be something one door did in its own code, so
 * the guarantee lasted exactly as long as every caller remembered it. It is
 * the ledger's now, the same way the payment's is: a ledger that would deposit
 * privately without saying where the coin is written is one that would open
 * the window the journal exists to close, and it is stopped instead.
 */
export const noDepositJournal = (): DepositJournal => {
  const refuse = (): never => {
    throw new Error(
      'a private deposit writes down the coin it is about to create before the money moves, and '
      + 'this ledger was given nowhere to write it. Nothing is proved or deposited. Construct the '
      + 'ledger with a deposit journal -- the sealed one the deposit door keeps beside the pool -- '
      + 'and deposit again.');
  };
  return { nonceAt: refuse, claim: async () => refuse() };
};
