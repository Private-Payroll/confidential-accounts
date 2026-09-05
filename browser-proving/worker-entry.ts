/**
 * A real Worker, running the real queue against real IndexedDB.
 *
 * The runner is faked — proving needs a preimage that only a live transaction
 * produces — but everything around it is the shipping code: the same queue, the
 * same store, the same protocol. What this proves is the part `directPorts` and
 * `MemoryKeyValue` never could: that the boundary survives structured cloning
 * across an actual thread, and that the jobs are still there after the page
 * that created them is gone.
 */
import { startJobWorker } from '../src/web/prover-worker.js';
import type { JobRunner } from '../src/core/jobs.js';

const runner: JobRunner = {
  // Slow on purpose: if this ran instantly the test could not tell a thread
  // from a promise.
  prove: async () => { await new Promise((r) => setTimeout(r, 50)); return { proof: 'PROOF' }; },
  submit: async (job) => ({ txRef: 'tx_' + job.id }),
};

startJobWorker(self as any, runner, (self as any).__DB_NAME__ ?? 'probe-jobs');
