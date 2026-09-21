/**
 * Approvals as durable jobs. Decision 0008.
 *
 * Everything a signer does — propose, approve, cancel — is slow and can fail
 * halfway, and the argument does not depend on which circuits are involved; the
 * list once named two that have since been deleted. Proving takes seconds at
 * best and ~108 seconds against the single-threaded WASM prover, and settlement
 * adds ~23 seconds of block time that no amount of engineering removes. So no
 * version of this product gets to treat "click approve" as a function call that
 * returns.
 *
 * WHY THIS EXISTS EVEN IF PROVING GETS FAST. All five properties below are
 * about correctness or about the ~23s we can never remove, not about the 108s
 * we hope to lose:
 *
 *   1. Proving must not run on the UI thread. WASM proving does not make a page
 *      feel slow, it FREEZES it — no scrolling, no cancel, the spinner itself
 *      stops animating. True at 3 seconds as much as at 108.
 *   2. Work must survive a closed tab, a slept laptop, a dropped connection.
 *      Losing an approval because someone switched apps is a data-loss bug at
 *      any speed.
 *   3. There is always a gap between "you approved" and "the chain agrees",
 *      because block time is not ours. The UI has to be able to say so.
 *   4. Somebody has to be told when it finishes if they looked away.
 *   5. Approving five payments must not mean five simultaneous proofs fighting
 *      over one core.
 *
 * DELIBERATELY ISOMORPHIC. No DOM, no Node, no timers of its own. The same file
 * runs in a browser tab, in a Worker, in the macOS and iOS apps, and in the
 * tests — because a job model that only works in one of those places is how the
 * web and native clients drift into disagreeing about what "approved" means.
 * Storage and clocks are injected for the same reason.
 */
import type { Hex } from './crypto.js';

/**
 * Where a job is.
 *
 * The states are deliberately about WHAT IS TRUE ON CHAIN rather than what the
 * code is doing, because that is what a person is actually asking when they
 * look at the screen.
 *
 *   queued     accepted, not started. Survives a restart.
 *   proving    the expensive part. Resumable: a proof is a pure function of its
 *              inputs, so a proof interrupted has lost time and nothing else.
 *   proven     proof in hand, not yet submitted. The dangerous state — see the
 *              note on `submitting`.
 *   submitting sent to the node, outcome unknown.
 *   settled    the chain agrees. Terminal.
 *   failed     terminal, with a reason a person can act on.
 *   cancelled  withdrawn before it settled.
 */
export type JobState =
  | 'queued'
  | 'proving'
  | 'proven'
  | 'submitting'
  | 'settled'
  | 'failed'
  | 'cancelled';

export const TERMINAL: readonly JobState[] = ['settled', 'failed', 'cancelled'];

export const isTerminal = (s: JobState): boolean => TERMINAL.includes(s);

/**
 * What the job is trying to do. Mirrors the circuits, so nothing is invented.
 *
 * `credit` WAS HERE AND IS GONE: the circuit was shed, and nothing ever
 * enqueued that kind.
 *
 * `execute` FOLLOWED IT. The circuit it named spent the
 * account's own balance and was removed with the balance. Nothing ever
 * enqueued that kind either — the only kind anything enqueues is `approve` —
 * so this is a name removed, not a queue drained.
 *
 * WHEN A RUN IS PAID FROM A VAULT there will be a kind for it, and it will be
 * added here first, because a job kind with no circuit is what these two
 * removals were both cleaning up after.
 */
export type JobKind = 'propose' | 'approve' | 'cancel' | 'addSigner';

/**
 * Who is working a job, and until when.
 *
 * WHY A JOB NEEDS AN OWNER AT ALL. The queue's own concurrency guard is a field
 * on one object, so it serialises the work inside ONE process and says nothing
 * about a second one. Two tabs are two processes over one store: both start up,
 * both read the same pending list, both take the first job. Proving twice costs
 * only time, but the step after it does not - a rebuilt transaction selects
 * different coins, so the two are unrelated payments to the chain and both
 * apply. That is a double payment produced by nobody retrying anything.
 *
 * WHY IT EXPIRES. A tab that is closed mid-proof does not get to release
 * anything, so a lease with no end is a job no later process may ever work.
 * The expiry has to outlast the longest step by a wide margin - a first proof
 * on a cold device has been measured at 176.9 seconds and a warm one at 140.3
 * - which is why the default below is minutes rather than seconds. The cost of
 * that choice is stated where it is made: a job whose worker really did die
 * waits out the remainder before anybody else picks it up. Waiting is the
 * cheaper of the two errors.
 */
export interface JobLease {
  /** One per process. Two tabs are two owners, which is the whole point. */
  owner: string;
  /** ISO instant after which another worker may take it. */
  until: string;
}

export interface Job {
  id: string;
  accountId: string;
  kind: JobKind;
  state: JobState;
  /** Who asked for it, so a UI can say "your approval" rather than "an approval". */
  signerId: string;
  /** Opaque to this module: whatever the caller needs to perform the work. */
  payload: Record<string, unknown>;
  /** Set once submitted, so a resumed job can ask the chain what happened. */
  txRef?: string;
  /** Why it failed, in words a person can act on. */
  error?: string;
  attempts: number;
  /**
   * True once this job has been in `submitting` at least once.
   *
   * **IT EXISTS SO THAT A REFUSAL CAN TELL A PERSON THE TRUE THING.** A job
   * that has never been submitted can be raised again with nothing to check; a
   * job that has been submitted three times and come back may have left three
   * transactions on the chain. Those are opposite instructions, and the count
   * of attempts alone cannot tell them apart - `attempts` counts proofs, and
   * proving reaches nothing.
   */
  submissionAttempted?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Held while a worker is working it. Absent means nobody is. */
  lease?: JobLease;
}

export interface JobStore {
  /** Every job, in creation order. Small by nature: jobs are per account. */
  list(): Promise<Job[]>;
  put(job: Job): Promise<void>;
  /**
   * Takes the lease on one job, or answers `null` because somebody else holds
   * a live one.
   *
   * **THIS MUST BE ATOMIC AGAINST EVERY OTHER PROCESS SHARING THIS STORAGE, AND
   * THAT IS WHY IT IS ON THE STORE RATHER THAN IN THE QUEUE.** Read-then-write
   * from two tabs interleaves, and the interleaving is exactly the case the
   * lease exists to refuse - both read "nobody holds it" and both then write
   * their own name. Only the layer that owns the storage can make the pair
   * indivisible, so only that layer can be asked to.
   *
   * **REQUIRED, NOT OPTIONAL.** An optional member would mean a store could be
   * wired in with no way to take a lease, and the queue above it would carry on
   * exactly as though there were one. A backend that genuinely cannot do this
   * should say so by failing to compile.
   */
  claim(id: string, lease: JobLease, now: Date): Promise<Job | null>;
  /**
   * Writes a job the caller believes it is working, and answers `false` when
   * the store disagrees.
   *
   * **A CONDITIONAL CLAIM WITH AN UNCONDITIONAL WRITE BESIDE IT IS NOT A LOCK,
   * AND THIS MEMBER EXISTS BECAUSE THAT WAS MEASURED RATHER THAN ARGUED.**
   * Taking the lease was already atomic; every save afterwards was a blind
   * `put` of the whole record. So a worker suspended past its own lease - a
   * slept laptop, a throttled background tab, the ordinary case this file plans
   * for - woke up, wrote its own name back over whoever had legitimately taken
   * the job, and carried on. Both workers then submitted, and the second write
   * erased any record that the first transaction had existed.
   *
   * It refuses two things and both were reachable: a write over a lease
   * somebody else holds, and a write over a job that has already finished.
   */
  writeHeld(job: Job, owner: string, now: Date): Promise<boolean>;
}

/**
 * The queue was working a job it no longer holds.
 *
 * Its own class because it must never be filed on the job: the job belongs to
 * another worker now, and writing a failure onto it is the very thing this
 * refuses. It travels to whoever called `drain` instead.
 */
export class LeaseLost extends Error {
  readonly leaseLost = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'LeaseLost';
  }
}

const isLeaseLost = (e: unknown): boolean =>
  !!e && typeof e === 'object' && (e as { leaseLost?: unknown }).leaseLost === true;

/**
 * Whether a store may accept this write from this worker.
 *
 * Exported for the same reason `mayClaim` is: three backends have to answer it
 * the same way, and three copies of a rule about who may write a payment is how
 * the copies come to disagree.
 */
export const mayWrite = (
  stored: Job | undefined,
  incoming: Job,
  owner: string,
  now: Date,
): boolean => {
  if (stored === undefined) return true;
  /*
   * A finished job is finished. Without this, a worker that was suspended
   * while somebody cancelled its job would write `proving` back over
   * `cancelled` and carry on working something a person had withdrawn.
   */
  if (isTerminal(stored.state) && !isTerminal(incoming.state)) return false;
  return mayClaim(stored.lease, owner, now);
};

export interface QueueOptions {
  store: JobStore;
  /** Injected so tests do not sleep and every environment can use its own. */
  now?: () => Date;
  newId?: () => string;
  /**
   * How many jobs run at once.
   *
   * ONE, and that is not laziness. The prover is single-threaded, so two
   * proofs do not go twice as fast — they take twice as long each and the user
   * sees nothing finish. Serial is both simpler and faster here.
   */
  concurrency?: number;
  /** Told about every change, for the UI and for notifications. */
  onChange?: (job: Job) => void;
  /**
   * Who this queue is, for the lease. One per process.
   *
   * Defaulted rather than required so that a caller cannot forget it and get no
   * lease at all; two queues that somehow shared an owner would be two tabs the
   * lease could not tell apart, which is why the default is random rather than
   * a constant.
   */
  owner?: string;
  /**
   * How long a lease lasts.
   *
   * **IT IS THE TIME A PERSON WAITS AFTER A TAB DIES, AND THAT IS THE ONLY
   * THING IT SHOULD BE.** A lease has to outlast the longest step or it lapses
   * under the worker still working - and the longest step is a proof, measured
   * at 176.9 seconds cold and 140.3 warm. Sized for that alone it came out at
   * fifteen minutes, and that is what a reopened tab then waited before it
   * could work its own job again, **with the screen saying *proving on this
   * device* for the whole of it.**
   *
   * **SO THE LEASE IS SHORT AND IT IS RENEWED WHILE THE WORK IS RUNNING** - see
   * `every` below. A worker that is alive keeps its lease however long the
   * proof takes; a worker that is gone stops renewing, and this is how long
   * anybody waits for that to become apparent.
   */
  leaseMs?: number;
  /**
   * Runs something repeatedly until the returned function is called.
   *
   * **INJECTED, BECAUSE THIS FILE HAS NO TIMERS OF ITS OWN AND THAT IS A
   * PROPERTY WORTH KEEPING.** The same job model runs in a browser tab, in a
   * Worker, in the desktop and phone applications and in the tests, and a
   * module that reached for `setInterval` would be a module that only works
   * where one exists.
   *
   * **WITHOUT IT THERE IS NO RENEWAL, AND THAT IS SAFE RATHER THAN BROKEN**:
   * the lease then has to be longer than the longest proof on its own, which
   * is what `leaseMs` defaults to. What is lost is the short wait, not the
   * lock.
   */
  every?: (fn: () => void, ms: number) => () => void;
  /**
   * How many times a job may be attempted before it stops on its own.
   *
   * **`attempts` WAS WRITTEN AND READ NOWHERE, WHICH IS THE SAME AS NOT HAVING
   * ONE.** A job that fails deterministically - a circuit that cannot be
   * satisfied, an artefact that 404s - re-proves every time a tab is reopened,
   * for ever, and the only signal is a page that never finishes. The count is
   * persisted on the job, so it survives the restart that produced it; a cap
   * that reset on reload would be a cap on nothing.
   */
  maxAttempts?: number;
}

/**
 * The work itself. Split at the proof boundary ON PURPOSE.
 *
 * `prove` is pure and idempotent: same inputs, same proof, no side effects on
 * chain. So an interrupted proof is safe to redo and costs only time.
 *
 * `submit` is NOT. Once a transaction reaches the node it may settle whether or
 * not we are still listening, so redoing it blindly risks paying twice. That is
 * what `recover` is for.
 */
export interface JobRunner {
  prove(job: Job): Promise<{ proof: unknown }>;
  submit(job: Job, proof: unknown): Promise<{ txRef: string }>;
  /**
   * Asked before re-submitting a job that was interrupted mid-flight.
   *
   * Returns the outcome if the chain already knows about it, or `null` when it
   * is SAFE TO DO AGAIN. Without this, a queue that resumes after a crash is a
   * queue that double-spends — and "it settled but we did not see it" is
   * indistinguishable from "it never arrived" without asking.
   *
   * **`null` DOES NOT MEAN THE CHAIN NEVER GOT IT, AND THIS SENTENCE USED TO
   * SAY THAT IT DID.** The implementation that answers it answers `null`
   * whenever the CIRCUIT ITSELF refuses a duplicate, which is a statement about
   * what a second attempt would cost and not about what the first one did. A
   * caller that reads `null` as evidence of nothing having been sent will tell
   * somebody so, and that sentence is how a person comes to raise a payroll run
   * a second time.
   */
  recover?(job: Job): Promise<{ settled: boolean; txRef?: string } | null>;
}

/**
 * **A REFUSAL FROM A SUBMIT THAT REACHED NOTHING, AND WHY IT NEEDS ITS OWN
 * SHAPE.**
 *
 * A thrown submission is normally recorded as `submitting`, because the
 * persisted record cannot tell *the node refused it* from *the node took it and
 * the socket closed*, and the second of those must never be filed as a failure.
 * That is right for anything that got as far as a network call.
 *
 * **IT IS WRONG FOR A REFUSAL, AND THIS WAS MEASURED RATHER THAN ARGUED.** A
 * runner that cannot submit at all - no wallet, nothing to pay a fee with -
 * knows for certain that nothing left the device. Recorded as `submitting`, the
 * queue then asks the chain what happened, finds nothing that can answer, and
 * ends by telling a person *the transaction may have settled: check the account
 * before retrying.* **That sentence is about a payment that provably never
 * existed**, and acting on it is how somebody raises the same run a second time
 * - which is the one thing in this system that pays twice.
 *
 * So a runner that KNOWS nothing was sent says so with this, and the queue
 * treats it as what it is: over, with nothing to check.
 *
 * **THE MARKER IS A PROPERTY AND NOT ONLY THE CLASS.** `instanceof` fails
 * across a realm and across two copies of one module - a worker bundle and a
 * page bundle are exactly that - and the cost of the check silently answering
 * false is the wrong sentence in front of somebody waiting on their own money.
 */
export class NothingWasSent extends Error {
  readonly nothingWasSent = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'NothingWasSent';
  }
}

/** True for anything a runner marked as never having reached the network. */
export const saysNothingWasSent = (e: unknown): boolean =>
  !!e && typeof e === 'object' && (e as { nothingWasSent?: unknown }).nothingWasSent === true;

const clone = (job: Job): Job => ({ ...job, payload: { ...job.payload } });

export class JobQueue {
  private readonly store: JobStore;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly onChange?: (job: Job) => void;
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private running = false;

  constructor(private runner: JobRunner, private options: QueueOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `job_${Math.random().toString(36).slice(2, 12)}`);
    this.onChange = options.onChange;
    this.owner = options.owner ?? `worker_${Math.random().toString(36).slice(2, 12)}`;
    /*
     * Fifteen minutes with no renewal; forty-five seconds with one. The first
     * has to outlast a 176-second proof by a margin because nothing keeps it
     * alive; the second only has to outlast the gap between two renewals, and
     * it is what a person waits after a tab dies.
     */
    this.leaseMs = options.leaseMs ?? (options.every ? 45_000 : 15 * 60_000);
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  /** Who this queue is. Two tabs are two of these, and the lease tells them apart. */
  get workerId(): string {
    return this.owner;
  }

  /** The lease this queue would take now, renewed from the clock rather than held. */
  private leaseNow(): JobLease {
    return { owner: this.owner, until: new Date(this.now().getTime() + this.leaseMs).toISOString() };
  }

  /** Accepts work. Returns as soon as it is DURABLE, not when it is done. */
  async enqueue(args: {
    accountId: string;
    kind: JobKind;
    signerId: string;
    payload?: Record<string, unknown>;
  }): Promise<Job> {
    const at = this.now().toISOString();
    const job: Job = {
      id: this.newId(),
      accountId: args.accountId,
      kind: args.kind,
      signerId: args.signerId,
      payload: args.payload ?? {},
      state: 'queued',
      attempts: 0,
      createdAt: at,
      updatedAt: at,
    };
    await this.save(job);
    return clone(job);
  }

  async get(id: string): Promise<Job | undefined> {
    return (await this.store.list()).find((j) => j.id === id);
  }

  /** Everything not finished, oldest first — which is the order to work in. */
  async pending(): Promise<Job[]> {
    return (await this.store.list()).filter((j) => !isTerminal(j.state));
  }

  /**
   * Withdraws a job that has not yet been submitted.
   *
   * Refuses once it is in flight, because at that point the chain may already
   * have it and a local "cancelled" would be a lie. That is the honest answer
   * even though it is the less convenient one.
   */
  async cancel(id: string): Promise<Job> {
    const job = await this.get(id);
    if (!job) throw new Error(`no job ${id}`);
    if (isTerminal(job.state)) throw new Error(`job ${id} is already ${job.state}`);
    if (job.state === 'submitting') {
      throw new Error(
        `job ${id} has already been submitted, so it cannot be cancelled here — ` +
          'the chain may already have accepted it. Cancel the proposal on chain instead.',
      );
    }
    job.state = 'cancelled';
    await this.save(job);
    return clone(job);
  }

  /**
   * Works the queue until nothing is left to do.
   *
   * Safe to call repeatedly and from several places — on start-up, when a job
   * is added, when the tab regains focus. A second concurrent call returns
   * immediately rather than racing the first.
   */
  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    /*
     * Jobs another worker holds. Skipped for this drain rather than waited on:
     * the other worker is making progress on them, and the useful thing to do
     * with the time is the next job rather than a spin on this one.
     */
    const heldElsewhere = new Set<string>();
    /*
     * How many times one job may be worked before we conclude the loop is not
     * making progress.
     *
     * A job legitimately needs at most three steps in a single drain
     * (`submitting` -> ask the chain -> `queued` -> `settled`). More than that
     * means the store is not persisting what we write — a full storage quota, a
     * backend silently dropping writes, an adapter appending instead of
     * overwriting — and the loop would otherwise spin forever: pinning a core,
     * re-proving the same job, in a tab that cannot be closed cleanly. Found by
     * mutating the store to write a new key per save.
     */
    const MAX_STEPS_PER_JOB = 8;
    const steps = new Map<string, number>();
    try {
      for (;;) {
        const queued = (await this.pending()).filter((j) => !heldElsewhere.has(j.id));
        if (queued.length === 0) return;

        /*
         * THE LEASE IS TAKEN BEFORE THE WORK, NOT AFTER IT. Claiming here and
         * not inside `step` is what makes the guard mean something: `step` is
         * public so a caller can drive one transition at a time, and a claim
         * inside it would be taken and released around each transition, leaving
         * the gaps between them open to exactly the second worker this refuses.
         */
        const next = await this.store.claim(queued[0].id, this.leaseNow(), this.now());
        if (!next) {
          heldElsewhere.add(queued[0].id);
          continue;
        }

        const count = (steps.get(next.id) ?? 0) + 1;
        steps.set(next.id, count);
        if (count > MAX_STEPS_PER_JOB) {
          /*
           * Deliberately thrown rather than recorded on the job: if storage
           * were working we would not be here, so writing `failed` would be
           * dropped too. The caller has to hear about it.
           */
          throw new Error(
            `job ${next.id} has been worked ${count} times without finishing, so its ` +
              'storage is not saving progress. Stopping rather than proving it forever.',
          );
        }

        /*
         * **THE LEASE IS KEPT ALIVE FOR AS LONG AS THE WORK RUNS.** A proof is
         * over two minutes and a job's transitions are minutes apart, so a
         * lease written once at claim time would have to be sized for the
         * slowest possible proof - and that size is then exactly how long a
         * reopened tab waits before it may work its own job again.
         *
         * Renewing through `claim` rather than through a write of its own is
         * deliberate: `claim` re-reads the stored record inside the same
         * indivisible step, so a renewal cannot put back a state that a
         * transition has moved on from. And it re-takes only OUR lease - if
         * another worker has legitimately taken the job, the renewal is refused
         * and we do not steal it back.
         */
        const stopRenewing = this.options.every?.(
          () => { void this.store.claim(next.id, this.leaseNow(), this.now()).catch(() => {}); },
          Math.max(1_000, Math.floor(this.leaseMs / 3)),
        ) ?? (() => {});

        try {
          await this.step(next);
        } finally {
          stopRenewing();
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** One job, one transition. Public so a caller can drive it a step at a time. */
  async step(job: Job): Promise<Job> {
    try {
      switch (job.state) {
        case 'queued':
          return await this.doProve(job);

        case 'proving':
          /*
           * Found mid-proof, which means the process died while proving.
           * Proving is pure, so redoing it is safe and costs only time. This is
           * exactly the case that must NOT be treated like an interrupted
           * submission.
           */
          return await this.doProve(job);

        case 'proven':
          return await this.doSubmit(job);

        case 'submitting':
          /*
           * The dangerous one. We sent it and did not see the outcome, so the
           * chain may or may not have it. Ask before doing anything.
           */
          return await this.doRecover(job);

        default:
          return clone(job);
      }
    } catch (e) {
      /*
       * **A LOST LEASE IS NOT THIS JOB'S FAILURE AND MUST NOT BE WRITTEN ONTO
       * IT.** The job belongs to another worker now; recording an error on it
       * would be this worker's last act being to overwrite the record it has
       * just been told it may not touch. It goes to whoever called `drain`.
       */
      if (isLeaseLost(e)) throw e;

      job.error = String((e as any)?.message ?? e);
      /*
       * **A THROWN SUBMIT IS NOT A FAILED SUBMIT, AND THE STATE HAS TO SAY THE
       * TRUE THING RATHER THAN THE CONVENIENT ONE.**
       *
       * `doSubmit` writes `submitting` to storage BEFORE it calls the runner,
       * so a throw from inside that call leaves the job holding the only honest
       * description of what is on chain: unknown. Overwriting that with
       * `failed` loses the distinction, and `failed` is terminal - so `recover`,
       * the one mechanism in this system built to ask the chain whether
       * something landed, was never consulted on the one path that most needs
       * it. What the person got instead was whatever the SDK threw, and a
       * person holding a raw error retries by hand.
       *
       * So a throw that happens with `submitting` already on disk KEEPS
       * `submitting`. The next `step` takes the `submitting` branch and asks.
       * A throw anywhere earlier - building, proving - reaches no chain and is
       * genuinely terminal.
       *
       * **AND THE ONE EXCEPTION, WHICH A MEASUREMENT FOUND RATHER THAN A
       * REVIEW: A RUNNER THAT KNOWS NOTHING WAS SENT.** A device with no wallet
       * refuses before any network call, and filing that as *outcome unknown*
       * ends with a person being told to check an account for a payment that
       * provably never existed. `NothingWasSent` is how a runner says which of
       * the two it is, and only a runner can know.
       */
      if (job.state !== 'submitting' || saysNothingWasSent(e)) job.state = 'failed';
      await this.save(job);
      return clone(job);
    }
  }

  /* ---------------- transitions ---------------- */

  private async doProve(job: Job): Promise<Job> {
    /*
     * Read BEFORE the increment, so the cap counts attempts already made
     * rather than the one about to be. `attempts` is on the job and the job is
     * on disk, so a tab reopened for the fourth time meets the same number the
     * third one left.
     */
    if (job.attempts >= this.maxAttempts) {
      job.state = 'failed';
      /*
       * **TWO SENTENCES, BECAUSE THE TWO SITUATIONS TAKE OPPOSITE ACTIONS AND
       * THE ONE THAT WAS HERE WAS WRONG IN THE DANGEROUS DIRECTION.** It said
       * *nothing has been sent to the chain by these attempts* unconditionally,
       * and a job reaches this line after re-queueing from `submitting` - so
       * three real transactions could have gone out under a sentence saying
       * none had. It then told the person to raise it again, which is exactly
       * how the same payroll run gets raised twice.
       */
      job.error = job.submissionAttempted
        ? `this ${job.kind} has been attempted ${job.attempts} times and has stopped rather ` +
          'than starting again. One or more of those attempts was sent, and whether any of ' +
          'them took effect is not something this device can tell. Check the account before ' +
          'raising it again.'
        : `this ${job.kind} has been attempted ${job.attempts} times without finishing, so it ` +
          'has stopped rather than starting again. Nothing was ever sent, so nothing has taken ' +
          'effect and it is safe to raise again.';
      await this.save(job);
      return clone(job);
    }

    job.state = 'proving';
    job.attempts += 1;
    await this.save(job);

    const { proof } = await this.runner.prove(job);

    job.state = 'proven';
    await this.save(job);
    // Held in memory only: a proof is large and reproducible, so persisting it
    // buys nothing a re-prove does not, and costs storage on every device.
    return this.doSubmit(job, proof);
  }

  private async doSubmit(job: Job, proof?: unknown): Promise<Job> {
    /*
     * Re-prove when resuming from `proven` without a proof in hand. The
     * alternative is persisting proofs, which trades a cheap recomputation for
     * permanent storage of something reproducible.
     */
    const material = proof ?? (await this.runner.prove(job)).proof;

    job.state = 'submitting';
    /*
     * Recorded on the job rather than inferred later, because after this line
     * nothing local can establish it again: `attempts` counts proofs, and a job
     * that came back through recovery looks exactly like one that never got
     * here.
     */
    job.submissionAttempted = true;
    await this.save(job);

    const { txRef } = await this.runner.submit(job, material);

    job.txRef = txRef;
    job.state = 'settled';
    await this.save(job);
    return clone(job);
  }

  private async doRecover(job: Job): Promise<Job> {
    if (!this.runner.recover) {
      /*
       * No way to ask the chain, so the only safe answer is to stop and say so.
       * Retrying blind could pay twice; marking it settled could hide a payment
       * that never happened. Both are worse than a person looking.
       */
      job.state = 'failed';
      job.error =
        'interrupted after submitting, and there is no way to ask the chain what happened. ' +
        'Check the account before retrying: the transaction may have settled.';
      await this.save(job);
      return clone(job);
    }

    const outcome = await this.runner.recover(job);
    if (outcome?.settled) {
      job.txRef = outcome.txRef ?? job.txRef;
      job.state = 'settled';
      await this.save(job);
      return clone(job);
    }

    /*
     * Safe to do again - which is what `recover`'s `null` actually means, and
     * is NOT the same as *the chain never got it*. The circuit refuses the
     * duplicate; that is what makes the retry safe, and it says nothing about
     * whether the first attempt landed.
     */
    job.state = 'queued';
    await this.save(job);
    return clone(job);
  }

  private async save(job: Job): Promise<void> {
    job.updatedAt = this.now().toISOString();
    /*
     * THE LEASE IS RENEWED ON EVERY TRANSITION AND DROPPED WHEN THERE IS
     * NOTHING LEFT TO DO. Renewed, because the transitions either side of a
     * proof are minutes apart and a lease that lapsed in between would be a
     * lease that expired under the worker still holding it. Dropped on a
     * terminal state, because a finished job that still names an owner reads as
     * work in progress to every other tab and to anything showing this to a
     * person.
     */
    if (isTerminal(job.state)) delete job.lease;
    else if (job.lease?.owner === this.owner) job.lease = this.leaseNow();

    /*
     * **CONDITIONAL, AND THAT IS THE DIFFERENCE BETWEEN A LEASE AND A LOCK.**
     * Claiming was already atomic; writing was not, so a worker that had lost
     * its lease while suspended wrote its own name back over the worker that
     * had legitimately taken the job, and both then submitted. Refusing here is
     * what makes the claim above mean anything after the first instant.
     */
    const kept = await this.store.writeHeld(clone(job), this.owner, this.now());
    if (!kept) {
      throw new LeaseLost(
        `this ${job.kind} is being worked somewhere else - another tab, or another window - ` +
          'so it has been left alone here. Nothing has been lost: whichever one is working it ' +
          'will finish it.',
      );
    }
    this.onChange?.(clone(job));
  }
}

/**
 * A store backed by nothing, for tests and for the simulated stack.
 *
 * Deliberately keeps insertion order, because `pending()` returning
 * oldest-first is what makes the queue fair rather than arbitrary.
 */
export class MemoryJobStore implements JobStore {
  private jobs: Job[] = [];

  async list(): Promise<Job[]> {
    return this.jobs.map(clone);
  }

  async put(job: Job): Promise<void> {
    const i = this.jobs.findIndex((j) => j.id === job.id);
    if (i === -1) this.jobs.push(clone(job));
    else this.jobs[i] = clone(job);
  }

  async writeHeld(job: Job, owner: string, now: Date): Promise<boolean> {
    const stored = this.jobs.find((j) => j.id === job.id);
    if (!mayWrite(stored, job, owner, now)) return false;
    await this.put(job);
    return true;
  }

  /**
   * Atomic here for free, and that is worth saying rather than assuming: this
   * store is one array in one process, and nothing suspends between the read
   * and the write below. It is the shared backends that have to work for it.
   */
  async claim(id: string, lease: JobLease, now: Date): Promise<Job | null> {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i === -1) return null;
    const held = this.jobs[i].lease;
    if (!mayClaim(held, lease.owner, now)) return null;
    this.jobs[i] = { ...clone(this.jobs[i]), lease };
    return clone(this.jobs[i]);
  }
}

/**
 * Whether a lease is free to take.
 *
 * Exported because every store has to answer this the same way, and three
 * copies of a rule about who may work a payment is how the copies disagree.
 *
 * Taking one's OWN lease again is allowed on purpose: a worker that comes back
 * to a job it is already holding is the ordinary case, and refusing it would
 * make a queue unable to continue its own work.
 */
export const mayClaim = (
  held: JobLease | undefined,
  owner: string,
  now: Date,
): boolean => {
  if (!held) return true;
  if (held.owner === owner) return true;
  /*
   * An unparseable expiry is treated as LIVE rather than expired. A record
   * nobody can read is not evidence that the worker who wrote it has gone, and
   * the two errors are not equal: waiting costs time, taking it costs a
   * payment.
   */
  const until = Date.parse(held.until);
  if (Number.isNaN(until)) return false;
  return until <= now.getTime();
};
