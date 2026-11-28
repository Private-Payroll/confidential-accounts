/**
 * The job queue served over a message port, so WASM proving, which blocks its thread, runs off the interface thread.
 * The queue lives on the worker's side only: two queues over one store would each erase the other's writes.
 */
import type { Job, JobKind, JobQueue } from './jobs.js';

/** The least a channel has to do; the adapters below fit `Worker`, `MessagePort` and Node's `parentPort` to it. */
export interface Port {
  postMessage(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
}

type Request =
  | { kind: 'enqueue'; id: number; args: EnqueueArgs }
  | { kind: 'cancel'; id: number; jobId: string }
  | { kind: 'pending'; id: number }
  | { kind: 'get'; id: number; jobId: string }
  | { kind: 'drain'; id: number };

type Response =
  /* A failure travels as a message: an error thrown inside a worker never reaches the page, and its caller would
   * wait forever. */
  | { kind: 'ok'; id: number; value: unknown }
  | { kind: 'error'; id: number; message: string }
  /* Sent unasked on every transition, for optimistic state and notifications. */
  | { kind: 'change'; job: Job };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface EnqueueArgs {
  accountId: string;
  kind: JobKind;
  signerId: string;
  payload?: Record<string, unknown>;
}

/**
 * Owns the queue on the background thread and answers for it. The queue is built before the port, so pass
 * `changeReporter(port)` as its `onChange`.
 */
export const serveJobs = (queue: JobQueue, port: Port): void => {
  const answer = async (message: unknown): Promise<void> => {
    if (typeof message !== 'object' || message === null || !('kind' in message) || typeof message.kind !== 'string') {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only this file's JobClient writes here.
    const req = message as Request;

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
          /* Answered, not ignored: silence would hang the caller, and a cached page talking to a newer worker is normal. */
          return reply({
            kind: 'error',
            id: 'id' in message && typeof message.id === 'number' ? message.id : Number.NaN,
            message: `this worker does not understand "${message.kind}" — the page may be a different version`
          });
      }
    } catch (e) {
      // The person reads this text ("may have settled" sends them to check before retrying), so it crosses whole.
      const said = typeof e === 'object' && e !== null && 'message' in e ? e.message : undefined;
      reply({ kind: 'error', id: req.id, message: String(said ?? e) });
    }
  };
  // Every request `answer` understands is answered there, a failure included; nobody reads what the handler returns.
  port.onMessage((message) => void answer(message));
};

/** Pass to `QueueOptions.onChange` so every transition reaches the host. */
export const changeReporter =
  (port: Port) =>
  (job: Job): void =>
    port.postMessage({ kind: 'change', job } satisfies Response);

/**
 * The interface thread's side, shaped like `JobQueue`. It keeps nothing: anything it remembered could disagree with
 * the worker about whether a payment went out.
 */
export class JobClient {
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(job: Job) => void>();
  private deadReason: string | null = null;

  constructor(private port: Port) {
    port.onMessage((message) => {
      if (typeof message !== 'object' || message === null || !('kind' in message) || typeof message.kind !== 'string') {
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only this file's serveJobs writes here.
      const res = message as Response;

      if (res.kind === 'change') {
        for (const l of this.listeners) l(res.job);
        return;
      }

      const pending = this.waiting.get(res.id);
      // A reply nobody waits for (late, or a duplicate) is normal on a channel, so it is dropped, not thrown.
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
   * The worker is gone: every outstanding call is rejected, so no spinner waits on nothing. The jobs are on disk, and a
   * new worker resumes them from `pending()`.
   */
  fail(reason: string): void {
    this.deadReason = reason;
    const outstanding = [...this.waiting.values()];
    this.waiting.clear();
    for (const p of outstanding) p.reject(new Error(reason));
  }

  // A plain `Omit` over the union would keep only the shared keys and refuse `args` and `jobId`.
  private send<T>(req: DistributiveOmit<Request, 'id'>): Promise<T> {
    if (this.deadReason) return Promise.reject(new Error(this.deadReason));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the worker answers each kind with its type.
      this.waiting.set(id, { resolve: (v) => resolve(v as T), reject });
      try {
        this.port.postMessage({ ...req, id });
      } catch (e) {
        // A channel that will not accept a message is already broken; failing
        // now beats waiting for a reply that cannot come.
        this.waiting.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
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

/** A browser `Worker`, `MessagePort` or anything with `postMessage` and `addEventListener('message')`, typed here so the
 * file compiles without the DOM. */
export interface MessageEventTargetLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export const webPort = (target: MessageEventTargetLike): Port => ({
  postMessage: (m) => target.postMessage(m),
  onMessage: (h) => target.addEventListener('message', (e) => h(e.data))
});

/** Node's `worker_threads` and React Native, which use `on('message', ...)`. */
export interface EmitterLike {
  postMessage(message: unknown): void;
  on(type: 'message', listener: (data: unknown) => void): void;
}

export const emitterPort = (target: EmitterLike): Port => ({
  postMessage: (m) => target.postMessage(m),
  onMessage: (h) => target.on('message', h)
});

/**
 * Two connected ports on one thread, for tests, delivering a microtask later as a real channel does. Never a stand-in
 * for the browser's Worker: it would run the prover on the interface thread.
 */
export const directPorts = (): [Port, Port] => {
  const handlers: [((m: unknown) => void)[], ((m: unknown) => void)[]] = [[], []];
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
    }
  });
  return [make(0, 1), make(1, 0)];
};
