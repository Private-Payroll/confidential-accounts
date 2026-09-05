/**
 * Approvals as durable jobs. Decision 0008.
 *
 * Everything a signer does — propose, approve, cancel — is slow and can fail
 * halfway. This sentence named `execute` and `credit` until `C292` deleted
 * both; nothing about the argument depended on which circuits they were.
 * Proving takes seconds at best and ~108 seconds against the
 * single-threaded WASM prover (M-78), and settlement adds ~23 seconds of block
 * time that no amount of engineering removes. So no version of this product
 * gets to treat "click approve" as a function call that returns.
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
 * `credit` WAS HERE AND IS GONE: S23 shed the circuit, and nothing ever
 * enqueued that kind.
 *
 * `execute` FOLLOWED IT, `C292`, `S26`. The circuit it named spent the
 * account's own balance and was removed with the balance. Nothing ever
 * enqueued that kind either — the only kind anything enqueues is `approve` —
 * so this is a name removed, not a queue drained.
 *
 * WHEN A RUN IS PAID FROM A VAULT there will be a kind for it, and it will be
 * added here first, because a job kind with no circuit is what these two
 * removals were both cleaning up after.
 */
export type JobKind = 'propose' | 'approve' | 'cancel' | 'addSigner';

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
  createdAt: string;
  updatedAt: string;
}

export interface JobStore {
  /** Every job, in creation order. Small by nature: jobs are per account. */
  list(): Promise<Job[]>;
  put(job: Job): Promise<void>;
}

export interface QueueOptions {
  store: JobStore;
  /** Injected so tests do not sleep and every environment can use its own. */
  now?: () => Date;
  newId?: () => string;
  /**
   * How many jobs run at once.
   *
   * ONE, and that is not laziness. The prover is single-threaded (M-78), so two
   * proofs do not go twice as fast — they take twice as long each and the user
   * sees nothing finish. Serial is both simpler and faster here.
   */
  concurrency?: number;
  /** Told about every change, for the UI and for notifications. */
  onChange?: (job: Job) => void;
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
   * Returns the outcome if the chain already knows about it, or null if it
   * genuinely never landed. Without this, a queue that resumes after a crash
   * is a queue that double-spends — and "it settled but we did not see it" is
   * indistinguishable from "it never arrived" without asking.
   */
  recover?(job: Job): Promise<{ settled: boolean; txRef?: string } | null>;
}

const clone = (job: Job): Job => ({ ...job, payload: { ...job.payload } });

export class JobQueue {
  private readonly store: JobStore;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly onChange?: (job: Job) => void;
  private running = false;

  constructor(private runner: JobRunner, private options: QueueOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `job_${Math.random().toString(36).slice(2, 12)}`);
    this.onChange = options.onChange;
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
        const next = (await this.pending())[0];
        if (!next) return;

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

        await this.step(next);
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
      job.error = String((e as any)?.message ?? e);
      job.state = 'failed';
      await this.save(job);
      return clone(job);
    }
  }

  /* ---------------- transitions ---------------- */

  private async doProve(job: Job): Promise<Job> {
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

    // The chain genuinely never got it, so starting again is safe.
    job.state = 'queued';
    await this.save(job);
    return clone(job);
  }

  private async save(job: Job): Promise<void> {
    job.updatedAt = this.now().toISOString();
    await this.store.put(clone(job));
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
}
