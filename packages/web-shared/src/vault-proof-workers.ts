/**
 * **THE PROOFS OF ONE TRANSACTION, SIDE BY SIDE ON THREADS OF THEIR OWN.**
 *
 * The vault worker is one thread, and its prover is WebAssembly that runs one
 * proof at a time on the thread it is called on. A private deposit needs two
 * proofs - the coin going into the vault and the vault's own `deposit` call -
 * and the ledger asks for them together, so on one thread their times add up:
 * 124.2 s and 126.7 s for the pair on a four-core machine on 29 Sep, where the
 * `deposit` proof alone took 78.8 s. Here each proof is handed to a thread of
 * its own (`vault-proof-worker-entry.ts`), so the pair takes about as long as
 * the longer of the two.
 *
 * **WHAT IS PROVED DOES NOT CHANGE.** The ledger decides every proof and every
 * input to it, exactly as before; each one reaches the same two calls of
 * `@midnight-ntwrk/zkir-v2` with the same bytes, and each answer goes back to
 * the call that asked for it and to no other. Only the thread it runs on moves.
 *
 * **AND A THREAD IS KEPT FOR THE NEXT PROOF OF THE SAME CIRCUIT.** A contract
 * call is checked and then proved; the thread that checked it has its prover
 * already started, so the proof does not start another. At most one idle
 * thread is kept per circuit, and for `KEPT_IDLE_MS`.
 */
import type { KeyMaterialSource } from '../../../src/midnight/wasm-proving.js';

type FromAProofWorker =
  | { readonly op: 'ready' }
  | { readonly op: 'lookupKey'; readonly askId: number; readonly keyLocation: string }
  | { readonly op: 'getParams'; readonly askId: number; readonly k: number }
  | { readonly op: 'result'; readonly value: unknown }
  | { readonly op: 'failure'; readonly error: string };

/** What a proof's thread needs of a `Worker`, so the handing out can be driven in a test with none. */
export interface ProofWorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: FromAProofWorker }) => void): void;
  addEventListener(type: 'error', listener: (event: { message?: string }) => void): void;
  terminate(): void;
}

/** The ledger's `ProvingProvider`, the shape `transaction.prove` calls back into. */
interface LedgerProvingProvider {
  check(preimage: Uint8Array, keyLocation: string): Promise<(bigint | undefined)[]>;
  prove(preimage: Uint8Array, keyLocation: string, overwriteBindingInput?: bigint): Promise<Uint8Array>;
  lookupKey(keyLocation: string): ReturnType<KeyMaterialSource['lookupKey']>;
}

/** The ceiling on one proof, the same ten minutes the wallet's own SDK keeps. */
export const PROOF_CEILING_MS = 10 * 60_000;

/** How long a thread that has finished a proof is kept for the next proof of its circuit. */
export const KEPT_IDLE_MS = 2 * 60_000;

const failureOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/*
 * **WHAT A PERSON IS TOLD WHEN A PROOF'S THREAD FAILS**: what happened, that
 * nothing was sent, and what to do. The thread's own words, which name its
 * internals, are kept underneath as the cause, where a report can still read
 * them.
 */
const THREAD_STOPPED =
  'This device stopped working out the proof for this transaction before it finished, so nothing was sent. '
  + 'Try again; if it happens again, reload the page and try once more.';
const PROOF_FAILED =
  'This device could not work out the proof for this transaction, so nothing was sent. Reload the page and try again.';
const proofTookTooLong = (op: 'prove' | 'check'): string =>
  `${op === 'prove' ? 'Working out' : 'Checking'} the proof for this transaction took more than ten minutes, so this device `
  + 'stopped and nothing was sent. Try again with this page open in front and other heavy work closed.';
const plainly = (says: string, underneath: string): Error => new Error(says, { cause: new Error(underneath) });

/**
 * **A `ProvingProvider` WHOSE PROOFS RUN ON THREADS OF THEIR OWN.** Every call
 * gets a thread: an idle one kept from an earlier proof of the same circuit,
 * or a new one. A thread whose proof failed, that reported an error, or that
 * ran past the ceiling is never used again.
 */
export function provingOnWorkers(
  source: KeyMaterialSource,
  spawn: () => ProofWorkerLike,
  timers: {
    set(run: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  } = { set: (run, ms) => setTimeout(run, ms), clear: (h) => { clearTimeout(h as ReturnType<typeof setTimeout>); } },
): LedgerProvingProvider & { stop(): void; readonly idle: number; readonly didNotLoad: boolean } {
  interface Job {
    readonly op: 'prove' | 'check';
    readonly preimage: Uint8Array;
    readonly overwriteBindingInput?: bigint;
    readonly resolve: (value: unknown) => void;
    readonly reject: (e: Error) => void;
  }
  interface Thread {
    readonly worker: ProofWorkerLike;
    ready: boolean;
    job: Job | null;
    dead: boolean;
    letGo: unknown;
  }
  const idle = new Map<string, Thread>();
  let stopped = false;
  /* A thread that failed before it said `ready` never loaded: this device cannot start the prover on a thread of its own. */
  let didNotLoad = false;

  const post = (t: Thread): void => {
    if (t.job === null || !t.ready) return;
    t.worker.postMessage({ op: t.job.op, preimage: t.job.preimage, overwriteBindingInput: t.job.overwriteBindingInput });
  };
  const answer = (t: Thread, askId: number, work: Promise<unknown>): void => {
    work.then(
      (value) => t.worker.postMessage({ op: 'answer', askId, ok: true, value }),
      (e: unknown) => t.worker.postMessage({ op: 'answer', askId, ok: false, error: failureOf(e) }),
    );
  };
  const make = (): Thread => {
    const t: Thread = { worker: spawn(), ready: false, job: null, dead: false, letGo: null };
    t.worker.addEventListener('error', (event) => {
      const job = t.job;
      t.job = null;
      t.dead = true;
      if (!t.ready) didNotLoad = true;
      t.worker.terminate();
      job?.reject(plainly(THREAD_STOPPED, event.message || 'a proof\'s thread stopped before it answered'));
    });
    t.worker.addEventListener('message', ({ data }) => {
      const job = t.job;
      switch (data.op) {
        case 'ready': t.ready = true; post(t); return;
        case 'lookupKey': if (job !== null) answer(t, data.askId, source.lookupKey(data.keyLocation)); return;
        case 'getParams': if (job !== null) answer(t, data.askId, source.getParams(data.k)); return;
        case 'result': t.job = null; job?.resolve(data.value); return;
        case 'failure':
          t.job = null;
          t.dead = true;
          t.worker.terminate();
          job?.reject(plainly(PROOF_FAILED, data.error));
      }
    });
    return t;
  };
  const keep = (keyLocation: string, t: Thread): void => {
    if (stopped || t.dead || idle.has(keyLocation)) { t.worker.terminate(); return; }
    t.letGo = timers.set(() => {
      if (idle.get(keyLocation) !== t) return;
      idle.delete(keyLocation);
      t.worker.terminate();
    }, KEPT_IDLE_MS);
    idle.set(keyLocation, t);
  };
  const run = (op: 'prove' | 'check', keyLocation: string, preimage: Uint8Array, overwriteBindingInput?: bigint) =>
    new Promise<unknown>((resolve, reject) => {
      const waiting = idle.get(keyLocation);
      if (waiting !== undefined) {
        idle.delete(keyLocation);
        if (waiting.letGo !== null) timers.clear(waiting.letGo);
        waiting.letGo = null;
      }
      const t = waiting !== undefined && !waiting.dead ? waiting : make();
      let settled = false;
      const ceiling = timers.set(() => {
        if (settled) return;
        settled = true;
        t.job = null;
        t.dead = true;
        t.worker.terminate();
        reject(plainly(proofTookTooLong(op), `the ${op} did not finish within ten minutes`));
      }, PROOF_CEILING_MS);
      t.job = {
        op, preimage, overwriteBindingInput,
        resolve: (value) => {
          if (settled) return;
          settled = true;
          timers.clear(ceiling);
          keep(keyLocation, t);
          resolve(value);
        },
        reject: (e) => {
          if (settled) return;
          settled = true;
          timers.clear(ceiling);
          reject(e);
        },
      };
      post(t);
    });

  return {
    check: (preimage, keyLocation) => run('check', keyLocation, preimage) as Promise<(bigint | undefined)[]>,
    prove: (preimage, keyLocation, overwriteBindingInput) =>
      run('prove', keyLocation, preimage, overwriteBindingInput) as Promise<Uint8Array>,
    /* Straight from the source, as the in-thread prover does: the ledger reads the verifier key through it. */
    lookupKey: (keyLocation) => source.lookupKey(keyLocation),
    stop: () => {
      stopped = true;
      for (const t of idle.values()) {
        if (t.letGo !== null) timers.clear(t.letGo);
        t.worker.terminate();
      }
      idle.clear();
    },
    get idle() { return idle.size; },
    get didNotLoad() { return didNotLoad; },
  };
}

/** A proof provider as a transaction is proved through it. */
interface TransactionProver {
  proveTx(tx: unknown, config?: unknown): Promise<unknown>;
}

/**
 * **ONE THREAD, WHEN A THREAD OF ITS OWN CANNOT BE STARTED.** The proofs go to
 * threads of their own (`workers`); when one of those threads fails to load -
 * a browser that will not start a worker from this page, or a worker file that
 * did not arrive - the transaction is proved again, whole, on this thread
 * (`inThread`), and every transaction after it is too. A proof that failed for
 * any other reason is not tried again: it is said.
 */
export function oneThreadWhenAThreadDoesNotLoad(
  workers: TransactionProver & { readonly didNotLoad: boolean; stop(): void },
  inThread: () => Promise<TransactionProver>,
): TransactionProver {
  let one: Promise<TransactionProver> | null = null;
  const onOneThread = (): Promise<TransactionProver> => { one ??= inThread(); return one; };
  return {
    proveTx: async (tx, config) => {
      if (workers.didNotLoad) return (await onOneThread()).proveTx(tx, config);
      try {
        return await workers.proveTx(tx, config);
      } catch (e) {
        if (!workers.didNotLoad) throw e;
        workers.stop();
        return (await onOneThread()).proveTx(tx, config);
      }
    },
  };
}

/**
 * **THE VAULT WORKER'S PROOF PROVIDER**: each proof on a thread of its own
 * where this thread can start one, and on this thread (`inThread`) where it
 * cannot - because `Worker` does not exist here, or because a thread failed to
 * load. Both ways to one thread are this function's, and only this function's.
 */
export async function proofProviderOnWorkers(
  source: KeyMaterialSource,
  scope: { readonly Worker?: unknown },
  inThread: () => Promise<TransactionProver>,
): Promise<TransactionProver> {
  if (typeof scope.Worker !== 'function') return inThread();
  const { createProofProvider } = await import('@midnight-ntwrk/midnight-js-types');
  const provider = provingOnWorkers(source, () => new Worker(new URL('./vault-proof-worker-entry.js', import.meta.url), {
    type: 'module', name: 'vault-proof',
  }) as unknown as ProofWorkerLike);
  const onWorkers = createProofProvider(provider as never) as unknown as TransactionProver;
  return oneThreadWhenAThreadDoesNotLoad({
    proveTx: (tx, config) => onWorkers.proveTx(tx, config),
    get didNotLoad() { return provider.didNotLoad; },
    stop: () => provider.stop(),
  }, inThread);
}
