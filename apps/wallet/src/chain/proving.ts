import { CostModel, Transaction } from '@midnightntwrk/ledger-v9';
import type { ProvingProvider } from '@midnightntwrk/ledger-v9';
import type {
  AnyVersionUnboundTransaction, AnyVersionUnprovenTransaction, VersionedProvingService,
} from '@midnightntwrk/wallet-sdk/capabilities/proving';
import type { KeyMaterialProvider } from '@midnightntwrk/zkir-v2';
import { makePinnedKeyMaterialProvider } from './key-material.js';
import { describeFailure } from '../lib/failure-text.js';
import { createLedger9ProofProvider } from '@midnight-ntwrk/midnight-js-types';
import { provedTransaction, type Provable } from '../../../../packages/web-shared/src/vault-proof-workers.js';

/**
 * THE IN-BROWSER PROVER: the facade's proving service for this wallet. Each
 * ledger-v9 transaction is proved with `transaction.prove(provider,
 * CostModel.initialCostModel())`, the call the SDK's own WASM proving service
 * makes, with each proof computed in a web worker of this app's own
 * (`proving-worker.ts`). The worker proves a contract's circuit with the
 * zkir-v3 engine and one of the network's own keys with the zkir-v2 engine,
 * chosen by where the key lives (`zkirEngineFor`).
 *
 * The worker says `ready` once its listener stands, and the page posts nothing
 * before it hears that: a message posted to a module worker while its
 * WebAssembly is still loading is dropped, and a proof posted at once would
 * never be answered. A worker that finished is kept for the next proof of the
 * same circuit rather than terminated, so it does not read its key again
 * (`keptProvers`). Key material is fetched by the thread that owns the workers
 * (the page, or the wallet's account builder) and moved to the worker that
 * asked, not copied, so a proving key leaves memory with the proof. A proof
 * still running at the SDK's own ten-minute ceiling is refused.
 *
 * Key material comes only from this wallet's own origin (`key-material.ts`):
 * artefacts vendored with their SHA-256 pinned, cached in IndexedDB, and
 * refused on any mismatch, with no fallback to any other source.
 */

/** The SDK's own ceiling (MAX_TIME_TO_PROCESS, WasmProver.js:27). */
export const PROVING_CEILING_MS = 10 * 60 * 1000;

/** The default key material source — OURS: own origin, hash-pinned,
 * IndexedDB-cached (`key-material.ts`). NOT the SDK's bucket. */
export const defaultKeyMaterial = (): KeyMaterialProvider =>
  makePinnedKeyMaterialProvider();

type FromWorker =
  | { readonly op: 'ready' }
  | { readonly op: 'lookupKey'; readonly askId: number; readonly keyLocation: string }
  | { readonly op: 'getParams'; readonly askId: number; readonly k: number }
  | { readonly op: 'result'; readonly value: unknown }
  | { readonly op: 'failure'; readonly error: string };

/** What a proving worker needs of a `Worker`, so the keeping can be driven in a test with none. */
export interface ProvingWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: FromWorker }) => void): void;
  addEventListener(type: 'error', listener: (event: { message?: string }) => void): void;
  terminate(): void;
}

/** A proof starting or ending, for a screen that says the wallet is at work. Reported as it happens and never from a clock. */
export interface ProofEvent {
  readonly op: 'prove' | 'check';
  readonly at: 'start' | 'end';
}

/**
 * **HOW LONG A PROVING WORKER IS KEPT WITH NOTHING TO DO.** A worker that has
 * proved once has read its circuit's key, and reading it is the part of a proof
 * that is not the proof itself: measured on 29 Sep, 6.3 s of a 45.9 s output
 * proof and 14.0 s of a 90.0 s spend proof, and 79 ms the second time in a
 * worker that was kept. What a kept worker costs is the memory it proved in,
 * which a browser does not give back while the worker lives, so it is let go
 * after this long.
 */
export const KEPT_IDLE_MS = 2 * 60_000;

/**
 * The buffers a key-material answer can be moved in rather than copied: each
 * key, circuit or parameter file's own bytes, once each. The provider hands
 * out a fresh copy per ask and keeps none, so moving it takes it from nobody.
 */
export const buffersOf = (value: unknown): ArrayBuffer[] => {
  const parts = value instanceof Uint8Array ? [value]
    : value !== null && typeof value === 'object' ? Object.values(value).filter((v): v is Uint8Array => v instanceof Uint8Array)
      : [];
  return [...new Set(parts.map((p) => p.buffer).filter((b): b is ArrayBuffer => b instanceof ArrayBuffer))];
};

interface Job {
  readonly op: 'prove' | 'check';
  readonly keyLocation: string;
  readonly preimage: Uint8Array;
  readonly overwriteBindingInput?: bigint;
  readonly km: KeyMaterialProvider;
  readonly resolve: (value: unknown) => void;
  readonly reject: (e: Error) => void;
}

/**
 * **THE WORKERS PROOFS RUN IN, KEPT BETWEEN PROOFS.** At most one idle worker
 * is kept per circuit - by the key location the ledger names for each proof -
 * so the next proof of that circuit reuses a worker that has already read its
 * key. Proofs that run at the same time each get their own worker, exactly as
 * before: a proof never waits for another to finish. A worker that failed, was
 * lost or ran past the ceiling is never kept.
 */
export function keptProvers(spawn: () => ProvingWorkerLike, idleMs: number = KEPT_IDLE_MS): {
  run(op: 'prove' | 'check', keyLocation: string, preimage: Uint8Array, km: KeyMaterialProvider, overwriteBindingInput?: bigint): Promise<unknown>;
  /** Lets every idle worker go. A proof in flight finishes and is not kept. */
  stop(): void;
  readonly idle: number;
} {
  interface Kept {
    readonly worker: ProvingWorkerLike;
    ready: boolean;
    job: Job | null;
    letGo: ReturnType<typeof setTimeout> | null;
    /* A worker that reported an error is never handed another proof. */
    dead: boolean;
  }
  const idle = new Map<string, Kept>();
  let stopped = false;

  const post = (kept: Kept): void => {
    const job = kept.job;
    if (job === null || !kept.ready) return;
    kept.worker.postMessage({ op: job.op, keyLocation: job.keyLocation, preimage: job.preimage, overwriteBindingInput: job.overwriteBindingInput });
  };

  const make = (): Kept => {
    const kept: Kept = { worker: spawn(), ready: false, job: null, letGo: null, dead: false };
    kept.worker.addEventListener('error', (event) => {
      const job = kept.job;
      kept.job = null;
      kept.dead = true;
      kept.worker.terminate();
      job?.reject(new Error(event.message || 'the proving worker failed to load: a bundling fault, not a proving one'));
    });
    kept.worker.addEventListener('message', ({ data }) => {
      const job = kept.job;
      switch (data.op) {
        case 'ready':
          /* The handshake: only now is the work order posted, and only once per worker. */
          kept.ready = true;
          post(kept);
          return;
        case 'lookupKey':
          if (job === null) return;
          job.km.lookupKey(data.keyLocation)
            .then((value) => kept.worker.postMessage({ op: 'answer', askId: data.askId, ok: true, value }, buffersOf(value)))
            .catch((e: unknown) => kept.worker.postMessage({ op: 'answer', askId: data.askId, ok: false, error: describeFailure(e) }));
          return;
        case 'getParams':
          if (job === null) return;
          job.km.getParams(data.k)
            .then((value) => kept.worker.postMessage({ op: 'answer', askId: data.askId, ok: true, value }, buffersOf(value)))
            .catch((e: unknown) => kept.worker.postMessage({ op: 'answer', askId: data.askId, ok: false, error: describeFailure(e) }));
          return;
        case 'result':
          kept.job = null;
          job?.resolve(data.value);
          return;
        case 'failure':
          /* Not kept: a worker whose proof failed may not be fit for the next one. */
          kept.job = null;
          kept.dead = true;
          kept.worker.terminate();
          job?.reject(new Error(data.error));
      }
    });
    return kept;
  };

  const keep = (keyLocation: string, kept: Kept): void => {
    if (stopped || kept.dead || idle.has(keyLocation)) { kept.worker.terminate(); return; }
    kept.letGo = setTimeout(() => {
      if (idle.get(keyLocation) !== kept) return;
      idle.delete(keyLocation);
      kept.worker.terminate();
    }, idleMs);
    idle.set(keyLocation, kept);
  };

  return {
    run: (op, keyLocation, preimage, km, overwriteBindingInput) => new Promise<unknown>((resolve, reject) => {
      const waiting = idle.get(keyLocation);
      if (waiting !== undefined) {
        idle.delete(keyLocation);
        if (waiting.letGo !== null) clearTimeout(waiting.letGo);
        waiting.letGo = null;
      }
      const kept = waiting !== undefined && !waiting.dead ? waiting : make();
      let settled = false;
      const ceiling = setTimeout(() => {
        if (settled) return;
        settled = true;
        kept.job = null;
        kept.dead = true;
        kept.worker.terminate();
        reject(new Error(`the ${op} did not finish within ten minutes, the SDK's own ceiling for a single proof`));
      }, PROVING_CEILING_MS);
      kept.job = {
        op, keyLocation, preimage, overwriteBindingInput, km,
        resolve: (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(ceiling);
          keep(keyLocation, kept);
          resolve(value);
        },
        reject: (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(ceiling);
          reject(e);
        },
      };
      post(kept);
    }),
    stop: () => {
      stopped = true;
      for (const kept of idle.values()) {
        if (kept.letGo !== null) clearTimeout(kept.letGo);
        kept.worker.terminate();
      }
      idle.clear();
    },
    get idle() { return idle.size; },
  };
}

/** The workers this wallet's proofs run in, for as long as the page is open. */
let provers: ReturnType<typeof keptProvers> | null = null;
const theProvers = (): ReturnType<typeof keptProvers> => {
  provers ??= keptProvers(() => new Worker(new URL('./proving-worker.ts', import.meta.url), { type: 'module' }) as unknown as ProvingWorkerLike);
  return provers;
};

/** Where the proofs run and who hears of each one: the wallet's own kept workers when no workers are named. */
export interface BrowserProvingOptions {
  /** Each proof starting and ending, as it happens. */
  readonly onProof?: (event: ProofEvent) => void;
  /** Where the proofs run. The wallet's own kept workers when absent. */
  readonly provers?: ReturnType<typeof keptProvers>;
}

/**
 * The provider the ledger calls back into, one proof obligation at a time
 * (`ProvingProvider`): each proof and check runs in a kept worker for its
 * key's location, which goes with it so the worker proves with the engine that
 * location calls for, and key material is read from `keyMaterialProvider`, the
 * wallet's own pinned material when none is named.
 */
export function browserProvingProvider(
  keyMaterialProvider?: KeyMaterialProvider,
  options: BrowserProvingOptions = {},
): ProvingProvider {
  const km = keyMaterialProvider ?? defaultKeyMaterial();
  const workers = options.provers ?? theProvers();

  const callWorker = (
    op: 'prove' | 'check', keyLocation: string, preimage: Uint8Array, overwriteBindingInput?: bigint,
  ): Promise<unknown> => {
    options.onProof?.({ op, at: 'start' });
    const said = (): void => options.onProof?.({ op, at: 'end' });
    return workers.run(op, keyLocation, preimage, km, overwriteBindingInput)
      .then((value) => { said(); return value; }, (e: unknown) => { said(); throw e; });
  };

  return {
    check: (preimage, keyLocation) =>
      callWorker('check', keyLocation, preimage) as Promise<(bigint | undefined)[]>,
    prove: (preimage, keyLocation, overwriteBindingInput) =>
      callWorker('prove', keyLocation, preimage, overwriteBindingInput) as Promise<Uint8Array>,
    /* Key material is read on this side, as the SDK's own provider reads it. */
    lookupKey: (keyLocation) => km.lookupKey(keyLocation),
  };
}

/**
 * What the wallet's contract builders prove with: a transaction as Midnight.js builds it, or one a builder made
 * itself, handed to Midnight.js's own proof provider over `browserProvingProvider`, the way the page's builders hand
 * theirs (`provedTransaction`). Midnight.js opens the handle; nothing here reads inside it.
 */
export function builderProving(
  keyMaterialProvider?: KeyMaterialProvider,
  options: BrowserProvingOptions = {},
): (unproven: Provable) => Promise<{ serialize(): Uint8Array }> {
  const prover = createLedger9ProofProvider(browserProvingProvider(keyMaterialProvider, options));
  return (unproven) => provedTransaction(prover, unproven);
}

/**
 * The facade's proving service for this wallet: a ledger-v9 transaction is
 * proved in the browser through `browserProvingProvider`, and any other is
 * refused before anything is proved.
 */
export function makeBrowserProvingService(
  keyMaterialProvider?: KeyMaterialProvider,
  options: BrowserProvingOptions = {},
): VersionedProvingService<AnyVersionUnboundTransaction, AnyVersionUnprovenTransaction> {
  const provider = browserProvingProvider(keyMaterialProvider, options);
  /* The SDK's own invocation for a ledger-v9 transaction. A transaction of an
   * earlier ledger is refused: this wallet holds no prover for it. */
  return {
    prove: async (transaction) => {
      if (!(transaction instanceof Transaction)) {
        throw new Error('this transaction was built for an earlier ledger than the one this wallet proves for, '
          + 'so nothing was proved and nothing was sent.');
      }
      return transaction.prove(provider, CostModel.initialCostModel());
    },
  };
}
