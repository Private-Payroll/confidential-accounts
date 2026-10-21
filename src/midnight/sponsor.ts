/**
 * The fee payer: the one component that spends, paying the DUST fee of
 * transactions other people built and signed.
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
 *
 * **ONE FEE AT A TIME, FROM A VIEW THAT IS CURRENT.** The DUST spend is proved
 * against this wallet's own copy of the network's DUST trees and checked by the
 * node against the network's. So before it balances, the fee payer waits until
 * its view has applied every DUST event the indexer holds, read fresh, and shows
 * its own last accepted payment; a view that does not get there in time is a
 * refusal with nothing sent. A spend proof the node refuses at admission (170)
 * is answered once: the view is waited for again and the fee is balanced again
 * with a fresh proof. Any other refusal at admission is answered as nothing
 * sent, because a transaction the node refused there never entered its pool.
 */
import type { FeeSponsor } from './ledger.js';
import type { TxRef } from '../core/ledger.js';
import type { SponsoredFeeSink } from './sponsored-fees.js';
import {
  FeeRefused, dustSpentBy, refusalForCommitted, refusalForExpected, type FeeCeiling,
} from './fee-ceiling.js';
import { NothingWasSent, saysNothingWasSent } from '../core/jobs.js';

/** The codes a fee payer's refusal carries beside its words, so a page can say why in its own words. */
export type FeeAnswerCode = 'fee-not-paid' | 'network-refused';

/** No fee was paid and nothing was sent: the fee payer could not pay this one now. The step can be tried again. */
export class FeeNotPaid extends NothingWasSent {
  readonly code: FeeAnswerCode = 'fee-not-paid';
  constructor(message: string) {
    super(message);
    this.name = 'FeeNotPaid';
  }
}

/** The node refused the transaction at admission, so it never entered the pool and cannot land. */
export class NetworkRefused extends NothingWasSent {
  readonly code: FeeAnswerCode = 'network-refused';
  constructor(message: string) {
    super(message);
    this.name = 'NetworkRefused';
  }
}

/** The fee payer's code on an error that says nothing was sent, or null for any other error. */
export const feeAnswerCodeOf = (e: unknown): FeeAnswerCode | null => {
  if (!e || typeof e !== 'object' || (e as { nothingWasSent?: unknown }).nothingWasSent !== true) return null;
  const code = (e as { code?: unknown }).code;
  return code === 'fee-not-paid' || code === 'network-refused' ? code : null;
};

/** The node's code for a DUST spend proof that does not verify against the network's DUST state. */
export const DUST_SPEND_PROOF_REFUSED = 170;
/**
 * The node's code, when it checks a transaction before its pool, for an intent
 * the chain already holds: the same step may already have landed.
 */
export const INTENT_ALREADY_ON_CHAIN = 244;
/** The code the same words carry when a transaction is malformed; never read as nothing sent either. */
export const INTENT_ALREADY_EXISTS = 230;

/** A refusal at the node's door: the JSON-RPC code (1010 invalid, 1002 could not be checked) and its custom code. */
export interface PoolRefusal {
  readonly rpcCode: 1010 | 1002;
  readonly custom: number | null;
  readonly text: string;
}

const FIBER_FAILURE_CAUSE = Symbol.for('effect/Runtime/FiberFailure/Cause');

/**
 * The node's refusal at admission, read from the error a submission threw, or null.
 *
 * The wallet library rethrows a submission error with only its own words, so
 * the node's answer is found by walking the causes it keeps: its failure
 * cause, then each error's own cause. Only the JSON-RPC codes the node returns
 * when it validates a transaction before taking it into its pool count: 1010
 * (invalid) and 1002 (it could not check it). Every other code, a failure after
 * admission, and a dropped connection give null, because the transaction may
 * then be in the pool. A 1010 naming an intent the chain already holds (244,
 * or 230) gives null too: the same step may already have landed.
 */
export function poolRefusalOf(e: unknown): PoolRefusal | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [e];
  while (queue.length > 0 && seen.size < 64) {
    const x = queue.shift();
    if (x === null || typeof x !== 'object' || seen.has(x)) continue;
    seen.add(x);
    const o = x as Record<PropertyKey, unknown>;
    if ((o.code === 1010 || o.code === 1002) && typeof o.message === 'string') {
      const data = typeof o.data === 'string' ? o.data.trim() : '';
      const m = /^Custom error: (\d+)$/u.exec(data);
      const custom = m ? Number(m[1]) : null;
      if (o.code === 1010 && (custom === INTENT_ALREADY_ON_CHAIN || custom === INTENT_ALREADY_EXISTS)) return null;
      return { rpcCode: o.code, custom, text: o.message.slice(0, 240) };
    }
    queue.push(o[FIBER_FAILURE_CAUSE], o.cause, o.error, o.defect, o.left, o.right);
  }
  return null;
}

/**
 * **THE FEE PAYER'S OWN VIEW OF THE NETWORK'S DUST, READ BEFORE EVERY FEE.**
 *
 * One per wallet, shared by every fee payer built over it, because the last
 * accepted payment belongs to the wallet and not to the object that sent it.
 */
export interface FeePayerView {
  /** The last DUST event this wallet's view has applied, or null before the first. */
  applied(): bigint | null;
  /** The newest DUST event the indexer holds, read now. Throws when the indexer does not answer. */
  tip(): Promise<bigint>;
  /** Whether this wallet's own history shows its DUST side of the transaction with this hash. */
  shows(transactionHash: string): Promise<boolean>;
  /** What an operator needs to read a refusal: applied of tip, coins free and booked, the balance. */
  numbers(): string;
  /** Where a refusal and a refused spend proof are written down for the operator. */
  note(line: string): void;
  /** The hash of the last payment the network accepted from this wallet and the view has not shown yet. */
  lastAccepted: string | null;
}

/** How long a fee waits for the view, how long one write may run, and the clock it waits by. */
export interface ViewTiming {
  readonly waitMs: number;
  readonly pollMs: number;
  /** How long one write may run before the lane counts it as overdue and refuses every write queued behind it. */
  readonly writeLimitMs: number;
  /** The time kept back, within that limit, for a second balance, proof and hand-in after a refused spend proof. */
  readonly sendReserveMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * **45 SECONDS, UNDER THE LIMIT AFTER WHICH A WRITE COUNTS AS OVERDUE.** A
 * payment answered once after a refused spend proof waits twice, so the second
 * wait is cut to what is left of the write's limit once a second send's time
 * is kept back. The limit is the lane's own (four of the slowest recorded
 * writes and the waits between them), and a test holds the two equal.
 */
export const VIEW_TIMING: ViewTiming = {
  waitMs: 45_000,
  pollMs: 1_000,
  writeLimitMs: 4 * 34_700 + 5_000 + 10_000 + 15_000,
  sendReserveMs: 35_000,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const hashOf = (tx: unknown): string | null => {
  try {
    const h = (tx as { transactionHash?: () => unknown })?.transactionHash?.();
    return h === undefined || h === null ? null : String(h);
  } catch {
    return null;
  }
};

const isObject = (x: unknown): x is object => x !== null && (typeof x === 'object' || typeof x === 'function');

/**
 * **WHAT A SPONSOR NEEDS FROM A FUNDED WALLET, AND NOTHING MORE. THIS IS THE
 * SEAM.**
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
 *                                  not spend.** See below for why it is
 *                                  required.
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
 * optional member would mean a wallet could be wired in with no way to release.
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
  /**
   * The wallet's own view of the network's DUST. A wallet that has none (a
   * stand-in in a test, a script driving this seam by hand) pays without
   * waiting; every wallet a deployment pays with has one.
   */
  view?: FeePayerView;
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

/** What a person is told when the node refused the transaction at admission. */
const refusedWords = (r: PoolRefusal, afterOneMore: boolean): string =>
  `the network refused this transaction before taking it in (${r.text})${afterOneMore ? ', and refused it again after the fee was paid with a fresh proof' : ''}, `
  + 'so it was not sent and cannot land. No fee was paid, so nothing was lost: try the step again.';

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
  /**
   * What each finalised transaction was made from, so a spend proof the node
   * refuses can be balanced again from the same transaction with a fresh one.
   */
  private readonly madeFrom = new WeakMap<object, { customerFinalised: unknown; ttl: Date }>();
  /** Every transaction already handed to the network: a refusal of a second copy says nothing about the first. */
  private readonly handedIn = new WeakSet<object>();
  /** When the write this fee payer is paying for began: the lane names the company at the start of every write. */
  private writeStartedAt: number | null = null;

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
    /** How long a fee waits for the view to be current, and the clock it waits by. */
    private timing: ViewTiming = VIEW_TIMING,
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
    this.writeStartedAt = this.timing.now();
  }

  /**
   * Waits until the view has applied every DUST event the indexer holds, read
   * now, and shows the last payment the network accepted from this wallet.
   *
   * Refuses with `FeeNotPaid` when it does not get there within the bound, or
   * when the indexer cannot be asked, so nothing is booked and nothing is sent.
   * The last payment is remembered only once its hand-in returned, which the
   * wallet library does only when the transaction is final on the chain; a
   * hand-in that failed (refused, dropped, timed out) is never waited for. A
   * history that never shows a remembered payment (its write can fail and is
   * only logged) refuses one fee: the payment is then forgotten, which is
   * written down, and the next fee waits on the view alone.
   */
  private async waitForTheView(waitMs: number): Promise<void> {
    const view = this.wallet.view;
    if (!view) return;
    const { now, sleep, pollMs } = this.timing;
    const started = now();
    let tip: bigint;
    try {
      tip = await view.tip();
    } catch (e) {
      throw this.notPaid(view, `the indexer could not say how far the network's DUST has got (${String((e as Error)?.message ?? e)})`);
    }
    for (;;) {
      const applied = view.applied();
      const atTheTip = applied !== null && applied >= tip;
      const last = view.lastAccepted;
      const shown = last === null || await view.shows(last).catch(() => false);
      if (atTheTip && shown) {
        if (last !== null && view.lastAccepted === last) view.lastAccepted = null;
        return;
      }
      if (now() - started >= waitMs) {
        if (atTheTip && last !== null) {
          if (view.lastAccepted === last) view.lastAccepted = null;
          view.note(`THE WALLET'S HISTORY NEVER SHOWED ITS LAST PAYMENT ${last}: it is no longer waited for, and the next fee waits on the view alone`);
        }
        throw this.notPaid(view, atTheTip
          ? 'its view of the network\'s DUST does not show its own last payment yet'
          : `its view of the network's DUST is behind the indexer's ${tip}`);
      }
      await sleep(pollMs);
    }
  }

  /** The refusal for a fee not paid, written down for the operator with the view's numbers. */
  private notPaid(view: FeePayerView, why: string): FeeNotPaid {
    const numbers = view.numbers();
    view.note(`a fee was not paid: ${why} (${numbers})`);
    return new FeeNotPaid(
      `the fee payer did not pay this fee: ${why} (${numbers}). No fee was paid and nothing was sent, `
      + 'so nothing was lost: try the step again in a minute.');
  }

  /**
   * Phase 2: balance the dust leg only, then prove and merge.
   *
   * The customer has already balanced their own legs and signed. This waits
   * for the view to be current, adds the fee and hands back something
   * submittable.
   */
  async addFeeAndFinalise(customerFinalised: unknown, ttl: Date): Promise<unknown> {
    this.writeStartedAt ??= this.timing.now();
    return this.payFee(customerFinalised, ttl, this.timing.waitMs);
  }

  /** Waits for the view for at most `waitMs`, then balances, proves and checks the fee against the ceiling. */
  private async payFee(customerFinalised: unknown, ttl: Date, waitMs: number): Promise<unknown> {
    await this.waitForTheView(waitMs);
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
    ).catch((e: unknown) => {
      /* A balance that could not be made is written down with the numbers that explain it, then raised as it came. */
      this.wallet.view?.note(`a fee could not be balanced: ${String((e as Error)?.message ?? e).slice(0, 200)} (${this.wallet.view.numbers()})`);
      throw e;
    });

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
    if (isObject(finalised)) this.madeFrom.set(finalised, { customerFinalised, ttl });
    return finalised;
  }

  /**
   * Balances a refused spend proof's transaction again, with a fresh proof.
   *
   * The wait for the view is cut to what is left of the write's limit once a
   * second send's time is kept back, and with nothing left it does not pay
   * again. Every way this can fail is nothing sent, because the first copy
   * never entered the pool and the second has not been handed in: a refusal
   * that already says so (a view still behind, a fee over the ceiling, which
   * keeps its own words) is raised as it is, and anything else (a balance that
   * cannot be made) as `FeeNotPaid`.
   */
  private async payAgain(made: { customerFinalised: unknown; ttl: Date }, refusal: PoolRefusal): Promise<unknown> {
    const { now, writeLimitMs, sendReserveMs, waitMs } = this.timing;
    const left = writeLimitMs - (now() - (this.writeStartedAt ?? now())) - sendReserveMs;
    if (left <= 0) {
      throw new FeeNotPaid(
        `the network refused the fee's proof (${refusal.text}), and no time is left in this write to pay it again, `
        + 'so it was not sent. No fee was paid, so nothing was lost: try the step again.');
    }
    try {
      return await this.payFee(made.customerFinalised, made.ttl, Math.min(waitMs, left));
    } catch (e) {
      throw saysNothingWasSent(e) ? e : new FeeNotPaid(String((e as Error)?.message ?? e));
    }
  }

  /**
   * Hands one transaction to the network. Answers its reference, or the node's
   * refusal at admission when that is what the error was; any other error is
   * raised as it came, because the transaction may then be in the pool.
   *
   * The booking is released on every error. The wallet library usually has
   * released it already, and a second release then frees nothing, so releasing
   * is always safe. A copy
   * already handed in before is never read as refused at admission, because a
   * refusal of the second copy can mean the first one landed.
   */
  private async handIn(tx: unknown): Promise<{ ref: string } | { refusal: PoolRefusal }> {
    const again = isObject(tx) && this.handedIn.has(tx);
    if (isObject(tx)) this.handedIn.add(tx);
    try {
      return { ref: String(await this.wallet.submitTransaction(tx)) };
    } catch (e) {
      /* Swallowed here: `e` names what happened, and a failed release must not replace it. */
      try { await this.release(tx); } catch { /* see above */ }
      const refusal = again ? null : poolRefusalOf(e);
      if (refusal === null) throw e;
      const view = this.wallet.view;
      view?.note(`the network refused a payment at admission: ${refusal.text} (${view.numbers()})`);
      return { refusal };
    }
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
   *
   * **A REFUSAL AT ADMISSION IS NOTHING SENT, AND A REFUSED SPEND PROOF IS
   * ANSWERED ONCE.** The node validates a transaction before it takes it into
   * its pool, so one it refused there cannot land. A refused DUST spend proof
   * (170) is balanced again from the same transaction, after the view is waited
   * for, with a fresh proof and both ceiling checks, and handed in once more;
   * only one of the two can land, because the first never entered the pool.
   * Any other refusal at admission, or a second 170, is `NetworkRefused`; a
   * second fee that cannot be paid, or no time left in the write to pay it, is
   * `FeeNotPaid`, because neither copy reached the pool.
   * When the second copy is the one that landed, its hash comes back with the
   * reference, because it is not the hash of the transaction this was given.
   */
  async submit(finalisedTransaction: unknown): Promise<TxRef> {
    let landed = finalisedTransaction;
    let ref: string;
    const first = await this.handIn(finalisedTransaction);
    if ('ref' in first) {
      ref = first.ref;
    } else {
      const made = isObject(finalisedTransaction) ? this.madeFrom.get(finalisedTransaction) : undefined;
      if (first.refusal.custom !== DUST_SPEND_PROOF_REFUSED || made === undefined) {
        throw new NetworkRefused(refusedWords(first.refusal, false));
      }
      const again = await this.payAgain(made, first.refusal);
      const second = await this.handIn(again);
      if (!('ref' in second)) throw new NetworkRefused(refusedWords(second.refusal, true));
      ref = second.ref;
      landed = again;
    }
    const transactionHash = hashOf(landed);
    if (this.wallet.view) this.wallet.view.lastAccepted = transactionHash;
    /*
     * **EVERYTHING FROM HERE IS AFTER THE MONEY HAS MOVED, SO NOTHING FROM HERE
     * MAY THROW.** A transaction that settled and then reported a failure is
     * the worst answer available on this path: whoever reads it raises the same
     * run again, which is how a payroll gets paid twice.
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
       * **THE FEE HERE IS THE ONE THE CHAIN CHARGED, OR ABSENT.** What it
       * is NOT is a difference of the balance below against a previous one:
       * that figure lags its own spend, dust regenerates from held NIGHT while
       * nothing is happening, and a second sponsored transaction in the window
       * contaminates it.
       */
      this.onPay({ fee: actual ?? undefined, remaining: dust });
    }
    return landed === finalisedTransaction || transactionHash === null
      ? { ref: String(ref), at }
      : { ref: String(ref), at, transactionHash };
  }

  /**
   * **IT RAISES THE WALLET'S FAILURE.** A caller with an original failure to
   * protect swallows it at its own call site, by name, so the error naming what
   * happened is never replaced by a complaint about tidying up; any other
   * caller learns the release did not happen, so a count of releases is a
   * count of coins let go.
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
