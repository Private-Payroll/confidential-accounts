/**
 * What the page knows about a proof that is running somewhere else.
 *
 * ── THE FREEZE IS NOT A PROPERTY OF PROVING. IT IS A PROPERTY OF PROVING ON
 *    THE THREAD THAT PAINTS THE PAGE. ──────────────────────────────────────
 *
 * Measured, on this contract's joint-largest circuit, in a page this repository
 * serves: 176.9 seconds the first time on a given device and 140.3 seconds
 * every time after that, **during which the page answered 0 times out of an
 * expected 2,807.** Not slow. Stopped: nothing scrolled, no button could be
 * pressed, and the spinner itself was frozen mid-turn.
 *
 * Every second of that wall clock survives moving the work to another thread.
 * **The freeze does not**, and that is the whole of what this file buys. The
 * person keeps their application while their own approval is being proved.
 *
 * ── RESTARTABLE, NOT RESUMABLE, AND THE DIFFERENCE IS NOT A NICETY ───────
 *
 * A proof is one opaque call into WebAssembly with no checkpoint of any kind.
 * A tab that is closed at 130 seconds has not saved 130 seconds of anything: a
 * reopened page starts that proof again from nothing. **What it costs is time
 * and only time** - proving is pure, reaches no chain and spends no fee, which
 * is exactly why the job model separates it from the step that does.
 *
 * So nothing here is called a resume, nothing reports a proof as part done, and
 * nothing stores a partial proof. The job survives; the proof does not.
 *
 * ── AND THE ONE NUMBER THAT IS REALLY A FRACTION ─────────────────────────
 *
 * The prover emits nothing while it runs, and there is nowhere to put a
 * callback: the package's entire surface is `prove`, `check`, `provingProvider`,
 * `jsonIrToBinary` and a class that reads `k`. No callback, no emitter, no abort
 * signal; the layer above accepts a timeout and nothing else.
 *
 * **The download is different.** Every artefact arrives with a length, so bytes
 * over bytes is a real ratio about a real thing. This model therefore carries a
 * fraction for the fetch and elapsed time for the proof, and a screen reading it
 * cannot draw a percentage over the proof because there is not one here to draw.
 * **A bar that crawls to ninety and sits there is a lie told to somebody waiting
 * on their own money**, and it is worse than no bar at all.
 */
import { JobClient, webPort, type Port } from '../core/jobs-worker.js';
import type { Job, JobState } from '../core/jobs.js';
import type { FetchProgress } from './key-material.js';

/**
 * Where a proof has reached, in terms a screen can render without inventing
 * anything.
 *
 * The stages are deliberately named after what the person is waiting FOR rather
 * than after what the code is doing, and only one of them carries a fraction.
 */
export type ProofStage =
  /** Accepted and durable, nothing started. */
  | { readonly name: 'waiting' }
  /** The one stage with a real ratio. `total` is null when nothing said. */
  | { readonly name: 'fetching'; readonly what: string; readonly received: number; readonly total: number | null }
  /** No fraction exists. Elapsed time is the only true thing to show. */
  | { readonly name: 'proving'; readonly elapsedMs: number }
  /** Sent, outcome not yet known. */
  | { readonly name: 'submitting' }
  | { readonly name: 'done' }
  | { readonly name: 'stopped'; readonly reason: string };

export interface ProofStatus {
  readonly jobId: string;
  readonly accountId: string;
  readonly stage: ProofStage;
  /** How many times this job has been started, across every tab and reload. */
  readonly attempts: number;
}

/** Everything the page is currently waiting on, oldest first. */
export type ProofStatusList = readonly ProofStatus[];

/**
 * What the worker sends that is not part of the job protocol.
 *
 * `fetch-progress` is unsolicited and frequent; `ready` is sent once. Both are
 * deliberately outside the request/response protocol, because neither is an
 * answer to anything the page asked.
 */
export type WorkerNotice =
  | { readonly kind: 'proving-worker-ready' }
  | { readonly kind: 'fetch-progress'; readonly jobId: string; readonly progress: FetchProgress };

/** The stage a persisted job state means when nothing more is known. */
const stageOfState = (job: Job, startedAt: number | undefined, now: number): ProofStage => {
  switch (job.state) {
    case 'queued':
      return { name: 'waiting' };
    case 'proving':
    case 'proven':
      /*
       * `proven` is drawn as proving on purpose. It is the instant between the
       * proof finishing and the balance beginning, it lasts no time at all, and
       * a screen that flashed a third word through it would read as a glitch.
       */
      return { name: 'proving', elapsedMs: startedAt === undefined ? 0 : now - startedAt };
    case 'submitting':
      return { name: 'submitting' };
    case 'settled':
      return { name: 'done' };
    case 'cancelled':
      return { name: 'stopped', reason: 'withdrawn before it was sent' };
    case 'failed':
      return { name: 'stopped', reason: job.error ?? 'it stopped and gave no reason' };
    default: {
      const never: never = job.state;
      return { name: 'stopped', reason: String(never) };
    }
  }
};

export interface ProvingSessionOptions {
  /** Injected so this is drivable without a real Worker. */
  port: Port;
  now?: () => number;
  /** Told whenever anything a screen renders has changed. */
  onChange?: (all: ProofStatusList) => void;
}

/**
 * The page's half of the proving worker.
 *
 * Holds no opinion of its own about what is true: every state it reports came
 * from the worker, which owns the store. The one thing it keeps for itself is
 * when each proof STARTED, because elapsed time is a property of this page's
 * clock and there is no honest way to recover it after a reload - which is
 * said, rather than reconstructed from a timestamp that would be a guess.
 */
export class ProvingSession {
  private readonly client: JobClient;
  private readonly now: () => number;
  private readonly onChange?: (all: ProofStatusList) => void;
  private readonly jobs = new Map<string, Job>();
  private readonly startedProvingAt = new Map<string, number>();
  private readonly fetching = new Map<string, FetchProgress>();
  private readyResolve!: () => void;
  private readonly readyPromise: Promise<void>;

  constructor(options: ProvingSessionOptions) {
    this.now = options.now ?? (() => Date.now());
    this.onChange = options.onChange;
    this.readyPromise = new Promise<void>((resolve) => { this.readyResolve = resolve; });

    /*
     * **THE NOTICE LISTENER IS INSTALLED BEFORE THE CLIENT, AND THE ORDER IS
     * NOT COSMETIC.** A module worker that is still evaluating its top-level
     * `await` drops messages posted to it, so the page must not send anything
     * until the worker says it is listening. Registering after the client would
     * mean the ready notice could be delivered to a handler that does not exist
     * yet on a channel that delivers once.
     */
    options.port.onMessage((message) => this.notice(message));
    this.client = new JobClient(options.port);
    this.client.onChange((job) => this.saw(job));
  }

  /** Resolves once the worker has said it is listening. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  private notice(message: unknown): void {
    const n = message as WorkerNotice;
    if (!n || typeof (n as any).kind !== 'string') return;
    if (n.kind === 'proving-worker-ready') return this.readyResolve();
    if (n.kind === 'fetch-progress') {
      this.fetching.set(n.jobId, n.progress);
      return this.publish();
    }
  }

  private saw(job: Job): void {
    const previous = this.jobs.get(job.id);
    this.jobs.set(job.id, job);

    /*
     * **A NEW ATTEMPT STARTS FROM NOTHING, AND THE CLEARING COMES BEFORE THE
     * SETTING BELOW OR IT DELETES WHAT IT JUST WROTE.** `attempts` moves on the
     * very transition INTO proving - queued at nought, proving at one - so
     * clearing afterwards wiped the start time of every first attempt and every
     * proof read as nought seconds. Measured, by the case beneath this file.
     *
     * Both records are per attempt for the same reason. The artefact count
     * belongs to a download that is over; the clock is the ONLY honest signal
     * the proving stage has, because the prover reports nothing at all, so a
     * clock carried across attempts is the one number that must not lie.
     *
     * A job that has moved PAST fetching needs no clearing here: `status`
     * already refuses to draw a fetch stage for a job that is not queued or
     * proving, so a second guard would be a line whose removal changes nothing
     * and which no case could ever catch.
     */
    if (previous !== undefined && previous.attempts !== job.attempts) {
      this.fetching.delete(job.id);
      this.startedProvingAt.delete(job.id);
    }

    if (job.state === 'proving' && !this.startedProvingAt.has(job.id)) {
      this.startedProvingAt.set(job.id, this.now());
    }
    this.publish();
  }

  /** What a screen should draw right now. */
  status(): ProofStatusList {
    const now = this.now();
    return [...this.jobs.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((job) => {
        const bytes = this.fetching.get(job.id);
        /*
         * FETCHING OUTRANKS PROVING WHILE BYTES ARE STILL ARRIVING, because the
         * job record says `proving` for the whole of it: the artefacts are
         * pulled INSIDE the prover's own call, by the WebAssembly reaching back
         * for them. Measured: 36.6 seconds of a 176.9-second first proof was
         * download, over a local connection. Showing that as proving would put
         * the one honest fraction in this operation behind a stage that has
         * none.
         */
        const stage: ProofStage =
          bytes && (job.state === 'queued' || job.state === 'proving')
            ? { name: 'fetching', what: bytes.what, received: bytes.received, total: bytes.total }
            : stageOfState(job, this.startedProvingAt.get(job.id), now);
        return { jobId: job.id, accountId: job.accountId, stage, attempts: job.attempts };
      });
  }

  private publish(): void {
    this.onChange?.(this.status());
  }

  /**
   * Picks up whatever a previous life left behind.
   *
   * A tab that was closed mid-proof, a laptop that slept, a Worker the browser
   * reclaimed: in every case the job is on disk and this is what continues it.
   * **It continues the JOB, not the proof** - the proof starts again, and costs
   * only the time it costs.
   */
  async resumeWork(): Promise<void> {
    await this.ready();
    for (const job of await this.client.pending()) this.saw(job);
    await this.client.drain();
  }

  async enqueue(args: { accountId: string; kind: Job['kind']; signerId: string; payload?: Record<string, unknown> }): Promise<Job> {
    await this.ready();
    const job = await this.client.enqueue(args);
    this.saw(job);
    void this.client.drain().catch(() => {
      /*
       * The failure is already on the job and already reported through
       * `onChange`; a second copy of it thrown from here would be an unhandled
       * rejection in a page that has nothing useful to do with it.
       */
    });
    return job;
  }

  /** Withdraws a job that has not been sent. Refuses once it has. */
  async cancel(jobId: string): Promise<Job> {
    await this.ready();
    const job = await this.client.cancel(jobId);
    this.saw(job);
    return job;
  }

  /** The worker is gone. Everything outstanding is refused rather than left hanging. */
  fail(reason: string): void {
    this.client.fail(reason);
  }
}

/**
 * Starts the proving worker and connects to it.
 *
 * **CONFIGURATION TRAVELS IN THE WORKER'S NAME, NOT IN A MESSAGE, AND THAT IS
 * THE POINT OF THIS FUNCTION.** A module worker whose top-level `await` is
 * still pending drops what is posted to it, and this worker's first act is to
 * load a WebAssembly prover - so a configuration message sent at construction
 * would be the message most likely to be lost. `name` is set before the worker
 * exists and is readable from inside it with no round trip at all.
 */
export interface ProvingWorkerConfig {
  /** Where the public proving artefacts are served from. */
  artefactBase: string;
  /** Which IndexedDB database holds the jobs. */
  dbName?: string;
}

export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  terminate?(): void;
}

export const connectProvingWorker = (
  worker: WorkerLike,
  options: Omit<ProvingSessionOptions, 'port'> = {},
): ProvingSession => new ProvingSession({ ...options, port: webPort(worker) });

/** The `name` a worker is started under, and the shape it reads back. */
export const workerNameFor = (config: ProvingWorkerConfig): string =>
  JSON.stringify({ v: 1, ...config });

export const configFromWorkerName = (name: string): ProvingWorkerConfig => {
  let parsed: any;
  try {
    parsed = JSON.parse(name);
  } catch {
    throw new Error(
      'the proving worker was started without the settings it needs. It cannot fetch ' +
        'proving material until it is told where the application serves it from.',
    );
  }
  if (typeof parsed?.artefactBase !== 'string' || parsed.artefactBase === '') {
    throw new Error(
      'the proving worker was not told where the application serves its proving material, ' +
        'so it has nothing to prove with.',
    );
  }
  return { artefactBase: parsed.artefactBase, dbName: typeof parsed.dbName === 'string' ? parsed.dbName : undefined };
};

/** Bytes as a person reads them. Used on screen and in the worker's notices. */
export const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * Elapsed time, in the shape a waiting person actually reads.
 *
 * Seconds up to a minute and then minutes and seconds, because *94s* stops
 * being a number anybody converts in their head somewhere around a minute and
 * a half - and this wait is over two minutes.
 */
export const elapsed = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
};

export type { Job, JobState };
