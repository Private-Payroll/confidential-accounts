/**
 * WHICH CONTRACT AN ACCOUNT'S READS GO TO, AND WHERE THAT ANSWER IS ALLOWED TO
 * COME FROM.
 *
 * Every read the product performs - the state of an account, what has been paid
 * among a set of signers, a stored record - starts by turning an account id into
 * a contract address. This file is the rule that turns it, and the rule is one
 * sentence: **an account's contract address comes from that account's own
 * record, and from nowhere else.**
 *
 * ── WHY THERE IS NO FALLBACK, STATED AS THE FAILURE IT PREVENTS ──────────
 *
 * The obvious repair for an account with no recorded address is to reach for the
 * address this deployment already has in hand - it is resolved at boot, it is a
 * real contract, and it is right there. **It is also the same address for every
 * account.** A product that fell back to it would show every company the same
 * balances, the same open rounds and the same signer set, and nothing would look
 * broken: each screen would be full, internally consistent and about somebody
 * else.
 *
 * So an account with no recorded address resolves to nothing, and the boundary
 * above answers that it cannot say. **An empty answer is recoverable. A
 * confident answer about another company's contract is not.**
 *
 * ── OPENING AN ACCOUNT IS WHAT FILLS THIS IN ─────────────────────────────
 *
 * Each account is its own deployed contract, assigned when the account is
 * opened, read back from the ledger that assigned it and written onto the
 * account's record in the same breath. That is the only way a row appears here,
 * which is why a deployment that cannot write also cannot read: it has no
 * account of its own to have recorded.
 *
 * ── WHAT THIS FILE REFUSES, AND WHY EACH REFUSAL IS NOT PARANOIA ─────────
 *
 * A recorded address is thirty-two bytes written as sixty-four lower-case hex
 * characters. **So is an address a process invented for itself**, which is the
 * whole reason the record carries where the address came from as well as the
 * address. A shape check cannot tell them apart and neither can an indexer: ask
 * it about a contract that was never deployed and it answers that it has no
 * state, which is indistinguishable from an account that has none.
 *
 * That is the failure worth being exact about. It is not a crash. It is a
 * company whose screens are empty, whose rounds are absent and whose balances
 * read as zero, **on a record the product itself wrote**, with nothing anywhere
 * saying that the question was never really asked.
 *
 * ── WHAT THIS RULE DOES NOT CATCH, SAID PLAINLY RATHER THAN LEFT OUT ─────
 *
 * A record carrying a real address, assigned by a real chain, written by the
 * ledger that is running, **for a contract belonging to a different deployment
 * of this product on the same network**, passes every check here. Nothing in a
 * record distinguishes our contract from another instance's, because nothing in
 * the address does.
 *
 * What would settle it is the check the write path already performs and the read
 * path does not: connecting to a contract reads its verifier keys back and
 * refuses if they are not the ones this build proves against. A foreign
 * contract fails that. **A read never connects, so a read never asks.** Closing
 * it is a piece of work with a cost - a key read-back on every read - and it is
 * named here rather than implied, because a rule that is silent about its own
 * edge gets read as covering it.
 *
 * ── AND IT IS NOT THE ONLY READER OF THESE TWO FIELDS ────────────────────
 *
 * `src/core/company-address.ts` answers a different question over the same
 * record - which company a browser session may derive a key for - and it
 * answers it differently on purpose: it checks the address's shape and where it
 * came from, does not ask which ledger wrote the record, and has a development
 * escape this rule deliberately has not. **Two rules over two questions is
 * fine; two rules that disagree about the same one is not**, so the difference
 * is written here rather than left for somebody to find by meeting both.
 */
import type { AddressSource } from '../core/ledger.js';
import type { WiringName } from '../core/provenance.js';

/**
 * What the product has recorded about one account's contract.
 *
 * **THE THREE TRAVEL TOGETHER AND THIS TYPE IS WHY.** An address alone is a
 * string that cannot be checked; the two facts beside it are what make it
 * checkable, and a lookup that answered with the address by itself would have
 * discarded them before this rule ever ran. That is what the lookup used to do.
 */
export interface RecordedContract {
  /** Null while the account has not been opened on a chain. */
  readonly address: string | null;
  /** Whether a chain assigned it, or a process invented it. Absent is not known. */
  readonly source: AddressSource | null;
  /** Which ledger wrote the record. Absent is not known. */
  readonly wiring: WiringName | null;
}

/**
 * The rule, whole, over plain values.
 *
 * Separated from every reader for the reason the deployment rules are: a rule
 * that can only be exercised by arranging a store, a chain and a deployment is a
 * rule that gets exercised once.
 *
 * Returns the address to read at, or `null` for an account this deployment
 * cannot name a contract for. **It never returns an address it was not given.**
 */
export function contractForAccount(
  accountId: string,
  recorded: RecordedContract | null,
  running: WiringName,
): string | null {
  /*
   * Not an error and not a disagreement: an account that has not been opened on
   * a chain has no contract, and saying so is the answer the caller needs. The
   * boundary above turns this into "could not ask", which is the honest reading.
   */
  if (!recorded || recorded.address === null || recorded.address.trim() === '') return null;

  /*
   * **NOT KNOWN IS TREATED AS NOT A CHAIN'S, AND THAT IS THE FAIL-CLOSED
   * DIRECTION.** Reading an absent source as a chain's would make this check
   * pass for exactly the records it cannot vouch for - the ones written before
   * anything recorded the provenance at all.
   */
  if (recorded.source !== 'chain') {
    throw new Error(
      `account "${accountId}" has a contract address that no chain assigned - it was `
      + 'invented by whatever wrote the record, or the record predates anything that '
      + 'noted where the address came from. An invented address has the same shape as a '
      + 'real one, so asking about it returns "no state" rather than an error, and this '
      + 'company would read as empty instead of as unreadable. The account has to be '
      + 'opened on the chain this deployment talks to before its records can be read '
      + 'back.');
  }

  if (recorded.wiring !== running) {
    throw new Error(
      `account "${accountId}" was recorded by a ${recorded.wiring ?? 'ledger nothing noted'} `
      + `and this deployment is running the ${running} ledger. A record is read back by `
      + 'the ledger that wrote it; reading this one here would answer about a contract '
      + 'this deployment was never talking to.');
  }

  return recorded.address;
}

/**
 * **THE TWO HALVES OF THE LOOKUP, HELD TOGETHER, BECAUSE OPENING AN ACCOUNT
 * NEEDS BOTH WITHIN ONE CALL.**
 *
 * Opening an account is a deploy, and the address it produces is not known to
 * anybody until the deploy comes back. The ledger hands it over the moment it
 * has it; the product then asks the ledger for the account's address, and the
 * ledger answers by asking this lookup. **So between those two instants the
 * address exists nowhere else** - and a lookup that could only read the durable
 * record would answer nothing, the account would be filed with no address, and
 * the deploy that had just succeeded would be unreadable ever after.
 *
 * That is not hypothetical: it is what a lookup reading the store alone does,
 * and it is why the answer to *the store is empty* is not *fill the store from
 * the store*.
 *
 * **THE HOLDING IS TEMPORARY BY CONSTRUCTION AND NOT BY DISCIPLINE.** The
 * moment the durable record carries an address, that record is the answer and
 * the handover entry is dropped in the same call. So there is no window in
 * which two places could answer differently, and nothing accumulates: an entry
 * exists only between a deploy returning and the account being filed.
 */
export class ContractBook {
  private readonly justOpened = new Map<string, string>();

  /**
   * `recorded` reads the product's durable record for an account. It is a
   * parameter rather than a store because this class has no business knowing
   * how accounts are stored, and because the rule above can then be exercised
   * without one.
   */
  constructor(
    private readonly recorded: (accountId: string) => RecordedContract | null,
    private readonly running: WiringName,
  ) {}

  /**
   * The address to read this account's contract at, or null.
   *
   * **DURABLE FIRST, ALWAYS.** A handover entry is what an account has instead
   * of a record, never as well as one.
   */
  lookUp = async (accountId: string): Promise<string | null> => {
    /*
     * **A REFUSAL DROPS THE HANDOVER TOO, AND THAT IS NOT TIDINESS.** A record
     * this deployment cannot vouch for will refuse every time it is read, so an
     * entry held beside it would sit there for the life of the process - and it
     * would be holding the one kind of address this file says a read can never
     * vouch for. **The claim that nothing accumulates has to hold on the
     * failing path as well as the succeeding one, or it is not a claim.**
     */
    let durable: string | null;
    try {
      durable = contractForAccount(accountId, this.recorded(accountId), this.running);
    } catch (e) {
      this.justOpened.delete(accountId);
      throw e;
    }
    if (durable !== null) {
      this.justOpened.delete(accountId);
      return durable;
    }
    return this.justOpened.get(accountId) ?? null;
  };

  /**
   * Called by the ledger the instant a deploy assigns an address, so that the
   * product's own read of it - moments later, through `lookUp` - can answer.
   */
  record = async (accountId: string, address: string): Promise<void> => {
    this.justOpened.set(accountId, address);
  };
}
