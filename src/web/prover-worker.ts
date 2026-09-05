/**
 * The background thread. Decision 0008, M-79.
 *
 * This is the file that makes the whole job model real in a browser: the queue,
 * its storage and the prover all live here, on a thread that is not the one
 * painting the page. WASM proving does not make a page feel slow, it stops it —
 * no scrolling, no cancel button, the spinner itself frozen mid-turn — and no
 * amount of `async` helps, because the work is CPU rather than I/O.
 *
 * Deliberately thin. Everything it does is in `jobs.ts`, `jobs-store-idb.ts` and
 * `jobs-worker.ts`; this file only wires them to the thread it happens to be
 * running on. That is what keeps the macOS and iOS clients able to reuse all of
 * it by writing their own twenty-line equivalent of this file and nothing else.
 */
import { JobQueue, type JobRunner } from '../core/jobs.js';
import { KeyValueJobStore } from '../core/jobs-store.js';
import { IndexedDbKeyValue } from '../core/jobs-store-idb.js';
import { serveJobs, changeReporter, type Port } from '../core/jobs-worker.js';

/**
 * The Worker's own global, as a `Port`.
 *
 * A dedicated Worker posts to and receives from `self`, so the two halves of the
 * channel are the same object here. That is why `Port` is two methods rather
 * than an object with a `port` on it.
 */
export const selfPort = (scope: any): Port => ({
  postMessage: (m) => scope.postMessage(m),
  onMessage: (h) => scope.addEventListener('message', (e: any) => h(e.data)),
});

/**
 * Wires a queue to a thread.
 *
 * `runner` is passed in rather than constructed, because building the Midnight
 * one needs providers, a wallet and a contract address — none of which belong
 * to this file, and all of which differ between the web app, the desktop app
 * and a test.
 *
 * The store is created BEFORE the port is served, so a message arriving in the
 * first tick cannot find a half-built queue.
 */
export const startJobWorker = (scope: any, runner: JobRunner, dbName?: string) => {
  const port = selfPort(scope);
  const store = new KeyValueJobStore(new IndexedDbKeyValue(scope.indexedDB, dbName));

  const queue = new JobQueue(runner, {
    store,
    // Every transition goes back to the page. This is the one channel that
    // optimistic UI and notifications both subscribe to, rather than being two
    // more mechanisms.
    onChange: changeReporter(port),
  });

  serveJobs(queue, port);

  /*
   * Work left behind by a previous life picks itself up.
   *
   * A tab that was closed mid-approval, a laptop that slept, a Worker the
   * browser killed for memory: in every case the jobs are on disk and this is
   * the only thing needed to continue them. `drain()` is safe to call
   * concurrently with anything the page asks for.
   *
   * Failures are reported rather than thrown. An unhandled rejection in a
   * Worker is invisible from the page, which is the worst way for a resumed
   * approval to die.
   */
  void queue.drain().catch((e) => {
    port.postMessage({
      kind: 'change',
      job: {
        id: 'resume', accountId: '', kind: 'approve', state: 'failed', signerId: '',
        payload: {}, attempts: 0, createdAt: '', updatedAt: '',
        error: `work left over from a previous session could not be resumed: ${String((e as any)?.message ?? e)}`,
      },
    });
  });

  return queue;
};
