/**
 * The queue, moved off the thread the person is looking at. Decision 0008.
 *
 * WHY A THREAD AND NOT A PROMISE. WASM proving does not make a page feel slow,
 * it stops it: no scrolling, no cancel button, the spinner itself frozen
 * mid-turn. `async` does not help, because the work is CPU rather than I/O and
 * there is nothing to await. The only fix is a second thread. That is true at 3
 * seconds as much as at the 108 we measured, so this survives whatever
 * the Foundation answers.
 *
 * WHAT THIS FILE IS. A protocol, not a Worker. It is written against a `Port`
 * with `postMessage` and a message handler, which is what `Worker`,
 * `MessagePort`, a `SharedWorker`, Node's `worker_threads`, and a React Native
 * bridge all already are. So the same queue serves a browser tab, the macOS and
 * iOS apps, and the tests, and none of them needs its own copy of the rules.
 *
 * THE RULE THAT MATTERS: THE QUEUE LIVES ON ONE SIDE ONLY. The worker owns the
 * store; the host owns nothing and asks for everything. Two `JobQueue`s over one
 * storage would each read, decide, and write, and the second write would erase
 * the first — a job marked `settled` on one side and re-proved on the other. So
 * the host here is a client with no state of its own, deliberately, even though
 * a local cache would be easy and would read faster.
 */
import type { Job, JobKind, JobQueue } from './jobs.js';

/**
 * The least a channel has to do.
 *
 * `Worker`, `MessagePort` and Node's `parentPort` all satisfy this as they are;
 * the adapters below exist only because their listener APIs are spelled
 * differently.
 */
export interface Port {
  postMessage(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
}

/* ---------------- the protocol ---------------- */

type Request =
  | { kind: 'enqueue'; id: number; args: EnqueueArgs }
  | { kind: 'cancel'; id: number; jobId: string }
  | { kind: 'pending'; id: number }
  | { kind: 'get'; id: number; jobId: string }
  | { kind: 'drain'; id: number };

type Response =
  /* Deliberately not an exception: an error thrown inside a worker does not
   * reach the page, it is simply lost, and the caller waits forever. Failures
   * have to travel as ordinary messages. */
  | { kind: 'ok'; id: number; value: unknown }
  | { kind: 'error'; id: number; message: string }
  /* Unsolicited. Every transition, so optimistic UI and notifications are
   * subscribers rather than separate mechanisms. */
  | { kind: 'change'; job: Job };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface EnqueueArgs {
  accountId: string;
  kind: JobKind;
  signerId: string;
  payload?: Record<string, unknown>;
}

/* ---------------- worker side ---------------- */

/**
 * Runs on the background thread. Owns the queue and answers for it.
 *
 * Returns nothing to unsubscribe with, because the worker's whole life is this.
 *
 * `onChange` on the queue must be wired to this port, which `serveJobs` cannot
 * do itself — the queue is constructed before the port exists. `changeReporter`
 * is what you pass to `QueueOptions.onChange`.
 */
export const serveJobs = (queue: JobQueue, port: Port): void => {
  port.onMessage(async (message) => {
    const req = message as Request;
    if (!req || typeof (req as any).kind !== 'string') return;

    const reply = (r: Response) => port.postMessage(r);

    try {
      switch (req.kind) {
        case 'enqueue':
          return reply({ kind: 'ok', id: req.id, value: await queue.enqueue(req.args) });
        case 'cancel':
          return reply({ kind: 'ok', id: req.id, value: await queue.cancel(req.jobId) });
        case 'pending':
          return reply({ kind: 'ok', id: req.id, value: await queue.pending() });
        case 'get':
          return reply({ kind: 'ok', id: req.id, value: (await queue.get(req.jobId)) ?? null });
        case 'drain':
          await queue.drain();
          return reply({ kind: 'ok', id: req.id, value: null });
        default:
          /*
           * An unknown request is answered rather than ignored. Silence here
           * would hang the caller, and version skew between a cached page and a
           * newer worker is a normal thing to happen, not an impossible one.
           */
          return reply({
            kind: 'error',
            id: (req as any).id,
            message: `this worker does not understand "${(req as any).kind}" — the page may be a different version`,
          });
      }
    } catch (e) {
      /*
       * The message text is the product here, not a log line. "may have
       * settled" is what tells a person to go and look at the account before
       * retrying, and it must survive the trip across the thread boundary.
       */
      reply({ kind: 'error', id: req.id, message: String((e as any)?.message ?? e) });
    }
  });
};

/** Pass to `QueueOptions.onChange` so every transition reaches the host. */
export const changeReporter =
  (port: Port) =>
  (job: Job): void =>
    port.postMessage({ kind: 'change', job } satisfies Response);

/* ---------------- host side ---------------- */

/**
 * What the interface thread holds. Same shape as `JobQueue`, over a thread.
 *
 * Intentionally has no store, no cache and no opinion: it asks and reports.
 * Anything it remembered could disagree with the worker, and the disagreement
 * would be about whether someone's payment went out.
 */
export class JobClient {
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(job: Job) => void>();
  private deadReason: string | null = null;

  constructor(private port: Port) {
    port.onMessage((message) => {
      const res = message as Response;
      if (!res || typeof (res as any).kind !== 'string') return;

      if (res.kind === 'change') {
        for (const l of this.listeners) l(res.job);
        return;
      }

      const pending = this.waiting.get(res.id);
      /*
       * An answer to something we are not waiting for is dropped, not thrown.
       * A late reply after a timeout, or a duplicate, is a normal event on a
       * message channel and must not take the page down.
       */
      if (!pending) return;
      this.waiting.delete(res.id);

      if (res.kind === 'error') pending.reject(new Error(res.message));
      else pending.resolve(res.value);
    });
  }

  /** Every transition, for optimistic state and notifications. */
  onChange(listener: (job: Job) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The worker is gone — crashed, terminated, or the tab is closing.
   *
   * Every outstanding call is rejected rather than left hanging, because a
   * promise that never settles is a spinner that never stops, and the person is
   * left believing an approval is still in progress when nothing is running.
   * The jobs themselves are safe: they are on disk, and a new worker resumes
   * them from `pending()`.
   */
  fail(reason: string): void {
    this.deadReason = reason;
    const outstanding = [...this.waiting.values()];
    this.waiting.clear();
    for (const p of outstanding) p.reject(new Error(reason));
  }

  /*
   * `Omit` collapses a union into one object with only the shared keys, so
   * `Omit<Request, 'id'>` would silently reject `args` and `jobId`. Distributing
   * over the union first is what keeps each request's own fields.
   */
  private send<T>(req: DistributiveOmit<Request, 'id'>): Promise<T> {
    if (this.deadReason) return Promise.reject(new Error(this.deadReason));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      try {
        this.port.postMessage({ ...req, id });
      } catch (e) {
        // A channel that will not accept a message is already broken; failing
        // now beats waiting for a reply that cannot come.
        this.waiting.delete(id);
        reject(e as Error);
      }
    });
  }

  enqueue(args: EnqueueArgs): Promise<Job> {
    return this.send({ kind: 'enqueue', args });
  }
  cancel(jobId: string): Promise<Job> {
    return this.send({ kind: 'cancel', jobId });
  }
  pending(): Promise<Job[]> {
    return this.send({ kind: 'pending' });
  }
  get(jobId: string): Promise<Job | null> {
    return this.send({ kind: 'get', jobId });
  }
  drain(): Promise<void> {
    return this.send({ kind: 'drain' });
  }
}

/* ---------------- adapters ---------------- */

/**
 * A browser `Worker`, `MessagePort`, or anything else with `postMessage` and
 * `addEventListener('message')`.
 *
 * Kept structural rather than importing DOM types, so this file still compiles
 * where there is no DOM — the whole point of the module being isomorphic.
 */
export interface MessageEventTargetLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export const webPort = (target: MessageEventTargetLike): Port => ({
  postMessage: (m) => target.postMessage(m),
  onMessage: (h) => target.addEventListener('message', (e) => h(e.data)),
});

/** Node's `worker_threads` and React Native, which use `on('message', ...)`. */
export interface EmitterLike {
  postMessage(message: unknown): void;
  on(type: 'message', listener: (data: unknown) => void): void;
}

export const emitterPort = (target: EmitterLike): Port => ({
  postMessage: (m) => target.postMessage(m),
  onMessage: (h) => target.on('message', h),
});

/**
 * A connected pair of ports on one thread, for tests and for anywhere a real
 * Worker is not available.
 *
 * Delivery is deferred to a microtask so it behaves like a real channel: a
 * handler registered after a send still receives it, and no caller can rely on
 * a reply arriving before its own next line runs. Synchronous delivery here
 * would let tests pass against ordering a browser never gives you.
 *
 * NOT a way to skip the Worker in a browser. It runs the prover on the
 * interface thread, which is precisely the freeze this file exists to prevent.
 */
export const directPorts = (): [Port, Port] => {
  const handlers: [Array<(m: unknown) => void>, Array<(m: unknown) => void>] = [[], []];
  const make = (mine: 0 | 1, theirs: 0 | 1): Port => ({
    postMessage: (m) => {
      // Structured clone is what a real channel does; matching it here stops a
      // test passing on an object reference that a Worker could never share.
      const copy = JSON.parse(JSON.stringify(m ?? null));
      queueMicrotask(() => {
        for (const h of [...handlers[theirs]]) h(copy);
      });
    },
    onMessage: (h) => {
      handlers[mine].push(h);
    },
  });
  return [make(0, 1), make(1, 0)];
};
