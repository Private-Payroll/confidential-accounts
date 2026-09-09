/**
 * The strip, connected to a real proving worker.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM THE STRIP IT RENDERS ────────────────
 *
 * `ProofStatus.tsx` draws a list and knows nothing about threads, which is what
 * lets every one of its cases be driven from a plain array. This file is the
 * one place in the page that constructs a `Worker`, and constructing one is the
 * single most consequential line in the application's build: a module that
 * throws while a Worker evaluates it is worse than one that throws in the page,
 * because the page sees nothing at all.
 *
 * Keeping the two apart means the screen can be exercised without a Worker
 * existing, and the Worker can be changed without touching a screen.
 *
 * ── THE WORKER IS STARTED ONCE AND SHARED, AND IT IS CHEAP UNTIL IT IS NOT ─
 *
 * Starting it opens a database and drains whatever a previous life left behind.
 * It loads no prover and no ledger until a job actually needs proving, so a
 * page that opens with nothing outstanding pays for a thread and nothing else.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ProofStatusStrip } from './ProofStatus.js';
import {
  ProvingSession, connectProvingWorker, workerNameFor, type ProofStatusList,
} from './proving-session.js';

/**
 * Where the public proving artefacts are served from.
 *
 * A relative path, because everything under it is public and same-origin: the
 * proving keys, the verifying keys, the circuits and the public parameters
 * carry no secret, and the private input never leaves this device. **A page
 * that reached an absolute URL for any of this would be a page whose proving
 * material comes from somewhere nobody in this repository controls**, which is
 * a different argument entirely and would need making somewhere else.
 */
const ARTEFACT_BASE = '/artefacts';

export function ProvingStrip() {
  const [proofs, setProofs] = useState<ProofStatusList>([]);
  const session = useRef<ProvingSession | null>(null);

  useEffect(() => {
    /*
     * **NO WORKER, NO STRIP, AND NO COMPLAINT.** A browser without Worker
     * support cannot prove here at all, and the honest behaviour is for this
     * component to render nothing rather than to put an error in front of
     * somebody about a feature they have not asked for yet.
     */
    if (typeof Worker === 'undefined') return;

    let worker: Worker;
    try {
      worker = new Worker(new URL('./proving-worker-entry.js', import.meta.url), {
        type: 'module',
        /*
         * **THE SETTINGS TRAVEL IN THE NAME, NOT IN A MESSAGE.** A module
         * worker that is still evaluating its top-level `await` drops what is
         * posted to it, so a settings message sent at construction is the one
         * most likely to be lost - and losing it leaves a worker that runs and
         * can never fetch anything. `name` is fixed before the worker exists.
         */
        name: workerNameFor({ artefactBase: ARTEFACT_BASE }),
      });
    } catch {
      return;
    }

    const s = connectProvingWorker(worker, { onChange: setProofs });
    session.current = s;

    /*
     * Work left behind by a previous life picks itself up here: a tab closed
     * mid-approval, a laptop that slept, a Worker the browser reclaimed. The
     * JOB is what resumes. The proof starts again from nothing, because there
     * is no way to save one half done - and that costs time and only time.
     */
    void s.resumeWork().catch(() => {
      /*
       * Swallowed here on purpose: whatever went wrong is already on a job and
       * has already been reported through the change channel this component is
       * subscribed to. A second copy thrown from an effect is an unhandled
       * rejection the page can do nothing with.
       */
    });

    return () => {
      s.fail('this page navigated away while an approval was in progress');
      worker.terminate?.();
      session.current = null;
    };
  }, []);

  return (
    <ProofStatusStrip
      proofs={proofs}
      onCancel={(jobId) => {
        void session.current?.cancel(jobId).catch(() => {
          /* The refusal is reported on the job itself, which the strip renders. */
        });
      }}
    />
  );
}
