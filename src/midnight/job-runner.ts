/**
 * The job model, connected to Midnight. Decision 0008, M-82.
 *
 * `src/core/jobs.ts` says proving is pure and submitting is not. This file is
 * the claim that the SDK actually supports that split, and it does — four
 * public calls, read out of `node_modules` rather than assumed:
 *
 *   build    createUnprovenCallTx(providers, options)      pure
 *   PROVE    proofProvider.proveTx(unprovenTx)             pure — this is the 82 seconds
 *   balance  walletProvider.balanceTx(unbound, ttl)        effectful, and it expires
 *   SUBMIT   midnightProvider.submitTx(finalized)          effectful
 *
 * `submitTx`, `submitTxAsync` and the `callTx[circuit]` interface the rest of
 * `ledger.ts` uses all fuse the four. That is right for a script and wrong for a
 * queue: a crash during the expensive step would land in `submitting` and demand
 * recovery when nothing had ever been sent.
 *
 * BALANCING BELONGS TO SUBMIT, NOT TO PROVE. `balanceTx` takes a `ttl`, so a
 * balanced transaction has an expiry. A job that balanced and then sat in
 * `proven` for an hour — a closed laptop, a queue behind a slow job — would
 * submit something already dead. Prove early, balance late.
 *
 * NOTHING PRIVATE IS PERSISTED. Decision 0008 says proofs are not stored
 * because they are large and reproducible. The SDK says the same thing for a
 * different reason: `UnsubmittedCallTxData` is marked privacy-sensitive and
 * carries the ZK inputs and the next private state, and must not be logged or
 * serialised. Two arguments, one answer — the proof lives in memory for the
 * length of one job and never reaches storage.
 */
import type { Job, JobRunner } from '../core/jobs.js';
import type { LedgerStatus } from '../core/ledger.js';
import { viewDigestOf } from '../core/ledger.js';
import type { Hex } from '../core/crypto.js';
import { refuseACallWithoutItsPrivateState } from './governed-call.js';

/**
 * What a job means in contract terms.
 *
 * Built by the caller rather than here, because which circuit an approval turns
 * into, and what has to be staged into private state first, is domain knowledge
 * that already lives in `account.ts` and `ledger.ts`. Duplicating it here is the
 * failure this project keeps repeating.
 */
export interface CallPlan {
  contractAddress: string;
  circuit: string;
  args: unknown[];
  /**
   * Where this call's private state is filed, or `null` for a circuit that
   * reads no witness.
   *
   * **THE SAME SHAPE THE PREPARED CALL USES, AND IT IS THE SAME SHAPE ON
   * PURPOSE.** This is a second, independent construction of the SDK's call
   * options: it goes to `createCallTxOptions` directly rather than through the
   * client's own call builder, so nothing makes the two agree except that they
   * are written to agree. A plan built from a prepared call whose answer is
   * `null` would otherwise meet a type error here, and the cheapest way past a
   * type error is a cast - which would hand a key to the one circuit that must
   * not be given one.
   *
   * The SDK omits the field on a falsy value, so `null` reaches it as an
   * absent key, which is what a circuit reading no witness needs.
   */
  privateStateId: string | null;
}

/**
 * How to tell, later, whether this job already happened.
 *
 * Derived from `job.payload` and the chain, never from anything the runner
 * remembers — because the whole point of recovery is that the process died and
 * remembers nothing.
 */
export interface Expectation {
  /**
   * The account's VIEW DIGEST once this landed, or null for jobs that do not
   * move the state (`approve`, `propose`, `cancel`).
   *
   * IT WAS a digest over the whole balance map, because since M-125 there is no
   * single state commitment and since M-128 no entry-log digest either, and it
   * was the right handle for recovery on exactly that basis: every state-moving
   * transaction changed one asset's commitment under a fresh salt, so the
   * digest moved whenever a job landed, and it moved to a value only that job's
   * opening produced.
   *
   * **`C292` TOOK THE MAP AWAY AND WITH IT EVERYTHING THAT SENTENCE RESTED ON.**
   * There is no state-moving circuit left on this contract, and both ledgers
   * answer `viewDigestOf([])` — ONE CONSTANT, the same for every account and
   * every state. So the digest does not move when a job lands, and a value
   * compared against it is not evidence of anything.
   *
   * **THIS MUST THEREFORE BE `null` FOR EVERY JOB KIND, AND IT IS**:
   * `expectationFor` below sets it only from a `nextViewDigest` the caller
   * supplies, and no surviving kind moves state, so no caller has one to
   * supply. If one is ever supplied anyway, `recover`'s first branch answers
   * "settled" for ANY account in ANY state, because the two sides of that
   * comparison are the same constant. **NOTHING ENFORCES THAT TODAY** — no
   * assert, no type — it holds because no caller passes a digest. Rule 27, in
   * those words. Whatever pays a run out of a vault is what has to give this
   * field a real handle again.
   */
  viewDigest: Hex | null;
  /**
   * The proposal this job was built against, or null where there is none.
   *
   * `round` used to do this work — "the account is now at round N, so this can
   * never land". There is no round any more, and asking about the
   * proposal is the better question anyway: it is the thing that actually
   * became unusable, and it stays answerable while every other proposal on the
   * account carries on.
   */
  proposalId: Hex | null;
  /**
   * True when the CIRCUIT ITSELF rejects a duplicate, so redoing the job is
   * safe even if we cannot tell whether the first attempt landed.
   *
   * This is not optimism. Every circuit in this contract but one has such a
   * guard, and each was read rather than assumed:
   *
   *   approve    `assert(!approvals.member(nul), "you have already approved…")`
   *   propose    `assert(!openProposals.member(id), "that proposal is already
   *              open")` — the id is `commit([tag, payloadHash, vault], salt)`
   *              (the tag since `S32`, `C317`), so a replay of the same call is
   *              the same id
   *   cancel     `assert(openProposals.member(id), "there is no open proposal
   *              with that id")`
   *   addSigner  `amendSigner` calls `closeProposal` on the approved path, so a
   *              replay finds no open proposal
   *
   * `execute` WAS THE FOURTH LINE OF THIS LIST — "the staleness assert, a
   * replay sees a state that moved" — and `C292` deleted the circuit along with
   * the state it read. Its job kind is gone from `JobKind` too, so there is
   * nothing here that could carry it. The asserts above were re-read against
   * the contract when that line came out, which is how the two M-128 spellings
   * beside it were caught still quoting `proposalOpen`.
   *
   * The exception is `addSigner` on the BOOTSTRAP path, and it is the reason
   * this flag exists rather than being assumed true. See M-83.
   */
  duplicateRejectedOnChain: boolean;
  /** When it is not, what a person has to check. Shown to them verbatim. */
  duplicateHazard?: string;
}

export interface JobRunnerDeps {
  /** Assembled by `midnightProviders`. */
  providers: {
    proofProvider: { proveTx(tx: unknown, config?: unknown): Promise<unknown> };
    walletProvider: { balanceTx(tx: unknown, ttl?: Date): Promise<unknown> };
    midnightProvider: { submitTx(tx: unknown): Promise<string> };
    /**
     * Lets go of anything the balance below booked that the submission did not
     * take.
     *
     * **REQUIRED, AND THAT IS THE POINT OF PUTTING IT HERE.** Balancing marks
     * coins in-flight; nothing releases them by time and nothing releases them
     * on failure. A bundle assembled without this is a bundle that leaks a coin
     * set on every failed submission, and the balance falls quietly with each
     * one. An optional member would let that bundle be assembled by accident.
     */
    releaseUnspent(): Promise<number>;
    [k: string]: unknown;
  };
  /** The compiled contract, as `findDeployedContract` takes it. */
  compiled: unknown;
  /**
   * **WHICH OF THAT CONTRACT'S CIRCUITS READ NO WITNESS, AND IT IS REQUIRED FOR
   * THE SAME REASON `releaseUnspent` IS.**
   *
   * This runner builds the scheme's call options itself - it goes through
   * neither the account client's call builder nor the find, so neither of their
   * refusals is anywhere on this path. What it needs in order to refuse a plan
   * that drops its private state is the one thing it cannot derive: which
   * circuits legitimately have none, which is a property of the contract in
   * `compiled` and not of this runner.
   *
   * An optional member would let a bundle be assembled without it, and a bundle
   * assembled without it is one that proves a signer check against no signer -
   * paying for a proof in order to do it. So it is asked for beside the
   * contract it describes.
   */
  circuitsThatReadNoWitness: ReadonlySet<string>;
  /**
   * Turns a job into a circuit call, staging whatever private state the
   * witnesses read. Called at the start of proving, so a job that cannot be
   * built fails in a second rather than after eighty of them.
   */
  plan(job: Job): Promise<CallPlan>;
  /** The account's public state, for recovery. */
  status(accountId: string): Promise<LedgerStatus | null>;
  /** What the chain should look like if this job landed. */
  expectation(job: Job): Promise<Expectation>;
  /**
   * How long a balanced transaction stays valid.
   *
   * Both parties in the sponsorship flow must agree on it, and it has to
   * outlive the round trip to the sponsor.
   */
  ttlMinutes?: number;
  now?: () => Date;
}

/** Held in memory between `prove` and `submit`, and nowhere else. Never stored. */
interface ProvenWork {
  plan: CallPlan;
  provenTx: unknown;
}

export class MidnightJobRunner implements JobRunner {
  private readonly ttlMinutes: number;
  private readonly now: () => Date;

  constructor(private deps: JobRunnerDeps) {
    this.ttlMinutes = deps.ttlMinutes ?? 20;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Build and prove. Nothing reaches the chain.
   *
   * An interruption anywhere in here costs time and nothing else, which is what
   * lets `jobs.ts` redo a job it finds in `proving` without asking anyone.
   */
  async prove(job: Job): Promise<{ proof: unknown }> {
    const plan = await this.deps.plan(job);

    /*
     * **BEFORE ANYTHING IS BUILT, AND CERTAINLY BEFORE ANYTHING IS PROVED.**
     *
     * The options assembled below take the plan's answer straight to the
     * scheme, which omits the field on a falsy value and runs the circuit
     * against no private state at all. Nothing downstream of here complains
     * about that: the proof succeeds, it costs what a proof costs, and what it
     * proves is a circuit whose signer check read nothing.
     *
     * The plan's type says `string | null`, and that is the compiler's half of
     * the answer. This is the other half, and it is the half that holds when a
     * plan arrives through a cast or from a caller the compiler never saw.
     */
    refuseACallWithoutItsPrivateState(
      plan.circuit, plan.privateStateId, this.deps.circuitsThatReadNoWitness);

    const [{ createUnprovenCallTx, createCallTxOptions }] = await Promise.all([
      import('@midnight-ntwrk/midnight-js-contracts'),
    ]);

    const options = (createCallTxOptions as any)(
      this.deps.compiled,
      plan.circuit,
      plan.contractAddress,
      plan.privateStateId,
      undefined, // no additional coin/encryption key mappings
      plan.args,
    );

    const unsubmitted: any = await (createUnprovenCallTx as any)(this.deps.providers, options);

    /*
     * `unprovenTx` sits under `private` because the SDK considers it sensitive:
     * it carries the ZK inputs and the next private state. It goes straight
     * into the prover and nowhere else — not into a log line, not into the job.
     */
    const unprovenTx = unsubmitted?.private?.unprovenTx;
    if (!unprovenTx) {
      throw new Error(
        `building the "${plan.circuit}" call produced no transaction to prove — ` +
          'the private state the witnesses read may not have been staged.',
      );
    }

    const provenTx = await this.deps.providers.proofProvider.proveTx(unprovenTx);
    return { proof: { plan, provenTx } satisfies ProvenWork };
  }

  /**
   * Balance and submit. Past this line the chain may know about it.
   *
   * Balancing is here rather than in `prove` because the result expires: see the
   * note at the top of the file.
   */
  async submit(_job: Job, proof: unknown): Promise<{ txRef: string }> {
    const work = proof as ProvenWork;
    if (!work?.provenTx) throw new Error('nothing to submit: this job has no proof in hand');

    const ttl = new Date(this.now().getTime() + this.ttlMinutes * 60_000);
    /*
     * **EVERY WAY OUT OF THIS METHOD THAT BALANCED AND DID NOT SUBMIT RELEASES
     * WHAT THE BALANCE BOOKED.**
     *
     * Balancing marks coins in-flight in the wallet's own state. Nothing
     * releases them by time - the vendor's sweep for that is a documented
     * no-op - and its own cleanup only ever acts on transactions that got an
     * answer from the chain, which one that was never submitted never gets. So
     * a booking abandoned here stands for ever, the next attempt balances onto
     * a fresh coin set because the first is filtered out as pending, and the
     * fee budget falls a little on every failure with nothing saying why.
     *
     * `releaseUnspent` releases only what has not been handed to a submission:
     * the bundle forgets a booking at the moment `submitTx` is entered, because
     * from there the sponsor's own method owns it. So this cannot double-release
     * a transaction the node may already have accepted, which is the one
     * mistake in this area that costs more than the leak does.
     */
    try {
      const finalised = await this.deps.providers.walletProvider.balanceTx(work.provenTx, ttl);
      const txId = await this.deps.providers.midnightProvider.submitTx(finalised);

      if (!txId) throw new Error('the transaction was submitted but no transaction id came back');
      return { txRef: String(txId) };
    } finally {
      /*
       * A release that fails must never replace the failure that caused it.
       * This runs on a path that has already gone wrong as often as not, and
       * the original error is the one naming what actually happened.
       */
      await this.deps.providers.releaseUnspent().catch(() => {});
    }
  }

  /**
   * Asked when a job is found in `submitting` — sent, outcome unknown.
   *
   * DELIBERATELY NOT A TRANSACTION-LEVEL QUESTION. The obvious move is
   * `publicDataProvider.watchForTxData(txId)`, and it cannot work:
   * its own type documentation says it waits indefinitely, never times out, and
   * asks implementations not to add timeouts. It can answer "yes, eventually".
   * It can never answer "no". Wrapping it in a timeout and reading the timeout
   * as "no" is exactly the guess decision 0008 refuses to make.
   *
   * So the question is asked of the ACCOUNT instead: is this job's effect
   * already present on chain? That is decidable, it needs no memory of the
   * transaction, and it is also correct in the case a txId cannot cover — where
   * our transaction lost a race to an identical one from another device.
   */
  async recover(job: Job): Promise<{ settled: boolean; txRef?: string } | null> {
    const status = await this.deps.status(job.accountId);
    if (!status) {
      throw new Error(
        `cannot tell what happened to this ${job.kind}: the account has no state on chain. ` +
          'Check the contract address before retrying.',
      );
    }

    const expect = await this.deps.expectation(job);

    // 1. The effect is visibly present. It was the exact answer and the
    //    strongest there is, while a state-moving circuit existed to produce a
    //    digest only its own opening could. `C292` removed the last of those,
    //    and `status.assets` is now `[]` on both ledgers, so both sides of this
    //    comparison are one constant. The guard that keeps it honest is
    //    `expect.viewDigest` being null, which it is for every surviving kind.
    if (expect.viewDigest && viewDigestOf(status.assets) === expect.viewDigest) {
      return { settled: true, txRef: job.txRef };
    }

    /*
     * 2. The proposal this job was built against is gone from the chain.
     *
     * It either settled or was cancelled, and nothing observable says which —
     * so this job cannot be applied, and saying "settled" would tell somebody a
     * payment went out that may not have. M-128 replaced "the round moved on"
     * with this, which is both narrower and more accurate: under the round
     * design an unrelated payment settling would have triggered this branch.
     */
    if (expect.proposalId && !status.openProposals.some(p => p.id === expect.proposalId)) {
      throw new Error(
        `this ${job.kind} was built against a proposal that is no longer open on the account. ` +
          'It cannot be applied. If it completed, it may have been by this transaction or by ' +
          'another — check the account before proposing again.',
      );
    }

    // 3. Nothing observable changed. Redo it ONLY where the circuit itself
    //    rejects a duplicate, so a second attempt cannot cost anything twice.
    if (expect.duplicateRejectedOnChain) return null;

    /*
     * The remaining case. There is no on-chain guard, we cannot see whether it
     * landed, and both automatic answers are wrong in a way that matters — so a
     * person looks. This is the least convenient option on purpose.
     */
    throw new Error(
      `this ${job.kind} was interrupted after being submitted and cannot be checked automatically. ` +
        (expect.duplicateHazard ?? 'Retrying it could apply it twice.') +
        ' Check the account before retrying.',
    );
  }
}

/**
 * The expectations for this contract's circuits.
 *
 * Separate from the runner so the reasoning is readable on its own, and so a
 * change to a circuit has one obvious place to land.
 *
 * `nextViewDigest` is supplied by whoever enqueued the job, because they were
 * the ones who knew what state they intended to write. Reconstructing it here
 * would have meant holding the opening, which is the private data this whole
 * design keeps off the server. The name in this sentence was
 * `nextStateCommitment`, after a commitment M-125 had already replaced.
 *
 * **NO SURVIVING JOB KIND MOVES STATE, SO IT IS ALWAYS `null` IN PRACTICE.**
 * `C292` removed the only kind that did. See the note on `Expectation`'s
 * `viewDigest` for why a non-null one would be worse than useless here.
 */
export const expectationFor = (
  job: Job, proposalId: Hex | null, nextViewDigest: Hex | null,
): Expectation => {
  const moves = nextViewDigest !== null;

  switch (job.kind) {
    case 'approve':
    case 'propose':
    case 'cancel':
      return {
        proposalId,
        viewDigest: moves ? nextViewDigest : null,
        duplicateRejectedOnChain: true,
      };

    case 'addSigner':
      /*
       * The one exception in the contract, and it is not theoretical.
       *
       * On the approved path `addSigner` closes the round, so a replay fails.
       * On the BOOTSTRAP path — `signerCount < threshold` — it just inserts the
       * leaf and increments the count, with nothing stopping it happening
       * twice.
       *
       * Treated as unsafe on both paths here, because which path applied
       * depends on `signerCount` at the moment the transaction was executed,
       * which is precisely what we cannot observe after the fact.
       */
      return {
        proposalId,
        viewDigest: null,
        duplicateRejectedOnChain: false,
        duplicateHazard:
          'Adding a signer during bootstrap has no on-chain duplicate check, so a second attempt ' +
          'would insert the same signer twice and inflate the signer count — which can leave the ' +
          'account permanently unable to reach its threshold.',
      };

    default:
      /*
       * An unknown kind is unsafe by default rather than safe. The cost of
       * being wrong in the safe direction is a person checking an account; in
       * the other direction it is a duplicated payment.
       */
      return {
        proposalId,
        viewDigest: null,
        duplicateRejectedOnChain: false,
        duplicateHazard: `"${job.kind}" has no recorded duplicate protection.`,
      };
  }
};
