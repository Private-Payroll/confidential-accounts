/**
 * The proving worker, as the page starts it.
 *
 * ── THIS IS THE TWENTY LINES `prover-worker.ts` WAS WRITTEN FOR ──────────
 *
 * That file hosts a queue on whatever thread it finds itself on and takes its
 * runner as an argument, so that a browser tab, a desktop application and a
 * test can each supply their own without any of them owning a copy of the
 * rules. It has been in this repository for weeks with exactly one caller: a
 * probe, whose runner returned the string `'PROOF'` after fifty milliseconds.
 *
 * **THIS IS THE FIRST ONE THAT PROVES.**
 *
 * ── WHY THE SETTINGS ARRIVE IN THE WORKER'S NAME AND NOT IN A MESSAGE ────
 *
 * A module worker that is still evaluating its top-level `await` DROPS what is
 * posted to it, and this worker's first act is to load a WebAssembly prover -
 * so a settings message sent at construction is the message most likely to be
 * lost, and losing it would leave a worker that runs and can never fetch
 * anything. `name` is fixed before the worker exists and is readable from
 * inside it with no round trip at all.
 *
 * **AND THE READY NOTICE IS THE OTHER HALF OF THE SAME HAZARD**, in the other
 * direction: the page must not send until this listener stands. It is posted
 * after `startJobWorker` returns, which is after `serveJobs` has registered.
 */
import { startJobWorker } from './prover-worker.js';
import { provingOnlyRunner, type ProvingCapability } from './proving-runner.js';
import { httpKeyMaterialSource, IndexedDbArtefactCache } from './key-material.js';
import { configFromWorkerName } from './proving-session.js';
import type { Job } from '../core/jobs.js';

/**
 * Where a job says its preimage can be fetched.
 *
 * A location and not the bytes, because the job record is persisted and an
 * unproven transaction is the private input. See `proving-runner.ts`.
 */
interface PreimagePayload {
  circuit?: unknown;
  preimageUrl?: unknown;
}

/**
 * Turns a job into the material to prove.
 *
 * **EXPORTED SO THAT IT CAN BE DRIVEN, WHICH IS A CORRECTION RATHER THAN A
 * CONVENIENCE.** The case that claimed to cover this guard supplied its own
 * copy of it and then asserted that its own copy threw - so deleting the real
 * one changed nothing anywhere. A guard on the path between a persisted record
 * and a network fetch is not a guard worth having on trust.
 */
export const preimageOver = (fetchImpl: typeof fetch) => async (job: Job) => {
  const { circuit, preimageUrl } = job.payload as PreimagePayload;
  if (typeof circuit !== 'string' || typeof preimageUrl !== 'string') {
    throw new Error(
      'this approval does not say what it is approving, so there is nothing to prove. ' +
        'Raise it again.',
    );
  }
  /*
   * **SAME ORIGIN ONLY, AND THE JOB RECORD IS WHY.** This location comes off a
   * persisted job, and the thing it points at is the proof preimage - the
   * private input, which is the one value in this system that must never leave
   * the device except to be proved on it. A record that named another origin
   * would make this worker fetch it from there, and a relative path cannot.
   */
  if (!preimageUrl.startsWith('/') || preimageUrl.startsWith('//')) {
    throw new Error(
      'this approval points somewhere outside the application for the material it needs, ' +
        'so it has not been fetched. Nothing has been sent. Raise it again.',
    );
  }
  const res = await fetchImpl(preimageUrl);
  if (!res.ok) {
    throw new Error(
      `the material for this approval is no longer available (${res.status}). ` +
        'Nothing has been sent. Raise it again.',
    );
  }
  return { circuit, unprovenTransaction: new Uint8Array(await res.arrayBuffer()) };
};

/**
 * Assembles everything the runner needs, in a Worker.
 *
 * Exported and taking its scope as an argument so that the wiring can be read,
 * and driven, without a Worker existing - the same reason `prover-worker.ts`
 * takes one.
 */
export interface WorkerProvingDeps {
  transactionCodec: ProvingCapability['transactionCodec'];
  proofProvider: ProvingCapability['proofProvider'];
}

export const provingCapability = (
  scope: any,
  artefactBase: string,
  onProgressJobId: () => string | null,
  deps: WorkerProvingDeps,
): ProvingCapability => ({
  preimageFor: preimageOver(scope.fetch.bind(scope)),

  keyMaterial: httpKeyMaterialSource(artefactBase, {
    cache: new IndexedDbArtefactCache(scope.indexedDB),
    fetchImpl: scope.fetch.bind(scope),
    /*
     * **THE ONLY PROGRESS THIS OPERATION HAS, SENT AS IT HAPPENS.** The prover
     * itself emits nothing and there is nowhere to put a callback, so these
     * bytes are the whole of what a screen can honestly draw a bar against.
     * Reported against the job being worked, because the queue works one at a
     * time and a byte count with no job on it is a number about nothing.
     */
    onProgress: (progress) => {
      const jobId = onProgressJobId();
      if (jobId === null) return;
      scope.postMessage({ kind: 'fetch-progress', jobId, progress });
    },
  }),

  transactionCodec: deps.transactionCodec,
  proofProvider: deps.proofProvider,
});

/**
 * Starts the worker.
 *
 * **NOTHING HEAVY IS LOADED HERE, AND THAT IS DELIBERATE RATHER THAN TIDY.**
 * The prover and the transaction reader are thirteen megabytes of WebAssembly
 * between them, and most of the time a worker starts there is nothing to prove:
 * a page opens, the queue drains, the queue is empty. So both arrive through
 * functions that the runner calls at the moment it first has a proof to make,
 * and a worker that finds an empty queue loads neither.
 */
export const startProvingWorker = async (scope: any): Promise<void> => {
  const config = configFromWorkerName(scope.name ?? '');

  /** Which job is being worked, so a byte count has something to be about. */
  let working: string | null = null;

  const capability = provingCapability(scope, config.artefactBase, () => working, {
    proofProvider: async (source) => {
      const { wasmProofProvider } = await import('../midnight/wasm-proving.js');
      return (await wasmProofProvider(source)) as any;
    },
    transactionCodec: async () => {
      const ledger: any = await import('@midnightntwrk/ledger-v9');
      return {
        /*
         * The three markers are the transaction's own variant tags. Proven
         * bytes read back under the unproven marker are REFUSED by the ledger,
         * which is what makes the pair meaningful rather than decorative.
         */
        deserializeUnproven: (raw: Uint8Array) =>
          ledger.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', raw),
        serializeProven: (tx: any) => tx.serialize(),
      };
    },
  });

  const runner = provingOnlyRunner(capability);
  startJobWorker(scope, {
    ...runner,
    prove: async (job) => {
      working = job.id;
      try {
        return await runner.prove(job);
      } finally {
        working = null;
      }
    },
  }, config.dbName);

  /*
   * Only now: the queue is built and `serveJobs` has registered its listener,
   * so nothing the page sends from this moment can be dropped.
   */
  scope.postMessage({ kind: 'proving-worker-ready' });
};

/*
 * **THE FILE IS BOTH A MODULE AND AN ENTRY POINT, AND THE GUARD IS WHAT KEEPS
 * IT IMPORTABLE.** Without it, a test that imports `provingCapability` would
 * start a queue and open a database as a side effect of the import.
 */
declare const self: any;
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof (self as any).window === 'undefined') {
  void startProvingWorker(self).catch((e) => {
    /*
     * An unhandled rejection inside a Worker is invisible from the page - the
     * thread simply never answers - which is the worst way for an approval to
     * die. This reports it as the queue's own change channel would.
     */
    self.postMessage({
      kind: 'change',
      job: {
        id: 'worker', accountId: '', kind: 'approve', state: 'failed', signerId: '',
        payload: {}, attempts: 0, createdAt: '', updatedAt: '',
        error: `the proving worker could not start: ${String((e as any)?.message ?? e)}`,
      },
    });
  });
}
