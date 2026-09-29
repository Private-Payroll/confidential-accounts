import { CostModel } from '@midnightntwrk/ledger-v9';
import type { ProvingProvider, UnprovenTransaction } from '@midnightntwrk/ledger-v9';
import type { ProvingService, UnboundTransaction } from '@midnightntwrk/wallet-sdk/proving';
import type { KeyMaterialProvider } from '@midnight-ntwrk/zkir-v2';
import { makePinnedKeyMaterialProvider } from './key-material.js';
import { describeFailure } from '../lib/failure-text.js';

/**
 * THE IN-BROWSER PROVER, MADE TO ACTUALLY ANSWER.
 *
 * This is an IMPLEMENTATION of the SDK's one-method proving seam
 * (`ProvingService.prove` — wallet-sdk-capabilities/dist/proving/
 * provingService.d.ts:16), which is what the seam exists for. It does what
 * `makeWasmProvingService` does — `transaction.prove(provider,
 * CostModel.initialCostModel())`, the exact call in provingService.js:26,
 * with the proof computed by `@midnight-ntwrk/zkir-v2` in a web worker —
 * and differs in one MEASURED place and one DECIDED place (the key
 * material's source; below):
 *
 * **The SDK's worker never hears its work order in this app.** Its worker
 * (wallet-sdk-prover-client/dist/proof-worker.js) registers its message
 * listener at the end of a module graph that initialises WASM under a
 * top-level await, while the page side (WasmProver.js:67-71) posts the
 * one-and-only op the moment the worker is constructed. A message posted to
 * a module worker while its top-level await is pending is DROPPED — measured
 * in a real Chromium against the SDK's own worker file: an immediate post is
 * never answered; the same post five seconds later is (it fails the schema
 * decode, which is an ANSWER). There is no ready signal in the SDK's
 * protocol, so every real proof would sit the full ten-minute internal
 * timeout and die with "prove action timed out" — an error that reads like
 * slow proving and is a lost postMessage. Worth telling the Foundation.
 *
 * So this service's worker (`proving-worker.ts`, ours, bundled by vite's
 * own `new Worker(new URL(...))` support) says `ready` AFTER its listener
 * stands, and the page posts nothing before it hears that. Everything else
 * mirrors the SDK except one thing: each proof gets a worker of its own, but
 * a worker that finished is kept for the next proof of the same circuit
 * rather than terminated, because a kept worker does not read its key again
 * (`keptProvers`). Key material is fetched on the PAGE side (so the
 * provider's in-memory cache survives across proofs); the SDK's own
 * ten-minute ceiling is kept: a proof that long is a fact the report should
 * carry, not a hang.
 *
 * WHERE KEY MATERIAL COMES FROM — it changed, and the change closed two
 * defects. An earlier build reused the SDK's own default provider, which downloads
 * from a hardcoded Amazon bucket ("dev" in its name, no integrity check —
 * it) — and that bucket has CORS disabled, so no web page can fetch from
 * it at all: measured on a real machine, it killed the first real send at
 * proving. The SDK's own configuration makes the source injectable
 * (`keyMaterialProvider?` — provingService.d.ts:25; a `?` in a type is a
 * door), so the default here is now OUR provider (`key-material.ts`):
 * artefacts vendored to this wallet's own origin by `npm run vendor-keys`,
 * every byte verified against a SHA-256 pinned at vendoring, cached in
 * IndexedDB, and refusing loudly on any mismatch — never falling back to
 * the bucket. The bucket's name no longer appears anywhere in this app's
 * send path, which is the point.
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
  postMessage(message: unknown): void;
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

interface Job {
  readonly op: 'prove' | 'check';
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
    kept.worker.postMessage({ op: job.op, preimage: job.preimage, overwriteBindingInput: job.overwriteBindingInput });
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
            .then((value) => kept.worker.postMessage({ op: 'answer', askId: data.askId, ok: true, value }))
            .catch((e: unknown) => kept.worker.postMessage({ op: 'answer', askId: data.askId, ok: false, error: describeFailure(e) }));
          return;
        case 'getParams':
          if (job === null) return;
          job.km.getParams(data.k)
            .then((value) => kept.worker.postMessage({ op: 'answer', askId: data.askId, ok: true, value }))
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
        op, preimage, overwriteBindingInput, km,
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

export function makeBrowserProvingService(
  keyMaterialProvider?: KeyMaterialProvider,
  options: {
    /** Each proof starting and ending, as it happens. */
    readonly onProof?: (event: ProofEvent) => void;
    /** Where the proofs run. The wallet's own kept workers when absent. */
    readonly provers?: ReturnType<typeof keptProvers>;
  } = {},
): ProvingService<UnboundTransaction> {
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

  /* The provider shape the ledger calls back into, per proof obligation
   * (`ProvingProvider`, ledger-v9.d.ts:2365). The worker needs no
   * `keyLocation`: it is carried inside the preimage
   * (proofDataIntoSerializedPreimage, ledger-v9.d.ts:610). It is read here
   * only to say which kept worker has that circuit's key already. */
  const provider: ProvingProvider = {
    check: (preimage, keyLocation) =>
      callWorker('check', keyLocation, preimage) as Promise<(bigint | undefined)[]>,
    prove: (preimage, keyLocation, overwriteBindingInput) =>
      callWorker('prove', keyLocation, preimage, overwriteBindingInput) as Promise<Uint8Array>,
    /* Straight through, as the SDK's own provider passes it
     * (WasmProver.js:132) — key material is page-side either way. */
    lookupKey: (keyLocation) => km.lookupKey(keyLocation),
  };

  return {
    /* The SDK's own invocation, verbatim: provingService.js:26. */
    prove: (transaction: UnprovenTransaction) =>
      transaction.prove(provider, CostModel.initialCostModel()) as Promise<UnboundTransaction>,
  };
}
