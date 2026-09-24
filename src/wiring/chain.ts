/**
 * THE BOUNDARY, IMPLEMENTED AGAINST THE REAL CHAIN.
 *
 * This module holds the second implementation set: the Midnight ledger, the
 * Midnight proof server, and the commitment scheme computed by the contract's
 * own circuits. It is the first place outside a test where those three are
 * constructed together.
 *
 * ── IT IS A SEPARATE MODULE, AND THAT IS NOT ORGANISATION ────────────────
 *
 * The selector next door is loaded by the browser page. Everything in here
 * reaches the contract's generated code, which reaches a WebAssembly runtime,
 * and a page that loads that runtime does not start at all. So this file exists
 * so that the selector can name a chain implementation set without CONTAINING
 * one: nothing here may ever be imported by a module the page also loads.
 * `src/web/no-wasm-in-the-page.test.ts` is what notices if that changes.
 *
 * ── WHAT THIS SET CAN AND CANNOT DO TODAY, STATED RATHER THAN DISCOVERED ─
 *
 * **IT READS THE CHAIN, AND IT WRITES ONLY WHEN IT WAS HANDED A FUNDED PAIR.**
 * Reading needs an indexer. Writing needs a wallet that holds funds, and a
 * deployment started the ordinary way has none: the only wallets in this
 * repository are brought up by operator scripts a person runs, which hold their
 * own keys and hand them over on purpose. A server does not have one of its own
 * and must not quietly acquire one.
 *
 * **SO THE WRITES REFUSE, BY NAME, AND THEY REFUSE EARLY.** That is the whole
 * of `ChainLedger` below, and the reason it is a wrapper rather than a comment
 * is worth writing down, because the obvious alternative is actively dangerous:
 *
 *   Handing the product a Midnight ledger whose providers have no wallet does
 *   NOT fail at the point of payment. `propose` and `proposeRun` stage a
 *   proposal salt into the device's private state store BEFORE the transaction
 *   is built, and the ledger says so itself where it does it. The transaction
 *   then dies for want of a wallet — and the device is left holding a salt for
 *   a round that was never raised. The next governance change recomputes an
 *   already-approved round's identity from that salt, gets a different one, and
 *   refuses about the wrong thing. **An approved round becomes unapplicable
 *   from that device, permanently, and nothing anywhere says why.**
 *
 * A refusal above the staging step costs a sentence. A refusal below it costs a
 * round that reached its threshold and can never be settled.
 */
import {
  MidnightLedger, MidnightProofSystem,
  type MidnightConfig, type FeeSponsor,
} from '../midnight/ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { FileSealedStateStore } from '../midnight/sealed-store.js';
import { midnightProviders, sponsoredProviders, type CustomerWallet } from '../midnight/providers.js';
import { NothingWasSent, saysNothingWasSent } from '../core/jobs.js';
import {
  refusalForProven, refusalUnlessOnlyACallTo, readProvenTransaction, readFinishedTransaction,
} from './proven-submission.js';
import type {
  Ledger, LedgerAddress, LedgerStatus, LedgerRecord, PaymentsAmong, PaidMovements,
  AccountOpening, SealedStateAt, TxRef, SignerRef, WriteInFlight, VaultTxArrival, VaultTxSent,
} from '../core/ledger.js';
import type { Hex } from '../core/crypto.js';
import type { Deployment } from './deployment.js';

import { type ContractBook } from './account-contract.js';
import { refusalForCapability, type WriteCapability } from './write-capability.js';
import { VaultLedger, type NotePool } from '../midnight/vault-ledger.js';
import { chainVaultHoldings } from '../midnight/vault-holdings.js';
import type { VaultHoldings } from '../core/vault-holdings.js';

/**
 * **THE SPEND-AUTHORITY SEAT, LEFT EMPTY UNLESS THIS DEPLOYMENT WAS GIVEN ONE,
 * AND NEVER LEFT NULL.**
 *
 * A construction site that passes `null` works by accident and becomes a crash
 * at the moment somebody gives the parameter a reader - which is the moment a
 * transaction is already being paid for.
 *
 * This object is what goes in that seat instead when there is nobody to pay. It
 * satisfies the interface and every member refuses, so the seat is filled by
 * something that cannot silently do the wrong thing, and the day the parameter
 * acquires a reader this deployment says so in words rather than dereferencing
 * nothing.
 */
const noSponsor = (refusal: string): FeeSponsor => ({
  /* What a description reads, so the seat being filled is not reported as somebody paying. */
  paysNothing: true,
  addFeeAndFinalise: async () => Promise.reject(new Error(refusal)),
  submit: async () => Promise.reject(new Error(refusal)),
  /*
   * **THE ONE MEMBER THAT SUCCEEDS ON A DEPLOYMENT THAT CANNOT PAY, AND IT IS
   * NOT AN INCONSISTENCY.** A release says *let go of what a balance booked*.
   * Nothing here has balanced anything - every other member refuses - so there
   * is nothing booked and the honest answer is that it is already released.
   * Refusing instead would put a second error in front of whoever is handling
   * the first one, on the cleanup path, which is exactly where an error is
   * least useful.
   */
  release: async () => {},
  /*
   * **A NO-OP, AND FOR THE SAME REASON THE RELEASE ABOVE IS.** Being told which
   * company a transaction belongs to is a record, not an action, and there is
   * nothing here that will ever pay for one. Refusing would put a second error
   * in front of a caller that is about to meet the real one.
   */
  payingFor: () => {},
  capacity: async () => Promise.reject(new Error(
    'the fee sponsor\'s remaining capacity is not available on this deployment: '
    + 'nothing is wired to pay fees, so there is no balance to report')),
});

/**
 * For the things that are NOT writes and still cannot be done here. Kept apart
 * from a write refusal because an operator whose private state store will not
 * open should not be told the cause is a missing wallet: a refusal that names
 * the wrong cause sends somebody to fix the wrong thing.
 */
const refuseUnwired = (what: string, why: string): Promise<never> =>
  Promise.reject(new Error(`${what} is not available on this deployment: ${why}`));

/* ---- how long a write may run before later ones stop waiting for it ---- */

/**
 * **THE SLOWEST SINGLE WRITE RECORDED THROUGH A PROOF SERVER ON STAGENET: 34.7
 * SECONDS**, a company created through the product's own service, proved,
 * balanced, submitted and settled. Every other write recorded through a proof
 * server there - thirty governance steps, two deploys, a deposit, a mint and a
 * sponsored call - took between 17.2 and 31.3 seconds. The time a wallet takes
 * to come up is not in it and is not inside a write: a wallet is up before this
 * ledger exists.
 */
export const SLOWEST_RECORDED_WRITE_MS = 34_700;

/**
 * **HOW MANY TIMES OPENING AN ACCOUNT IS ATTEMPTED, AND HOW LONG IT WAITS
 * BETWEEN ATTEMPTS IN ALL.** Opening is the one write retried underneath this
 * ledger: four attempts, waiting five, ten and fifteen seconds between them.
 * These are the retry's own defaults and this ledger passes no override; they
 * are restated here so the deadline below can be read as arithmetic, and a
 * test holds them to what the retry actually does.
 */
export const OPENING_ATTEMPTS = 4;
export const OPENING_WAITS_MS = 5_000 + 10_000 + 15_000;

/**
 * **A WRITE STILL RUNNING AFTER THIS LONG IS OVERDUE: 168.8 SECONDS.** Every
 * attempt of the one retried write taking as long as the slowest write ever
 * recorded, plus every wait between them. **IT IS A THRESHOLD FOR SAYING SO, NOT
 * A BOUND ON HOW LONG A WRITE CAN TAKE**: it rests on one slowest sample, and a
 * submission that is never answered waits without limit. It over-counts in the
 * safe direction, because that sample includes work done once per write rather
 * than once per attempt.
 *
 * **WHAT IT DOES AND WHAT IT DOES NOT.** It does not stop the write, release its
 * fee payer or let anything past it - the write may still reach the chain, and
 * a second write started beside it would have its fee recorded against the
 * wrong company. It changes two things: a later write through the same fee
 * payer is refused by name instead of waiting for ever, and the health check
 * says the product is not healthy. **So a deadline that is too long costs a
 * person waiting longer to be told; one that is too short refuses a second
 * press that would have gone through, and shows an unhealthy product to
 * somebody who may stop the server while a slow write is about to land** - a
 * company opened that way reaches the chain with no record here. The first is
 * the cheaper mistake.
 */
export const WRITE_OVERDUE_AFTER_MS =
  OPENING_ATTEMPTS * SLOWEST_RECORDED_WRITE_MS + OPENING_WAITS_MS;

/**
 * The clock a lane is judged by. Only a test passes anything else.
 */
export interface LaneClock {
  readonly now: () => number;
  readonly overdueAfterMs: number;
}
const REAL_CLOCK: LaneClock = { now: () => Date.now(), overdueAfterMs: WRITE_OVERDUE_AFTER_MS };

/** The write a fee payer is busy with. */
interface Running {
  readonly what: string;
  readonly startedAt: number;
  readonly clock: LaneClock;
  overdue: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** A write waiting its turn, and how to turn it away. */
interface Queued {
  readonly what: string;
  readonly refuse: (e: Error) => void;
  gaveUp: boolean;
}

/**
 * **ONE LANE PER FEE PAYER.** `tail` settles when everything queued so far has
 * finished or been turned away; `running` is the write under way; `queued` are
 * the ones behind it that have not started.
 */
interface Lane {
  tail: Promise<void>;
  running: Running | null;
  readonly queued: Set<Queued>;
}

/**
 * The lane each fee payer's writes go through. `ChainLedger.write` says why.
 * Weak, so a fee payer nobody holds is not kept.
 */
const lanes = new WeakMap<FeeSponsor, Lane>();

const laneOf = (payer: FeeSponsor): Lane => {
  let lane = lanes.get(payer);
  if (!lane) {
    lane = { tail: Promise.resolve(), running: null, queued: new Set() };
    lanes.set(payer, lane);
  }
  return lane;
};

const isOverdue = (r: Running): boolean =>
  r.overdue || r.clock.now() - r.startedAt >= r.clock.overdueAfterMs;

const secondsOf = (r: Running): number =>
  Math.max(0, Math.floor((r.clock.now() - r.startedAt) / 1000));

/**
 * **THE SENTENCE A LATER WRITE IS REFUSED WITH.** It reaches whoever made the
 * later write, who is often not whoever made the stuck one - so it says that
 * their own request did nothing, when to try it again, and, for whoever runs the
 * server, the one thing that would make it worse.
 */
const refusalBehindOverdueWrite = (what: string, r: Running): string =>
  `${what} was not started, and nothing was spent on it: this deployment's fee payer is still `
  + `busy with an earlier write (${r.what}, running since ${new Date(r.startedAt).toISOString()}, `
  + `${secondsOf(r)} seconds), longer than a write is expected to take. Nothing else is sent `
  + 'through that wallet until it finishes, so that no fee is recorded against the wrong '
  + 'company. Try this again once the health check no longer shows a write in flight - but if '
  + 'the earlier write was yours, find out first whether it reached the chain, because if it did, '
  + 'trying again does it a second time. Stopping the server does not undo a write that has '
  + 'already been sent, and a company being opened would then reach the chain with no record '
  + 'here, so whoever runs the server should find out whether it landed before stopping it.';

/** Turn away everything queued behind a write that has become overdue. */
const refuseQueued = (lane: Lane, r: Running): void => {
  for (const q of lane.queued) {
    q.gaveUp = true;
    q.refuse(new Error(refusalBehindOverdueWrite(q.what, r)));
  }
  lane.queued.clear();
};

/**
 * The chain ledger the product is handed.
 *
 * **READS ARE DELEGATED WHOLE AND NOTHING HERE REPAIRS AN ANSWER.** That is
 * the property this class holds for `status`, and it is worth being exact
 * about, because the boundary underneath is less exact than it should be:
 *
 *   `Ledger.status` is documented as answering `null` *when the account is not
 *   on this ledger*. The Midnight implementation answers `null` for that, AND
 *   for a contract the indexer has no state for. An indexer that cannot be
 *   reached at all does not answer `null` — it rejects, which is the loud and
 *   correct outcome.
 *
 * So the two meanings are not separated at this boundary, and this wrapper
 * cannot separate them: it has no information the ledger has not got. **What it
 * can do, and does, is never turn an unanswered read into an answer** — a
 * repaired `null` becomes an empty status, and an empty status read as truth
 * lets a caller close a record the chain still holds.
 *
 * **WRITES REFUSE HERE, ABOVE THE LEDGER, WHENEVER THIS DEPLOYMENT WAS NOT
 * GIVEN WHAT WRITING NEEDS** - and when it was, they are delegated whole, the
 * same way reads are. The refusal is one sentence built in one place from what
 * is actually missing, so a deployment short of one piece says which piece
 * rather than reciting a general apology.
 */
export class ChainLedger implements Ledger {
  /**
   * Taken from the ledger this wraps rather than restated.
   *
   * The value a record is stamped with must be the one the ledger underneath
   * would have used. Two literals here would be two things to keep in step, and
   * the one that went stale would be the one nobody reads.
   */
  get wiring() { return this.inner.wiring; }

  /**
   * The sentence, computed once at construction rather than per call.
   *
   * **NULL MEANS THIS DEPLOYMENT CAN WRITE**, and it is the only thing any
   * write method below consults. There is deliberately no second way to ask -
   * a method that checked some other field could disagree with this one, and
   * the disagreement would be a write that got through.
   */
  private readonly cannotWrite: string | null;

  /**
   * Who pays, kept so that every write can say whose transaction it is.
   *
   * **ONLY EVER TOLD, NEVER ASKED.** Nothing here reads a balance, a capacity
   * or a decision off this object - `cannotWrite` above is still the one field
   * any write consults, and there is deliberately no second way to ask whether
   * this deployment may write.
   */
  private readonly payer: FeeSponsor | undefined;

  /**
   * The company's side, kept for the one write that does not go through the
   * ledger underneath: a transaction a signer's device already proved.
   */
  private readonly company: CustomerWallet | undefined;

  constructor(
    private readonly inner: MidnightLedger,
    private readonly deployment: Deployment,
    capability?: WriteCapability,
    private readonly clock: LaneClock = REAL_CLOCK,
  ) {
    this.cannotWrite = refusalForCapability(capability);
    this.payer = capability?.sponsor;
    this.company = capability?.customer;
  }

  /**
   * **A REJECTED PROMISE, NEVER A SYNCHRONOUS THROW.** Every method that uses
   * this is declared to return one, and a caller that writes `.catch(...)` on a
   * method that throws before it returns does not catch anything — the exception
   * comes out of the call rather than out of the promise. A refusal that escapes
   * the caller's error handling is a refusal the product cannot report.
   */
  private refuse(what: string): Promise<never> {
    return Promise.reject(new Error(`${what} needs to write to the chain, and ${this.cannotWrite}`));
  }

  /* ---- reads: the chain answers, and nothing here repairs the answer ---- */

  address(accountId: string): Promise<LedgerAddress | null> {
    return this.inner.address(accountId);
  }

  status(accountId: string): Promise<LedgerStatus | null> {
    return this.inner.status(accountId);
  }

  paidAmong(accountId: string, leaves: Hex[]): Promise<PaymentsAmong | null> {
    return this.inner.paidAmong(accountId, leaves);
  }

  paidMovementsOf(accountId: string): Promise<PaidMovements | null> {
    return this.inner.paidMovementsOf(accountId);
  }

  fetch(accountId: string, keyEpoch: number): Promise<LedgerRecord | null> {
    return this.inner.fetch(accountId, keyEpoch);
  }

  /**
   * Delegated, and the ground is narrower than it first looks: resealing READS
   * the chain — it resolves the address and the contract state before it files
   * anything — but it WRITES only to this deployment's own blob storage. It
   * stages no private state and builds no transaction, so it is safe here.
   * Refusing it would stop an account being read back at all, which is a loss
   * with no safety bought.
   */
  reseal(accountId: string, next: SealedStateAt): Promise<void> {
    return this.inner.reseal(accountId, next);
  }

  /**
   * **WHAT IS RUNNING, AND ONLY WHAT IS RUNNING.** The ledger underneath
   * describes itself as sponsoring fees, which on a deployment with nobody to
   * pay is a claim about a component it has not got. This sentence is the one
   * an operator reads on the health route and at boot, so it says the narrower
   * true thing in both directions.
   */
  describe(): string {
    return `Midnight ${this.deployment.network} via ${this.deployment.indexerUrl}, `
      + (this.cannotWrite === null
        ? 'reading and writing (a wallet is wired, so this deployment can open companies '
          + 'and raise rounds)'
        : 'read-only (no wallet is wired, so nothing can be written to the chain)');
  }

  /**
   * **THE WRITE THIS DEPLOYMENT'S FEE PAYER IS BUSY WITH, OR `null`.** Read from
   * the same lane every write goes through, so it cannot disagree with what a
   * write would be told. A deployment that cannot write has no lane and nothing
   * in flight.
   */
  writeInFlight(): WriteInFlight | null {
    if (this.cannotWrite || !this.payer) return null;
    const r = lanes.get(this.payer)?.running;
    if (!r) return null;
    return {
      what: r.what,
      since: new Date(r.startedAt).toISOString(),
      seconds: secondsOf(r),
      overdue: isOverdue(r),
      waiting: lanes.get(this.payer)?.queued.size ?? 0,
    };
  }

  /* ---- writes: refused above everything that stages anything, or delegated whole ---- */

  /**
   * **ONE GATE AND ONE PLACE THE COMPANY IS NAMED, FOR ALL NINE WRITES.**
   *
   * Every write below is the same two decisions - may this deployment write,
   * and whose transaction is this - and they were nine copies of the first and
   * nowhere at all for the second. Nine copies of a rule is nine chances for
   * one of them to drift, and the one that drifts is a write that got through.
   *
   * **WHY THE COMPANY IS NAMED HERE AND NOT DEEPER.** A fee payer is handed a
   * bound, shielded transaction; whose it is cannot be read off it, off a
   * receipt or off the chain. This is the last layer that still knows, and
   * after it the answer does not exist anywhere. **It is a record and nothing
   * refuses on it** - a write is never stopped for want of an attribution.
   *
   * The delegation is a thunk rather than a promise so the inner call is not
   * started before the refusal is decided.
   */
  private write<T>(accountId: string, what: string, go: () => Promise<T>): Promise<T> {
    if (this.cannotWrite) return this.refuse(what);
    const payer = this.payer!;
    /*
     * **ONE WRITE AT A TIME PER FEE PAYER, WAITING ITS TURN BEHIND THE LAST.**
     *
     * The fee payer holds whose transaction it is paying for, and what it
     * expected to pay, on itself - the vendor's callbacks carry nothing that
     * tells one operation from another. Two writes running at once would share
     * those two fields, and the second would overwrite the first's company
     * before the first recorded what it paid: a fee record that is wrong rather
     * than absent. Its wallet also books coins while it balances, and two
     * balances racing for one wallet's coins is a failed payment for somebody.
     *
     * **KEYED ON THE FEE PAYER, NOT ON THIS OBJECT**, because the fee payer is
     * the thing being shared: two ledgers built over one fee payer must queue
     * behind each other too. A write that fails lets the next one go.
     *
     * **AND A WRITE THAT NEVER SETTLES DOES NOT LET THE NEXT ONE GO.** Nothing
     * here can tell a write that will never settle from one that is slow and
     * will still land, so the lane is never released on a clock. What the clock
     * decides is only whether the writes behind it keep waiting: once the
     * running one is overdue, each of them - and each that arrives after - is
     * refused by name, and the health check says so.
     */
    const lane = laneOf(payer);
    if (lane.running && isOverdue(lane.running)) {
      return Promise.reject(new Error(refusalBehindOverdueWrite(what, lane.running)));
    }
    let refuse!: (e: Error) => void;
    const refused = new Promise<never>((_, reject) => { refuse = reject; });
    const queued: Queued = { what, refuse, gaveUp: false };
    lane.queued.add(queued);

    const clock = this.clock;
    const run = async (): Promise<T | undefined> => {
      lane.queued.delete(queued);
      /* Turned away while it waited; the caller has its refusal already. */
      if (queued.gaveUp) return undefined;
      const running: Running = {
        what, startedAt: clock.now(), clock, overdue: false, timer: undefined,
      };
      lane.running = running;
      running.timer = setTimeout(() => {
        running.overdue = true;
        if (lane.running === running) refuseQueued(lane, running);
      }, clock.overdueAfterMs);
      /* A process with nothing else to do is not kept alive by this clock. */
      running.timer.unref?.();
      try {
        /*
         * Told before the work starts, because the fee payer reads it at the
         * moment it records a payment, which is inside the call below.
         */
        payer.payingFor(accountId);
        return await go();
      } finally {
        clearTimeout(running.timer);
        if (lane.running === running) lane.running = null;
      }
    };
    const turn = lane.tail.then(run);
    lane.tail = turn.then(() => undefined, () => undefined);
    return Promise.race([turn, refused]) as Promise<T>;
  }

  open(accountId: string, opening: AccountOpening): Promise<TxRef> {
    return this.write(accountId, 'opening an account',
      () => this.inner.open(accountId, opening));
  }

  propose(...args: Parameters<Ledger['propose']>): Promise<TxRef> {
    return this.write(args[0], 'raising a round', () => this.inner.propose(...args));
  }

  proposeRun(...args: Parameters<Ledger['proposeRun']>): ReturnType<Ledger['proposeRun']> {
    return this.write(args[0], 'raising a payroll round',
      () => this.inner.proposeRun(...args)) as ReturnType<Ledger['proposeRun']>;
  }

  approve(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef> {
    return this.write(accountId, 'approving a round',
      () => this.inner.approve(accountId, proposalId, by));
  }

  cancel(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef> {
    return this.write(accountId, 'cancelling a round',
      () => this.inner.cancel(accountId, proposalId, by));
  }

  addSigner(accountId: string, leaf: Hex, proposalId: Hex | null, by: SignerRef): Promise<TxRef> {
    return this.write(accountId, 'adding a signer',
      () => this.inner.addSigner(accountId, leaf, proposalId, by));
  }

  removeSigner(accountId: string, removedLeaf: Hex, proposalId: Hex, by: SignerRef): Promise<TxRef> {
    return this.write(accountId, 'removing a signer',
      () => this.inner.removeSigner(accountId, removedLeaf, proposalId, by));
  }

  setThreshold(...args: Parameters<Ledger['setThreshold']>): Promise<TxRef> {
    return this.write(args[0], 'changing the approval threshold',
      () => this.inner.setThreshold(...args));
  }

  setVaultThreshold(...args: Parameters<Ledger['setVaultThreshold']>): Promise<TxRef> {
    return this.write(args[0], 'changing a vault\'s approval threshold',
      () => this.inner.setVaultThreshold(...args));
  }

  /**
   * **A TRANSACTION A SIGNER'S DEVICE ALREADY PROVED, BALANCED, PAID FOR AND
   * SENT.**
   *
   * Nothing is proved here. The company's side balances what it owns, the fee
   * payer adds the capped fee, and the fee payer submits - the same two parties,
   * in the same order, through the same one-write-at-a-time lane as every other
   * write. Before anything is booked the transaction is read and refused unless
   * it only calls this company's own contract.
   *
   * **EVERY FAILURE BEFORE THE SUBMISSION CARRIES THE MARK THAT NOTHING WAS
   * SENT**, including a refusal to start because an earlier write is overdue,
   * so the device can say so. A failure of the submission itself does not: it
   * may have landed.
   */
  /**
   * **A VAULT TRANSACTION A SIGNER'S DEVICE BUILT, PAID FOR AND SENT, WITH NO
   * COMPANY WALLET ANYWHERE ON THE WAY.**
   *
   * `check` reads the transaction and answers a sentence to refuse it; nothing
   * is booked until it answers `null`. A transaction that moves nothing, or
   * moves only a vault's own coins, is bound here; one a depositor's wallet
   * finished is already bound and signed.
   * Either way the fee payer adds only DUST and submits, so the token kinds the
   * two parties balance never overlap.
   *
   * Through the same one-write-at-a-time lane as every other write, and every
   * failure before the submission carries the mark that nothing was sent.
   */
  sendVault(
    accountId: string,
    what: string,
    arrival: VaultTxArrival,
    bytes: Uint8Array,
    check: (tx: unknown) => string | null | Promise<string | null>,
    read: (bytes: Uint8Array) => Promise<unknown>,
  ): Promise<VaultTxSent> {
    let submitting = false;
    return this.write(accountId, what, async () => {
      let tx: unknown;
      try {
        tx = await read(bytes);
      } catch {
        throw new NothingWasSent(`this is not a transaction this service can read, so ${what} was not paid for. Nothing was sent.`);
      }
      const refusal = await check(tx);
      if (refusal !== null) throw new NothingWasSent(refusal);
      /* Only a depositor's wallet binds and signs what it finished; everything else a device sends is bound here. */
      const bound = arrival === 'finished-by-the-depositor'
        ? tx
        : (tx as { bind(): unknown }).bind();
      const deadline = new Date(Date.now() + 20 * 60_000);
      const payer = this.payer!;
      const finalised = await payer.addFeeAndFinalise(bound, deadline);
      let transactionHash: string | null = null;
      try {
        transactionHash = String((finalised as { transactionHash(): unknown }).transactionHash());
      } catch { /* the reference below still names it */ }
      submitting = true;
      const ref = await payer.submit(finalised);
      return { ref: String(ref.ref), at: ref.at, transactionHash };
    }).catch((e: unknown) => {
      if (submitting || saysNothingWasSent(e)) throw e;
      throw new NothingWasSent(String((e as { message?: unknown })?.message ?? e));
    });
  }

  submitProven(
    accountId: string,
    proven: Uint8Array,
    read: (bytes: Uint8Array) => Promise<unknown> = readProvenTransaction,
  ): Promise<TxRef> {
    return this.sendProven(accountId, proven, read, null);
  }

  /**
   * **THE SAME DOOR, FOR A TRANSACTION THE SERVICE IS ABOUT TO RECORD AS ONE
   * PARTICULAR CALL** - a raise or an approval a device built. It is refused
   * unless it is exactly one call, to that circuit, as well as everything the
   * door above refuses.
   */
  submitProvenCall(
    accountId: string,
    proven: Uint8Array,
    circuit: string,
    read: (bytes: Uint8Array) => Promise<unknown> = readProvenTransaction,
  ): Promise<TxRef> {
    return this.sendProven(accountId, proven, read, circuit);
  }

  private sendProven(
    accountId: string,
    proven: Uint8Array,
    read: (bytes: Uint8Array) => Promise<unknown>,
    only: string | null,
  ): Promise<TxRef> {
    let submitting = false;
    /*
     * A deployment that cannot write is refused by the lane itself, before
     * anything below runs, and the refusal is marked on the way out.
     */
    return this.write(accountId, 'sending an approval proved on a device', async () => {
      const address = await this.inner.address(accountId);
      if (!address) {
        throw new NothingWasSent(
          'this company has no contract on this chain that this deployment can find, so '
          + 'there is nothing to send an approval to. Nothing was sent.');
      }
      const tx = await read(proven);
      const refusal = refusalForProven(tx, address.value)
        ?? (only === null ? null : refusalUnlessOnlyACallTo(tx, only));
      if (refusal) throw new NothingWasSent(refusal);
      /*
       * **WHAT EITHER SIDE BOOKS IS LET GO BY THESE PROVIDERS THEMSELVES**: a
       * failed balance releases both sides' bookings inside the balance, and a
       * submission takes both over from the moment it starts.
       */
      const providers = sponsoredProviders(this.company!, this.payer!);
      const finalised = await providers.walletProvider.balanceTx(tx as never);
      submitting = true;
      const ref = await providers.midnightProvider.submitTx(finalised);
      return { ref: String(ref), at: new Date().toISOString() };
    }).catch((e: unknown) => {
      if (submitting || saysNothingWasSent(e)) throw e;
      throw new NothingWasSent(String((e as { message?: unknown })?.message ?? e));
    });
  }
}

/**
 * **HOW A VAULT TRANSACTION A DEVICE SENT IS READ**: bound and signed when the
 * depositor's wallet finished it, and proven and not yet bound otherwise - a
 * transaction that moves nothing, and a payment out that moves only the vault's
 * own coins. `ChainLedger.sendVault` takes the reader as an argument so a test
 * can hand in the ledger's own objects without bytes.
 */
export const vaultTransactionReader = (arrival: VaultTxArrival): ((bytes: Uint8Array) => Promise<unknown>) =>
  arrival === 'finished-by-the-depositor' ? readFinishedTransaction : readProvenTransaction;

/** The configuration the ledger takes, derived from the deployment and nowhere else. */
export const configFor = (d: Deployment): MidnightConfig => ({
  indexerUrl: d.indexerUrl,
  indexerWsUrl: d.indexerWsUrl,
  proverUrl: d.proverUrl,
  nodeUrl: d.nodeUrl,
  zkConfigPath: d.zkConfigPath,
  networkId: d.network,
  privateStateId: d.privateStateId,
});

/**
 * Build the chain ledger.
 *
 * **`book` IS THE ONE INPUT THIS MODULE DOES NOT OWN.** An account id becomes an
 * address by asking whatever recorded it, and that is the product's store rather
 * than this file's business. It is a parameter for the same reason the
 * commitment scheme is not defaulted — the alternative is this file inventing a
 * second answer to a question the product already answers.
 *
 * **THE BOOK HAS TWO HALVES AND BOTH ARE NEEDED, WHICH IS THE DEFECT THIS
 * SIGNATURE CLOSES.** It used to take the reading half alone. Opening an account
 * assigns an address that exists nowhere until the deploy returns; the ledger
 * hands it over the instant it has one, and the product then asks the ledger for
 * the account's address, which asks the book. With no writing half the ledger had
 * nowhere to hand it, so the account would be filed with no address — **the
 * deploy would have succeeded and the company would have been unreadable ever
 * after.**
 */
export function chainLedger(
  d: Deployment,
  book: ContractBook,
  capability?: WriteCapability,
): ChainLedger {
  const cfg = configFor(d);
  const refusal = refusalForCapability(capability);
  const nobodyPays = noSponsor(
    refusal ?? 'nothing is wired to pay fees on this deployment');
  const inner = new MidnightLedger(
    cfg,
    capability?.sponsor ?? nobodyPays,
    new FileSealedStateStore(d.sealedStateRoot),
    book.lookUp,
    /*
     * A thunk, which is what the ledger asks for: the providers are built on
     * first use, so constructing this set needs no node, no indexer and no
     * proof server to be reachable. A deployment that cannot reach its chain
     * still starts, and says so when something is asked of it.
     */
    /*
     * **NO BLANKET CAST ON THIS OBJECT.** Every field below is supplied and
     * individually assignable, so a cast over the whole bundle buys nothing and
     * costs the one check that would notice the SDK's bundle changing shape.
     * The one unsatisfiable field is cast on its own, so the compiler still
     * reads the other five.
     */
    () => midnightProviders({
      config: cfg,
      /*
       * Only a write uses this. On a deployment built to watch there is nobody
       * to be, and the cast says so rather than a stub pretending otherwise:
       * every write refuses above this line, so nothing can reach it.
       */
      customer: capability?.customer ?? (undefined as never),
      sponsor: capability?.sponsor ?? nobodyPays,
      artifactsPath: d.zkConfigPath,
      privateStateId: d.privateStateId,
      /*
       * Reached only on a path that writes, because only a write needs the
       * private state store unlocked. It refuses with its own cause rather than
       * the wallet's, so that if it is ever reached from somewhere else the
       * sentence is still true.
       */
      storagePassword: capability?.storagePassword ?? (async () => refuseUnwired(
        'the private state store',
        'no key is wired to unlock it, and this deployment writes nothing that would need it')),
    }),
    /*
     * The compiled contract is what a WRITE proves against. A deployment that
     * cannot write leaves it absent rather than half-built: a partially
     * constructed compiled contract is a thing that looks ready.
     */
    capability?.compiled,
    /*
     * **THE DEPLOYMENT BAG, AND ITS ABSENCE WAS THE THIRD INDEPENDENT REASON
     * NOTHING COULD BE OPENED HERE.** Even a fully funded deployment would have
     * refused at the first line of opening an account, because this argument was
     * not passed at all — and it carries the two things opening needs that no
     * other operation does: somewhere to hand the assigned address, and the
     * choice of who may maintain the contract afterwards.
     */
    capability && {
      register: book.record,
      maintenanceAuthority: capability.maintenanceAuthority,
    },
  );
  return new ChainLedger(inner, d, capability);
}

/**
 * **WHAT A VAULT HOLDS PUBLICLY, AS THE CHAIN ANSWERS IT. IT ANSWERS PUBLIC
 * MONEY AND NOTHING ELSE, AND THAT IS LESS THAN A PAYROLL RUN ASKS.**
 *
 * ── READ THIS FIRST: WHAT THIS DOES NOT CLOSE ────────────────────────────
 *
 * **EVERY PAYEE ON EVERY RUN THIS PRODUCT CAN RAISE IS PRIVATE.**
 * `payrollPayee` (`src/core/movement.ts:140`) refuses a public address by name,
 * and `paymentFactsFor` (`src/core/payroll.ts:2212`) puts every payee through
 * it at `:2251` and returns the narrowed type. So the only payments a run can carry are
 * ones this reader CANNOT answer, and a service holding it still refuses every
 * payroll run it is asked to raise. **What changes is the refusal's class, not
 * the outcome.** A one-off transfer to a public address is the shape this can
 * answer, and that surface does not raise runs.
 *
 * It is here anyway, and it is not decoration: it is the public half of a
 * reader a service has to have, wired where a service can reach it, with the
 * private half named as what is missing rather than left to be discovered.
 *
 * **AND IT DOES WIDEN ONE THING, WHICH IS SAID PLAINLY BECAUSE IT IS THE ONLY
 * NEW BEHAVIOUR HERE.** A reader that answers nothing refuses every round that
 * moves money, whatever its payees are. This one refuses on what the chain
 * says, so a round whose payees are ALL PUBLIC and whose total the vault's
 * public balance covers is now raised where it was previously stopped. Nothing
 * the payroll door can build has that shape; `AccountService.proposeRun` itself
 * does not check, and what was holding that shut was the refusing reader rather
 * than a rule. Naming it is not the same as pinning it, and it is not pinned.
 *
 * ── WHAT IT CAN ANSWER AND WHAT IT CANNOT ────────────────────────────────
 *
 * **PUBLIC MONEY: YES.** `unshieldedBalance` asks the indexer's own door for
 * the balances a contract holds and needs nothing else. `affordable` walks the
 * public payees through that same read.
 *
 * **PRIVATE MONEY: NO, AND IT REFUSES RATHER THAN ANSWERING.** A private
 * balance is a reconciliation between a local note pool and the chain, and a
 * server holds no vault note pool. The pool below refuses every use by name, so
 * a proposal with a private payee is refused with a sentence about the pool
 * instead of being answered from a pool that happened to be on disk. The
 * refusal reaches the caller as *cannot pay*, which is the safe direction:
 * `refuseWhatTheVaultCannotPay` treats every non-answer as a refusal to raise.
 * **The sentence it produces is the generic one**, because the refusal arrives
 * as an ordinary error rather than as one of the three the adapter knows. A
 * permanent, structural inability reported in the words kept for the
 * unexpected is a defect and it is recorded rather than hidden here.
 *
 * ── NOTHING THIS OBJECT HOLDS CAN WRITE, AND THAT IS ARRANGED ────────────
 *
 * A `VaultLedger` can pay out of a vault. This one is built to read, so it is
 * given **no fee payer, no customer wallet and no compiled contract** — not as
 * an omission but as the guard: a write reaches `connect`, which builds on the
 * compiled contract, so every write on this object stops there. The reads do
 * not go near it. **`nobodyPays` is still a truthy object**, so it carries the
 * mark a description reads, and `VaultLedger.describe()` says this client has
 * no fee payer.
 *
 * **THE VAULT'S OWN ARTEFACT PATH IS PASSED** in all three places that take one
 * - `vaultConfigFor` below covers the config and the provider bundle, and the
 * constructor's last argument carries it directly - from the deployment and
 * never derived from the account's, because a client pointed at the wrong
 * contract's assets is confidently wrong rather than absent.
 */
export const vaultConfigFor = (d: Deployment): MidnightConfig =>
  /*
   * **THE VAULT CLIENT'S CONFIG IS THE ACCOUNT'S WITH ONE FIELD REPLACED.**
   * `configFor` builds `zkConfigPath` from the ACCOUNT's artefacts, and a vault
   * client carrying it is one reader away from checking a call against the
   * wrong contract's ABI. Nothing reads the field on a vault client today;
   * that is why it is corrected here rather than after something does, and why
   * it is a named function rather than a spread at a call site - a correction
   * applied in one of the two places it is needed is the half-applied kind that
   * reads as done.
   */
  ({ ...configFor(d), zkConfigPath: d.vaultZkConfigPath });

export function chainVaultHoldingsFor(d: Deployment): VaultHoldings {
  const cfg = vaultConfigFor(d);
  /*
   * **IT TAKES NO WRITE CAPABILITY, AND THE ABSENT PARAMETER IS THE POINT.**
   * There is no argument here through which a funded wallet could reach this
   * object, so a later edit cannot hand it one by passing what it already has
   * next door.
   */
  const nobodyPays = noSponsor(
    'reading what a vault holds pays no fee, so this client was given nobody to pay one');

  /*
   * **MEMOISED ACROSS QUESTIONS, AND A FAILURE IS NOT.**
   *
   * The client asks for the bundle once per read and many times over the life
   * of a service, so building it per read would open a provider set per
   * question. **A REJECTION IS DROPPED RATHER THAN KEPT**: an indexer that was
   * unreachable at the first read is a transient, and a cached rejected promise
   * would turn it into a service that tells everybody the vault could not be
   * established until somebody restarts it — a sentence inviting a retry for a
   * failure that can never clear, which is a shape this product has met
   * before.
   */
  let built: Promise<unknown> | null = null;
  const providersOnce = () => (built ??= midnightProviders({
    config: cfg,
    /* Reads need neither, and a reader that held them would be a writer. */
    customer: undefined as never,
    sponsor: nobodyPays,
    artifactsPath: d.vaultZkConfigPath,
    privateStateId: d.privateStateId,
    storagePassword: async () => refuseUnwired(
      'the private state store',
      'nothing here writes, and a read of what a vault holds needs no private state'),
  }).catch((cause) => { built = null; throw cause; }));

  /*
   * **A POOL THAT REFUSES, SO THAT "THE BRANCH WAS NOT TAKEN" BECOMES "THERE IS
   * NO BRANCH".** If any read ever loads, saves or creates a note here, it
   * stops with a sentence naming the method rather than quietly answering from
   * a pool this service has no business holding.
   *
   * **IT STAYS A REFUSAL NOW THAT THE PRODUCT'S DATABASE HOLDS VAULT POOLS**
   * (`PostgresVaultRecords`). What the database holds is ciphertext wrapped
   * to each signer's own key, and opening it needs one of those keys. A service
   * that held one would be able to read every balance it serves, which is the
   * thing the pool is sealed per signer to prevent; so this reader is given no
   * store and no key, and a store arriving elsewhere does not make it a writer.
   */
  const refuse = (method: string) => (): never => {
    throw new Error(
      `reading what a vault holds asked the note pool to ${method}, and a service holds no `
      + "vault note pool it can open. A private balance is a reconciliation against the "
      + 'record of the vault\'s notes, and that record is sealed so that only a signer\'s own '
      + 'key opens it: a server keeps it and cannot read it. What can be answered here is public '
      + 'money, which is a ledger balance and reads no note.');
  };
  const noPool: NotePool = {
    load: refuse('load') as NotePool['load'],
    save: refuse('save') as NotePool['save'],
    create: refuse('create') as NotePool['create'],
  };

  return chainVaultHoldings(new VaultLedger(
    cfg,
    /*
     * **NO FEE PAYER AND NO COMPILED CONTRACT, DELIBERATELY, AND THEY ARE THE
     * GUARD RATHER THAN AN OMISSION.** This object is handed to a service, and
     * a `VaultLedger` can pay out of a vault. Given the deployment's real
     * sponsor it would be a funded writer sitting inside a reader. It is given
     * neither, so a write refuses before it can balance anything.
     */
    nobodyPays,
    providersOnce,
    undefined,
    noPool,
    d.vaultZkConfigPath,
  ));
}

/** The set, whole. Assembled only by the selector next door. */
export function chainWiring(
  d: Deployment,
  book: ContractBook,
  capability?: WriteCapability,
) {
  return {
    name: 'chain',
    commitments: MidnightCommitments,
    createLedger: () => chainLedger(d, book, capability),
    createProofSystem: () => new MidnightProofSystem(configFor(d)),
  };
}
