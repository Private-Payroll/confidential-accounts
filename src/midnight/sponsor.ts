/**
 * The fee sponsor. Decision 0001, M-4.
 *
 * This is the whole SaaS story in one file. DUST is non-transferable, so it
 * cannot be topped up into a customer's account — which sounds like a problem
 * and is actually the feature. The protocol's answer is two-phase balancing:
 * the customer balances the shielded and unshielded legs of their transaction
 * and signs it, and a sponsor balances only the dust leg and submits. **The
 * customer wallet never has to hold NIGHT or register for DUST generation at
 * all.**
 *
 * So the customer never sees a token, never funds anything, never learns what
 * DUST is. We hold NIGHT, generate DUST, and pay. That is a SaaS invoice
 * instead of a crypto onboarding, and it is the difference between a product a
 * finance team will use and one they will not.
 *
 * THE ONE RULE THAT MATTERS: the token kinds must not overlap. Re-balancing a
 * kind the other party has already balanced is a double spend, and the node
 * rejects the whole transaction. The customer takes `['shielded','unshielded']`
 * and the sponsor takes `['dust']`, and neither takes `'all'`.
 *
 * Verified against the installed `@midnightntwrk/wallet-sdk-facade`, not
 * against a document:
 *
 *   balanceFinalizedTransaction(tx, { shieldedSecretKeys, dustSecretKey },
 *                               { ttl, tokenKindsToBalance? })
 *     -> { type: 'FINALIZED_TRANSACTION', originalTransaction, balancingTransaction }
 *   finalizeRecipe(recipe) -> FinalizedTransaction     // proves and merges
 *
 * `balancingTransaction` comes back UNPROVEN. `finalizeRecipe` is what proves
 * it and merges it with the customer's, which is why this class calls both and
 * a caller cannot skip the second.
 */
import type { FeeSponsor } from './ledger.js';
import type { TxRef } from '../core/ledger.js';
import type { SponsoredFeeSink } from './sponsored-fees.js';
import {
  FeeRefused, dustSpentBy, refusalForCommitted, refusalForExpected, type FeeCeiling,
} from './fee-ceiling.js';

/**
 * **WHAT A SPONSOR NEEDS FROM A FUNDED WALLET, AND NOTHING MORE. THIS IS THE
 * SEAM, AND IT IS WIDER THAN ONE ROW ASKED FOR ON PURPOSE.**
 *
 * The party that pays is the only component in this system with spend
 * authority, so what it is allowed to ask a wallet for is worth deciding once
 * rather than growing a method at a time. Every member below is here because
 * paying for somebody else's transaction cannot be done without it:
 *
 *   `balanceFinalizedTransaction`  add the fee leg to a transaction that is
 *                                  already balanced, signed and finalised by
 *                                  its owner. **The FINALIZED method and not
 *                                  the unbound one**, and that is a custody
 *                                  decision rather than a preference: the
 *                                  unbound form mutates, re-signs and re-binds
 *                                  the transaction it is given, so a sponsor
 *                                  using it could alter the legs it is paying
 *                                  for. This one cannot.
 *   `finalizeRecipe`               the fee leg comes back unproven. Skipping
 *                                  this hands a recipe to a node instead of a
 *                                  transaction, and the failure surfaces from
 *                                  inside the vendor SDK naming none of this.
 *   `submitTransaction`            whoever pays the fee submits.
 *   `revert`                       **release coins this wallet booked and did
 *                                  not spend.** See below - it is the member
 *                                  this interface was missing, and its absence
 *                                  was not a gap in tidiness.
 *   `estimateFee`                  what the transaction is about to cost,
 *                                  read BEFORE anything is booked. It is the
 *                                  vendor's own pre-spend control at this exact
 *                                  call site, and it is the only moment the
 *                                  expected cost exists at all.
 *   `paidFee`                      what it actually cost, or `null` when that
 *                                  cannot be said. Answers rather than throws:
 *                                  it runs after the money has moved.
 *   `balances`                     what is left to pay with, so an operator
 *                                  learns the fee budget is running out before
 *                                  customers start failing.
 *   the two keys                   what the balancing call is given.
 *
 * **WHY `revert` IS REQUIRED AND NOT OPTIONAL.** Balancing marks coins as
 * in-flight in the wallet's own state. Nothing releases them by time - the
 * vendor's sweep for that is documented as a no-op - and nothing releases them
 * on failure, because a transaction that was balanced and never submitted never
 * acquires a result for the vendor's own cleanup to act on. **So a booking made
 * by a call that then threw stands for ever, and the next attempt balances onto
 * a fresh coin set because the first one is filtered out as pending.** The
 * balance quietly falls with each failure and nothing anywhere says why. An
 * optional member would mean a wallet could be wired in with no way to release,
 * which is the state this seam is in today.
 *
 * **WHAT IS DELIBERATELY NOT HERE, SO THAT ADDING IT LATER IS A DECISION AND
 * NOT A DISCOVERY.** The vendor offers a sponsor two spend controls at exactly
 * this call site - checking that what it is about to pay for was actually
 * signed, and estimating the fee before committing to it. **The second is here
 * and the first is not.** The signature check produces a verdict about the
 * company's half, and the fee payer's exposure does not depend on it: what the
 * fee payer can lose on one transaction is bounded by the ceiling below whether
 * or not the other half is well signed.
 *
 * **WHAT A SPONSOR PAYS IS CAPPED, AND THE CAP IS IN THE CLASS BELOW RATHER
 * THAN IN THIS INTERFACE.** The fee follows the transaction's complexity and
 * somebody else composes the transaction, so without a cap the failure is a
 * bill. The class refuses before booking when the estimate is already over the
 * ceiling, and refuses again - releasing what it booked - when the balanced
 * transaction declares more DUST spent than the ceiling allows. The second
 * check reads the transaction itself, so it needs nothing more from a wallet
 * than this interface already asks for.
 */
export interface SponsorWallet {
  balanceFinalizedTransaction(
    tx: unknown,
    secretKeys: { shieldedSecretKeys: unknown; dustSecretKey: unknown },
    options: { ttl: Date; tokenKindsToBalance?: string[] },
  ): Promise<unknown>;
  finalizeRecipe(recipe: unknown): Promise<unknown>;
  submitTransaction(tx: unknown): Promise<string>;
  /**
   * Release coins booked by a balance that was not spent.
   *
   * Takes whatever the balancing produced - the recipe, or the transaction it
   * became - because which of the two is in hand depends on how far the attempt
   * got, and a release that could only be given one of them would be a release
   * that cannot run at the point it is needed.
   */
  revert(booking: unknown): Promise<void>;
  /**
   * What this transaction is expected to cost, before anything is committed to.
   *
   * **IT IS THE VENDOR'S OWN PRE-SPEND CONTROL AT EXACTLY THIS CALL SITE**, and
   * it is here now because the number it produces cannot be recovered
   * afterwards: it is the fee the balance below is ABOUT to converge on, and
   * the balancing call returns the transaction without it. Read after the fact
   * you get what was charged; read here you get what could have been decided
   * on.
   *
   * **IT ESTIMATES THE FEE INCLUDING THE BALANCING LEG.** The cheaper call
   * next to it in the vendor's interface prices the transaction alone and says
   * in its own docstring that it lacks the fees of the balancing transaction -
   * which, for a fee payer that adds nothing but a fee leg, is the only leg it
   * is paying for. **The cheap one is the wrong number, not a rough one.**
   *
   * **IT IS A FIRST CHECK AND NOT THE DECIDING ONE.** Over the ceiling, the
   * payment is refused before anything is booked. Unread, the payment goes on
   * to the balance, and the amount read off the balanced transaction decides.
   */
  estimateFee(tx: unknown, ttl: Date): Promise<bigint>;
  /**
   * What a submitted transaction actually cost, or `null` when it cannot be
   * said.
   *
   * **IT ANSWERS `null` RATHER THAN THROWING, AND `null` RATHER THAN
   * GUESSING.** The charged fee is on the chain rather than in the wallet, so
   * reading it is a question asked of something that may not answer in time,
   * on a path where the money has already moved. A reading that did not come
   * back is not a failure of the payment and must never be reported as one -
   * and it is not a zero either.
   *
   * **THE OBVIOUS SUBSTITUTE IS REFUSED HERE RATHER THAN LEFT TO BE TRIED: a
   * difference of wallet balances is not this number.** The balance lags the
   * spend it is meant to show, dust regenerates continuously from held NIGHT so
   * the figure moves for reasons that have nothing to do with this
   * transaction, and any second sponsored transaction in the window
   * contaminates it.
   */
  paidFee(ref: string): Promise<bigint | null>;
  shieldedSecretKeys: unknown;
  dustSecretKey: unknown;
  balances(): Promise<{ dust: bigint; night: bigint }>;
}

/**
 * The token kinds each party balances. Deliberately constants rather than
 * arguments: this is the invariant, not a tuning knob, and a caller who could
 * pass `'all'` here could create a double spend from a plausible-looking call.
 */
export const CUSTOMER_BALANCES = ['shielded', 'unshielded'] as const;
export const SPONSOR_BALANCES = ['dust'] as const;

export class WalletFeeSponsor implements FeeSponsor {
  /**
   * The company the transaction in flight belongs to, and the estimate taken
   * for it.
   *
   * **TWO FIELDS ON AN OBJECT THAT PAYS FOR OTHER PEOPLE'S TRANSACTIONS, AND
   * BOTH ARE THERE BECAUSE THE INFORMATION EXISTS NOWHERE ELSE BY THE TIME IT
   * IS WANTED.** The company is told to this object and cannot be derived from
   * what it is handed; the estimate is read before the balance and is gone
   * once the balance has run. The company decides nothing. The estimate is
   * compared with the ceiling once, before the balance, and is otherwise a
   * record.
   *
   * **THEY REST ON ONE OPERATION AT A TIME**, which is the same property the
   * provider bundle above this already rests on and states. Two operations
   * through one fee payer at once would make the record wrong rather than
   * absent, and the fix is a fee payer per operation.
   */
  private company: string | null = null;
  private estimated: bigint | null = null;

  constructor(
    private wallet: SponsorWallet,
    /**
     * The most one transaction may spend from this wallet's DUST.
     *
     * **REQUIRED, AND CHECKED HERE**, because a fee payer built without one pays
     * whatever it is handed, and the place that would notice is an invoice.
     */
    private ceiling: FeeCeiling,
    /**
     * Told when the sponsor pays, and how much capacity is left.
     *
     * Not optional in spirit: this component is the only one in the system that
     * spends, so an operator who cannot see it spending finds out that DUST ran
     * out when customers start failing.
     */
    private onPay?: (info: { fee?: bigint; remaining?: bigint }) => void,
    /**
     * Where the record of this payment goes: which company, expected, actual.
     *
     * Optional only because a script driving this seam by hand has nowhere to
     * put one. Every deployment supplies one, and the reason it is taken at all
     * is that attribution cannot be extracted from a shielded transaction after
     * the fact.
     */
    private fees?: SponsoredFeeSink,
  ) {
    if (!ceiling || typeof ceiling.perTransaction !== 'bigint' || ceiling.perTransaction <= 0n) {
      throw new Error(
        'a fee payer was about to be built with no ceiling on what one transaction may spend, '
        + 'so it was not built. Without one it pays whatever it is handed.');
    }
  }

  /**
   * Which company the next transaction is for.
   *
   * It clears the previous estimate at the same time, and that pairing is the
   * point: an estimate belongs to one transaction, and an estimate left
   * standing from the previous one would be filed against this one as though it
   * had been measured for it.
   */
  payingFor(accountId: string): void {
    this.company = accountId;
    this.estimated = null;
  }

  /**
   * Phase 2: balance the dust leg only, then prove and merge.
   *
   * The customer has already balanced their own legs and signed. This adds the
   * fee and hands back something submittable.
   */
  async addFeeAndFinalise(customerFinalised: unknown, ttl: Date): Promise<unknown> {
    /*
     * **READ BEFORE ANYTHING IS BOOKED.** This is the only moment the expected
     * cost exists: it is the fee the balance below is about to converge on,
     * and the balance hands back a transaction rather than a price.
     *
     * **OVER THE CEILING, IT STOPS HERE, WITH NOTHING TO RELEASE.** A reading
     * that did not come back does not stop anything: an instrument failing is
     * not a reason to refuse, and the amount read off the balanced transaction
     * below decides either way. **What is not read is recorded as not read.**
     */
    this.estimated = await this.wallet.estimateFee(customerFinalised, ttl).catch(() => null);
    const tooDear = refusalForExpected(this.estimated, this.ceiling);
    if (tooDear) throw new FeeRefused(tooDear);

    const recipe = await this.wallet.balanceFinalizedTransaction(
      customerFinalised,
      {
        shieldedSecretKeys: this.wallet.shieldedSecretKeys,
        dustSecretKey: this.wallet.dustSecretKey,
      },
      /*
       * **DUST ONLY, ALWAYS, AND NEVER THE ARGUMENT'S OWN DEFAULT.** Anything
       * wider re-balances what the customer already balanced, which the node
       * reads as a double spend. And the default if this were omitted is
       * *everything*: the sponsor would quietly pay the customer's shielded and
       * unshielded legs out of its own coins, with no error and no warning.
       * **A constant rather than an argument, so no caller can widen it.**
       */
      { ttl, tokenKindsToBalance: [...SPONSOR_BALANCES] },
    );

    /*
     * **FROM THIS LINE THE COINS ARE BOOKED**, so every way out of the rest of
     * this method has to release them. Nothing else will: time does not, and
     * the vendor's own cleanup never sees a transaction that was balanced and
     * not submitted.
     *
     * `balancingTransaction` arrives unproven. Skipping the call below produces
     * a recipe rather than a transaction, and the failure lands at submission
     * as a type error from inside the SDK — which names none of this.
     */
    let finalised: unknown;
    try {
      finalised = await this.wallet.finalizeRecipe(recipe);
    } catch (e) {
      /* Swallowed HERE and not inside the release: `e` is the error naming what
       * actually happened, and a complaint about tidying up in its place sends
       * whoever reads it to the wrong layer. */
      try { await this.release(recipe); } catch { /* see above */ }
      throw e;
    }

    /*
     * **THE CHECK THAT DECIDES, ON THE TRANSACTION THAT WOULD BE SENT.** The
     * DUST it declares it will spend is the most the chain can take from this
     * wallet for it. Over the ceiling, or unreadable, the booking is released
     * and nothing is handed back to submit. The release target is the
     * transaction, as it is on the submit path below, because that is what the
     * booking has become.
     */
    const overCeiling = refusalForCommitted(dustSpentBy(finalised), this.ceiling);
    if (overCeiling) {
      try { await this.release(finalised); } catch { /* the refusal is the error that matters */ }
      throw new FeeRefused(overCeiling);
    }
    return finalised;
  }

  /**
   * Phase 3: whoever pays the fee submits.
   *
   * **A THROW HERE IS NOT PROOF THE TRANSACTION DID NOT LAND**, and this method
   * does not pretend otherwise: it releases the booking and re-raises, and what
   * the state machine above makes of that is the state machine's business. What
   * it must not do is leave the coins booked on the one path where the outcome
   * is unknown, because that is the path most likely to be tried again.
   *
   * **AND THE COMPANY'S SIDE OF THE SAME WINDOW DOES THE OPPOSITE, DELIBERATELY
   * — SAID HERE SO THAT NEITHER HALF READS AS THE ONLY ANSWER.** The layer that
   * links the two callbacks forgets the company's booking without releasing it,
   * because the vendor's release on a transaction that DID land destroys the
   * pending entry chain sync would have used to repair the local state. **These
   * coins are ours and a resync is a thing we do; the company's wallet is on a
   * device we do not operate**, so what is worth protecting there is the
   * self-healing path rather than the booking. Both decisions are written down
   * with what they cost.
   */
  async submit(finalisedTransaction: unknown): Promise<TxRef> {
    let ref: string;
    try {
      ref = await this.wallet.submitTransaction(finalisedTransaction);
    } catch (e) {
      /* Swallowed here, for the reason above. */
      try { await this.release(finalisedTransaction); } catch { /* see above */ }
      throw e;
    }
    /*
     * **EVERYTHING FROM HERE IS AFTER THE MONEY HAS MOVED, SO NOTHING FROM HERE
     * MAY THROW.** A transaction that settled and then reported a failure is
     * the worst answer available on this path: whoever reads it raises the same
     * round again, which is how a payroll gets paid twice.
     */
    const at = new Date().toISOString();
    const actual = await this.wallet.paidFee(String(ref)).catch(() => null);
    if (this.fees) {
      try {
        this.fees.record({
          at,
          company: this.company,
          estimated: this.estimated,
          actual,
          ref: String(ref),
        });
      } catch { /* a record must never turn a payment that landed into a failure */ }
    }
    if (this.onPay) {
      const { dust } = await this.wallet.balances().catch(() => ({ dust: undefined as any }));
      /*
       * **THE FEE HERE IS THE ONE THE CHAIN CHARGED, OR ABSENT.** It used to be
       * absent always - the field existed and nothing ever filled it. What it
       * is NOT is a difference of the balance below against a previous one:
       * that figure lags its own spend, dust regenerates from held NIGHT while
       * nothing is happening, and a second sponsored transaction in the window
       * contaminates it.
       */
      this.onPay({ fee: actual ?? undefined, remaining: dust });
    }
    return { ref: String(ref), at };
  }

  /**
   * **IT REPORTS ITS OWN FAILURE, AND UNTIL IT DID THE COUNT ABOVE THIS SEAM
   * WAS A COUNT OF ATTEMPTS WEARING THE WORD *RELEASED*.**
   *
   * This method swallowed. Every caller therefore saw success whatever the
   * vendor did, the layer that keeps the record of what is outstanding deleted
   * bookings it had not released, and the number it answered - which exists so
   * a caller can assert that coins were let go rather than assert the absence
   * of a complaint - could not be wrong. **A release that cannot fail is
   * exactly the instrument every open row in this area is *done when* somebody
   * asserts on.**
   *
   * **THE SWALLOW WAS RIGHT AND IT WAS IN THE WRONG PLACE.** A release that
   * fails must never replace the failure that caused it: this runs on a path
   * that has already gone wrong, and swapping the error naming what happened
   * for a complaint about tidying up sends whoever reads it somewhere else
   * entirely. That is a property of the two CALL SITES that have an original
   * failure to protect, not of the release - so each of them swallows, by
   * name, and a caller with nothing to protect gets the truth.
   *
   * **IT IS PUBLIC BECAUSE THE WINDOW IT GUARDS IS NOT INSIDE THIS CLASS.** The
   * two methods above are called by the SDK at two separate times, and what
   * goes wrong between them goes wrong where neither of them is running. So
   * whoever owns both phases has to be able to say *let that go*, and that is
   * what the interface member this satisfies is for.
   */
  async release(booking: unknown): Promise<void> {
    await this.wallet.revert(booking);
  }

  /**
   * Remaining capacity, so we alarm before customers start failing.
   *
   * DUST regenerates from held NIGHT rather than being bought, so "running out"
   * is a rate problem, not a balance problem: a burst of customer activity can
   * outrun generation while the NIGHT balance looks perfectly healthy. Both
   * numbers are reported for that reason.
   */
  async capacity(): Promise<{ dust: bigint; night: bigint }> {
    return this.wallet.balances();
  }
}
